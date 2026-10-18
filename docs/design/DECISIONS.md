# Architecture decisions

These are initial decisions and experiment gates. They describe the intended implementation, not existing code. Change a decision by recording evidence, alternatives, and consequences here.

## ADR-001: Preserve KWin; implement a tiling policy inside Plasma

**Status:** accepted direction.

Plastile preserves the Plasma Wayland session and KWin. Replacing KWin with i3/bspwm is an X11 integration path, not the target product. A compositor fork would substantially expand ownership into rendering, input, protocols, and distro maintenance. None of that is required to establish fast tiling behavior.

**Consequence:** the product must fit the actual KWin API and asynchronous client model. When an API is missing, demonstrate the limitation and add a narrow bridge or revise scope; do not invent an unsupported external Wayland geometry API.

## ADR-002: Start with a TypeScript core and declarative KWin adapter

**Status:** accepted starting architecture; performance-gated.

Use TypeScript for pure policy/layout code, compiled to the module format supported by the target Qt runtime. Use a small declarative root for workspace services, shortcut ownership, scheduling, and lazy QML UI. Node is only a build/test tool. This minimizes installation complexity and supports deterministic replay.

**Alternatives:** all-C++ effect; daemon plus effect; Rust/C++ native plugin; KWin fork. These may provide capabilities but also introduce ABI, threading, serialization, build, and lifetime work.

**Revisit if:** the measured core or adapter cannot meet M1/M3 budgets after fixing redundant work; the script API cannot correctly distinguish important requested/committed transitions; or an essential feature needs compositor rendering/input hooks. The migration decision must identify a specific limitation and compare a minimal native spike. Compiled code is not presumed faster end to end.

## ADR-003: Direct geometry is provisional; compare native tiles early

**Status:** provisional, resolved by G1 in M1.

Begin with a direct geometry adapter for a small prototype. It has a clear single owner, supports arbitrary pure layouts, and exposes the request ledger needed for correctness. Build a second small application path using native roots and stable tile mutations with the same fixture/core.

**Choose one production default at G1.** Direct geometry wins unless native tiles demonstrate a material correctness/integration advantage and satisfy latency/churn budgets. Native tiles win if their connected resize/state semantics avoid reproduced direct-path failures without unacceptable tree mutation or editor conflicts. The comparison must include rapid A→B→A resize reversal, output changes, min-size clients, no-op commands, and unload.

**Consequence of native choice:** define exclusive root ownership, native-editor adoption, tile ID mapping, activity projection, and snapshot/restore before shipping. Use `manage/unmanage`, not deprecated property assignment. Implement an incremental structural diff rather than re-creating the entire tree each time.

**Consequence of direct choice:** keep requested/observed geometry separate; yield to native quick tiling until explicit adoption; record API limitations. Do not ship an unused second backend merely because it was prototyped.

### G1 resolution (2026-10-17): direct geometry selected

**Status:** accepted at the nested-compositor layer. KWin 6.7.5 (tag `ab7df7cc`), Qt 6.12.0, virtual backend, 1280×800.

**Workload.** Both spikes (`probes/spikes`) share one core: adoption, order, master/stack solve, commands, and a coalesced flush. They ran the same experiment script, `probes/spikes/run.py --reps 10`:

- three controlled fixture clients, one of which delays every commit by 300 ms;
- no-op, focus, ratio, swap and A→B→A reversal commands;
- a burst create/remove;
- a client that obeys its own minimum size;
- user fullscreen and native quick-tile actions;
- 10 reloads with pending work.

Correctness is judged by an independent oracle: one-shot KWin scripts reading the real window state. Raw results: [`spike-direct.json`](../status/evidence/spike-direct.json), [`spike-native.json`](../status/evidence/spike-native.json).

**Results.**

| Experiment | Direct (ledger) | Native tiles |
|---|---|---|
| No-op ×10 | 0 writes | 0 mutations |
| Focus ×10 | 0 solves, 0 writes | 0 solves, 0 mutations |
| Ratio step ×10 | 30 frame writes (3 per step) | 10 `resizeByPixels`, 30 tile geometry signals |
| Swap ×4 | 8 writes | 8 `manage`, 16 tile window signals |
| **A→B→A with delayed client ×5** | **final A 5/5**, using exactly 1 bounded correction per reversal | **final B 5/5: tile at A, window stuck at B.** KWin drops the return-to-A configure (M0 E04) and the native path has no script lever to correct it |
| Burst +3 / −3 windows | 2 solves each; 10 and 6 writes | 8 splits, 4 removes, 8 relative-geometry writes (+3); 9 splits, 6 removes (−3); the spike projector also produced overlaps |
| User fullscreen | respected; layout restored afterwards | **the structural rebuild after the window count changed cancelled the user's fullscreen** and floated the window |
| User native quick-tile | yielded (window kept its quick-tile rect) | quick-tile-left did not take effect on a custom-tiled window |
| Reload ×10 with pending work | no errors | no errors |

