#include "LogStore.h"

#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QRegularExpression>

namespace openspeak {

namespace {

QString stamp() { return QDateTime::currentDateTime().toString(QStringLiteral("yyyy-MM-dd HH:mm:ss.zzz")); }

// Uma linha por registro: quebras e caracteres de controle viram espaço, para um
// cliente não forjar linhas de outro.
QString oneLine(QString s, int maxChars)
{
    if (s.size() > maxChars)
        s = s.left(maxChars) + QStringLiteral(" […]");
    for (QChar &c : s)
        if (c.unicode() < 0x20 || c.unicode() == 0x7f)
            c = QLatin1Char(' ');
    return s;
}

} // namespace

LogStore::LogStore(QString dir, int keepDays) : m_dir(std::move(dir)), m_keepDays(keepDays)
{
    QDir().mkpath(m_dir);
}

QString LogStore::safeFileName(const QString &nickname)
{
    QString s = nickname;
    for (QChar &c : s)
        if (!c.isLetterOrNumber() && c != QLatin1Char(' ') && c != QLatin1Char('.') && c != QLatin1Char('_')
            && c != QLatin1Char('-'))
            c = QLatin1Char('_');
    s = s.trimmed();
    while (s.startsWith(QLatin1Char('.')))
        s.remove(0, 1);
    if (s.isEmpty())
        s = QStringLiteral("sem-nome");
    return s.left(48);
}

void LogStore::appendServer(const QString &line)
{
    std::lock_guard lock(m_mutex);
    const QDate today = QDate::currentDate();
    if (!m_serverFile.isOpen() || m_serverDate != today) {
        m_serverFile.close();
        m_serverDate = today;
        m_serverFile.setFileName(QDir(m_dir).filePath(QStringLiteral("server-%1.log").arg(today.toString(Qt::ISODate))));
        if (!m_serverFile.open(QIODevice::Append))
            return;
    }
    m_serverFile.write((stamp() + QLatin1Char(' ') + oneLine(line, MaxLineChars * 4) + QLatin1Char('\n')).toUtf8());
    m_serverFile.flush();
}

int LogStore::appendClient(const QString &nickname, int clid, const QString &version, const QStringList &lines)
{
    std::lock_guard lock(m_mutex);
    const QDate today = QDate::currentDate();
    if (m_clientBytesDate != today) {
        m_clientBytes.clear();
        m_clientBytesDate = today;
    }
    const QString dayDir = QDir(m_dir).filePath(QStringLiteral("clients/%1").arg(today.toString(Qt::ISODate)));
    QDir().mkpath(dayDir);
    const QString path = QDir(dayDir).filePath(safeFileName(nickname) + QStringLiteral(".log"));
    qint64 &used = m_clientBytes[path];
    if (used == 0)
        used = QFileInfo(path).size(); // servidor reiniciado no meio do dia
    if (used >= ClientDailyBytes)
        return 0;
    QFile file(path);
    if (!file.open(QIODevice::Append))
        return 0;
    const QString prefix = QStringLiteral("%1 [clid %2%3] ").arg(stamp()).arg(clid)
                               .arg(version.isEmpty() ? QString() : QStringLiteral(" v") + oneLine(version, 32));
    QByteArray out;
    int written = 0;
    for (const QString &line : lines.mid(0, MaxLinesPerBatch)) {
        const QByteArray row = (prefix + oneLine(line, MaxLineChars) + QLatin1Char('\n')).toUtf8();
        if (used + out.size() + row.size() > ClientDailyBytes) {
            out += (prefix + QStringLiteral("(cota diária de registros atingida; o resto de hoje foi descartado)\n")).toUtf8();
            file.write(out);
            used = ClientDailyBytes; // esgotada: nada mais hoje
            return written;
        }
        out += row;
        ++written;
    }
    file.write(out);
    used += out.size();
    return written;
}

void LogStore::prune()
{
    std::lock_guard lock(m_mutex);
    const QDate today = QDate::currentDate();
    if (m_pruned == today)
        return;
    m_pruned = today;
    const QDate oldest = today.addDays(-m_keepDays);
    static const QRegularExpression dated(QStringLiteral("(\\d{4}-\\d{2}-\\d{2})"));
    auto tooOld = [&](const QString &name) {
        const auto m = dated.match(name);
        if (!m.hasMatch())
            return false;
        const QDate d = QDate::fromString(m.captured(1), Qt::ISODate);
        return d.isValid() && d < oldest;
    };
    QDir root(m_dir);
    for (const QString &f : root.entryList({QStringLiteral("server-*.log")}, QDir::Files))
        if (tooOld(f))
            root.remove(f);
    QDir clients(root.filePath(QStringLiteral("clients")));
    for (const QString &d : clients.entryList(QDir::Dirs | QDir::NoDotAndDotDot))
        if (tooOld(d))
            QDir(clients.filePath(d)).removeRecursively();
}

} // namespace openspeak
