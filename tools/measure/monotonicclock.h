#pragma once

#include <QObject>
#include <QtQml/qqmlregistration.h>

// CLOCK_MONOTONIC timestamps for probes. Values are nanoseconds as doubles:
// exact below 2^53 ns (~104 days of uptime), which is checked by the probe.
class MonotonicClock : public QObject
{
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON

public:
    explicit MonotonicClock(QObject *parent = nullptr);

    Q_INVOKABLE double nowNs() const;
    // Resolution reported by clock_getres(CLOCK_MONOTONIC).
    Q_INVOKABLE double resolutionNs() const;
};
