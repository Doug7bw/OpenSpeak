#include "VideoSource.h"
#include "WindowGrabber.h"

#include <QBuffer>
#include <QDateTime>
#include <QElapsedTimer>
#include <QGuiApplication>
#include <QMediaDevices>
#include <QPainter>
#include <QScreen>
#include <QtMath>
#include <QtMultimedia/private/qcapturablewindow_p.h>
#include <windows.h>
#include <dwmapi.h>

#include <iterator>

namespace openspeak {

namespace {
// Segundos de preto antes de propor a captura com borda amarela: na prévia do seletor
// troca sozinha (rápido); na transmissão pergunta, então espera mais para não incomodar
// quem só está carregando um jogo ou passando por uma tela de loading.
int blackFallbackSeconds(bool askBeforeFallback) { return askBeforeFallback ? 10 : 3; }
} // namespace

VideoSource::VideoSource(QObject *parent) : QObject(parent)
{
    m_session.setVideoSink(&m_sink);
    connect(&m_sink, &QVideoSink::videoFrameChanged, this, &VideoSource::onFrame);
    m_testTimer.setTimerType(Qt::PreciseTimer);
    connect(&m_testTimer, &QTimer::timeout, this, &VideoSource::renderTestPattern);
}

VideoSource::~VideoSource() { close(); }

QString VideoSource::appNameForWindow(quintptr id)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(reinterpret_cast<HWND>(id), &pid);
    HANDLE process = pid ? OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) : nullptr;
    if (!process)
        return {};
    wchar_t path[MAX_PATH * 2]{};
    DWORD size = DWORD(std::size(path));
    const bool ok = QueryFullProcessImageNameW(process, 0, path, &size);
    CloseHandle(process);
    if (!ok)
        return {};
    // FileDescription ("Google Chrome", "Counter-Strike 2"); sem ela, o nome do .exe.
    QString name;
    DWORD unused = 0;
    const DWORD infoSize = GetFileVersionInfoSizeW(path, &unused);
    QByteArray info(int(infoSize), Qt::Uninitialized);
    if (infoSize && GetFileVersionInfoW(path, 0, infoSize, info.data())) {
        struct { WORD language, codePage; } *translations = nullptr;
        UINT len = 0;
        if (VerQueryValueW(info.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void **>(&translations), &len) && len >= 4) {
            const QString key = QStringLiteral("\\StringFileInfo\\%1%2\\FileDescription")
                                    .arg(translations[0].language, 4, 16, QLatin1Char('0'))
                                    .arg(translations[0].codePage, 4, 16, QLatin1Char('0'));
            wchar_t *value = nullptr;
            if (VerQueryValueW(info.data(), reinterpret_cast<LPCWSTR>(key.utf16()), reinterpret_cast<void **>(&value), &len) && len > 1)
                name = QString::fromWCharArray(value).trimmed();
        }
    }
    if (name.isEmpty()) {
        name = QString::fromWCharArray(path).section(QLatin1Char('\\'), -1);
        if (name.endsWith(QLatin1String(".exe"), Qt::CaseInsensitive))
            name.chop(4);
    }
    return name.left(64);
}

bool VideoSource::fullscreenAppInForeground()
{
    const HWND hwnd = GetForegroundWindow();
    if (!hwnd)
        return false;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == GetCurrentProcessId())
        return false;
    // A área de trabalho também cobre o monitor inteiro.
    wchar_t className[64]{};
    GetClassNameW(hwnd, className, 64);
    const QString cls = QString::fromWCharArray(className);
    if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd")
        return false;
    RECT rect{};
    MONITORINFO info{sizeof(info)};
    if (!GetWindowRect(hwnd, &rect) || !GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &info))
        return false;
    return rect.left <= info.rcMonitor.left && rect.top <= info.rcMonitor.top
        && rect.right >= info.rcMonitor.right && rect.bottom >= info.rcMonitor.bottom;
}

