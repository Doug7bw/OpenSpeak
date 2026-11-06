// Teste ponta a ponta do modo SFU, num único processo:
// transmissor (padrão de teste, H.264 + RTP) -> relay do servidor C++ -> dois
// espectadores (depacketizam, decodificam). Valida a sinalização com o clid 0,
// o repasse sem transcodificação para mais de um espectador, a porta UDP única
// (ICE UDP mux), estatísticas e o fim do stream.

#include "ConnectionHandler.h"
#include "ScreenshareManager.h"
#include "ServerHost.h"
#include "Settings.h"

#include <QSignalSpy>
#include <QTest>
#include <QUdpSocket>
#include <QVideoSink>
#include <QTemporaryDir>
#include <QFile>
#include <QJsonDocument>
#include <QScopeGuard>
#include <QNetworkAccessManager>
#include <QNetworkReply>

using namespace openspeak;

class TestSfuEndToEnd : public QObject {
    Q_OBJECT

    /// GET /api/live (o que o bot do Discord lê): dados do stream `id`.
    static QJsonObject liveMedia(quint16 port, const QString &id)
    {
        QNetworkAccessManager network;
        std::unique_ptr<QNetworkReply> reply(network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/live").arg(port)))));
        QSignalSpy done(reply.get(), &QNetworkReply::finished);
        if (!done.wait(5000))
            return {};
        for (const auto &value : QJsonDocument::fromJson(reply->readAll()).object().value("streams").toArray())
            if (value.toObject().value("id").toString() == id)
                return value.toObject().value("media").toObject();
        return {};
    }

    static QVariantMap item(const ScreenshareManager &m, const QString &id)
    {
        for (const QVariant &v : m.items())
            if (v.toMap().value("streamIdentifier").toString() == id)
                return v.toMap();
        return {};
    }

    static quint16 freeUdpPort()
    {
        QUdpSocket probe;
        probe.bind(QHostAddress::AnyIPv4, 0);
        return probe.localPort();
    }

private slots:
    void relayToTwoViewers()
    {
        QTemporaryDir metricsDir;
        QVERIFY(metricsDir.isValid());
        const QString metricsFile = metricsDir.filePath("metrics.json");
        const QByteArray previousMetricsFile = qgetenv("OPENSPEAK_METRICS_FILE");
        qputenv("OPENSPEAK_METRICS_FILE", metricsFile.toUtf8());
        const auto restoreEnv = qScopeGuard([&] {
            if (previousMetricsFile.isNull()) qunsetenv("OPENSPEAK_METRICS_FILE");
            else qputenv("OPENSPEAK_METRICS_FILE", previousMetricsFile);
        });
        const auto snapshot = [&] {
            QFile file(metricsFile);
            return file.open(QIODevice::ReadOnly) ? QJsonDocument::fromJson(file.readAll()).object() : QJsonObject{};
        };
        if (qEnvironmentVariableIsSet("OPENSPEAK_RTC_LOG"))
            rtc::InitLogger(rtc::LogLevel::Debug);
        ServerHost::Options opts;
        opts.port = 0;
        opts.address = QHostAddress::LocalHost;
        opts.iceServers = {}; // apenas candidatos locais
        opts.sfu = true;
        opts.rtcPort = freeUdpPort();
        ServerHost host(opts);
        QVERIFY(host.start());
        QVERIFY(host.sfuEnabled());
        const QString url = QStringLiteral("ws://127.0.0.1:%1/ws").arg(host.port());

        Settings settingsA(QStringLiteral("sfu-host"), true), settingsB(QStringLiteral("sfu-viewer-b"), true),
            settingsC(QStringLiteral("sfu-viewer-c"), true);
        for (Settings *s : {&settingsA, &settingsB, &settingsC}) {
            s->setShowInactiveStreams(true);
            s->setHiddenStreams({});
        }
        ConnectionHandler a, b, c;
        ScreenshareManager ma(&a, &settingsA), mb(&b, &settingsB), mc(&c, &settingsC);
        a.connectTo(url, QStringLiteral("Host"), settingsA.uid());
        b.connectTo(url, QStringLiteral("ViewerB"), settingsB.uid());
        c.connectTo(url, QStringLiteral("ViewerC"), settingsC.uid());
        QTRY_VERIFY_WITH_TIMEOUT(a.isConnected() && b.isConnected() && c.isConnected(), 5000);
        QTRY_VERIFY_WITH_TIMEOUT(a.serverPingMs() >= 0 && b.serverPingMs() >= 0 && c.serverPingMs() >= 0, 5000);
        QTRY_VERIFY_WITH_TIMEOUT(a.client(b.ownClid()) && a.client(b.ownClid())->pingMs >= 0, 5000);
        QVERIFY(a.hasStreamingP2P());
        QVERIFY(a.hasStreamingSFU());

        // Transmissor: padrão de teste 1280x720, público (aceite automático), modo SFU.
        QVERIFY(ma.openPreview({{"type", 2}, {"id", "test"}, {"test", true}}, 30));
        ma.startStream({{"name", "SFU"}, {"access", 1}, {"mode", 2}, {"audio", false}, {"bitrate", 2'000'000},
                        {"width", 1280}, {"height", 720}, {"fps", 30}});
        QTRY_COMPARE_WITH_TIMEOUT(b.streams().size(), 1, 5000);
        const QString id = b.streams().firstKey();
        QCOMPARE(ma.ownConfig(id).value("mode").toInt(), int(StreamMode::SFU));

        // Transmissor -> servidor conecta antes de qualquer espectador.
        QTRY_VERIFY_WITH_TIMEOUT(ma.stats(id, 0).value("video").toMap().value("connectionType").toString() != QString(), 20000);

        QVideoSink sinkB, sinkC;
        int framesB = 0, framesC = 0;
        QSize sizeB, sizeC;
        connect(&sinkB, &QVideoSink::videoFrameChanged, this, [&](const QVideoFrame &f) { framesB++; sizeB = f.size(); });
        connect(&sinkC, &QVideoSink::videoFrameChanged, this, [&](const QVideoFrame &f) { framesC++; sizeC = f.size(); });

        mb.joinStream(id);
        mc.joinStream(id);
        QTRY_VERIFY_WITH_TIMEOUT(item(mb, id).value("status").toString() != QLatin1String("waiting"), 5000);
        QTRY_VERIFY_WITH_TIMEOUT(item(mc, id).value("status").toString() != QLatin1String("waiting"), 5000);
        mb.attachVideo(id, &sinkB);
        mc.attachVideo(id, &sinkC);

        QTRY_COMPARE_WITH_TIMEOUT(item(mb, id).value("status").toString(), QStringLiteral("playing"), 20000);
        QTRY_COMPARE_WITH_TIMEOUT(item(mc, id).value("status").toString(), QStringLiteral("playing"), 20000);
        QTRY_VERIFY_WITH_TIMEOUT(framesB >= 15 && framesC >= 15, 20000);
        QCOMPARE(sizeB, QSize(1280, 720));
        QCOMPARE(sizeC, QSize(1280, 720));
        QTRY_COMPARE_WITH_TIMEOUT(snapshot().value("mediaSessions").toArray().size(), 3, 5000);
        const auto metrics = snapshot();
        for (const auto &value : metrics.value("mediaSessions").toArray()) {
            const auto session = value.toObject();
            QCOMPARE(session.value("state").toString(), QStringLiteral("connected"));
            if (session.value("role").toString() == QLatin1String("publisher"))
                QVERIFY(session.value("mediaRxBytes").toDouble() > 0);
            else
                QVERIFY(session.value("mediaTxBytes").toDouble() > 0);
            QVERIFY(!session.value("mediaIp").toString().isEmpty());
        }
        for (const auto &value : metrics.value("clients").toArray()) {
            const auto client = value.toObject();
            QCOMPARE(client.value("ip").toString(), QStringLiteral("127.0.0.1"));
            QCOMPARE(client.value("clientInfo").toObject().value("kind").toString(), QStringLiteral("native"));
            QVERIFY(client.value("connectedAt").toDouble() > 0);
        }
        qInfo() << "quadros recebidos: B =" << framesB << " C =" << framesC;

        // O transmissor mantém UMA sessão (com o servidor) e vê os dois espectadores.
        QTRY_COMPARE_WITH_TIMEOUT(ma.viewers(id).value("viewers").toList().size(), 2, 3000);
        const QVariantMap out = ma.stats(id, 0);
        QCOMPARE(out.value("viewers").toList().size(), 1);
        QCOMPARE(out.value("viewers").toList().first().toMap().value("clid").toInt(), RelayClid);
        QVERIFY(out.value("video").toMap().value("sentPackets").toLongLong() > 0);
        const QVariantMap in = mb.stats(id, 0);
        QVERIFY(in.value("video").toMap().value("receivedPackets").toLongLong() > 0);
        qInfo() << "envio:" << out.value("video").toMap().value("sentPackets") << "pacotes  recebimento (B):"
                << in.value("video").toMap().value("receivedPackets") << "pacotes," << in.value("video").toMap().value("decoder").toString();

        // Bot do Discord: total de dados do stream (transmissor -> servidor -> espectadores).
        const QJsonObject media = liveMedia(host.port(), id);
        QVERIFY(media.value("sentBytes").toDouble() > 0);
        QVERIFY(media.value("receivedBytes").toDouble() > 0);

        // Simulcast: os dois começam na camada alta. C escolhe a baixa e passa a
        // receber 480p; B continua em 720p. De volta ao automático, C volta à alta.
        QTRY_VERIFY_WITH_TIMEOUT(item(mc, id).value("simulcast").toBool(), 5000);
        QCOMPARE(item(mc, id).value("layer").toString(), QStringLiteral("high"));
        mc.setQualityPreference(id, QStringLiteral("low"));
        QCOMPARE(item(mc, id).value("qualityPreference").toString(), QStringLiteral("low"));
        QTRY_COMPARE_WITH_TIMEOUT(item(mc, id).value("layer").toString(), QStringLiteral("low"), 5000);
        QTRY_COMPARE_WITH_TIMEOUT(sizeC.height(), 480, 10000);
        const int beforeLowB = framesB;
        QTRY_VERIFY_WITH_TIMEOUT(framesB >= beforeLowB + 15, 10000);
        QCOMPARE(sizeB, QSize(1280, 720));
        mc.setQualityPreference(id, QStringLiteral("auto"));
        QTRY_COMPARE_WITH_TIMEOUT(item(mc, id).value("layer").toString(), QStringLiteral("high"), 5000);
        QTRY_COMPARE_WITH_TIMEOUT(sizeC, QSize(1280, 720), 10000);

        // Kick de um espectador não afeta o outro.
        ma.removeViewer(id, c.ownClid(), false);
        QTRY_COMPARE_WITH_TIMEOUT(item(mc, id).value("errorKey").toString(), QStringLiteral("video.join.error.kicked"), 3000);
        const int beforeKick = framesB;
        QTRY_VERIFY_WITH_TIMEOUT(framesB >= beforeKick + 15, 10000);
        QCOMPARE(item(mb, id).value("status").toString(), QStringLiteral("playing"));
        // O total só cresce: o que foi entregue a quem saiu continua contando.
        const QJsonObject afterKick = liveMedia(host.port(), id);
        QVERIFY(afterKick.value("sentBytes").toDouble() > media.value("sentBytes").toDouble());
        QVERIFY(afterKick.value("receivedBytes").toDouble() > media.value("receivedBytes").toDouble());

        // Fim do stream.
        ma.stopStream(id);
        QTRY_VERIFY_WITH_TIMEOUT(b.streams().isEmpty() && c.streams().isEmpty(), 3000);
        QTRY_VERIFY_WITH_TIMEOUT(mb.items().isEmpty(), 3000);
    }

    void sfuUnavailableFallsBack()
    {
        // Servidor sem relay: STREAM_SFU não é anunciado e o stream cai para P2P.
        ServerHost::Options opts;
        opts.port = 0;
        opts.address = QHostAddress::LocalHost;
        ServerHost host(opts);
        QVERIFY(host.start());
        QVERIFY(!host.sfuEnabled());
        Settings settings(QStringLiteral("sfu-off"), true);
        ConnectionHandler a;
        ScreenshareManager ma(&a, &settings);
        a.connectTo(QStringLiteral("ws://127.0.0.1:%1/ws").arg(host.port()), QStringLiteral("Host"), settings.uid());
        QTRY_VERIFY_WITH_TIMEOUT(a.isConnected(), 5000);
        QVERIFY(!a.hasStreamingSFU());
        QSignalSpy errors(&ma, &ScreenshareManager::errorOccurred);
        QVERIFY(ma.openPreview({{"type", 2}, {"id", "test"}, {"test", true}}, 30));
        ma.startStream({{"mode", 2}, {"audio", false}});
        QCOMPARE(errors.count(), 0);
        QTRY_COMPARE_WITH_TIMEOUT(a.streams().size(), 1, 5000);
        const QString id = a.streams().firstKey();
        QCOMPARE(ma.ownConfig(id).value("mode").toInt(), int(StreamMode::P2P));
        ma.stopStream(id);
        QTRY_VERIFY_WITH_TIMEOUT(a.streams().isEmpty(), 3000);
    }
};

QTEST_MAIN(TestSfuEndToEnd)
#include "tst_sfu_e2e.moc"
