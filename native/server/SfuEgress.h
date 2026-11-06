#pragma once
// Sessão servidor -> um espectador (papel outbound: o servidor oferta).
// Tracks sendonly H.264 (PT 96) e Opus (PT 111) com SSRC próprios; o RTP vem
// pronto do Forwarder. Cadeia: Sender Report (âncora do transmissor), NACK
// (retransmite do buffer próprio), PLI (-> keyframe do transmissor) e
// estatísticas (RR/REMB do espectador, para o controle de banda).

#include "RtcSession.h"
#include "RtpStatsHandler.h"
#include "SfuForwarder.h"

#include <mutex>

namespace openspeak {

class SfuEgress : public RtcSession {
    Q_OBJECT
public:
    SfuEgress(QString streamId, int viewerClid, QJsonArray iceServers, SignalFn send,
              std::shared_ptr<sfu::Forwarder> forwarder, QObject *parent = nullptr);
    ~SfuEgress() override;

    void start() override;
    /// Sai do repasse e fecha a PeerConnection (antes do deleteLater).
    void stop();

    /// Atualiza a estimativa de banda deste espectador (1 Hz).
    void collectStats(int configuredBitrate);
    int estimatedBitrate() const { return m_estimate; }
    /// Saída deste espectador no Forwarder (escolha de camada do simulcast).
    const sfu::EgressSink *sink() const { return m_sink.get(); }
    QJsonObject mediaSnapshot();

protected:
    void setupPeerConnection(rtc::PeerConnection &pc) override;
    QString transformLocalSdp(const QString &sdp) override;

private:
    class SrReporter;

    std::shared_ptr<sfu::Forwarder> m_forwarder;
    std::shared_ptr<sfu::EgressSink> m_sink;
    std::mutex m_statsMutex;
    std::shared_ptr<RtpStatsHandler> m_videoStats;
    RtpCounters m_prevVideo;
    int m_estimate = 0;
};

} // namespace openspeak
