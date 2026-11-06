import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Window
import QtMultimedia
import "I18n.js" as I18n

// Um quadro na área de streams (equivalente ao .video-stream do TS 6).
Rectangle {
    id: tile
    property string streamId
    property var data_
    property bool focused: false
    // Ajuste manual só na grade: com um stream em foco a organização é a do foco.
    property bool arrangeable: true
    property bool arranging: false

    signal toggleFocus()
    signal arrangeBegun()
    signal moveDragged(real dx, real dy)
    signal resizeDragged(bool left, bool top, real dx, real dy)
    signal editRequested()
    signal changeSourceRequested()
    signal viewersRequested()
    signal statsRequested()

    readonly property bool own: data_.kind === "own"
    readonly property string status: data_.status
    readonly property bool playing: own || status === "playing" || status === "reconnecting" || status === "connecting"
    readonly property bool small: height < 160
    readonly property bool hovered: hover.hovered
    // Prévia do próprio stream fechada por causa de um app em tela cheia.
    readonly property bool previewClosed: own && !!data_.previewClosed
    // No picture-in-picture o vídeo fica só na janela pequena, como na web.
    readonly property bool inPip: pipWindow.visible
    // 1 = 100%; com "volume até 500%" ligado nas preferências, vai a 5.
    readonly property real maxVolume: Settings.volumeBoost ? 5 : 1
    // Simulcast (SFU): escolha entre a camada alta, a baixa ou o automático.
    // O botão aparece em toda transmissão pelo servidor; sem as duas camadas, o
    // menu explica que só há uma qualidade.
    readonly property bool hasQuality: !own && !!data_.sfu
    readonly property bool simulcast: !own && !!data_.simulcast
    readonly property string qualityPreference: data_.qualityPreference || "auto"
    readonly property string currentLayerText: data_.layer === "low" ? I18n.t("video.quality.low") : I18n.t("video.quality.high")
    readonly property string qualityAutoText: simulcast ? I18n.t("video.quality.auto_current", { layer: currentLayerText })
                                                        : I18n.t("video.quality.auto")
    readonly property string qualityTip: !simulcast ? I18n.t("video.quality") + ": " + I18n.t("video.quality.single")
        : I18n.t("video.quality") + ": "
        + (qualityPreference === "high" ? I18n.t("video.quality.high")
           : qualityPreference === "low" ? I18n.t("video.quality.low") : qualityAutoText)

    color: "#05070b"
    radius: Theme.radius
    border.width: 1
    border.color: focused ? Theme.accent : own ? Qt.rgba(0.94, 0.22, 0.29, 0.45) : Theme.border
    clip: true

    function typeIcon(t) { return t === 1 ? "camera" : t === 3 ? "window" : "screen" }
    function accessIcon(a) { return a === 2 ? "contacts" : a === 3 ? "lock" : "globe" }
    function initials(name) {
        return (name || "?").trim().split(/\s+/).slice(0, 2).map(p => p[0]).join("").toUpperCase()
    }

    // ---------------------------------------------------------------- vídeo
    property var attachedSinks: []
    function attach(sink) {
        if (own)
            Screenshare.attachOwnPreview(streamId, sink)
        else
            Screenshare.attachVideo(streamId, sink)
    }
    function detach(sink) {
        if (own)
            Screenshare.detachOwnPreview(streamId, sink)
        else
            Screenshare.detachVideo(streamId, sink)
    }
    function refreshAttachment() {
        if (playing && !previewClosed && !inPip)
            attach(video.videoSink)
        if (fullscreenWindow.visible)
            attach(fullscreenVideo.videoSink)
        if (pipWindow.visible)
            attach(pipVideo.videoSink)
    }
    onPreviewClosedChanged: {
        if (previewClosed)
            detach(video.videoSink)
        else
            refreshAttachment()
    }
    onStatusChanged: {
        refreshAttachment()
        if (!playing) {
            pipWindow.close()
            fullscreenWindow.close()
        } else if (DebugOpen === "pip" && status === "playing") // depuração: --open pip
            Qt.callLater(openPip)
        else if (DebugOpen === "fullscreen" && (own || status === "playing")) // depuração: --open fullscreen
            Qt.callLater(openFullscreen)
    }
    Component.onCompleted: {
        refreshAttachment()
        if (DebugOpen === "fullscreen" && own)
            Qt.callLater(openFullscreen)
    }
    Component.onDestruction: {
        detach(video.videoSink)
        detach(fullscreenVideo.videoSink)
        detach(pipVideo.videoSink)
    }

    VideoOutput {
        id: video
        anchors.fill: parent
        anchors.margins: 1
        fillMode: VideoOutput.PreserveAspectFit
        visible: tile.playing && !tile.previewClosed && !tile.inPip
        opacity: tile.data_.paused ? 0.35 : 1
    }

    ColumnLayout {
        anchors.centerIn: parent
        visible: tile.inPip
        spacing: 6
        Icon { Layout.alignment: Qt.AlignHCenter; visible: !tile.small; name: "pip"; size: 28; color: Theme.textDim }
        Label { Layout.alignment: Qt.AlignHCenter; visible: !tile.small; text: I18n.t("video.stream.in_pip"); color: Theme.textDim }
        Button {
            objectName: "closePip"
            Layout.alignment: Qt.AlignHCenter
            text: I18n.t("video.action.pip.close")
            onClicked: tile.closePip()
        }
    }

    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width - 24, 320)
        visible: tile.previewClosed && !tile.inPip
        spacing: 6
        Icon { Layout.alignment: Qt.AlignHCenter; visible: !tile.small; name: "eyeOff"; size: 28; color: Theme.textDim }
        Label {
            Layout.fillWidth: true
            visible: !tile.small
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            text: I18n.t("video.preview.closed")
            color: Theme.textDim
        }
        Button {
            objectName: "showPreview"
            Layout.alignment: Qt.AlignHCenter
            text: I18n.t("video.preview.show")
            onClicked: Screenshare.keepOwnPreview(tile.streamId)
        }
    }

    HoverHandler { id: hover }
    TapHandler {
        acceptedButtons: Qt.LeftButton
        onDoubleTapped: tile.openFullscreen()
    }

    // Arrastar o quadro o move para qualquer lugar da área.
    DragHandler {
        target: null
        enabled: tile.arrangeable
        // Sem isso o arrasto rouba o gesto dos cantos, dos botões e do volume.
        grabPermissions: PointerHandler.CanTakeOverFromHandlersOfDifferentType | PointerHandler.ApprovesTakeOverByAnything
        cursorShape: Qt.ClosedHandCursor
        onActiveChanged: {
            tile.arranging = active
            if (active)
                tile.arrangeBegun()
        }
        onActiveTranslationChanged: if (active) tile.moveDragged(activeTranslation.x, activeTranslation.y)
    }

    // Cantos que redimensionam o preview. A conta usa a posição na janela porque
    // o próprio quadro se mexe durante o arrasto.
    Repeater {
        model: tile.arrangeable ? [Qt.TopEdge | Qt.LeftEdge, Qt.TopEdge | Qt.RightEdge,
                                   Qt.BottomEdge | Qt.LeftEdge, Qt.BottomEdge | Qt.RightEdge] : []
        delegate: MouseArea {
            required property int modelData
            readonly property bool edgeLeft: !!(modelData & Qt.LeftEdge)
            readonly property bool edgeTop: !!(modelData & Qt.TopEdge)
            property point pressedAt
            z: 1000
            x: edgeLeft ? 0 : parent.width - width
            y: edgeTop ? 0 : parent.height - height
            width: 12
            height: 12
            cursorShape: edgeLeft === edgeTop ? Qt.SizeFDiagCursor : Qt.SizeBDiagCursor
            onPressed: mouse => {
                pressedAt = mapToItem(null, mouse.x, mouse.y)
                tile.arranging = true
                tile.arrangeBegun()
            }
            onPositionChanged: mouse => {
                const at = mapToItem(null, mouse.x, mouse.y)
                tile.resizeDragged(edgeLeft, edgeTop, at.x - pressedAt.x, at.y - pressedAt.y)
            }
            onReleased: tile.arranging = false
            onCanceled: tile.arranging = false
        }
    }

    // ---------------------------------------------------------- tela cheia
    function openFullscreen() {
        if (!tile.playing)
            return
        // Abre no monitor onde está a janela do app agora: a janela de tela cheia
        // guarda a posição da vez anterior, e o Windows usa o monitor dessa posição.
        // O tamanho também é preciso: sem ele, na primeira abertura a janela nativa
        // nasce com 0x0 e o Qt a coloca no monitor primário, ignorando x/y.
        const appScreen = tile.Window.window ? tile.Window.window.screen : null
        if (appScreen) {
            fullscreenWindow.screen = appScreen
            fullscreenWindow.x = appScreen.virtualX
            fullscreenWindow.y = appScreen.virtualY
            fullscreenWindow.width = appScreen.width
            fullscreenWindow.height = appScreen.height
        }
        NativeWindow.setTaskbarInFullScreen(fullscreenWindow, Settings.fullscreenTaskbar)
        fullscreenWindow.showFullScreen()
        attach(fullscreenVideo.videoSink)
    }
    Window {
        id: fullscreenWindow
        color: "black"
        title: tile.data_.name
        onVisibleChanged: {
            if (visible)
                fullscreenIdle.restart()
            else
                tile.detach(fullscreenVideo.videoSink)
        }
        // Controles aparecem ao mexer o mouse e somem (com o cursor) após 2,5 s parado.
        property bool controlsShown: true
        VideoOutput {
            id: fullscreenVideo
            anchors.fill: parent
            fillMode: VideoOutput.PreserveAspectFit
            opacity: tile.data_.paused ? 0.35 : 1
        }
        Timer {
            id: fullscreenIdle
            interval: 2500
            onTriggered: fullscreenWindow.controlsShown = fullscreenTopHover.hovered || fullscreenBottomHover.hovered
        }
        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            acceptedButtons: Qt.NoButton
            cursorShape: fullscreenWindow.controlsShown ? Qt.ArrowCursor : Qt.BlankCursor
            onPositionChanged: { fullscreenWindow.controlsShown = true; fullscreenIdle.restart() }
        }
        Shortcut { sequence: "Esc"; onActivated: fullscreenWindow.close() }
        TapHandler { onDoubleTapped: fullscreenWindow.close() }

        Rectangle {
            anchors.centerIn: parent
            visible: tile.data_.paused
            radius: 18
            color: Qt.rgba(0, 0, 0, 0.6)
            implicitWidth: fullscreenPaused.implicitWidth + 28
            implicitHeight: 40
            RowLayout {
                id: fullscreenPaused
                anchors.centerIn: parent
                Icon { name: "pause"; size: 18 }
                Label { text: I18n.t("video.stream.paused"); color: Theme.text; font.pixelSize: 15 }
            }
        }

        Rectangle {
            anchors.top: parent.top
            width: parent.width
            height: 56
            opacity: fullscreenWindow.controlsShown ? 1 : 0
            visible: opacity > 0
            Behavior on opacity { NumberAnimation { duration: 200 } }
            gradient: Gradient {
                GradientStop { position: 0; color: Qt.rgba(0, 0, 0, 0.75) }
                GradientStop { position: 1; color: "transparent" }
            }
            HoverHandler { id: fullscreenTopHover }
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 18
                anchors.rightMargin: 10
                spacing: 4
                Label {
                    Layout.fillWidth: true
                    text: tile.data_.name + (tile.own ? "" : "  ·  " + tile.data_.ownerName)
                    elide: Text.ElideRight
                    color: Theme.text
                    font.pixelSize: 15
                    font.weight: Font.DemiBold
                }
                FullscreenButton { iconName: "close"; tip: I18n.t("video.action.fullscreen.close"); onClicked: fullscreenWindow.close() }
            }
        }

        Rectangle {
            anchors.bottom: parent.bottom
            width: parent.width
            height: 64
            opacity: fullscreenWindow.controlsShown ? 1 : 0
            visible: opacity > 0
            Behavior on opacity { NumberAnimation { duration: 200 } }
            gradient: Gradient {
                GradientStop { position: 0; color: "transparent" }
                GradientStop { position: 1; color: Qt.rgba(0, 0, 0, 0.8) }
            }
            HoverHandler { id: fullscreenBottomHover }
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 14
                anchors.rightMargin: 14
                spacing: 4
                FullscreenButton {
                    visible: tile.own
                    iconName: tile.data_.paused ? "play" : "pause"
                    tip: tile.data_.paused ? I18n.t("video.action.resume") : I18n.t("video.action.pause")
                    onClicked: Screenshare.setPaused(tile.streamId, !tile.data_.paused)
                }
                FullscreenButton {
                    visible: !tile.own
                    iconName: tile.data_.audioBlocked || volumeSlider.value === 0 ? "mute" : "volume"
                    tip: I18n.t("video.action.volume")
                    onClicked: volumeSlider.value = volumeSlider.value === 0 ? 1 : 0
                }
                VolumeSlider {
                    id: fullscreenVolume
                    visible: !tile.own
                    Layout.preferredWidth: 120
                    from: 0; to: tile.maxVolume
                    onVolumeEdited: v => volumeSlider.value = v
                    Binding { target: fullscreenVolume; property: "value"; value: volumeSlider.value }
                }
                FullscreenButton {
                    id: fullscreenQuality
                    visible: tile.hasQuality
                    iconName: "quality"
                    iconColor: !tile.simulcast ? Qt.rgba(1, 1, 1, 0.55) : tile.data_.layer === "low" ? Theme.warn : "white"
                    tip: tile.qualityTip
                    onClicked: fullscreenQualityMenu.open()
                    QualityMenu { id: fullscreenQualityMenu }
                }
                Item { Layout.fillWidth: true }
                FullscreenButton {
                    iconName: "pip"
                    tip: I18n.t("video.action.pip.open")
                    onClicked: { fullscreenWindow.close(); tile.openPip() }
                }
                FullscreenButton { iconName: "fullscreen"; tip: I18n.t("video.action.fullscreen.close"); onClicked: fullscreenWindow.close() }
                FullscreenButton {
                    visible: tile.own
                    iconName: "stop"
                    iconColor: Theme.danger
                    tip: I18n.t("video.action.stop_stream")
                    onClicked: { fullscreenWindow.close(); Screenshare.stopStream(tile.streamId) }
                }
                FullscreenButton {
                    visible: !tile.own
                    iconName: "leave"
                    iconColor: Theme.danger
                    tip: I18n.t("video.action.leave")
                    onClicked: { fullscreenWindow.close(); Screenshare.leaveStream(tile.streamId) }
                }
            }
        }
    }
    component FullscreenButton: ToolButton {
        property string iconName
        property string tip
        property color iconColor: "white"
        padding: 6
        implicitWidth: 42
        implicitHeight: 42
        contentItem: Item {}
        Icon { anchors.centerIn: parent; name: parent.iconName; color: parent.iconColor; size: 22 }
        ToolTip.visible: hovered
        ToolTip.text: tip
    }

    // ---------------------------------------------------- picture-in-picture
    // Janela pequena sem borda, arrastável e redimensionável, com os controles
    // principais. Fixada (padrão), fica por cima de todos os apps.
    function openPip() {
        if (!tile.playing)
            return
        if (!pipWindow.visible) {
            // Canto inferior direito da tela do app (margem para a barra de tarefas).
            pipWindow.x = tile.Screen.virtualX + tile.Screen.width - pipWindow.width - 24
            pipWindow.y = tile.Screen.virtualY + tile.Screen.height - pipWindow.height - 72
        }
        pipWindow.show()
        pipWindow.raise()
        attach(pipVideo.videoSink)
    }
    function closePip() {
        pipWindow.close()
        const main = tile.Window.window
        if (main) {
            main.raise()
            main.requestActivate()
        }
    }
    Window {
        id: pipWindow
        width: 480
        height: 270
        minimumWidth: 240
        minimumHeight: 135
        color: "black"
        title: tile.data_.name
        // Sem janela-mãe: declarada dentro do tile, o Qt usaria a janela principal
        // como transientParent e o Windows esconderia o PiP ao minimizar o app.
        transientParent: null
        flags: Qt.Window | Qt.FramelessWindowHint | (Settings.pipPinned ? Qt.WindowStaysOnTopHint : 0)
        onVisibleChanged: {
            if (visible) {
                tile.detach(video.videoSink)
            } else {
                tile.detach(pipVideo.videoSink)
                tile.refreshAttachment()
            }
        }

        VideoOutput {
            id: pipVideo
            anchors.fill: parent
            fillMode: VideoOutput.PreserveAspectFit
            opacity: tile.data_.paused ? 0.35 : 1
        }
        HoverHandler { id: pipHover }
        // Arrasta a janela por qualquer ponto do vídeo; duplo clique volta ao app.
        DragHandler {
            target: null
            onActiveChanged: if (active) pipWindow.startSystemMove()
        }
        TapHandler { onDoubleTapped: tile.closePip() }
        Shortcut { sequence: "Esc"; onActivated: tile.closePip() }

        Rectangle {
            anchors.centerIn: parent
            visible: tile.data_.paused
            radius: 16
            color: Qt.rgba(0, 0, 0, 0.6)
            implicitWidth: pipPaused.implicitWidth + 24
            implicitHeight: 32
            RowLayout {
                id: pipPaused
                anchors.centerIn: parent
                Icon { name: "pause"; size: 16 }
                Label { text: I18n.t("video.stream.paused"); color: Theme.text }
            }
        }

        Rectangle {
            anchors.top: parent.top
            width: parent.width
            height: 36
            opacity: pipHover.hovered ? 1 : 0
            Behavior on opacity { NumberAnimation { duration: 150 } }
            gradient: Gradient {
                GradientStop { position: 0; color: Qt.rgba(0, 0, 0, 0.75) }
                GradientStop { position: 1; color: "transparent" }
            }
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 10
                anchors.rightMargin: 4
                spacing: 2
                Label {
                    Layout.fillWidth: true
                    text: tile.data_.name + (tile.own ? "" : "  ·  " + tile.data_.ownerName)
                    elide: Text.ElideRight
                    color: Theme.text
                    font.weight: Font.DemiBold
                }
                PipButton {
                    iconName: "pin"
                    iconColor: Settings.pipPinned ? Theme.accent : "white"
                    tip: Settings.pipPinned ? I18n.t("video.action.pip.unpin") : I18n.t("video.action.pip.pin")
                    onClicked: Settings.pipPinned = !Settings.pipPinned
                }
                PipButton { iconName: "close"; tip: I18n.t("video.action.pip.close"); onClicked: tile.closePip() }
            }
        }

        Rectangle {
            anchors.bottom: parent.bottom
            width: parent.width
            height: 40
            opacity: pipHover.hovered ? 1 : 0
            Behavior on opacity { NumberAnimation { duration: 150 } }
            gradient: Gradient {
                GradientStop { position: 0; color: "transparent" }
                GradientStop { position: 1; color: Qt.rgba(0, 0, 0, 0.75) }
            }
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 6
                anchors.rightMargin: 22
                spacing: 2
                PipButton {
                    visible: tile.own
                    iconName: tile.data_.paused ? "play" : "pause"
                    tip: tile.data_.paused ? I18n.t("video.action.resume") : I18n.t("video.action.pause")
                    onClicked: Screenshare.setPaused(tile.streamId, !tile.data_.paused)
                }
                PipButton {
                    visible: !tile.own
                    iconName: tile.data_.audioBlocked || volumeSlider.value === 0 ? "mute" : "volume"
                    tip: I18n.t("video.action.volume")
                    onClicked: volumeSlider.value = volumeSlider.value === 0 ? 1 : 0
                }
                VolumeSlider {
                    id: pipVolume
                    visible: !tile.own && pipWindow.width >= 320
                    Layout.preferredWidth: 90
                    from: 0; to: tile.maxVolume
                    onVolumeEdited: v => volumeSlider.value = v
                    Binding { target: pipVolume; property: "value"; value: volumeSlider.value }
                }
                Item { Layout.fillWidth: true }
                PipButton {
                    visible: tile.own
                    iconName: "stop"
                    iconColor: Theme.danger
                    tip: I18n.t("video.action.stop_stream")
                    onClicked: Screenshare.stopStream(tile.streamId)
                }
                PipButton {
                    visible: !tile.own
                    iconName: "leave"
                    iconColor: Theme.danger
                    tip: I18n.t("video.action.leave")
                    onClicked: Screenshare.leaveStream(tile.streamId)
                }
            }
        }

        // Redimensiona por qualquer borda ou canto (o Windows faz o resize nativo).
        Repeater {
            model: [Qt.LeftEdge, Qt.RightEdge, Qt.TopEdge, Qt.BottomEdge,
                    Qt.TopEdge | Qt.LeftEdge, Qt.TopEdge | Qt.RightEdge,
                    Qt.BottomEdge | Qt.LeftEdge, Qt.BottomEdge | Qt.RightEdge]
            delegate: MouseArea {
                required property int modelData
                readonly property bool edgeLeft: !!(modelData & Qt.LeftEdge)
                readonly property bool edgeRight: !!(modelData & Qt.RightEdge)
                readonly property bool edgeTop: !!(modelData & Qt.TopEdge)
                readonly property bool edgeBottom: !!(modelData & Qt.BottomEdge)
                readonly property bool corner: (edgeLeft || edgeRight) && (edgeTop || edgeBottom)
                readonly property int grip: corner ? 14 : 6
                // Cantos acima das bordas para ganharem o clique na interseção.
                z: corner ? 1001 : 1000
                x: edgeRight ? parent.width - width : 0
                y: edgeBottom ? parent.height - height : 0
                width: edgeLeft || edgeRight ? grip : parent.width
                height: edgeTop || edgeBottom ? grip : parent.height
                cursorShape: corner ? (edgeLeft === edgeTop ? Qt.SizeFDiagCursor : Qt.SizeBDiagCursor)
                                    : edgeLeft || edgeRight ? Qt.SizeHorCursor : Qt.SizeVerCursor
                onPressed: pipWindow.startSystemResize(modelData)
            }
        }
    }


    // ---------------------------------------------- cartão (não assistindo)
    Item {
        anchors.fill: parent
        visible: !tile.playing

        Image {
            anchors.fill: parent
            source: tile.data_.thumbnail || ""
            fillMode: Image.PreserveAspectCrop
            opacity: 0.32
            visible: source != ""
        }

        ColumnLayout {
            anchors.centerIn: parent
            width: Math.min(parent.width - 24, 360)
            spacing: tile.small ? 3 : 6

            Rectangle {
                Layout.alignment: Qt.AlignHCenter
                width: tile.small ? 30 : 54
                height: width
                radius: width / 2
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0; color: "#2160a8" }
                    GradientStop { position: 1; color: Theme.accent }
                }
                border.width: 3
                border.color: Qt.rgba(0.94, 0.22, 0.29, 0.8)
                Label {
                    anchors.centerIn: parent
                    text: tile.initials(tile.data_.ownerName)
                    font.pixelSize: tile.small ? 12 : 18
                    font.weight: Font.Bold
                    color: "white"
                }
            }
            Label {
                Layout.fillWidth: true
                horizontalAlignment: Text.AlignHCenter
                text: tile.data_.name
                elide: Text.ElideRight
                font.pixelSize: 15
                font.weight: Font.DemiBold
                color: Theme.text
            }
            RowLayout {
                Layout.alignment: Qt.AlignHCenter
                visible: !tile.small
                spacing: 5
                Icon { name: tile.typeIcon(tile.data_.type); size: 14; color: Theme.textDim }
                Label { text: tile.data_.ownerName; color: Theme.textDim; font.pixelSize: 12 }
                Label { text: "•"; color: Theme.textFaint }
                Icon { name: tile.accessIcon(tile.data_.access); size: 14; color: Theme.textDim }
                Label { text: "•"; color: Theme.textFaint }
                Icon { name: "users"; size: 14; color: Theme.textDim }
                Label { text: tile.data_.viewerCount; color: Theme.textDim; font.pixelSize: 12 }
            }

            // Assistir
            Button {
                Layout.alignment: Qt.AlignHCenter
                visible: tile.status === ""
                text: I18n.t("video.action.join")
                highlighted: true
                onClicked: Screenshare.joinStream(tile.streamId)
            }
            // Aguardando / conectando
            ColumnLayout {
                Layout.alignment: Qt.AlignHCenter
                visible: tile.status === "waiting"
                spacing: 6
                RowLayout {
                    Layout.alignment: Qt.AlignHCenter
                    BusyIndicator { implicitWidth: 22; implicitHeight: 22; running: parent.visible }
                    Label { text: I18n.t("video.join.status.waiting_for_answer"); color: Theme.text }
                }
                Button {
                    Layout.alignment: Qt.AlignHCenter
                    flat: true
                    text: I18n.t("video.action.join.abort")
                    onClicked: Screenshare.leaveStream(tile.streamId)
                }
            }
            // Erro
            ColumnLayout {
                Layout.alignment: Qt.AlignHCenter
                visible: tile.status === "error"
                spacing: 6
                RowLayout {
                    Layout.alignment: Qt.AlignHCenter
                    Icon { name: "warning"; size: 16; color: Theme.warn }
                    Label {
                        text: I18n.t(tile.data_.errorKey || "video.join.error.generic", { reason: "" })
                        color: Theme.warn
                        wrapMode: Text.WordWrap
                    }
                }
                RowLayout {
                    Layout.alignment: Qt.AlignHCenter
                    Button { text: I18n.t("video.action.retry"); onClicked: Screenshare.joinStream(tile.streamId) }
                    Button { flat: true; text: I18n.t("video.action.dismiss"); onClicked: Screenshare.dismiss(tile.streamId) }
                }
            }
        }
    }

    // --------------------------------------------------- estados de vídeo
    Rectangle {
        anchors.centerIn: parent
        visible: tile.playing && !tile.own && (tile.status !== "playing" || !tile.data_.hasVideo)
        radius: 18
        color: Qt.rgba(0, 0, 0, 0.6)
        implicitWidth: connRow.implicitWidth + 28
        implicitHeight: 36
        RowLayout {
            id: connRow
            anchors.centerIn: parent
            BusyIndicator { implicitWidth: 20; implicitHeight: 20; running: parent.visible }
            Label {
                text: tile.status === "reconnecting" ? I18n.t("video.join.status.reconnecting") : I18n.t("video.join.status.connecting")
                color: Theme.text
            }
        }
    }
    Rectangle {
        anchors.centerIn: parent
        visible: tile.playing && tile.data_.paused
        radius: 20
        color: Qt.rgba(0, 0, 0, 0.6)
        implicitWidth: pausedRow.implicitWidth + 32
        implicitHeight: 40
        RowLayout {
            id: pausedRow
            anchors.centerIn: parent
            Icon { name: "pause" }
            Label { text: I18n.t("video.stream.paused"); color: Theme.text; font.weight: Font.DemiBold }
        }
    }

    // ------------------------------------------------------- barra superior
    Rectangle {
        id: topBar
        anchors.top: parent.top
        width: parent.width
        height: tile.small ? 28 : 38
        visible: tile.playing
        opacity: tile.hovered || tile.data_.severity > 0 ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 150 } }
        gradient: Gradient {
            GradientStop { position: 0; color: Qt.rgba(0, 0, 0, 0.7) }
            GradientStop { position: 1; color: "transparent" }
        }
        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: 10
            anchors.rightMargin: 10
            spacing: 8
            Rectangle {
                visible: tile.own
                radius: 3
                color: Theme.live
                implicitWidth: liveText.implicitWidth + 12
                implicitHeight: 18
                Label { id: liveText; anchors.centerIn: parent; text: I18n.t("video.stream.live"); color: "white"; font.pixelSize: 10; font.weight: Font.Black }
                SequentialAnimation on opacity {
                    loops: Animation.Infinite
                    NumberAnimation { to: 0.7; duration: 1000 }
                    NumberAnimation { to: 1; duration: 1000 }
                }
            }
            Icon { name: tile.typeIcon(tile.data_.type); size: 15; color: Theme.textDim }
            Label {
                Layout.fillWidth: true
                text: tile.data_.name + (tile.own ? "" : "  ·  " + tile.data_.ownerName)
                elide: Text.ElideRight
                color: Theme.text
                font.weight: Font.DemiBold
            }
            ToolButton {
                padding: 3
                visible: tile.data_.severity > 0
                implicitWidth: 26
                implicitHeight: 26
                contentItem: Item {}
        Icon { anchors.centerIn: parent; name: tile.data_.severity >= 2 ? "warning" : "info"; color: Theme.severityColor(tile.data_.severity) }
                onClicked: tile.statsRequested()
            }
            ViewerCount {
                streamId: tile.streamId
                count: tile.data_.viewerCount
                color: Theme.text
                iconSize: 15
                fontSize: 13
            }
        }
    }

    // ------------------------------------------------------- barra de ações
    component QualityMenu: Menu {
        y: -implicitHeight
        MenuItem {
            visible: !tile.simulcast
            height: visible ? implicitHeight : 0
            enabled: false
            text: I18n.t("video.quality.single.hint")
        }
        MenuItem {
            enabled: tile.simulcast
            text: tile.qualityAutoText
            checkable: true
            checked: tile.qualityPreference === "auto"
            onTriggered: Screenshare.setQualityPreference(tile.streamId, "auto")
        }
        MenuItem {
            enabled: tile.simulcast
            text: I18n.t("video.quality.high")
            checkable: true
            checked: tile.qualityPreference === "high"
            onTriggered: Screenshare.setQualityPreference(tile.streamId, "high")
        }
        MenuItem {
            enabled: tile.simulcast
            text: I18n.t("video.quality.low")
            checkable: true
            checked: tile.qualityPreference === "low"
            onTriggered: Screenshare.setQualityPreference(tile.streamId, "low")
        }
    }

    component TileButton: ToolButton {
        padding: 3
        property string iconName
        property string tip
        property color iconColor: "white"
        implicitWidth: tile.small ? 26 : 32
        implicitHeight: implicitWidth
        contentItem: Item {}
        Icon { anchors.centerIn: parent; name: parent.iconName; color: parent.iconColor; size: tile.small ? 15 : 18 }
        ToolTip.visible: hovered
        ToolTip.text: tip
    }

    component PipButton: ToolButton {
        property string iconName
        property string tip
        property color iconColor: "white"
        padding: 3
        implicitWidth: 30
        implicitHeight: 30
        contentItem: Item {}
        Icon { anchors.centerIn: parent; name: parent.iconName; color: parent.iconColor; size: 17 }
        ToolTip.visible: hovered
        ToolTip.text: tip
    }

    Rectangle {
        anchors.bottom: parent.bottom
        width: parent.width
        height: tile.small ? 32 : 44
        opacity: tile.hovered || !tile.playing ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: 150 } }
        gradient: Gradient {
            GradientStop { position: 0; color: "transparent" }
            GradientStop { position: 1; color: Qt.rgba(0, 0, 0, 0.75) }
        }

        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: 6
            anchors.rightMargin: 6
            spacing: 2

            // --- próprio
            TileButton {
                visible: tile.own
                iconName: tile.data_.paused ? "play" : "pause"
                tip: tile.data_.paused ? I18n.t("video.action.resume") : I18n.t("video.action.pause")
                onClicked: Screenshare.setPaused(tile.streamId, !tile.data_.paused)
            }
            TileButton { visible: tile.own; iconName: "swap"; tip: I18n.t("video.action.change_source"); onClicked: tile.changeSourceRequested() }
            TileButton { visible: tile.own; iconName: "settings"; tip: I18n.t("video.settings"); onClicked: tile.editRequested() }
            TileButton {
                visible: tile.own
                iconName: "users"
                iconColor: tile.data_.pendingRequests > 0 ? Theme.warn : "white"
                tip: I18n.t("video.action.manage_viewers")
                onClicked: tile.viewersRequested()
                Rectangle {
                    visible: tile.data_.pendingRequests > 0
                    anchors.top: parent.top
                    anchors.right: parent.right
                    width: 16; height: 16; radius: 8
                    color: Theme.warn
                    Label { anchors.centerIn: parent; text: tile.data_.pendingRequests; color: "black"; font.pixelSize: 10; font.weight: Font.Bold }
                }
            }

            // --- remoto assistindo
            TileButton {
                id: volumeButton
                visible: !tile.own && tile.playing
                iconName: tile.data_.audioBlocked || volumeSlider.value === 0 ? "mute" : "volume"
                tip: tile.data_.audioBlocked ? I18n.t("video.audio.discord.blocked") : I18n.t("video.action.volume")
                onClicked: volumeSlider.value = volumeSlider.value === 0 ? 1 : 0
            }
            VolumeSlider {
                id: volumeSlider
                visible: !tile.own && tile.playing && !tile.small
                Layout.preferredWidth: 90
                from: 0; to: tile.maxVolume
                value: tile.data_.volume
                onVolumeEdited: v => Screenshare.setVolume(tile.streamId, v)
                onValueChanged: if (!pressed) Screenshare.setVolume(tile.streamId, value)
            }

            TileButton {
                id: qualityButton
                objectName: "qualityButton"
                visible: tile.hasQuality && tile.playing
                iconName: "quality"
                iconColor: !tile.simulcast ? Qt.rgba(1, 1, 1, 0.55) : tile.data_.layer === "low" ? Theme.warn : "white"
                tip: tile.qualityTip
                onClicked: qualityMenu.open()
                QualityMenu { id: qualityMenu }
            }
            TileButton { visible: tile.playing; iconName: "chart"; tip: I18n.t("video.action.stats"); onClicked: tile.statsRequested() }
            Item { Layout.fillWidth: true }
            TileButton {
                visible: !tile.own
                iconName: "eyeOff"
                tip: I18n.t("video.stream.hide_stream")
                onClicked: {
                    Settings.hideStream(tile.streamId)
                    Screenshare.leaveStream(tile.streamId)
                }
            }
            TileButton {
                visible: tile.playing
                iconName: tile.focused ? "grid" : "focus"
                tip: tile.focused ? I18n.t("video.action.unfocus") : I18n.t("video.action.focus")
                onClicked: tile.toggleFocus()
            }
            TileButton {
                objectName: "hidePreview"
                visible: tile.own && !tile.previewClosed && !tile.inPip
                iconName: "eyeOff"
                tip: I18n.t("video.preview.hide")
                onClicked: Screenshare.closeOwnPreview(tile.streamId)
            }
            TileButton {
                visible: tile.playing
                iconName: "pip"
                iconColor: pipWindow.visible ? Theme.accent : "white"
                tip: pipWindow.visible ? I18n.t("video.action.pip.close") : I18n.t("video.action.pip.open")
                onClicked: pipWindow.visible ? tile.closePip() : tile.openPip()
            }
            TileButton { visible: tile.playing; iconName: "fullscreen"; tip: I18n.t("video.action.fullscreen.open"); onClicked: tile.openFullscreen() }
            TileButton {
                visible: tile.own
                iconName: "stop"
                iconColor: Theme.danger
                tip: I18n.t("video.action.stop_stream")
                onClicked: Screenshare.stopStream(tile.streamId)
            }
            TileButton {
                visible: !tile.own && tile.playing
                iconName: "leave"
                iconColor: Theme.danger
                tip: I18n.t("video.action.leave")
                onClicked: Screenshare.leaveStream(tile.streamId)
            }
        }
    }
}
