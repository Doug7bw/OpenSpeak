#pragma once
// Opus (via FFmpeg/libopus): codificador do áudio do stream e decodificador
// do lado do espectador. 48 kHz, estéreo, quadros de 20 ms.

#include <QByteArray>
#include <functional>
#include <chrono>
#include <mutex>

struct AVCodecContext;
struct AVFrame;
struct AVPacket;
struct SwrContext;

namespace openspeak {

class OpusEncoder {
public:
    using Output = std::function<void(const QByteArray &packet, quint32 rtpTimestamp)>;

    OpusEncoder() = default;
    ~OpusEncoder();

    bool open(int bitrate, Output output);
    void close();
    void setBitrate(int bitrate);
    /// float32 intercalado em qualquer taxa/canais; converte para 48 kHz estéreo.
    void push(const QByteArray &pcm, int sampleRate, int channels);

private:
    void encodeBuffered();

    std::mutex m_mutex;
    Output m_output;
    AVCodecContext *m_ctx = nullptr;
    AVFrame *m_frame = nullptr;
    AVPacket *m_packet = nullptr;
    SwrContext *m_swr = nullptr;
    int m_swrRate = 0, m_swrChannels = 0;
    QByteArray m_buffer; // float32 estéreo 48 kHz
    quint32 m_samples = 0;
    std::chrono::steady_clock::time_point m_start{}; // relógio de parede do 1º quadro
    bool m_started = false;
};

class OpusDecoder {
public:
    OpusDecoder();
    ~OpusDecoder();
    /// Retorna float32 intercalado 48 kHz estéreo.
    QByteArray decode(const QByteArray &packet);

private:
    AVCodecContext *m_ctx = nullptr;
    AVFrame *m_frame = nullptr;
    AVPacket *m_packet = nullptr;
    SwrContext *m_swr = nullptr;
};

} // namespace openspeak
