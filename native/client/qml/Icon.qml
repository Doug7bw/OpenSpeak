import QtQuick

// Ícones SVG de traço (24x24), os mesmos da versão web, renderizados via data URL.
Item {
    id: root
    property string name: ""
    property color color: Theme.text
    property int size: 18
    implicitWidth: size
    implicitHeight: size

    readonly property var paths: ({
        screen: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
        window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
        camera: '<path d="M15 10l5-3v10l-5-3z"/><rect x="2" y="6" width="13" height="12" rx="2"/>',
        stream: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z" fill="CURRENT"/>',
        stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
        pause: '<path d="M9 6v12M15 6v12"/>',
        play: '<path d="M7 5v14l12-7z"/>',
        users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.2c2.6.2 4.5 2.6 4.5 5.8"/>',
        user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M18.60 9.98 L21.03 10.24 L21.03 13.76 L18.60 14.02 L18.09 15.24 L19.63 17.14 L17.14 19.63 L15.24 18.09 L14.02 18.60 L13.76 21.03 L10.24 21.03 L9.98 18.60 L8.76 18.09 L6.86 19.63 L4.37 17.14 L5.91 15.24 L5.40 14.02 L2.97 13.76 L2.97 10.24 L5.40 9.98 L5.91 8.76 L4.37 6.86 L6.86 4.37 L8.76 5.91 L9.98 5.40 L10.24 2.97 L13.76 2.97 L14.02 5.40 L15.24 5.91 L17.14 4.37 L19.63 6.86 L18.09 8.76Z"/>',
        github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
        download: '<path d="M12 3v12M7 10l5 5 5-5M4 16v5h16v-5"/>',
        pip: '<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1" fill="CURRENT"/>',
        pin: '<path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 14v7"/>',
        fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
        leave: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H4"/>',
        chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
        eyeOff: '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-3 3.5M6.5 7.6C4 9.3 3 12 3 12s4 6 9 6a9 9 0 0 0 3.7-.8"/>',
        eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
        focus: '<rect x="3" y="3" width="18" height="12" rx="1.5"/><path d="M3 19h4M10 19h4M17 19h4"/>',
        grid: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
        warning: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
        check: '<path d="M5 12l5 5 9-10"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
        ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
        kick: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6M16 14l5 5M21 14l-5 5"/>',
        channel: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
        server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/>',
        lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
        globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
        contacts: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/><path d="M17 4l1.2 1.2L20.5 3"/>',
        star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
        chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
        chevronRight: '<path d="M9 6l6 6-6 6"/>',
        chevronDown: '<path d="M6 9l6 6 6-6"/>',
        volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
        mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M22 9l-6 6M16 9l6 6"/>',
        quality: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
        swap: '<path d="M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7"/>',
        palette: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z"/><circle cx="7.5" cy="11" r="1.2" fill="CURRENT"/><circle cx="10.5" cy="7" r="1.2" fill="CURRENT"/><circle cx="15" cy="7.5" r="1.2" fill="CURRENT"/>',
        power: '<path d="M12 3v8"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/>',
        logo: '<path d="M11.7 9c-.6-1.2-2-2.1-2.8-3M12.3 9c1.1-2 3.2-3.8 5.1-6"/><path d="M6.5 9h11a3.5 3.5 0 0 1 3.5 3.5v4a3.5 3.5 0 0 1-3.5 3.5H9.5L5 22.5l.6-3A3.5 3.5 0 0 1 3 16.5v-4A3.5 3.5 0 0 1 6.5 9z"/><path d="M7 13l3.6 1.8v1a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1zM17 13l-3.6 1.8v1a1 1 0 0 0 1 1H16a1 1 0 0 0 1-1z" fill="CURRENT"/>'
    })

    Image {
        anchors.fill: parent
        sourceSize: Qt.size(root.size * 2, root.size * 2)
        smooth: true
        source: {
            const body = root.paths[root.name]
            if (!body)
                return ""
            const c = root.color.toString()
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + c
                    + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
                    + body.replace(/CURRENT/g, c) + '</svg>'
            return "data:image/svg+xml;utf8," + encodeURIComponent(svg)
        }
    }
}
