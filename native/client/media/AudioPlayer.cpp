#include "AudioPlayer.h"

#include <algorithm>

namespace openspeak {

AudioPlayer::AudioPlayer(QObject *parent) : QObject(parent)
{
    connect(&m_devices, &QMediaDevices::audioOutputsChanged, this, [this] {
        if (QMediaDevices::defaultAudioOutput() != m_output)
            open();
    });
    open();
}

AudioPlayer::~AudioPlayer() { close(); }

void AudioPlayer::close()
{
    if (m_sink)
        m_sink->stop();
    m_sink.reset();
    m_device = nullptr;
    m_stuckWrites = 0;
}

void AudioPlayer::open()
{
    close();
    m_output = QMediaDevices::defaultAudioOutput();
    if (m_output.isNull())
        return;
    QAudioFormat fmt;
    fmt.setSampleRate(48000);
    fmt.setChannelCount(2);
    fmt.setSampleFormat(QAudioFormat::Float);
    m_sink = std::make_unique<QAudioSink>(m_output, fmt);
    m_sink->setBufferSize(48000 * 2 * 4 / 5); // 200 ms
    m_sink->setVolume(std::min(m_volume, 1.0));
    m_device = m_sink->start();
    // Mais que ~150 ms acumulados = atraso perceptível: descarta.
    m_maxBuffered = 48000 * 2 * 4 * 150 / 1000;
}

void AudioPlayer::write(const QByteArray &pcm)
{
    if (pcm.isEmpty())
        return;
    // Saída parada com erro (dispositivo removido, driver reiniciado): recria.
    if (!m_sink || !m_device || (m_sink->state() == QAudio::StoppedState && m_sink->error() != QAudio::NoError))
        open();
    if (!m_device)
        return;
    const qsizetype queued = m_sink->bufferSize() - m_sink->bytesFree();
    if (queued > m_maxBuffered) {
        // Buffer cheio que nunca esvazia = saída travada; ~1 s assim (50 pacotes) recria.
        if (++m_stuckWrites > 50)
            open();
        return;
    }
    m_stuckWrites = 0;
    if (m_volume <= 1.0) {
        m_device->write(pcm);
        return;
    }
    // Acima de 100% o QAudioSink não amplifica: aplica o ganho aqui, limitando o pico.
    QByteArray boosted = pcm;
    float *samples = reinterpret_cast<float *>(boosted.data());
    const qsizetype count = boosted.size() / qsizetype(sizeof(float));
    const float gain = float(m_volume);
    for (qsizetype i = 0; i < count; ++i)
        samples[i] = std::clamp(samples[i] * gain, -1.0f, 1.0f);
    m_device->write(boosted);
}

void AudioPlayer::setVolume(double volume)
{
    m_volume = std::clamp(volume, 0.0, kMaxVolume);
    if (m_sink)
        m_sink->setVolume(std::min(m_volume, 1.0));
}

} // namespace openspeak
