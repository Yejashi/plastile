// org.kde.plastile.State: two text slots in files, for Plastile's saved session state (ADR-020).
//
// The service never interprets the text (Plastile's TypeScript side validates the schema). It
// checks only what it must: the slot number, the size, and that a stored file becomes a valid
// D-Bus string. Requests are processed one at a time in arrival order.
#pragma once

#include <QByteArray>
#include <QDBusConnection>
#include <QDBusContext>
#include <QDBusMessage>
#include <QDBusServiceWatcher>
#include <QObject>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QTimer>

#include <deque>

class StateService : public QObject, protected QDBusContext
{
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "org.kde.plastile.State")

public:
    static constexpr int Slots = 2;
    /** Largest text accepted by Write and returned by Read, in UTF-8 bytes. */
    static constexpr qint64 MaxBytes = 1024 * 1024;

    struct Options {
        QString directory; // $XDG_STATE_HOME/plastile
        int delayMs = 0; // test only: wait this long before processing each request
        int idleMs = 60000; // exit after this long without a request and without a connected caller
    };

    StateService(const QDBusConnection &bus, Options options, QObject *parent = nullptr);

    QString slotPath(int slot) const;
    /** A request is waiting (test delay). */
    bool busy() const { return !m_queue.empty(); }

public Q_SLOTS:
    /** The stored text of slot 0 and slot 1; "" for a slot that is absent or unreadable. Always two entries. */
    Q_SCRIPTABLE QStringList Read();
    /** Atomically replace a slot's text. false when it could not be stored (see the helper's log). */
    Q_SCRIPTABLE bool Write(int slot, const QString &text);

Q_SIGNALS:
    /** No request for idleMs, none pending and no caller still on the bus: the process may exit. */
    void idle();

private:
    struct Request {
        QDBusMessage message;
        bool write = false;
        int slot = 0;
        QString text;
    };

    void enqueue(Request request);
    void processNext();
    QDBusMessage process(const Request &request);
    QString readSlot(int slot) const;
    bool writeSlot(int slot, const QByteArray &data, QString *why) const;
    bool ensureDirectory(QString *why) const;
    void touch();
    void track(const QString &caller);

    QDBusConnection m_bus;
    Options m_options;
    std::deque<Request> m_queue;
    QTimer m_delay;
    QTimer m_idle;
    /** Callers (unique bus names) still connected. KWin is one connection for the whole session; while
     *  it is on the bus the service stays, so its final Write at exit never waits on an activation. */
    QDBusServiceWatcher m_callers;
    QSet<QString> m_connected;
};
