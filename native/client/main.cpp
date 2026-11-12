// OpenSpeak — cliente nativo (Qt Quick + libdatachannel + FFmpeg).
//
//   OpenSpeak.exe [--profile nome] [--debug] [--server ws://host:9988/ws] [--nickname Nome]
//
// --profile separa identidade/configurações (duas instâncias na mesma máquina).
// --debug   habilita a fonte "Padrão de teste" no diálogo de transmissão.

#include "ClientLog.h"
#include "ConnectionHandler.h"
#include "Layout.h"
#include "PeerDirectory.h"
#include "ScreenshareManager.h"
#include "Settings.h"
#include "SourceThumbnails.h"
#include "WindowThumbnail.h"
#include "AutoUpdater.h"
#include "TrayIcon.h"
#include "NativeWindow.h"
#include "NvidiaProfile.h"
#include "SoundEffects.h"
#include "Version.h"

#include <QApplication>
#include <QCommandLineParser>
#include <QElapsedTimer>
#include <QFile>
#include <QIcon>
#include <QLocalServer>
#include <QLocalSocket>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QStyleHints>
#include <QQuickWindow>
#include <QQuickItem>
#include <QTimer>
#ifdef Q_OS_WIN
#include <windows.h>
#include <shobjidl_core.h>
#endif

using namespace openspeak;

static QQuickItem *findVisualItem(QQuickItem *root, const QString &name)
{
    if (root->objectName() == name) return root;
    for (auto *child : root->childItems())
        if (auto *found = findVisualItem(child, name)) return found;
    return nullptr;
}

