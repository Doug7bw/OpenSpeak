#pragma once
// Orquestrador central (com::teamspeak::video::ScreenshareManager), exposto à QML.
//  - Streams próprios: uma captura + UM encoder compartilhado + uma
//    SessionOutbound por espectador (single-encoding). No modo SFU, uma única
//    SessionOutbound com o servidor (clid 0), que repassa aos espectadores.
//  - Streams assistidos: uma SessionInbound por stream.
//  - Pedidos de entrada, privacidade, limite, kick/ban, miniaturas, estatísticas.

#include "AudioCapture.h"
#include "AudioCodec.h"
#include "ConnectionHandler.h"
#include "SessionInbound.h"
#include "SessionOutbound.h"
#include "Settings.h"
#include "VideoEncoder.h"
#include "VideoSource.h"

#include <QMap>
#include <QObject>
#include <QSet>
#include <QTimer>
#include <QVariantList>
#include <QVideoSink>

#include <memory>
#include <mutex>

namespace openspeak {

class ScreenshareManager : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantList items READ items NOTIFY itemsChanged)
    Q_PROPERTY(int pendingRequests READ pendingRequests NOTIFY itemsChanged)
    Q_PROPERTY(QStringList encoders READ encoders CONSTANT)
    Q_PROPERTY(bool previewActive READ previewActive NOTIFY previewChanged)
    Q_PROPERTY(QString previewLabel READ previewLabel NOTIFY previewChanged)
    Q_PROPERTY(bool streaming READ streaming NOTIFY itemsChanged)
    Q_PROPERTY(bool audioMuted READ audioMuted WRITE setAudioMuted NOTIFY audioMutedChanged)
public:
    ScreenshareManager(ConnectionHandler *handler, Settings *settings, QObject *parent = nullptr);
    ~ScreenshareManager() override;

    QVariantList items() const;
    int pendingRequests() const;
    QStringList encoders() const { return VideoEncoder::availableEncoders(); }
    bool previewActive() const { return m_preview && m_preview->isActive(); }
    QString previewLabel() const { return m_preview ? m_preview->label() : QString(); }
    bool streaming() const { return !m_own.empty(); }
    /// Silencia o áudio de todos os streams assistidos (ação da bandeja).
    bool audioMuted() const { return m_userMuted; }
    void setAudioMuted(bool muted);

    // --- fontes / pré-visualização (diálogo de setup)
    Q_INVOKABLE QVariantList sources(int type) const;
    Q_INVOKABLE bool openPreview(const QVariantMap &source, int fps);
    Q_INVOKABLE void closePreview();
    Q_INVOKABLE void attachPreview(QVideoSink *sink);
    Q_INVOKABLE void detachPreview(QVideoSink *sink);

    // --- streams próprios
    Q_INVOKABLE void startStream(const QVariantMap &config);
    Q_INVOKABLE void updateStream(const QString &id, const QVariantMap &config);
    Q_INVOKABLE void changeSource(const QString &id);
    Q_INVOKABLE void stopStream(const QString &id);
    Q_INVOKABLE void stopAllStreams();
    Q_INVOKABLE void setPaused(const QString &id, bool paused);
    Q_INVOKABLE QVariantMap ownConfig(const QString &id) const;
    Q_INVOKABLE void attachOwnPreview(const QString &id, QVideoSink *sink);
    Q_INVOKABLE void detachOwnPreview(const QString &id, QVideoSink *sink);
    /// Reabre a prévia fechada pelo app em tela cheia; vale até o fim desta transmissão.
    Q_INVOKABLE void keepOwnPreview(const QString &id);
    /// Fecha a prévia à mão; com um app em tela cheia ela volta a fechar sozinha.
    Q_INVOKABLE void closeOwnPreview(const QString &id);
    Q_INVOKABLE void respondJoinRequest(const QString &id, int clid, bool accept, bool ban = false);
    Q_INVOKABLE void removeViewer(const QString &id, int clid, bool ban = false);
    Q_INVOKABLE void unban(const QString &id, const QString &uid);
    Q_INVOKABLE QVariantMap viewers(const QString &id) const;
    /// Apelidos de quem assiste: nas minhas transmissões e nas que estou assistindo
    /// (o servidor manda a lista aos espectadores). Lista vazia válida; null se não sei.
    Q_INVOKABLE QVariant viewerNames(const QString &id) const;
    /// Streams que estou assistindo ou pedindo para assistir (sem os com erro).
    QStringList watchedStreams() const;

    // --- streams assistidos
    Q_INVOKABLE void joinStream(const QString &id);
    Q_INVOKABLE void leaveStream(const QString &id);
    Q_INVOKABLE void dismiss(const QString &id);
    Q_INVOKABLE void attachVideo(const QString &id, QVideoSink *sink);
    Q_INVOKABLE void detachVideo(const QString &id, QVideoSink *sink);
    Q_INVOKABLE void setVolume(const QString &id, double volume);
    /// Qualidade de um stream assistido no SFU com simulcast: "auto", "high" ou "low".
    Q_INVOKABLE void setQualityPreference(const QString &id, const QString &preference);

    // --- estatísticas
    Q_INVOKABLE QVariantMap stats(const QString &id, int viewerClid) const;

