#pragma once
// Transporte do servidor: HTTP (cliente web opcional) + WebSocket em /ws na mesma porta.
// Com OPENSPEAK_HAS_SFU, também o relay de mídia (STREAM_SFU) numa porta UDP própria.

#include "DiscordAuth.h"
#include "LogStore.h"
#include "VirtualServer.h"

#include <QDir>
#include <QHash>
#include <QHttpServer>
#include <QNetworkAccessManager>
#include <QUrl>
#include <QObject>
#include <QTcpServer>
#include <QTimer>
#include <QWebSocket>

#include <memory>

namespace openspeak {

class ServerHost : public QObject {
    Q_OBJECT
public:
    struct Options {
        quint16 port = 9988;
        QHostAddress address = QHostAddress::Any;
        QString name = QStringLiteral("OpenSpeak");
        QJsonArray iceServers;
        QString webRoot; // vazio = não serve o cliente web
        bool sfu = false;        // relay de mídia (exige build com OPENSPEAK_HAS_SFU)
        quint16 rtcPort = 10000; // UDP mux do relay (0 = portas efêmeras)
        QString publicIp;        // IP anunciado nos candidatos do relay (NAT 1:1)
        QString discordClientId, discordClientSecret; // login da atividade do Discord (opcional)
        QString password;     // exigida no login (vazia = servidor aberto)
        QString passwordFile; // se existir, vale no lugar de `password` (o monitor troca a senha nele)
        QString profilesFile; // JSON dos perfis (vazio = só na memória)
        LogStore *logs = nullptr; // guarda os registros dos clientes (CLIENT_LOGS); nulo = não guarda
    };

    explicit ServerHost(Options options, QObject *parent = nullptr);
    bool start();
    quint16 port() const;
    bool sfuEnabled() const { return m_relay != nullptr; }
    /// Este binário foi compilado com o relay de mídia?
    static bool sfuAvailable();

private:
    void onNewWebSocket();
    void onMessage(QWebSocket *ws, const QString &text);
    void onSocketClosed(QWebSocket *ws);
    /// `login` com resumeToken: o socket novo assume a sessão antiga.
    void resumeSession(QWebSocket *ws, int tempClid, const QJsonObject &msg);
    /// Remove o cliente de vez (logout, sessão sem retomada ou espera esgotada).
    void dropClient(int clid);
    void sendTo(int clid, const QJsonObject &message);
    /// Senha vigente: relida do arquivo a cada login, para trocar sem reiniciar.
    QString currentPassword() const;
    void heartbeat();
    void writeMonitoringSnapshot();
    void sendLiveWebhook();
    QJsonObject liveSnapshot() const;
    void sampleMediaRate();

    Options m_options;
    QHttpServer m_http;
    QTcpServer *m_tcp = nullptr;
    std::unique_ptr<StreamRelay> m_relay; // declarado antes: vive mais que o VirtualServer
    VirtualServer m_server;
    DiscordAuth m_discord;
    QHash<int, QWebSocket *> m_sockets;
    QHash<QWebSocket *, int> m_clids; // inverso de m_sockets (a retomada troca o socket de um clid)
    QHash<QWebSocket *, bool> m_alive;
    // Sessões com a conexão caída esperando a retomada (SessionGraceMs). As
    // notificações ficam guardadas e vão, em ordem, antes da resposta da retomada.
    struct Suspension {
        qint64 since = 0;
        QStringList backlog;
        qint64 backlogBytes = 0;
    };
    QHash<int, Suspension> m_suspended;
    struct ConnectionInfo {
        QString ip, userAgent, origin;
        qint64 connectedAt = 0, lastActivityAt = 0;
        qint64 pingRttMs = -1;
        quint64 rxBytes = 0, txBytes = 0;
    };
    QHash<int, ConnectionInfo> m_connectionInfo;
    QTimer m_heartbeat;
    QTimer m_logPrune;
    QTimer m_monitoring;
    QString m_monitoringFile;
    quint64 m_signalingRx = 0, m_signalingTx = 0;
    quint64 m_mediaTx = 0; // espectadores por WebSocket (SfuWsViewer)
    // Tráfego de mídia do relay (entrada + saída), medido a cada heartbeat (que
    // também manda o webhook do bot se o Mbps arredondado mudou).
    QHash<QString, double> m_mediaBytes; // sessão -> bytes na amostra anterior
    qint64 m_mediaSampledAt = 0;
    double m_mediaMbps = 0;
    // Total por stream do relay, para o bot (fim da transmissão): o que o transmissor
    // enviou ao servidor e o que o servidor entregou aos espectadores (inclusive os que já saíram).
    struct MediaTotals {
        double sent = 0, received = 0;
    };
    QHash<QString, MediaTotals> m_streamMedia;
    // Webhook do bot do Discord (OPENSPEAK_LIVE_WEBHOOK): POST do liveSnapshot() quando muda.
    QUrl m_liveWebhook;
    bool m_liveEnabled = false;
    QByteArray m_liveSecret, m_lastLive;
    QTimer m_liveDebounce;
    QNetworkAccessManager m_liveNetwork;
};

} // namespace openspeak
