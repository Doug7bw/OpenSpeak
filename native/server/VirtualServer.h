#pragma once
// Servidor virtual: canais, clientes e registro de streams.
// Porta em C++ de server/virtualServer.js. Não toca em mídia: guarda o estado,
// aplica privacidade/limites e repassa `streamsignaling` entre os pares.
// No modo SFU a mídia é do StreamRelay injetado (clid 0 na sinalização).

#include "ProfileStore.h"
#include "Protocol.h"
#include "StreamRelay.h"

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QSet>
#include <QString>

#include <functional>
#include <map>
#include <stdexcept>

namespace openspeak {

class CommandError : public std::runtime_error {
public:
    CommandError(QString code, const QString &message = {})
        : std::runtime_error((message.isEmpty() ? code : message).toStdString()), code(std::move(code)) {}
    QString code;
};

class VirtualServer {
public:
    using SendFn = std::function<void(int clid, const QJsonObject &message)>;

    /// Nome e descrição de cada canal; o padrão é uma sala só, o "Geral".
    using ChannelList = QList<std::pair<QString, QString>>;
    static ChannelList defaultChannels() { return {{QStringLiteral("Geral"), QStringLiteral("Canal padrão")}}; }

    VirtualServer(SendFn send, QString name = QStringLiteral("OpenSpeak"), QJsonArray iceServers = {},
                  const ChannelList &channels = defaultChannels());

    int connect();
    void disconnect(int clid);
    /// A conexão caiu sem logout. Quem entrou com `resumable` continua na sala
    /// ("away", os próprios streams aparecem pausados) até resume() ou
    /// disconnect(); devolve false para os demais (desconecte já).
    bool suspend(int clid);
    /// Retoma a sessão com o token do login; devolve a visão atual da sala ou
    /// lança CommandError(session_expired).
    QJsonObject resume(int clid, const QString &token);

    /// Executa um comando; devolve `data` da resposta ou lança CommandError.
    QJsonObject handle(int clid, const QString &cmd, const QJsonObject &args);

    QString name() const { return m_name; }
    int streamCount() const { return int(m_streams.size()); }
    /// Somente para o arquivo local de monitoramento; não é um comando público.
    QJsonObject monitoringSnapshot() const;
    /// Transmissões ao vivo que o dono deixou anunciar (`announce`), para o bot do
    /// Discord via GET /api/live. Só nomes públicos: nada de uid, IP ou miniatura.
    QJsonObject liveSnapshot() const;
    /// Chamado quando algo que aparece no liveSnapshot() pode ter mudado (stream
    /// começou/mudou/parou, apelido). O ServerHost usa para o webhook do bot.
    void setLiveChangedCallback(std::function<void()> callback) { m_liveChanged = std::move(callback); }
    void setClientLatency(int clid, qint64 milliseconds);

    /// Habilita STREAM_SFU. O relay deve viver mais que o VirtualServer.
    void setRelay(StreamRelay *relay);
    /// Senha exigida no `login` (vazia = servidor aberto).
    void setPassword(const QString &password) { m_password = password; }
    /// Arquivo JSON dos perfis (vazio = só na memória).
    void setProfilesFile(const QString &file) { m_profiles.setFile(file); }
    /// Relógio dos bloqueios por tentativas erradas (testes).
    void setProfileClock(std::function<qint64()> now) { m_profiles = ProfileStore(std::move(now)); }

private:
    struct Client {
        int clid = 0;
        bool loggedIn = false;
        QString nickname;
        QString uid;
        int cid = 0;
        QJsonObject clientInfo;
        qint64 pingMs = -1;
        qint64 pingUpdatedAt = 0;
        qint64 annotationSecond = -1;
        int annotationBatches = 0;
        QString resumeToken; // só para quem entrou com `resumable`
        bool suspended = false;
        QString profile; // chave do perfil, se o cliente provou a senha
    };
    struct Channel {
        int cid = 0;
        int order = 0;
        QString name;
        QString description;
    };
    struct Quality {
        int width = 1280;
        int height = 720;
        int fps = 30;
    };
    struct PendingRequest {
        QJsonArray codecs;
        qint64 since = 0;
        bool websocket = false; // mídia pelo WebSocket de sinalização (só SFU)
    };
    struct Stream {
        QString id;
        int ownerClid = 0;
        int cid = 0;
        int mode = int(StreamMode::P2P);
        qint64 created = 0;
        bool paused = false;
        QString thumbnail;
        QString name;
        int type = int(StreamType::Screen);
        int access = int(StreamAccess::Public);
        int bitrate = 3'000'000;
        int viewerLimit = 0;
        bool audio = false;
        bool announce = true; // aparece no bot do Discord (GET /api/live)
        QString app;          // programa transmitido (janela), informado pelo cliente
        Quality quality;
        QList<int> viewers; // ordem de entrada
        std::map<int, PendingRequest> pending;
        QSet<QString> banned; // uids
    };

