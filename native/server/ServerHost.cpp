#include "ServerHost.h"

#include <QFile>
#include <QFileInfo>
#include <QCoreApplication>
#include <QDateTime>
#include <QSaveFile>
#include <QSet>
#include <QHttpServerRequest>
#include <QHttpServerResponder>
#include <QHttpServerResponse>
#include <QHttpServerWebSocketUpgradeResponse>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QLoggingCategory>
#include <QUrl>
#include <QNetworkReply>
#include <QNetworkRequest>

#include <algorithm>
#include <cmath>

#ifdef OPENSPEAK_HAS_SFU
#include "SfuRelay.h"
#endif

Q_LOGGING_CATEGORY(lcServer, "openspeak.server")

namespace openspeak {

namespace {
constexpr qint64 MaxMessageBytes = 512 * 1024;
constexpr qint64 MaxBacklogBytes = 2 * 1024 * 1024;
}

ServerHost::ServerHost(Options options, QObject *parent)
    : QObject(parent),
      m_options(std::move(options)),
      m_server([this](int clid, const QJsonObject &msg) { sendTo(clid, msg); }, m_options.name, m_options.iceServers),
      m_discord(m_options.discordClientId, m_options.discordClientSecret)
{
    m_server.setPassword(currentPassword());
    m_server.setProfilesFile(m_options.profilesFile);
    if (LogStore *logs = m_options.logs) {
        m_server.setClientLogSink([logs](const QString &nickname, int clid, const QString &version, const QStringList &lines) {
            logs->appendClient(nickname, clid, version, lines);
        });
        logs->prune();
        m_logPrune.setInterval(60 * 60 * 1000);
        connect(&m_logPrune, &QTimer::timeout, this, [logs] { logs->prune(); });
        m_logPrune.start();
    }
#ifdef OPENSPEAK_HAS_SFU
    if (m_options.sfu) {
        SfuRelay::Options relay;
        relay.iceServers = m_options.iceServers;
        relay.transport.udpMuxPort = m_options.rtcPort;
        relay.transport.publicIp = m_options.publicIp;
        m_relay = std::make_unique<SfuRelay>(relay);
        m_relay->setBinarySender([this](int clid, const QByteArray &data) -> qint64 {
            QWebSocket *ws = m_sockets.value(clid);
            if (!ws)
                return -1;
            ws->sendBinaryMessage(data);
            m_mediaTx += quint64(data.size());
            return ws->bytesToWrite();
        });
        m_server.setRelay(m_relay.get());
    }
#else
    if (m_options.sfu)
        qCWarning(lcServer) << "relay SFU indisponível: compilado sem libdatachannel";
#endif
    m_http.addWebSocketUpgradeVerifier(this, [](const QHttpServerRequest &request) {
        return request.url().path() == QLatin1String("/ws") ? QHttpServerWebSocketUpgradeResponse::accept()
                                                            : QHttpServerWebSocketUpgradeResponse::deny();
    });
    connect(&m_http, &QHttpServer::newWebSocketConnection, this, &ServerHost::onNewWebSocket);

    // Atividade do Discord: código OAuth2 -> access token (o secret não sai do servidor).
    // Registrada antes das rotas do cliente web, que aceitam qualquer caminho.
    m_http.route(QStringLiteral("/api/discord/token"), QHttpServerRequest::Method::Post,
                 [this](const QHttpServerRequest &request, QHttpServerResponder &responder) {
        auto shared = std::make_shared<QHttpServerResponder>(std::move(responder));
        const QJsonObject body = request.body().size() <= 4096 ? QJsonDocument::fromJson(request.body()).object() : QJsonObject{};
        m_discord.exchange(body.value("code").toString(), [shared](int status, const QJsonObject &reply) {
            shared->write(QJsonDocument(reply), QHttpServerResponder::StatusCode(status));
        });
    });

    // Bot do Discord: transmissões ao vivo marcadas para anunciar (só leitura).
    m_http.route(QStringLiteral("/api/live"), QHttpServerRequest::Method::Get, [this] {
        sampleMediaRate(); // totais de dados por stream atualizados na hora
        QHttpServerResponse response(liveSnapshot());
        QHttpHeaders headers = response.headers();
        headers.append(QHttpHeaders::WellKnownHeader::CacheControl, "no-store");
        response.setHeaders(std::move(headers));
        return response;
    });

    if (!m_options.webRoot.isEmpty()) {
        const QDir root(m_options.webRoot);
        auto serve = [root](QString relative) -> QHttpServerResponse {
            // "v/<versão>/..." é o mesmo arquivo: a atividade do Discord usa um caminho
            // novo a cada publicação porque o proxy do Discord guarda JS/CSS em cache.
            static const QRegularExpression versionPrefix(QStringLiteral("^v/[A-Za-z0-9._-]+/"));
            relative.remove(versionPrefix);
            const QString clean = QDir::cleanPath(relative.isEmpty() ? QStringLiteral("index.html") : relative);
            const QString file = root.absoluteFilePath(clean);
            if (clean.startsWith(QLatin1String("..")) || !file.startsWith(root.absolutePath()) || !QFileInfo(file).isFile())
                return QHttpServerResponse(QHttpServerResponse::StatusCode::NotFound);
            QHttpServerResponse response = QHttpServerResponse::fromFile(file);
            QHttpHeaders headers = response.headers();
            headers.append(QHttpHeaders::WellKnownHeader::CacheControl, "no-cache");
            if (file.endsWith(QLatin1String(".js")))
                headers.replaceOrAppend(QHttpHeaders::WellKnownHeader::ContentType, "text/javascript; charset=utf-8");
            response.setHeaders(std::move(headers));
            return response;
        };
        m_http.route(QStringLiteral("/"), [serve] { return serve({}); });
        m_http.route(QStringLiteral("/<arg>"), [serve](const QUrl &path) { return serve(path.path()); });
    }

    // Bot do Discord: avisa na hora em vez de esperar a próxima consulta ao /api/live.
    m_liveWebhook = QUrl(QString::fromLocal8Bit(qgetenv("OPENSPEAK_LIVE_WEBHOOK")));
    m_liveSecret = qgetenv("OPENSPEAK_LIVE_WEBHOOK_SECRET");
    if (m_liveWebhook.isValid() && m_liveWebhook.scheme().startsWith(QLatin1String("http"))) {
        m_liveEnabled = true;
        m_liveDebounce.setSingleShot(true);
        m_liveDebounce.setInterval(300); // junta mudanças seguidas num POST só
        connect(&m_liveDebounce, &QTimer::timeout, this, &ServerHost::sendLiveWebhook);
        m_server.setLiveChangedCallback([this] { if (!m_liveDebounce.isActive()) m_liveDebounce.start(); });
        qCInfo(lcServer).noquote() << "webhook do bot:" << m_liveWebhook.toString(QUrl::RemoveUserInfo);
    }

    m_heartbeat.setInterval(15'000);
    connect(&m_heartbeat, &QTimer::timeout, this, &ServerHost::heartbeat);
    m_monitoringFile = QString::fromLocal8Bit(qgetenv("OPENSPEAK_METRICS_FILE"));
    if (!m_monitoringFile.isEmpty()) {
        m_monitoring.setInterval(2'000);
        connect(&m_monitoring, &QTimer::timeout, this, &ServerHost::writeMonitoringSnapshot);
    }
}

bool ServerHost::start()
{
    m_tcp = new QTcpServer(this);
    if (!m_tcp->listen(m_options.address, m_options.port) || !m_http.bind(m_tcp)) {
        qCCritical(lcServer) << "não foi possível escutar na porta" << m_options.port << m_tcp->errorString();
        return false;
    }
    m_heartbeat.start();
    if (!m_monitoringFile.isEmpty()) {
        writeMonitoringSnapshot();
        m_monitoring.start();
    }
    return true;
}

void ServerHost::writeMonitoringSnapshot()
{
    auto data = m_server.monitoringSnapshot();
    data["timestamp"] = double(QDateTime::currentMSecsSinceEpoch());
    data["pid"] = double(QCoreApplication::applicationPid());
    data["sfuEnabled"] = sfuEnabled();
    data["signalingRxBytes"] = double(m_signalingRx);
    data["signalingTxBytes"] = double(m_signalingTx);
    data["websocketMediaTxBytes"] = double(m_mediaTx);
    QJsonArray clients;
    for (const auto &value : data.value("clients").toArray()) {
        auto client = value.toObject();
        const auto info = m_connectionInfo.value(client.value("clid").toInt());
        client["ip"] = info.ip;
        client["userAgent"] = info.userAgent;
        client["origin"] = info.origin;
        client["connectedAt"] = double(info.connectedAt);
        client["lastActivityAt"] = double(info.lastActivityAt);
        client["pingRttMs"] = info.pingRttMs < 0 ? QJsonValue(QJsonValue::Null) : QJsonValue(double(info.pingRttMs));
        client["signalingRxBytes"] = double(info.rxBytes);
        client["signalingTxBytes"] = double(info.txBytes);
        clients.append(client);
    }
    data["clients"] = clients;
    if (m_relay)
        data["mediaSessions"] = m_relay->monitoringSessions();
    QSaveFile file(m_monitoringFile);
    const auto bytes = QJsonDocument(data).toJson(QJsonDocument::Compact);
    if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size() || !file.commit())
        qCWarning(lcServer) << "não foi possível gravar o monitoramento:" << file.errorString();
}

QJsonObject ServerHost::liveSnapshot() const
{
    auto live = m_server.liveSnapshot();
    if (m_relay) {
        auto stats = live.value("stats").toObject();
        stats["mbps"] = std::round(m_mediaMbps * 10) / 10;
        live["stats"] = stats;
        // Dados de cada stream que passa pelo relay (no P2P a mídia não passa por aqui).
        QJsonArray streams;
        for (const auto &value : live.value("streams").toArray()) {
            auto stream = value.toObject();
            const auto media = m_streamMedia.constFind(stream.value("id").toString());
            if (media != m_streamMedia.cend())
                stream["media"] = QJsonObject{{"sentBytes", std::round(media->sent)}, {"receivedBytes", std::round(media->received)}};
            streams.append(stream);
        }
        live["streams"] = streams;
    }
    return live;
}

void ServerHost::sampleMediaRate()
{
    if (!m_relay)
        return;
    // Os contadores são por sessão e somem quando ela acaba: soma só o que cada
    // sessão andou desde a amostra anterior (sessão nova conta desde zero).
    QHash<QString, double> bytes;
    QSet<QString> live;
    double delta = 0;
    for (const auto &value : m_relay->monitoringSessions()) {
        const auto session = value.toObject();
        const QString streamId = session.value("streamId").toString();
        const bool publisher = session.value("role").toString() == QLatin1String("publisher");
        const QString key = streamId + u'/' + QString::number(session.value("clid").toInt()) + u'/' + session.value("role").toString();
        const double total = session.value("mediaRxBytes").toDouble() + session.value("mediaTxBytes").toDouble();
        bytes.insert(key, total);
        const double moved = std::max(0.0, total - m_mediaBytes.value(key, 0));
        delta += moved;
        MediaTotals &media = m_streamMedia[streamId];
        (publisher ? media.sent : media.received) += moved;
        live.insert(streamId);
    }
    // Stream sem sessão no relay (acabou ou é P2P) não precisa mais do total.
    for (auto it = m_streamMedia.begin(); it != m_streamMedia.end();)
        it = live.contains(it.key()) ? std::next(it) : m_streamMedia.erase(it);
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (m_mediaSampledAt)
        m_mediaMbps = delta * 8 / 1e6 / (std::max<qint64>(now - m_mediaSampledAt, 1) / 1000.0);
    m_mediaBytes = std::move(bytes);
    m_mediaSampledAt = now;
}

void ServerHost::sendLiveWebhook()
{
    // Compara com o Mbps arredondado: variações pequenas de tráfego não geram POST.
    // Contagens (online, espectadores) mudam a comparação e vão na hora.
    const QJsonObject live = liveSnapshot();
    QJsonObject rounded = live;
    QJsonObject stats = rounded.value("stats").toObject();
    if (stats.value("mbps").isDouble())
        stats["mbps"] = std::round(stats.value("mbps").toDouble());
    rounded["stats"] = stats;
    // Os totais de dados crescem o tempo todo: sozinhos não justificam um POST.
    QJsonArray streams;
    for (const auto &value : rounded.value("streams").toArray()) {
        auto stream = value.toObject();
        stream.remove(QStringLiteral("media"));
        streams.append(stream);
    }
    rounded["streams"] = streams;
    const QByteArray key = QJsonDocument(rounded).toJson(QJsonDocument::Compact);
    if (key == m_lastLive)
        return; // só a contagem de algo que o bot não mostra, ou nada mudou
    m_lastLive = key;
    const QByteArray body = QJsonDocument(live).toJson(QJsonDocument::Compact);
    QNetworkRequest request(m_liveWebhook);
    request.setHeader(QNetworkRequest::ContentTypeHeader, QByteArrayLiteral("application/json"));
    request.setTransferTimeout(5'000);
    if (!m_liveSecret.isEmpty())
        request.setRawHeader("X-OpenSpeak-Secret", m_liveSecret);
    QNetworkReply *reply = m_liveNetwork.post(request, body);
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        if (reply->error() != QNetworkReply::NoError || status >= 300) {
            m_lastLive.clear(); // a próxima mudança reenvia tudo (o bot também consulta o /api/live)
            qCWarning(lcServer).noquote() << "webhook do bot falhou:" << (status ? QString::number(status) : reply->errorString());
        }
    });
}

QString ServerHost::currentPassword() const
{
    if (!m_options.passwordFile.isEmpty()) {
        QFile file(m_options.passwordFile);
        if (file.open(QIODevice::ReadOnly))
            return QString::fromUtf8(file.readLine(1024)).trimmed();
    }
    return m_options.password;
}

quint16 ServerHost::port() const { return m_tcp ? m_tcp->serverPort() : 0; }

bool ServerHost::sfuAvailable()
{
#ifdef OPENSPEAK_HAS_SFU
    return true;
#else
    return false;
#endif
}

void ServerHost::onNewWebSocket()
{
    while (m_http.hasPendingWebSocketConnections()) {
        QWebSocket *ws = m_http.nextPendingWebSocketConnection().release();
        ws->setParent(this);
        ws->setMaxAllowedIncomingMessageSize(MaxMessageBytes);
        const int clid = m_server.connect();
        m_sockets.insert(clid, ws);
        m_clids.insert(ws, clid);
        m_alive.insert(ws, true);
        ConnectionInfo info;
        info.connectedAt = info.lastActivityAt = QDateTime::currentMSecsSinceEpoch();
        info.ip = ws->peerAddress().toString();
        const auto request = ws->request();
        // Só o proxy local é confiável para informar o IP; clientes diretos não podem forjar XFF.
        if (ws->peerAddress().isLoopback()) {
            const auto forwarded = QString::fromLatin1(request.rawHeader("X-Forwarded-For")).split(',').last().trimmed();
            const QHostAddress address(forwarded);
            if (!address.isNull()) info.ip = address.toString();
        }
        info.userAgent = QString::fromUtf8(request.rawHeader("User-Agent")).left(512);
        info.origin = QString::fromUtf8(request.rawHeader("Origin")).left(256);
        m_connectionInfo.insert(clid, info);
        qCInfo(lcServer).noquote() << "conexão clid=" << clid << "de" << info.ip;

        connect(ws, &QWebSocket::textMessageReceived, this, [this, ws](const QString &text) { onMessage(ws, text); });
        connect(ws, &QWebSocket::pong, this, [this, ws](quint64 elapsedMs, const QByteArray &) {
            const int clid = m_clids.value(ws);
            if (!clid)
                return;
            m_alive[ws] = true;
            auto &info = m_connectionInfo[clid];
            info.pingRttMs = qint64(elapsedMs);
            info.lastActivityAt = QDateTime::currentMSecsSinceEpoch();
            m_server.setClientLatency(clid, info.pingRttMs);
        });
        connect(ws, &QWebSocket::disconnected, this, [this, ws] { onSocketClosed(ws); });
        ws->ping();
    }
}

void ServerHost::onSocketClosed(QWebSocket *ws)
{
    ws->deleteLater();
    m_alive.remove(ws);
    const int clid = m_clids.take(ws);
    if (!clid)
        return; // trocado por uma retomada ou já removido (logout)
    m_sockets.remove(clid);
    // Queda sem logout: quem sabe retomar continua na sala (streams pausados).
    if (ws->closeReason() != QLatin1String("bye") && m_server.suspend(clid)) {
        m_suspended.insert(clid, Suspension{QDateTime::currentMSecsSinceEpoch(), {}, 0});
        qCInfo(lcServer) << "conexão perdida clid=" << clid << "(aguardando retomada)";
        return;
    }
    dropClient(clid);
}

void ServerHost::dropClient(int clid)
{
    if (QWebSocket *ws = m_sockets.take(clid)) {
        m_clids.remove(ws);
        m_alive.remove(ws);
        ws->close(QWebSocketProtocol::CloseCodeNormal, QStringLiteral("bye"));
    }
    m_suspended.remove(clid);
    m_connectionInfo.remove(clid);
    m_server.disconnect(clid);
    qCInfo(lcServer) << "desconectado clid=" << clid;
}

void ServerHost::onMessage(QWebSocket *ws, const QString &text)
{
    const int clid = m_clids.value(ws);
    if (!clid)
        return;
    m_signalingRx += text.toUtf8().size();
    auto &info = m_connectionInfo[clid];
    info.rxBytes += text.toUtf8().size();
    info.lastActivityAt = QDateTime::currentMSecsSinceEpoch();
    const QJsonObject msg = QJsonDocument::fromJson(text.toUtf8()).object();
    if (msg.value("type").toString() != QLatin1String("cmd") || !msg.value("cmd").isString())
        return;
    const QString cmd = msg.value("cmd").toString();
    if (cmd == QLatin1String("login") && msg.value("args").toObject().contains("resumeToken")) {
        resumeSession(ws, clid, msg);
        return;
    }
    if (cmd == QLatin1String("login"))
        m_server.setPassword(currentPassword());
    QJsonObject reply{{"type", "res"}, {"id", msg.value("id")}};
    if (cmd == QLatin1String("logout")) {
        reply["return_code"] = rc::Ok;
        reply["data"] = QJsonObject{};
        sendTo(clid, reply);
        dropClient(clid);
        return;
    }
    try {
        reply["data"] = m_server.handle(clid, cmd, msg.value("args").toObject());
        reply["return_code"] = rc::Ok;
    } catch (const CommandError &err) {
        reply["return_code"] = err.code;
        reply["error"] = QString::fromStdString(err.what());
    } catch (const std::exception &err) {
        qCWarning(lcServer) << "erro em" << cmd << err.what();
        reply["return_code"] = rc::Internal;
        reply["error"] = QStringLiteral("erro interno");
    }
    sendTo(clid, reply);
    // Senha errada: derruba a conexão (cada nova tentativa paga um handshake).
    if (cmd == QLatin1String("login") && reply.value("return_code").toString() == rc::AccessDenied) {
        qCInfo(lcServer).noquote() << "senha incorreta clid=" << clid << "de" << info.ip;
        dropClient(clid);
        return;
    }
    // Measure after login as well: native peers may still be opening when the
    // handshake ping arrives. The reply establishes the client's public view.
    if (cmd == QLatin1String("login") && reply.value("return_code").toString() == rc::Ok)
        ws->ping();
}

void ServerHost::resumeSession(QWebSocket *ws, int tempClid, const QJsonObject &msg)
{
    const QJsonObject args = msg.value("args").toObject();
    const int target = args.value("resumeClid").toInt();
    QJsonObject reply{{"type", "res"}, {"id", msg.value("id")}};
    QJsonObject data;
    try {
        if (target == tempClid)
            throw CommandError(rc::SessionExpired);
        data = m_server.resume(target, args.value("resumeToken").toString());
    } catch (const CommandError &err) {
        reply["return_code"] = err.code;
        reply["error"] = QString::fromStdString(err.what());
        sendTo(tempClid, reply);
        return;
    }
    // A conexão antiga pode ainda não ter caído deste lado: a nova assume.
    if (QWebSocket *old = m_sockets.take(target)) {
        m_clids.remove(old);
        m_alive.remove(old);
        old->abort();
    }
    // O socket novo deixa o clid provisório (que nunca fez login) e vira o antigo.
    m_sockets.remove(tempClid);
    m_server.disconnect(tempClid);
    ConnectionInfo info = m_connectionInfo.take(tempClid);
    info.connectedAt = m_connectionInfo.value(target).connectedAt;
    m_connectionInfo.insert(target, info);
    m_sockets.insert(target, ws);
    m_clids.insert(ws, target);
    const Suspension suspension = m_suspended.take(target);
    for (const QString &text : suspension.backlog) {
        m_signalingTx += text.toUtf8().size();
        ws->sendTextMessage(text);
    }
    reply["return_code"] = rc::Ok;
    reply["data"] = data;
    sendTo(target, reply);
    qCInfo(lcServer) << "sessão retomada clid=" << target << "após"
                     << (suspension.since ? (QDateTime::currentMSecsSinceEpoch() - suspension.since) / 1000 : 0) << "s";
    ws->ping();
    // Mídia que caiu junto renegocia já, sem esperar o próximo timeout.
    if (m_relay)
        m_relay->resumePeer(target);
}

void ServerHost::sendTo(int clid, const QJsonObject &message)
{
    QWebSocket *ws = m_sockets.value(clid);
    const auto suspended = ws ? m_suspended.end() : m_suspended.find(clid);
    if (!ws && suspended == m_suspended.end())
        return;
    // Sinalização de mídia velha não serve na volta (a retomada renegocia) e o
    // ping dos outros só ocupa a fila.
    const QString cmd = message.value("cmd").toString();
    if (!ws && (cmd == QLatin1String("notifystreamsignaling") || cmd == QLatin1String("notifyclientlatency")))
        return;
    const QString text = QString::fromUtf8(QJsonDocument(message).toJson(QJsonDocument::Compact));
    if (!ws) {
        // Fila cheia: a visão completa na resposta da retomada cobre o estado.
        if (suspended->backlogBytes + text.size() > MaxBacklogBytes)
            return;
        suspended->backlogBytes += text.size();
        suspended->backlog.append(text);
        return;
    }
    const auto bytes = text.toUtf8().size();
    m_signalingTx += bytes;
    m_connectionInfo[clid].txBytes += bytes;
    ws->sendTextMessage(text);
}

void ServerHost::heartbeat()
{
    sampleMediaRate();
    // Tráfego novo: no máximo um POST a cada heartbeat (15 s), só se o Mbps mudou.
    if (m_liveEnabled && m_relay && !m_liveDebounce.isActive())
        sendLiveWebhook();
    // Derruba sockets mortos; quem sabe retomar fica suspenso esperando a volta.
    QList<QWebSocket *> dead;
    for (auto it = m_alive.begin(); it != m_alive.end(); ++it) {
        if (!it.value()) {
            dead.append(it.key());
            continue;
        }
        it.value() = false;
        it.key()->ping();
    }
    for (QWebSocket *ws : dead)
        ws->abort();
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    QList<int> expired;
    for (auto it = m_suspended.cbegin(); it != m_suspended.cend(); ++it)
        if (now - it->since > SessionGraceMs)
            expired.append(it.key());
    for (const int clid : expired) {
        qCInfo(lcServer) << "retomada não veio, clid=" << clid;
        dropClient(clid);
    }
}

} // namespace openspeak
