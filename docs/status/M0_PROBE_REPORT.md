# M0 probe report (T00–T04)

**Layer:** every result below comes from **actual KWin 6.7.5**, run as a disposable nested `kwin_wayland --virtual` session on the reference machine ([ENVIRONMENT](ENVIRONMENT.md)). These are not mocks. They are also **not physical-session results**: the virtual backend runs a software 60 Hz timeline with no scanout and no input devices. No probe was run in the user's live session.

**Evidence labels:** *measured* (fixture, versions, clock, counts and raw files given), *observed source* (tag `ab7df7cc`), *inference*.

## 1. Tooling built

| Component | Path | Purpose |
|---|---|---|
| Nested harness | [`tools/nested.py`](../../tools/nested.py) | Private D-Bus, runtime, config and data per session; script load/unload; kglobalaccel invocation over a persistent D-Bus connection; log capture |
| Environment collector | [`tools/collect_environment.py`](../../tools/collect_environment.py) | Read-only T00 inventory |
| Capability probe | [`probes/capability`](../../probes/capability) | Runtime API introspection (T01) |
| Lifecycle probe and controls | [`probes/lifecycle`](../../probes/lifecycle) | Registry, generation guard, teardown, reload churn (T02) |
| Controlled client | [`fixtures/client`](../../fixtures/client) | Raw libwayland xdg-shell client: min/max, delayed or ignored configure, app-initiated resize, transient child, render markers, `CLOCK_MONOTONIC` JSONL log, `wp_presentation` feedback (T03) |
| Measurement module | [`tools/measure`](../../tools/measure) | Measurement-only `CLOCK_MONOTONIC` for QML probes; never part of a runtime package (T03) |
| Timing, constraints and baseline probes | [`probes/timing`](../../probes/timing) | Scheduler and dispatch timing, delayed-commit reversal, min-size behaviour, P01/P02 baselines (T03/T04) |

All timestamps share one clock domain: `CLOCK_MONOTONIC`. The harness uses Python `clock_gettime_ns`, scripts use `Plastile.Measure`, and the client uses `clock_gettime`. KWin's `wp_presentation` reports `clk_id 1` (`CLOCK_MONOTONIC`).

## 2. Clocks and scheduler (E06, E13): measured

Source: [evidence/timing-reversal.json](evidence/timing-reversal.json) (`python3 probes/timing/run.py`). Single run, idle nested KWin.

| Quantity | Result |
|---|---|
| `Date.now()` step inside KWin | 1 ms. No `performance.now()`, so sub-ms timing is impossible with script-only clocks |
| `MonotonicClock.nowNs()` call cost inside QV4 | mean 0.31 µs; back-to-back difference p50 0.28, p99 0.35 µs (20 000 calls); `clock_getres` 1 ns |
| `Qt.callLater` schedule → run | p50 2.97 µs, p95 3.16, p99 6.3, max 28.7 µs (n=200, sequential) |
| QML `Timer` interval 0 | p50 3.25 µs, p99 14.3, max 47.4 µs (n=100) |
| QML `Timer` interval 1 ms | p50 1.019 ms, p99 1.068 ms (n=100) |
| QML `Timer` interval 16 ms | p50 16.13 ms, max 16.70 ms (n=100). **Not quantized to an animation tick here.** Do not generalize to other configurations |
| `Qt.callLater` coalescing | 1000 calls with one stable function ran **once**; 1000 fresh closures ran **1000 times**. Per-call scheduling cost 0.27 µs (stable), 1.08 µs (fresh) |
| Harness D-Bus `Peer.Ping` round trip (persistent connection) | p50 54 µs, p99 73 µs (n=500) |
| `invokeShortcut` send → `ShortcutHandler.onActivated` entry | p50 305 µs, p95 372 µs, p99 438 µs, max 504 µs (n=500). **D-Bus command API, not physical input**; mostly kglobalaccel/D-Bus routing |
| One `frameGeometry` write (script-side duration) | 6.5–12 µs across the 5 reversal-test writes. Covers the property crossing and synchronous signal emission; the baselines below have larger samples |

