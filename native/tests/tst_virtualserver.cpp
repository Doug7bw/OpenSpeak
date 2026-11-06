// Mesmos cenários de test/server.test.js, contra a porta C++.

#include "VirtualServer.h"

#include <QDateTime>
#include <QFile>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <QTest>

using namespace openspeak;

/// Relay falso: registra as chamadas e expõe os callbacks (sem mídia).
class FakeRelay : public StreamRelay {
public:
    QStringList calls;
    SignalFn signal;
    FailFn failed;

    void setCallbacks(SignalFn s, FailFn f) override
    {
        signal = std::move(s);
        failed = std::move(f);
    }
    void openStream(const QString &id, int owner, int bitrate) override { calls << QStringLiteral("open %1 %2 %3").arg(id).arg(owner).arg(bitrate); }
    void updateStream(const QString &id, int bitrate) override { calls << QStringLiteral("update %1 %2").arg(id).arg(bitrate); }
    void closeStream(const QString &id) override { calls << QStringLiteral("close %1").arg(id); }
    void addViewer(const QString &id, int clid) override { calls << QStringLiteral("add %1 %2").arg(id).arg(clid); }
    void removeViewer(const QString &id, int clid) override { calls << QStringLiteral("remove %1 %2").arg(id).arg(clid); }
    bool webSocketViewers = true;
    bool addWebSocketViewer(const QString &id, int clid) override
    {
        calls << QStringLiteral("addws %1 %2").arg(id).arg(clid);
        return webSocketViewers;
    }
    void signaling(const QString &id, int from, const QJsonObject &payload) override
    {
        calls << QStringLiteral("signal %1 %2 %3").arg(id).arg(from).arg(payload.value("type").toString());
    }
};

class TestVirtualServer : public QObject {
    Q_OBJECT

    std::unique_ptr<VirtualServer> server;
    QHash<int, QList<QJsonObject>> inbox;

    int login(const QString &nick)
    {
        const int clid = server->connect();
        inbox[clid];
        server->handle(clid, "login", {{"nickname", nick}, {"uid", "uid-" + nick}});
        return clid;
    }

    QList<QJsonObject> notes(int clid, const QString &cmd) const
    {
        QList<QJsonObject> out;
        for (const QJsonObject &m : inbox.value(clid))
            if (m.value("cmd").toString() == cmd)
                out.append(m.value("args").toObject());
        return out;
    }

    QString expectError(int clid, const QString &cmd, const QJsonObject &args)
    {
        try {
            server->handle(clid, cmd, args);
        } catch (const CommandError &e) {
            return e.code;
        }
        return QStringLiteral("<sem erro>");
    }

    QString setup(int host, const QJsonObject &args = {})
    {
        return server->handle(host, "setupstream", args).value("streamIdentifier").toString();
    }

private slots:
    void init()
    {
        inbox.clear();
        server = std::make_unique<VirtualServer>([this](int clid, const QJsonObject &m) { inbox[clid].append(m); });
    }

    void cleanup() { server.reset(); } // antes dos relays falsos (locais a cada teste)

    // ---- perfis (mesmos cenários de test/server.test.js)

    void profileClaimRequiresPasswordOnLogin()
    {
        const int jonas = login("Jonas");
        const int other = login("other");
        QVERIFY(server->handle(jonas, "sync", {}).value("server").toObject().value("capabilityExtensions").toArray().contains(CapProfiles));
        QCOMPARE(expectError(jonas, "updateprofile", {{"color", "#ff0000"}}), rc::ProfileRequired);
        QCOMPARE(expectError(jonas, "setprofilepassword", {{"password", "x"}}), rc::InvalidArgs);

        server->handle(jonas, "setprofilepassword", {{"password", "segredo"}});
        QVERIFY(notes(other, "notifyclientupdated").last().value("client").toObject().value("hasProfile").toBool());

        server->disconnect(jonas);
        const int again = server->connect();
        QCOMPARE(expectError(again, "login", {{"nickname", "jonas"}, {"uid", "u2"}}), rc::ProfilePassword);
        QCOMPARE(expectError(again, "login", {{"nickname", "jonas"}, {"uid", "u2"}, {"profilePassword", "errada"}}), rc::ProfilePassword);
        const QJsonObject view = server->handle(again, "login", {{"nickname", "jonas"}, {"uid", "u2"}, {"profilePassword", "segredo"}});
        bool found = false;
        for (const QJsonValue &c : view.value("clients").toArray())
            found |= c.toObject().value("nickname").toString() == QLatin1String("Jonas");
        QVERIFY(found); // o apelido é o da reivindicação, sem variar a caixa
    }