Native tile frames also differ from the plan by about 2 px, because KWin rounds tile geometry itself. Shared-edge ownership therefore moves into KWin.

**Decision.** Direct geometry is the production backend. Native tiles do not avoid the reproduced direct-path failure, because the same xdg configure skip affects them. They add structural mutation churn and harmful side effects on user state, and they conflict with native quick-tile. The native spike stays in `probes/spikes/native` as evidence only. No native tile backend ships.

**Native capability spike (T08):** not required. The one reproduced limitation, the dropped return-to-A configure, is handled within the script API by the requested/observed ledger: an outstanding-request memory plus a bounded correction on the stale observation. No other script-API gap blocked the experiments.

**Remaining limitations.**
- The comparison is nested-only. A physical-session repeat is part of G3.
- The native projector was a simple rebuild-on-count-change design. A cleverer incremental projector might reduce churn, but it could not fix the reversal or the fullscreen side effect.
- A direct-backend client that obeys a minimum larger than its slot stays "outstanding" in the spike. The production ledger needs a deadline and constraint learning (T15/T18).

## ADR-004: One pure model; one geometry writer

**Status:** accepted.

The core owns policy, order, layouts, context membership, and desired placement. The adapter owns live KWin object references and all external mutation. Presentation owns optional visual transitions. Configuration owns validated snapshots. A helper may persist or inspect, but cannot independently retile windows.

**Reason:** distributed shadow state and multiple writers create oscillation, stale restoration, and difficult latency attribution. Upstream workarounds show why ownership must be explicit.

## ADR-005: Immediate commands; coalesced lifecycle invalidation

**Status:** accepted.

Commands run immediately when the runtime is not applying. Commands during apply are queued in order. Lifecycle events update/stage state and mark full contexts dirty. One stable scheduled flush processes accumulated invalidations. There is no normal-path fixed 10/50/100 ms wait and no trailing debounce for all tiling.

**Reason:** batching reduces repeated solves, while a quiet-period delay can make responsiveness depend on unrelated activity. Genuine removals and context changes must survive self-event suppression.

**Revisit:** only if a measured toolkit/KWin ordering issue requires a scoped bounded deferral. Each exception needs a named reason, deadline, cancellation, test, and measured cost.

## ADR-006: Instantaneous geometry first; optional presentation later

**Status:** accepted.

Default animation duration is zero. Do not implement animation by repeatedly assigning intermediate real window sizes. An optional effect may animate visual transforms and retarget from the current visual state, while commands remain immediate.

**Reason:** snappiness and client redraw cost must be measured before introducing animation. “Smooth” and “low latency” are distinct measurements.

## ADR-007: Automatic tiling first; scrolling and zones later

**Status:** accepted scope order.

Deliver master/stack, persistent BSP, monocle, and floating with shared state/constraints. Add scrolling as a separate viewport model after basic release gates pass. Add zone selection/editor as a later frontend to the same commands/geometry model.

**Reason:** scrolling adds off-screen visibility, input, focus, clipping, and multi-output questions. Manual zones add UI and do not solve automatic insertion. Combining all modes at the start would delay correctness and make latency attribution harder.

## ADR-008: Configuration is validated data

**Status:** accepted.

Use a schema with global settings, context overrides, ordered rules, and stable command IDs. Parse/validate/compile at activation; publish an immutable configuration revision. Initial custom layouts use bounded declarative split/zone data. Arbitrary user JavaScript inside KWin is outside initial scope.

**Future extension gate:** a native/daemon extension environment must have instruction/time/memory limits, input/output validation, cancellation, deterministic fallback, and a defined trust model. A try/catch block cannot stop an infinite JavaScript loop in the compositor.

## ADR-009: Multiple contexts have explicit conservative semantics

**Status:** accepted initial policy.

The default layout unit is `(output identity, desktop ID, activity ID)`. Pinned/all-desktop and multi-activity windows float by default unless a later policy explicitly assigns one visible geometry authority. An output's currently visible desktop is discovered through the appropriate API rather than assumed to be global.

**Reason:** one real window cannot simultaneously occupy conflicting rectangles. Native tile roots do not include activity identity. Avoid hidden ambiguity in the first release.

