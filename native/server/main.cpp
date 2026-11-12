// openspeak-server: servidor de sinalização (equivalente ao server/index.js)
// e, se compilado com libdatachannel, relay de mídia para o modo SFU.
//
//   openspeak-server [--port 9988] [--name OpenSpeak] [--web <pasta do cliente web>]
//                    [--rtc-port 10000] [--public-ip <ip>] [--no-sfu]
//   OPENSPEAK_PASSWORD=<senha> exige a senha no login (servidor privado);
//   OPENSPEAK_PASSWORD_FILE=<arquivo> lê a senha dele a cada login (o monitor troca a senha ali).
//   OPENSPEAK_PROFILES_FILE=<arquivo> guarda os perfis (padrão: profiles.json na pasta de dados do usuário).
//   OPENSPEAK_LOG_DIR=<pasta> guarda os registros do servidor e dos clientes (CLIENT_LOGS)
//   (padrão: logs/ na pasta de dados do usuário; "off" desliga). Mantém 14 dias.
//   OPENSPEAK_ICE='[{"urls":"stun:..."}]' define os iceServers anunciados
//   (e usados pelo próprio relay para descobrir o endereço público).

#include "LogStore.h"
#include "ServerHost.h"

#include <QCommandLineParser>
#include <QCoreApplication>
#include <QJsonDocument>
#include <QStandardPaths>

#include <memory>

using namespace openspeak;

static QJsonArray iceServersFromEnv()
{
    const QByteArray env = qgetenv("OPENSPEAK_ICE");
    if (!env.isEmpty()) {
        const QJsonDocument doc = QJsonDocument::fromJson(env);
        if (doc.isArray())
            return doc.array();
        qWarning("OPENSPEAK_ICE inválido, usando padrão");
    }
    return QJsonArray{QJsonObject{{"urls", "stun:stun.l.google.com:19302"}}};
}

// Registros do servidor: continuam no stderr (journal) e vão também para o arquivo do dia.
static LogStore *g_logs = nullptr;
static QtMessageHandler g_previousHandler = nullptr;

static void logToFile(QtMsgType type, const QMessageLogContext &context, const QString &message)
{
    if (g_logs) {
        static const char *const levels[] = {"D", "W", "C", "F", "I"}; // ordem do QtMsgType
        const char *level = type >= 0 && type <= QtInfoMsg ? levels[type] : "?";
        const QString category = context.category && qstrcmp(context.category, "default") != 0
                                     ? QString::fromLatin1(context.category) + QStringLiteral(": ")
                                     : QString();
        g_logs->appendServer(QString::fromLatin1(level) + QLatin1Char(' ') + category + message);
    }
    if (g_previousHandler)
        g_previousHandler(type, context, message);
}

static QString defaultWebRoot()
{
    // Procura a pasta public/ do cliente web subindo a partir do executável.
    QDir dir(QCoreApplication::applicationDirPath());
    for (int i = 0; i < 5; ++i) {
        if (QFileInfo::exists(dir.filePath(QStringLiteral("public/index.html"))))
            return dir.filePath(QStringLiteral("public"));
        if (!dir.cdUp())
            break;
    }
    return {};
}