**Consequences:** `Qt.callLater` with a stable function is a cheap, correct primitive for the coalesced lifecycle lane, as the architecture assumed. Production timing has only 1 ms resolution. Sub-millisecond engine budgets can therefore be checked only in nested sessions with the measurement module, or by amortized in-script batches.

## 3. Lifecycle and teardown (T02, E10): measured

Sources: [lifecycle-100](evidence/lifecycle-100.json), [lifecycle-300](evidence/lifecycle-300.json), [leak control](evidence/lifecycle-leak-control.json), and [reload memory controls](evidence/lifecycle-controls.json).

Each cycle:

1. Load the script, which adopts a live fixture window.
2. Invoke the shortcut once.
3. Invoke it again and unload immediately, so a 250 ms deadline timer is running and a `Qt.callLater` is queued inside `onDestruction`.
4. After teardown: invoke the shortcut, add and remove a window, and wait past the deadline.

Results:

- **100 and 300 cycles: pass.** Every cycle shows exactly one handler per activation and one coalesced flush. Teardown releases all three registered connections (`remaining=0`). No line came from any dead instance after teardown. The deadline timer and the callLater queued during destruction never ran, so no stale-rejection path was even needed. The kglobalaccel `kwin` component holds 168 names at the first cycle and the last; one name is reused across reloads.
- **Leak control: a plain closure connected to `Workspace.windowAdded` survives unload and keeps firing.** After three reloads, three dead instances' closures fired on every window add (6 firings in total). This resolves E10: explicit, registry-owned disconnection is mandatory.
- **Shortcut persistence:** the action entry stays in the session's `kglobalshortcutsrc` after unload. That is expected KDE behaviour, but a live-session probe would leave entries in the user's file.
- **Reload memory, attributed with controls** (300 cycles each, `probes/lifecycle/control.py`): an empty script grew KWin RSS +196 KiB and a shortcut-only script +264 KiB, both flat after the first cycles. An empty script plus one fixture window added and removed per cycle grew +3160 KiB, close to the full lifecycle probe's +3664 KiB, which includes the same window churn. The growth therefore tracks KWin's window create/destroy, not Plastile script reload or teardown. RSS is a coarse signal. Heap and live-object trends over long sessions remain a T34 task.
- **Not measurable:** KWin's fd count, because `kwin_wayland` has `cap_sys_nice=ep` and is non-dumpable.

## 4. Direct geometry behaviour (E03, E04): measured

Source: [timing-reversal.json](evidence/timing-reversal.json) and its [timeline](evidence/timing-reversal-timeline.jsonl). The fixture uses SSD and `--configure-delay-ms 300`, delay mode `latest`.

- **Position-only write:** `frameGeometryChanged` fires *inside* the setter, and the readback is updated immediately. A tiler's apply loop **will** be re-entered by its own writes.
- **Resize write:** no synchronous signal and an unchanged readback. KWin sends an xdg configure about 0.1 ms after the write. The client acks and commits 300 ms later, and KWin then reports the new frame. The request time, configure receipt, commit and observation are distinct, recorded events (T03 acceptance).
- **E04 reproduced: return-to-A is silently dropped while B is outstanding.**
  1. The window settled at A. Writing B made KWin configure B.
  2. 50 ms later, writing A (equal to the still-committed size) made KWin send **no configure**.
  3. The client then committed B, KWin reported B, and the window **stayed at B** (about 1.75 s, until an unrelated later request).

  Observed source agrees with this: the xdg path skips the configure when the requested client size equals the current client size. Consequence for T05/T15: the ledger must keep the outstanding-B intent, recognize the B observation as stale against the newer A target, and issue a bounded correction. "Observed equals target" is not a valid no-op test while another request is in flight.
