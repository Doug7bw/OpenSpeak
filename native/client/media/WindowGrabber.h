#pragma once
// Captura de janela sem a borda amarela do Windows.Graphics.Capture (Windows 10 não
// permite desligá-la). Híbrido, como o CroppingWindowCapturer do WebRTC:
//  A) janela sem nada por cima: duplicação da tela (DXGI) recortada na GPU;
//  B) janela coberta: PrintWindow(PW_RENDERFULLCONTENT);
//  C) preto nos dois por ~3 s (alguns jogos/D3D): emite fallbackRequested (sem parar);
//     o VideoSource troca para o QWindowCapture (com borda) ou, na transmissão,
//     pergunta antes a quem transmite.
// Também captura um monitor inteiro (forMonitor), pelo mesmo caminho A: é o que põe o
// cursor na transmissão de tela, que o QScreenCapture não inclui.

#include <QObject>
#include <QThread>
#include <QVideoFrame>

#include <memory>

class QScreen;
class QTimer;

namespace openspeak {

class WindowGrabber : public QObject {
    Q_OBJECT
public:
    WindowGrabber(quintptr hwnd, int targetFps, QObject *parent = nullptr);
    ~WindowGrabber() override;
    /// Captura o monitor (HMONITOR) inteiro. Sem quadro em ~2 s: fallbackRequested.
    static std::unique_ptr<WindowGrabber> forMonitor(quintptr monitor, int targetFps);
    /// HMONITOR da tela, ou 0 se não houver.
    static quintptr monitorForScreen(const QScreen *screen);

    void start();
    void stop();

signals:
    void frameReady(const QVideoFrame &frame);
    /// Método em uso, para as informações da transmissão ("Duplicação de tela (DXGI)"...).
    void methodChanged(const QString &method);
    void windowClosed();
    /// Monitor: sem quadro em ~2 s (já parou). Janela: preto há ~3 s (segue capturando;
    /// avisa de novo só depois de voltar a ter imagem).
    void fallbackRequested();

private:
    struct Impl;
    void tick();
    void tickMonitor();

    QThread m_thread;
    QObject *m_context = nullptr; // vive na m_thread
    QTimer *m_timer = nullptr;    // idem
    std::unique_ptr<Impl> m_impl; // usado só na m_thread
    int m_fps;
};

} // namespace openspeak