## ADR-010: Measure before language or data-structure rewrites

**Status:** accepted.

Separate policy, scheduler, adapter, configure, client commit, render, and presentation timing. Use matched baselines and counters. Pure tests run in Node and, for performance claims, the actual QV4 runtime. Start with simple maps/arrays and O(n) solves; introduce indices/caches only for a measured need and test their invalidation.

## ADR-011: Minimal persistence and no synchronous command-path service

**Status:** accepted.

Persist configuration, layout preferences, ratios/order hints, and user float choices as available. Session IDs are not cross-login identity. Script-only builds must not pretend to offer arbitrary file writes; use the supported settings path or an optional small helper with asynchronous versioned messages. The last valid in-memory configuration remains usable if the helper dies.

## ADR-012: License and upstream reuse are deliberate

**Status:** accepted process; project license remains an owner decision.

Research links and original design descriptions are not a decision to copy upstream implementations. The sampled repositories include MIT, GPL-family, and mixed component notices. Keep original code as the default; any port must identify file-level notices and the resulting distribution obligations before inclusion. Do not silently assign a new project license to someone else's source. The planning commit does not choose the final software license.

## ADR-013: Persist session preferences through QtCore Settings

**Status:** accepted direction (2026-10-18); implementation is task T27.

**Context.** ADR-011 asked for persistence through a supported settings path or an optional helper, and the
earlier status listed T27 as blocked because the script API offers only `readConfig`. Experiment E12 found
a supported path inside the script: QtCore's `Settings` QML type is a public Qt API. Plasma's own QML
packages already depend on it, so it is installed on a Plasma desktop. In nested KWin 6.7.5 a declarative
script wrote a value and a JSON blob to a file under `StandardPaths.GenericStateLocation`. After unload and
reload the script read back exactly what it had written
([probe](../../probes/persistence/run.py), [evidence](../status/evidence/persistence-t27.json)).

**Decision.** Persist only a small, versioned, validated snapshot: per-context layout preferences (layout
kind, master ratio and count, column/zone choices) and user float decisions/geometry keyed conservatively by
application identity. Store it as one JSON string under `$XDG_STATE_HOME/plastile/`. Load it once at adoption
and validate and migrate it there, falling back to ordinary defaults on anything invalid. Never key it by
session window ids. The write is synchronous file I/O on the compositor thread, so it is maintenance work
(ARCHITECTURE §7): debounced, only when the snapshot changed, never on the command path, and cancelled on
unload.

**Consequences.** No helper process and no D-Bus service. A missing QtCore module or an unwritable file
leaves Plastile working in memory and reports one diagnostic. Configuration stays in KConfig (`readConfig`).
The persisted file is state, not configuration: deleting it resets layout preferences only.

### Implementation (T27, 2026-10-18)

`package/contents/ui/Persistence.qml` creates two QtCore `Settings` objects inside `Qt.createQmlObject`, so a
missing or broken module throws there and Plastile runs in memory with one diagnostic. Each has an explicit
location, `StandardPaths.GenericStateLocation` + `/plastile/state-0.ini` and `state-1.ini`, and one value,
`[plastile] snapshot`. The snapshot (`src/persist/snapshot.ts`) is `{schemaVersion, generation, savedAt,
contexts: [{outputKey, desktopId, activity, layout, masterStack}], floats: [{appId, resourceName, role, rect,
outputKey, area}]}`, at most 64 entries of each. Contexts come from `Engine.contextPreferences()`. Floats are
recorded only when the user floats a window with *Toggle floating*, and are forgotten when the user tiles it again.
Any invalid field rejects the whole snapshot. Migrations (`src/persist/migrate.ts`) are pure per-version steps.
Version 1 is the first schema, so the chain is still empty, and a newer schema is rejected.

At load the runtime reads both slots before the first solve and applies the valid one with the highest generation.
It logs one line if any slot was rejected. If a slot holds a newer schema, nothing is written that session, which
keeps that file intact for the newer Plastile. A saved float is given to a window only when exactly one live window
has its `appId`/`resourceName`/`role` (Q06, `src/persist/match.ts`). Otherwise the window gets ordinary insertion
and the saved float waits.

A change only marks the state dirty. A one-shot timer writes the snapshot 2 s after the last change: it is re-armed
on later changes, never periodic, and also re-armed while a window is being moved or resized. A clean unload writes
once. A write goes to the slot not loaded or last written, with the next generation, and is skipped when the content
is unchanged. A torn or damaged slot therefore leaves the previous one usable. QSettings itself replaces the file
atomically: inotify shows the text written to an `O_TMPFILE` and then linked (new file) or renamed (existing file)
onto the slot, never written in place (scenarios `persist-reload-restart-T27`, `persist-reload-cycles-Q09`).

