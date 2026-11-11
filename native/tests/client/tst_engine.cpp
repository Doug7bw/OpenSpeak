// Testes unitários do motor: detecção de problemas (limiares do TS),
// layout e filtro de SDP. Mesmos cenários de test/stats.test.js e test/layout.test.js.

#include "AudioCapture.h"
#include "ConnectionHandler.h"
#include "AudioCodec.h"
#include "Settings.h"
#include "Layout.h"
#include "SdpFilter.h"
#include "StreamStats.h"
#include "VideoDecoder.h"
#include "VideoEncoder.h"
#include "SourceThumbnails.h"

#include <QImage>
#include <algorithm>
#include <QPainter>
#include <QSignalSpy>
#include <QFile>
#include <QTemporaryDir>
#include <QTest>
#include <QWindow>
#include <windows.h>

using namespace openspeak;

class TestEngine : public QObject {
    Q_OBJECT

    static StatsSummary video()
    {
        StatsSummary s;
        s.video.width = 1280;
        s.video.height = 720;
        s.video.fps = 30;
        s.video.hasEncode = true;
        s.video.avgEncodeTime = 0.01;
        return s;
    }

private slots:
    // Metade esquerda vermelha, direita azul: o recorte da direita não pode trazer vermelho.
    void animatedAvatarKeepsTheGifAndMakesACover()
    {
        const QByteArray gif = QByteArray::fromBase64(
            "R0lGODlhAgABAPAAAP8AAAD/ACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgABAAACAkQBACH5BAAKAAAALAAAAAACAAEAAAICDAoAOw==");
        QTemporaryDir dir;
        const QString path = dir.filePath("foto.GIF");
        QFile file(path);
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write(gif);
        file.close();

        ConnectionHandler handler;
        const QVariantMap fields = handler.animatedAvatarFromFile(QUrl::fromLocalFile(path));
        QVERIFY(fields.value("avatar").toString().startsWith("data:image/jpeg;base64,"));
        QCOMPARE(fields.value("avatarAnimated").toString(), "data:image/gif;base64," + QString::fromLatin1(gif.toBase64()));
        QVERIFY(!handler.gifTooLarge(QUrl::fromLocalFile(path)));
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write(QByteArray(400 * 1024, 'x'));
        file.close();
        QVERIFY(handler.gifTooLarge(QUrl::fromLocalFile(path)));
    }

    void avatarUsesTheAdjustedCrop()
    {
        QTemporaryDir dir;
        const QString path = dir.filePath("foto.png");
        QImage image(400, 200, QImage::Format_RGB32);
        image.fill(Qt::red);
        QPainter(&image).fillRect(200, 0, 200, 200, Qt::blue);
        QVERIFY(image.save(path));

        ConnectionHandler handler;
        const QString avatar = handler.avatarFromFile(QUrl::fromLocalFile(path), 0.5, 0, 0.5);
        QVERIFY(avatar.startsWith("data:image/jpeg;base64,"));
        const QImage cropped = QImage::fromData(QByteArray::fromBase64(avatar.section(',', 1).toLatin1()));
        QCOMPARE(cropped.size(), QSize(128, 128));
        const QColor center = cropped.pixelColor(64, 64), corner = cropped.pixelColor(4, 4);
        QVERIFY(center.blue() > 200 && center.red() < 60);
        QVERIFY(corner.blue() > 200 && corner.red() < 60);
        QVERIFY(handler.avatarFromFile(QUrl::fromLocalFile(dir.filePath("nada.png")), 0, 0, 1).isEmpty());
    }

    void picksDiscordProcessTreeRoot()
    {
        // Raiz (pai é o Update.exe, fora da lista) com filhos, como o Discord real.
        QCOMPARE(AudioCapture::rootProcess({{500, 900}, {610, 500}, {620, 500}, {630, 610}}), 500u);
        // Filhos listados antes da raiz.
        QCOMPARE(AudioCapture::rootProcess({{620, 500}, {500, 900}}), 500u);
        // Duas instâncias independentes (estável + PTB): a de menor PID.
        QCOMPARE(AudioCapture::rootProcess({{800, 1}, {810, 800}, {700, 2}}), 700u);
        QCOMPARE(AudioCapture::rootProcess({}), 0u);
    }

