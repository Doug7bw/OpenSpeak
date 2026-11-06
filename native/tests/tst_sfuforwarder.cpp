// Forwarder do SFU com simulcast (sem rede): escolha de camada por espectador,
// troca só no keyframe, numeração de saída contínua e a regra automática de
// camada (LayerPolicy).

#include "SfuForwarder.h"
#include "SfuLayerPolicy.h"

#include <QTest>

using namespace openspeak;
using namespace openspeak::sfu;

namespace {

/// Captura o que sairia para o espectador.
class CaptureSink : public EgressSink {
public:
    struct Packet {
        Kind kind;
        uint16_t seq;
        uint32_t ts;
        uint8_t pt;
        uint8_t firstPayload;
    };
    void send(Kind kind, rtc::binary packet) override
    {
        const auto b = [&](size_t i) { return std::to_integer<uint8_t>(packet[i]); };
        packets.push_back({kind, uint16_t(b(2) << 8 | b(3)), uint32_t(b(4)) << 24 | uint32_t(b(5)) << 16 | uint32_t(b(6)) << 8 | b(7),
                           uint8_t(b(1) & 0x7F), b(12)});
    }
    std::vector<Packet> video() const
    {
        std::vector<Packet> out;
        for (const Packet &p : packets)
            if (p.kind == Kind::Video)
                out.push_back(p);
        return out;
    }
    std::vector<Packet> packets;
};

constexpr uint8_t NalSps = 0x67, NalSlice = 0x41;

rtc::binary rtp(uint16_t seq, uint32_t ts, uint32_t ssrc, uint8_t nal, uint8_t pt = 102)
{
    rtc::binary p(14);
    p[0] = std::byte(0x80);
    p[1] = std::byte(pt);
    p[2] = std::byte(seq >> 8);
    p[3] = std::byte(seq & 0xFF);
    for (int i = 0; i < 4; ++i) {
        p[4 + i] = std::byte((ts >> (24 - 8 * i)) & 0xFF);
        p[8 + i] = std::byte((ssrc >> (24 - 8 * i)) & 0xFF);
    }
    p[12] = std::byte(nal);
    p[13] = std::byte(0xAA);
    return p;
}

void feed(Forwarder &f, Kind kind, int layer, const rtc::binary &p) { f.onRtp(kind, layer, p.data(), p.size()); }

bool continuous(const std::vector<CaptureSink::Packet> &v)
{
    for (size_t i = 1; i < v.size(); ++i)
        if (uint16_t(v[i - 1].seq + 1) != v[i].seq || int32_t(v[i].ts - v[i - 1].ts) < 0)
            return false;
    return true;
}

} // namespace

class TestSfuForwarder : public QObject {
    Q_OBJECT

private slots:
    void keyFrameStartDetection()
    {
        const auto key = rtp(1, 0, 1, NalSps);
        const auto delta = rtp(1, 0, 1, NalSlice);
        QVERIFY(isKeyFrameStart(key.data(), key.size()));
        QVERIFY(!isKeyFrameStart(delta.data(), delta.size()));
        // FU-A com início de IDR
        auto fu = rtp(1, 0, 1, 0x7C);
        fu[13] = std::byte(0x85);
        QVERIFY(isKeyFrameStart(fu.data(), fu.size()));
    }

    void singleLayerStartsAtKeyFrame()
    {
        Forwarder f;
        auto a = std::make_shared<CaptureSink>();
        f.addSink(a);
        feed(f, Kind::Video, HighLayer, rtp(10, 1000, 0xA, NalSlice)); // antes do keyframe: não serve
        QVERIFY(a->video().empty());
        QCOMPARE(f.sinkLayer(a.get()), -1);
        feed(f, Kind::Video, HighLayer, rtp(11, 4000, 0xA, NalSps));
        feed(f, Kind::Video, HighLayer, rtp(12, 4000, 0xA, NalSlice));
        feed(f, Kind::Video, HighLayer, rtp(13, 7000, 0xA, NalSlice));
        const auto v = a->video();
        QCOMPARE(v.size(), size_t(3));
        QCOMPARE(v.front().pt, VideoPayloadType);
        QVERIFY(continuous(v));
        QCOMPARE(f.sinkLayer(a.get()), HighLayer);
        QVERIFY(f.hasLayer(HighLayer));
        QVERIFY(!f.hasLayer(LowLayer));
    }