    void profileNicknameCannotChangeOrBeTaken()
    {
        const int jonas = login("Jonas");
        const int other = login("other");
        server->handle(jonas, "setprofilepassword", {{"password", "segredo"}});
        QCOMPARE(expectError(jonas, "clientupdate", {{"nickname", "novo"}}), rc::PermissionDenied);
        QCOMPARE(expectError(other, "clientupdate", {{"nickname", "JONAS"}}), rc::ProfilePassword);
    }

    void profilePasswordChangeNeedsCurrent()
    {
        const int jonas = login("Jonas");
        server->handle(jonas, "setprofilepassword", {{"password", "segredo"}});
        QCOMPARE(expectError(jonas, "setprofilepassword", {{"password", "nova1"}}), rc::ProfilePassword);
        server->handle(jonas, "setprofilepassword", {{"password", "nova1"}, {"currentPassword", "segredo"}});
        server->disconnect(jonas);
        server->handle(server->connect(), "login", {{"nickname", "Jonas"}, {"uid", "u"}, {"profilePassword", "nova1"}});
    }

    void profileTooManyAttemptsLocks()
    {
        qint64 now = 1000;
        server->setProfileClock([&now] { return now; });
        const int jonas = login("Jonas");
        server->handle(jonas, "setprofilepassword", {{"password", "segredo"}});
        const auto attempt = [this](const QString &password) {
            return expectError(server->connect(), "login", {{"nickname", "Jonas"}, {"uid", "u"}, {"profilePassword", password}});
        };
        for (int i = 0; i < 5; ++i)
            QCOMPARE(attempt("errada"), rc::ProfilePassword);
        QCOMPARE(attempt("segredo"), rc::ProfileLocked);
        now += 60'001;
        QCOMPARE(attempt("segredo"), QStringLiteral("<sem erro>"));
    }