signals:
    void itemsChanged();
    void previewChanged();
    void audioMutedChanged();
    void statsChanged(const QString &id);
    void joinRequest(const QString &id, int clid, const QString &nickname);
    void joinRequestResolved(const QString &id, int clid);
    void errorOccurred(const QString &message);
    /// Aviso informativo; `key` é uma chave do I18n.
    void noticeOccurred(const QString &key);

private:
    struct StreamConfig {
        QString name;
        StreamType type = StreamType::Screen;
        StreamAccess access = StreamAccess::Public;
        StreamMode mode = StreamMode::P2P;
        int bitrate = 3'000'000;
        int viewerLimit = 0;
        bool audio = true;
        bool excludeDiscord = true;  // tela: não transmite o áudio do Discord
        bool announce = true;        // aparece no bot do Discord
        QString app;                 // programa da janela (VideoSource::appName)
        int width = 1280, height = 720, fps = 30, audioBitrate = 128'000;
    };
    struct JoinReq {
        int clid = 0;
        QString nickname, uid;
        QStringList codecs;
    };
    struct History {
        QList<QVariantMap> video, audio;
    };
    struct OwnStream {
        QString id;
        StreamConfig config;
        std::unique_ptr<VideoSource> source;
        std::unique_ptr<VideoEncoder> encoder;
        std::unique_ptr<VideoEncoder> encoderLow; // simulcast (SFU): camada baixa
        std::unique_ptr<AudioCapture> audio;
        QString audioLabel;            // como o áudio está sendo capturado (estatísticas)
        bool excludingDiscord = false; // o Discord (e não o OpenSpeak) está fora da captura
        std::unique_ptr<OpusEncoder> opus;
        QMap<int, SessionOutbound *> sessions; // por espectador (P2P) ou só RelayClid (SFU)
        std::mutex sinkMutex;           // protege `sinks` (thread do encoder/áudio)
        QList<SessionOutbound *> sinks;
        QMap<int, JoinReq> joinRequests;
        QSet<int> viewers;
        QSet<QString> banned;
        bool paused = false;
        bool previewClosed = false; // fechada para economizar com um app em tela cheia em foco
        bool previewKept = false;   // o usuário pediu para mostrar: não fecha mais nesta transmissão
        QTimer thumbTimer;
        QMap<int, History> history;
        bool sfu() const { return config.mode == StreamMode::SFU; }
        void pushFrame(const QVideoFrame &f)
        {
            encoder->pushFrame(f);
            if (encoderLow)
                encoderLow->pushFrame(f);
        }
    };
    enum class InStatus { Waiting, Connecting, Playing, Reconnecting, Error };
    struct InboundView {
        QString id;
        int ownerClid = 0;
        int peerClid = 0; // com quem a sessão negocia: o dono (P2P) ou o servidor (SFU)
        InStatus status = InStatus::Waiting;
        QString errorKey;
        SessionInbound *session = nullptr;
        double volume = 1.0;
        History history;
        QList<int> attendees;   // espectadores, pelo notifystreamattendees
        bool attendeesKnown = false;
        // Simulcast (SFU): o servidor informa a camada recebida.
        bool simulcast = false;
        QString layer = QStringLiteral("high");
        QString qualityPreference = QStringLiteral("auto");
    };

    static StreamConfig configFromMap(const QVariantMap &m, const StreamConfig &base);
    static QJsonObject wireConfig(const StreamConfig &c);
    void onNotification(const QString &cmd, const QJsonObject &args);
    void onJoinRequest(const QJsonObject &a);
    bool maybeAutoAccept(OwnStream &own, const JoinReq &req);
    bool viewerLimitReached(const OwnStream &own) const;
    void onClientJoined(const QJsonObject &a);
    SessionOutbound *addOutbound(OwnStream &own, int peerClid, const QStringList &codecs);
    void onClientLeft(const QJsonObject &a);
    void onJoinResponse(const QJsonObject &a);
    void onSignaling(const QJsonObject &a);
    void sendQualityPreference(const InboundView &view);
    void startMedia(OwnStream &own);
    void startAudioFor(OwnStream &own);
    void configureEncoder(OwnStream &own);
    void scheduleThumbnails(OwnStream &own);
    void removeSession(OwnStream &own, int clid);
    void disposeOwn(const QString &id);
    void disposeInbound(InboundView &view);
    void setInboundError(InboundView &view, const QString &key);
    void collectStats();
    void closePreviewsForFullscreenApp();
    void notifyChanged();
    void updateInboundMute();
    double effectiveVolume(const InboundView &view) const;
    QString errorMessage(const CommandResult &r) const;

    ConnectionHandler *m_handler;
    ServerConnection *m_conn;
    Settings *m_settings;
    std::unique_ptr<VideoSource> m_preview;
    std::map<int, std::unique_ptr<VideoSource>> m_pendingSources; // aguardando setupstream
    int m_nextToken = 1;
    std::map<QString, std::unique_ptr<OwnStream>> m_own;
    QMap<QString, InboundView> m_inbound;
    QMap<QString, QList<QJsonObject>> m_earlySignals;
    QTimer m_statsTimer;
    QTimer m_fullscreenTimer;
    QTimer m_changeDebounce;
    // Com o Discord excluído, o OpenSpeak entra na captura da tela: o áudio de quem
    // você assiste vazaria para a sua transmissão, então ele é silenciado.
    bool m_inboundMuted = false;
    bool m_userMuted = false;
};

} // namespace openspeak
