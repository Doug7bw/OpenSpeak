#pragma once
// Espectador do relay SFU por WebSocket, sem WebRTC (atividade do Discord, cujo
// proxy só deixa passar HTTP e WebSocket).
//
// Recebe do Forwarder o mesmo RTP já reescrito que vai para os espectadores
// WebRTC e o entrega em lotes pela conexão de sinalização do próprio cliente,
// como mensagens binárias, sempre na thread do Qt. Cada mensagem é uma sequência
// de registros [tipo u8 (0 = vídeo, 1 = áudio)][tamanho u16 BE][pacote RTP].
//
// O WebSocket é TCP: com o socket congestionado o vídeo é descartado até o
// próximo keyframe (que é pedido ao transmissor) em vez de acumular atraso.

#include "SfuForwarder.h"

#include <QByteArray>
#include <QJsonObject>
#include <QObject>

#include <functional>
#include <memory>

namespace openspeak {

class SfuWsViewer : public QObject {
    Q_OBJECT
public:
    /// Envia uma mensagem binária ao cliente e devolve os bytes ainda na fila do
    /// socket (-1 = cliente sem conexão).
    using SendFn = std::function<qint64(const QByteArray &data)>;

    /// Acima disso na fila do socket, o vídeo espera o próximo keyframe.
    static constexpr qint64 MaxPendingBytes = 512 * 1024;

    SfuWsViewer(std::shared_ptr<sfu::Forwarder> forwarder, SendFn send, QObject *parent = nullptr);
    ~SfuWsViewer() override;

    /// Sai do repasse (antes do deleteLater).
    void stop();
    /// Pedido do cliente (perda no caminho transmissor -> servidor ou erro do decodificador).
    void requestKeyFrame();
    QJsonObject mediaSnapshot() const;
    /// Saída deste espectador no Forwarder (escolha de camada do simulcast).
    const sfu::EgressSink *sink() const;

    /// O pacote RTP de vídeo (H.264) começa um keyframe (SPS ou IDR)?
    static bool isKeyFrameStart(const std::byte *data, size_t size);

private:
    class Sink;
    void flush();

    std::shared_ptr<sfu::Forwarder> m_forwarder;
    std::shared_ptr<Sink> m_sink;
    SendFn m_send;
};

} // namespace openspeak
