#pragma once
// Preferências locais (QSettings). `--profile nome` separa identidades para
// rodar duas instâncias na mesma máquina.

#include <QObject>
#include <QSettings>
#include <QStringList>
#include <QVariantMap>

namespace openspeak {

class Settings : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString nickname READ nickname WRITE setNickname NOTIFY changed)
    Q_PROPERTY(QString serverUrl READ serverUrl WRITE setServerUrl NOTIFY changed)
    Q_PROPERTY(QString defaultServerUrl READ defaultServerUrl CONSTANT)
    Q_PROPERTY(QString serverPassword READ serverPassword WRITE setServerPassword NOTIFY changed)
    Q_PROPERTY(QString uid READ uid CONSTANT)
    Q_PROPERTY(bool showOwnStreams READ showOwnStreams WRITE setShowOwnStreams NOTIFY changed)
    Q_PROPERTY(bool showInactiveStreams READ showInactiveStreams WRITE setShowInactiveStreams NOTIFY changed)
    Q_PROPERTY(bool advancedMode READ advancedMode WRITE setAdvancedMode NOTIFY changed)
    Q_PROPERTY(QStringList hiddenStreams READ hiddenStreams WRITE setHiddenStreams NOTIFY changed)
    Q_PROPERTY(QStringList contacts READ contacts NOTIFY changed)
    Q_PROPERTY(QVariantMap lastStreamingConfig READ lastStreamingConfig WRITE setLastStreamingConfig NOTIFY changed)
    Q_PROPERTY(bool debug READ debug CONSTANT)
    Q_PROPERTY(QString connectionMode READ connectionMode WRITE setConnectionMode NOTIFY changed)
    Q_PROPERTY(bool automaticUpdates READ automaticUpdates WRITE setAutomaticUpdates NOTIFY changed)
    Q_PROPERTY(bool sendLogs READ sendLogs WRITE setSendLogs NOTIFY changed)
    Q_PROPERTY(bool pipPinned READ pipPinned WRITE setPipPinned NOTIFY changed)
    Q_PROPERTY(bool prereleaseUpdates READ prereleaseUpdates WRITE setPrereleaseUpdates NOTIFY changed)
    Q_PROPERTY(QString updateEdition READ updateEdition WRITE setUpdateEdition NOTIFY changed)
    Q_PROPERTY(bool minimizeToTray READ minimizeToTray WRITE setMinimizeToTray NOTIFY changed)
    Q_PROPERTY(bool startMinimized READ startMinimized WRITE setStartMinimized NOTIFY changed)
    Q_PROPERTY(bool launchAtStartup READ launchAtStartup WRITE setLaunchAtStartup NOTIFY changed)
    Q_PROPERTY(bool trayNoticeShown READ trayNoticeShown WRITE setTrayNoticeShown NOTIFY changed)
    Q_PROPERTY(bool soundEffects READ soundEffects WRITE setSoundEffects NOTIFY changed)
    Q_PROPERTY(QString soundTheme READ soundTheme WRITE setSoundTheme NOTIFY changed)
    Q_PROPERTY(int soundVolume READ soundVolume WRITE setSoundVolume NOTIFY changed)
    Q_PROPERTY(bool volumeBoost READ volumeBoost WRITE setVolumeBoost NOTIFY changed)
    Q_PROPERTY(bool fullscreenTaskbar READ fullscreenTaskbar WRITE setFullscreenTaskbar NOTIFY changed)
    Q_PROPERTY(QString theme READ theme WRITE setTheme NOTIFY changed)
    Q_PROPERTY(QString accentColor READ accentColor WRITE setAccentColor NOTIFY changed)
    Q_PROPERTY(int previewScale READ previewScale WRITE setPreviewScale NOTIFY changed)
