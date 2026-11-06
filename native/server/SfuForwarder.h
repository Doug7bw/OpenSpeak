#pragma once
// Núcleo do relay SFU de um stream: recebe o RTP do transmissor (ingest) e
// repassa a cada espectador (egress), sem decodificar nem transcodificar.
//
// Simulcast: o transmissor nativo pode mandar duas camadas de vídeo (0 = alta,
// 1 = baixa, mid "video-low"); cada espectador recebe uma delas. A troca de
// camada só acontece no início de um keyframe da camada nova, e até lá o
// espectador continua na anterior (sem buraco na imagem).
//
// Roda nas threads da libdatachannel; todo o estado é protegido por mutex.
// Reescrita no repasse:
//  - payload type fixo do lado de saída (H.264 = 96, Opus = 111);
//  - header extensions removidas: os IDs de extmap negociados pelo transmissor
//    não valem na sessão com o espectador;
//  - seq e timestamp contínuos: no vídeo, por espectador (cada um pode trocar
//    de camada numa hora diferente); no áudio, iguais para todos. Quando o
//    transmissor reconecta ele volta com SSRC/seq/timestamp novos, e os offsets
//    mantêm a sequência de saída sem saltos;
//  - o SSRC de saída é o da track de cada espectador (EgressSink).

#include <rtc/rtc.hpp>

#include <array>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <optional>
#include <vector>

namespace openspeak::sfu {

enum class Kind { Video = 0, Audio = 1 };

constexpr uint8_t VideoPayloadType = 96;
constexpr uint8_t AudioPayloadType = 111;
constexpr uint32_t VideoClockRate = 90000;
constexpr uint32_t AudioClockRate = 48000;
/// Constrained Baseline nível 5.2 (o mesmo do SessionOutbound do cliente).
inline constexpr const char *H264Profile = "profile-level-id=42e034;packetization-mode=1;level-asymmetry-allowed=1";

/// Camadas de vídeo do simulcast.
constexpr int HighLayer = 0;
constexpr int LowLayer = 1;
constexpr int MaxLayers = 2;
/// mid da m-line da camada baixa na oferta do transmissor.
inline constexpr const char *LowLayerMid = "video-low";

/// O pacote RTP de vídeo (H.264) começa um keyframe (SPS ou IDR)?
bool isKeyFrameStart(const std::byte *data, size_t size);

/// Tracks de saída de um espectador (trocam a cada reconexão da sessão).
/// `send` é virtual para o espectador por WebSocket (SfuWsViewer).
class EgressSink {
public:
    virtual ~EgressSink() = default;
    void attach(std::shared_ptr<rtc::Track> video, std::shared_ptr<rtc::Track> audio, uint32_t videoSsrc, uint32_t audioSsrc);
    void detach();
    /// Recebe o pacote já reescrito para este espectador, aplica o SSRC dele e envia.
    virtual void send(Kind kind, rtc::binary packet);
    uint64_t sentBytes() const { return m_sentBytes.load(); }

private:
    std::mutex m_mutex;
    std::shared_ptr<rtc::Track> m_video, m_audio;
    uint32_t m_videoSsrc = 0, m_audioSsrc = 0;
    std::atomic<uint64_t> m_sentBytes{0};
};

class Forwarder {
public:
    using Clock = std::chrono::steady_clock;
    static constexpr auto KeyFrameInterval = std::chrono::milliseconds(500);
    /// Sem pacotes há mais que isso, a camada é considerada fora do ar.
    static constexpr auto LayerTimeout = std::chrono::milliseconds(1500);

    // --- lado do transmissor (ingest)
    void setIngestVideoTrack(int layer, const std::shared_ptr<rtc::Track> &track);
    void onRtp(Kind kind, int layer, const std::byte *data, size_t size);
    uint64_t receivedBytes() const { return m_receivedBytes.load(); }
    /// Sender Report do transmissor: âncora NTP<->RTP para o SR de saída.
    void onSenderReport(Kind kind, int layer, uint32_t ssrc, uint32_t rtpTimestamp);

