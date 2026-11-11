#pragma once
// Reprodução do áudio de um stream assistido (float32 48 kHz estéreo).
// Mantém a latência baixa descartando o excesso acumulado no buffer, e segue a saída
// padrão do Windows: trocou o dispositivo (fone, caixa, Bluetooth) ou a saída parou
// com erro, o player é recriado em vez de ficar mudo.

#include <QAudioDevice>
#include <QAudioSink>
#include <QIODevice>
#include <QMediaDevices>
#include <QObject>

#include <memory>

namespace openspeak {

class AudioPlayer : public QObject {
    Q_OBJECT
public:
    explicit AudioPlayer(QObject *parent = nullptr);
    ~AudioPlayer() override;

    /// Volume máximo (500%); acima de 1.0 o ganho é aplicado no PCM.
    static constexpr double kMaxVolume = 5.0;

    void write(const QByteArray &pcm);
    void setVolume(double volume);
    double volume() const { return m_volume; }

private:
    void open();
    void close();

    QMediaDevices m_devices;
    QAudioDevice m_output;
    std::unique_ptr<QAudioSink> m_sink;
    QIODevice *m_device = nullptr;
    double m_volume = 1.0;
    qsizetype m_maxBuffered = 0;
    int m_stuckWrites = 0;
};

} // namespace openspeak