int main(int argc, char *argv[])
{
#ifdef Q_OS_WIN
    // Sem identidade própria, a barra de tarefas mostra o ícone do .exe/atalho em
    // vez do ícone da janela, que acompanha o tema.
    SetCurrentProcessExplicitAppUserModelID(L"OpenSpeak.Client");
#endif
    // QApplication (e não QGuiApplication) por causa do menu do ícone na bandeja.
    QApplication app(argc, argv);
    QGuiApplication::setApplicationName(QStringLiteral("OpenSpeak"));
    QGuiApplication::setOrganizationName(QStringLiteral("OpenSpeak"));
    QGuiApplication::setApplicationVersion(openspeak::version());
    QGuiApplication::setWindowIcon(QIcon(QStringLiteral(":/assets/openspeak.ico")));
    QQuickStyle::setStyle(QStringLiteral("FluentWinUI3"));
    QGuiApplication::styleHints()->setColorScheme(Qt::ColorScheme::Dark);

    QCommandLineParser parser;
    parser.addHelpOption();
    QCommandLineOption profileOpt(QStringLiteral("profile"), QStringLiteral("Perfil de configurações."), QStringLiteral("nome"));
    QCommandLineOption debugOpt(QStringLiteral("debug"), QStringLiteral("Habilita a fonte de teste."));
    QCommandLineOption serverOpt(QStringLiteral("server"), QStringLiteral("URL do servidor."), QStringLiteral("url"));
    QCommandLineOption nickOpt(QStringLiteral("nickname"), QStringLiteral("Apelido."), QStringLiteral("nome"));
    QCommandLineOption autoOpt(QStringLiteral("autoconnect"), QStringLiteral("Conecta ao abrir."));
    // Depuração: salva capturas da janela e inicia um stream de teste sozinho.
    QCommandLineOption shotOpt(QStringLiteral("screenshot"), QStringLiteral("Salva capturas da janela (prefixo)."), QStringLiteral("arquivo"));
    QCommandLineOption autoStreamOpt(QStringLiteral("autostream"), QStringLiteral("Inicia um stream de teste (requer --debug)."));
    QCommandLineOption meshPortOpt(QStringLiteral("mesh-port"), QStringLiteral("Porta da malha na tailnet (padrão 9987)."), QStringLiteral("porta"));
    QCommandLineOption openOpt(QStringLiteral("open"), QStringLiteral("Abre um painel ao iniciar: setup | setup-windows | setup-cameras | source | settings | stats | viewers | pip."), QStringLiteral("painel"));
    QCommandLineOption autoJoinOpt(QStringLiteral("autojoin"), QStringLiteral("Assiste ao primeiro stream do canal."));
    QCommandLineOption uiSmokeOpt(QStringLiteral("ui-smoke-test"), QStringLiteral("Valida o layout QML em 900x560 e encerra (sem conectar)."));
    QCommandLineOption cloudOpt(QStringLiteral("cloud"), QStringLiteral("Conecta à sala web pública."));
    QCommandLineOption quitOpt(QStringLiteral("quit-after"), QStringLiteral("Encerra o teste após N segundos (requer --debug)."), QStringLiteral("segundos"));
    QCommandLineOption updateOpt(QStringLiteral("apply-update"), QStringLiteral("Auxiliar interno de atualização."), QStringLiteral("arquivo"));
    QCommandLineOption digestOpt(QStringLiteral("update-sha256"), QStringLiteral("SHA-256 do instalador."), QStringLiteral("hash"));
    QCommandLineOption waitPidOpt(QStringLiteral("wait-pid"), QStringLiteral("Processo que precisa encerrar antes da atualização."), QStringLiteral("pid"));
    QCommandLineOption restartOpt(QStringLiteral("restart-after-update"), QStringLiteral("Reabre o app após atualização solicitada."));
    QCommandLineOption afterUpdateOpt(QStringLiteral("after-update"), QStringLiteral("Aberto pelo instalador ao fim da atualização."));
    QCommandLineOption autostartOpt(QStringLiteral("autostart"), QStringLiteral("Aberto pelo Windows ao entrar na conta."));
    QCommandLineOption gsyncOpt(QStringLiteral("gsync-off"), QStringLiteral("Só desliga o G-Sync no perfil NVIDIA do app e encerra (0 = desligado, 3 = já estava, 2 = sem NVIDIA, 1 = erro)."));
    parser.addOptions({gsyncOpt, profileOpt, debugOpt, serverOpt, nickOpt, autoOpt, shotOpt, autoStreamOpt, autoJoinOpt, openOpt, meshPortOpt, uiSmokeOpt, cloudOpt, quitOpt, updateOpt, digestOpt, waitPidOpt, restartOpt, afterUpdateOpt, autostartOpt});
    parser.process(app);
    if (parser.isSet(updateOpt))
        return AutoUpdater::runInstallHelper(parser.value(updateOpt), parser.value(digestOpt), parser.value(waitPidOpt).toUInt(), parser.isSet(restartOpt));
    if (parser.isSet(gsyncOpt)) {
        const GsyncResult r = disableGsyncForThisApp();
        // 0 = desligado agora, 3 = já estava, 2 = sem NVIDIA, 1 = falhou.
        return r.status == GsyncResult::Failed ? 1 : r.status == GsyncResult::NoNvidia ? 2
             : r.status == GsyncResult::AlreadyOff ? 3 : 0;
    }
#ifdef Q_OS_WIN
    // O instalador segura este mutex (SetupMutex) enquanto roda. Aberto no meio da
    // atualização, o app não usaria arquivos pela metade nem dispararia outra instalação.
    if (!parser.isSet(afterUpdateOpt)) {
        if (HANDLE setup = OpenMutexW(SYNCHRONIZE, FALSE, L"OpenSpeakSetupMutex")) {
            CloseHandle(setup);
            MessageBoxW(nullptr, L"O OpenSpeak está sendo atualizado e vai abrir sozinho quando a instalação terminar.",
                        L"OpenSpeak", MB_OK | MB_ICONINFORMATION);
            return 0;
        }
    }
#endif

    // Uma instância por perfil: abrir de novo (atalho, menu Iniciar) só traz de volta a
    // janela que está na bandeja. Depuração e testes podem abrir várias.
    const bool singleInstance = !parser.isSet(debugOpt) && !parser.isSet(uiSmokeOpt) && !parser.isSet(shotOpt);
    const QString instanceName = QStringLiteral("OpenSpeak-%1-%2")
        .arg(qEnvironmentVariable("USERNAME"), parser.value(profileOpt).isEmpty() ? QStringLiteral("default") : parser.value(profileOpt));
    if (singleInstance) {
        QLocalSocket other;
        other.connectToServer(instanceName);
        if (other.waitForConnected(500)) {
#ifdef Q_OS_WIN
            AllowSetForegroundWindow(ASFW_ANY);
#endif
            other.write(parser.isSet(autostartOpt) ? "autostart" : "show");
            other.waitForBytesWritten(500);
            other.disconnectFromServer();
            return 0;
        }
    }

    // Com G-Sync em janela, o driver NVIDIA faz o monitor seguir os quadros da UI e a tela pisca.
    if (!parser.isSet(uiSmokeOpt))
        disableGsyncInBackground();
    // Registros em arquivo (e para o servidor, abaixo) desde o começo.
    if (!parser.isSet(uiSmokeOpt)) // os testes de interface não enchem a pasta do usuário
        ClientLog::install(parser.value(profileOpt));
    qInfo().noquote() << "OpenSpeak" << openspeak::version() << "iniciado";
    Settings settings(parser.value(profileOpt), parser.isSet(debugOpt));
    settings.refreshLaunchAtStartup();
    // A janela pode ficar escondida na bandeja; quem encerra é o "Sair" (Main.qml).
    QApplication::setQuitOnLastWindowClosed(false);
    AutoUpdater updater(&settings);
    if (parser.isSet(uiSmokeOpt))
        updater.setAutomaticChecks(false); // cada build roda vários; não gasta o limite da API do GitHub
    if (!parser.isSet(debugOpt) && !parser.isSet(uiSmokeOpt))
        QObject::connect(&app, &QCoreApplication::aboutToQuit, &updater, &AutoUpdater::installOnExit);
    if (parser.isSet(uiSmokeOpt)) settings.setAdvancedMode(true);
    if (parser.isSet(serverOpt)) {
        settings.setServerUrl(parser.value(serverOpt));
        settings.setConnectionMode(QStringLiteral("server"));
    }
    // Primeira abertura depois de uma atualização: avisa e oferece as novidades.
    const bool updated = settings.markVersionSeen(openspeak::version());
    if (parser.isSet(nickOpt))
        settings.setNickname(parser.value(nickOpt));
    ConnectionHandler handler;
    // Edição lite: só cliente do servidor (streams P2P ou SFU), sem Tailscale nem sala web.
    const bool lite = updater.edition() == QLatin1String("lite");
    if (!lite) {
        // Modos avançados: descoberta dos pares pela tailnet (sem servidor).
        const quint16 meshPort = parser.isSet(meshPortOpt) ? quint16(parser.value(meshPortOpt).toUInt()) : MeshConnection::DefaultPort;
        handler.setDirectory(new TailscaleDirectory(meshPort, &handler));
    }
    ClientLog logUploader(&handler, openspeak::version(), [&settings] { return settings.sendLogs(); });
    ScreenshareManager screenshare(&handler, &settings);
    SoundEffects sounds(&handler, &screenshare, &settings);
    QObject::connect(&app, &QCoreApplication::aboutToQuit, &handler, &ConnectionHandler::disconnectFromServer);
    if (parser.isSet(quitOpt) && settings.debug())
        QTimer::singleShot(qBound(1, parser.value(quitOpt).toInt(), 3600) * 1000, &app, &QCoreApplication::quit);
    StreamLayout layout;
    SourceThumbnails sourceThumbnails;
    TrayIcon tray;
    NativeWindow nativeWindow;
    QLocalServer instanceServer;
    if (singleInstance) {
        QLocalServer::removeServer(instanceName);
        instanceServer.listen(instanceName);
        QObject::connect(&instanceServer, &QLocalServer::newConnection, &tray, [&] {
            while (QLocalSocket *client = instanceServer.nextPendingConnection()) {
                QObject::connect(client, &QLocalSocket::disconnected, client, &QObject::deleteLater);
                QObject::connect(client, &QLocalSocket::readyRead, &tray, [&tray, client] {
                    if (client->readAll().startsWith("show"))
                        emit tray.openRequested();
                });
            }
        });
    }

    QQmlApplicationEngine engine;
    qmlRegisterType<WindowThumbnail>("OpenSpeak.Native", 1, 0, "WindowThumbnail");
    engine.rootContext()->setContextProperty(QStringLiteral("Settings"), &settings);
    engine.rootContext()->setContextProperty(QStringLiteral("Updater"), &updater);
    engine.rootContext()->setContextProperty(QStringLiteral("Server"), &handler);
    engine.rootContext()->setContextProperty(QStringLiteral("Screenshare"), &screenshare);
    engine.rootContext()->setContextProperty(QStringLiteral("StreamLayout"), &layout);
    engine.rootContext()->setContextProperty(QStringLiteral("SourceThumbnails"), &sourceThumbnails);
    engine.rootContext()->setContextProperty(QStringLiteral("AutoConnect"), parser.isSet(autoOpt) && !parser.isSet(cloudOpt));
    engine.rootContext()->setContextProperty(QStringLiteral("DebugOpen"), parser.value(openOpt));
    engine.rootContext()->setContextProperty(QStringLiteral("UiSmoke"), parser.isSet(uiSmokeOpt));
    engine.rootContext()->setContextProperty(QStringLiteral("LiteEdition"), lite);
    engine.rootContext()->setContextProperty(QStringLiteral("Tray"), &tray);
    engine.rootContext()->setContextProperty(QStringLiteral("Sounds"), &sounds);
    engine.rootContext()->setContextProperty(QStringLiteral("NativeWindow"), &nativeWindow);
    QString changelog;
    if (QFile f(QStringLiteral(":/changelog.md")); f.open(QIODevice::ReadOnly))
        changelog = QString::fromUtf8(f.readAll());
    engine.rootContext()->setContextProperty(QStringLiteral("Changelog"), changelog);
    QString licenses;
    if (QFile f(QStringLiteral(":/licenses.md")); f.open(QIODevice::ReadOnly))
        licenses = QString::fromUtf8(f.readAll());
    engine.rootContext()->setContextProperty(QStringLiteral("ThirdPartyLicenses"), licenses);
    engine.rootContext()->setContextProperty(QStringLiteral("JustUpdated"), updated && !parser.isSet(uiSmokeOpt));
    // Aberto pelo Windows com "Iniciar minimizado": só o ícone na bandeja.
    engine.rootContext()->setContextProperty(QStringLiteral("StartHidden"),
        parser.isSet(autostartOpt) && settings.startMinimized() && tray.available() && !parser.isSet(uiSmokeOpt));
    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed, &app, [] { QCoreApplication::exit(1); },
                     Qt::QueuedConnection);
    engine.loadFromModule(QStringLiteral("OpenSpeak"), QStringLiteral("Main"));

    if (parser.isSet(uiSmokeOpt)) {
        auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().value(0));
        if (!window) return 1;
        window->resize(900, 560);
        // Valida até dar certo em duas leituras seguidas; em vez de esperar o prazo inteiro, sai assim que estabiliza.
        auto *smokePoll = new QTimer(&app);
        smokePoll->setInterval(100);
        QElapsedTimer smokeClock;
        smokeClock.start();
        QObject::connect(smokePoll, &QTimer::timeout, &app, [&app, &engine, window, smokePoll, smokeClock, stable = 0, panel = parser.value(openOpt)]() mutable {
            bool valid = true;
            if (panel.startsWith("login")) {
                auto *connectButton = findVisualItem(window->contentItem(), QStringLiteral("serverConnectButton"));
                auto *advanced = findVisualItem(window->contentItem(), QStringLiteral("advancedOptions"));
                auto *address = findVisualItem(window->contentItem(), QStringLiteral("changeServerButton"));
                valid = valid && connectButton && connectButton->isVisible() && address && address->isVisible()
                    && advanced && advanced->isVisible() == (panel == "login-advanced");
            } else if (panel == "profile-card") {
                auto *name = findVisualItem(window->contentItem(), QStringLiteral("profileCardName"));
                valid = valid && name && name->isVisible() && name->width() > 100;
            } else if (panel == "avatar-crop") {
                auto *view = findVisualItem(window->contentItem(), QStringLiteral("avatarCropView"));
                auto *save = findVisualItem(window->contentItem(), QStringLiteral("avatarCropSave"));
                valid = valid && view && view->isVisible() && view->width() == 280 && save && save->isEnabled();
            } else if (panel == "startup") {
                auto *startup = findVisualItem(window->contentItem(), QStringLiteral("startupScreen"));
                valid = valid && startup && startup->isVisible() && startup->width() >= 800;
            } else if (panel == "update-notes") {
                auto *dialog = window->findChild<QObject *>(QStringLiteral("changelogDialog"));
                auto *text = findVisualItem(window->contentItem(), QStringLiteral("changelogText"));
                auto *toggle = findVisualItem(window->contentItem(), QStringLiteral("changelogToggle"));
                valid = valid && dialog && dialog->property("visible").toBool()
                    && dialog->property("height").toDouble() < window->height()
                    && text && text->height() > 20 && toggle && toggle->isVisible();
            } else if (panel == "updates" || panel == "preferences" || panel == "profile" || panel == "changelog" || panel == "licenses") {
                // Atualizações, novidades e licenças são páginas das Preferências.
                auto *dialog = window->findChild<QObject *>(QStringLiteral("preferencesDialog"));
                valid = valid && dialog && dialog->property("visible").toBool()
                    && dialog->property("width").toDouble() >= 400
                    && dialog->property("height").toDouble() < window->height();
                if (panel == "changelog")
                    valid = valid && engine.rootContext()->contextProperty(QStringLiteral("Changelog")).toString()
                                         .startsWith(QStringLiteral("# OpenSpeak "));
                if (panel != "preferences")
                    valid = valid && dialog->property("page").toString()
                                         == (panel == "licenses"  ? QStringLiteral("about")
                                             : panel == "profile" ? QStringLiteral("profile")
                                                                  : QStringLiteral("updates"));
                if (panel == "licenses")
                    valid = valid && engine.rootContext()->contextProperty(QStringLiteral("ThirdPartyLicenses")).toString()
                                         .contains(QStringLiteral("libdatachannel"));
            } else if (panel != "view-menu") {
                auto *grid = findVisualItem(window->contentItem(), QStringLiteral("sourceGrid"));
                valid = valid && grid && grid->isVisible() && grid->height() >= 120 && grid->width() >= 200;
                if (panel == "setup") {
                    auto *fps = findVisualItem(window->contentItem(), QStringLiteral("fps60"));
                    auto *settingsPane = findVisualItem(window->contentItem(), QStringLiteral("settingsPane"));
                    valid = valid && fps && settingsPane && fps->width() >= 30;
                    if (fps && settingsPane) {
                        valid = valid && fps->mapToItem(settingsPane, QPointF(fps->width(), 0)).x() <= settingsPane->width() + 1;
                        qInfo() << "UI layout:" << "grid" << (grid ? grid->size() : QSizeF()) << "FPS" << fps->width()
                                << "right edge" << fps->mapToItem(settingsPane, QPointF(fps->width(), 0)).x()
                                << "settings width" << settingsPane->width();
                    } else qWarning() << "Missing FPS control or settings pane" << fps << settingsPane;
                }
            } else {
                auto *menu = window->findChild<QObject *>(QStringLiteral("viewMenu"));
                valid = valid && menu && menu->property("visible").toBool() && menu->property("width").toDouble() >= 250;
            }
            valid = valid && !window->grabWindow().isNull();
            stable = valid ? stable + 1 : 0;
            if (stable < 2 && !smokeClock.hasExpired(4500))
                return;
            smokePoll->stop();
            if (!valid) qCritical("UI smoke test failed: preview grid, FPS controls, or menu do not fit.");
            app.exit(valid ? 0 : 1);
        });
        smokePoll->start();
    }

    if (parser.isSet(autoStreamOpt) && settings.debug()) {
        QObject::connect(&handler, &ConnectionHandler::connectionChanged, &screenshare, [&] {
            if (!handler.isConnected())
                return;
            QTimer::singleShot(500, &screenshare, [&] {
                // OPENSPEAK_AUTOSOURCE=screen usa a Tela 1 em vez do padrão de teste.
                if (qgetenv("OPENSPEAK_AUTOSOURCE") == "screen")
                    screenshare.openPreview({{"type", 2}, {"id", "0"}}, 30);
                else
                    screenshare.openPreview({{"type", 2}, {"id", "test"}, {"test", true}}, 30);
                screenshare.startStream({{"name", "Padrão de teste"}, {"access", 1}, {"audio", qgetenv("OPENSPEAK_AUTOAUDIO") == "1"}, {"bitrate", 3'000'000},
                                         {"width", 1280}, {"height", 720}, {"fps", 30}});
            });
        });
    }
    if (parser.isSet(autoJoinOpt)) {
        QObject::connect(&handler, &ConnectionHandler::streamAdded, &screenshare, [&](const QString &id) {
            QTimer::singleShot(300, &screenshare, [&, id] { screenshare.joinStream(id); });
        });
        QObject::connect(&handler, &ConnectionHandler::connectionChanged, &screenshare, [&] {
            if (handler.isConnected() && !handler.streams().isEmpty())
                screenshare.joinStream(handler.streams().firstKey());
        });
    }
    if (parser.isSet(cloudOpt) && !lite) {
        auto *directory = handler.directory();
        auto *cloudTimer = new QTimer(&app);
        cloudTimer->setInterval(500);
        QObject::connect(cloudTimer, &QTimer::timeout, &app, [&, directory, cloudTimer] {
            if (updater.startupBusy()) return;
            if (directory->status() != PeerDirectory::Status::Running) return;
            cloudTimer->stop();
            handler.connectCloud(settings.nickname(), settings.uid());
        });
        cloudTimer->start();
    }
    if (parser.isSet(shotOpt)) {
        const QString prefix = parser.value(shotOpt);
        auto *timer = new QTimer(&app);
        int shot = 0;
        QObject::connect(timer, &QTimer::timeout, &app, [&engine, prefix, shot]() mutable {
            ++shot;
            if (auto *w = qobject_cast<QQuickWindow *>(engine.rootObjects().value(0)))
                w->grabWindow().save(QStringLiteral("%1-%2.png").arg(prefix).arg(shot));
            // Janelas extras visíveis (tela cheia, picture-in-picture).
            int extra = 0;
            for (QWindow *top : QGuiApplication::topLevelWindows())
                if (auto *q = qobject_cast<QQuickWindow *>(top); q && q->isVisible() && q != engine.rootObjects().value(0))
                    q->grabWindow().save(QStringLiteral("%1-%2-w%3.png").arg(prefix).arg(shot).arg(++extra));
        });
        timer->start(4000);
    }
    const int code = app.exec();
    qInfo() << "OpenSpeak encerrando";
    ClientLog::uninstall(); // antes dos estáticos irem embora
    return code;
}