    using Handler = QJsonObject (VirtualServer::*)(Client &, const QJsonObject &);
    static const QHash<QString, Handler> &handlers();

    QJsonObject cmdLogin(Client &, const QJsonObject &);
    QJsonObject cmdSync(Client &, const QJsonObject &);
    QJsonObject cmdHeartbeat(Client &, const QJsonObject &);
    QJsonObject cmdClientMove(Client &, const QJsonObject &);
    QJsonObject cmdClientUpdate(Client &, const QJsonObject &);
    QJsonObject cmdSetProfilePassword(Client &, const QJsonObject &);
    QJsonObject cmdUpdateProfile(Client &, const QJsonObject &);
    QJsonObject cmdProfileMedia(Client &, const QJsonObject &);
    QJsonObject cmdSetupStream(Client &, const QJsonObject &);
    QJsonObject cmdUpdateStream(Client &, const QJsonObject &);
    QJsonObject cmdStopStream(Client &, const QJsonObject &);
    QJsonObject cmdStreamThumbnail(Client &, const QJsonObject &);
    QJsonObject cmdRequestStreamInfo(Client &, const QJsonObject &);
    QJsonObject cmdJoinStreamRequest(Client &, const QJsonObject &);
    QJsonObject cmdRespondJoinStreamRequest(Client &, const QJsonObject &);
    QJsonObject cmdRemoveClientFromStream(Client &, const QJsonObject &);
    QJsonObject cmdStreamUnban(Client &, const QJsonObject &);
    QJsonObject cmdStreamSignaling(Client &, const QJsonObject &);
    QJsonObject cmdStreamAnnotation(Client &, const QJsonObject &);

    void applyConfig(Stream &s, const QJsonObject &args);
    Stream &stream(const QJsonValue &id);
    Stream &ownStream(const Client &c, const QJsonValue &id);
    void ban(Stream &s, const QString &uid);
    void removeViewer(Stream &s, int clid, LeaveReason reason);
    void stopStream(QString id, LeaveReason reason);
    void detachFromStreams(const Client &c, LeaveReason reason);
    void notifyAttendees(const Stream &s);
    QJsonObject view(const Client &c) const;
    /// Presença mudou (away): o cliente e os streams dele, que aparecem pausados.
    void broadcastPresence(const Client &c);
    bool isSfu(const Stream &s) const { return m_relay && s.mode == int(StreamMode::SFU); }
    void onRelaySignal(const QString &id, int clid, const QJsonObject &payload);
    void onRelayFailed(const QString &id, int clid);

    void checkProfilePassword(const QString &key, const QJsonValue &password);
    /// Nome que a sala mostra: o de exibição do perfil ou o apelido.
    QString shownName(const Client &c) const;
    QJsonObject publicClient(const Client &c) const;
    QJsonObject publicStream(const Stream &s) const;
    void notify(int clid, const QString &cmd, const QJsonObject &args);
    void broadcast(const QString &cmd, const QJsonObject &args, int exceptClid = 0);
    void broadcastToChannel(int cid, const QString &cmd, const QJsonObject &args, int exceptClid = 0);

    SendFn m_send;
    std::function<void()> m_liveChanged;
    StreamRelay *m_relay = nullptr;
    QString m_name;
    QString m_password;
    ProfileStore m_profiles;
    QJsonArray m_iceServers;
    std::map<int, Client> m_clients;
    std::map<int, Channel> m_channels;
    std::map<QString, Stream> m_streams;
    int m_nextClid = 1;
    int m_nextStreamId = 1;
    int m_defaultChannel = 1;
};

} // namespace openspeak
