# Context probes: per-output desktops (O08) and activities (E08)

Nested KWin 6.7.5 only (virtual backend, private bus). Nothing here touches the live session.

- `listen.js`: a passive plain-JS KWin script that logs `PLT-LISTEN <signal> <json>` for
  `currentDesktopChanged`, `desktopsChanged`, `currentActivityChanged`, `activitiesChanged`,
  `activityAdded`, `activityRemoved` and per-window `activitiesChanged`. It uses plain closures,
  which survive unload (see API_PROFILE "Lifetime"). Use it only in a disposable session.
- `summarize.py`: turns `tests/integration/run.py` reports into
  `docs/status/evidence/contexts-o08-e08.json`, with UUIDs replaced by labels.
- Scenarios: `tests/integration/scenarios_contexts.py`. Per-output desktops use
  `[Windows] PerOutputVirtualDesktops=true` in the nested `kwinrc`. Activities run
  `/usr/lib/kactivitymanagerd` (package `kactivitymanagerd` 6.7.5) inside the nested environment.
  Its database and config land in the session's private XDG dirs.

```
python3 tests/integration/run.py --only per-output-desktops-O08,activities-E08,activities-late-service-E08,activities-add-second-E08
python3 probes/contexts/summarize.py artifacts/integration/<stamp>/report.json [more reports]
```

## Observed (measured in nested KWin 6.7.5, 2 runs each)

- `options.perOutputVirtualDesktops` reads `true` with that key.
  `setCurrentDesktopForScreen(d, o)` changes only `o`. `currentDesktopChanged` carries three
  arguments: `(previous VirtualDesktop, new VirtualDesktop, LogicalOutput)`.
  `workspace.currentDesktop` follows the active output's desktop: two samples agree, but this is
  an inference from those samples.
- Without the Activities service, `workspace.activities` is `[nil UUID]` and `currentActivity` is `""`.
  Windows report `activities == []`. With kactivitymanagerd running, `currentActivity` is a UUID
  and new windows report `[current]`.
- All activities is represented as `w.activities == []`. Plain-JS scripts have no `onAllActivities`
  property (it is undefined). The per-window `activitiesChanged` signal has no arguments.
- `AddActivity` emits `activityAdded(id)` and `activitiesChanged(id)`. `RemoveActivity` emits
  `activityRemoved(id)` and `activitiesChanged(id)`. Switching activity emits
  `currentActivityChanged(newId)` and no `currentDesktopChanged`. When the service starts, KWin
  emits only `currentActivityChanged`. Windows mapped before the service started keep
  `activities == []`, so they are on all activities.

## Defect found (Plastile, observed source + measured)

The context key collapses the activity dimension to `"default"` while `activities.length <= 1`
(`src/core/engine.ts` `singleContextKey`). Contexts are not re-keyed when the activity count
crosses 1 (`activitiesChanged` → `topologyChanged()` only marks contexts dirty).

- After a second activity appears, the existing tiled windows stay in a `"default"` context that
  `isVisible` never shows. New windows on the same activity tile over them.
- After the second activity is removed, windows keyed to the real activity overlap the new
  `"default"` windows.

The `activities-late-service-E08` and `activities-add-second-E08` scenarios fail on this defect.
