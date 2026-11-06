import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "I18n.js" as I18n

ApplicationWindow {
    id: window
    width: 1360
    height: 840
    minimumWidth: 900
    minimumHeight: 560
    // Aberto pelo Windows com "Iniciar minimizado na bandeja": começa escondido.
    visible: !StartHidden
    title: Server.connected ? "OpenSpeak — " + Server.serverName : "OpenSpeak"
    color: Theme.background
    // Controles do FluentWinUI3 (caixas, sliders, foco) seguem a cor de destaque do tema.
    palette.accent: Theme.accent
    Binding { target: Theme; property: "name"; value: Settings.theme }
    Binding { target: Theme; property: "accentName"; value: Settings.accentColor }
    Binding { target: Application.styleHints; property: "colorScheme"; value: Theme.light ? Qt.Light : Qt.Dark }
    Connections {
        target: Theme
        function onAccentChanged() { NativeWindow.setLinkColor(Theme.accent) }
    }
    // Sem moldura, mas com WS_SYSMENU/WS_MINIMIZEBOX: sem eles o Windows ignora o
    // clique no ícone da barra de tarefas e não minimiza o app.
    flags: Qt.Window | Qt.FramelessWindowHint | Qt.WindowSystemMenuHint | Qt.WindowMinimizeButtonHint

    header: Rectangle {
        height: 34
        color: Theme.contrast
        MouseArea {
            anchors.fill: parent
            anchors.rightMargin: 246
            // Maximizada: o arrasto só começa depois de alguns pixels, restaurando a
            // janela sob o cursor (como no Windows); assim o duplo clique continua livre.
            property point pressPoint
            property bool fromMaximized: false
            onPressed: mouse => {
                fromMaximized = window.visibility === Window.Maximized
                pressPoint = Qt.point(mouse.x, mouse.y)
                if (!fromMaximized) window.startSystemMove()
            }
            onPositionChanged: mouse => {
                if (!fromMaximized || !pressed) return
                if (Math.abs(mouse.x - pressPoint.x) + Math.abs(mouse.y - pressPoint.y) < 6) return
                fromMaximized = false
                const ratio = mouse.x / width
                const cursor = mapToGlobal(mouse.x, mouse.y)
                window.showNormal()
                window.x = Math.round(cursor.x - ratio * window.width)
                window.y = Math.round(cursor.y - mouse.y)
                window.startSystemMove()
            }
            onReleased: fromMaximized = false
            onDoubleClicked: window.toggleMaximized()
        }
        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: 12
            spacing: 8
            Icon { name: "logo"; size: 16; color: Theme.accent }
            Label { text: "OpenSpeak"; color: Theme.textDim; font.pixelSize: 12; font.weight: Font.DemiBold }
            Item { Layout.fillWidth: true }
            ToolButton {
                id: repoButton
                objectName: "repoLink"
                Layout.preferredWidth: 36
                Layout.preferredHeight: 34
                Accessible.name: "Repositório do OpenSpeak no GitHub"
                ToolTip.visible: hovered
                ToolTip.text: "Código-fonte no GitHub"
                contentItem: Item {
                    Icon { anchors.centerIn: parent; name: "github"; size: 14; color: repoButton.hovered ? Theme.textDim : Theme.textFaint }
                }
                onClicked: Qt.openUrlExternally("https://github.com/JonasHenriqueDev/OpenSpeak")
            }
            ToolButton {
                Layout.preferredWidth: 36
                Layout.preferredHeight: 34
                Accessible.name: "Atualizações do OpenSpeak"
                ToolTip.visible: hovered
                ToolTip.text: "Atualizações · " + Updater.version
                // Centralizado: como contentItem direto, o ícone estica e fica achatado.
                contentItem: Item { Icon { anchors.centerIn: parent; name: "download"; size: 16 } }
                onClicked: preferencesDialog.openAt("updates")
            }
            ToolButton {
                objectName: "preferencesButton"
                Layout.preferredWidth: 36
                Layout.preferredHeight: 34
                Accessible.name: I18n.t("app.prefs.tooltip")
                ToolTip.visible: hovered
                ToolTip.text: I18n.t("app.prefs.tooltip")
                // Centralizado: como contentItem direto, o ícone estica e fica achatado.
                contentItem: Item { Icon { anchors.centerIn: parent; name: "settings"; size: 16 } }
                onClicked: preferencesDialog.open()
            }
            Repeater {
                model: ["minimize", "maximize", "close"]
                delegate: ToolButton {
                    id: windowButton
                    required property string modelData
                    Layout.preferredWidth: 46
                    Layout.preferredHeight: 34
                    padding: 0
                    Accessible.name: modelData === "minimize" ? "Minimizar" : modelData === "maximize" ? "Maximizar ou restaurar" : "Fechar"
                    background: Rectangle {
                        color: windowButton.hovered ? (windowButton.modelData === "close" ? Theme.danger : Theme.panel3) : "transparent"
                    }
                    contentItem: Item {
                        Rectangle {
                            anchors.centerIn: parent
                            width: 10; height: windowButton.modelData === "minimize" ? 1 : 10
                            visible: windowButton.modelData !== "close"
                            color: windowButton.modelData === "minimize" ? Theme.text : "transparent"
                            border.width: windowButton.modelData === "maximize" ? 1 : 0
                            border.color: Theme.text
                        }
                        Icon { anchors.centerIn: parent; name: "close"; size: 16; visible: windowButton.modelData === "close" }
                    }
                    onClicked: {
                        if (modelData === "minimize") window.showMinimized()
                        else if (modelData === "maximize") window.toggleMaximized()
                        else window.close()
                    }
                }
            }
        }
    }
    function toggleMaximized() {
        if (visibility === Window.Maximized) showNormal()
        else showMaximized()
    }

    // ------------------------------------------------------ bandeja do sistema
    // O X esconde a janela na bandeja (Settings.minimizeToTray); "Sair" encerra de fato.
    property bool quitting: false
    property bool restoreMaximized: false
    onVisibilityChanged: function() {
        if (window.visibility === Window.Maximized) restoreMaximized = true
        else if (window.visibility === Window.Windowed) restoreMaximized = false
    }
    onClosing: function(close) {
        if (quitting) return
        if (Settings.minimizeToTray && Tray.visible) {
            close.accepted = false
            hideToTray()
            return
        }
        quitApp()
    }
    function hideToTray() {
        window.hide()
        if (!Settings.trayNoticeShown) {
            Tray.showMessage(I18n.t("app.tray.notice.title"), I18n.t("app.tray.notice.text"))
            Settings.trayNoticeShown = true
        }
    }
    function showFromTray() {
        if (!window.visible || window.visibility === Window.Minimized) {
            if (restoreMaximized) window.showMaximized()
            else window.showNormal()
        }
        window.raise()
        window.requestActivate()
    }
    function quitApp() {
        quitting = true
        // Encerra as transmissões antes da conexão (aboutToQuit desconecta do servidor).
        Screenshare.stopAllStreams()
        Qt.quit()
    }
    Binding { target: Tray; property: "visible"; value: Tray.available && !UiSmoke }
    Binding { target: Tray; property: "streaming"; value: Screenshare.streaming }
    Binding { target: Tray; property: "audioMuted"; value: Screenshare.audioMuted }
    Binding { target: Tray; property: "soundsMuted"; value: !Settings.soundEffects }
    // Ícone da janela, da barra de tarefas e da bandeja nas cores do tema, sem reiniciar.
    readonly property color appIconColor: Theme.accent
    onAppIconColorChanged: Tray.setThemeColor(Theme.accent)
    Connections {
        target: Tray
        function onOpenRequested() { window.showFromTray() }
        function onMessageClicked() { window.showFromTray() }
        function onStopStreamingRequested() { Screenshare.stopAllStreams() }
        function onToggleMuteRequested() { Screenshare.audioMuted = !Screenshare.audioMuted }
        function onToggleSoundsRequested() { Settings.soundEffects = !Settings.soundEffects }
        function onSettingsRequested() { window.showFromTray(); preferencesDialog.open() }
        function onQuitRequested() { window.quitApp() }
    }
    SettingsDialog {
        id: preferencesDialog
        objectName: "preferencesDialog"
        onQuitRequested: window.quitApp()
        onInstallRequested: installDialog.open()
    }
    ChangelogDialog { id: changelogDialog }
    Dialog {
        id: installDialog
        title: "Atualizar OpenSpeak"
        anchors.centerIn: parent
        modal: true
        standardButtons: Dialog.Ok | Dialog.Cancel
        Label { text: "O app será fechado e reaberto após a atualização.\nAs conexões e transmissões atuais serão encerradas."; wrapMode: Text.WordWrap }
        onAccepted: Updater.installNow()
    }
    Component.onCompleted: {
        NativeWindow.enableSnapToTop(window)
        NativeWindow.keepAutoHideTaskbar(window)
        NativeWindow.setLinkColor(Theme.accent)
        if (DebugOpen === "updates") Qt.callLater(() => preferencesDialog.openAt("updates"))
        if (DebugOpen === "preferences") Qt.callLater(() => preferencesDialog.open())
        if (DebugOpen === "profile" || DebugOpen === "avatar-crop") Qt.callLater(() => preferencesDialog.openAt("profile"))
        if (DebugOpen === "changelog") Qt.callLater(() => { preferencesDialog.allChangelog = true; preferencesDialog.openAt("updates") })
        if (DebugOpen === "licenses") Qt.callLater(() => preferencesDialog.openAt("about"))
        if (JustUpdated) {
            const text = I18n.t("app.updated", { version: Updater.version })
            if (StartHidden)
                Tray.showMessage("OpenSpeak", text)
            Qt.callLater(() => changelogDialog.open())
        }
        if (DebugOpen === "update-notes") Qt.callLater(() => changelogDialog.open())
        Tray.texts = {
            open: I18n.t("app.tray.open"),
            stop: I18n.t("app.tray.stop"),
            mute: I18n.t("app.tray.mute"),
            muteSounds: I18n.t("app.tray.mute_sounds"),
            settings: I18n.t("app.tray.settings"),
            quit: I18n.t("app.tray.quit"),
            tooltip: I18n.t("app.tray.tooltip"),
            tooltipStreaming: I18n.t("app.tray.tooltip.streaming")
        }

    }
    // Delegate resizing to Windows so edge drags retain native behavior.
    ResizeHandles {
        parent: window.contentItem
        window: window
        topOffset: -window.header.height
    }

    Loader {
        id: mainLoader
        anchors.fill: parent
        active: (UiSmoke && DebugOpen !== "startup") || (!UiSmoke && !Updater.startupBusy)
        sourceComponent: Server.connected || (UiSmoke && DebugOpen.indexOf("login") !== 0) ? mainView : loginView
    }
    Rectangle {
        objectName: "startupScreen"
        anchors.fill: parent
        color: Theme.background
        visible: UiSmoke ? DebugOpen === "startup" : Updater.startupBusy
        ColumnLayout {
            anchors.centerIn: parent
            width: Math.min(420, parent.width - 40)
            spacing: 20
            Icon { Layout.alignment: Qt.AlignHCenter; name: "logo"; size: 54; color: Theme.accent }
            Label { Layout.alignment: Qt.AlignHCenter; text: "OpenSpeak"; font.pixelSize: 26; color: Theme.text }
            BusyIndicator { Layout.alignment: Qt.AlignHCenter; running: parent.parent.visible }
            Label { Layout.fillWidth: true; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap; text: Updater.status; color: Theme.textDim }
        }
    }

    Component {
        id: loginView
        LoginView {
            message: window.loginMessage
            onConnecting: window.loginMessage = I18n.t("app.connecting")
        }
    }
    Component {
        id: mainView
        MainView {}
    }

    property string loginMessage: ""

    Toasts {
        id: toasts
        anchors.top: parent.top
        anchors.right: parent.right
        anchors.topMargin: 54
        anchors.rightMargin: 14
        z: 100
    }

    function errorText(key) {
        const t = I18n.t(key)
        return t
    }

    Connections {
        target: Server
        function onConnectFailed(error) { window.loginMessage = error }
        function onDisconnected(reason) { window.loginMessage = I18n.t("app.disconnected") }
        function onConnectionChanged() { if (Server.connected) window.loginMessage = "" }
    }

    Connections {
        target: Screenshare
        function onErrorOccurred(message) {
            toasts.show({ kind: "error", text: window.errorText(message) })
        }
        function onNoticeOccurred(key) {
            toasts.show({ key: key, kind: "info", text: I18n.t(key) })
        }
        function onJoinRequest(id, clid, nickname) {
            if (!window.visible || window.visibility === Window.Minimized)
                Tray.showMessage(I18n.t("app.tray.join_request.title"), I18n.t("video.join.request.notification", { user: nickname }))
            toasts.show({
                key: "join:" + id + ":" + clid,
                kind: "request",
                icon: "users",
                timeout: 30000,
                text: I18n.t("video.join.request.notification", { user: nickname })
                      + (Server.clientIdentity(clid) ? "
" + Server.clientIdentity(clid) : ""),
                actions: [
                    { label: I18n.t("video.join.request.accept"), primary: true,
                      run: function() { Screenshare.respondJoinRequest(id, clid, true, false) } },
                    { label: I18n.t("video.join.request.deny"),
                      run: function() { Screenshare.respondJoinRequest(id, clid, false, false) } },
                    { label: I18n.t("video.join.request.block"), danger: true,
                      run: function() { Screenshare.respondJoinRequest(id, clid, false, true) } }
                ]
            })
        }
        function onJoinRequestResolved(id, clid) { toasts.dismiss("join:" + id + ":" + clid) }
        function onCaptureFallbackSuggested(id, label) {
            if (!window.visible || window.visibility === Window.Minimized || !window.active)
                Tray.showMessage(I18n.t("video.capture.fallback.title"), I18n.t("video.capture.fallback.text", { window: label }))
            toasts.show({
                key: "capture:" + id,
                kind: "request",
                icon: "warning",
                timeout: 0,
                text: I18n.t("video.capture.fallback.text", { window: label }),
                actions: [
                    { label: I18n.t("video.capture.fallback.use"), primary: true,
                      run: function() { Screenshare.respondAlternativeCapture(id, true) } },
                    { label: I18n.t("video.capture.fallback.keep"),
                      run: function() { Screenshare.respondAlternativeCapture(id, false) } }
                ]
            })
        }
        function onCaptureFallbackResolved(id) { toasts.dismiss("capture:" + id) }
    }
}
