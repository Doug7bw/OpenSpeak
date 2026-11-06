#include "SfuForwarder.h"

#include <algorithm>

namespace openspeak::sfu {

namespace {

uint8_t u8(const std::byte *p) { return std::to_integer<uint8_t>(*p); }
uint16_t be16(const std::byte *p) { return uint16_t(u8(p) << 8 | u8(p + 1)); }
uint32_t be32(const std::byte *p)
{
    return uint32_t(u8(p)) << 24 | uint32_t(u8(p + 1)) << 16 | uint32_t(u8(p + 2)) << 8 | uint32_t(u8(p + 3));
}
void put16(std::byte *p, uint16_t v)
{
    p[0] = std::byte(v >> 8);
    p[1] = std::byte(v & 0xFF);
}
void put32(std::byte *p, uint32_t v)
{
    for (int i = 0; i < 4; ++i)
        p[i] = std::byte((v >> (24 - 8 * i)) & 0xFF);
}

uint32_t ticks(std::chrono::steady_clock::duration d, uint32_t clockRate)
{
    return uint32_t(std::max(0.0, std::chrono::duration<double>(d).count()) * clockRate);
}

constexpr uint8_t NalIdr = 5, NalSps = 7, NalStapA = 24, NalFuA = 28;
bool startsKeyFrame(uint8_t nalType) { return nalType == NalIdr || nalType == NalSps; }

/// Depois de abrir uma camada, por quantos pacotes descartar os anteriores ao
/// keyframe (retransmissões atrasadas); passado isso a comparação de seq daria
/// a volta nos 16 bits.
constexpr int SwitchGuardPackets = 4000;

} // namespace

bool isKeyFrameStart(const std::byte *data, size_t size)
{
    if (size < 13)
        return false;
    const uint8_t b0 = u8(data);
    size_t at = 12 + 4 * size_t(b0 & 0x0F);
    if (b0 & 0x10) {
        if (size < at + 4)
            return false;
        at += 4 + 4 * size_t(u8(data + at + 2) << 8 | u8(data + at + 3));
    }
    if (size <= at)
        return false;
    const std::byte *p = data + at;
    const size_t n = size - at;
    const uint8_t type = u8(p) & 0x1F;
    if (type == NalStapA) {
        for (size_t i = 1; i + 2 < n;) {
            const size_t len = size_t(u8(p + i) << 8 | u8(p + i + 1));
            if (len == 0 || i + 2 + len > n)
                break;
            if (startsKeyFrame(u8(p + i + 2) & 0x1F))
                return true;
            i += 2 + len;
        }
        return false;
    }
    if (type == NalFuA)
        return n >= 2 && (u8(p + 1) & 0x80) && startsKeyFrame(u8(p + 1) & 0x1F);
    return startsKeyFrame(type);
}

// ================================================================ EgressSink

void EgressSink::attach(std::shared_ptr<rtc::Track> video, std::shared_ptr<rtc::Track> audio, uint32_t videoSsrc, uint32_t audioSsrc)
{
    std::lock_guard lock(m_mutex);
    m_video = std::move(video);
    m_audio = std::move(audio);
    m_videoSsrc = videoSsrc;
    m_audioSsrc = audioSsrc;
}

void EgressSink::detach()
{
    std::lock_guard lock(m_mutex);
    m_video.reset();
    m_audio.reset();
}

void EgressSink::send(Kind kind, rtc::binary packet)
{
    std::shared_ptr<rtc::Track> track;
    uint32_t ssrc = 0;
    {
        std::lock_guard lock(m_mutex);
        track = kind == Kind::Video ? m_video : m_audio;
        ssrc = kind == Kind::Video ? m_videoSsrc : m_audioSsrc;
    }
    if (!track || !track->isOpen() || packet.size() < 12)
        return;
    put32(packet.data() + 8, ssrc);
    const size_t size = packet.size();
    try {
        track->send(std::move(packet));
        m_sentBytes += size;
    } catch (const std::exception &) {
        // track fechando durante uma reconexão do espectador
    }
}

// ==================================================================== Output

void Forwarder::Output::rebase(uint32_t ssrc, uint16_t seq, uint32_t ts, Clock::time_point now, uint32_t rate)
{
    // Fonte nova (início, transmissor reconectado ou troca de camada): continua
    // a numeração de saída de onde parou, avançando o relógio RTP pelo tempo
    // real que passou.
    if (started) {
        const uint32_t step = std::max<uint32_t>(1, ticks(now - lastAt, rate));
        seqOffset = uint16_t(lastSeq + 1 - seq);
        tsOffset = lastTs + step - ts;
    }
    started = true;
    srcSsrc = ssrc;
    lastSeq = uint16_t(seq + seqOffset - 1);
    lastTs = ts + tsOffset;
    lastAt = now;
}

void Forwarder::Output::advance(uint16_t outSeq, uint32_t outTs, Clock::time_point now)
{
    if (int16_t(outSeq - lastSeq) > 0) {
        lastSeq = outSeq;
        lastTs = outTs;
        lastAt = now;
    }
}

// ================================================================= Forwarder

void Forwarder::setIngestVideoTrack(int layer, const std::shared_ptr<rtc::Track> &track)
{
    if (layer < 0 || layer >= MaxLayers)
        return;
    std::lock_guard lock(m_mutex);
    m_video[size_t(layer)].ingest = track;
}

Forwarder::SinkState *Forwarder::findLocked(const EgressSink *sink)
{
    for (SinkState &s : m_sinks)
        if (s.sink.get() == sink)
            return &s;
    return nullptr;
}

const Forwarder::SinkState *Forwarder::findLocked(const EgressSink *sink) const
{
    for (const SinkState &s : m_sinks)
        if (s.sink.get() == sink)
            return &s;
    return nullptr;
}

bool Forwarder::aliveLocked(int layer, Clock::time_point now) const
{
    const Source &src = m_video[size_t(layer)];
    return src.started && now - src.lastAt < LayerTimeout;
}

int Forwarder::targetLocked(const SinkState &s, Clock::time_point now) const
{
    if (aliveLocked(s.wanted, now))
        return s.wanted;
    for (int layer = 0; layer < MaxLayers; ++layer)
        if (layer != s.wanted && aliveLocked(layer, now))
            return layer;
    return s.wanted;
}

void Forwarder::markKeyFrameLocked(int layer) { m_video[size_t(layer)].keyFramePending = true; }

std::vector<std::shared_ptr<rtc::Track>> Forwarder::takeKeyFrameRequestsLocked(Clock::time_point now)
{
    std::vector<std::shared_ptr<rtc::Track>> out;
    for (Source &src : m_video) {
        if (!src.keyFramePending || now - src.lastKeyFrameRequest < KeyFrameInterval)
            continue;
        auto track = src.ingest.lock();
        if (!track || !track->isOpen())
            continue;
        src.keyFramePending = false;
        src.lastKeyFrameRequest = now;
        out.push_back(std::move(track));
    }
    return out;
}

void Forwarder::sendPlis(const std::vector<std::shared_ptr<rtc::Track>> &tracks)
{
    for (const auto &track : tracks) {
        try {
            track->requestKeyframe();
        } catch (const std::exception &) {
        }
    }
}

void Forwarder::onVideoLocked(int layer, uint32_t ssrc, uint16_t seq, uint32_t ts, bool keyStart, Clock::time_point now,
                              const rtc::binary &base, std::vector<std::pair<std::shared_ptr<EgressSink>, rtc::binary>> &out)
{
    Source &src = m_video[size_t(layer)];
    if (!src.started || src.ssrc != ssrc) {
        src.started = true;
        src.ssrc = ssrc;
        src.haveSr = false;
        src.keyFramePending = true; // os espectadores precisam de um IDR da fonte nova
    }
    src.lastAt = now;

    for (SinkState &s : m_sinks) {
        const int target = targetLocked(s, now);
        if (s.layer == layer && s.out.srcSsrc == ssrc) {
            // Já nesta camada (mesmo que esperando trocar para outra: até o
            // keyframe dela, segue nesta). Retransmissões de antes do keyframe
            // que abriu a camada não fazem sentido para este espectador.
            if (s.guardLeft > 0) {
                --s.guardLeft;
                if (int16_t(seq - s.firstSeq) < 0)
                    continue;
            }
        } else if (target == layer && keyStart) {
            s.out.rebase(ssrc, seq, ts, now, VideoClockRate);
            s.layer = layer;
            s.firstSeq = seq;
            s.guardLeft = SwitchGuardPackets;
        } else {
            if (target == layer)
                markKeyFrameLocked(layer); // esperando um keyframe desta camada
            continue;
        }
        const uint16_t outSeq = uint16_t(seq + s.out.seqOffset);
        const uint32_t outTs = ts + s.out.tsOffset;
        s.out.advance(outSeq, outTs, now);
        rtc::binary packet = base;
        put16(packet.data() + 2, outSeq);
        put32(packet.data() + 4, outTs);
        out.emplace_back(s.sink, std::move(packet));
    }
}

void Forwarder::onRtp(Kind kind, int layer, const std::byte *data, size_t size)
{
    // Cabeçalho RTP: V=2, CC CSRCs e, se X, uma extensão (perfil + tamanho em palavras).
    if (size < 12 || (u8(data) >> 6) != 2 || layer < 0 || layer >= MaxLayers)
        return;
    const uint8_t b0 = u8(data);
    const size_t header = 12 + 4 * size_t(b0 & 0x0F);
    if (size < header)
        return;
    size_t payloadAt = header;
    if (b0 & 0x10) {
        if (size < header + 4)
            return;
        payloadAt = header + 4 + 4 * size_t(be16(data + header + 2));
        if (size < payloadAt)
            return;
    }
    const uint16_t seq = be16(data + 2);
    m_receivedBytes += size;
    const uint32_t ts = be32(data + 4);
    const uint32_t ssrc = be32(data + 8);
    const auto now = Clock::now();

    // Pacote de saída sem extensão e com o PT fixo; seq/ts entram por espectador.
    rtc::binary base;
    base.reserve(header + (size - payloadAt));
    base.assign(data, data + header);
    base[0] = std::byte(b0 & ~0x10);
    base[1] = std::byte((u8(data + 1) & 0x80) | (kind == Kind::Video ? VideoPayloadType : AudioPayloadType));
    base.insert(base.end(), data + payloadAt, data + size);

    std::vector<std::pair<std::shared_ptr<EgressSink>, rtc::binary>> out;
    std::vector<std::shared_ptr<rtc::Track>> plis;
    {
        std::lock_guard lock(m_mutex);
        if (kind == Kind::Video) {
            onVideoLocked(layer, ssrc, seq, ts, isKeyFrameStart(data, size), now, base, out);
            plis = takeKeyFrameRequestsLocked(now);
        } else {
            Output &o = m_audio.out;
            if (!o.started || ssrc != o.srcSsrc) {
                o.rebase(ssrc, seq, ts, now, AudioClockRate);
                m_audio.haveSr = false;
            }
            const uint16_t outSeq = uint16_t(seq + o.seqOffset);
            const uint32_t outTs = ts + o.tsOffset;
            o.advance(outSeq, outTs, now);
            put16(base.data() + 2, outSeq);
            put32(base.data() + 4, outTs);
            out.reserve(m_sinks.size());
            for (const SinkState &s : m_sinks)
                out.emplace_back(s.sink, base);
        }
    }
    sendPlis(plis);
    for (auto &[sink, packet] : out)
        sink->send(kind, std::move(packet));
}

void Forwarder::onSenderReport(Kind kind, int layer, uint32_t ssrc, uint32_t rtpTimestamp)
{
    std::lock_guard lock(m_mutex);
    if (kind == Kind::Audio) {
        if (!m_audio.out.started || ssrc != m_audio.out.srcSsrc)
            return;
        m_audio.haveSr = true;
        m_audio.srRtp = rtpTimestamp;
        m_audio.srAt = Clock::now();
        return;
    }
    if (layer < 0 || layer >= MaxLayers)
        return;
    Source &src = m_video[size_t(layer)];
    if (!src.started || ssrc != src.ssrc)
        return;
    src.haveSr = true;
    src.srRtp = rtpTimestamp;
    src.srAt = Clock::now();
}

std::optional<uint32_t> Forwarder::rtpNow(Kind kind, const EgressSink *sink) const
{
    std::lock_guard lock(m_mutex);
    const auto now = Clock::now();
    // Com SR do transmissor, seguimos a âncora dele (mesma referência para
    // áudio e vídeo); sem SR, o último pacote repassado vale como "agora".
    if (kind == Kind::Audio) {
        const Output &o = m_audio.out;
        if (!o.started)
            return std::nullopt;
        if (m_audio.haveSr)
            return m_audio.srRtp + o.tsOffset + ticks(now - m_audio.srAt, AudioClockRate);
        return o.lastTs + ticks(now - o.lastAt, AudioClockRate);
    }
    const SinkState *s = findLocked(sink);
    if (!s || s->layer < 0 || !s->out.started)
        return std::nullopt;
    const Source &src = m_video[size_t(s->layer)];
    if (src.haveSr && src.ssrc == s->out.srcSsrc)
        return src.srRtp + s->out.tsOffset + ticks(now - src.srAt, VideoClockRate);
    return s->out.lastTs + ticks(now - s->out.lastAt, VideoClockRate);
}

void Forwarder::addSink(const std::shared_ptr<EgressSink> &sink)
{
    std::lock_guard lock(m_mutex);
    if (findLocked(sink.get()))
        return;
    SinkState s;
    s.sink = sink;
    m_sinks.push_back(std::move(s));
}

void Forwarder::removeSink(const std::shared_ptr<EgressSink> &sink)
{
    std::lock_guard lock(m_mutex);
    m_sinks.erase(std::remove_if(m_sinks.begin(), m_sinks.end(), [&](const SinkState &s) { return s.sink == sink; }),
                  m_sinks.end());
}

void Forwarder::setSinkLayer(const EgressSink *sink, int layer)
{
    if (layer < 0 || layer >= MaxLayers)
        return;
    std::vector<std::shared_ptr<rtc::Track>> plis;
    {
        std::lock_guard lock(m_mutex);
        SinkState *s = findLocked(sink);
        if (!s || s->wanted == layer)
            return;
        s->wanted = layer;
        const int target = targetLocked(*s, Clock::now());
        if (target != s->layer)
            markKeyFrameLocked(target);
        plis = takeKeyFrameRequestsLocked(Clock::now());
    }
    sendPlis(plis);
}

int Forwarder::sinkLayer(const EgressSink *sink) const
{
    std::lock_guard lock(m_mutex);
    const SinkState *s = findLocked(sink);
    return s ? s->layer : -1;
}

bool Forwarder::hasLayer(int layer) const
{
    if (layer < 0 || layer >= MaxLayers)
        return false;
    std::lock_guard lock(m_mutex);
    return aliveLocked(layer, Clock::now());
}

void Forwarder::requestKeyFrame()
{
    std::vector<std::shared_ptr<rtc::Track>> plis;
    {
        std::lock_guard lock(m_mutex);
        for (int layer = 0; layer < MaxLayers; ++layer)
            markKeyFrameLocked(layer);
        plis = takeKeyFrameRequestsLocked(Clock::now());
    }
    sendPlis(plis); // os que estão na janela saem com o próximo pacote de vídeo
}

void Forwarder::requestKeyFrame(const EgressSink *sink)
{
    std::vector<std::shared_ptr<rtc::Track>> plis;
    {
        std::lock_guard lock(m_mutex);
        const auto now = Clock::now();
        const SinkState *s = findLocked(sink);
        if (s)
            markKeyFrameLocked(targetLocked(*s, now));
        else
            for (int layer = 0; layer < MaxLayers; ++layer)
                markKeyFrameLocked(layer);
        plis = takeKeyFrameRequestsLocked(now);
    }
    sendPlis(plis);
}

void Forwarder::requestBitrate(int layer, unsigned int bitrate)
{
    if (layer < 0 || layer >= MaxLayers)
        return;
    std::shared_ptr<rtc::Track> track;
    {
        std::lock_guard lock(m_mutex);
        track = m_video[size_t(layer)].ingest.lock();
    }
    if (!track || !track->isOpen())
        return;
    try {
        track->requestBitrate(bitrate);
    } catch (const std::exception &) {
    }
}

} // namespace openspeak::sfu
