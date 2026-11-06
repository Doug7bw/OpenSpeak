#include "SfuIngest.h"
#include "RtpRecovery.h"
#include "SdpFilter.h"

#include <atomic>

namespace openspeak {
QJsonObject SfuIngest::mediaSnapshot() const
{
    auto data = monitoringSnapshot();
    data["mediaRxBytes"] = double(m_forwarder->receivedBytes());
    data["mediaTxBytes"] = 0;
    return data;
}

namespace {

uint8_t u8(const std::byte *p) { return std::to_integer<uint8_t>(*p); }
uint32_t be32(const std::byte *p)
{
    return uint32_t(u8(p)) << 24 | uint32_t(u8(p + 1)) << 16 | uint32_t(u8(p + 2)) << 8 | uint32_t(u8(p + 3));
}

/// Cabeça da cadeia: descarta o que sobrou (ninguém lê a fila da track).
class Drain final : public rtc::MediaHandler {
public:
    void incoming(rtc::message_vector &messages, const rtc::message_callback &) override { messages.clear(); }
};

} // namespace

/// Fim da cadeia (vê a entrada primeiro): RTP vai ao Forwarder, SR vira âncora
/// de sincronismo. Não altera as mensagens; a RtcpReceivingSession vem depois.
class SfuIngest::Tap final : public rtc::MediaHandler {
public:
    Tap(std::shared_ptr<sfu::Forwarder> forwarder, sfu::Kind kind, int layer)
        : m_forwarder(std::move(forwarder)), m_kind(kind), m_layer(layer) {}
    void retire() { m_active = false; }

    void incoming(rtc::message_vector &messages, const rtc::message_callback &) override
    {
        if (!m_active)
            return;
        for (const auto &m : messages) {
            if (!m)
                continue;
            if (m->type == rtc::Message::Control)
                onRtcp(m->data(), m->size());
            else if (m->type == rtc::Message::Binary)
                m_forwarder->onRtp(m_kind, m_layer, m->data(), m->size());
        }
    }

private:
    void onRtcp(const std::byte *data, size_t size)
    {
        // Pacote composto: procura o SR (PT 200) = SSRC + NTP(8) + RTP(4).
        size_t offset = 0;
        while (offset + 4 <= size) {
            const std::byte *p = data + offset;
            if ((u8(p) >> 6) != 2)
                break;
            const size_t len = (size_t(u8(p + 2) << 8 | u8(p + 3)) + 1) * 4;
            if (offset + len > size)
                break;
            if (u8(p + 1) == 200 && len >= 28)
                m_forwarder->onSenderReport(m_kind, m_layer, be32(p + 4), be32(p + 16));
            offset += len;
        }
    }

    std::shared_ptr<sfu::Forwarder> m_forwarder;
    const sfu::Kind m_kind;
    const int m_layer;
    std::atomic<bool> m_active{true};
};

SfuIngest::SfuIngest(QString streamId, int ownerClid, QJsonArray iceServers, SignalFn send,
                     std::shared_ptr<sfu::Forwarder> forwarder, QObject *parent)
    : RtcSession(std::move(streamId), ownerClid, std::move(iceServers), true, std::move(send), parent),
      m_forwarder(std::move(forwarder))
{
}

SfuIngest::~SfuIngest()
{
    retireTaps();
    close();
}

void SfuIngest::start()
{
    // O transmissor oferta logo após o setupstream; se a oferta não vier, o
    // timeout de conexão da base pede uma nova (kReconnect).
    createPeerConnection();
}

void SfuIngest::setupPeerConnection(rtc::PeerConnection &)
{
    // PeerConnection nova (reconexão): o que chegar das tracks antigas não
    // deve mais alcançar os espectadores.
    retireTaps();
}

void SfuIngest::retireTaps()
{
    std::lock_guard lock(m_trackMutex);
    for (const auto &tap : m_taps)
        tap->retire();
    for (const auto &track : m_tracks)
        track->resetCallbacks();
    m_taps.clear();
    m_tracks.clear();
    for (int layer = 0; layer < sfu::MaxLayers; ++layer)
        m_forwarder->setIngestVideoTrack(layer, nullptr);
}

void SfuIngest::onRemoteTrack(std::shared_ptr<rtc::Track> track)
{
    // Thread do libdatachannel.
    const auto desc = track->description();
    sfu::Kind kind;
    if (desc.type() == "video")
        kind = sfu::Kind::Video;
    else if (desc.type() == "audio")
        kind = sfu::Kind::Audio;
    else
        return;
    // Simulcast do transmissor nativo: a camada baixa vem numa m-line própria.
    const int layer = kind == sfu::Kind::Video && desc.mid() == sfu::LowLayerMid ? sfu::LowLayer : sfu::HighLayer;

    // A entrada percorre a cadeia do fim para o início:
    // recuperação (NACK) -> Tap -> sessão RTCP -> Drain.
    auto drain = std::make_shared<Drain>();
    auto session = std::make_shared<rtc::RtcpReceivingSession>(); // RR + PLI + REMB
    auto tap = std::make_shared<Tap>(m_forwarder, kind, layer);
    track->setMediaHandler(drain);
    drain->addToChain(session);
    drain->addToChain(tap);
    if (kind == sfu::Kind::Video) // reenvio do que se perdeu no caminho até o SFU
        drain->addToChain(std::make_shared<RtpRecoveryHandler>(RtpRecoveryBuffer::Mode::PassThrough));
    if (kind == sfu::Kind::Video) {
        m_forwarder->setIngestVideoTrack(layer, track);
        auto forwarder = m_forwarder;
        track->onOpen([forwarder] { forwarder->requestKeyFrame(); });
    }
    std::lock_guard lock(m_trackMutex);
    m_tracks.push_back(track);
    m_taps.push_back(tap);
}

QString SfuIngest::transformRemoteSdp(const QString &sdp)
{
    // Modo SFU: codec fixo, sem transcodificação.
    return sdp::keepH264ConstrainedBaseline(sdp::filterCodecs(sdp, {QStringLiteral("H264")}, {QStringLiteral("opus")}));
}

QString SfuIngest::transformLocalSdp(const QString &sdp) { return sdp::opusStereo(sdp, 510'000); }

} // namespace openspeak
