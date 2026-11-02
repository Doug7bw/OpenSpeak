#pragma once
// Ajustes de janela que dependem da plataforma (Windows), chamados pelo QML.

#include <QAbstractNativeEventFilter>
#include <QColor>
#include <QList>
#include <QObject>
#include <QPointer>

class QWindow;

class NativeWindow : public QObject, public QAbstractNativeEventFilter {
    Q_OBJECT
public:
    using QObject::QObject;
    ~NativeWindow() override;

    /// Em tela cheia sem borda o Windows trata a janela como "app em tela cheia" e
    /// não mostra a barra de tarefas oculta automaticamente ao passar o mouse.
    /// Com a borda de 1 px (WS_BORDER) ela volta a aparecer; a borda é pintada de
    /// preto pelo app (o Windows a desenha clara conforme o tema e o foco).
    Q_INVOKABLE void setTaskbarInFullScreen(QWindow *window, bool enabled);

    /// Janela sem moldura não tem o Aero Snap: ao fim de um arrasto (startSystemMove)
    /// com o cursor no topo do monitor, maximiza como as janelas do Windows.
    Q_INVOKABLE void enableSnapToTop(QWindow *window);

    /// Maximizada, a janela sem moldura cobre o monitor inteiro quando a barra de tarefas
    /// se oculta sozinha, e o Windows a trata como "app em tela cheia": a barra não volta
    /// ao levar o mouse à borda. Deixar 1 px livre nessa borda evita isso.
    Q_INVOKABLE void keepAutoHideTaskbar(QWindow *window);

    /// Cor dos links em Markdown/RichText: o QTextDocument usa a paleta da
    /// aplicação e ignora `linkColor`/`palette` do Label.
    Q_INVOKABLE void setLinkColor(const QColor &color);

    bool nativeEventFilter(const QByteArray &eventType, void *message, qintptr *result) override;

private:
    void installFilter();
    QList<QPointer<QWindow>> m_snapWindows;
    QList<QPointer<QWindow>> m_taskbarWindows;
    QList<QPointer<QWindow>> m_borderWindows; // tela cheia com a borda de 1 px pintada de preto
    bool m_filterInstalled = false;
    bool m_sizing = false; // o laço modal atual é de redimensionar, não de mover
};
