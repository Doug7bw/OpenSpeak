#pragma once
// Captura do áudio que acompanha o stream.
//  - Tela:   todo o áudio do sistema EXCETO o próprio OpenSpeak (evita eco), ou
//            EXCETO o Discord (o Windows só exclui uma árvore de processos; enquanto
//            o Discord estiver fechado, volta a excluir o OpenSpeak)
//  - Janela: apenas o áudio do processo dono da janela (pelo HWND; pidForWindow)
//  - Câmera: microfone padrão
// Usa o "process loopback" do WASAPI (Windows 10 2004+), como o
// ProcessAudioCapturer do TeamSpeak. Saída: float32 intercalado.

#include <QAudioSource>
#include <QByteArray>
#include <QIODevice>
#include <QList>
#include <QObject>
#include <QPair>

#include <atomic>
#include <memory>
#include <thread>

namespace openspeak {

class AudioCapture : public QObject {
    Q_OBJECT
public:
    enum class Mode { SystemExcludingSelf, SystemExcludingDiscord, Process, Microphone };

    explicit AudioCapture(QObject *parent = nullptr);
    ~AudioCapture() override;

    /// `pid` só é usado em Mode::Process.
    bool start(Mode mode, quint32 pid = 0);
    void stop();
    bool isRunning() const { return m_running; }

    static constexpr int SampleRate = 48000;
    static constexpr int Channels = 2;

    /// Procura o PID do processo dono de uma janela pelo título (reserva, sem HWND).
    static quint32 pidForWindowTitle(const QString &title);
    /// Processo cujo áudio acompanha a janela: o dono do HWND (num app UWP, o processo do
    /// app, não o ApplicationFrameHost), subindo até a raiz dos processos com o mesmo
    /// executável, para a árvore incluir também o processo irmão que toca o som.
    static quint32 pidForWindow(quintptr hwnd);
    struct ProcessEntry {
        quint32 pid = 0;
        quint32 parent = 0;
        QString exe;
    };
    /// Sobe de `pid` pelos pais enquanto o executável for o mesmo (sem diferenciar maiúsculas).
    static quint32 familyRoot(quint32 pid, const QList<ProcessEntry> &processes);
    /// PID do processo raiz do Discord (estável, PTB ou Canary), ou 0 se fechado.
    static quint32 discordRootPid();
    /// Entre processos (pid, pai), a raiz: o de menor PID cujo pai não está na lista.
    static quint32 rootProcess(const QList<QPair<quint32, quint32>> &processes);

signals:
    /// Amostras float32 intercaladas (SampleRate/Channels acima).
    void samplesAvailable(const QByteArray &pcm, int sampleRate, int channels);
    void errorOccurred(const QString &error);
    /// Mode::SystemExcludingDiscord: o que está sendo excluído agora ("discord" ou "self").
    void excludedChanged(const QString &excluded);

private:
    void loopbackThread(Mode mode, quint32 pid);

    std::atomic<bool> m_running{false};
    std::thread m_thread;
    std::unique_ptr<QAudioSource> m_mic;
    QIODevice *m_micDevice = nullptr;
};

} // namespace openspeak