    void switchesLayerOnlyAtKeyFrame()
    {
        Forwarder f;
        auto a = std::make_shared<CaptureSink>(); // fica na alta
        auto b = std::make_shared<CaptureSink>(); // vai para a baixa
        f.addSink(a);
        f.addSink(b);
        uint16_t hs = 100, ls = 5000;
        uint32_t ht = 0, lt = 777'000;
        auto step = [&](bool highKey, bool lowKey) {
            feed(f, Kind::Video, HighLayer, rtp(hs++, ht, 0xA, highKey ? NalSps : NalSlice));
            feed(f, Kind::Video, LowLayer, rtp(ls++, lt, 0xB, lowKey ? NalSps : NalSlice));
            ht += 3000;
            lt += 3000;
        };
        step(true, true);
        step(false, false);
        QCOMPARE(f.sinkLayer(b.get()), HighLayer);

        f.setSinkLayer(b.get(), LowLayer);
        step(false, false); // sem keyframe da baixa: b continua na alta
        QCOMPARE(f.sinkLayer(b.get()), HighLayer);
        step(false, true);  // keyframe da baixa: b troca
        QCOMPARE(f.sinkLayer(b.get()), LowLayer);
        step(false, false);

        // a: só a alta, 5 pacotes; b: 4 da alta (até o keyframe da baixa) + 2
        // da baixa, sem salto na numeração.
        const auto va = a->video(), vb = b->video();
        QCOMPARE(va.size(), size_t(5));
        QCOMPARE(vb.size(), size_t(6));
        QVERIFY(continuous(va));
        QVERIFY(continuous(vb));
        QCOMPARE(vb[4].firstPayload, NalSps);

        // Retransmissão atrasada da baixa, de antes do keyframe: não vai para b.
        feed(f, Kind::Video, LowLayer, rtp(uint16_t(ls - 3), lt - 9000, 0xB, NalSlice));
        QCOMPARE(b->video().size(), size_t(6));
    }

    void fallsBackWhenWantedLayerIsMissing()
    {
        Forwarder f;
        auto a = std::make_shared<CaptureSink>();
        f.addSink(a);
        f.setSinkLayer(a.get(), LowLayer); // transmissor sem simulcast
        feed(f, Kind::Video, HighLayer, rtp(1, 0, 0xA, NalSps));
        feed(f, Kind::Video, HighLayer, rtp(2, 3000, 0xA, NalSlice));
        QCOMPARE(a->video().size(), size_t(2));
        QCOMPARE(f.sinkLayer(a.get()), HighLayer);
    }

    void sourceReconnectKeepsNumbering()
    {
        Forwarder f;
        auto a = std::make_shared<CaptureSink>();
        f.addSink(a);
        feed(f, Kind::Video, HighLayer, rtp(1, 0, 0xA, NalSps));
        feed(f, Kind::Video, HighLayer, rtp(2, 3000, 0xA, NalSlice));
        // Transmissor reconectou: SSRC/seq/ts novos; até o keyframe, nada.
        feed(f, Kind::Video, HighLayer, rtp(900, 50, 0xC, NalSlice));
        QCOMPARE(a->video().size(), size_t(2));
        feed(f, Kind::Video, HighLayer, rtp(901, 3050, 0xC, NalSps));
        QCOMPARE(a->video().size(), size_t(3));
        QVERIFY(continuous(a->video()));
    }

    void audioGoesToEveryone()
    {
        Forwarder f;
        auto a = std::make_shared<CaptureSink>();
        auto b = std::make_shared<CaptureSink>();
        f.addSink(a);
        f.addSink(b);
        f.setSinkLayer(b.get(), LowLayer);
        feed(f, Kind::Audio, HighLayer, rtp(1, 0, 0xD, 0x11, 111));
        QCOMPARE(a->packets.size(), size_t(1));
        QCOMPARE(b->packets.size(), size_t(1));
        QCOMPARE(a->packets.front().pt, AudioPayloadType);
    }

    void autoPolicy()
    {
        using namespace std::chrono_literals;
        LayerPolicy p;
        const int cfg = 5'000'000;
        auto t = LayerPolicy::Clock::now();
        QCOMPARE(p.step(cfg, cfg, t), 0);
        QCOMPARE(p.step(1'000'000, cfg, t += 1s), 0); // abaixo, mas ainda não por 2 s
        QCOMPARE(p.step(1'000'000, cfg, t += 1s), 0);
        QCOMPARE(p.step(1'000'000, cfg, t += 1s), 1); // desceu
        // Banda voltou, mas espera a janela inicial (10 s) e mais 5 s estável.
        QCOMPARE(p.step(cfg, cfg, t += 1s), 1);
        QCOMPARE(p.step(cfg, cfg, t += 10s), 1);
        QCOMPARE(p.step(cfg, cfg, t += 5s), 0);
        // Caiu logo depois de subir: a próxima espera dobra (20 s).
        QCOMPARE(p.step(1'000'000, cfg, t += 1s), 0);
        QCOMPARE(p.step(1'000'000, cfg, t += 2s), 1);
        QCOMPARE(p.step(cfg, cfg, t += 1s), 1);
        QCOMPARE(p.step(cfg, cfg, t += 15s), 1);
        QCOMPARE(p.step(cfg, cfg, t += 5s), 1); // janela de 20 s acabou: começa a contar os 5 s
        QCOMPARE(p.step(cfg, cfg, t += 5s), 0);

        LayerPolicy forced;
        forced.preference = LayerPreference::High;
        QCOMPARE(forced.step(100'000, cfg, t), 0);
        forced.preference = LayerPreference::Low;
        QCOMPARE(forced.step(cfg, cfg, t), 1);
        QCOMPARE(sfu::layerPreferenceFromString(QStringLiteral("low")), LayerPreference::Low);
        QCOMPARE(sfu::layerPreferenceFromString(QStringLiteral("xyz")), LayerPreference::Auto);
    }
};

QTEST_GUILESS_MAIN(TestSfuForwarder)
#include "tst_sfuforwarder.moc"