bool VideoSource::isShareableWindow(const QCapturableWindow &window)
{
    const auto *handle = QCapturableWindowPrivate::handle(window);
    const HWND hwnd = handle ? reinterpret_cast<HWND>(handle->id) : nullptr;
    if (!hwnd || !IsWindow(hwnd) || !IsWindowVisible(hwnd) || GetAncestor(hwnd, GA_ROOT) != hwnd)
        return false;
    // Qt supplies "Window 0x..." for untitled shell surfaces. Use the actual
    // native title and styles rather than filtering localized application names.
    if (GetWindowTextLengthW(hwnd) <= 0) return false;
    const auto style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if (style & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) return false;
    if (GetWindow(hwnd, GW_OWNER) && !(style & WS_EX_APPWINDOW)) return false;
    DWORD cloaked = 0;
    if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked)
        return false;
    wchar_t className[256]{};
    GetClassNameW(hwnd, className, 256);
    const QString cls = QString::fromWCharArray(className);
    if (cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd" || cls == "Progman" || cls == "WorkerW")
        return false;
    return true;
}

QList<SourceDescriptor> VideoSource::availableSources(StreamType type)
{
    QList<SourceDescriptor> out;
    if (type == StreamType::Screen) {
        const auto screens = QGuiApplication::screens();
        for (int i = 0; i < screens.size(); ++i) {
            const QSize size = screens[i]->size() * screens[i]->devicePixelRatio();
            out.append({StreamType::Screen, QString::number(i),
                        QStringLiteral("Tela %1 (%2x%3)").arg(i + 1).arg(size.width()).arg(size.height())});
        }
    } else if (type == StreamType::Window) {
        const auto windows = QWindowCapture::capturableWindows();
        for (int i = 0; i < windows.size(); ++i) {
            const QString title = windows[i].description().trimmed();
            if (!title.isEmpty() && isShareableWindow(windows[i]))
                out.append({StreamType::Window, QString::number(i), title, false, windows[i], true});
        }
    } else if (type == StreamType::Camera) {
        for (const QCameraDevice &cam : QMediaDevices::videoInputs())
            out.append({StreamType::Camera, QString::fromUtf8(cam.id()), cam.description()});
    }
    return out;
}

