#include "SfuEgress.h"
#include "SdpFilter.h"

#include <QRandomGenerator>

#include <algorithm>
#include <cmath>

namespace openspeak {

namespace {
constexpr int MinBitrate = 150'000;

uint64_t ntpNow()
{
    const double secs = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
    return uint64_t(std::floor((secs + 2208988800.) * double(uint64_t(1) << 32))); // 1900 -> 1970
}
} // namespace

/// Sender Report do egress. O RtcpSrReporter da libdatachannel usa o timestamp
/// do último pacote como "agora", o que no repasse mistura o atraso de rede do
/// transmissor de forma diferente para áudio e vídeo; aqui o RTP de "agora"
/// vem do Forwarder, ancorado nos SRs do próprio transmissor (lip-sync).
class SfuEgress::SrReporter final : public rtc::MediaHandler {
public:
    SrReporter(std::shared_ptr<sfu::Forwarder> forwarder, std::shared_ptr<sfu::EgressSink> sink, sfu::Kind kind, uint32_t ssrc,
               std::string cname)
        : m_forwarder(std::move(forwarder)), m_sink(std::move(sink)), m_kind(kind), m_ssrc(ssrc), m_cname(std::move(cname)) {}

    void outgoing(rtc::message_vector &messages, const rtc::message_callback &send) override
    {
        std::lock_guard lock(m_mutex);
        for (const auto &m : messages) {
            if (!m || m->type == rtc::Message::Control || m->size() < 12)
                continue;
            const size_t header = 12 + 4 * size_t(std::to_integer<uint8_t>(m->data()[0]) & 0x0F);
            m_packets++;
            m_octets += uint32_t(m->size() > header ? m->size() - header : 0);
        }
        const auto now = std::chrono::steady_clock::now();
        if (!m_packets || now - m_last < std::chrono::seconds(1))
            return;
        const auto rtp = m_forwarder->rtpNow(m_kind, m_sink.get());
        if (!rtp)
            return;
        m_last = now;
        const auto srSize = rtc::RtcpSr::Size(0);
        auto msg = rtc::make_message(srSize + rtc::RtcpSdes::Size({{uint8_t(m_cname.size())}}), rtc::Message::Control);
        auto *sr = reinterpret_cast<rtc::RtcpSr *>(msg->data());
        sr->setNtpTimestamp(ntpNow());
        sr->setRtpTimestamp(*rtp);
        sr->setPacketCount(m_packets);
        sr->setOctetCount(m_octets);
        sr->preparePacket(m_ssrc, 0);
        auto *sdes = reinterpret_cast<rtc::RtcpSdes *>(msg->data() + srSize);
        auto *chunk = sdes->getChunk(0);
        chunk->setSSRC(m_ssrc);
        auto *item = chunk->getItem(0);
        item->type = 1; // CNAME
        item->setText(m_cname);
        sdes->preparePacket(1);
        send(msg);
    }

private:
    std::shared_ptr<sfu::Forwarder> m_forwarder;
    std::shared_ptr<sfu::EgressSink> m_sink; // vídeo: o timestamp de saída é deste espectador
    const sfu::Kind m_kind;
    const uint32_t m_ssrc;
    const std::string m_cname;
    std::mutex m_mutex;
    uint32_t m_packets = 0, m_octets = 0;
    std::chrono::steady_clock::time_point m_last;
};

SfuEgress::SfuEgress(QString streamId, int viewerClid, QJsonArray iceServers, SignalFn send,
                     std::shared_ptr<sfu::Forwarder> forwarder, QObject *parent)
    : RtcSession(std::move(streamId), viewerClid, std::move(iceServers), false, std::move(send), parent),
      m_forwarder(std::move(forwarder)), m_sink(std::make_shared<sfu::EgressSink>())
{
    m_forwarder->addSink(m_sink);
}

SfuEgress::~SfuEgress() { stop(); }

void SfuEgress::stop()
{
    m_forwarder->removeSink(m_sink);
    m_sink->detach();
    close();
}

void SfuEgress::start()
{
    createPeerConnection();
    sendOffer(false);
}

void SfuEgress::setupPeerConnection(rtc::PeerConnection &pc)
{
    const std::string cname = "openspeak-sfu";
    const std::string msid = "openspeak-" + streamId().toStdString();
    auto *rng = QRandomGenerator::global();
    const uint32_t videoSsrc = rng->generate() | 1;
    const uint32_t audioSsrc = rng->generate() | 1;
    auto forwarder = m_forwarder;
    std::weak_ptr<sfu::EgressSink> weakSink = m_sink;
    auto keyFrame = [forwarder, weakSink] {
        if (const auto sink = weakSink.lock())
            forwarder->requestKeyFrame(sink.get());
    };

    rtc::Description::Video vdesc("video", rtc::Description::Direction::SendOnly);
    vdesc.addH264Codec(sfu::VideoPayloadType, sfu::H264Profile);
    vdesc.addSSRC(videoSsrc, cname, msid, "video");
    auto video = pc.addTrack(vdesc);
    auto vhead = std::make_shared<SrReporter>(forwarder, m_sink, sfu::Kind::Video, videoSsrc, cname);
    auto vstats = std::make_shared<RtpStatsHandler>(sfu::VideoClockRate, true);
    vhead->addToChain(std::make_shared<rtc::RtcpNackResponder>());
    vhead->addToChain(std::make_shared<rtc::PliHandler>(keyFrame)); // PLI do espectador: keyframe da camada dele
    vhead->addToChain(vstats);
    video->setMediaHandler(vhead);
    video->onOpen(keyFrame); // espectador novo começa num keyframe

    rtc::Description::Audio adesc("audio", rtc::Description::Direction::SendOnly);
    adesc.addOpusCodec(sfu::AudioPayloadType);
    adesc.addSSRC(audioSsrc, cname, msid, "audio");
    auto audio = pc.addTrack(adesc);
    auto ahead = std::make_shared<SrReporter>(forwarder, nullptr, sfu::Kind::Audio, audioSsrc, cname);
    ahead->addToChain(std::make_shared<rtc::RtcpNackResponder>());
    audio->setMediaHandler(ahead);

    m_sink->attach(video, audio, videoSsrc, audioSsrc);
    std::lock_guard lock(m_statsMutex);
    m_videoStats = vstats;
    m_prevVideo = {};
}

QString SfuEgress::transformLocalSdp(const QString &sdp) { return sdp::opusStereo(sdp, 510'000); }

QJsonObject SfuEgress::mediaSnapshot()
{
    auto data = monitoringSnapshot();
    data["mediaRxBytes"] = 0;
    data["mediaTxBytes"] = double(m_sink->sentBytes());
    std::lock_guard lock(m_statsMutex);
    if (m_videoStats) {
        const auto stats = m_videoStats->snapshot();
        if (stats.receiverReports) {
            data["lossPercent"] = stats.fractionLost * 100;
            data["jitterMs"] = stats.jitter * 1000;
            if (stats.rttCount)
                data["rttMs"] = stats.rtt * 1000;
            data["nackedPackets"] = double(stats.nackedPackets);
        }
    }
    return data;
}

void SfuEgress::collectStats(int configuredBitrate)
{
    std::shared_ptr<RtpStatsHandler> stats;
    {
        std::lock_guard lock(m_statsMutex);
        stats = m_videoStats;
    }
    if (m_estimate <= 0)
        m_estimate = configuredBitrate;
    if (!stats)
        return;
    // Mesmo AIMD do SessionOutbound do cliente: perda do RR, limitado pelo
    // REMB quando o espectador envia (navegador).
    const RtpCounters c = stats->snapshot();
    if (c.receiverReports != m_prevVideo.receiverReports) {
        if (c.fractionLost > 0.10)
            m_estimate = int(m_estimate * (1.0 - 0.5 * c.fractionLost));
        else if (c.fractionLost < 0.02)
            m_estimate = int(m_estimate * 1.05);
    }
    if (c.rembBitrate > 0)
        m_estimate = std::min<int>(m_estimate, int(c.rembBitrate));
    m_estimate = std::clamp(m_estimate, std::min(MinBitrate, configuredBitrate), configuredBitrate);
    m_prevVideo = c;
}

} // namespace openspeak
