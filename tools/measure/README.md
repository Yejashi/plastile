# Plastile.Measure (measurement-only)

A one-class QML module, `MonotonicClock.nowNs()` / `resolutionNs()`, that gives probes
`CLOCK_MONOTONIC` timestamps inside KWin's QML engine. The script runtime itself only has
`Date.now()` (1 ms steps) and no `performance.now()`. The values share a clock domain with
the harness (`time.clock_gettime_ns(CLOCK_MONOTONIC)`) and the fixture client logs.

It is **not** part of any Plastile runtime package. Probes load it only in nested sessions,
via `QML_IMPORT_PATH=build/measure/qml`. A production script must not import it.

```sh
cmake -S tools/measure -B build/measure -DCMAKE_BUILD_TYPE=Release
cmake --build build/measure
```

Measured call overhead inside KWin 6.7.5 / Qt 6.12 (nested): mean about 0.32 µs per `nowNs()`
call, p99 0.55 µs (see `docs/status/evidence/timing-reversal.json`, field `scriptClock`).
