#pragma once
// Registros (logs) guardados no servidor, para investigar bugs depois:
//   <pasta>/server-AAAA-MM-DD.log                 o que o próprio servidor registrou
//   <pasta>/clients/AAAA-MM-DD/<apelido>.log      o que cada cliente mandou (`clientlog`)
// Um arquivo por dia; os mais velhos que `keepDays` são apagados. Cada cliente tem
// uma cota diária, para um app com defeito (ou malicioso) não encher o disco.
// Seguro entre threads: o servidor registra de qualquer thread (relay SFU).

#include <QDate>
#include <QFile>
#include <QHash>
#include <QString>
#include <QStringList>

#include <mutex>

namespace openspeak {

class LogStore {
public:
    static constexpr qint64 ClientDailyBytes = 8 * 1024 * 1024;
    static constexpr int MaxLinesPerBatch = 500;
    static constexpr int MaxLineChars = 4000;

    explicit LogStore(QString dir, int keepDays = 14);

    QString dir() const { return m_dir; }
    /// Uma linha do servidor (sem quebra no fim).
    void appendServer(const QString &line);
    /// Um lote de linhas de um cliente. Devolve quantas foram gravadas.
    int appendClient(const QString &nickname, int clid, const QString &version, const QStringList &lines);
    /// Apaga arquivos e pastas de dias mais antigos que `keepDays`.
    void prune();

    /// Apelido virando nome de arquivo seguro no Windows e no Linux.
    static QString safeFileName(const QString &nickname);

private:
    QString m_dir;
    int m_keepDays;
    std::mutex m_mutex;
    QFile m_serverFile;
    QDate m_serverDate;
    QDate m_pruned;
    QHash<QString, qint64> m_clientBytes; // arquivo do dia -> bytes gravados
    QDate m_clientBytesDate;
};

} // namespace openspeak