    void capturesAudioByDefault()
    {
        Settings settings(QStringLiteral("audio-default"), true);
        settings.setLastStreamingConfig({});
        QCOMPARE(settings.lastStreamingConfig().value("audio"), QVariant(true));
        // Desligar vale só para aquela transmissão: a próxima volta a capturar o áudio.
        settings.setLastStreamingConfig({{"audio", false}, {"excludeDiscord", false}});
        QCOMPARE(settings.lastStreamingConfig().value("audio"), QVariant(true));
        // O áudio do Discord é sempre excluído: a opção antiga salva não volta.
        QVERIFY(!settings.lastStreamingConfig().contains("excludeDiscord"));
        settings.setLastStreamingConfig({});
    }

    void windowAudioFollowsProcessFamily()
    {
        const QList<AudioCapture::ProcessEntry> procs{
            {100, 4, "explorer.exe"}, {200, 100, "chrome.exe"}, {210, 200, "chrome.exe"},
            {220, 210, "CHROME.EXE"}, {300, 100, "game.exe"}, {310, 300, "helper.exe"}};
        // Janela num processo filho: sobe até a raiz com o mesmo executável.
        QCOMPARE(AudioCapture::familyRoot(220, procs), 200u);
        QCOMPARE(AudioCapture::familyRoot(200, procs), 200u);
        // Pai com outro executável: fica no próprio processo.
        QCOMPARE(AudioCapture::familyRoot(310, procs), 310u);
        QCOMPARE(AudioCapture::familyRoot(300, procs), 300u);
        // Processo desconhecido (já saiu): devolve o mesmo PID.
        QCOMPARE(AudioCapture::familyRoot(999, procs), 999u);
        // Janela real deste processo (o pai, o ctest, tem outro executável).
        QWindow window;
        window.create();
        QCOMPARE(AudioCapture::pidForWindow(window.winId()), quint32(GetCurrentProcessId()));
        QCOMPARE(AudioCapture::pidForWindow(0), 0u);
        // Ciclo de PIDs reciclados não trava.
        QCOMPARE(AudioCapture::familyRoot(1, {{1, 2, "a.exe"}, {2, 1, "a.exe"}}) != 0, true);
    }

    void excludingDiscordReportsWhatIsExcluded()
    {
        AudioCapture capture;
        QSignalSpy excluded(&capture, &AudioCapture::excludedChanged);
        QSignalSpy errors(&capture, &AudioCapture::errorOccurred);
        capture.start(AudioCapture::Mode::SystemExcludingDiscord);
        QTRY_VERIFY_WITH_TIMEOUT(!excluded.isEmpty() || !errors.isEmpty(), 5000);
        QVERIFY2(errors.isEmpty(), errors.isEmpty() ? "" : qPrintable(errors.first().first().toString()));
        const QString expected = AudioCapture::discordRootPid() ? QStringLiteral("discord") : QStringLiteral("self");
        QCOMPARE(excluded.first().first().toString(), expected);
        capture.stop();
    }

