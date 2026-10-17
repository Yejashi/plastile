#include "monotonicclock.h"

#include <time.h>

MonotonicClock::MonotonicClock(QObject *parent)
    : QObject(parent)
{
}

double MonotonicClock::nowNs() const
{
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return double(ts.tv_sec) * 1e9 + double(ts.tv_nsec);
}

double MonotonicClock::resolutionNs() const
{
    timespec ts;
    clock_getres(CLOCK_MONOTONIC, &ts);
    return double(ts.tv_sec) * 1e9 + double(ts.tv_nsec);
}