public:
    explicit Settings(const QString &profile, bool debug, QObject *parent = nullptr);

    QString nickname() const { return value("nickname").toString(); }
    void setNickname(const QString &v) { set("nickname", v); }
    QString defaultServerUrl() const { return QStringLiteral("wss://openspeak.duckdns.org/ws"); }
    QString serverUrl() const
    {
        const QString url = value("serverUrl").toString();
        return url.isEmpty() ? defaultServerUrl() : url;
    }
    void setServerUrl(const QString &v) { set("serverUrl", v); }
    /// Senha do servidor privado (OPENSPEAK_PASSWORD), lembrada depois do primeiro login.
    QString serverPassword() const { return value("serverPassword").toString(); }
    void setServerPassword(const QString &v) { set("serverPassword", v); }
    QString uid() const { return m_uid; }
    bool showOwnStreams() const { return value("showOwnStreams", true).toBool(); }
    void setShowOwnStreams(bool v) { set("showOwnStreams", v); }
    bool showInactiveStreams() const { return value("showInactiveStreams", true).toBool(); }
    void setShowInactiveStreams(bool v) { set("showInactiveStreams", v); }
    bool advancedMode() const { return value("advancedMode", false).toBool(); }
    void setAdvancedMode(bool v) { set("advancedMode", v); }
    QStringList hiddenStreams() const { return value("hiddenStreams").toStringList(); }
    void setHiddenStreams(const QStringList &v) { set("hiddenStreams", v); }
    QStringList contacts() const { return value("contacts").toStringList(); }
    QVariantMap lastStreamingConfig() const;
    void setLastStreamingConfig(const QVariantMap &v) { set("lastStreamingConfig", v); }
    bool debug() const { return m_debug; }
    /// "server" (padrão), "tailnet" ou "cloud" (opções avançadas).
    QString connectionMode() const { return value("connectionMode", QStringLiteral("server")).toString(); }
    void setConnectionMode(const QString &v) { set("connectionMode", v); }
    bool automaticUpdates() const { return value("automaticUpdates", true).toBool(); }
    void setAutomaticUpdates(bool v) { set("automaticUpdates", v); }
    /// Envia os registros (logs) do app ao servidor, se ele aceitar (CLIENT_LOGS).
    bool sendLogs() const { return value("sendLogs", true).toBool(); }
    void setSendLogs(bool v) { set("sendLogs", v); }
    /// Abre no Explorer a pasta dos registros locais.
    Q_INVOKABLE void openLogFolder() const;
    /// Janela picture-in-picture por cima de todos os apps.
    bool pipPinned() const { return value("pipPinned", true).toBool(); }
    void setPipPinned(bool v) { set("pipPinned", v); }
    bool prereleaseUpdates() const { return value("prereleaseUpdates", false).toBool(); }
    void setPrereleaseUpdates(bool v) { set("prereleaseUpdates", v); }
    /// Edição recebida nas atualizações: "lite", "full" ou vazio (a instalada).
    QString updateEdition() const { return value("updateEdition").toString(); }
    void setUpdateEdition(const QString &v) { set("updateEdition", v); }
    /// O X da janela esconde o app na bandeja em vez de sair.
    bool minimizeToTray() const { return value("minimizeToTray", true).toBool(); }
    void setMinimizeToTray(bool v) { set("minimizeToTray", v); }
    /// Aberto pelo Windows (--autostart), começa só com o ícone na bandeja.
    bool startMinimized() const { return value("startMinimized", false).toBool(); }
    void setStartMinimized(bool v) { set("startMinimized", v); }
    /// Entrada em HKCU\...\CurrentVersion\Run (não fica no QSettings do perfil).
    bool launchAtStartup() const;
    void setLaunchAtStartup(bool v);
    /// Reescreve a entrada de inicialização com o caminho atual do .exe (versão portátil movida).
    void refreshLaunchAtStartup();
    /// Balão "continua rodando na bandeja" já exibido uma vez.
    bool trayNoticeShown() const { return value("trayNoticeShown", false).toBool(); }
    void setTrayNoticeShown(bool v) { set("trayNoticeShown", v); }
    /// Efeitos sonoros de canal e transmissão (desligar = mudo).
    bool soundEffects() const { return value("soundEffects", true).toBool(); }
    void setSoundEffects(bool v) { set("soundEffects", v); }
    /// Tema dos efeitos: "suave" (padrão), "bolha", "cristal", "retro", "kalimba", "espacial", "discreto" ou "nostalgia".
    QString soundTheme() const { return value("soundTheme", QStringLiteral("suave")).toString(); }
    void setSoundTheme(const QString &v) { set("soundTheme", v); }
    /// Volume dos efeitos, 0 a 100.
    int soundVolume() const { return qBound(0, value("soundVolume", 60).toInt(), 100); }
    void setSoundVolume(int v) { set("soundVolume", qBound(0, v, 100)); }
    /// Controle de volume dos streams assistidos vai até 500% (ganho no áudio).
    bool volumeBoost() const { return value("volumeBoost", false).toBool(); }
    void setVolumeBoost(bool v) { set("volumeBoost", v); }
    /// Tema de cores da interface (ids em qml/Theme.qml); padrão "meia-noite".
    QString theme() const { return value("theme", QStringLiteral("meia-noite")).toString(); }
    void setTheme(const QString &v) { set("theme", v); }
    /// Cor de destaque (ids em qml/Theme.qml); vazio = a do tema.
    QString accentColor() const { return value("accentColor").toString(); }
    void setAccentColor(const QString &v) { set("accentColor", v); }
    /// Em tela cheia, a barra de tarefas que se oculta automaticamente aparece ao passar o mouse.
    bool fullscreenTaskbar() const { return value("fullscreenTaskbar", true).toBool(); }
    void setFullscreenTaskbar(bool v) { set("fullscreenTaskbar", v); }
    /// Tamanho dos previews na área de streams, 40 a 100% do espaço de cada um.
    int previewScale() const { return qBound(40, value("previewScale", 100).toInt(), 100); }
    void setPreviewScale(int v) { set("previewScale", qBound(40, v, 100)); }

    /// Senha do perfil, lembrada por servidor e apelido (não vai para outro servidor).
    Q_INVOKABLE QString profilePassword(const QString &url, const QString &nickname) const;
    Q_INVOKABLE void setProfilePassword(const QString &url, const QString &nickname, const QString &password);
    Q_INVOKABLE bool isContact(const QString &uid) const { return contacts().contains(uid); }
    Q_INVOKABLE void toggleContact(const QString &uid);
    Q_INVOKABLE void hideStream(const QString &id);
    Q_INVOKABLE void showStream(const QString &id);
    /// Grava a versão em uso; true na primeira abertura depois de uma atualização.
    bool markVersionSeen(const QString &version);

signals:
    void changed();

private:
    QVariant value(const QString &key, const QVariant &def = {}) const;
    void set(const QString &key, const QVariant &v);
    QString startupEntryName() const;
    QString startupCommand() const;

    QSettings m_settings;
    QString m_group;
    QString m_uid;
    bool m_debug = false;
};

} // namespace openspeak