    // --- lado dos espectadores (egress)
    void addSink(const std::shared_ptr<EgressSink> &sink);
    void removeSink(const std::shared_ptr<EgressSink> &sink);
    /// Camada que o espectador deve receber. Se ela não estiver no ar, ele fica
    /// na que estiver.
    void setSinkLayer(const EgressSink *sink, int layer);
    /// Camada que o espectador está recebendo agora (-1 = nenhuma ainda).
    int sinkLayer(const EgressSink *sink) const;
    /// A camada está chegando do transmissor?
    bool hasLayer(int layer) const;
    /// PLI ao transmissor, no máximo um a cada KeyFrameInterval por camada (os
    /// pedidos dentro da janela são agregados e saem quando ela abre).
    void requestKeyFrame(); // todas as camadas
    void requestKeyFrame(const EgressSink *sink); // a camada que este espectador recebe/espera
    /// REMB ao transmissor (controle de banda agregado da camada).
    void requestBitrate(int layer, unsigned int bitrate);
    /// Timestamp RTP de saída correspondente a "agora", para o Sender Report
    /// do egress (mantém áudio e vídeo na mesma referência: lip-sync).
    std::optional<uint32_t> rtpNow(Kind kind, const EgressSink *sink = nullptr) const;

private:
    /// Uma camada de vídeo vinda do transmissor.
    struct Source {
        bool started = false;
        uint32_t ssrc = 0;
        Clock::time_point lastAt;
        bool haveSr = false; // SR do SSRC atual
        uint32_t srRtp = 0;
        Clock::time_point srAt;
        std::weak_ptr<rtc::Track> ingest;
        bool keyFramePending = false;
        Clock::time_point lastKeyFrameRequest;
    };
    /// Numeração de saída (seq/timestamp) contínua.
    struct Output {
        bool started = false;
        uint32_t srcSsrc = 0;
        uint16_t seqOffset = 0;
        uint32_t tsOffset = 0;
        uint16_t lastSeq = 0; // último seq de saída (o mais novo)
        uint32_t lastTs = 0;
        Clock::time_point lastAt;
        /// Passa a seguir `ssrc` a partir do pacote (seq, ts), sem saltos na saída.
        void rebase(uint32_t ssrc, uint16_t seq, uint32_t ts, Clock::time_point now, uint32_t clockRate);
        /// Registra um pacote repassado (ignora retransmissões/fora de ordem).
        void advance(uint16_t outSeq, uint32_t outTs, Clock::time_point now);
    };
    struct SinkState {
        std::shared_ptr<EgressSink> sink;
        int wanted = HighLayer;
        int layer = -1;          // camada atual
        uint16_t firstSeq = 0;   // seq de origem do keyframe que abriu a camada atual
        int guardLeft = 0;       // pacotes em que ainda vale descartar os anteriores a firstSeq
        Output out;
    };
    struct AudioLane {
        Output out;
        bool haveSr = false;
        uint32_t srRtp = 0;
        Clock::time_point srAt;
    };
    static uint32_t clockRate(Kind kind) { return kind == Kind::Video ? VideoClockRate : AudioClockRate; }
    bool aliveLocked(int layer, Clock::time_point now) const;
    /// Camada que o espectador deve receber considerando o que está no ar.
    int targetLocked(const SinkState &s, Clock::time_point now) const;
    void markKeyFrameLocked(int layer);
    /// PLIs pendentes que já podem sair (um por camada).
    std::vector<std::shared_ptr<rtc::Track>> takeKeyFrameRequestsLocked(Clock::time_point now);
    static void sendPlis(const std::vector<std::shared_ptr<rtc::Track>> &tracks);
    SinkState *findLocked(const EgressSink *sink);
    const SinkState *findLocked(const EgressSink *sink) const;
    void onVideoLocked(int layer, uint32_t ssrc, uint16_t seq, uint32_t ts, bool keyStart, Clock::time_point now,
                       const rtc::binary &base, std::vector<std::pair<std::shared_ptr<EgressSink>, rtc::binary>> &out);

    mutable std::mutex m_mutex;
    std::atomic<uint64_t> m_receivedBytes{0};
    std::array<Source, MaxLayers> m_video;
    AudioLane m_audio;
    std::vector<SinkState> m_sinks;
};

} // namespace openspeak::sfu
