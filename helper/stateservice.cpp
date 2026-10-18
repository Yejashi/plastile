#include "stateservice.h"

#include <QDBusError>
#include <QDir>
#include <QFile>
#include <QFileDevice>
#include <QLoggingCategory>
#include <QSaveFile>
#include <QStringDecoder>

Q_LOGGING_CATEGORY(lcState, "plastile.state", QtInfoMsg)

StateService::StateService(const QDBusConnection &bus, Options options, QObject *parent)
    : QObject(parent)
    , m_bus(bus)
    , m_options(std::move(options))
{
    m_delay.setSingleShot(true);
    connect(&m_delay, &QTimer::timeout, this, &StateService::processNext);
    m_idle.setSingleShot(true);
    m_idle.setInterval(m_options.idleMs);
    connect(&m_idle, &QTimer::timeout, this, [this]() {
        if (m_queue.empty())
            Q_EMIT idle();
        else
            m_idle.start();
    });
    m_idle.start();
}

QString StateService::slotPath(int slot) const
{
    return m_options.directory + QStringLiteral("/state-%1.json").arg(slot);
}

QStringList StateService::Read()
{
    Request r;
    r.message = message();
    setDelayedReply(true);
    enqueue(std::move(r));
    return {};
}

bool StateService::Write(int slot, const QString &text)
{
    Request r;
    r.message = message();
    r.write = true;
    r.slot = slot;
    r.text = text;
    setDelayedReply(true);
    enqueue(std::move(r));
    return false;
}

void StateService::touch()
{
    m_idle.start();
}

void StateService::enqueue(Request request)
{
    touch();
    m_queue.push_back(std::move(request));
    if (m_options.delayMs <= 0) {
        // No test delay: processed now, so replies leave in arrival order.
        processNext();
    } else if (!m_delay.isActive()) {
        m_delay.start(m_options.delayMs);
    }
}

void StateService::processNext()
{
    while (!m_queue.empty()) {
        Request r = std::move(m_queue.front());
        m_queue.pop_front();
        m_bus.send(process(r));
        touch();
        if (m_options.delayMs > 0) {
            if (!m_queue.empty())
                m_delay.start(m_options.delayMs);
            return;
        }
    }
}

QDBusMessage StateService::process(const Request &r)
{
    if (!r.write) {
        const QStringList texts{readSlot(0), readSlot(1)};
        qCDebug(lcState) << "Read" << texts.at(0).size() << texts.at(1).size();
        return r.message.createReply(QVariant(texts));
    }
    if (r.slot < 0 || r.slot >= Slots) {
        qCWarning(lcState) << "Write refused: slot" << r.slot << "is not 0 or 1";
        return r.message.createErrorReply(QDBusError::InvalidArgs, QStringLiteral("slot must be 0 or 1"));
    }
    const QByteArray data = r.text.toUtf8();
    if (data.size() > MaxBytes) {
        qCWarning(lcState) << "Write refused: text of" << data.size() << "bytes exceeds" << MaxBytes;
        return r.message.createErrorReply(QDBusError::InvalidArgs, QStringLiteral("text longer than 1 MiB"));
    }
    QString why;
    const bool ok = writeSlot(r.slot, data, &why);
    if (ok)
        qCDebug(lcState) << "Write" << r.slot << data.size();
    else
        qCWarning(lcState).noquote() << "Write of slot" << r.slot << "failed:" << why;
    return r.message.createReply(QVariant(ok));
}

QString StateService::readSlot(int slot) const
{
    QFile f(slotPath(slot));
    if (!f.exists())
        return {};
    if (!f.open(QIODevice::ReadOnly)) {
        qCWarning(lcState).noquote() << "cannot read" << f.fileName() << ":" << f.errorString();
        return {};
    }
    const QByteArray data = f.read(MaxBytes + 1);
    if (data.size() > MaxBytes) {
        qCWarning(lcState).noquote() << f.fileName() << "is larger than 1 MiB; treated as unreadable";
        return {};
    }
    // A D-Bus string is valid UTF-8 without NUL. Damaged bytes become U+FFFD, so Plastile still
    // sees (and reports) a damaged slot instead of an empty one.
    QStringDecoder decode(QStringDecoder::Utf8);
    QString text = decode(data);
    text.replace(QChar(u'\0'), QChar(QChar::ReplacementCharacter));
    return text;
}

bool StateService::ensureDirectory(QString *why) const
{
    QDir dir(m_options.directory);
    if (!dir.exists() && !QDir().mkpath(m_options.directory)) {
        *why = QStringLiteral("cannot create ") + m_options.directory;
        return false;
    }
    // Owner only, also for a directory created more openly before (changed only when it differs).
    const auto owner = QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner;
    const auto all = owner | QFileDevice::ReadGroup | QFileDevice::WriteGroup | QFileDevice::ExeGroup
        | QFileDevice::ReadOther | QFileDevice::WriteOther | QFileDevice::ExeOther;
    if ((QFile::permissions(m_options.directory) & all) != owner)
        QFile::setPermissions(m_options.directory, owner);
    return true;
}

bool StateService::writeSlot(int slot, const QByteArray &data, QString *why) const
{
    if (!ensureDirectory(why))
        return false;
    // QSaveFile writes a temporary file, fsyncs it and renames it onto the slot: a reader sees
    // the old text or the new text, never a torn one. The fsync blocks this process only.
    QSaveFile f(slotPath(slot));
    if (!f.open(QIODevice::WriteOnly)) {
        *why = f.errorString();
        return false;
    }
    f.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    if (f.write(data) != data.size()) {
        *why = f.errorString();
        f.cancelWriting();
        return false;
    }
    if (!f.commit()) {
        *why = f.errorString();
        return false;
    }
    return true;
}
