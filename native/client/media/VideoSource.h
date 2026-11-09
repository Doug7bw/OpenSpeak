#pragma once
// Fonte de captura compartilhada por todas as sessões de um stream
// (o "lado de entrada" do ScalableSharedVideoTransformer do TS).
// Telas e câmeras via Qt Multimedia; janelas via WindowGrabber (sem a borda amarela do
// WGC), com o QWindowCapture como reserva; padrão de teste via QPainter.

#include "Protocol.h"

#include <QCamera>
#include <QCapturableWindow>
#include <QImage>
#include <QMediaCaptureSession>
#include <QObject>
#include <QPointer>
#include <QScreenCapture>
#include <QSet>
#include <QTimer>
#include <QVideoFrame>
#include <QVideoSink>
#include <QWindowCapture>

#include <memory>

namespace openspeak {

class WindowGrabber;

struct SourceDescriptor {
    StreamType type = StreamType::Screen;
    QString id;    // índice da tela, id da câmera, ou índice da janela
    QString label;
    bool testPattern = false;
    QCapturableWindow window; // Preserve the enumerated window across preview/selection.
    bool windowSpecified = false;
};

class VideoSource : public QObject {
    Q_OBJECT
public:
    explicit VideoSource(QObject *parent = nullptr);
    ~VideoSource() override;

    /// Lista as fontes disponíveis: telas, janelas e câmeras.
    static QList<SourceDescriptor> availableSources(StreamType type);
    static bool isShareableWindow(const QCapturableWindow &window);

    bool open(const SourceDescriptor &desc, int targetFps);
    void close();

    StreamType type() const { return m_desc.type; }
    QString label() const { return m_desc.label; }
    /// Programa dono da janela (descrição do .exe, ex.: "Counter-Strike 2"); vazio
    /// para telas e câmeras. Vai no `app` do stream (bot do Discord).
    QString appName() const { return m_appName; }
    static QString appNameForWindow(quintptr hwnd);
    bool isActive() const { return m_active; }
    QSize lastFrameSize() const { return m_lastSize; }

    /// Encaminha cada quadro também para estes sinks (pré-visualização na QML).
    /// Há um app em tela cheia (jogo etc.) em foco, fora o próprio OpenSpeak?
    static bool fullscreenAppInForeground();

    void addPreviewSink(QVideoSink *sink);
    void removePreviewSink(QVideoSink *sink);
    void clearPreviewSinks() { m_previews.clear(); }
    void transferPreviewSinksTo(VideoSource &target);

    /// Miniatura JPEG pequena em data URL (ThumbnailCapturer do TS).
    QString captureThumbnail(int width = 320) const;

    QString errorString() const { return m_error; }
    /// Como os quadros estão sendo capturados (informações da transmissão).
    QString captureMethod() const { return m_captureMethod; }

    /// Janela preta na captura sem borda: sem isto (prévia do seletor), troca sozinha para o
    /// WGC (com borda) depois de ~3 s; com isto ligado (transmissão), espera 10 s e emite
    /// alternativeCaptureSuggested em vez de trocar.
    void setAskBeforeFallback(bool ask);
    bool alternativeCapturePending() const { return m_fallbackPending; }
    /// Troca para o Windows.Graphics.Capture. false se não houver o que trocar.
    bool useAlternativeCapture();
    /// Mantém a captura atual e não pergunta mais nesta fonte.
    void declineAlternativeCapture();
    /// Escolha manual (opções da transmissão): janela com as duas capturas possíveis?
    bool alternativeCaptureAvailable() const;
    /// Está no Windows.Graphics.Capture (com a borda amarela)?
    bool usingAlternativeCapture() const { return m_desc.type == StreamType::Window && m_window != nullptr; }
    /// Liga (WGC, com borda) ou desliga (volta à captura sem borda). true se trocou.
    bool setAlternativeCapture(bool use);

signals:
    void frameAvailable(const QVideoFrame &frame);
    void ended();
    void errorOccurred(const QString &error);
    /// A captura da janela está preta; pergunta se troca (setAskBeforeFallback).
    void alternativeCaptureSuggested();

private:
    void onFrame(const QVideoFrame &frame);
    void renderTestPattern();
    void startWindowCapture(const QCapturableWindow &window);
    void startBorderlessWindowCapture(); // WindowGrabber em m_fallbackHwnd
    void startScreenCapture(QScreen *screen);

    SourceDescriptor m_desc;
    QString m_appName;
    bool m_active = false;
    QString m_error;
    QString m_captureMethod;
    QCapturableWindow m_fallbackWindow;
    quintptr m_fallbackHwnd = 0; // janela com captura sem borda (0: só há o WGC)
    int m_fps = 30;
    bool m_askBeforeFallback = false;
    bool m_fallbackPending = false;  // pergunta em aberto
    bool m_fallbackDeclined = false; // recusou: não pergunta mais
    QSize m_lastSize;
    QVideoFrame m_lastFrame;
    QMediaCaptureSession m_session;
    QVideoSink m_sink;
    std::unique_ptr<QScreenCapture> m_screen;
    std::unique_ptr<QWindowCapture> m_window;
    std::unique_ptr<WindowGrabber> m_grabber; // captura sem borda (WindowGrabber.h)
    std::unique_ptr<QCamera> m_camera;
    QTimer m_testTimer;
    qint64 m_testStart = 0;
    quint64 m_testFrame = 0;
    QList<QPointer<QVideoSink>> m_previews;
};

} // namespace openspeak
