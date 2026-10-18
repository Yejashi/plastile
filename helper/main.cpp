// plastile-state: Plastile's persistence helper (ADR-020).
//
// Started by the session bus on the first call to org.kde.plastile.State (D-Bus activation),
// it owns that name, serves Read/Write on /State and exits after an idle period; the next call
// starts it again. Owning the bus name is what makes it the only writer of the state files:
// a second instance cannot get the name and exits at once.
//
// Environment (test only, never needed in normal use):
//   PLASTILE_STATE_TEST_DELAY_MS  wait this long before processing each request (slow-helper scenarios)
//   PLASTILE_STATE_TEST_IDLE_MS   idle period before exiting (default 60000)
#include "stateservice.h"

#include <QCoreApplication>
#include <QDBusConnection>
#include <QDBusConnectionInterface>
#include <QDir>
#include <QStandardPaths>
#include <QTimer>

#include <cstdio>
#include <sys/stat.h>

namespace
{
const auto Service = QStringLiteral("org.kde.plastile.State");
const auto Path = QStringLiteral("/State");

int envInt(const char *name, int fallback, int lo, int hi)
{
    bool ok = false;
    const int v = qEnvironmentVariableIntValue(name, &ok);
    return ok ? qBound(lo, v, hi) : fallback;
}

QString stateDirectory()
{
#if QT_VERSION >= QT_VERSION_CHECK(6, 7, 0)
    const QString base = QStandardPaths::writableLocation(QStandardPaths::GenericStateLocation);
#else
    // GenericStateLocation exists from Qt 6.7; the same XDG rule by hand before that.
    QString base = qEnvironmentVariable("XDG_STATE_HOME");
    if (base.isEmpty() || !base.startsWith(u'/'))
        base = QDir::homePath() + QStringLiteral("/.local/state");
#endif
    return base + QStringLiteral("/plastile");
}
} // namespace

int main(int argc, char **argv)
{
    // Files 0600 and directories 0700 whatever the caller's umask.
    umask(077);
    QCoreApplication app(argc, argv);
    app.setApplicationName(QStringLiteral("plastile-state"));
    app.setApplicationVersion(QStringLiteral(PLASTILE_STATE_VERSION));

    QDBusConnection bus = QDBusConnection::sessionBus();
    if (!bus.isConnected()) {
        std::fprintf(stderr, "plastile-state: no session bus: %s\n", qPrintable(bus.lastError().message()));
        return 2;
    }

    StateService::Options options;
    options.directory = stateDirectory();
    options.delayMs = envInt("PLASTILE_STATE_TEST_DELAY_MS", 0, 0, 120000);
    options.idleMs = envInt("PLASTILE_STATE_TEST_IDLE_MS", 60000, 100, 3600000);
    StateService service(bus, options);

    // The object first, then the name: calls the bus queued while activating us are delivered
    // once we own the name, and must find the object.
    if (!bus.registerObject(Path, &service, QDBusConnection::ExportScriptableSlots)) {
        std::fprintf(stderr, "plastile-state: cannot register %s\n", qPrintable(Path));
        return 2;
    }
    const auto reply = bus.interface()->registerService(Service, QDBusConnectionInterface::DontQueueService,
                                                        QDBusConnectionInterface::DontAllowReplacement);
    if (!reply.isValid() || reply.value() != QDBusConnectionInterface::ServiceRegistered) {
        std::fprintf(stderr, "plastile-state: %s is already owned on this bus; exiting\n", qPrintable(Service));
        return 1;
    }

    // The bus went away (session ended, or a test's private bus stopped): nothing left to serve.
    bus.connect(QString(), QStringLiteral("/org/freedesktop/DBus/Local"), QStringLiteral("org.freedesktop.DBus.Local"),
                QStringLiteral("Disconnected"), &app, SLOT(quit()));

    // Idle: give the name back first, so the next call activates a new instance instead of
    // reaching this one while it exits; answer whatever was already routed here, then exit.
    QObject::connect(&service, &StateService::idle, &app, [&]() {
        bus.interface()->unregisterService(Service);
        QTimer::singleShot(200, &app, [&]() {
            if (!service.busy())
                app.quit(); // otherwise the idle timer runs again once the request is answered
        });
    });
    return app.exec();
}
