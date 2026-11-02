#include "NativeWindow.h"

#include <QCoreApplication>
#include <QGuiApplication>
#include <QPalette>
#include <QWindow>
#include <QtGui/qpa/qplatformwindow_p.h>

#include <windows.h>
#include <shellapi.h>

NativeWindow::~NativeWindow()
{
    if (m_filterInstalled && QCoreApplication::instance())
        QCoreApplication::instance()->removeNativeEventFilter(this);
}

void NativeWindow::setTaskbarInFullScreen(QWindow *window, bool enabled)
{
    if (!window)
        return;
    window->create(); // a janela nativa precisa existir antes de showFullScreen()
    if (auto *native = window->nativeInterface<QNativeInterface::Private::QWindowsWindow>())
        native->setHasBorderInFullScreen(enabled);
    if (enabled && !m_borderWindows.contains(window)) {
        m_borderWindows.append(window);
        installFilter();
    }
}

void NativeWindow::enableSnapToTop(QWindow *window)
{
    if (!window || m_snapWindows.contains(window))
        return;
    m_snapWindows.append(window);
    installFilter();
}

void NativeWindow::keepAutoHideTaskbar(QWindow *window)
{
    if (!window || m_taskbarWindows.contains(window))
        return;
    m_taskbarWindows.append(window);
    installFilter();
}

void NativeWindow::installFilter()
{
    if (!m_filterInstalled) {
        QCoreApplication::instance()->installNativeEventFilter(this);
        m_filterInstalled = true;
    }
}

// Pinta de preto a área não-cliente (a borda de 1 px), sem tocar no vídeo.
static void paintBlackFrame(HWND hwnd)
{
    RECT window, client;
    if (!GetWindowRect(hwnd, &window) || !GetClientRect(hwnd, &client))
        return;
    POINT origin{0, 0};
    ClientToScreen(hwnd, &origin);
    OffsetRect(&client, origin.x - window.left, origin.y - window.top);
    OffsetRect(&window, -window.left, -window.top);
    if (HDC dc = GetWindowDC(hwnd)) {
        ExcludeClipRect(dc, client.left, client.top, client.right, client.bottom);
        FillRect(dc, &window, HBRUSH(GetStockObject(BLACK_BRUSH)));
        ReleaseDC(hwnd, dc);
    }
}

// Borda do monitor com uma barra de tarefas oculta automaticamente, ou -1.
static int autoHideTaskbarEdge(const RECT &monitor)
{
    for (UINT edge : {ABE_BOTTOM, ABE_TOP, ABE_LEFT, ABE_RIGHT}) {
        APPBARDATA data{sizeof(APPBARDATA)};
        data.uEdge = edge;
        data.rc = monitor;
        if (SHAppBarMessage(ABM_GETAUTOHIDEBAREX, &data))
            return int(edge);
    }
    return -1;
}

// Maximiza deixando 1 px livre na borda da barra. Devolve false (o Qt cuida) quando a
// área de trabalho já é menor que o monitor, ou seja, quando a barra não se oculta.
static bool leaveTaskbarEdgeFree(QWindow *window, HWND hwnd, MINMAXINFO *limits)
{
    MONITORINFO info{sizeof(MONITORINFO)};
    if (!GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &info)
        || !EqualRect(&info.rcWork, &info.rcMonitor))
        return false;
    const int edge = autoHideTaskbarEdge(info.rcMonitor);
    if (edge < 0)
        return false;
    RECT area{0, 0, info.rcMonitor.right - info.rcMonitor.left, info.rcMonitor.bottom - info.rcMonitor.top};
    switch (edge) {
    case ABE_BOTTOM: --area.bottom; break;
    case ABE_TOP: ++area.top; break;
    case ABE_LEFT: ++area.left; break;
    case ABE_RIGHT: --area.right; break;
    }
    limits->ptMaxPosition = {area.left, area.top};
    limits->ptMaxSize = {area.right - area.left, area.bottom - area.top};
    // Tratar a mensagem aqui pula o Qt, que aplicaria o tamanho mínimo da janela.
    const QSize minimum = window->minimumSize() * window->devicePixelRatio();
    limits->ptMinTrackSize = {minimum.width(), minimum.height()};
    return true;
}

void NativeWindow::setLinkColor(const QColor &color)
{
    QPalette palette = QGuiApplication::palette();
    palette.setColor(QPalette::Link, color);
    palette.setColor(QPalette::LinkVisited, color);
    QGuiApplication::setPalette(palette);
}

bool NativeWindow::nativeEventFilter(const QByteArray &eventType, void *message, qintptr *result)
{
    if (eventType != "windows_generic_MSG")
        return false;
    const MSG *msg = static_cast<const MSG *>(message);
    switch (msg->message) {
    case WM_NCPAINT:
    case WM_NCACTIVATE:
        for (const QPointer<QWindow> &window : std::as_const(m_borderWindows)) {
            if (!window || window->visibility() != QWindow::FullScreen || HWND(window->winId()) != msg->hwnd)
                continue;
            paintBlackFrame(msg->hwnd);
            *result = msg->message == WM_NCACTIVATE ? TRUE : 0;
            return true;
        }
        break;
    case WM_GETMINMAXINFO:
        for (const QPointer<QWindow> &window : std::as_const(m_taskbarWindows)) {
            if (!window || HWND(window->winId()) != msg->hwnd
                || !leaveTaskbarEdgeFree(window, msg->hwnd, reinterpret_cast<MINMAXINFO *>(msg->lParam)))
                continue;
            *result = 0;
            return true;
        }
        break;
    case WM_ENTERSIZEMOVE:
        m_sizing = false;
        break;
    case WM_SIZING:
        m_sizing = true;
        break;
    case WM_EXITSIZEMOVE: {
        if (m_sizing)
            break;
        for (const QPointer<QWindow> &window : std::as_const(m_snapWindows)) {
            if (!window || HWND(window->winId()) != msg->hwnd)
                continue;
            POINT cursor;
            MONITORINFO info{sizeof(MONITORINFO)};
            if (GetCursorPos(&cursor) && GetMonitorInfoW(MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST), &info)
                && cursor.y <= info.rcMonitor.top + 1)
                QMetaObject::invokeMethod(window, &QWindow::showMaximized, Qt::QueuedConnection);
            break;
        }
        break;
    }
    }
    return false;
}
