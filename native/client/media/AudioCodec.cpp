#include "AudioCodec.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
}

namespace openspeak {

namespace {
constexpr int Rate = 48000;
constexpr int Channels = 2;
constexpr int FrameSamples = 960; // 20 ms
}

// ================================================================ encoder

OpusEncoder::~OpusEncoder() { close(); }

bool OpusEncoder::open(int bitrate, Output output)
{
    std::lock_guard lock(m_mutex);
    const AVCodec *codec = avcodec_find_encoder_by_name("libopus");
    if (!codec)
        return false;
    m_ctx = avcodec_alloc_context3(codec);
    m_ctx->sample_rate = Rate;
    m_ctx->sample_fmt = AV_SAMPLE_FMT_FLT;
    av_channel_layout_default(&m_ctx->ch_layout, Channels);
    m_ctx->bit_rate = bitrate;
    m_ctx->time_base = {1, Rate};
    av_opt_set(m_ctx->priv_data, "application", "audio", 0);
    av_opt_set(m_ctx->priv_data, "frame_duration", "20", 0);
    av_opt_set_int(m_ctx->priv_data, "packet_loss", 5, 0);
    av_opt_set_int(m_ctx->priv_data, "fec", 1, 0);
    if (avcodec_open2(m_ctx, codec, nullptr) < 0) {
        avcodec_free_context(&m_ctx);
        return false;
    }
    m_frame = av_frame_alloc();
    m_frame->nb_samples = FrameSamples;
    m_frame->format = AV_SAMPLE_FMT_FLT;
    av_channel_layout_default(&m_frame->ch_layout, Channels);
    m_frame->sample_rate = Rate;
    av_frame_get_buffer(m_frame, 0);
    m_packet = av_packet_alloc();
    m_output = std::move(output);
    return true;
}

void OpusEncoder::close()
{
    std::lock_guard lock(m_mutex);
    if (m_ctx)
        avcodec_free_context(&m_ctx);
    if (m_frame)
        av_frame_free(&m_frame);
    if (m_packet)
        av_packet_free(&m_packet);
    if (m_swr)
        swr_free(&m_swr);
    m_buffer.clear();
    m_started = false;
}

void OpusEncoder::setBitrate(int bitrate)
{
    std::lock_guard lock(m_mutex);
    if (m_ctx)
        m_ctx->bit_rate = bitrate; // libopus aplica a cada quadro
}

void OpusEncoder::push(const QByteArray &pcm, int sampleRate, int channels)
{
    std::lock_guard lock(m_mutex);
    if (!m_ctx || pcm.isEmpty() || channels <= 0)
        return;
    if (sampleRate == Rate && channels == Channels) {
        m_buffer.append(pcm);
    } else {
        if (!m_swr || m_swrRate != sampleRate || m_swrChannels != channels) {
            if (m_swr)
                swr_free(&m_swr);
            AVChannelLayout in{}, out{};
            av_channel_layout_default(&in, channels);
            av_channel_layout_default(&out, Channels);
            swr_alloc_set_opts2(&m_swr, &out, AV_SAMPLE_FMT_FLT, Rate, &in, AV_SAMPLE_FMT_FLT, sampleRate, 0, nullptr);
            swr_init(m_swr);
            m_swrRate = sampleRate;
            m_swrChannels = channels;
        }
        const int inSamples = pcm.size() / int(sizeof(float) * channels);
        const int maxOut = swr_get_out_samples(m_swr, inSamples);
        QByteArray converted(maxOut * int(sizeof(float)) * Channels, Qt::Uninitialized);
        const uint8_t *inData[] = {reinterpret_cast<const uint8_t *>(pcm.constData())};
        uint8_t *outData[] = {reinterpret_cast<uint8_t *>(converted.data())};
        const int got = swr_convert(m_swr, outData, maxOut, inData, inSamples);
        if (got > 0)
            m_buffer.append(converted.constData(), got * int(sizeof(float)) * Channels);
    }
    encodeBuffered();
}

void OpusEncoder::encodeBuffered()
{
    const int frameBytes = FrameSamples * Channels * int(sizeof(float));
    // A captura do Windows não entrega nada no silêncio: sem isto o timestamp RTP
    // parava enquanto o relógio andava, e o player do navegador via cada volta do som
    // como pacotes "atrasados" (atraso crescendo, áudio cortado). Pula o timestamp
    // para frente, como num silêncio DTX; nunca para trás.
    const auto now = std::chrono::steady_clock::now();
    if (!m_started) {
        m_started = true;
        m_start = now;
    } else {
        const qint64 wall = std::chrono::duration_cast<std::chrono::milliseconds>(now - m_start).count() * Rate / 1000;
        const qint64 pending = m_buffer.size() / (Channels * qsizetype(sizeof(float)));
        const qint64 behind = wall - (qint64(m_samples) + pending);
        if (behind > Rate / 5) // > 200 ms
            m_samples += quint32(behind / FrameSamples * FrameSamples);
    }
    while (m_buffer.size() >= frameBytes) {
        av_frame_make_writable(m_frame);
        memcpy(m_frame->data[0], m_buffer.constData(), frameBytes);
        m_buffer.remove(0, frameBytes);
        m_frame->pts = m_samples;
        m_samples += FrameSamples;
        if (avcodec_send_frame(m_ctx, m_frame) < 0)
            continue;
        while (avcodec_receive_packet(m_ctx, m_packet) == 0) {
            if (m_output)
                m_output(QByteArray(reinterpret_cast<const char *>(m_packet->data), m_packet->size), quint32(m_packet->pts));
            av_packet_unref(m_packet);
        }
    }
}

// ================================================================ decoder

OpusDecoder::OpusDecoder()
{
    const AVCodec *codec = avcodec_find_decoder_by_name("libopus");
    if (!codec)
        codec = avcodec_find_decoder(AV_CODEC_ID_OPUS);
    m_ctx = avcodec_alloc_context3(codec);
    m_ctx->sample_rate = Rate;
    av_channel_layout_default(&m_ctx->ch_layout, Channels);
    m_ctx->request_sample_fmt = AV_SAMPLE_FMT_FLT;
    avcodec_open2(m_ctx, codec, nullptr);
    m_frame = av_frame_alloc();
    m_packet = av_packet_alloc();
}

OpusDecoder::~OpusDecoder()
{
    avcodec_free_context(&m_ctx);
    av_frame_free(&m_frame);
    av_packet_free(&m_packet);
    if (m_swr)
        swr_free(&m_swr);
}

QByteArray OpusDecoder::decode(const QByteArray &packet)
{
    QByteArray out;
    if (!m_ctx || packet.isEmpty())
        return out;
    m_packet->data = reinterpret_cast<uint8_t *>(const_cast<char *>(packet.constData()));
    m_packet->size = packet.size();
    if (avcodec_send_packet(m_ctx, m_packet) < 0)
        return out;
    while (avcodec_receive_frame(m_ctx, m_frame) == 0) {
        if (!m_swr) {
            AVChannelLayout outLayout{};
            av_channel_layout_default(&outLayout, Channels);
            swr_alloc_set_opts2(&m_swr, &outLayout, AV_SAMPLE_FMT_FLT, Rate, &m_frame->ch_layout,
                                AVSampleFormat(m_frame->format), m_frame->sample_rate, 0, nullptr);
            swr_init(m_swr);
        }
        const int maxOut = swr_get_out_samples(m_swr, m_frame->nb_samples);
        QByteArray chunk(maxOut * Channels * int(sizeof(float)), Qt::Uninitialized);
        uint8_t *outData[] = {reinterpret_cast<uint8_t *>(chunk.data())};
        const int got = swr_convert(m_swr, outData, maxOut, const_cast<const uint8_t **>(m_frame->extended_data), m_frame->nb_samples);
        if (got > 0)
            out.append(chunk.constData(), got * Channels * int(sizeof(float)));
        av_frame_unref(m_frame);
    }
    return out;
}

} // namespace openspeak
