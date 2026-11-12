#pragma once
// Registros (logs) do app, para investigar bugs:
//  - tudo que o app registra (qInfo/qWarning/qCInfo...) vai para um arquivo por dia
//    na pasta de dados do usuário (logs/openspeak-AAAA-MM-DD.log, 7 dias);
//  - e, se o servidor anunciar CLIENT_LOGS e o usuário não desligar nas configurações,
//    as linhas de informação para cima vão em lotes para o servidor (`clientlog`).
// O que se perde enquanto desconectado fica numa fila limitada e vai na próxima conexão.

#include <QObject>
#include <QStringList>
#include <QTimer>

#include <functional>

namespace openspeak {

class ConnectionHandler;

class ClientLog : public QObject {
    Q_OBJECT
public:
    /// Instala o tratador de mensagens do Qt. `profile` separa o arquivo de cada perfil.
    static void install(const QString &profile = {});
    static void uninstall();
    /// Pasta dos arquivos locais.
    static QString folder();

    static constexpr int MaxQueued = 5000;
    static constexpr int MaxBatchBytes = 256 * 1024; // cabe com folga numa mensagem do servidor

    /// Linhas ainda não enviadas, no máximo `maxLines`/`maxBytes` (mais antigas primeiro).
    static QStringList takePending(int maxLines, int maxBytes = MaxBatchBytes);
    /// Só para os testes: enfileira como se viesse do Qt.
    static void enqueueForTest(const QString &line);

    /// Envia a fila ao servidor a cada poucos segundos enquanto `enabled()` for verdadeiro.
    ClientLog(ConnectionHandler *handler, QString version, std::function<bool()> enabled, QObject *parent = nullptr);

    void flush();

private:
    ConnectionHandler *m_handler;
    QString m_version;
    std::function<bool()> m_enabled;
    QTimer m_timer;
};

} // namespace openspeak