- **An identical request (same frame)** produced no configure and no signal. That makes it cheap for KWin, but it still costs a script→C++ crossing (6.5–12 µs per write in this run), so the diff must skip it.
- **Frame vs client:** Breeze SSD adds a 28 px titlebar (frame 600×400 gives client 600×372). The isolated default configuration draws no decoration, so the harness pins Breeze.
- **Floating-point geometry:** values like `x=466.666…` and `width=400.00000000000006` were observed at scale 1. Rectangle comparison needs a tolerance.

## 5. Constraints (E07, partial): measured

Source: [constraints-minsize.json](evidence/constraints-minsize.json). The fixture declares an xdg min size of 600×400; the probe requests a 300×200 frame.

- The script sees `minSize = 600×400`, in **client** coordinates.
- **KWin does not clamp the script request:** it configures the client at 300×172.
- A client that ignores its minimum commits 300×172. A client that honours it commits 600×400, which KWin accepts silently as a 600×428 frame, with no re-configure.
- So the requested and observed frames diverge permanently unless the solver pre-clamps to `minSize + decoration margins`. Nothing loops, because KWin does not fight back; but a naive tiler that re-requests on every mismatch would.
- XWayland increment and aspect hints are not yet tested.

## 6. Native tiles and quick tile: measured

- `tile.manage(w)` returns `true` and sets `w.tile` without an immediate frame change; `unmanage` returns `true` and clears it.
- **A native quick-tile is a `Tile` association** (`w.tile !== null`). A direct `frameGeometry` write leaves it in place, and KWin then treats the next quick-tile-left as "already tiled". With `w.tile.unmanage(w)` before the direct write, P02 succeeded in 20 of 20 samples. Without it, 19 of 20 were no-ops.
- Repeating quick-tile in the current direction is a no-op on a single output (observed source: it tries to shift to the adjacent output). Left from top-left was also a no-op.
- Consequence for the direct backend: before adopting a window, check `w.tile` and release it with `unmanage`, or leave the window alone as an explicit native quick-tile (behaviour spec).

## 7. Nested no-tiler baselines (T04, partial): measured

Command: `python3 probes/timing/baseline.py --runs 3 --samples 300 --seed 1`.

**Setup.** No tiler is loaded; the timing probe performs one placement per activation on one fixture window (Breeze SSD, no client delay). Each run is a fresh nested session, with seeded 20–45 ms jitter between samples and workload order rotated per run.

**Raw data.** [summary](evidence/baseline-nested-p01-p02.json); [all 3600 samples](evidence/baseline-nested-p01-p02-samples.jsonl.gz) in the PERFORMANCE §8 schema.

**Provenance.** The run started at `49bd3d4` with `probes/timing/` not yet committed. The probe package it used is byte-identical to the one committed in `2abf0b3`; `baseline.py` is committed alongside this report, and now records `implementationDirty`.

**P01-resize — direct `frameGeometry` resize (one window, same position), alternating between two sizes**

| Metric | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| Dispatch: D-Bus send → handler | 900 | 507 µs | 697 µs | 777 µs | 896 µs |
| Write: script-side setter duration | 900 | 5.3 µs | 11.5 µs | 13.1 µs | 20 µs |
| Request → client configure | 900 | 71 µs | 121 µs | 319 µs | 370 µs |
| Request → client commit | 900 | 137 µs | 214 µs | 415 µs | 946 µs |
| Request → observed target frame | 900 | 244 µs | 371 µs | 517 µs | 1.42 ms |
| Request → `presented` (virtual timeline) | 900 | 9.25 ms | 16.7 ms | 17.6 ms | 18.0 ms |

Success 900/900. Exactly 1 configure and 1 observation per request. Per-run observed p50: 248, 262 and 222 µs.

**P01-move — direct position-only move at constant size**

| Metric | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| Dispatch: D-Bus send → handler | 898 | 493 µs | 691 µs | 800 µs | 1.00 ms |
| Write: setter duration | 898 | 63 µs | 118 µs | 230 µs | 344 µs |
| Request → observed target frame | 898 | 38 µs | 72 µs | 101 µs | 186 µs |