bool VideoSource::open(const SourceDescriptor &desc, int targetFps)
{
    close();
    m_desc = desc;
    m_appName.clear();
    m_error.clear();

    if (desc.testPattern) {
        m_testStart = QDateTime::currentMSecsSinceEpoch();
        m_testFrame = 0;
        m_testTimer.start(1000 / std::max(1, targetFps));
        m_active = true;
        m_desc.label = QStringLiteral("Padrão de teste");
        m_captureMethod = QStringLiteral("Padrão de teste");
        return true;
    }

    if (desc.type == StreamType::Screen) {
        const auto screens = QGuiApplication::screens();
        const int idx = desc.id.toInt();
        if (idx < 0 || idx >= screens.size()) {
            m_error = QStringLiteral("no_available_source");
            return false;
        }
        // OPENSPEAK_SCREEN_CAPTURE=qt força o QScreenCapture (não inclui o cursor).
        const quintptr monitor = WindowGrabber::monitorForScreen(screens[idx]);
        if (monitor && qEnvironmentVariable("OPENSPEAK_SCREEN_CAPTURE") != QLatin1String("qt")) {
            m_grabber = WindowGrabber::forMonitor(monitor, targetFps);
            connect(m_grabber.get(), &WindowGrabber::frameReady, this, &VideoSource::onFrame);
            connect(m_grabber.get(), &WindowGrabber::methodChanged, this, [this](const QString &m) { m_captureMethod = m; });
            connect(m_grabber.get(), &WindowGrabber::fallbackRequested, this, [this, screen = QPointer<QScreen>(screens[idx])] {
                m_grabber.reset();
                if (screen)
                    startScreenCapture(screen);
            });
            m_captureMethod = QStringLiteral("Duplicação de tela (DXGI)");
            m_grabber->start();
        } else {
            startScreenCapture(screens[idx]);
        }
    } else if (desc.type == StreamType::Window) {
        const auto windows = QWindowCapture::capturableWindows();
        const int idx = desc.id.toInt();
        if ((desc.windowSpecified && !desc.window.isValid()) ||
            (!desc.windowSpecified && (idx < 0 || idx >= windows.size()))) {
            m_error = QStringLiteral("no_available_source");
            return false;
        }
        const QCapturableWindow window = desc.windowSpecified ? desc.window : windows[idx];
        const auto *handle = QCapturableWindowPrivate::handle(window);
        if (handle && handle->id)
            m_appName = appNameForWindow(handle->id);
        // OPENSPEAK_WINDOW_CAPTURE=wgc força o Windows.Graphics.Capture (com a borda amarela).
        if (handle && handle->id && qEnvironmentVariable("OPENSPEAK_WINDOW_CAPTURE") != QLatin1String("wgc")) {
            m_grabber = std::make_unique<WindowGrabber>(handle->id, targetFps);
            connect(m_grabber.get(), &WindowGrabber::frameReady, this, &VideoSource::onFrame);
            connect(m_grabber.get(), &WindowGrabber::methodChanged, this, [this](const QString &m) { m_captureMethod = m; });
            connect(m_grabber.get(), &WindowGrabber::windowClosed, this, [this] {
                emit errorOccurred(QStringLiteral("window_closed"));
                emit ended();
            });
            m_fallbackWindow = window;
            m_grabber->setBlackFallbackSeconds(blackFallbackSeconds(m_askBeforeFallback));
            connect(m_grabber.get(), &WindowGrabber::fallbackRequested, this, [this] {
                if (!m_askBeforeFallback) {
                    useAlternativeCapture();
                } else if (!m_fallbackDeclined && !m_fallbackPending) {
                    m_fallbackPending = true;
                    emit alternativeCaptureSuggested();
                }
            });
            m_grabber->start();
        } else {
            startWindowCapture(window);
        }
    } else if (desc.type == StreamType::Camera) {
        QCameraDevice device;
        for (const QCameraDevice &cam : QMediaDevices::videoInputs())
            if (QString::fromUtf8(cam.id()) == desc.id)
                device = cam;
        if (device.isNull() && desc.id.isEmpty())
            device = QMediaDevices::defaultVideoInput();
        if (device.isNull()) {
            m_error = QStringLiteral("no_available_source");
            return false;
        }
        m_camera = std::make_unique<QCamera>(device);
        // Escolhe o formato mais próximo de 1080p com FPS suficiente.
        QCameraFormat best;
        for (const QCameraFormat &f : device.videoFormats()) {
            if (f.maxFrameRate() + 0.5 < std::min(targetFps, 30))
                continue;
            if (best.isNull() || std::abs(f.resolution().height() - 1080) < std::abs(best.resolution().height() - 1080))
                best = f;
        }
        if (!best.isNull())
            m_camera->setCameraFormat(best);
        m_session.setCamera(m_camera.get());
        m_captureMethod = QStringLiteral("Câmera");
        connect(m_camera.get(), &QCamera::errorOccurred, this, [this](auto, const QString &e) { emit errorOccurred(e); });
        m_camera->start();
    }
    m_active = true;
    return true;
}

void VideoSource::setAskBeforeFallback(bool ask)
{
    m_askBeforeFallback = ask;
    if (m_grabber && m_desc.type == StreamType::Window)
        m_grabber->setBlackFallbackSeconds(blackFallbackSeconds(ask));
}

bool VideoSource::useAlternativeCapture()
{
    m_fallbackPending = false;
    if (!m_active || !m_grabber || m_desc.type != StreamType::Window || m_window)
        return false;
    qInfo() << "VideoSource: trocando para o Windows.Graphics.Capture";
    m_grabber.reset();
    startWindowCapture(m_fallbackWindow);
    return true;
}

void VideoSource::declineAlternativeCapture()
{
    m_fallbackPending = false;
    m_fallbackDeclined = true;
}

void VideoSource::close()
{
    m_testTimer.stop();
    m_grabber.reset();
    m_fallbackPending = false;
    m_fallbackDeclined = false;
    if (m_screen)
        m_screen->stop();
    if (m_window)
        m_window->stop();
    if (m_camera)
        m_camera->stop();
    m_session.setScreenCapture(nullptr);
    m_session.setWindowCapture(nullptr);
    m_session.setCamera(nullptr);
    m_screen.reset();
    m_window.reset();
    m_camera.reset();
    m_active = false;
    m_lastFrame = {};
    m_captureMethod.clear();
}