    void filtersShellAndBackgroundWindows()
    {
        QWindow normal;
        normal.setTitle("OpenSpeak filter test");
        normal.resize(320, 180);
        normal.show();
        ShowWindow(reinterpret_cast<HWND>(normal.winId()), SW_SHOWNORMAL);
        const QCapturableWindow descriptor(&normal);
        QTRY_VERIFY(VideoSource::isShareableWindow(descriptor));
        normal.setTitle("");
        SetWindowTextW(reinterpret_cast<HWND>(normal.winId()), L"");
        QVERIFY(!VideoSource::isShareableWindow(descriptor));
        normal.setTitle("Settings"); // real Settings windows remain shareable
        QVERIFY(VideoSource::isShareableWindow(descriptor));
        normal.hide();
        QVERIFY(!VideoSource::isShareableWindow(descriptor));
        normal.show();
        const HWND hwnd = reinterpret_cast<HWND>(normal.winId());
        const auto style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_TOOLWINDOW);
        QVERIFY(!VideoSource::isShareableWindow(descriptor));
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE);
        QVERIFY(!VideoSource::isShareableWindow(descriptor));
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
        QVERIFY(VideoSource::isShareableWindow(descriptor));
    }
    void vanishedSourceDoesNotSelectAnotherDevice()
    {
        VideoSource capture;
        SourceDescriptor window;
        window.type = StreamType::Window;
        window.id = "0";
        window.windowSpecified = true;
        QVERIFY(!capture.open(window, 5));
        QCOMPARE(capture.errorString(), QStringLiteral("no_available_source"));
        SourceDescriptor camera;
        camera.type = StreamType::Camera;
        camera.id = "openspeak-nonexistent-camera";
        QVERIFY(!capture.open(camera, 5));
        QVERIFY(!capture.isActive());
    }

    void sourceThumbnails()
    {
        SourceThumbnails thumbnails;
        QSignalSpy ready(&thumbnails, &SourceThumbnails::ready);
        const QVariantList sources{QVariantMap{{"type", 2}, {"id", "test"}, {"test", true}}};
        thumbnails.start(sources);
        QTRY_COMPARE_WITH_TIMEOUT(ready.count(), 1, 3000);
        QCOMPARE(ready.first()[0].toString(), QStringLiteral("test:2"));
        const QString image = ready.first()[1].toString();
        QVERIFY(image.startsWith("data:image/jpeg;base64,"));
        const auto bytes = QByteArray::fromBase64(image.section(',', 1).toLatin1());
        QCOMPARE(QImage::fromData(bytes).size(), QSize(320, 180));
        thumbnails.start(sources);
        thumbnails.stop();
        QTest::qWait(300);
        QCOMPARE(ready.count(), 1); // closing the picker cancels queued captures
        thumbnails.start({});
        QTest::qWait(100);
        QCOMPARE(ready.count(), 1);
    }

    void noIssues()
    {
        StatsSummary s = video();
        TargetQuality t{1280, 720, 30};
        analyzeIssues(s, &t, true);
        QCOMPARE(s.issueStatus, int(SeverityOk));
        QVERIFY(s.issues.isEmpty());
    }

    void networkThresholds()
    {
        TargetQuality t{1280, 720, 30};
        StatsSummary minor = video();
        minor.fractionLost = 0.01;
        minor.lastRoundTripTime = 0.4;
        minor.jitter = 0.2;
        analyzeIssues(minor, &t, true);
        QCOMPARE(minor.issueSeverity.value("network:packetloss"), int(SeverityMinor));
        QCOMPARE(minor.issueSeverity.value("network:rtt"), int(SeverityMinor));
        QCOMPARE(minor.issueSeverity.value("network:jitter"), int(SeverityMinor));

        StatsSummary major = video();
        major.fractionLost = 0.06;
        major.lastRoundTripTime = 0.7;
        analyzeIssues(major, &t, true);
        QCOMPARE(major.issueSeverity.value("network:packetloss"), int(SeverityMajor));
        QCOMPARE(major.issueSeverity.value("network:rtt"), int(SeverityMajor));

        StatsSummary s = video();
        s.sent.currentDelay = 6;
        s.retransmit.bps = 1000;
        analyzeIssues(s, &t, true);
        QCOMPARE(s.issueSeverity.value("network:packetdelay"), int(SeverityMinor));
        QCOMPARE(s.issueSeverity.value("network:retransmit"), int(SeverityMinor));
    }

    void encoderThresholds()
    {
        TargetQuality t{1280, 720, 30};
        StatsSummary s = video();
        s.video.width = 640;
        s.video.height = 360;
        s.video.fps = 15;
        s.video.avgEncodeTime = 0.06;
        s.video.limitReason = QStringLiteral("cpu");
        analyzeIssues(s, &t, true);
        QCOMPARE(s.issueSeverity.value("video:qualitylimit"), int(SeverityMajor));
        QCOMPARE(s.issueSeverity.value("video:encodetime"), int(SeverityMajor));
        QCOMPARE(s.issueSeverity.value("video:fps"), int(SeverityMajor));

        StatsSummary inbound = video();
        inbound.video.limitReason = QStringLiteral("cpu");
        analyzeIssues(inbound, &t, false);
        QVERIFY(inbound.issues.isEmpty());
    }

    void gridLayouts()
    {
        auto one = gridLayout(1, 1600, 900);
        QCOMPARE(one.tiles.size(), 1);
        QCOMPARE(one.tiles[0].rect.width(), 1600.0);
        auto four = gridLayout(4, 1608, 908, 8);
        QCOMPARE(four.perPage, 4);
        for (int n : {2, 3, 5, 7, 12}) {
            for (const auto &t : gridLayout(n, 1200, 700).tiles) {
                QVERIFY(t.rect.right() <= 1200 && t.rect.bottom() <= 700);
                QVERIFY(t.rect.height() >= MinTileHeight);
            }
        }
        // Mover: qualquer lugar da área, sem sair dela.
        QCOMPARE(moveRect(QRectF(100, 100, 320, 180), 50, -20, 1000, 800), QRectF(150, 80, 320, 180));
        QCOMPARE(moveRect(QRectF(100, 100, 320, 180), -500, 5000, 1000, 800), QRectF(0, 620, 320, 180));
        // Sem sobreposição: o arrastado fica no lugar, os outros saem e encolhem se faltar espaço.
        const QRectF held(300, 170, 594, 334);
        QList<QRectF> placed;
        for (const auto &t : gridLayout(4, 1200, 700).tiles)
            placed.append(t.rect);
        placed[0] = held;
        const auto settled = resolveOverlaps(placed, 0, 1200, 700);
        QCOMPARE(settled.size(), 4);
        QCOMPARE(settled[0], held);
        for (int i = 0; i < settled.size(); ++i)
            for (int j = i + 1; j < settled.size(); ++j)
                QVERIFY(!settled[i].intersects(settled[j]));
        QVERIFY(resolveOverlaps({QRectF(0, 0, 400, 225), QRectF(10, 10, 400, 225)}, 0, 400, 225).isEmpty());
        // Organizar: mantém os tamanhos; só encolhe, na mesma proporção, se não couberem.
        const auto packed = packRects({QRectF(700, 400, 200, 112.5), QRectF(20, 30, 480, 270), QRectF(600, 10, 320, 180)}, 1200, 700);
        QCOMPARE(packed.size(), 3);
        QCOMPARE(packed[0].width(), 200.0);
        QCOMPARE(packed[1].width(), 480.0);
        QVERIFY(packed[1].x() < packed[2].x() && !packed[1].intersects(packed[2]));
        const auto shrunk = packRects({QRectF(0, 0, 800, 450), QRectF(0, 460, 400, 225)}, 800, 500);
        QVERIFY(qAbs(shrunk[0].width() / shrunk[1].width() - 2) < 0.01);
        QVERIFY(packRects({QRectF(0, 0, 400, 225), QRectF(0, 0, 400, 225)}, 200, 100).isEmpty());
        // Redimensionar: proporção e canto oposto fixos, dentro da área, com tamanho mínimo.
        const QRectF rect(300, 200, 320, 180);
        QCOMPARE(resizeRect(rect, false, false, 160, 0, 1000, 800), QRectF(300, 200, 480, 270));
        QCOMPARE(resizeRect(rect, true, true, -160, 0, 1000, 800), QRectF(140, 110, 480, 270));
        QCOMPARE(resizeRect(rect, false, false, 5000, 0, 1000, 800).right(), 1000.0);
        QCOMPARE(resizeRect(rect, false, false, -5000, 0, 1000, 800).width(), MinCustomWidth);
        const QRectF fitted = rectFromFraction(0.5, 0.5, 0.2, LayoutAspect, 1600, 500);
        QVERIFY(fitted.right() <= 1600 && fitted.bottom() <= 500);
        QCOMPARE(rectFromFraction(0, 0, 1, LayoutAspect, 1600, 300).height(), 300.0);

        auto paged = gridLayout(50, 600, 300);
        QVERIFY(paged.perPage < 50);
        auto focus = focusLayout(4, 2, 1280, 800);
        QCOMPARE(focus.tiles[0].index, 2);
        QCOMPARE(focus.tiles.size(), 4);
    }

    void sdpFilterKeepsOnlyH264AndOpus()
    {
        const QString offer = QStringLiteral(
            "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
            "m=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n"
            "a=rtpmap:63 red/48000/2\r\na=fmtp:63 111/111\r\n"
            "m=video 9 UDP/TLS/RTP/SAVPF 45 96 97 103\r\na=mid:1\r\na=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\r\n"
            "a=rtpmap:45 AV1/90000\r\na=rtcp-fb:45 transport-cc\r\n"
            "a=rtpmap:96 H264/90000\r\na=rtcp-fb:96 nack\r\na=rtcp-fb:96 transport-cc\r\na=fmtp:96 packetization-mode=1\r\n"
            "a=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rtpmap:103 ulpfec/90000\r\n"
            "a=ssrc-group:FID 1 2\r\n");
        const QString out = sdp::filterCodecs(offer, {"H264"}, {"opus"});
        QVERIFY(out.contains("m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"));
        QVERIFY(out.contains("m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"));
        QVERIFY(!out.contains("AV1"));
        QVERIFY(!out.contains("rtx"));
        QVERIFY(!out.contains("ulpfec"));
        QVERIFY(!out.contains("transport-cc"));
        QVERIFY(!out.contains("FID"));
        QVERIFY(out.contains("a=rtcp-fb:96 nack"));

        const QString stereo = sdp::opusStereo(out, 256000);
        QVERIFY(stereo.contains("a=fmtp:111 minptime=10;"));
        QVERIFY(stereo.contains("stereo=1"));
        QVERIFY(stereo.contains("maxaveragebitrate=256000"));
    }

    void sdpSfuHelpers()
    {
        // Modo SFU: só H.264 Constrained Baseline com packetization-mode=1.
        const QString offer = QStringLiteral(
            "v=0\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 102 104 106\r\n"
            "a=rtpmap:102 H264/90000\r\na=rtcp-fb:102 nack\r\na=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f\r\n"
            "a=rtpmap:104 H264/90000\r\na=fmtp:104 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f\r\n"
            "a=rtpmap:106 H264/90000\r\na=rtcp-fb:106 nack\r\na=fmtp:106 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n");
        const QString out = sdp::keepH264ConstrainedBaseline(offer);
        QVERIFY(out.contains("m=video 9 UDP/TLS/RTP/SAVPF 106\r\n"));
        QVERIFY(!out.contains("a=rtpmap:102"));
        QVERIFY(!out.contains("640c1f"));
        QVERIFY(out.contains("a=rtcp-fb:106 nack"));
        // Sem nenhuma variante compatível, não mexe.
        QCOMPARE(sdp::keepH264ConstrainedBaseline(QStringLiteral("v=0\r\nm=video 9 X 96\r\na=rtpmap:96 H264/90000\r\n")),
                 QStringLiteral("v=0\r\nm=video 9 X 96\r\na=rtpmap:96 H264/90000\r\n"));

        // NAT 1:1: candidato host IPv4 passa a anunciar o IP público.
        const QString host = QStringLiteral("candidate:1 1 UDP 2122317823 10.0.0.5 10000 typ host");
        QCOMPARE(sdp::advertiseHostIp(host, "203.0.113.10"), QStringLiteral("candidate:1 1 UDP 2122317823 203.0.113.10 10000 typ host"));
        const QString srflx = QStringLiteral("a=candidate:2 1 UDP 1686052607 203.0.113.10 10000 typ srflx raddr 10.0.0.5 rport 10000");
        QCOMPARE(sdp::advertiseHostIp(srflx, "203.0.113.10"), srflx);
        const QString v6 = QStringLiteral("candidate:3 1 UDP 2122317823 fe80::1 10000 typ host");
        QCOMPARE(sdp::advertiseHostIp(v6, "203.0.113.10"), v6);
        const QString sdpText = QStringLiteral("v=0\r\nm=video 9 X 96\r\na=candidate:1 1 UDP 2122317823 172.17.0.1 10000 typ host\r\n");
        QVERIFY(sdp::advertiseHostIp(sdpText, "203.0.113.10").contains("a=candidate:1 1 UDP 2122317823 203.0.113.10 10000 typ host\r\n"));
        // Duas interfaces viram o mesmo candidato: a chave ignora fundação/prioridade.
        QCOMPARE(sdp::candidateKey(QStringLiteral("candidate:1 1 UDP 2122317823 203.0.113.10 10000 typ host")),
                 sdp::candidateKey(QStringLiteral("candidate:9 1 udp 2122252543 203.0.113.10 10000 typ host")));
    }

    void encodeDecodeRoundTrip()
    {
        // Alimenta o encoder durante sua inicialização e decodifica a saída.
        const QStringList encoders = VideoEncoder::availableEncoders();
        QVERIFY2(!encoders.isEmpty(), "nenhum encoder H.264");
        qInfo() << "encoders disponíveis:" << encoders;

        QList<EncodedVideoFrame> packets;
        std::mutex m;
        VideoEncoder enc;
        VideoEncoderConfig cfg;
        cfg.maxWidth = 640;
        cfg.maxHeight = 360;
        cfg.fps = 60; // taxa suportada pelo hardware; entradas espaçadas abaixo
        cfg.bitrate = 1'000'000;
        enc.start(cfg, [&](const EncodedVideoFrame &f) {
            std::lock_guard lock(m);
            packets.append(f);
        });
        QImage img(1280, 720, QImage::Format_RGBX8888);
        for (int i = 0; i < 150; ++i) {
            img.fill(QColor::fromHsv((i * 30) % 360, 200, 200));
            enc.pushFrame(QVideoFrame(img));
            QTest::qWait(30);
            std::lock_guard lock(m);
            if (packets.size() >= 5)
                break;
        }
        QTRY_VERIFY_WITH_TIMEOUT([&] { std::lock_guard lock(m); return packets.size() >= 5; }(), 5000);
        enc.stop();
        QVERIFY(packets.first().keyFrame);
        QCOMPARE(packets.first().width, 640);

        std::atomic<int> decoded{0};
        QSize decodedSize;
        VideoDecoder dec;
        dec.start(QStringLiteral("H264"), [&](const QVideoFrame &f) {
            decodedSize = f.size();
            decoded++;
        }, [] {});
        for (const auto &p : packets)
            dec.push(p.data);
        QTRY_VERIFY_WITH_TIMEOUT(decoded >= 3, 5000);
        dec.stop();
        QCOMPARE(decodedSize, QSize(640, 360));
    }

    void opusRoundTrip()
    {
        QList<QByteArray> packets;
        OpusEncoder enc;
        QVERIFY(enc.open(128000, [&](const QByteArray &p, quint32) { packets.append(p); }));
        QByteArray pcm(48000 / 10 * 2 * 4, 0); // 100 ms de silêncio estéreo float
        enc.push(pcm, 48000, 2);
        QCOMPARE(packets.size(), 5); // 5 quadros de 20 ms
        OpusDecoder dec;
        QByteArray out;
        for (const auto &p : packets)
            out += dec.decode(p);
        QCOMPARE(out.size(), 5 * 960 * 2 * 4);
    }

    // A captura não entrega nada no silêncio; o timestamp RTP tem que seguir o
    // relógio (como num silêncio DTX) para o player do navegador não descartar o som.
    void opusTimestampFollowsTheClockAcrossSilence()
    {
        QList<quint32> stamps;
        OpusEncoder enc;
        QVERIFY(enc.open(128000, [&](const QByteArray &, quint32 ts) { stamps.append(ts); }));
        const QByteArray pcm(960 * 2 * 4, 0); // 20 ms
        for (int i = 0; i < 5; ++i)
            enc.push(pcm, 48000, 2);
        QTest::qSleep(600);
        for (int i = 0; i < 5; ++i)
            enc.push(pcm, 48000, 2);
        QVERIFY(stamps.size() >= 8);
        quint32 biggestStep = 0;
        for (int i = 1; i < stamps.size(); ++i) {
            const quint32 step = stamps[i] - stamps[i - 1]; // módulo 2^32, como no RTP
            QVERIFY2(step > 0 && step < 0x80000000u, qPrintable(QString::number(stamps[i - 1]) + " -> " + QString::number(stamps[i])));
            QCOMPARE(step % 960, 0u);
            biggestStep = std::max(biggestStep, step);
        }
        QVERIFY2(biggestStep >= 48000 / 5, "o timestamp não pulou o silêncio de 600 ms");
    }
};

QTEST_MAIN(TestEngine)
#include "tst_engine.moc"