### Measured addendum: the cost of in-process saves (2026-10-18)

The numbers come from `probes/persistence/cost/run.py` ([evidence](../status/evidence/persistence-t27-cost.json)).
The setup was nested KWin 6.7.5 with Qt 6.11.2, the virtual backend and the production `Persistence.qml`. State
files were on ext4 on a virtio disk. The clock was `CLOCK_MONOTONIC` from `tools/measure`. Another nested suite may
have shared the 4 CPUs.

| What | p50 | p95 | p99 | max | n |
|---|---|---|---|---|---|
| `setValue` (any size) | 0.01 ms | | | 0.15 ms | 750 |
| `sync()`, 1 KiB text | 1.59 ms | 2.17 ms | 3.63 ms | 10.7 ms | 250 |
| `sync()`, 16 KiB | 2.19 ms | 4.04 ms | 5.55 ms | 7.3 ms | 250 |
| `sync()`, 64 KiB | 3.60 ms | 6.03 ms | 7.85 ms | 13.2 ms | 250 |
| Production save (277-byte snapshot) | 3.6 ms | | | 19.5 ms | 3 |
| Load: `open()` (first load in a KWin process) / both slot reads | 3.2 ms / 0.12 ms | | | | 1 |
| Load on reload, two 64 KiB slots: `open()` / reads | 0.78 / 0.09 ms | 0.96 / 0.32 ms | | 1.09 / 1.06 ms | 19 |

Every one of the 750 measured `sync()` calls took longer than 1 ms. The cost is mostly fixed. A 1 KiB text already
costs 1.6 ms, consistent with the `fsync` that `QSaveFile::commit` performs (inference: `fsync` itself was not timed).
A full snapshot is about 25 KB under the 64-entry caps.

Commands do no file I/O. Over 123 preference-changing commands in three bursts, no event in the state directory fell
inside a command handler's measured interval or within 1.5 s after one. Each burst produced exactly one save, about
2 s after its last command. Handler time, `markDirty` included, was p50 0.48 ms and p99 1.21 ms. The scenario
`persist-reload-restart-T27` repeats the inotify check.

Lock behaviour: QSettings takes a `QLockFile` (`state-N.ini.lock`) for each save. With a stale lock (dead process)
the save took 2.5 ms. With the lock held by a live process of the matching name, the save blocked the compositor
thread for **31.9 s**, QLockFile's 30 s stale-lock time (n=1).

**Decision.** In-process saves stay (option A), with these costs on record. They exceed the 1 ms target the gap
analysis proposed for this choice.

- A save stalls the compositor thread for about 2–8 ms, up to 20 ms observed. That is enough to miss a frame when
  it lands on a frame deadline.
- A save never runs inside a command (measured), never while a window is dragged, and never when nothing changed.
  It runs at most once per quiet period after a preference change: typically a few times per session, not per
  keypress.
- KWin saves its own tile layouts the same way: a 2 s single-shot timer, then `KConfig::sync()` on the compositor
  thread (observed source: kwin v6.7.5 `src/tiles/tilemanager.cpp:61-64, 390-404`).
- A held lock needs another live process holding Plastile's own lock file. In practice that is a second Plastile on
  the same state directory stopped during its save, or a lock planted on purpose. It is a 30 s freeze when it happens.

The asynchronous D-Bus helper (option B) would remove both costs but needs packaging beyond `kpackagetool` and an
asynchronous restore. The store interface (`StateStore` in `src/runtime/persistence.ts`) keeps that switch local.

**Revisit if** a physical-session check shows a visible hitch at saves, saves need to be more frequent, or lock
stalls are reported. All these numbers come from one virtual disk in a nested session. An HDD or a busy filesystem
will be slower, and no physical-session measurement exists.

## ADR-014: Start M8/M9 as experimental opt-in layouts before G3 physical sign-off

**Status:** accepted deviation from the roadmap's ordering (2026-10-18).

**Context.** The roadmap puts scrolling (M8) and zones (M9) after G3, the initial release gate. G3 needs
physical-session results (input-to-visible latency, real outputs, panels). This environment cannot provide
them, and the user asked for the whole project to be implemented. Every G3 item that does not need a physical
session is being completed and tested at the nested layer, so G3 stays open only for its physical checks.