    void profileDataIsValidatedAndShown()
    {
        const int jonas = login("Jonas");
        const int viewer = login("viewer");
        server->handle(jonas, "setprofilepassword", {{"password", "segredo"}});
        QCOMPARE(expectError(jonas, "updateprofile", {{"color", "red;x"}}), rc::InvalidArgs);
        QCOMPARE(expectError(jonas, "updateprofile", {{"avatar", "data:image/svg+xml;base64,AAAA"}}), rc::InvalidArgs);
        QCOMPARE(expectError(jonas, "updateprofile", {{"avatar", "data:image/png;base64," + QString(70'000, 'A')}}), rc::PayloadTooLarge);
        server->handle(jonas, "updateprofile", {{"displayName", " Jonas H "}, {"color", "#12ab9F"}, {"description", "oi"},
                                                {"avatar", "data:image/png;base64,AAAA"}});
        const QJsonObject client = notes(viewer, "notifyclientupdated").last().value("client").toObject();
        QCOMPARE(client.value("nickname").toString(), QStringLiteral("Jonas"));
        QCOMPARE(client.value("displayName").toString(), QStringLiteral("Jonas H"));
        QCOMPARE(client.value("color").toString(), QStringLiteral("#12ab9F"));
        QCOMPARE(client.value("description").toString(), QStringLiteral("oi"));
        QCOMPARE(client.value("avatar").toString(), QStringLiteral("data:image/png;base64,AAAA"));

        // Banner: fora da lista, baixado sob demanda; 400 KB+ passam pela validação.
        QCOMPARE(expectError(jonas, "updateprofile", {{"banner", "data:image/svg+xml;base64,AAAA"}}), rc::InvalidArgs);
        QCOMPARE(expectError(jonas, "updateprofile", {{"banner", "data:image/gif;base64," + QString(460'000, 'A')}}), rc::PayloadTooLarge);
        const QString banner = "data:image/gif;base64," + QString(430'000, 'A');
        server->handle(jonas, "updateprofile", {{"banner", banner}});
        const QJsonObject media = server->handle(jonas, "profilemedia", {{"clid", jonas}});
        QCOMPARE(media.value("banner").toString(), banner);
        QCOMPARE(media.value("mediaTag").toString().size(), 12);
        QCOMPARE(expectError(jonas, "updateprofile", {{"avatarAnimated", "data:image/png;base64,AAAA"}}), rc::InvalidArgs);
        server->handle(jonas, "updateprofile", {{"avatarAnimated", "data:image/gif;base64,BBBB"}});
        QCOMPARE(server->handle(jonas, "profilemedia", {{"clid", jonas}}).value("avatarAnimated").toString(), QStringLiteral("data:image/gif;base64,BBBB"));

        setup(jonas);
        const QJsonObject stream = server->liveSnapshot().value("streams").toArray().first().toObject();
        QCOMPARE(stream.value("owner").toString(), QStringLiteral("Jonas H"));
        QCOMPARE(stream.value("name").toString(), QStringLiteral("Stream de Jonas H"));
    }

    void profileSurvivesRestart()
    {
        QTemporaryDir dir;
        const QString file = dir.filePath("sub/profiles.json");
        server->setProfilesFile(file);
        const int jonas = login("Jonas");
        server->handle(jonas, "setprofilepassword", {{"password", "segredo"}});
        server->handle(jonas, "updateprofile", {{"color", "#112233"}});

        server = std::make_unique<VirtualServer>([this](int clid, const QJsonObject &m) { inbox[clid].append(m); });
        server->setProfilesFile(file);
        const QJsonObject view = server->handle(server->connect(), "login", {{"nickname", "Jonas"}, {"uid", "u"}, {"profilePassword", "segredo"}});
        QCOMPARE(view.value("clients").toArray().first().toObject().value("color").toString(), QStringLiteral("#112233"));
    }

    // O monitor gera senhas novas no arquivo: o servidor precisa enxergá-las sem reiniciar.
    void profileReloadsFileChangedOutside()
    {
        QTemporaryDir dir;
        const QString file = dir.filePath("profiles.json");
        server->setProfilesFile(file);
        const int jonas = login("Jonas");
        server->handle(jonas, "setprofilepassword", {{"password", "segredo"}});

        QFile in(file);
        QVERIFY(in.open(QIODevice::ReadOnly));
        QJsonObject root = QJsonDocument::fromJson(in.readAll()).object();
        in.close();
        QJsonObject profiles = root.value("profiles").toObject();
        QJsonObject profile = profiles.value("jonas").toObject();
        profile["password"] = ProfileStore::hashPassword("gerada", "0123456789abcdef", 1000);
        profiles["jonas"] = profile;
        root["profiles"] = profiles;
        QFile out(file);
        QVERIFY(out.open(QIODevice::WriteOnly));
        out.write(QJsonDocument(root).toJson(QJsonDocument::Compact));
        out.setFileTime(QDateTime::currentDateTime().addSecs(5), QFileDevice::FileModificationTime);
        out.close();

        QCOMPARE(expectError(server->connect(), "login", {{"nickname", "Jonas"}, {"uid", "u"}, {"profilePassword", "segredo"}}), rc::ProfilePassword);
        QCOMPARE(expectError(server->connect(), "login", {{"nickname", "Jonas"}, {"uid", "u"}, {"profilePassword", "gerada"}}), QStringLiteral("<sem erro>"));
    }

    // Mesmo vetor de test/server.test.js: os dois servidores leem o arquivo um do outro.
    void profileHashMatchesNodeServer()
    {
        const QString stored = ProfileStore::hashPassword("senha", "0123456789abcdef", 1000);
        QCOMPARE(stored, QStringLiteral("pbkdf2-sha256$1000$MDEyMzQ1Njc4OWFiY2RlZg==$yNWjOB5+y96EHOKAn3xp3CM7YwtRLFxNMPHfhb8vN8c="));
        QVERIFY(ProfileStore::checkPassword("senha", stored));
        QVERIFY(!ProfileStore::checkPassword("outra", stored));
    }

    // O padrão é só o "Geral"; os testes de troca de canal recriam o servidor com três.
    void useThreeChannels()
    {
        server = std::make_unique<VirtualServer>([this](int clid, const QJsonObject &m) { inbox[clid].append(m); },
                                                 QStringLiteral("OpenSpeak"), QJsonArray{},
                                                 VirtualServer::ChannelList{{"Geral", {}}, {"B", {}}, {"C", {}}});
    }

    void defaultServerHasOnlyGeral()
    {
        const int a = login("a");
        const QJsonArray channels = server->handle(a, "sync", {}).value("channels").toArray();
        QCOMPARE(channels.size(), 1);
        QCOMPARE(channels.first().toObject().value("name").toString(), QStringLiteral("Geral"));
    }

    void loginRequiresPasswordWhenSet()
    {
        server->setPassword("segredo");
        const int a = server->connect();
        QCOMPARE(expectError(a, "login", {{"nickname", "a"}, {"uid", "a"}}), rc::AccessDenied);
        QCOMPARE(expectError(a, "login", {{"nickname", "a"}, {"uid", "a"}, {"password", "errada"}}), rc::AccessDenied);
        QCOMPARE(expectError(a, "sync", {}), rc::NotLoggedIn);
        QCOMPARE(expectError(a, "login", {{"nickname", "a"}, {"uid", "a"}, {"password", "segredo"}}), QStringLiteral("<sem erro>"));
        server->setPassword({});
        const int b = server->connect();
        QCOMPARE(expectError(b, "login", {{"nickname", "b"}, {"uid", "b"}}), QStringLiteral("<sem erro>"));
    }

    void monitoringTracksLoginStreamsAndDisconnect()
    {
        const int pending = server->connect();
        const int host = login("host"), viewer = login("viewer");
        const QString sid = setup(host, {{"name", "Tela"}});
        server->handle(viewer, "joinstreamrequest", {{"streamIdentifier", sid}});
        server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", viewer}, {"accept", true}});
        const auto snapshot = server->monitoringSnapshot();
        QCOMPARE(snapshot.value("connections").toInt(), 3);
        QCOMPARE(snapshot.value("clients").toArray().size(), 2);
        QCOMPARE(snapshot.value("viewerSubscriptions").toInt(), 1);
        QCOMPARE(snapshot.value("streams").toArray().size(), 1);
        QCOMPARE(snapshot.value("streams").toArray().first().toObject().value("viewerClids").toArray(), QJsonArray{viewer});
        QVERIFY(!snapshot.value("clients").toArray().first().toObject().contains("uid"));
        QVERIFY(!snapshot.value("streams").toArray().first().toObject().contains("thumbnail"));
        server->disconnect(host);
        server->disconnect(pending);
        QCOMPARE(server->monitoringSnapshot().value("clients").toArray().size(), 1);
        QCOMPARE(server->monitoringSnapshot().value("streams").toArray().size(), 0);
    }

    void liveSnapshotListsOnlyAnnouncedStreams()
    {
        const int host = login("host"), other = login("other");
        const QString shown = setup(host, {{"name", "Ranked"}, {"app", "Counter-Strike 2"}, {"type", int(StreamType::Window)}});
        setup(other, {{"name", "Segredo"}, {"announce", false}});
        QVERIFY(notes(other, "notifystreamstarted").first().value("stream").toObject().value("announce").toBool());

        auto streams = server->liveSnapshot().value("streams").toArray();
        QCOMPARE(streams.size(), 1);
        const QJsonObject s = streams.first().toObject();
        QCOMPARE(s.value("id").toString(), shown);
        QCOMPARE(s.value("owner").toString(), QStringLiteral("host"));
        QCOMPARE(s.value("app").toString(), QStringLiteral("Counter-Strike 2"));
        QCOMPARE(s.value("channel").toString(), QStringLiteral("Geral"));
        QVERIFY(!s.contains("uid"));
        QVERIFY(!s.contains("thumbnail"));
        // Contagens contam também streams sem anúncio, mas sem dizer de quem.
        const QJsonObject stats = server->liveSnapshot().value("stats").toObject();
        QCOMPARE(stats.value("clients").toInt(), 2);
        QCOMPARE(stats.value("streams").toInt(), 2);
        QCOMPARE(stats.value("viewers").toInt(), 0);
        QVERIFY(stats.value("mbps").isNull());
        QCOMPARE(s.value("viewerNames").toArray(), QJsonArray{});

        // Quem assiste aparece pelo apelido (o bot lista no fim da transmissão).
        server->handle(other, "joinstreamrequest", {{"streamIdentifier", shown}});
        server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", shown}, {"clid", other}, {"accept", true}});
        QCOMPARE(server->liveSnapshot().value("streams").toArray().first().toObject().value("viewerNames").toArray(),
                 QJsonArray{QStringLiteral("other")});

        server->handle(host, "updatestream", {{"streamIdentifier", shown}, {"announce", false}});
        QCOMPARE(server->liveSnapshot().value("streams").toArray().size(), 0);
        server->handle(host, "updatestream", {{"streamIdentifier", shown}, {"announce", true}, {"app", "Chrome"}});
        streams = server->liveSnapshot().value("streams").toArray();
        QCOMPARE(streams.first().toObject().value("app").toString(), QStringLiteral("Chrome"));
    }

    void liveChangedFiresOnStreamLifecycle()
    {
        int calls = 0;
        server->setLiveChangedCallback([&] { ++calls; });
        const int host = login("host");
        QCOMPARE(calls, 1); // login muda o contador "online"
        const int pending = server->connect();
        server->disconnect(pending);
        QCOMPARE(calls, 1); // quem nem fez login não conta
        const QString sid = setup(host);
        QCOMPARE(calls, 2);
        server->handle(host, "updatestream", {{"streamIdentifier", sid}, {"app", "Chrome"}});
        QCOMPARE(calls, 3);
        server->handle(host, "clientupdate", {{"nickname", "novo"}});
        QCOMPARE(calls, 4);
        server->disconnect(host);
        QVERIFY(calls >= 5); // fim do stream e saída do usuário
    }

    void serverMeasuredLatencyIsPublicWithoutPrivateMetadata()
    {
        const int a = login("a"), b = login("b");
        server->setClientLatency(a, 37);
        const auto notices = notes(b, "notifyclientlatency");
        QCOMPARE(notices.size(), 1);
        QCOMPARE(notices.first().value("clid").toInt(), a);
        QCOMPARE(notices.first().value("pingMs").toInt(), 37);
        QVERIFY(!notices.first().contains("ip"));
        const int c = server->connect();
        const auto view = server->handle(c, "login", {{"nickname", "c"}, {"uid", "uid-c"}});
        QCOMPARE(view.value("clients").toArray().first().toObject().value("pingMs").toInt(), 37);
        server->setClientLatency(a, -1);
        QVERIFY(notes(b, "notifyclientlatency").last().value("pingMs").isNull());
        QCOMPARE(expectError(a, "setClientLatency", {{"pingMs", 0}}), rc::UnknownCommand);
    }

    void fullFlow()
    {
        const int host = login("host"), viewer = login("viewer");
        const QString sid = setup(host, {{"name", "Tela"}, {"access", int(StreamAccess::Private)}});
        QCOMPARE(notes(viewer, "notifystreamstarted").size(), 1);

        server->handle(viewer, "joinstreamrequest", {{"streamIdentifier", sid}, {"codecs", QJsonArray{"video/H264"}}});
        const auto req = notes(host, "notifyjoinstreamrequest");
        QCOMPARE(req.size(), 1);
        QCOMPARE(req[0].value("clid").toInt(), viewer);
        QCOMPARE(req[0].value("codecs").toArray().first().toString(), QStringLiteral("video/H264"));

        const QJsonObject offer{{"type", "offer"}, {"sdp", "v=0"}};
        QCOMPARE(expectError(host, "streamsignaling", {{"streamIdentifier", sid}, {"clid", viewer}, {"payload", offer}}), rc::PermissionDenied);

        server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", viewer}, {"accept", true}});
        QVERIFY(notes(viewer, "notifyrespondjoinstreamrequest")[0].value("accepted").toBool());
        QCOMPARE(notes(host, "notifystreamclientjoined")[0].value("clid").toInt(), viewer);

        server->handle(host, "streamsignaling", {{"streamIdentifier", sid}, {"clid", viewer}, {"payload", offer}});
        const auto sig = notes(viewer, "notifystreamsignaling");
        QCOMPARE(sig[0].value("clid").toInt(), host);
        QCOMPARE(sig[0].value("payload").toObject().value("type").toString(), QStringLiteral("offer"));

        server->handle(viewer, "removeclientfromstream", {{"streamIdentifier", sid}});
        QCOMPARE(notes(host, "notifystreamclientleft")[0].value("reason").toInt(), int(LeaveReason::Left));
    }

    void banAndUnban()
    {
        const int host = login("host"), viewer = login("viewer");
        const QString sid = setup(host);
        server->handle(viewer, "joinstreamrequest", {{"streamIdentifier", sid}});
        server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", viewer}, {"accept", false}, {"ban", true}});
        QCOMPARE(notes(viewer, "notifyrespondjoinstreamrequest")[0].value("reason").toInt(), int(LeaveReason::Banned));
        QCOMPARE(expectError(viewer, "joinstreamrequest", {{"streamIdentifier", sid}}), rc::Banned);
        server->handle(host, "streamunban", {{"streamIdentifier", sid}, {"uid", "uid-viewer"}});
        server->handle(viewer, "joinstreamrequest", {{"streamIdentifier", sid}});
    }

    void kickWithBan()
    {
        const int host = login("host"), viewer = login("viewer");
        const QString sid = setup(host);
        server->handle(viewer, "joinstreamrequest", {{"streamIdentifier", sid}});
        server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", viewer}, {"accept", true}});
        server->handle(host, "removeclientfromstream", {{"streamIdentifier", sid}, {"clid", viewer}, {"reason", int(LeaveReason::Banned)}});
        QCOMPARE(notes(viewer, "notifystreamclientleft")[0].value("reason").toInt(), int(LeaveReason::Banned));
        QCOMPARE(notes(host, "notifystreambanadded").size(), 1);
        QCOMPARE(expectError(viewer, "joinstreamrequest", {{"streamIdentifier", sid}}), rc::Banned);
    }

    void viewerCannotRemoveOthers()
    {
        const int host = login("host"), a = login("a"), b = login("b");
        const QString sid = setup(host);
        for (int c : {a, b}) {
            server->handle(c, "joinstreamrequest", {{"streamIdentifier", sid}});
            server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", c}, {"accept", true}});
        }
        QCOMPARE(expectError(a, "removeclientfromstream", {{"streamIdentifier", sid}, {"clid", b}}), rc::PermissionDenied);
        QCOMPARE(expectError(a, "streamsignaling", {{"streamIdentifier", sid}, {"clid", b}, {"payload", QJsonObject{{"type", "ice"}}}}),
                 rc::PermissionDenied);
    }

    void viewerLimit()
    {
        const int host = login("host"), a = login("a"), b = login("b");
        const QString sid = setup(host, {{"viewerLimit", 1}});
        server->handle(a, "joinstreamrequest", {{"streamIdentifier", sid}});
        server->handle(b, "joinstreamrequest", {{"streamIdentifier", sid}});
        server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", a}, {"accept", true}});
        QCOMPARE(expectError(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", b}, {"accept", true}}), rc::ViewerLimit);
    }

    void leavingChannelStopsStreams()
    {
        useThreeChannels();
        const int host = login("host"), viewer = login("viewer");
        const QString s1 = setup(host);
        server->handle(host, "clientmove", {{"cid", 2}});
        QCOMPARE(notes(viewer, "notifystreamstopped")[0].value("streamIdentifier").toString(), s1);
        const QString s2 = setup(host);
        server->disconnect(host);
        QCOMPARE(notes(viewer, "notifystreamstopped")[1].value("streamIdentifier").toString(), s2);
        QCOMPARE(server->streamCount(), 0);
    }

    void joinRequiresSameChannel()
    {
        useThreeChannels();
        const int host = login("host"), viewer = login("viewer");
        const QString sid = setup(host);
        server->handle(viewer, "clientmove", {{"cid", 3}});
        QCOMPARE(expectError(viewer, "joinstreamrequest", {{"streamIdentifier", sid}}), rc::NotInChannel);
    }

    void thumbnailOnlyWhenPublic()
    {
        const int host = login("host"), viewer = login("viewer");
        const QString sid = setup(host, {{"access", int(StreamAccess::Private)}});
        const QString thumb = QStringLiteral("data:image/jpeg;base64,AAAA");
        QVERIFY(!server->handle(host, "streamthumbnail", {{"streamIdentifier", sid}, {"thumbnail", thumb}}).value("published").toBool());
        server->handle(host, "updatestream", {{"streamIdentifier", sid}, {"access", int(StreamAccess::Public)}});
        QVERIFY(server->handle(host, "streamthumbnail", {{"streamIdentifier", sid}, {"thumbnail", thumb}}).value("published").toBool());
        QCOMPARE(notes(viewer, "notifystreamthumbnail")[0].value("thumbnail").toString(), thumb);
    }

    void sfuRejectedWithoutRelay()
    {
        const int host = login("host");
        QCOMPARE(expectError(host, "setupstream", {{"mode", 2}}), rc::ModeNotSupported);
        QCOMPARE(expectError(host, "setupstream", {{"mode", 7}}), rc::ModeNotSupported);
        // Sem relay, só STREAM_P2P é anunciado.
        const int other = server->connect();
        const QJsonObject view = server->handle(other, "login", {{"nickname", "x"}, {"uid", "uid-x"}});
        QCOMPARE(view.value("server").toObject().value("capabilityExtensions").toArray(), (QJsonArray{CapStreamP2P, CapProfiles, CapProfileMedia}));
    }

    // ------------------------------------------------------------ modo SFU

    void sfuCapabilityAndSetup()
    {
        FakeRelay relay;
        server->setRelay(&relay);
        const int host = server->connect();
        const QJsonObject view = server->handle(host, "login", {{"nickname", "host"}, {"uid", "uid-host"}});
        QCOMPARE(view.value("server").toObject().value("capabilityExtensions").toArray(), (QJsonArray{CapStreamP2P, CapProfiles, CapProfileMedia, CapStreamSFU, CapStreamSimulcast}));

        const QString sid = setup(host, {{"mode", int(StreamMode::SFU)}, {"bitrate", 2'000'000}});
        QCOMPARE(relay.calls, QStringList{QStringLiteral("open %1 %2 2000000").arg(sid).arg(host)});
        server->handle(host, "updatestream", {{"streamIdentifier", sid}, {"bitrate", 1'000'000}});
        QCOMPARE(relay.calls.last(), QStringLiteral("update %1 1000000").arg(sid));

        // P2P continua disponível e não toca no relay.
        relay.calls.clear();
        setup(host);
        QVERIFY(relay.calls.isEmpty());
    }

    void sfuJoinUsesRelayPeer()
    {
        FakeRelay relay;
        server->setRelay(&relay);
        const int host = login("host"), viewer = login("viewer");
        const QString sid = setup(host, {{"mode", int(StreamMode::SFU)}, {"access", int(StreamAccess::Private)}});
        const QString p2p = setup(host);
        relay.calls.clear();

        server->handle(viewer, "joinstreamrequest", {{"streamIdentifier", sid}});
        QVERIFY(relay.calls.isEmpty()); // pedido pendente ainda não é espectador
        server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", viewer}, {"accept", true}});
        const QJsonObject resp = notes(viewer, "notifyrespondjoinstreamrequest")[0];
        QCOMPARE(resp.value("peerClid").toInt(-1), RelayClid);
        QCOMPARE(resp.value("ownerClid").toInt(), host);
        // O dono continua sabendo quem assiste (lista de espectadores).
        QCOMPARE(notes(host, "notifystreamclientjoined")[0].value("clid").toInt(), viewer);
        QCOMPARE(relay.calls, QStringList{QStringLiteral("add %1 %2").arg(sid).arg(viewer)});

        // P2P: peerClid = dono.
        server->handle(viewer, "joinstreamrequest", {{"streamIdentifier", p2p}});
        server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", p2p}, {"clid", viewer}, {"accept", true}});
        QCOMPARE(notes(viewer, "notifyrespondjoinstreamrequest")[1].value("peerClid").toInt(), host);
    }

    void sfuWebSocketViewer()
    {
        FakeRelay relay;
        server->setRelay(&relay);
        const int host = login("host"), viewer = login("viewer"), other = login("other");
        const QString sid = setup(host, {{"mode", int(StreamMode::SFU)}});
        const QString p2p = setup(host);
        relay.calls.clear();

        // Sem WebRTC só dá para assistir pelo relay.
        QCOMPARE(expectError(viewer, "joinstreamrequest", {{"streamIdentifier", p2p}, {"transport", "websocket"}}), rc::ModeNotSupported);

        server->handle(viewer, "joinstreamrequest", {{"streamIdentifier", sid}, {"transport", "websocket"}});
        server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", viewer}, {"accept", true}});
        QCOMPARE(notes(viewer, "notifyrespondjoinstreamrequest")[0].value("transport").toString(), QStringLiteral("websocket"));
        QCOMPARE(relay.calls, QStringList{QStringLiteral("addws %1 %2").arg(sid).arg(viewer)});
        server->handle(viewer, "streamsignaling", {{"streamIdentifier", sid}, {"clid", RelayClid}, {"payload", QJsonObject{{"type", "keyframe"}}}});
        QCOMPARE(relay.calls.last(), QStringLiteral("signal %1 %2 keyframe").arg(sid).arg(viewer));
        server->handle(viewer, "removeclientfromstream", {{"streamIdentifier", sid}});
        QCOMPARE(relay.calls.last(), QStringLiteral("remove %1 %2").arg(sid).arg(viewer));

        // Relay sem o transporte: o espectador sai como falha.
        relay.webSocketViewers = false;
        server->handle(other, "joinstreamrequest", {{"streamIdentifier", sid}, {"transport", "websocket"}});
        server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", other}, {"accept", true}});
        QCOMPARE(notes(other, "notifystreamclientleft").last().value("reason").toInt(), int(LeaveReason::Failed));
    }

    void sfuSignalingRoutesThroughRelay()
    {
        FakeRelay relay;
        server->setRelay(&relay);
        const int host = login("host"), viewer = login("viewer"), stranger = login("stranger");
        const QString sid = setup(host, {{"mode", int(StreamMode::SFU)}});
        const QJsonObject offer{{"type", "offer"}, {"sdp", "v=0"}};

        // Transmissor -> relay.
        server->handle(host, "streamsignaling", {{"streamIdentifier", sid}, {"clid", RelayClid}, {"payload", offer}});
        QCOMPARE(relay.calls.last(), QStringLiteral("signal %1 %2 offer").arg(sid).arg(host));

        // Quem não foi aceito não fala com o relay.
        server->handle(viewer, "joinstreamrequest", {{"streamIdentifier", sid}});
        QCOMPARE(expectError(viewer, "streamsignaling", {{"streamIdentifier", sid}, {"clid", RelayClid}, {"payload", offer}}),
                 rc::PermissionDenied);
        QCOMPARE(expectError(stranger, "streamsignaling", {{"streamIdentifier", sid}, {"clid", RelayClid}, {"payload", offer}}),
                 rc::PermissionDenied);

        server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", viewer}, {"accept", true}});
        const QJsonObject answer{{"type", "answer"}, {"sdp", "v=0"}};
        server->handle(viewer, "streamsignaling", {{"streamIdentifier", sid}, {"clid", RelayClid}, {"payload", answer}});
        QCOMPARE(relay.calls.last(), QStringLiteral("signal %1 %2 answer").arg(sid).arg(viewer));

        // No SFU dono e espectador não trocam sinalização diretamente.
        QCOMPARE(expectError(host, "streamsignaling", {{"streamIdentifier", sid}, {"clid", viewer}, {"payload", offer}}),
                 rc::PermissionDenied);
        QCOMPARE(expectError(viewer, "streamsignaling", {{"streamIdentifier", sid}, {"clid", host}, {"payload", answer}}),
                 rc::PermissionDenied);

        // Relay -> clientes, com clid 0; nunca para quem não participa.
        relay.signal(sid, viewer, offer);
        relay.signal(sid, host, answer);
        relay.signal(sid, stranger, offer);
        const auto toViewer = notes(viewer, "notifystreamsignaling");
        QCOMPARE(toViewer.size(), 1);
        QCOMPARE(toViewer[0].value("clid").toInt(-1), RelayClid);
        QCOMPARE(toViewer[0].value("payload").toObject().value("type").toString(), QStringLiteral("offer"));
        QCOMPARE(notes(host, "notifystreamsignaling").size(), 1);
        QVERIFY(notes(stranger, "notifystreamsignaling").isEmpty());

        // Em stream P2P o clid 0 não existe.
        const QString p2p = setup(host);
        QCOMPARE(expectError(host, "streamsignaling", {{"streamIdentifier", p2p}, {"clid", RelayClid}, {"payload", offer}}),
                 rc::PermissionDenied);
    }

    void sfuLifecycleNotifiesRelay()
    {
        FakeRelay relay;
        server->setRelay(&relay);
        const int host = login("host"), a = login("a"), b = login("b"), c = login("c");
        const QString sid = setup(host, {{"mode", int(StreamMode::SFU)}});
        for (int v : {a, b, c}) {
            server->handle(v, "joinstreamrequest", {{"streamIdentifier", sid}});
            server->handle(host, "respondjoinstreamrequest", {{"streamIdentifier", sid}, {"clid", v}, {"accept", true}});
        }
        relay.calls.clear();

        server->handle(a, "removeclientfromstream", {{"streamIdentifier", sid}});
        QCOMPARE(relay.calls.last(), QStringLiteral("remove %1 %2").arg(sid).arg(a));
        server->handle(host, "removeclientfromstream", {{"streamIdentifier", sid}, {"clid", b}, {"reason", int(LeaveReason::Banned)}});
        QCOMPARE(relay.calls.last(), QStringLiteral("remove %1 %2").arg(sid).arg(b));
        QCOMPARE(expectError(b, "joinstreamrequest", {{"streamIdentifier", sid}}), rc::Banned);

        // Falha do egress no relay: espectador sai com Failed.
        relay.failed(sid, c);
        QCOMPARE(notes(c, "notifystreamclientleft").last().value("reason").toInt(), int(LeaveReason::Failed));
        QCOMPARE(relay.calls.last(), QStringLiteral("remove %1 %2").arg(sid).arg(c));

        // Desconectar o dono encerra o stream no relay.
        server->disconnect(host);
        QCOMPARE(relay.calls.last(), QStringLiteral("close %1").arg(sid));
        QCOMPARE(server->streamCount(), 0);
    }

    void sfuIngestFailureStopsStream()
    {
        FakeRelay relay;
        server->setRelay(&relay);
        const int host = login("host"), viewer = login("viewer");
        const QString sid = setup(host, {{"mode", int(StreamMode::SFU)}});
        relay.failed(sid, host);
        QCOMPARE(server->streamCount(), 0);
        QCOMPARE(notes(viewer, "notifystreamstopped")[0].value("streamIdentifier").toString(), sid);
        QCOMPARE(relay.calls.last(), QStringLiteral("close %1").arg(sid));
    }

    void suspendKeepsResumableClientAndPausesStreams()
    {
        const int host = server->connect();
        const auto data = server->handle(host, "login", {{"nickname", "host"}, {"uid", "uid-host"}, {"resumable", true}});
        const QString token = data.value("resumeToken").toString();
        QVERIFY(token.size() >= 32);
        const int viewer = login("viewer");
        QVERIFY(!server->suspend(viewer)); // sem `resumable`: desconecta como antes
        const int other = login("other");
        const QString sid = setup(host);
        inbox.clear();

        QVERIFY(server->suspend(host));
        QCOMPARE(server->streamCount(), 1);
        QVERIFY(notes(other, "notifystreamupdated").last().value("stream").toObject().value("paused").toBool());
        QVERIFY(notes(other, "notifyclientupdated").last().value("client").toObject().value("away").toBool());
        QVERIFY(notes(other, "notifyclientleftview").isEmpty());

        try {
            server->resume(host, "forjado");
            QFAIL("token falso aceito");
        } catch (const CommandError &e) {
            QCOMPARE(e.code, rc::SessionExpired);
        }
        const auto view = server->resume(host, token);
        QCOMPARE(view.value("clid").toInt(), host);
        QVERIFY(view.value("resumed").toBool());
        QCOMPARE(view.value("streams").toArray().size(), 1);
        QVERIFY(!view.value("streams").toArray()[0].toObject().value("paused").toBool());
        QVERIFY(!notes(other, "notifystreamupdated").last().value("stream").toObject().value("paused").toBool());
        QCOMPARE(server->handle(host, "sync", {}).value("clid").toInt(), host);
        QCOMPARE(server->handle(host, "heartbeat", {}), QJsonObject{});

        // A espera acabou (disconnect): agora sim sai e o stream acaba.
        server->suspend(host);
        server->disconnect(host);
        QCOMPARE(server->streamCount(), 0);
        QCOMPARE(notes(other, "notifystreamstopped").last().value("streamIdentifier").toString(), sid);
        try {
            server->resume(host, token);
            QFAIL("sessão removida retomada");
        } catch (const CommandError &e) {
            QCOMPARE(e.code, rc::SessionExpired);
        }
    }
};

QTEST_GUILESS_MAIN(TestVirtualServer)
#include "tst_virtualserver.moc"
