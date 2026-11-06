#include "RtpStatsHandler.h"

#include <algorithm>
#include <bit>
#include <cmath>

namespace openspeak {

namespace {

uint16_t be16(const std::byte *p) { return uint16_t(std::to_integer<uint8_t>(p[0]) << 8 | std::to_integer<uint8_t>(p[1])); }
uint32_t be32(const std::byte *p)
{
    return uint32_t(std::to_integer<uint8_t>(p[0])) << 24 | uint32_t(std::to_integer<uint8_t>(p[1])) << 16
         | uint32_t(std::to_integer<uint8_t>(p[2])) << 8 | uint32_t(std::to_integer<uint8_t>(p[3]));
}
uint8_t u8(const std::byte *p) { return std::to_integer<uint8_t>(*p); }

bool looksLikeRtcp(const std::byte *data, size_t size)
{
    return size >= 8 && (u8(data) >> 6) == 2 && u8(data + 1) >= 192 && u8(data + 1) <= 223;
}

} // namespace

uint32_t ntpMiddle32Now()
{
    using namespace std::chrono;
    constexpr uint64_t NtpOffset = 2208988800ULL; // 1900 -> 1970
    const auto now = duration_cast<microseconds>(system_clock::now().time_since_epoch()).count();
    const uint64_t seconds = uint64_t(now / 1'000'000) + NtpOffset;
    const uint64_t fraction = (uint64_t(now % 1'000'000) << 32) / 1'000'000;
    return uint32_t(((seconds & 0xFFFF) << 16) | (fraction >> 16));
}

RtpStatsHandler::RtpStatsHandler(uint32_t clockRate, bool sender) : m_clockRate(clockRate), m_sender(sender) {}

RtpCounters RtpStatsHandler::snapshot() const
{
    std::lock_guard lock(m_mutex);
    return m_c;
}

void RtpStatsHandler::outgoing(rtc::message_vector &messages, const rtc::message_callback &)
{
    std::lock_guard lock(m_mutex);
    for (const auto &m : messages) {
        if (!m || m->type == rtc::Message::Control || looksLikeRtcp(m->data(), m->size()))
            continue;
        if (m->size() >= 12 && m_ssrc == 0)
            m_ssrc = be32(m->data() + 8);
        m_c.packetsSent++;
        m_c.bytesSent += m->size();
    }
}

void RtpStatsHandler::incoming(rtc::message_vector &messages, const rtc::message_callback &)
{
    for (const auto &m : messages) {
        if (!m)
            continue;
        if (m->type == rtc::Message::Control || looksLikeRtcp(m->data(), m->size()))
            onRtcp(m->data(), m->size());
        else if (!m_sender)
            onRtp(m->data(), m->size());
    }
}

void RtpStatsHandler::onRtp(const std::byte *data, size_t size)
{
    if (size < 12)
        return;
    std::lock_guard lock(m_mutex);
    const uint16_t seq = be16(data + 2);
    const uint32_t ts = be32(data + 4);
    m_c.packetsReceived++;
    m_c.bytesReceived += size;

    if (!m_haveSeq) {
        m_haveSeq = true;
        m_maxSeq = seq;
        m_baseSeq = seq;
    } else {
        const uint16_t delta = uint16_t(seq - m_maxSeq);
        if (delta < 0x8000) { // em ordem (com tolerância a wrap)
            if (seq < m_maxSeq)
                m_cycles += 1u << 16;
            m_maxSeq = seq;
        }
    }
    const int64_t expected = int64_t(m_cycles + m_maxSeq) - int64_t(m_baseSeq) + 1;
    m_c.packetsLost = std::max<int64_t>(0, expected - int64_t(m_c.packetsReceived));

    // Jitter entre chegadas (RFC 3550 §6.4.1), em unidades do relógio RTP.
    const double arrival = std::chrono::duration<double>(std::chrono::steady_clock::now() - m_epoch).count() * m_clockRate;
    const double transit = arrival - double(ts);
    if (m_haveTransit) {
        const double d = std::abs(transit - m_transit);
        m_c.jitter += (d / m_clockRate - m_c.jitter) / 16.0;
    }
    m_transit = transit;
    m_haveTransit = true;
}

void RtpStatsHandler::onRtcp(const std::byte *data, size_t size)
{
    std::lock_guard lock(m_mutex);
    size_t offset = 0;
    while (offset + 4 <= size) {
        const std::byte *p = data + offset;
        if ((u8(p) >> 6) != 2)
            break;
        const int count = u8(p) & 0x1F;
        const int pt = u8(p + 1);
        const size_t len = (size_t(be16(p + 2)) + 1) * 4;
        if (offset + len > size)
            break;

        if (m_sender && (pt == 201 || pt == 200)) {
            // RR (201) ou SR (200) com blocos de relatório.
            size_t block = pt == 201 ? 8 : 28;
            for (int i = 0; i < count && block + 24 <= len; ++i, block += 24) {
                const std::byte *b = p + block;
                if (m_ssrc && be32(b) != m_ssrc)
                    continue;
                m_c.receiverReports++;
                m_c.fractionLost = u8(b + 4) / 256.0;
                int32_t cumulative = int32_t(be32(b + 4) & 0x00FFFFFF);
                if (cumulative & 0x00800000)
                    cumulative |= int32_t(0xFF000000);
                m_c.cumulativeLost = cumulative;
                m_c.jitter = double(be32(b + 12)) / m_clockRate;
                const uint32_t lsr = be32(b + 16);
                const uint32_t dlsr = be32(b + 20);
                if (lsr != 0) {
                    const uint32_t rttNtp = ntpMiddle32Now() - lsr - dlsr;
                    const double rtt = rttNtp / 65536.0;
                    if (rtt >= 0 && rtt < 10) {
                        m_c.rtt = rtt;
                        m_c.rttSum += rtt;
                        m_c.rttCount++;
                    }
                }
            }
        } else if (m_sender && pt == 205 && count == 1 && len >= 16) {
            // NACK genérico: cada FCI = PID + bitmask de 16 pacotes.
            for (size_t f = 12; f + 4 <= len; f += 4) {
                const uint16_t blp = be16(p + f + 2);
                const int lost = 1 + std::popcount(blp);
                m_c.nackedPackets += lost;
                const uint64_t avg = m_c.packetsSent ? m_c.bytesSent / m_c.packetsSent : 1200;
                m_c.nackedBytes += lost * avg;
            }
        } else if (m_sender && pt == 206 && count == 15 && len >= 24) {
            // REMB: "REMB" + num SSRC + expoente(6) + mantissa(18).
            const std::byte *f = p + 12;
            // Só vale para esta track: com simulcast, o REMB da camada baixa
            // (outro SSRC) não pode limitar a alta.
            const int ssrcs = u8(f + 4);
            bool mine = !m_ssrc || ssrcs == 0;
            for (int i = 0; i < ssrcs && size_t(20 + 4 * (i + 1)) <= len; ++i)
                mine = mine || be32(f + 8 + 4 * i) == m_ssrc;
            if (mine && u8(f) == 'R' && u8(f + 1) == 'E' && u8(f + 2) == 'M' && u8(f + 3) == 'B') {
                const uint8_t exp = u8(f + 5) >> 2;
                const uint32_t mantissa = (uint32_t(u8(f + 5) & 0x03) << 16) | (uint32_t(u8(f + 6)) << 8) | u8(f + 7);
                m_c.rembBitrate = uint32_t(std::min<uint64_t>(uint64_t(mantissa) << exp, UINT32_MAX));
            }
        }
        offset += len;
    }
}

} // namespace openspeak