**Decision.** Implement M8 and M9 now, following their design addenda ([SCROLLING](SCROLLING.md),
[ZONES](ZONES.md)), as layouts that are off unless selected (`layout: "scrolling"` or `"zones"`).
They are labelled experimental in user documentation. They reuse the shared event, ledger, ownership and
teardown paths and add no daemon, effect or executable extension. They must not change the behaviour or
performance counters of the initial layouts: the existing suites gate every change.

**Consequences.** M8/M9 results are nested-only until a physical session runs their physical checks, and
the release notes must say so. If they turn out to weaken core correctness, they are removed rather than
patched around. G3 remains the gate for calling any build a release.

## ADR-015: Script-side D-Bus requests for reload and the shortcut report

**Status:** accepted (2026-10-18); tasks D9 and T26.

**Context.** The settings dialog's Apply never reaches a script (kwin v6.7.5 `ScriptingConfig::reload()` is a
TODO), and `KWin.readConfig` reads KWin's cached `kwinrc`, so a script that re-reads its keys sees the old
values. Default shortcuts can collide silently: KGlobalAccel accepts a key another action already holds
(measured). KWin registers `DBusCall` (org.kde.kwin 3.0) for declarative scripts; its `call()` is asynchronous
and its reply arrives as plain lists through `dbusToVariant` (observed source: `src/scripting/dbuscall.cpp`,
`scriptingutils.cpp`; measured: `call()` returns within the same millisecond).

**Decision.** The root creates one `DBusCall` per request and destroys it with its reply; requests still
pending at unload are destroyed with the root, and the runtime also ignores late replies. *Reload
configuration* calls `org.kde.KWin /KWin reconfigure`; KWin's handler only restarts its 200 ms reconfigure
timer, after which KWin re-reads `kwinrc` and emits `Options.configChanged`, the path every reconfigure
already takes. The shortcut report calls only argument-free methods (`allComponents`, then each component's
`allShortcutInfos`, one request in flight), because `DBusCall` arguments are plain QVariants and cannot carry
the `(ai)` key-sequence struct that `globalShortcutsByKey` takes. It starts on an event-loop turn after
start-up and only reads.

**Consequences.** No file I/O or synchronous IPC is added to a command: the reload command issues one
asynchronous call whose handler only starts a timer, and KWin's re-read happens on its own timer. A reload
re-reads all of KWin's settings, as any KDE settings page's Apply does, and Scripting::start then runs and
skips the loaded script (measured: one engine, one activation for 20 rapid requests). The shortcut report is a
snapshot (load and reload), limited to single-chord keys and to components KGlobalAccel knows. KWin hosts
both services in-process, so Qt may deliver these calls locally; measured, `call()` returned within 1 ms
even for KWin's component (159 shortcuts), and each reply arrives on a later event-loop turn. Replies are
QV4 array-like sequences, not Arrays (measured), so parsing accepts array-likes.

## ADR-016: The explain view is a lazily loaded popup marked as Plastile's own UI

**Status:** accepted (2026-10-18); task T28.

**Context.** BEHAVIOR §1 excludes Plastile's own UI from tiling, but the adapter had no way to recognise it
(`meta.own` was always false). A QML window created by a declarative script is a KWin internal window: no
application id, `pid` -1, on all desktops (measured, nested KWin 6.7.5; the scenario also passes on 6.8.0). KWin delivers no keyboard input to an
ordinary internal window; a `Qt.Popup` internal window takes a popup grab instead, receives keys while open,
and is closed by KWin on a click elsewhere or when a window is activated (observed source:
`popup_input_filter.cpp`, `internalwindow.cpp`). Setting `visible` did not map such a window in a script;
`show()` did (measured).

**Decision.** *Explain active window* activates an asynchronous `Loader` (file read and compilation off the command's call) that creates `Inspector.qml`, a frameless `Qt.Popup`
window displaying a view computed once by pure code (`src/runtime/inspect.ts`): plain behaviour statements,
internal ids only under *Show details*. Escape, KWin's popup cancellation, the same command, or unload
destroys it. The adapter treats a window as Plastile's own when its caption is the inspector's fixed title
and it has neither an application id nor a client process; classification excludes own UI before
anything else.

**Consequences.** Nothing exists for keyboard-only use, and an open inspector holds no connections, timers
or geometry writes. While it is open it takes the keyboard like a menu; global shortcuts still run first
(measured). A client window could only be mistaken for it by having that exact caption with no application
id and no process, which ordinary Wayland and X11 clients do not have. Further own windows (a zones overlay)
must reuse the marker or extend `isOwnUi`.