void VideoSource::startScreenCapture(QScreen *screen)
{
    m_screen = std::make_unique<QScreenCapture>();
    m_screen->setScreen(screen);
    m_session.setScreenCapture(m_screen.get());
    m_captureMethod = QStringLiteral("Tela inteira (Qt)");
    connect(m_screen.get(), &QScreenCapture::errorOccurred, this, [this](auto, const QString &e) { emit errorOccurred(e); });
    m_screen->start();
}

void VideoSource::startWindowCapture(const QCapturableWindow &window)
{
    m_window = std::make_unique<QWindowCapture>();
    m_window->setWindow(window);
    m_captureMethod = QStringLiteral("Windows.Graphics.Capture (com borda)");
    m_session.setWindowCapture(m_window.get());
    connect(m_window.get(), &QWindowCapture::errorOccurred, this, [this](auto, const QString &e) {
        emit errorOccurred(e);
        emit ended(); // janela fechada
    });
    m_window->start();
}

void VideoSource::addPreviewSink(QVideoSink *sink)
{
    if (sink && !m_previews.contains(sink))
        m_previews.append(sink);
    if (sink && m_lastFrame.isValid())
        sink->setVideoFrame(m_lastFrame);
}

void VideoSource::removePreviewSink(QVideoSink *sink) { m_previews.removeAll(sink); }

void VideoSource::transferPreviewSinksTo(VideoSource &target)
{
    for (const auto &sink : std::as_const(m_previews))
        if (sink) target.addPreviewSink(sink);
    m_previews.clear();
}

void VideoSource::onFrame(const QVideoFrame &frame)
{
    if (!frame.isValid() || !m_active)
        return;
    m_lastFrame = frame;
    m_lastSize = frame.size();
    m_previews.removeAll(nullptr);
    for (const auto &sink : std::as_const(m_previews))
        sink->setVideoFrame(frame);
    emit frameAvailable(frame);
}

void VideoSource::renderTestPattern()
{
    const int w = 1280, h = 720;
    QImage img(w, h, QImage::Format_RGBX8888);
    const double t = (QDateTime::currentMSecsSinceEpoch() - m_testStart) / 1000.0;
    QPainter p(&img);
    p.fillRect(img.rect(), QColor::fromHsl(int(t * 40) % 360, 140, 56));
    const QColor bars[] = {Qt::white, Qt::yellow, Qt::cyan, Qt::green, Qt::magenta, Qt::red, Qt::blue};
    for (int i = 0; i < 7; ++i)
        p.fillRect(QRectF(i * w / 7.0, h * 0.62, w / 7.0 + 1, h * 0.18), bars[i]);
    p.setBrush(QColor(0x16, 0xbc, 0xfb));
    p.setPen(Qt::NoPen);
    p.drawEllipse(QPointF((qSin(t * 1.7) * 0.4 + 0.5) * w, h * 0.35), h * 0.08, h * 0.08);
    p.setPen(Qt::white);
    QFont font(QStringLiteral("Consolas"));
    font.setPixelSize(h / 12);
    p.setFont(font);
    p.drawText(QPointF(w * 0.04, h * 0.14),
               QStringLiteral("OpenSpeak %1  #%2").arg(QTime::currentTime().toString(QStringLiteral("HH:mm:ss"))).arg(m_testFrame++));
    p.end();
    onFrame(QVideoFrame(img));
}

QString VideoSource::captureThumbnail(int width) const
{
    if (!m_lastFrame.isValid())
        return {};
    QImage img = m_lastFrame.toImage();
    if (img.isNull())
        return {};
    img = img.scaledToWidth(width, Qt::SmoothTransformation).convertToFormat(QImage::Format_RGB888);
    QByteArray jpeg;
    QBuffer buffer(&jpeg);
    buffer.open(QIODevice::WriteOnly);
    img.save(&buffer, "JPEG", 65);
    return QStringLiteral("data:image/jpeg;base64,") + QString::fromLatin1(jpeg.toBase64());
}

} // namespace openspeak
