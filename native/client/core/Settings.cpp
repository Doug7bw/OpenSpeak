#include "Settings.h"
#include "Presets.h"
#include "Protocol.h"

#include <QCoreApplication>
#include <QDir>
#include <QRandomGenerator>

static const char RunKey[] = R"(HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run)";

namespace openspeak {

Settings::Settings(const QString &profile, bool debug, QObject *parent)
    : QObject(parent), m_settings(QStringLiteral("OpenSpeak"), QStringLiteral("OpenSpeak")), m_debug(debug)
{
    m_group = profile.isEmpty() ? QStringLiteral("default") : profile;
    m_uid = value("uid").toString();
    if (m_uid.isEmpty()) {
        QByteArray bytes(15, Qt::Uninitialized);
        QRandomGenerator::global()->fillRange(reinterpret_cast<quint32 *>(bytes.data()), 3);
        for (int i = 12; i < 15; ++i)
            bytes[i] = char(QRandomGenerator::global()->bounded(256));
        m_uid = QString::fromLatin1(bytes.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
        set("uid", m_uid);
    }
    // 1.0.8: o modo padrão passou a ser Servidor (SFU). Antes o diálogo gravava P2P
    // sempre que o servidor não tinha relay, então a escolha salva não era do usuário.
    if (!value("sfuDefaultMigrated").toBool()) {
        QVariantMap cfg = value("lastStreamingConfig").toMap();
        if (!cfg.isEmpty()) {
            cfg.insert(QStringLiteral("mode"), int(StreamMode::SFU));
            set("lastStreamingConfig", cfg);
        }
        set("sfuDefaultMigrated", true);
    }
}

QVariant Settings::value(const QString &key, const QVariant &def) const
{
    return m_settings.value(m_group + QLatin1Char('/') + key, def);
}

void Settings::set(const QString &key, const QVariant &v)
{
    m_settings.setValue(m_group + QLatin1Char('/') + key, v);
    emit changed();
}

QVariantMap Settings::lastStreamingConfig() const
{
    QVariantMap cfg = value("lastStreamingConfig").toMap();
    const QualityPreset *p = findPreset(QLatin1String(DefaultPresetId));
    auto def = [&cfg](const char *k, const QVariant &v) {
        if (!cfg.contains(QLatin1String(k)))
            cfg.insert(QLatin1String(k), v);
    };
    def("type", int(StreamType::Screen));
    def("access", int(StreamAccess::Public));
    def("mode", int(StreamMode::SFU)); // cai para P2P se o servidor não tiver relay
    def("bitrate", p->bitrate);
    def("viewerLimit", 0);
    // Toda transmissão começa capturando o áudio (desligar vale só para aquela).
    cfg.insert(QStringLiteral("audio"), true);
    cfg.remove(QStringLiteral("excludeDiscord")); // o áudio do Discord agora é sempre excluído
    def("announce", true); // "Mostrar ao vivo no bot do Discord"
    def("width", p->width);
    def("height", p->height);
    def("fps", p->fps);
    def("audioBitrate", p->audioBitrate);
    return cfg;
}

bool Settings::markVersionSeen(const QString &version)
{
    const QString last = value("lastVersion").toString();
    if (last == version)
        return false;
    set("lastVersion", version);
    // Quem já usava antes desta chave existir (tem apelido salvo) também foi atualizado.
    return !last.isEmpty() || !nickname().isEmpty();
}

QString Settings::startupEntryName() const
{
    return m_group == QLatin1String("default") ? QStringLiteral("OpenSpeak") : QStringLiteral("OpenSpeak (%1)").arg(m_group);
}

QString Settings::startupCommand() const
{
    QString cmd = QStringLiteral("\"%1\" --autostart").arg(QDir::toNativeSeparators(QCoreApplication::applicationFilePath()));
    if (m_group != QLatin1String("default"))
        cmd += QStringLiteral(" --profile \"%1\"").arg(m_group);
    return cmd;
}

bool Settings::launchAtStartup() const
{
#ifdef Q_OS_WIN
    return QSettings(QLatin1String(RunKey), QSettings::NativeFormat).contains(startupEntryName());
#else
    return false;
#endif
}

void Settings::setLaunchAtStartup(bool v)
{
#ifdef Q_OS_WIN
    QSettings run(QLatin1String(RunKey), QSettings::NativeFormat);
    if (v)
        run.setValue(startupEntryName(), startupCommand());
    else
        run.remove(startupEntryName());
    run.sync();
    emit changed();
#else
    Q_UNUSED(v);
#endif
}

void Settings::refreshLaunchAtStartup()
{
#ifdef Q_OS_WIN
    QSettings run(QLatin1String(RunKey), QSettings::NativeFormat);
    if (run.contains(startupEntryName()) && run.value(startupEntryName()).toString() != startupCommand())
        run.setValue(startupEntryName(), startupCommand());
#endif
}

static QString profilePasswordKey(const QString &url, const QString &nickname)
{
    return url + QLatin1Char('|') + nickname.trimmed().toLower();
}

QString Settings::profilePassword(const QString &url, const QString &nickname) const
{
    return value("profilePasswords").toMap().value(profilePasswordKey(url, nickname)).toString();
}

void Settings::setProfilePassword(const QString &url, const QString &nickname, const QString &password)
{
    QVariantMap passwords = value("profilePasswords").toMap();
    passwords.insert(profilePasswordKey(url, nickname), password);
    set("profilePasswords", passwords);
}

void Settings::toggleContact(const QString &uid)
{
    QStringList list = contacts();
    if (list.contains(uid))
        list.removeAll(uid);
    else
        list.append(uid);
    set("contacts", list);
}

void Settings::hideStream(const QString &id)
{
    QStringList list = hiddenStreams();
    if (!list.contains(id)) {
        list.append(id);
        setHiddenStreams(list);
    }
}

void Settings::showStream(const QString &id)
{
    QStringList list = hiddenStreams();
    if (list.removeAll(id))
        setHiddenStreams(list);
}

} // namespace openspeak