int main(int argc, char *argv[])
{
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("openspeak-server"));

    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("Servidor OpenSpeak (STREAM_P2P e, com o relay de mídia, STREAM_SFU)"));
    parser.addHelpOption();
    QCommandLineOption portOpt(QStringLiteral("port"), QStringLiteral("Porta (padrão 9988)."), QStringLiteral("porta"), QStringLiteral("9988"));
    QCommandLineOption nameOpt(QStringLiteral("name"), QStringLiteral("Nome do servidor."), QStringLiteral("nome"), QStringLiteral("OpenSpeak"));
    QCommandLineOption webOpt(QStringLiteral("web"), QStringLiteral("Pasta do cliente web a servir (opcional)."), QStringLiteral("pasta"));
    QCommandLineOption noWebOpt(QStringLiteral("no-web"), QStringLiteral("Não servir o cliente web."));
    QCommandLineOption hostOpt(QStringLiteral("host"), QStringLiteral("Interface de escuta (padrão 0.0.0.0)."), QStringLiteral("ip"), QStringLiteral("0.0.0.0"));
    QCommandLineOption rtcPortOpt(QStringLiteral("rtc-port"),
                                  QStringLiteral("Porta UDP única do relay SFU (ICE UDP mux, padrão 10000; 0 = portas efêmeras)."),
                                  QStringLiteral("porta"), QStringLiteral("10000"));
    QCommandLineOption publicIpOpt(QStringLiteral("public-ip"),
                                   QStringLiteral("IP público anunciado nos candidatos do relay (NAT 1:1, ex.: VM na nuvem)."),
                                   QStringLiteral("ip"));
    QCommandLineOption noSfuOpt(QStringLiteral("no-sfu"), QStringLiteral("Desativa o relay de mídia (só STREAM_P2P)."));
    parser.addOptions({portOpt, nameOpt, webOpt, noWebOpt, hostOpt, rtcPortOpt, publicIpOpt, noSfuOpt});
    parser.process(app);

    ServerHost::Options options;
    options.port = quint16(parser.value(portOpt).toUInt());
    options.address = QHostAddress(parser.value(hostOpt));
    if (options.address.isNull()) { qCritical("Interface de escuta inválida"); return 1; }
    options.name = parser.value(nameOpt);
    options.iceServers = iceServersFromEnv();
    if (!parser.isSet(noWebOpt))
        options.webRoot = parser.isSet(webOpt) ? parser.value(webOpt) : defaultWebRoot();
    options.sfu = ServerHost::sfuAvailable() && !parser.isSet(noSfuOpt);
    bool portOk = false;
    const uint rtcPort = parser.value(rtcPortOpt).toUInt(&portOk);
    if (!portOk || rtcPort > 65535) { qCritical("--rtc-port inválida"); return 1; }
    options.rtcPort = quint16(rtcPort);
    if (parser.isSet(publicIpOpt)) {
        const QHostAddress ip(parser.value(publicIpOpt));
        if (ip.isNull() || ip.protocol() != QAbstractSocket::IPv4Protocol) { qCritical("--public-ip deve ser um IPv4"); return 1; }
        options.publicIp = ip.toString();
    }
    // Login da atividade do Discord (opcional): credenciais do app no Developer Portal.
    options.discordClientId = qEnvironmentVariable("DISCORD_CLIENT_ID");
    options.discordClientSecret = qEnvironmentVariable("DISCORD_CLIENT_SECRET");
    // Pela variável de ambiente, não por argumento: a linha de comando aparece no `ps`.
    options.password = qEnvironmentVariable("OPENSPEAK_PASSWORD");
    options.passwordFile = qEnvironmentVariable("OPENSPEAK_PASSWORD_FILE");
    options.profilesFile = qEnvironmentVariable("OPENSPEAK_PROFILES_FILE");
    if (options.profilesFile.isEmpty())
        options.profilesFile = QDir(QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation)).filePath(QStringLiteral("profiles.json"));
    QString logDir = qEnvironmentVariable("OPENSPEAK_LOG_DIR");
    std::unique_ptr<LogStore> logs;
    if (logDir.compare(QLatin1String("off"), Qt::CaseInsensitive) != 0) {
        if (logDir.isEmpty())
            logDir = QDir(QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation)).filePath(QStringLiteral("logs"));
        logs = std::make_unique<LogStore>(logDir);
        g_logs = logs.get();
        g_previousHandler = qInstallMessageHandler(logToFile);
        options.logs = logs.get();
    }
    if (!ServerHost::sfuAvailable() && (parser.isSet(rtcPortOpt) || parser.isSet(publicIpOpt)))
        qWarning("compilado sem o relay SFU: --rtc-port/--public-ip ignorados");

    ServerHost host(options);
    if (!host.start())
        return 1;
    qInfo().noquote() << QStringLiteral("[openspeak] servidor \"%1\" em ws://localhost:%2/ws").arg(options.name).arg(host.port());
    if (!options.webRoot.isEmpty())
        qInfo().noquote() << QStringLiteral("[openspeak] cliente web: http://localhost:%1 (%2)").arg(host.port()).arg(options.webRoot);
    if (!options.discordClientId.isEmpty() && !options.discordClientSecret.isEmpty())
        qInfo().noquote() << QStringLiteral("[openspeak] login do Discord: app %1").arg(options.discordClientId);
    if (!options.passwordFile.isEmpty())
        qInfo().noquote() << QStringLiteral("[openspeak] senha do servidor em %1 (relida a cada login)").arg(options.passwordFile);
    else
        qInfo().noquote() << (options.password.isEmpty() ? QStringLiteral("[openspeak] servidor aberto (sem OPENSPEAK_PASSWORD)")
                                                         : QStringLiteral("[openspeak] servidor privado: login exige senha"));
    qInfo().noquote() << QStringLiteral("[openspeak] perfis em %1").arg(options.profilesFile);
    qInfo().noquote() << (logs ? QStringLiteral("[openspeak] registros do servidor e dos clientes em %1").arg(logs->dir())
                               : QStringLiteral("[openspeak] registros em arquivo desligados (OPENSPEAK_LOG_DIR=off)"));
    if (host.sfuEnabled())
        qInfo().noquote() << QStringLiteral("[openspeak] relay SFU: UDP %1%2")
                                 .arg(options.rtcPort ? QString::number(options.rtcPort) : QStringLiteral("(portas efêmeras)"),
                                      options.publicIp.isEmpty() ? QString() : QStringLiteral(", anunciando %1").arg(options.publicIp));
    else
        qInfo().noquote() << QStringLiteral("[openspeak] relay SFU desativado (só P2P)");
    const int code = app.exec();
    qInstallMessageHandler(g_previousHandler);
    g_logs = nullptr;
    return code;
}
