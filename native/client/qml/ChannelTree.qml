import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "I18n.js" as I18n

// Árvore de canais com clientes e indicadores de stream (ao vivo / espectadores).
Rectangle {
    id: root
    color: Theme.panel
    signal streamClicked(string id)

    function typeIcon(t) { return t === 1 ? "camera" : t === 3 ? "window" : "screen" }

    ProfileCard { id: profileCard }
    Component.onCompleted: {
        if (DebugOpen === "profile-card")
            Qt.callLater(() => profileCard.openFor({ name: "Teste", nickname: "teste", description: "Descrição", uid: "u" }, root))
    }

    Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }

    ScrollView {
        anchors.fill: parent
        anchors.rightMargin: 1
        clip: true

        Column {
            width: root.width - 1
            padding: 6
            spacing: 2

            RowLayout {
                width: parent.width - 12
                height: 34
                spacing: 8
                Item { width: 2 }
                Icon { name: "server"; color: Theme.gold }
                Label { text: Server.serverName; font.weight: Font.DemiBold; color: Theme.text; Layout.fillWidth: true; elide: Text.ElideRight }
                // Servidor com relay: as transmissões vão todas por ele (SFU).
                Rectangle {
                    visible: Server.hasStreamingSFU
                    radius: 4
                    color: Theme.accentSoft
                    implicitWidth: modeLabel.implicitWidth + 12
                    implicitHeight: 18
                    Label { id: modeLabel; anchors.centerIn: parent; text: "SFU"; color: Theme.accent; font.pixelSize: 11; font.weight: Font.Bold }
                    HoverHandler { id: modeHover }
                    ToolTip.visible: modeHover.hovered
                    ToolTip.delay: 250
                    ToolTip.text: I18n.t("app.server.mode.sfu")
                }
            }

            Repeater {
                model: Server.tree
                delegate: Column {
                    id: channel
                    required property var modelData
                    width: parent.width - 12

                    ItemDelegate {
                        width: parent.width
                        height: 30
                        ToolTip.visible: hovered
                        ToolTip.delay: 600
                        ToolTip.text: channel.modelData.description + "\n(" + I18n.t("app.channel.join") + ": duplo clique)"
                        onDoubleClicked: Server.moveTo(channel.modelData.cid)
                        contentItem: RowLayout {
                            spacing: 7
                            Icon { name: "channel"; size: 16; color: channel.modelData.current ? Theme.accent : Theme.textFaint }
                            Label {
                                Layout.fillWidth: true
                                text: channel.modelData.name
                                elide: Text.ElideRight
                                color: channel.modelData.current ? Theme.text : Theme.textDim
                                font.weight: Font.Medium
                            }
                            Row {
                                visible: channel.modelData.streamCount > 0
                                spacing: 3
                                Icon { name: "stream"; size: 14; color: Theme.live }
                                Label { text: channel.modelData.streamCount; color: Theme.live; font.pixelSize: 12 }
                            }
                        }
                    }

                    Repeater {
                        model: channel.modelData.clients
                        delegate: Column {
                            id: client
                            required property var modelData
                            width: channel.width

                            ItemDelegate {
                                id: clientRow
                                width: parent.width
                                height: 28
                                // Destaque recuado junto com o nome, com folga igual dos dois lados.
                                leftInset: 18; rightInset: 2; topInset: 1; bottomInset: 1
                                leftPadding: 26; rightPadding: 10
                                background: RowHighlight { control: clientRow }
                                onClicked: profileCard.openFor(client.modelData, clientRow)
                                contentItem: RowLayout {
                                    spacing: 7
                                    Rectangle {
                                        visible: !client.modelData.avatar
                                        width: 9; height: 9; radius: 5; color: "transparent"; border.width: 2; border.color: Theme.online
                                    }
                                    Avatar {
                                        visible: !!client.modelData.avatar
                                        source: client.modelData.avatar
                                        name: client.modelData.name
                                        size: 18
                                    }
                                    Label {
                                        text: client.modelData.name
                                        color: client.modelData.color || Theme.text
                                        font.weight: client.modelData.me ? Font.DemiBold : Font.Normal
                                        elide: Text.ElideRight
                                        Layout.maximumWidth: 150
                                    }
                                    Label { visible: client.modelData.me; text: "(" + I18n.t("app.you") + ")"; color: Theme.textDim }
                                    Icon {
                                        visible: Settings.contacts.indexOf(client.modelData.uid) >= 0
                                        name: "star"; size: 13; color: Theme.gold
                                    }
                                    Item { Layout.fillWidth: true }
                                    Label {
                                        text: client.modelData.pingMs >= 0 ? Math.round(client.modelData.pingMs) + " ms" : "—"
                                        color: Theme.textDim
                                        font.pixelSize: 11
                                        ToolTip.visible: pingHover.hovered
                                        ToolTip.text: client.modelData.pingMs >= 0 ? "Ping desta pessoa até o servidor (RTT)" : "Ping não disponível neste modo ou aguardando medição"
                                        HoverHandler { id: pingHover }
                                    }
                                }
                            }

                            Repeater {
                                model: client.modelData.streams
                                delegate: ItemDelegate {
                                    id: streamRow
                                    required property var modelData
                                    readonly property bool clickable: channel.modelData.current && !client.modelData.me
                                    width: client.width
                                    height: 26
                                    leftInset: 36; rightInset: 2; topInset: 1; bottomInset: 1
                                    leftPadding: 44; rightPadding: 10
                                    background: RowHighlight { control: streamRow }
                                    hoverEnabled: clickable
                                    onClicked: if (clickable) root.streamClicked(modelData.streamIdentifier)
                                    ToolTip.visible: hovered && !streamViewers.hovered
                                    ToolTip.text: modelData.name
                                    contentItem: RowLayout {
                                        spacing: 6
                                        Icon { name: root.typeIcon(streamRow.modelData.type); size: 14; color: Theme.textDim }
                                        Label {
                                            Layout.fillWidth: true
                                            text: streamRow.modelData.name
                                            color: Theme.textDim
                                            font.pixelSize: 12
                                            elide: Text.ElideRight
                                        }
                                        // Selo e contagem no mesmo eixo; a contagem tem largura
                                        // reservada para o selo não pular quando o número muda.
                                        Rectangle {
                                            Layout.alignment: Qt.AlignVCenter
                                            Layout.preferredWidth: liveLabel.implicitWidth + 10
                                            Layout.preferredHeight: 16
                                            radius: 4
                                            color: Theme.live
                                            Label {
                                                id: liveLabel
                                                anchors.fill: parent
                                                horizontalAlignment: Text.AlignHCenter
                                                verticalAlignment: Text.AlignVCenter
                                                text: I18n.t("video.stream.live")
                                                color: "white"
                                                font.pixelSize: 9
                                                font.weight: Font.Bold
                                            }
                                        }
                                        ViewerCount {
                                            id: streamViewers
                                            Layout.alignment: Qt.AlignVCenter
                                            Layout.minimumWidth: 30
                                            streamId: streamRow.modelData.streamIdentifier
                                            count: streamRow.modelData.viewerCount
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Fundo de hover das linhas de cliente e de stream: arredondado, só sobre a área recuada.
    component RowHighlight: Rectangle {
        required property ItemDelegate control
        radius: 5
        color: control.down ? Theme.panel3 : control.hovered ? Theme.panel2 : "transparent"
    }
}
