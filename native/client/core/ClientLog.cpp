#include "ClientLog.h"

#include "ConnectionHandler.h"
#include "Protocol.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QStandardPaths>

#include <climits>
#include <deque>
#include <mutex>

namespace openspeak {

namespace {

struct State {
    std::mutex mutex;
    QtMessageHandler previous = nullptr;
    bool installed = false;
    QString profile;
    QFile file;
    QDate fileDate;
    std::deque<QString> queue;
    int dropped = 0;
};

State &state()
{
    static State *s = new State; // nunca destruído: o Qt pode registrar algo depois do main
    return *s;
}

void enqueueLocked(State &s, const QString &line)
{
    if (int(s.queue.size()) >= ClientLog::MaxQueued) {
        s.queue.pop_front();
        ++s.dropped;
    }
    s.queue.push_back(line);
}

void pruneLocal(const QString &dir)
{
    const QDate oldest = QDate::currentDate().addDays(-7);
    QDir d(dir);
    for (const QString &name : d.entryList({QStringLiteral("openspeak*.log")}, QDir::Files)) {
        const QDate date = QDate::fromString(name.right(14).left(10), Qt::ISODate); // ...AAAA-MM-DD.log
        if (date.isValid() && date < oldest)
            d.remove(name);
    }
}

void writeLocal(State &s, const QString &line)
{
    const QDate today = QDate::currentDate();
    if (!s.file.isOpen() || s.fileDate != today) {
        s.file.close();
        s.fileDate = today;
        const QString dir = ClientLog::folder();
        QDir().mkpath(dir);
        pruneLocal(dir);
        const QString name = s.profile.isEmpty() ? QStringLiteral("openspeak-%1.log")
                                                 : QStringLiteral("openspeak-%1-%2.log").arg(s.profile);
        s.file.setFileName(QDir(dir).filePath(name.arg(today.toString(Qt::ISODate))));
        if (!s.file.open(QIODevice::Append))
            return;
    }
    s.file.write((line + QLatin1Char('\n')).toUtf8());
    s.file.flush();
}

void handler(QtMsgType type, const QMessageLogContext &context, const QString &message)
{
    State &s = state();
    static const char *const levels[] = {"D", "W", "C", "F", "I"}; // ordem do QtMsgType
    const char *level = type >= 0 && type <= QtInfoMsg ? levels[type] : "?";
    QString line = QDateTime::currentDateTime().toString(QStringLiteral("yyyy-MM-dd HH:mm:ss.zzz ")) + QLatin1String(level)
                   + QLatin1Char(' ');
    if (context.category && qstrcmp(context.category, "default") != 0)
        line += QLatin1String(context.category) + QStringLiteral(": ");
    line += message;
    line.replace(QLatin1Char('\n'), QLatin1Char(' '));
    {
        std::lock_guard lock(s.mutex);
        writeLocal(s, line);
        if (type != QtDebugMsg) // depuração fica só no arquivo local
            enqueueLocked(s, line);
    }
    if (s.previous)
        s.previous(type, context, message);
}

} // namespace

void ClientLog::install(const QString &profile)
{
    State &s = state();
    std::lock_guard lock(s.mutex);
    if (s.installed)
        return;
    s.installed = true;
    s.profile = profile;
    s.previous = qInstallMessageHandler(handler);
}

void ClientLog::uninstall()
{
    State &s = state();
    std::lock_guard lock(s.mutex);
    if (!s.installed)
        return;
    qInstallMessageHandler(s.previous);
    s.installed = false;
    s.file.close();
}

QString ClientLog::folder()
{
    return QDir(QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation)).filePath(QStringLiteral("logs"));
}

QStringList ClientLog::takePending(int maxLines, int maxBytes)
{
    State &s = state();
    std::lock_guard lock(s.mutex);
    QStringList out;
    int bytes = 0;
    if (s.dropped) {
        out << QStringLiteral("(%1 registros antigos descartados: a fila encheu enquanto desconectado)").arg(s.dropped);
        s.dropped = 0;
    }
    while (!s.queue.empty() && out.size() < maxLines) {
        const QString &line = s.queue.front();
        const int size = int(line.size()) * 2 + 8; // estimativa em JSON
        if (!out.isEmpty() && bytes + size > maxBytes)
            break;
        bytes += size;
        out << line;
        s.queue.pop_front();
    }
    return out;
}

void ClientLog::enqueueForTest(const QString &line)
{
    State &s = state();
    std::lock_guard lock(s.mutex);
    enqueueLocked(s, line);
}

ClientLog::ClientLog(ConnectionHandler *handler, QString version, std::function<bool()> enabled, QObject *parent)
    : QObject(parent), m_handler(handler), m_version(std::move(version)), m_enabled(std::move(enabled))
{
    m_timer.setInterval(5000);
    connect(&m_timer, &QTimer::timeout, this, &ClientLog::flush);
    m_timer.start();
    // Logo ao conectar, manda o que juntou desde a abertura do app.
    connect(m_handler, &ConnectionHandler::connectionChanged, this, [this] {
        if (m_handler->isConnected())
            QTimer::singleShot(1000, this, &ClientLog::flush);
    });
}

void ClientLog::flush()
{
    if (!m_handler->isConnected() || !m_handler->hasClientLogs())
        return;
    if (m_enabled && !m_enabled()) {
        takePending(MaxQueued, INT_MAX); // desligado: o que juntou não vai depois
        return;
    }
    const QStringList lines = takePending(ClientLogMaxLines);
    if (lines.isEmpty())
        return;
    m_handler->connection()->sendCommand(QStringLiteral("clientlog"),
                                         {{"version", m_version}, {"lines", QJsonArray::fromStringList(lines)}});
}

} // namespace openspeak
