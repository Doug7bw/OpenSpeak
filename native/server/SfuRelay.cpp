#include "SfuRelay.h"
#include "SfuEgress.h"
#include "SfuForwarder.h"
#include "SfuLayerPolicy.h"
#include "SfuIngest.h"
#include "SfuWsViewer.h"

#include <QLoggingCategory>
#include <QPointer>

#include <algorithm>

Q_LOGGING_CATEGORY(lcSfu, "openspeak.sfu")

namespace openspeak {

SfuRelay::SfuRelay(Options options, QObject *parent) : QObject(parent), m_options(std::move(options))
{
    m_statsTimer.setInterval(1000);
    connect(&m_statsTimer, &QTimer::timeout, this, &SfuRelay::adjustBitrates);
    m_statsTimer.start();
}

SfuRelay::~SfuRelay()
{
    QStringList ids;
    for (const auto &[id, s] : m_streams)
        ids.append(id);
    for (const QString &id : ids)
        closeStream(id);
}

void SfuRelay::setCallbacks(SignalFn signal, FailFn failed)
{
    m_signal = std::move(signal);
    m_failed = std::move(failed);
}

template <typename Session>
void SfuRelay::wire(Session *session, const QString &streamId, int clid)
{
    session->setTransport(m_options.transport);
    // Falha definitiva (reconexões esgotadas). Fila: o VirtualServer reage
    // removendo o espectador / encerrando o stream, o que volta a chamar o relay.
    QPointer<Session> guard(session);
    connect(session, &RtcSession::failed, this, [this, guard, streamId, clid] {
        auto it = m_streams.find(streamId);
        if (!guard || it == m_streams.end())
            return;
        const Stream &s = it->second;
        QObject *current = clid == s.ownerClid ? static_cast<QObject *>(s.ingest)
                                               : (s.viewers.count(clid) ? s.viewers.at(clid) : nullptr);
        if (current == static_cast<QObject *>(guard.data()) && m_failed) {
            qCWarning(lcSfu) << streamId << "sessão com" << clid << "falhou";
            m_failed(streamId, clid);
        }
    }, Qt::QueuedConnection);
}

void SfuRelay::dispose(QObject *session)
{
    if (auto *egress = qobject_cast<SfuEgress *>(session))
        egress->stop();
    else if (auto *ws = qobject_cast<SfuWsViewer *>(session))
        ws->stop();
    else if (auto *rtc = qobject_cast<RtcSession *>(session))
        rtc->close();
    session->disconnect(this);
    session->deleteLater();
}

void SfuRelay::openStream(const QString &streamId, int ownerClid, int bitrate)
{
    closeStream(streamId);
    Stream s;
    s.id = streamId;
    s.ownerClid = ownerClid;
    s.bitrate = bitrate;
    s.forwarder = std::make_shared<sfu::Forwarder>();
    auto send = [this, streamId, ownerClid](const QJsonObject &payload) {
        QMetaObject::invokeMethod(this, [this, streamId, ownerClid, payload] {
            if (m_signal)
                m_signal(streamId, ownerClid, payload);
        }, Qt::QueuedConnection);
    };
    s.ingest = new SfuIngest(streamId, ownerClid, m_options.iceServers, send, s.forwarder, this);
    SfuIngest *ingest = s.ingest;
    m_streams.emplace(streamId, std::move(s));
    wire(ingest, streamId, ownerClid);
    ingest->start();
    qCInfo(lcSfu) << "stream" << streamId << "aberto (transmissor" << ownerClid << ")";
}

void SfuRelay::updateStream(const QString &streamId, int bitrate)
{
    auto it = m_streams.find(streamId);
    if (it != m_streams.end())
        it->second.bitrate = bitrate;
}

void SfuRelay::closeStream(const QString &streamId)
{
    auto node = m_streams.extract(streamId);
    if (node.empty())
        return;
    Stream &s = node.mapped();
    for (auto &[clid, egress] : s.viewers)
        dispose(egress);
    for (auto &[clid, ws] : s.wsViewers)
        dispose(ws);
    dispose(s.ingest);
    qCInfo(lcSfu) << "stream" << streamId << "encerrado";
}

void SfuRelay::addViewer(const QString &streamId, int clid)
{
    auto it = m_streams.find(streamId);
    if (it == m_streams.end())
        return;
    removeViewer(streamId, clid);
    Stream &s = it->second;
    auto send = [this, streamId, clid](const QJsonObject &payload) {
        QMetaObject::invokeMethod(this, [this, streamId, clid, payload] {
            if (m_signal)
                m_signal(streamId, clid, payload);
        }, Qt::QueuedConnection);
    };
    auto *egress = new SfuEgress(streamId, clid, m_options.iceServers, send, s.forwarder, this);
    s.viewers[clid] = egress;
    wire(egress, streamId, clid);
    egress->start();
    qCInfo(lcSfu) << "stream" << streamId << "+ espectador" << clid << "(" << s.viewers.size() << "no total)";
}

bool SfuRelay::addWebSocketViewer(const QString &streamId, int clid)
{
    auto it = m_streams.find(streamId);
    if (it == m_streams.end() || !m_binary)
        return false;
    removeViewer(streamId, clid);
    Stream &s = it->second;
    auto send = [this, clid](const QByteArray &data) { return m_binary ? m_binary(clid, data) : qint64(-1); };
    s.wsViewers[clid] = new SfuWsViewer(s.forwarder, send, this);
    qCInfo(lcSfu) << "stream" << streamId << "+ espectador WebSocket" << clid;
    return true;
}

void SfuRelay::setBinarySender(BinaryFn send) { m_binary = std::move(send); }

void SfuRelay::removeViewer(const QString &streamId, int clid)
{
    auto it = m_streams.find(streamId);
    if (it == m_streams.end())
        return;
    it->second.layers.erase(clid);
    if (auto ws = it->second.wsViewers.find(clid); ws != it->second.wsViewers.end()) {
        SfuWsViewer *viewer = ws->second;
        it->second.wsViewers.erase(ws);
        dispose(viewer);
    }
    auto viewer = it->second.viewers.find(clid);
    if (viewer == it->second.viewers.end())
        return;
    SfuEgress *egress = viewer->second;
    it->second.viewers.erase(viewer);
    dispose(egress);
}

void SfuRelay::signaling(const QString &streamId, int fromClid, const QJsonObject &payload)
{
    auto it = m_streams.find(streamId);
    if (it == m_streams.end())
        return;
    Stream &s = it->second;
    if (fromClid == s.ownerClid) {
        s.ingest->onSignalingMessage(payload);
        return;
    }
    if (payload.value("type").toString() == QLatin1String("layer")) {
        // Espectador escolheu a qualidade (simulcast).
        if (!s.viewers.count(fromClid) && !s.wsViewers.count(fromClid))
            return;
        s.layers[fromClid].policy.preference = sfu::layerPreferenceFromString(payload.value("preference").toString());
        adjust(s, false);
        return;
    }
    auto viewer = s.viewers.find(fromClid);
    if (viewer != s.viewers.end())
        viewer->second->onSignalingMessage(payload);
    auto ws = s.wsViewers.find(fromClid);
    if (ws != s.wsViewers.end() && payload.value("type").toString() == QLatin1String("keyframe"))
        ws->second->requestKeyFrame();
}

void SfuRelay::resumePeer(int clid)
{
    for (auto &[id, s] : m_streams) {
        if (s.ownerClid == clid)
            s.ingest->restart();
        auto viewer = s.viewers.find(clid);
        if (viewer != s.viewers.end())
            viewer->second->restart();
    }
}

QJsonArray SfuRelay::monitoringSessions()
{
    QJsonArray sessions;
    for (auto &[id, s] : m_streams) {
        auto ingest = s.ingest->mediaSnapshot();
        ingest["layers"] = QJsonArray{s.forwarder->hasLayer(sfu::HighLayer), s.forwarder->hasLayer(sfu::LowLayer)};
        ingest["streamId"] = id;
        ingest["clid"] = s.ownerClid;
        ingest["role"] = "publisher";
        sessions.append(ingest);
        for (auto &[clid, egress] : s.viewers) {
            auto viewer = egress->mediaSnapshot();
            viewer["layer"] = s.forwarder->sinkLayer(egress->sink());
            if (const auto l = s.layers.find(clid); l != s.layers.end())
                viewer["layerPreference"] = sfu::layerPreferenceName(l->second.policy.preference);
            viewer["streamId"] = id;
            viewer["clid"] = clid;
            viewer["role"] = "viewer";
            sessions.append(viewer);
        }
        for (auto &[clid, ws] : s.wsViewers) {
            auto viewer = ws->mediaSnapshot();
            viewer["streamId"] = id;
            viewer["clid"] = clid;
            viewer["role"] = "viewer";
            sessions.append(viewer);
        }
    }
    return sessions;
}

void SfuRelay::adjustBitrates()
{
    for (auto &[id, s] : m_streams)
        adjust(s, true);
}

void SfuRelay::adjust(Stream &s, bool collect)
{
    const auto now = LayerPolicy::Clock::now();
    // Simulcast só com as duas camadas chegando; sem ele, uma qualidade para
    // todos: o transmissor segue o espectador mais limitado (com piso).
    const bool simulcast = s.forwarder->hasLayer(sfu::HighLayer) && s.forwarder->hasLayer(sfu::LowLayer);
    if (simulcast != s.simulcast) {
        s.simulcast = simulcast;
        qCInfo(lcSfu) << "stream" << s.id << (simulcast ? "simulcast ativo (2 camadas)" : "uma camada só")
                      << "alta" << s.forwarder->hasLayer(sfu::HighLayer) << "baixa" << s.forwarder->hasLayer(sfu::LowLayer);
    }
    int high = s.bitrate, low = s.bitrate;
    bool anyHigh = false;
    for (auto &[clid, egress] : s.viewers) {
        if (collect)
            egress->collectStats(s.bitrate);
        ViewerLayer &v = s.layers[clid];
        const int estimate = egress->estimatedBitrate();
        const int layer = simulcast ? v.policy.step(estimate, s.bitrate, now) : sfu::HighLayer;
        s.forwarder->setSinkLayer(egress->sink(), layer);
        if (egress->state() == RtcSession::State::Connected) {
            // Quem forçou a alta assume o risco: a banda dele não puxa a camada
            // dos outros para baixo.
            if (layer == sfu::HighLayer && (!simulcast || v.policy.preference == LayerPreference::Auto)) {
                high = std::min(high, estimate);
                anyHigh = true;
            } else if (layer == sfu::LowLayer) {
                low = std::min(low, estimate);
            }
        }
        reportLayer(s, clid, v, simulcast, layer);
    }
    for (auto &[clid, ws] : s.wsViewers) {
        // Sem RR/REMB: alta, a não ser que o espectador peça a baixa.
        ViewerLayer &v = s.layers[clid];
        const int layer = simulcast && v.policy.preference == LayerPreference::Low ? sfu::LowLayer : sfu::HighLayer;
        s.forwarder->setSinkLayer(ws->sink(), layer);
        reportLayer(s, clid, v, simulcast, layer);
    }
    if (!collect)
        return;
    const int floor = simulcast ? std::max(MinTargetBitrate, int(s.bitrate * HighLayerFloor)) : MinTargetBitrate;
    high = anyHigh ? std::max(high, std::min(floor, s.bitrate)) : s.bitrate;
    s.forwarder->requestBitrate(sfu::HighLayer, unsigned(high));
    if (simulcast) // o transmissor limita ao bitrate próprio da camada baixa
        s.forwarder->requestBitrate(sfu::LowLayer, unsigned(std::max(low, 150'000)));
}

void SfuRelay::reportLayer(Stream &s, int clid, ViewerLayer &v, bool simulcast, int layer)
{
    if (v.sent == layer && v.sentSimulcast == simulcast && v.sentPreference == v.policy.preference)
        return;
    v.sent = layer;
    v.sentSimulcast = simulcast;
    v.sentPreference = v.policy.preference;
    const QJsonObject payload{{"type", "layer"}, {"simulcast", simulcast},
                              {"layer", layer == sfu::LowLayer ? "low" : "high"},
                              {"preference", sfu::layerPreferenceName(v.policy.preference)}};
    // Pela fila: o contrato do StreamRelay não chama de volta de dentro de signaling().
    QMetaObject::invokeMethod(this, [this, streamId = s.id, clid, payload] {
        if (m_signal)
            m_signal(streamId, clid, payload);
    }, Qt::QueuedConnection);
}

} // namespace openspeak
