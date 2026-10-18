# Implementation status

**Product state:** a working automatic tiler exists as a KWin declarative script package (`package/`) with a TypeScript core (`src/`). It has been validated only in **disposable nested KWin 6.7.5 sessions** (virtual backend). No probe or build has run in the user's physical session, so it is a **candidate**, not a release.

| Field | Value |
|---|---|
| Current milestone | M3–M7 in progress; G0 and G1 passed (nested); G2 nested integration passing; G3 open |
| Completed tasks (nested evidence) | T00–T03, T05–T08 (G1: direct geometry), T09–T15, T17, T19, T21–T23, T29 |
| Partially complete | T04 (no-tiler P01/P02 done; upstream baseline in progress), T16, T18 (Wayland only), T20 (nested only), T24 (send/transfer done, follow policy not configurable), T25–T26 (schema, rules, activation; shortcut-conflict UI not built), T28 (settings dialog verified headlessly), T30 (scale/rotation/unplug nested), T32–T35 in progress |
| Not started / deferred | T27 persistence (script API has no write path: per-session layout changes are not persisted; configuration is persisted by KConfig), T31 presentation (deferred per ADR-006), T36–T37 (M8/M9) |
| Tested environment | KWin 6.7.5 (tag `ab7df7cc`), Qt 6.12.0, KF 6.30.0, Arch Linux, Linux 7.2.9 ([ENVIRONMENT](ENVIRONMENT.md)) |
| Test layers used | pure/replay (Node 26, 97 tests), nested KWin integration (`tests/integration/run.py`, 23 scenarios), real input via libei in nested KWin. **Physical session: none.** |
| Reports | [M0 probe report](M0_PROBE_REPORT.md), [script API profile](API_PROFILE.md), ADR-003 G1 record in [DECISIONS](../design/DECISIONS.md) |
| Raw results | `artifacts/` (local, gitignored). Committed summaries in [evidence/](evidence/) |
| Next eligible tasks | T16/T18/T20 remainder (XWayland, work areas, real apps), T32–T35 |

## What works (nested KWin 6.7.5, oracle-checked)

- Adoption, open/close, master/stack, BSP (rotate/mirror/equalize/reinsert), monocle, floating layout; layout switching preserves order.
- Focus/swap/move/resize/master-count commands; focus-only commands issue zero solves and zero writes; no-op commands issue zero writes.
- Requested/observed ledger: A→B→A with a 300 ms client ends at A with one bounded correction; clients that obey a larger minimum are learned once; clients that ignore requests are corrected at most twice, then left alone with an explanation.
- Minimize/fullscreen/maximize are respected (overlapping suspensions handled); native quick tile yields until `adopt-native`; toggle-float restores the latest real floating geometry; transients float.
- Real pointer/keyboard input (libei): Meta+drag preserves the model, drop on a tile swaps once, drop elsewhere snaps back, Escape cancels a KWin Move action, Meta+right-drag resize becomes the new ratio; close/unload mid-drag leave no errors.
- Two outputs with send-to-output, send-to-desktop without follow, inactive desktops placed only when shown, fractional scales 1.25–2.0, portrait rotation, output unplug with pending requests and replug.
- Configuration: flat KConfig keys + JSON overrides/rules, validated before activation; invalid input keeps the previous revision; live reload; settings dialog bound through KConfigXT (verified headlessly).
- 20 reload cycles with pending work: stable connection/window counts, one shortcut per command, no errors; idle produces no flushes, deadlines or writes.

## Measured performance (nested, `evidence/perf-p03-nested.json`, 300 samples per cell, CLOCK_MONOTONIC in QV4)

| Windows | Ratio command: dispatch→last request p50 / p95 / p99 | Solve p95 / p99 | Writes per command |
|---|---|---|---|
| 2 | 166 / 248 / 595 µs | 55 / 418 µs | 2 |
| 8 | 278 / 433 / 822 µs | 88 / 543 µs | 8 |
| 16 | 418 / 948 / 1033 µs | 135 / 675 µs | 16 |
| 32 | 678 / 1243 / 1391 µs | 208 / 794 µs | 32 |

Against the proposed budgets (PERFORMANCE §4): dispatch-to-last-request p95 ≤ 2 ms and p99 ≤ 4 ms **met** at 32 windows; pure solve p95 ≤ 0.5 ms **met**, p99 ≤ 1 ms **met**. Focus commands: zero solves/writes; their 0.6–1.0 ms is KWin's own activation call. Sample counts are below the 5000-sample tail target; p99 values are indicative. Nothing here is a physical input-to-photon measurement.

## Decisions and findings that bind the implementation

- **Direct geometry is the backend** (G1): native tiles cannot correct the dropped return-to-A configure and a structural rebuild cancelled user fullscreen.
- **Mandatory connection registry**: plain closures connected to `Workspace` signals survive unload.
- **Intent before write**: KWin emits position observations inside the `frameGeometry` setter; the ledger registers the request first.
- **Interactive drags keep their slot**: the model is preserved during the drag, no writes to the dragged window; the drop is interpreted once in the next flush (KWin reports the end of a cancelled Move before restoring the start geometry).
- **Context change resets the ledger**: KWin's output transfer emits the frame change before the output change.
- **Floating-layout contexts own no geometry**; the deadline timer is disarmed when nothing is outstanding (no idle work).
- **Settings dialog Apply does not notify the running script** (observed source: `ScriptingConfig::reload()` is a TODO in kwin v6.7.5); use the reload-configuration command or disable/enable.
- **KWin reports a 150×150 client minimum** for the fixture by default, so dense layouts overflow on small outputs; overflow floats the newest window with an explanation.
- **Escape does not cancel a pointer Meta+drag** in KWin 6.7.5 (measured); it cancels the keyboard Move action.

## Outstanding / open gates

| Item | Why open | What closes it |
|---|---|---|
| Physical session: input-to-visible latency, real outputs at 60/100/144 Hz, panels with plasmashell, activities | Needs the user's live session (a probe would also add entries to the user's `kglobalshortcutsrc`) | User-approved install into the live session; physical latency tooling |
| Upstream automatic-tiler baseline (T04) | In progress (nested Polonium) | `probes/baseline-upstream` |
| XWayland constraints (G10), layer-shell panels (O07), real applications, activities (E08), per-output desktops (O08) | In progress | `tests/integration/scenarios_*.py` |
| 100-cycle reload, 10-minute churn, idle CPU (T34) | In progress | `probes/perf/churn.py` |
| Packaging, CI, user documentation (T32, T33, T35) | In progress | `tools/install.sh`, `.github/workflows/ci.yml`, `docs/user/` |
| Persistence of per-session layout changes (T27) | The declarative script API exposes `readConfig` only | Documented limitation; a settings-helper path would be a separate decision |
| Codeberg refresh (E02) | In progress | `docs/research/CODEBERG_ADDENDUM.md` |

## Known failures

None outstanding in the committed suites (97 unit tests, 23 nested scenarios, last full run at `2d9bd60`).

## Conventions

- `artifacts/<area>/<timestamp>/` holds raw local results (may contain private metadata). Never committed.
- `docs/status/evidence/` holds redacted summaries and small reproducible raw files.
- Every probe and scenario runs in its own disposable nested KWin through `tools/nested.py`; nothing connects to, replaces or restarts the user's compositor.
- Build: `npm ci && npm run check` (typecheck, tests, bundle); `make -C fixtures/client`; `cmake -S tools/measure -B build/measure && cmake --build build/measure`; `make -C tools/input`; integration: `python3 tests/integration/run.py`.