Success 898/898, plus 2 no-ops where the window was already at the target. No configure (0 per request). The observation is **synchronous inside the setter**, so this write time **includes the probe's own observation handler** (JSON formatting and logging). It is an upper bound on adapter cost, not a clean cost. Presentation is unattributable: there is no client commit to attach feedback to.

**P02-quicktile — `Workspace.slotWindowQuickTileLeft()` from a floating rect**

Each measured sample is preceded by an unmeasured `unmanage` plus a direct reset (reported separately in the summary as `P02-reset`).

| Metric | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| Dispatch | 900 | 522 µs | 709 µs | 806 µs | 1.28 ms |
| Slot call duration (includes synchronous move observation) | 900 | 52 µs | 86 µs | 99 µs | 154 µs |
| Request → client configure | 900 | 126 µs | 536 µs | 663 µs | 1.67 ms |
| Request → client commit | 900 | 250 µs | 675 µs | 831 µs | 3.60 ms |
| Request → final observed frame | 900 | 362 µs | 825 µs | 950 µs | 3.40 ms |
| Request → `presented` (virtual timeline) | 900 | 13.2 ms | 20.9 ms | 33.5 ms | 33.8 ms |

Success 900/900, with 1 configure per request.

**Interpretation and limits:**

- **What dominates (nested).** Script-side work is microseconds and KWin→client→KWin round trips are sub-millisecond. The time to the next presented frame dominates, at 9–13 ms median on the virtual 60 Hz timeline, as expected.
- **Native quick-tile** has a higher median and tail than a direct write to the target rect on this workload: observed p50 362 vs 244 µs, p99 950 vs 517 µs. The workloads differ in size change and decoration state, so this is a **control, not a backend verdict**. G1 needs the T05/T06 spikes on one shared workload.
- **Dispatch** (about 0.5 ms here, 0.3 ms in the idle timing run) is the D-Bus/kglobalaccel command path, not physical key-to-handler latency. The harness also scans the growing log file while waiting, which loads the CPU.
- **Presentation** values come from the virtual backend's software timeline. They say nothing about physical scanout, refresh rates of 100/144 Hz, or input-to-photon latency. Physical-session measurement is **open**.
- **Sample counts.** 900 per workload, below PERFORMANCE §6's 5000-sample target for p99 claims. Treat the p99 and max values as indicative. Use the per-run p50 spread (about ±20 µs) as the noise scale.
- **Not yet run:** an upstream automatic-tiler baseline (T04 remainder) and multi-window workloads (P03+, which need the M1 spikes).

## 8. Gate G0 assessment

| G0 criterion | Status |
|---|---|
| A controlled window can be observed and positioned | **pass (nested)** |
| Unload removes callbacks and shortcuts | **pass (nested)**, provided connections are registry-owned; a non-owned closure leaks (measured) |
| Basic timestamps can be interpreted | **pass (nested)** with the measurement module; production scripts have only 1 ms `Date.now()` |
| Output and context APIs known | **mostly.** Outputs, desktops and per-output desktop calls are verified. Activities semantics (E08), panel-aware `clientArea`, and output transfer and unplug are still open |
| No internal C++ method assumed as a script API | **pass:** every adapter operation is mapped to a runtime-verified surface ([API profile](API_PROFILE.md)) |

**G0 verdict:** passed at the nested-compositor layer for the direct and native script paths the M1 spikes need. No missing capability requires a native bridge at this point. Physical-session validation (input-to-visible, panels, real outputs, mixed refresh rates) is **open**, and so is a comparable upstream automatic-tiler baseline.

## 9. Open items carried forward

- **T04:** upstream automatic-tiler baseline (for example Polonium at the pinned commit) in a nested session, and physical-session baselines (needs the user's approval and their session).
- **E02:** Codeberg refresh not attempted.
- **E08:** the all-activities representation.
- **E16:** output identity under replug.
- XWayland constraint hints (**E07** remainder).
- Interactive move/resize, which needs an input source.
- TypeScript is not installed. T09 must pin it as a dev dependency and target the measured QV4 language level ([API profile](API_PROFILE.md#javascript-language-level-in-kwins-qv4-qt-612)).
