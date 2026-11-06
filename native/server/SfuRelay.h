#pragma once
// Relay de mídia do servidor (STREAM_SFU): por stream, uma SfuIngest com o
// transmissor, um Forwarder e uma SfuEgress por espectador.
//
// Cenário alvo: 1 transmissor, poucos espectadores, codec fixo H.264 + Opus,
// repassado sem transcodificar. O transmissor nativo manda duas camadas de
// vídeo (simulcast); cada espectador recebe a alta ou a baixa, conforme a banda
// dele (automático) ou o que ele escolher. A camada atual vai ao espectador por
// `streamsignaling` com {type:'layer', simulcast, layer, preference}, e ele
// escolhe mandando {type:'layer', preference:'auto'|'high'|'low'} ao clid 0.

#include "RtcSession.h"
#include "SfuLayerPolicy.h"
#include "StreamRelay.h"

#include <QHash>
#include <QJsonArray>
#include <QObject>
#include <QTimer>

#include <map>
#include <memory>

namespace openspeak {

class SfuEgress;
class SfuIngest;
class SfuWsViewer;
namespace sfu { class Forwarder; }
using sfu::LayerPolicy;
using sfu::LayerPreference;

class SfuRelay : public QObject, public StreamRelay {
    Q_OBJECT
public:
    struct Options {
        QJsonArray iceServers;          // STUN do próprio servidor (OPENSPEAK_ICE)
        RtcSession::Transport transport; // porta UDP única + IP público anunciado
    };

    explicit SfuRelay(Options options, QObject *parent = nullptr);
    ~SfuRelay() override;

    void setCallbacks(SignalFn signal, FailFn failed) override;
    void openStream(const QString &streamId, int ownerClid, int bitrate) override;
    void updateStream(const QString &streamId, int bitrate) override;
    void closeStream(const QString &streamId) override;
    void addViewer(const QString &streamId, int clid) override;
    bool addWebSocketViewer(const QString &streamId, int clid) override;
    void setBinarySender(BinaryFn send) override;
    void removeViewer(const QString &streamId, int clid) override;
    void signaling(const QString &streamId, int fromClid, const QJsonObject &payload) override;
    void resumePeer(int clid) override;
    QJsonArray monitoringSessions() override;

    /// Piso do bitrate pedido ao transmissor: um espectador ruim não derruba
    /// a qualidade de todos abaixo disso.
    static constexpr int MinTargetBitrate = 300'000;
    /// Com simulcast, a camada alta não desce abaixo desta fração do bitrate do
    /// stream por causa de um espectador: quem não aguenta vai para a baixa.
    static constexpr double HighLayerFloor = LayerPolicy::DownRatio;

private:
    struct ViewerLayer {
        LayerPolicy policy;
        int sent = -2;           // última camada informada ao espectador
        bool sentSimulcast = false;
        LayerPreference sentPreference = LayerPreference::Auto;
    };
    struct Stream {
        QString id;
        int ownerClid = 0;
        int bitrate = 0;
        std::shared_ptr<sfu::Forwarder> forwarder;
        SfuIngest *ingest = nullptr;
        std::map<int, SfuEgress *> viewers;
        std::map<int, SfuWsViewer *> wsViewers; // fora do controle de banda (sem RR/REMB)
        std::map<int, ViewerLayer> layers;        // por espectador (WebRTC ou WebSocket)
    };

    template <typename Session> void wire(Session *session, const QString &streamId, int clid);
    void dispose(QObject *session);
    void adjustBitrates();
    /// Camadas e bitrates do stream; `collect` atualiza as estimativas (1 Hz).
    void adjust(Stream &s, bool collect);
    /// Informa ao espectador a camada atual, se mudou.
    void reportLayer(Stream &s, int clid, ViewerLayer &v, bool simulcast, int layer);

    Options m_options;
    SignalFn m_signal;
    FailFn m_failed;
    BinaryFn m_binary;
    std::map<QString, Stream> m_streams;
    QTimer m_statsTimer;
};

} // namespace openspeak
