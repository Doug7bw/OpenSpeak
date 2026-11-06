#pragma once
// Escolha da camada do simulcast para um espectador (lógica pura, testável).
//
// Preferência do espectador: "auto", "high" ou "low". No automático:
//  - desce para a baixa quando a banda estimada fica abaixo de DownRatio do
//    bitrate do stream por DownAfter seguidos;
//  - volta para a alta depois de UpAfter com a estimativa acima de UpRatio,
//    respeitando uma espera que dobra a cada tentativa frustrada (subiu e caiu
//    de novo em pouco tempo), para não ficar alternando.

#include <QString>

#include <algorithm>
#include <chrono>
#include <optional>

namespace openspeak::sfu {

enum class LayerPreference { Auto, High, Low };

inline LayerPreference layerPreferenceFromString(const QString &s)
{
    if (s == QLatin1String("high"))
        return LayerPreference::High;
    if (s == QLatin1String("low"))
        return LayerPreference::Low;
    return LayerPreference::Auto;
}

inline QString layerPreferenceName(LayerPreference p)
{
    switch (p) {
    case LayerPreference::High: return QStringLiteral("high");
    case LayerPreference::Low: return QStringLiteral("low");
    case LayerPreference::Auto: break;
    }
    return QStringLiteral("auto");
}

class LayerPolicy {
public:
    using Clock = std::chrono::steady_clock;

    static constexpr double DownRatio = 0.6;
    static constexpr double UpRatio = 0.85;
    static constexpr auto DownAfter = std::chrono::seconds(2);
    static constexpr auto UpAfter = std::chrono::seconds(5);
    static constexpr auto InitialBackoff = std::chrono::seconds(10);
    static constexpr auto MaxBackoff = std::chrono::seconds(120);
    /// Caiu de novo até este tempo depois de subir: a subida foi frustrada.
    static constexpr auto FailedUpWindow = std::chrono::seconds(30);

    LayerPreference preference = LayerPreference::Auto;

    /// Camada (0 = alta, 1 = baixa) para a estimativa atual do espectador.
    int step(int estimate, int configured, Clock::time_point now)
    {
        if (preference == LayerPreference::High)
            return 0;
        if (preference == LayerPreference::Low)
            return 1;
        if (m_layer == 0) {
            m_aboveSince.reset();
            if (estimate >= DownRatio * configured) {
                m_belowSince.reset();
                return 0;
            }
            if (!m_belowSince)
                m_belowSince = now;
            if (now - *m_belowSince < DownAfter)
                return 0;
            m_belowSince.reset();
            m_layer = 1;
            const bool failedUp = m_lastUp && now - *m_lastUp < FailedUpWindow;
            m_backoff = failedUp ? std::min<Clock::duration>(m_backoff * 2, MaxBackoff) : Clock::duration(InitialBackoff);
            m_upAllowedAt = now + m_backoff;
            return 1;
        }
        m_belowSince.reset();
        if (estimate < UpRatio * configured || now < m_upAllowedAt) {
            m_aboveSince.reset();
            return 1;
        }
        if (!m_aboveSince)
            m_aboveSince = now;
        if (now - *m_aboveSince < UpAfter)
            return 1;
        m_aboveSince.reset();
        m_layer = 0;
        m_lastUp = now;
        return 0;
    }

    int autoLayer() const { return m_layer; }

private:
    int m_layer = 0;
    std::optional<Clock::time_point> m_belowSince, m_aboveSince, m_lastUp;
    Clock::time_point m_upAllowedAt{};
    Clock::duration m_backoff = InitialBackoff;
};

} // namespace openspeak::sfu
