#include "VirtualServer.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QJsonDocument>
#include <QRandomGenerator>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>

namespace openspeak {

namespace {

[[noreturn]] void fail(const QString &code, const QString &message = {}) { throw CommandError(code, message); }

// Laço em vez de regex: a mídia passa de 400 KB e o PCRE sem JIT pode estourar o limite.
bool isDataImage(const QString &value, const QStringList &types)
{
    const int comma = value.indexOf(QLatin1Char(','));
    const QString head = value.left(comma);
    if (comma < 0 || !head.startsWith(QLatin1String("data:image/")) || !head.endsWith(QLatin1String(";base64")))
        return false;
    if (!types.contains(head.mid(11, head.size() - 11 - 7)) || comma + 1 == value.size())
        return false;
    for (qsizetype i = comma + 1; i < value.size(); ++i) {
        const QChar ch = value[i];
        if (ch.unicode() > 127 || !(ch.isLetterOrNumber() || ch == QLatin1Char('+') || ch == QLatin1Char('/') || ch == QLatin1Char('=')))
            return false;
    }
    return true;
}

QString cleanString(const QJsonValue &v, int maxLength)
{
    if (!v.isString())
        return {};
    static const QRegularExpression control(QStringLiteral("[\\x00-\\x1f]"));
    return v.toString().remove(control).trimmed().left(maxLength);
}

int clampInt(const QJsonValue &v, int min, int max, int fallback)
{
    if (!v.isDouble())
        return fallback;
    const double d = v.toDouble();
    if (!std::isfinite(d))
        return fallback;
    return std::clamp(int(std::lround(d)), min, max);
}

bool isOneOf(int v, std::initializer_list<int> values) { return std::find(values.begin(), values.end(), v) != values.end(); }

qint64 nowMs() { return QDateTime::currentMSecsSinceEpoch(); }

/// Compara pelos hashes, em tempo constante (não vaza o tamanho nem o prefixo).
bool samePassword(const QString &given, const QString &expected)
{
    const QByteArray a = QCryptographicHash::hash(given.toUtf8(), QCryptographicHash::Sha256);
    const QByteArray b = QCryptographicHash::hash(expected.toUtf8(), QCryptographicHash::Sha256);
    char diff = 0;
    for (qsizetype i = 0; i < a.size(); ++i)
        diff |= char(a[i] ^ b[i]);
    return diff == 0;
}

QString newResumeToken()
{
    quint32 words[6];
    QRandomGenerator::system()->fillRange(words);
    return QString::fromLatin1(QByteArray(reinterpret_cast<const char *>(words), sizeof words)
                                   .toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
}

} // namespace

VirtualServer::VirtualServer(SendFn send, QString name, QJsonArray iceServers, const ChannelList &channels)
    : m_send(std::move(send)), m_name(std::move(name)), m_iceServers(std::move(iceServers))
{
    int cid = 1;
    for (const auto &[channelName, description] : channels) {
        m_channels[cid] = Channel{cid, cid, channelName, description};
        ++cid;
    }
}

void VirtualServer::setRelay(StreamRelay *relay)
{
    m_relay = relay;
    if (m_relay)
        m_relay->setCallbacks([this](const QString &id, int clid, const QJsonObject &payload) { onRelaySignal(id, clid, payload); },
                              [this](const QString &id, int clid) { onRelayFailed(id, clid); });
}

void VirtualServer::onRelaySignal(const QString &id, int clid, const QJsonObject &payload)
{
    // O relay só fala com quem ainda participa do stream.
    auto it = m_streams.find(id);
    if (it == m_streams.end() || !isSfu(it->second))
        return;
    const Stream &s = it->second;
    if (s.ownerClid != clid && !s.viewers.contains(clid))
        return;
    notify(clid, QStringLiteral("notifystreamsignaling"), {{"streamIdentifier", id}, {"clid", RelayClid}, {"payload", payload}});
}

void VirtualServer::onRelayFailed(const QString &id, int clid)
{
    auto it = m_streams.find(id);
    if (it == m_streams.end() || !isSfu(it->second))
        return;
    if (clid == it->second.ownerClid)
        stopStream(id, LeaveReason::StreamStopped); // perdemos o transmissor
    else
        removeViewer(it->second, clid, LeaveReason::Failed);
}

const QHash<QString, VirtualServer::Handler> &VirtualServer::handlers()
{
    static const QHash<QString, Handler> map = {
        {QStringLiteral("login"), &VirtualServer::cmdLogin},
        {QStringLiteral("sync"), &VirtualServer::cmdSync},
        {QStringLiteral("heartbeat"), &VirtualServer::cmdHeartbeat},
        {QStringLiteral("clientmove"), &VirtualServer::cmdClientMove},
        {QStringLiteral("clientupdate"), &VirtualServer::cmdClientUpdate},
        {QStringLiteral("setprofilepassword"), &VirtualServer::cmdSetProfilePassword},
        {QStringLiteral("updateprofile"), &VirtualServer::cmdUpdateProfile},
        {QStringLiteral("profilemedia"), &VirtualServer::cmdProfileMedia},
        {QStringLiteral("setupstream"), &VirtualServer::cmdSetupStream},
        {QStringLiteral("updatestream"), &VirtualServer::cmdUpdateStream},
        {QStringLiteral("stopstream"), &VirtualServer::cmdStopStream},
        {QStringLiteral("streamthumbnail"), &VirtualServer::cmdStreamThumbnail},
        {QStringLiteral("requeststreaminfo"), &VirtualServer::cmdRequestStreamInfo},
        {QStringLiteral("joinstreamrequest"), &VirtualServer::cmdJoinStreamRequest},
        {QStringLiteral("respondjoinstreamrequest"), &VirtualServer::cmdRespondJoinStreamRequest},
        {QStringLiteral("removeclientfromstream"), &VirtualServer::cmdRemoveClientFromStream},
        {QStringLiteral("streamunban"), &VirtualServer::cmdStreamUnban},
        {QStringLiteral("streamsignaling"), &VirtualServer::cmdStreamSignaling},
        {QStringLiteral("streamannotation"), &VirtualServer::cmdStreamAnnotation},
    };
    return map;
}

// ------------------------------------------------------------------ conexão

QJsonObject VirtualServer::monitoringSnapshot() const
{
    QJsonArray clients, channels, streams;
    for (const auto &[id, c] : m_clients)
        if (c.loggedIn)
            clients.append(QJsonObject{{"clid", id}, {"nickname", c.nickname}, {"cid", c.cid}, {"clientInfo", c.clientInfo},
                                       {"away", c.suspended}});
    for (const auto &[id, ch] : m_channels)
        channels.append(QJsonObject{{"cid", id}, {"name", ch.name}});
    int viewers = 0;
    for (const auto &[id, s] : m_streams) {
        viewers += s.viewers.size();
        QJsonArray viewerClids;
        for (const int clid : s.viewers)
            viewerClids.append(clid);
        streams.append(QJsonObject{{"id", id}, {"name", s.name}, {"ownerClid", s.ownerClid},
                                   {"cid", s.cid}, {"mode", s.mode}, {"paused", s.paused},
                                   {"viewers", int(s.viewers.size())}, {"bitrate", s.bitrate},
                                   {"created", s.created}, {"viewerClids", viewerClids},
                                   {"width", s.quality.width}, {"height", s.quality.height},
                                   {"fps", s.quality.fps}, {"audio", s.audio}});
    }
    return {{"name", m_name}, {"clients", clients}, {"channels", channels}, {"streams", streams},
            {"connections", int(m_clients.size())}, {"viewerSubscriptions", viewers}};
}

QJsonObject VirtualServer::liveSnapshot() const
{
    QJsonArray streams;
    for (const auto &[id, s] : m_streams) {
        if (!s.announce)
            continue;
        const auto owner = m_clients.find(s.ownerClid);
        const auto channel = m_channels.find(s.cid);
        // Apelidos de quem assiste (os mesmos que a sala mostra), para o bot listar no fim.
        QJsonArray viewerNames;
        for (const int clid : s.viewers)
            if (const auto viewer = m_clients.find(clid); viewer != m_clients.end())
                viewerNames.append(shownName(viewer->second));
        streams.append(QJsonObject{
            {"id", id}, {"name", s.name},
            {"owner", owner != m_clients.end() ? shownName(owner->second) : QString()},
            {"channel", channel != m_channels.end() ? channel->second.name : QString()},
            {"app", s.app}, {"type", s.type}, {"access", s.access}, {"mode", s.mode},
            {"paused", s.paused || (owner != m_clients.end() && owner->second.suspended)},
            {"audio", s.audio}, {"viewers", int(s.viewers.size())}, {"viewerNames", viewerNames},
            {"started", double(s.created)},
            {"quality", QJsonObject{{"width", s.quality.width}, {"height", s.quality.height}, {"fps", s.quality.fps}}},
        });
    }
    // Só contagens agregadas (para "carga do servidor" no bot). O Mbps quem mede é
    // o ServerHost, que vê os bytes do relay; aqui fica null (P2P não passa mídia).
    int clients = 0, viewers = 0;
    for (const auto &[id, c] : m_clients)
        clients += c.loggedIn ? 1 : 0;
    for (const auto &[id, s] : m_streams)
        viewers += int(s.viewers.size());
    const QJsonObject stats{{"clients", clients}, {"streams", int(m_streams.size())},
                            {"viewers", viewers}, {"mbps", QJsonValue(QJsonValue::Null)}};
    return {{"server", m_name}, {"streams", streams}, {"stats", stats}};
}

void VirtualServer::setClientLatency(int clid, qint64 milliseconds)
{
    auto it = m_clients.find(clid);
    if (it == m_clients.end()) return;
    auto &client = it->second;
    client.pingMs = milliseconds < 0 ? -1 : std::min<qint64>(milliseconds, 90'000);
    client.pingUpdatedAt = nowMs();
    if (client.loggedIn)
        broadcast(QStringLiteral("notifyclientlatency"), {{"clid", clid},
            {"pingMs", client.pingMs < 0 ? QJsonValue(QJsonValue::Null) : QJsonValue(double(client.pingMs))},
            {"pingUpdatedAt", double(client.pingUpdatedAt)}});
}

int VirtualServer::connect()
{
    const int clid = m_nextClid++;
    m_clients[clid] = Client{clid};
    return clid;
}

void VirtualServer::disconnect(int clid)
{
    auto it = m_clients.find(clid);
    if (it == m_clients.end())
        return;
    const Client client = it->second;
    if (client.loggedIn)
        detachFromStreams(client, LeaveReason::Left);
    m_clients.erase(clid);
    if (client.loggedIn)
        broadcast(QStringLiteral("notifyclientleftview"), {{"clid", clid}});
}

bool VirtualServer::suspend(int clid)
{
    auto it = m_clients.find(clid);
    if (it == m_clients.end() || !it->second.loggedIn || it->second.resumeToken.isEmpty())
        return false;
    Client &client = it->second;
    if (!client.suspended) {
        client.suspended = true;
        broadcastPresence(client);
    }
    return true;
}

QJsonObject VirtualServer::resume(int clid, const QString &token)
{
    auto it = m_clients.find(clid);
    if (it == m_clients.end() || it->second.resumeToken.isEmpty() || token.isEmpty() || it->second.resumeToken != token)
        fail(rc::SessionExpired, QStringLiteral("A sessão expirou. Conecte novamente."));
    Client &client = it->second;
    if (client.suspended) {
        client.suspended = false;
        broadcastPresence(client);
    }
    QJsonObject data = view(client);
    data["resumed"] = true;
    data["resumeToken"] = client.resumeToken;
    return data;
}

QJsonObject VirtualServer::handle(int clid, const QString &cmd, const QJsonObject &args)
{
    auto it = m_clients.find(clid);
    if (it == m_clients.end())
        fail(rc::ClientNotFound);
    if (cmd != QLatin1String("login") && !it->second.loggedIn)
        fail(rc::NotLoggedIn);
    const auto handler = handlers().value(cmd, nullptr);
    if (!handler)
        fail(rc::UnknownCommand, QStringLiteral("comando desconhecido: %1").arg(cmd));
    return (this->*handler)(it->second, args);
}

// ----------------------------------------------------------------- comandos

QJsonObject VirtualServer::cmdLogin(Client &client, const QJsonObject &args)
{
    if (client.loggedIn)
        fail(rc::InvalidArgs, QStringLiteral("já autenticado"));
    const QString nickname = cleanString(args.value("nickname"), 32);
    const QString uid = cleanString(args.value("uid"), 64);
    if (nickname.isEmpty() || uid.isEmpty())
        fail(rc::InvalidArgs, QStringLiteral("nickname e uid são obrigatórios"));
    if (!m_password.isEmpty() && !samePassword(args.value("password").toString(), m_password))
        fail(rc::AccessDenied, QStringLiteral("Senha do servidor incorreta."));
    m_profiles.refresh();
    const ProfileStore::Profile *profile = m_profiles.find(nickname);
    if (profile) {
        checkProfilePassword(ProfileStore::key(nickname), args.value("profilePassword"));
        client.profile = ProfileStore::key(nickname);
    }
    client.nickname = profile ? profile->nickname : nickname;
    client.uid = uid;
    client.cid = m_defaultChannel;
    client.loggedIn = true;
    const auto info = args.value("clientInfo").toObject();
    for (const auto &key : {"name", "version", "platform", "kind"}) {
        const auto value = cleanString(info.value(key), 80);
        if (!value.isEmpty()) client.clientInfo[key] = value;
    }
    if (args.value("resumable").toBool())
        client.resumeToken = newResumeToken();
    broadcast(QStringLiteral("notifycliententerview"), {{"client", publicClient(client)}}, client.clid);
    QJsonObject data = view(client);
    if (!client.resumeToken.isEmpty())
        data["resumeToken"] = client.resumeToken;
    return data;
}

QJsonObject VirtualServer::cmdSync(Client &client, const QJsonObject &) { return view(client); }

QJsonObject VirtualServer::cmdHeartbeat(Client &, const QJsonObject &) { return {}; }

QJsonObject VirtualServer::view(const Client &client) const
{
    QJsonArray channels, clients, streams;
    // P2P só sem relay: com o relay, as transmissões vão todas pelo servidor.
    QJsonArray caps;
    if (!m_relay)
        caps.append(CapStreamP2P);
    caps.append(CapProfiles);
    caps.append(CapProfileMedia);
    caps.append(CapStreamAnnotations);
    if (m_relay) {
        caps.append(CapStreamSFU);
        caps.append(CapStreamSimulcast);
    }
    for (const auto &[cid, ch] : m_channels)
        channels.append(QJsonObject{{"cid", ch.cid}, {"order", ch.order}, {"name", ch.name}, {"description", ch.description}});
    for (const auto &[id, c] : m_clients)
        if (c.loggedIn)
            clients.append(publicClient(c));
    for (const auto &[id, s] : m_streams)
        streams.append(publicStream(s));
    return {
        {"clid", client.clid},
        {"server", QJsonObject{{"name", m_name}, {"capabilityExtensions", caps}}},
        {"iceServers", m_iceServers},
        {"channels", channels},
        {"clients", clients},
        {"streams", streams},
    };
}

QJsonObject VirtualServer::cmdClientMove(Client &client, const QJsonObject &args)
{
    const int cid = args.value("cid").toInt();
    if (!m_channels.count(cid))
        fail(rc::ChannelNotFound);
    if (client.cid == cid)
        return {};
    // Streams pertencem ao canal: sair encerra os próprios e a participação nos demais.
    detachFromStreams(client, LeaveReason::Left);
    client.cid = cid;
    broadcast(QStringLiteral("notifyclientmoved"), {{"clid", client.clid}, {"cid", cid}});
    return {};
}

QJsonObject VirtualServer::cmdClientUpdate(Client &client, const QJsonObject &args)
{
    if (args.contains("nickname")) {
        const QString nickname = cleanString(args.value("nickname"), 32);
        if (nickname.isEmpty())
            fail(rc::InvalidArgs);
        // O apelido é a identidade do perfil: nem o dono troca, nem outro assume.
        if (!client.profile.isEmpty())
            fail(rc::PermissionDenied, QStringLiteral("o apelido de um perfil não muda"));
        if (m_profiles.find(nickname))
            fail(rc::ProfilePassword);
        client.nickname = nickname;
    }
    broadcast(QStringLiteral("notifyclientupdated"), {{"client", publicClient(client)}});
    return {};
}

QJsonObject VirtualServer::cmdSetProfilePassword(Client &client, const QJsonObject &args)
{
    const QString password = args.value("password").toString();
    if (password.size() < 4 || password.size() > 128)
        fail(rc::InvalidArgs, QStringLiteral("a senha deve ter de 4 a 128 caracteres"));
    m_profiles.refresh();
    if (!client.profile.isEmpty()) {
        checkProfilePassword(client.profile, args.value("currentPassword"));
        m_profiles.setPassword(client.profile, password);
        return {};
    }
    if (m_profiles.find(client.nickname))
        fail(rc::ProfilePassword);
    client.profile = m_profiles.claim(client.nickname, password);
    broadcast(QStringLiteral("notifyclientupdated"), {{"client", publicClient(client)}});
    return {};
}

QJsonObject VirtualServer::cmdUpdateProfile(Client &client, const QJsonObject &args)
{
    if (client.profile.isEmpty())
        fail(rc::ProfileRequired);
    m_profiles.refresh();
    ProfileStore::Profile profile = *m_profiles.find(client.nickname);
    if (args.contains("displayName"))
        profile.displayName = cleanString(args.value("displayName"), 32);
    if (args.contains("description"))
        profile.description = cleanString(args.value("description"), 190);
    if (args.contains("color")) {
        static const QRegularExpression hexColor(QStringLiteral("^#[0-9a-fA-F]{6}$"));
        const QString color = args.value("color").toString();
        if (!color.isEmpty() && !hexColor.match(color).hasMatch())
            fail(rc::InvalidArgs);
        profile.color = color;
    }
    if (args.contains("avatar")) {
        static const QRegularExpression dataImage(QStringLiteral("^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$"));
        const QString avatar = args.value("avatar").toString();
        if (!avatar.isEmpty() && !dataImage.match(avatar).hasMatch())
            fail(rc::InvalidArgs);
        if (avatar.size() > MaxAvatarBytes)
            fail(rc::PayloadTooLarge);
        profile.avatar = avatar;
    }
    if (args.contains("avatarAnimated")) {
        const QString gif = args.value("avatarAnimated").toString();
        if (!gif.isEmpty() && !isDataImage(gif, {QStringLiteral("gif")}))
            fail(rc::InvalidArgs);
        if (gif.size() > MaxProfileMediaBytes)
            fail(rc::PayloadTooLarge);
        profile.avatarAnimated = gif;
    }
    if (args.contains("banner")) {
        const QString banner = args.value("banner").toString();
        if (!banner.isEmpty() && !isDataImage(banner, {QStringLiteral("png"), QStringLiteral("jpeg"), QStringLiteral("webp"), QStringLiteral("gif")}))
            fail(rc::InvalidArgs);
        if (banner.size() > MaxProfileMediaBytes)
            fail(rc::PayloadTooLarge);
        profile.banner = banner;
    }
    m_profiles.update(client.profile, profile);
    // O mesmo perfil pode estar em mais de um dispositivo.
    for (const auto &[id, c] : m_clients)
        if (c.loggedIn && c.profile == client.profile)
            broadcast(QStringLiteral("notifyclientupdated"), {{"client", publicClient(c)}});
    return {};
}

// A mídia pesada não vai em publicClient: quem abre um card pede só a daquele perfil.
QJsonObject VirtualServer::cmdProfileMedia(Client &, const QJsonObject &args)
{
    m_profiles.refresh();
    const int clid = args.value("clid").toInt();
    for (const auto &[id, c] : m_clients) {
        if (!c.loggedIn || c.clid != clid)
            continue;
        const ProfileStore::Profile *profile = c.profile.isEmpty() ? nullptr : m_profiles.find(c.nickname);
        return {{"mediaTag", profile ? profile->mediaTag : QString()}, {"banner", profile ? profile->banner : QString()},
                {"avatarAnimated", profile ? profile->avatarAnimated : QString()}};
    }
    fail(rc::InvalidArgs);
}

QJsonObject VirtualServer::cmdSetupStream(Client &client, const QJsonObject &args)
{
    if (args.value("type").toInt() == int(StreamType::YouTube))
        fail(rc::ModeNotSupported);
    // Com relay de mídia, toda transmissão vai pelo servidor (SFU): o P2P está
    // desativado. Sem relay, P2P é o único modo.
    const int mode = args.contains("mode") ? args.value("mode").toInt() : int(m_relay ? StreamMode::SFU : StreamMode::P2P);
    if (mode == int(StreamMode::SFU) && !m_relay)
        fail(rc::ModeNotSupported, QStringLiteral("o servidor não tem relay de mídia (STREAM_SFU)"));
    if (mode == int(StreamMode::P2P) && m_relay)
        fail(rc::ModeNotSupported, QStringLiteral("transmissão P2P desativada neste servidor: atualize o OpenSpeak"));
    if (mode != int(StreamMode::P2P) && mode != int(StreamMode::SFU))
        fail(rc::ModeNotSupported);
    const auto owned = std::count_if(m_streams.begin(), m_streams.end(),
                                     [&](const auto &p) { return p.second.ownerClid == client.clid; });
    if (owned >= MaxStreamsPerClient)
        fail(rc::StreamLimit);

    Stream s;
    s.id = QStringLiteral("s%1").arg(m_nextStreamId++);
    s.ownerClid = client.clid;
    s.cid = client.cid;
    s.mode = mode;
    s.created = nowMs();
    s.paused = args.value("paused").toBool();
    s.name = QStringLiteral("Stream de %1").arg(shownName(client));
    applyConfig(s, args);
    const QString id = s.id;
    m_streams[id] = std::move(s);
    if (isSfu(m_streams[id]))
        m_relay->openStream(id, client.clid, m_streams[id].bitrate);
    broadcast(QStringLiteral("notifystreamstarted"), {{"stream", publicStream(m_streams[id])}});
    return {{"streamIdentifier", id}};
}

QJsonObject VirtualServer::cmdUpdateStream(Client &client, const QJsonObject &args)
{
    Stream &s = ownStream(client, args.value("streamIdentifier"));
    const int accessBefore = s.access;
    applyConfig(s, args);
    if (args.contains("paused"))
        s.paused = args.value("paused").toBool();
    if (s.access != int(StreamAccess::Public))
        s.thumbnail.clear();
    if (isSfu(s))
        m_relay->updateStream(s.id, s.bitrate);
    broadcast(QStringLiteral("notifystreamupdated"),
              {{"stream", publicStream(s)}, {"accessChanged", accessBefore != s.access}});
    return {};
}

QJsonObject VirtualServer::cmdStopStream(Client &client, const QJsonObject &args)
{
    const Stream &s = ownStream(client, args.value("streamIdentifier"));
    stopStream(s.id, LeaveReason::StreamStopped);
    return {};
}

QJsonObject VirtualServer::cmdStreamThumbnail(Client &client, const QJsonObject &args)
{
    Stream &s = ownStream(client, args.value("streamIdentifier"));
    const QString thumb = args.value("thumbnail").toString();
    if (!thumb.startsWith(QLatin1String("data:image/")))
        fail(rc::InvalidArgs);
    if (thumb.size() > MaxThumbnailBytes)
        fail(rc::PayloadTooLarge);
    // Miniaturas só são publicadas para streams públicos (igual ao TS).
    if (s.access != int(StreamAccess::Public))
        return {{"published", false}};
    s.thumbnail = thumb;
    broadcastToChannel(s.cid, QStringLiteral("notifystreamthumbnail"),
                       {{"streamIdentifier", s.id}, {"thumbnail", thumb}}, client.clid);
    return {{"published", true}};
}

QJsonObject VirtualServer::cmdRequestStreamInfo(Client &client, const QJsonObject &args)
{
    const Stream &s = stream(args.value("streamIdentifier"));
    QJsonObject info = publicStream(s);
    if (s.ownerClid == client.clid) {
        QJsonArray viewers, pending, banned;
        for (int v : s.viewers)
            viewers.append(v);
        for (const auto &[clid, req] : s.pending)
            pending.append(clid);
        for (const QString &uid : s.banned)
            banned.append(uid);
        info["viewers"] = viewers;
        info["pending"] = pending;
        info["banned"] = banned;
    }
    notify(client.clid, QStringLiteral("notifystreaminfo"), {{"stream", info}});
    return {{"stream", info}};
}

QJsonObject VirtualServer::cmdJoinStreamRequest(Client &client, const QJsonObject &args)
{
    Stream &s = stream(args.value("streamIdentifier"));
    if (s.ownerClid == client.clid)
        fail(rc::InvalidArgs, QStringLiteral("não é possível assistir ao próprio stream"));
    if (s.cid != client.cid)
        fail(rc::NotInChannel);
    if (s.banned.contains(client.uid))
        fail(rc::Banned);
    if (s.viewers.contains(client.clid))
        fail(rc::AlreadyJoined);
    if (s.viewerLimit > 0 && s.viewers.size() >= s.viewerLimit)
        fail(rc::ViewerLimit);
    // Transporte "websocket": espectador sem WebRTC (atividade do Discord).
    const bool websocket = args.value("transport").toString() == QLatin1String("websocket");
    if (websocket && !isSfu(s))
        fail(rc::ModeNotSupported, QStringLiteral("assistir por WebSocket exige um stream no modo servidor (SFU)"));
    QJsonArray codecs;
    for (const QJsonValue &c : args.value("codecs").toArray()) {
        if (c.isString() && codecs.size() < 16)
            codecs.append(c);
    }
    s.pending[client.clid] = PendingRequest{codecs, nowMs(), websocket};
    notify(s.ownerClid, QStringLiteral("notifyjoinstreamrequest"),
           {{"streamIdentifier", s.id}, {"clid", client.clid}, {"nickname", shownName(client)},
            {"uid", client.uid}, {"codecs", codecs}});
    return {{"pending", true}};
}

QJsonObject VirtualServer::cmdRespondJoinStreamRequest(Client &client, const QJsonObject &args)
{
    Stream &s = ownStream(client, args.value("streamIdentifier"));
    const int clid = args.value("clid").toInt();
    auto req = s.pending.find(clid);
    if (req == s.pending.end())
        fail(rc::NoPendingRequest);
    auto viewer = m_clients.find(clid);
    if (viewer == m_clients.end() || viewer->second.cid != s.cid) {
        s.pending.erase(req);
        fail(rc::ClientNotFound);
    }
    if (args.value("accept").toBool()) {
        if (s.viewerLimit > 0 && s.viewers.size() >= s.viewerLimit)
            fail(rc::ViewerLimit);
        const QJsonArray codecs = req->second.codecs;
        const bool websocket = req->second.websocket;
        s.pending.erase(req);
        s.viewers.append(clid);
        // peerClid = com quem o espectador negocia: o dono (P2P) ou o relay (SFU).
        const bool sfu = isSfu(s);
        QJsonObject response{{"streamIdentifier", s.id}, {"accepted", true}, {"ownerClid", s.ownerClid},
                             {"peerClid", sfu ? RelayClid : s.ownerClid}};
        if (websocket)
            response["transport"] = QStringLiteral("websocket");
        notify(clid, QStringLiteral("notifyrespondjoinstreamrequest"), response);
        // O dono é avisado também no SFU (lista de espectadores), mas não abre sessão.
        notify(s.ownerClid, QStringLiteral("notifystreamclientjoined"),
               {{"streamIdentifier", s.id}, {"clid", clid}, {"codecs", codecs}});
        notifyAttendees(s);
        if (sfu && websocket) {
            if (!m_relay->addWebSocketViewer(s.id, clid))
                removeViewer(s, clid, LeaveReason::Failed);
        } else if (sfu) {
            m_relay->addViewer(s.id, clid);
        }
    } else {
        s.pending.erase(req);
        const bool doBan = args.value("ban").toBool();
        if (doBan)
            ban(s, viewer->second.uid);
        notify(clid, QStringLiteral("notifyrespondjoinstreamrequest"),
               {{"streamIdentifier", s.id}, {"accepted", false},
                {"reason", int(doBan ? LeaveReason::Banned : LeaveReason::Denied)}});
    }
    return {};
}

QJsonObject VirtualServer::cmdRemoveClientFromStream(Client &client, const QJsonObject &args)
{
    Stream &s = stream(args.value("streamIdentifier"));
    const int target = args.contains("clid") ? args.value("clid").toInt() : client.clid;
    const bool isOwner = s.ownerClid == client.clid;
    if (!isOwner && target != client.clid)
        fail(rc::PermissionDenied);
    int reason = isOwner && target != client.clid ? args.value("reason").toInt(int(LeaveReason::Kicked))
                                                  : int(LeaveReason::Left);
    if (!isOneOf(reason, {int(LeaveReason::Left), int(LeaveReason::Kicked), int(LeaveReason::Banned), int(LeaveReason::Failed)}))
        reason = int(LeaveReason::Kicked);
    if (reason == int(LeaveReason::Banned)) {
        auto it = m_clients.find(target);
        if (it != m_clients.end())
            ban(s, it->second.uid);
    }
    removeViewer(s, target, LeaveReason(reason));
    return {};
}

QJsonObject VirtualServer::cmdStreamUnban(Client &client, const QJsonObject &args)
{
    Stream &s = ownStream(client, args.value("streamIdentifier"));
    const QString uid = cleanString(args.value("uid"), 64);
    if (s.banned.remove(uid))
        notify(client.clid, QStringLiteral("notifystreambanremoved"), {{"streamIdentifier", s.id}, {"uid", uid}});
    return {};
}

QJsonObject VirtualServer::cmdStreamSignaling(Client &client, const QJsonObject &args)
{
    const Stream &s = stream(args.value("streamIdentifier"));
    const int target = args.value("clid").toInt();
    const QJsonObject payload = args.value("payload").toObject();
    if (!args.value("payload").isObject() || !payload.value("type").isString())
        fail(rc::InvalidArgs);
    if (QJsonDocument(payload).toJson(QJsonDocument::Compact).size() > MaxSignalingBytes)
        fail(rc::PayloadTooLarge);
    if (target == RelayClid) {
        // SFU: dono ou espectador aceito <-> relay do servidor.
        if (!isSfu(s) || (s.ownerClid != client.clid && !s.viewers.contains(client.clid)))
            fail(rc::PermissionDenied);
        m_relay->signaling(s.id, client.clid, payload);
        return {};
    }
    // Só pares legítimos conversam: dono <-> espectador aceito (no SFU não há
    // mídia direta entre eles).
    if (isSfu(s))
        fail(rc::PermissionDenied);
    const bool ownerToViewer = s.ownerClid == client.clid && s.viewers.contains(target);
    const bool viewerToOwner = s.ownerClid == target && s.viewers.contains(client.clid);
    if (!ownerToViewer && !viewerToOwner)
        fail(rc::PermissionDenied);
    notify(target, QStringLiteral("notifystreamsignaling"),
           {{"streamIdentifier", s.id}, {"clid", client.clid}, {"payload", payload}});
    return {};
}

QJsonObject VirtualServer::cmdStreamAnnotation(Client &client, const QJsonObject &args)
{
    const Stream &s = stream(args.value("streamIdentifier"));
    if (client.cid != s.cid || (client.clid != s.ownerClid && !s.viewers.contains(client.clid)))
        fail(rc::PermissionDenied);

    static const QRegularExpression strokePattern(QStringLiteral("\\A[a-zA-Z0-9-]{1,48}\\z"));
    const QString strokeId = args.value("strokeId").toString();
    const QJsonArray points = args.value("points").toArray();
    if (!strokePattern.match(strokeId).hasMatch() || points.isEmpty() || points.size() > MaxAnnotationPoints)
        fail(rc::InvalidArgs);
    for (const QJsonValue &value : points) {
        const QJsonArray point = value.toArray();
        if (point.size() != 2)
            fail(rc::InvalidArgs);
        for (const QJsonValue &coordinate : point) {
            const int n = coordinate.toInt(-1);
            if (n < 0 || n > AnnotationScale)
                fail(rc::InvalidArgs);
        }
    }

    const qint64 second = nowMs() / 1000;
    if (client.annotationSecond != second) {
        client.annotationSecond = second;
        client.annotationBatches = 0;
    }
    if (client.annotationBatches >= MaxAnnotationBatchesPerSecond)
        return {};
    ++client.annotationBatches;

    const QString command = QStringLiteral("notifystreamannotation");
    const QJsonObject message{{"streamIdentifier", s.id}, {"clid", client.clid}, {"name", shownName(client)},
                              {"strokeId", strokeId}, {"points", points}};
    if (s.ownerClid != client.clid)
        notify(s.ownerClid, command, message);
    for (int clid : s.viewers)
        if (clid != client.clid)
            notify(clid, command, message);
    return {};
}

// --------------------------------------------------------------- auxiliares

void VirtualServer::applyConfig(Stream &s, const QJsonObject &args)
{
    if (args.contains("name")) {
        const QString name = cleanString(args.value("name"), 64);
        if (!name.isEmpty())
            s.name = name;
    }
    if (args.contains("type")) {
        const int t = args.value("type").toInt(-1);
        if (t >= int(StreamType::None) && t <= int(StreamType::File))
            s.type = t;
    }
    if (args.contains("access")) {
        const int a = args.value("access").toInt(-1);
        if (isOneOf(a, {int(StreamAccess::Public), int(StreamAccess::ContactsOnly), int(StreamAccess::Private)}))
            s.access = a;
    }
    if (args.contains("bitrate"))
        s.bitrate = clampInt(args.value("bitrate"), 100'000, 50'000'000, s.bitrate);
    if (args.contains("viewerLimit"))
        s.viewerLimit = clampInt(args.value("viewerLimit"), 0, 1000, s.viewerLimit);
    if (args.contains("audio"))
        s.audio = args.value("audio").toBool();
    if (args.contains("app"))
        s.app = cleanString(args.value("app"), 64);
    if (args.contains("announce"))
        s.announce = args.value("announce").toBool(true);
    if (args.value("quality").isObject()) {
        const QJsonObject q = args.value("quality").toObject();
        s.quality.width = clampInt(q.value("width"), -1, 7680, s.quality.width);
        s.quality.height = clampInt(q.value("height"), -1, 4320, s.quality.height);
        s.quality.fps = clampInt(q.value("fps"), 1, 144, s.quality.fps);
    }
}

VirtualServer::Stream &VirtualServer::stream(const QJsonValue &id)
{
    auto it = m_streams.find(id.toString());
    if (it == m_streams.end())
        fail(rc::StreamNotFound);
    return it->second;
}

VirtualServer::Stream &VirtualServer::ownStream(const Client &c, const QJsonValue &id)
{
    Stream &s = stream(id);
    if (s.ownerClid != c.clid)
        fail(rc::PermissionDenied);
    return s;
}

void VirtualServer::ban(Stream &s, const QString &uid)
{
    if (uid.isEmpty() || s.banned.contains(uid))
        return;
    s.banned.insert(uid);
    notify(s.ownerClid, QStringLiteral("notifystreambanadded"), {{"streamIdentifier", s.id}, {"uid", uid}});
}

void VirtualServer::removeViewer(Stream &s, int clid, LeaveReason reason)
{
    const bool wasViewer = s.viewers.removeAll(clid) > 0;
    const bool wasPending = s.pending.erase(clid) > 0;
    if (!wasViewer && !wasPending)
        return;
    if (wasViewer && isSfu(s))
        m_relay->removeViewer(s.id, clid);
    const QJsonObject args{{"streamIdentifier", s.id}, {"clid", clid}, {"reason", int(reason)}, {"wasPending", wasPending}};
    notify(s.ownerClid, QStringLiteral("notifystreamclientleft"), args);
    if (clid != s.ownerClid && m_clients.count(clid))
        notify(clid, QStringLiteral("notifystreamclientleft"), args);
    if (wasViewer)
        notifyAttendees(s);
}

void VirtualServer::stopStream(QString id, LeaveReason reason)
{
    auto it = m_streams.find(id);
    if (it == m_streams.end())
        return;
    if (isSfu(it->second))
        m_relay->closeStream(id);
    m_streams.erase(it);
    broadcast(QStringLiteral("notifystreamstopped"), {{"streamIdentifier", id}, {"reason", int(reason)}});
}

void VirtualServer::detachFromStreams(const Client &c, LeaveReason reason)
{
    QStringList owned;
    for (auto &[id, s] : m_streams) {
        if (s.ownerClid == c.clid)
            owned.append(id);
        else
            removeViewer(s, c.clid, reason);
    }
    for (const QString &id : owned)
        stopStream(id, LeaveReason::StreamStopped);
}

void VirtualServer::notifyAttendees(const Stream &s)
{
    QJsonArray viewers;
    for (int v : s.viewers)
        viewers.append(v);
    const QJsonObject args{{"streamIdentifier", s.id}, {"viewers", viewers}};
    notify(s.ownerClid, QStringLiteral("notifystreamattendees"), args);
    for (int v : s.viewers)
        notify(v, QStringLiteral("notifystreamattendees"), args);
    // A contagem de espectadores é pública (aparece na árvore de canais).
    broadcast(QStringLiteral("notifystreamupdated"), {{"stream", publicStream(s)}});
}

void VirtualServer::broadcastPresence(const Client &c)
{
    broadcast(QStringLiteral("notifyclientupdated"), {{"client", publicClient(c)}});
    for (const auto &[id, s] : m_streams)
        if (s.ownerClid == c.clid)
            broadcast(QStringLiteral("notifystreamupdated"), {{"stream", publicStream(s)}});
}

void VirtualServer::checkProfilePassword(const QString &key, const QJsonValue &password)
{
    const QString given = password.toString();
    if (given.isEmpty())
        fail(rc::ProfilePassword, QStringLiteral("Este apelido é um perfil: informe a senha."));
    const auto result = m_profiles.verify(key, given);
    if (result == ProfileStore::Verify::Locked)
        fail(rc::ProfileLocked, QStringLiteral("Muitas tentativas. Aguarde um minuto."));
    if (result != ProfileStore::Verify::Ok)
        fail(rc::ProfilePassword, QStringLiteral("Senha do perfil incorreta."));
}

QString VirtualServer::shownName(const Client &c) const
{
    const ProfileStore::Profile *profile = c.profile.isEmpty() ? nullptr : m_profiles.find(c.nickname);
    return profile && !profile->displayName.isEmpty() ? profile->displayName : c.nickname;
}

QJsonObject VirtualServer::publicClient(const Client &c) const
{
    const ProfileStore::Profile *profile = c.profile.isEmpty() ? nullptr : m_profiles.find(c.nickname);
    return {{"clid", c.clid}, {"nickname", c.nickname}, {"uid", c.uid}, {"cid", c.cid},
            {"inputMuted", false}, {"outputMuted", false}, {"away", c.suspended},
            {"pingMs", c.pingMs < 0 ? QJsonValue(QJsonValue::Null) : QJsonValue(double(c.pingMs))},
            {"pingUpdatedAt", double(c.pingUpdatedAt)},
            {"hasProfile", profile != nullptr},
            {"displayName", profile ? profile->displayName : QString()},
            {"color", profile ? profile->color : QString()},
            {"description", profile ? profile->description : QString()},
            {"avatar", profile ? profile->avatar : QString()},
            {"mediaTag", profile ? profile->mediaTag : QString()}};
}

QJsonObject VirtualServer::publicStream(const Stream &s) const
{
    const bool isPublic = s.access == int(StreamAccess::Public);
    // Dono com a conexão caída (aguardando retomada): para todos, o stream está pausado.
    const auto owner = m_clients.find(s.ownerClid);
    const bool paused = s.paused || (owner != m_clients.end() && owner->second.suspended);
    return {
        {"streamIdentifier", s.id},
        {"ownerClid", s.ownerClid},
        {"cid", s.cid},
        {"name", s.name},
        {"type", s.type},
        {"access", s.access},
        {"mode", s.mode},
        {"bitrate", s.bitrate},
        {"viewerLimit", s.viewerLimit},
        {"audio", s.audio},
        {"announce", s.announce},
        {"app", s.app},
        {"quality", QJsonObject{{"width", s.quality.width}, {"height", s.quality.height}, {"fps", s.quality.fps}}},
        {"paused", paused},
        {"created", double(s.created)},
        {"viewerCount", int(s.viewers.size())},
        {"thumbnail", isPublic && !s.thumbnail.isEmpty() ? QJsonValue(s.thumbnail) : QJsonValue(QJsonValue::Null)},
    };
}

void VirtualServer::notify(int clid, const QString &cmd, const QJsonObject &args)
{
    m_send(clid, {{"type", "notify"}, {"cmd", cmd}, {"args", args}});
}

void VirtualServer::broadcast(const QString &cmd, const QJsonObject &args, int exceptClid)
{
    for (const auto &[id, c] : m_clients)
        if (c.loggedIn && id != exceptClid)
            notify(id, cmd, args);
    // Todo começo/mudança/fim de stream (inclusive espectadores), troca de apelido e
    // entrada/saída de usuários (contador "online" do bot) passa por aqui.
    static const QStringList liveCommands{QStringLiteral("notifystreamstarted"), QStringLiteral("notifystreamupdated"),
                                          QStringLiteral("notifystreamstopped"), QStringLiteral("notifyclientupdated"),
                                          QStringLiteral("notifycliententerview"), QStringLiteral("notifyclientleftview")};
    if (m_liveChanged && liveCommands.contains(cmd))
        m_liveChanged();
}

void VirtualServer::broadcastToChannel(int cid, const QString &cmd, const QJsonObject &args, int exceptClid)
{
    for (const auto &[id, c] : m_clients)
        if (c.loggedIn && c.cid == cid && id != exceptClid)
            notify(id, cmd, args);
}

} // namespace openspeak
