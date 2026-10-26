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

**Status:** accepted process. Licence chosen by the owner on 2026-10-26: **GPL-3.0-or-later**.

Research links and original design descriptions are not a decision to copy upstream implementations. The sampled repositories include MIT, GPL-family, and mixed component notices. Keep original code as the default; any port must identify file-level notices and the resulting distribution obligations before inclusion. Do not silently assign a new project license to someone else's source. The planning commit does not choose the final software license.

**Decision (2026-10-26, owner).** Plastile is licensed under the GNU General Public License, version 3 or (at
your option) any later version, SPDX `GPL-3.0-or-later`. The full text is `LICENSE` at the repository root.

- `package/metadata.json`, `effect/metadata.json` and `package.json` say `GPL-3.0-or-later`.
- `tools/release.py` puts `LICENSE` into every distributable file: `contents/LICENSE` in the script and effect
  zips (KWin ignores it; `kpackagetool6` installs both packages with it, checked into a scratch data directory)
  and `plastile-state-<version>/LICENSE` in the helper tarball. A build without the file fails.
- Why GPL-3.0-or-later: it is copyleft like KWin (GPL-2.0-or-later, which GPL-3.0 may combine with) and most
  of Plasma, and it is compatible with the helper's Qt 6 dependency (LGPL-3.0 or GPL).
- Unchanged: the reuse rule above. No upstream code is known to be copied. Files vendored with their own notice
  keep it (`fixtures/client/protocols/wlr-layer-shell-unstable-v1.xml`, a test fixture, not distributed).

## ADR-013: Persist session preferences through QtCore Settings

**Status:** accepted direction (2026-10-18); implementation is task T27. **The storage path is superseded by
[ADR-020](#adr-020-persistence-goes-through-an-asynchronous-d-bus-helper) (2026-10-18):** the QtCore `Settings`
store, its in-process load before the first solve and its synchronous saves are removed. The snapshot, its
validation and migrations, the two generation-numbered slots, conservative float matching (Q06) and the debounced
saves below still apply.

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
unload. *(Superseded by ADR-020: the write and the load go to the plastile-state helper over D-Bus, and the load
is applied when the reply arrives, after the first solve.)*

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
recorded only when the user floats a window with *Toggle floating*, and are forgotten when the user tiles it again
(or quick-tiles it with KWin). Any invalid field rejects the whole snapshot, so the save leaves out any entry the
load would refuse (an over-long identity from a client, a second entry for one key). Migrations (`src/persist/migrate.ts`) are pure per-version steps.
Version 1 is the first schema, so the chain is still empty, and a newer schema is rejected. *(Schema 2 adds each
float's `windowHint`, with the first migration; see the [ADR-020
addendum](#addendum-same-window-float-hint-and-a-bounded-start-up-hold-2026-10-18).)*

At load the runtime reads both slots before the first solve and applies the valid one with the highest generation.
It logs one line if any slot was rejected. If a slot holds a newer schema, nothing is written that session, which
keeps that file intact for the newer Plastile. A saved float is given to a window only when exactly one live window
has its `appId`/`resourceName`/`role` (Q06, `src/persist/match.ts`). Otherwise the window gets ordinary insertion
and the saved float waits. It is matched against windows being adopted (those live at the load reply, and each
window when it is first classified), never against a window already in use when a float starts waiting, such as
the sibling of a floated window that closed.

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
analysis proposed for this choice. *(Superseded by ADR-020, which takes option B. The probe that produced this
table was `probes/persistence/cost/run.py` at commit `7a27cf7`; that directory now measures the helper path.)*

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

### Addendum: compiled with main.qml, created on use (2026-10-25)

`Loader.setSource("Inspector.qml")` read the file at the first use. KWin keeps the files a script loaded with until
KWin restarts ([INSTALL, Updating](../user/INSTALL.md#updating)), so an upgrade or a removal while Plastile ran
made that first use read the new or missing file. Measured in nested KWin 6.8.1 (scenario
`package-files-replaced-T32`): a replaced `Inspector.qml` opened with the replacement's caption, and a deleted
`ZoneOverlay.qml` left no overlay while the counters said `shown`. **Change:** `main.qml` declares both as
inline components (`Inspector { view: root.inspectorView }`, `ZoneOverlay { view: root.zonesView }`), so they are
compiled and cached with `main.qml`, and the asynchronous `Loader`s take them as `sourceComponent`. The objects are
still created only on use and off the command's call; reading and compiling the two files moves to script load
(not measured). A package missing either file no longer starts; `tools/release.py` already requires both.

## ADR-017: Defer the drag drop preview; live peer resize is opt-in

**Status:** accepted (2026-10-18); task T29.

**Context.** BEHAVIOR §8 allows an optional lightweight insertion/swap preview during a drag and optional
live peer updates during a shared resize, coalesced to at most one solve per display frame. The drop rule is
already deterministic and documented: the dragged window's centre over another tile swaps the two, anywhere
else snaps back, with one release commit (nested `drag-I01-I02`). A preview needs a Plastile-owned overlay
window per output that takes no input, is created lazily, follows the hovered target on every frame change of
the moved window, and is destroyed on drop, Escape, window or output removal, configuration switch and
unload. KWin delivers no input to an ordinary internal script window but a `Qt.Popup` takes a grab
(ADR-016); whether a non-popup internal window shows above the dragged window without affecting KWin's
drag, and what it costs per motion event, are unmeasured. The nested virtual backend can check the overlay's
lifetime but not what is presented, so its visual result would rest on a physical session that is not
available. The zones layout ([ZONES](ZONES.md), M9) is building the first own-UI overlay at the same time.

**Decision.** Defer the drop preview. Build live peer resize as the per-context JSON setting `liveResize`,
default `false`: while a tile in master/stack or BSP is resized interactively, each frame change of the
resized window marks it for the existing coalesced flush, which applies the dragged boundary to the
committed layout state, solves once, and writes only peers whose target changed (never the resized window,
which KWin owns while interactive). The committed state, plan and revision are untouched until release,
which commits the boundary once as before; a cancel restores the committed slots. No timer or pointer
sampling is involved.

**Evidence.** Nested KWin 6.7.5, 2 s of libei Meta+right-drag on the master of three tiles at 60 steps/s
(`live-resize-T29`, evidence `live-resize-T29.json`): off, 0 solves and 0 writes during the drag and one
release solve; on, 60 solves/s and 120 frame requests/s (two peers), one solve per frame change of the
resized window (120 frame changes, 120 live solves), no write to the resized window, and a release that
needed one solve and no further peer write.

**Consequences.** No visual hint appears while dragging; nothing exists to leak or tear down. Revisit the
preview once the zones overlay has established an input-transparent own-UI window and its teardown, and a
physical session can judge it, reusing that window rather than adding a second overlay path. Live resize
costs client redraws of the peers at the resized window's commit rate; it stays opt-in until physical
measurements show it is not perceived as lag or flicker.

## ADR-018: Close T31 (presentation) as deferred; animation stays disabled

**Status:** superseded by [ADR-023](#adr-023-window-motion-is-an-optional-transform-only-kwin-effect-plastile-motion) (2026-10-25); accepted 2026-10-18; task T31.

**Context.** T31 is conditional: "If animation is desired … Otherwise keep animation disabled and close as
deferred." ADR-006 makes instantaneous geometry the default and forbids animating real window sizes. Its
prerequisite T20 (the G2 performance report) is not complete, and the only environment available is the
nested virtual backend, which cannot show what is presented. A transform-only effect would be a native KWin
effect built against exact KWin versions (6.7 and 6.8 already differ in script-visible behaviour, see
[API_PROFILE](../status/API_PROFILE.md)), and nobody has asked for animation.

**Decision.** T31 is closed as deferred. The configuration accepts `animation` only at its inert values
(`enabled: false`, `durationMs: 0`) and rejects anything else with an actionable error
(`src/config/schema.ts`, the `animation` branch; documented in [user CONFIGURATION](../user/CONFIGURATION.md)).
No effect, timer or transform code exists.

**Consequences.** Every geometry change is a direct frame request, measured as such. Reopening T31 needs a
deliberate feature decision, a completed G2 report, and a physical session to judge the result. The
acceptance criteria on the card then apply unchanged.


## ADR-019: No live settings preview; the settings form is KConfigXT, checked against the schema

**Status:** accepted (2026-10-18); task T28 (deviation from [CONFIGURATION](CONFIGURATION.md) §5's live
preview and the card's "schema-driven settings surface" and "preview/cancel uses config revisions").

**Context.** KWin's script settings dialog is a KConfigXT form (`package/contents/ui/config.ui` bound to
`package/contents/config/main.xml`) that KWin's `ScriptingConfig` loads. Its Apply writes `kwinrc` and never
reaches the running script (ADR-015), and its Cancel discards edits before anything is written. The dialog
therefore has no channel to show the running script a candidate revision, and generating the form from
Plastile's schema at run time would need Plastile's own settings UI or KCM.

**Decision.** There is no live preview, so there is nothing to cancel in the running script: a configuration
reaches the engine only through activation (load, the *Reload configuration* command, or KWin's reconfigure),
which validates the whole snapshot first and keeps the previous revision on failure (T25). The form is
written by hand and kept equivalent to the schema by tests: `tests/core/package.test.ts` compares the keys,
defaults and enum vocabulary of `main.xml` with the runtime's flat-key parser, and `tools/settings-check`
(built in CI) loads the form like `ScriptingConfig` and checks that every entry has a widget and that values
round-trip. JSON overrides and rules are edited as text in the same form.

**Consequences.** Cancel cannot restore stale window references, because no preview revision ever holds
any. A setting takes effect only after Apply and a reload, which [user CONFIGURATION](../user/CONFIGURATION.md)
states. A preview would need a Plastile-owned settings surface that sends candidate revisions to the engine
and restores the previous one on cancel, recomputing from current window state; it stays out of scope until
there is a reason to build that surface.

## ADR-020: Persistence goes through an asynchronous D-Bus helper

**Status:** accepted (2026-10-18), the owner's decision; task T27. Supersedes the storage path of
[ADR-013](#adr-013-persist-session-preferences-through-qtcore-settings) (QtCore `Settings`, in-process load and
saves). ADR-013's snapshot, validation, migrations, two generation-numbered slots, Q06 matching and debounce stay.

**Context.** ADR-013 saved on KWin's compositor thread: `Settings.sync()`, a `QSaveFile` commit with `fsync`
behind a `QLockFile`. Its addendum measured 1.6–3.6 ms p50 and up to 7.85 ms p99 per save (19.5 ms observed),
every one of 750 calls over 1 ms, and a 31.9 s stall when another live process held the lock
([evidence](../status/evidence/persistence-t27-cost.json)). The owner judged that unacceptable: a save that is
debounced and off the command path still drops frames, and a held lock freezes the desktop. Nothing in-process
avoids it. A probe ([`probes/persistence/worker/`](../../probes/persistence/worker/run.py),
[evidence](../status/evidence/persistence-worker-probe.json)) found that a `WorkerScript` runs on its own thread
inside KWin (the main thread's 5 ms timer kept ticking, worst gap 6 ms, while a worker spun for 1.5 s) but cannot
write files: an XHR file `PUT` is refused unless KWin's environment has `QML_XHR_ALLOW_FILE_WRITE`, and the
`QtQuick.LocalStorage` import is ignored in a worker. KWin scripts have no `writeConfig`. ADR-011 already allowed "an optional small helper with
asynchronous versioned messages".

**Decision.**

- **A helper process,** `plastile-state` ([helper/](../../helper/README.md)): C++17, Qt 6 Core and DBus only.
  It owns the session-bus name `org.kde.plastile.State` and serves `Read() -> as` and
  `Write(i slot, s text) -> b` on `/State`. It stores the slots as `$XDG_STATE_HOME/plastile/state-0.json` and
  `state-1.json` (directory 0700, files 0600) with `QSaveFile`, whose `fsync` now blocks only the helper. It refuses
  a slot other than 0 or 1 and texts over 1 MiB, never interprets the text, answers in arrival order, and exits
  60 s after its last caller left the bus (see the addendum on KWin's exit below). There is no lock file: owning the bus name makes it the only writer, and a second
  instance exits. The session bus starts it on demand from its activation file.
- **No persistence file I/O on KWin's thread.** `Persistence.qml` is a thin asynchronous store over KWin's
  `DBusCall` (org.kde.kwin 3.0, as in ADR-015): one call object per request, destroyed with its reply, plus the
  one-shot maintenance Timer for the debounce. The QtCore `Settings` path is removed.
- **Asynchronous load.** The runtime sends one `Read` at start-up and tiles with defaults at once; it never waits
  for the reply. *(Changed by the [addendum](#addendum-same-window-float-hint-and-a-bounded-start-up-hold-2026-10-18):
  the first solve waits for the reply, at most 250 ms.)* The reply applies the newest valid slot by the same generation and slot rules, except what the user
  changed since start-up: a context whose preferences changed keeps the user's values, and an application whose
  float decision changed keeps it (the engine now says which context or application identity a preference change
  touched). Saved floats are matched against the windows live at that moment (Q06 unchanged). Affected contexts
  re-solve in the engine's next flush; the reply callback writes no geometry, and the single writer is unchanged.
  A float restored to a window whose tile request is still in flight now waits for that request to settle: KWin
  drops a write back to the committed size while a configure is outstanding (the ledger's E04 rule), so writing at
  once left the window on its tile (found by `persist-reload-restart-T27`; unit test added). *Toggle floating* and a
  switch to the floating layout wait the same way for a tile configure still in flight (a second toggle before a
  slow client committed the first; unit test in `tests/core/floats.test.ts`). A suspend or unload drops such a
  wait (the user owns the frames from then on), and a parked scrolling window keeps its parking entry until its
  restore is written, so every exit still unparks it (review of the bug-hunt fixes; `tests/core/scrollingEngine.test.ts`).
- **Saves.** Nothing is written before the load reply, or its failure, arrives; changes made meanwhile are saved a
  quiet period after it. One `Write` is in flight at a time; changes made while it waits are saved after its reply.
  Nothing is retried by itself: what a failed `Write` carried is saved with the next change or at unload, with one
  diagnostic per run of failures. A failed or absent helper at load (`ServiceUnknown`, an error reply, a malformed
  reply) gives state `memory`, one diagnostic and no further request. A clean unload sends one final `Write` if
  dirty, after a `Write` still in flight and into the other slot. An unload while the load is pending writes
  nothing: the slots' generations are not known yet. The quiet period is measured with `Date.now()`, the wall
  clock: a step back (NTP, a manual change) restarts it, so a save waits at most one more period, never the length
  of the step.
- **The interaction postponement is dropped.** ADR-013 postponed a save due during an interactive move or resize
  because the save blocked the compositor thread for milliseconds, and capped the postponement at 30 s for a move
  that never ends. Issuing a save now costs about as much as one command handler (below), so the postponement and
  its cap are gone, with `Engine.isInteracting()`, which had no other user.
- **Two QV4 costs found by the measurement were cut.** Validating a full snapshot built a path string for every
  field: 2.3 ms of its 2.9 ms parse in QV4. Paths are now built only for reported errors: 0.34 ms, with identical
  results on 8000 mutated inputs. The unchanged-content check stringified the snapshot a second time; the content is
  now a slice of the serialized text (`contentOf`).

**Evidence** (nested KWin 6.7.5, Qt 6.12.0, virtual backend, ext4 on NVMe; CLOCK_MONOTONIC from `tools/measure`
inside KWin; other agents' nested suites shared the 12 CPUs; probe `probes/persistence/cost/run.py`,
[evidence](../status/evidence/persistence-helper-cost.json)). Times on KWin's thread:

| What | p50 | p95 | max | n |
|---|---|---|---|---|
| `write()` call (builds the `DBusCall`, sends), 1 KiB text | 0.06 ms | 0.09 ms | 0.12 ms | 250 |
| `write()` call, 16 KiB | 0.08 ms | 0.12 ms | 0.15 ms | 250 |
| `write()` call, 64 KiB | 0.20 ms | 0.28 ms | 0.34 ms | 250 |
| `read()` call at start-up (first in the session / reloads) | 0.08 ms / 0.05 ms | 0.07 ms | 0.08 ms | 1 / 20 |
| A save as Plastile issues it (snapshot build + serialize + call), 0.3 KB state after command bursts | 0.19 ms | | 0.21 ms | 3 |
| Same, typical state (2 contexts, 2 floats, 0.8–1 KB) | 0.22 ms | 0.28 ms | 0.69 ms | 20 |
| Same, largest state (64 contexts, 64 floats, 24 KB) | 1.23 ms | 1.59 ms | 1.83 ms | 20 |
| Load reply callback (parse both slots + apply), typical state | 0.14 ms | 0.29 ms | 0.29 ms | 20 |
| Load reply callback, largest state (two 24 KB slots) | 2.19 ms | 2.84 ms | 3.09 ms | 20 |
| For comparison: a command handler (dispatch to return) | 0.29 ms | 0.48 ms | 0.96 ms | 123 |

None of the 750 `write()` calls took 1 ms. The two cuts above are included; before them the largest state cost
about 1.6 ms to issue and 5.4 ms in the load callback (same probe, earlier runs, n=6–8).

Before (ADR-013): `sync()` alone was 1.6 ms p50 for 1 KiB and 3.6 ms for 64 KiB, and 31.9 s with a held lock. The
`fsync` is still paid, in the helper: a `Write` reply arrived 2.3–3.0 ms p50 (max 6.2 ms, n=750) after the call, and the first `Read`, which starts the helper, 6.5 ms, which KWin's thread does not
wait for.

Nested scenarios (each passed twice, KWin 6.7.5):

- `persist-helper-stopped-Q05`: the helper is stopped with SIGSTOP while a save comes due. KWin's main-thread
  D-Bus round trip stays at its baseline (p50 0.16 and 0.25 ms stopped against 0.17 and 0.21 ms before the stop in the two runs, max under 0.5 ms, n=30 each), three resize commands appear in the oracle in 15–21 ms, one
  `Write` waits in flight and nothing else is sent, no file changes, and both saves land after SIGCONT. After a
  SIGKILL the next save activates a new helper. Added in review: the round trip is also sampled every 10 ms for
  2.6 s across the moment the save to the stopped helper is issued (max 0.76 ms, n=255), and a positive control, a
  one-shot script that keeps KWin's main thread busy for 400 ms, shows as a 400 ms round trip, so the probe does
  detect a stall of KWin's thread and the quiet result is not circular.
- `persist-helper-delayed-Q05` (every request delayed 4 s): tiling starts on defaults; the saved ratio applies to
  the untouched output when the reply arrives, about 4 s later, while the output the user changed keeps the user's
  ratio; the delayed writes land in order with the latest preferences.
- `persist-reload-cycles-Q09`: each of 20 unloads saved exactly once, so a `Write` issued from
  `Component.onDestruction` is delivered (`DBusCall::call()` sends with `asyncCall` before the object is destroyed;
  observed source).
- `persist-no-helper-Q05`: without the activation file Plastile tiles, logs one diagnostic and writes nothing.
- `persist-helper-contract-T27` (added in review; the helper alone on a private bus, no KWin): slot and size
  refusals (1 MiB counted in UTF-8 bytes), atomic replacement (new inode, an open reader keeps the old text),
  modes repaired to 0700/0600, damaged, oversized and unreadable slots, one instance per bus, 200 pipelined writes
  answered in order, idle exit and re-activation with 40 calls straddling the exit, and exit with the bus. It found
  that `QSaveFile` refuses to replace a slot its owner cannot write, so a read-only slot (restored from a backup,
  say) failed every save into it, and Plastile, which writes into the slot after the committed one, never got past
  it. The helper now makes such a slot 0600 before replacing it.
- Probe command phase: 123 commands, no state-file event inside a command handler or within 1.5 s after one, one
  save per burst.

**Consequences.**

- Persistence needs the installed helper, a second artifact beside the `.kwinscript`: `tools/install.sh
  install-helper` builds and installs it, and `tools/release.py` ships its source tarball
  `dist/plastile-state-<version>.tar.gz`. The `.kwinscript` stays script-only; with it alone Plastile keeps its
  preferences in memory and logs `plastile warn persistence unavailable` once.
- *(Changed by the [addendum](#addendum-same-window-float-hint-and-a-bounded-start-up-hold-2026-10-18): this now
  happens only when the reply takes longer than the 250 ms start-up hold.)* Restore is asynchronous. The first solve uses defaults and the saved preferences apply one reply later, as a
  re-solve: 5–10 ms after start in nested runs, helper activation included. A restored layout can therefore change
  once, visibly, right after start-up. A newly opened window whose saved float arrives after its first tile write
  floats one configure later.
- Changes made before the load reply are lost if the script unloads before it arrives.
- State files of earlier development builds (`state-N.ini`) are not read; no release used them.
- KWin's own exit was measured in nested sessions only (`persist-kwin-exit-T27`, added in review): with a change
  still inside the debounce, SIGTERM to `kwin_wayland` ran Plastile's teardown 7 ms later and the final `Write`
  reached the helper after KWin had exited, 6 of 6 times locally, three of them with the helper exited for idleness
  so that the `Write` activated a new one. On the CI sandbox that activation case lost the `Write` in 2 of 3 runs
  (run 39138658100; by inference, the bus drops an activation pending for a sender that disconnects). The helper
  therefore no longer exits while a caller is on the bus: it watches each caller's unique name and starts its 60 s
  idle period only after the last one left. KWin is one connection for the whole session, so the helper now runs
  from Plastile's first request until KWin exits, and the final `Write` never needs an activation. The private bus stayed up there; at a real logout the session bus and the
  service manager may already be stopping, so that case stays unverified.
- Unverified: D-Bus activation and the final `Write` at logout on a physical session bus (dbus-broker under
  systemd); the CI jobs that build the helper; any physical-session timing.

**Revisit if** the start-up re-solve is visible as a hitch on a physical session, the load callback grows past a
frame for real snapshots, or KWin gains a supported asynchronous file write for scripts.

### Addendum: same-window float hint and a bounded start-up hold (2026-10-18)

**Status:** accepted (2026-10-18), the owner's decisions; task T27, found by `reenable-floats-T19` and
`resume-floats-T19`.

**Context.** Two consequences of the matching rule and of the asynchronous load fought the user. A saved float was
matched by application identity only, so after a disable and re-enable a float the user had moved while Plastile was
disabled was moved back to the rectangle saved at unload (recorded by `reenable-floats-T19`: one restore write to the
old rectangle). And because the first solve ran before the helper's reply, every restored float was first tiled and
then moved back one reply later, and a restored layout or ratio changed once right after start (both T19 scenarios
failed their no-write checks on `f3d1f8f`).

**Decision 1: a same-window hint (schema 2).** Each saved float also records `windowHint`, the KWin window id
(`internalId`, Plastile's `WindowId`) of the window it was taken from. At restore, a live window with exactly that id
is the window the user floated: it floats again at the frame it had when this runtime started (`start()`'s initial
snapshot, kept on the record), clamped or relocated by the usual float rules only if needed, with a write only if it
is not there, and that frame becomes its float preference, so it is what the next save stores. No ambiguity rule
applies to a hint match, and a preference whose hinted window is live is not given to another window of the
application. Otherwise the application identity rule is unchanged (Q06: exactly one live window of that identity gets
the saved rectangle; two or more get ordinary insertion and the preference waits).

The hint is not durable identity, which ADR-013 forbids. KWin gives every window a new random `QUuid` id, so after a
KWin restart, a logout or an application relaunch it names no live window, and the identity rule applies as before
(`persist-reload-restart-T27`'s restart half). It only identifies the same window within one KWin session, across a
script unload and load.

`SCHEMA_VERSION` is 2. The first migration (`src/persist/migrate.ts`, fixtures `tests/fixtures/persist/v1.json` ->
`v2-from-v1.json`) adds `windowHint: ""` to every float. Validation accepts any string of at most 128 characters,
`""` included. A version-1 file loads (migrated) and is rewritten as version 2 by the next save, into the other slot;
a version-3 file is read-only like any newer schema. A Plastile of schema 1 treats a version-2 file the same way:
read-only for that session.

**Decision 2: the first solve waits for the saved state, bounded.** With a store (`Persistence.qml`), `start()`
adopts the initial windows but does not solve; the Persister releases it when the load finished (reply applied, reply
failed, helper absent or a malformed reply) or after `LOAD_HOLD_MS` = 250 ms, whichever comes first. The deadline is
the store's one-shot maintenance timer, which no save needs while the load is pending, and unload cancels it. During
the hold, window events and commands update the model at once (a command is dispatched and answered as usual; focus
commands activate immediately) and their geometry stays dirty work; nothing is solved, corrected or tiled. The release
schedules the engine's next flush, so the reply callback itself still writes no geometry. A reply after the deadline is
applied as before, as a re-solve. Without a store there is no hold; recording builds do not hold either (the recorder
has no input for the release, and replays model no persistence). This is a bounded wait once per script start, not a
settle timer: no command waits for it, and it ends on the reply.

**Evidence** (nested KWin 6.7.5, virtual backend, other agents' suites sharing the CPUs; `Date.now()` in QV4, so
millisecond resolution; from `plastile info start-up hold released` lines):

- Reply latency, from the load request to the release: 0–2 ms with the helper already running (n=27), 6–11 ms when the
  request activates the helper on a fresh bus (n=10), across the persistence scenarios of one run.
- The deadline (helper delaying every request by 4 s, `persist-helper-delayed-Q05`): released after 212–254 ms (n=3;
  a QML `Timer`, observed firing up to 15% early); defaults, then the saved ratio applied once when the reply arrived.
- `reenable-floats-T19`: after a disable and re-enable, the three user floats (one moved while disabled, one of an
  application with three windows) float where they are; KWin's own `frameGeometryChanged` for them stays silent and
  Plastile writes none of them. With the hint match disabled (identity only), the moved float was put back at the
  rectangle saved at unload and the check fails (mutation run).
- `resume-floats-T19`: the floats' frames do not change at re-enable, no write.
- `persist-ambiguous-Q06`: with the floated window still open and a second instance opened while disabled, the float
  goes to the floated window only; after that window closed, two instances are ambiguous as before, and one instance
  gets the saved rectangle by identity.

**Consequences.**

- The visible start-up re-solve of ADR-020 now happens only when the reply takes longer than 250 ms.
- Start-up tiling is delayed by the reply latency, about 1–11 ms nested, at most 250 ms. Not measured on a physical
  session, where helper activation through dbus-broker and systemd may be slower.
- A saved float follows its window across script reloads even when the user moved it, and even with several windows
  of the application open. Two windows of one application can still not both have saved positions: preferences stay
  keyed by application identity.
- The snapshot grows by up to 64 short hints (about 3 KB at the caps).

**Revisit if** a physical session shows helper activation regularly above 250 ms, or the hold is visible as a
start-up delay.

## ADR-021: A window that arrives maximized is un-maximized and tiled

**Status:** accepted (2026-10-19), the owner's decision; task T17. Changes T17's "honour native maximize" for
the case of a window that opens maximized; every later maximize is honoured as before.

**Context.** In the physical runbook (the owner's desktop, KWin 6.7.5) the owner's kitty opened every new window
already maximized, with no KWin rule and no kitty option found. Plastile honoured the maximize (T17: suspension
`maximized`), so new terminals were never tiled and Plastile looked dead; explain said "tiling of this window is
suspended while it is maximized". The maximize was the application's choice, not the user's. KWin's script API can
clear it: `Window.setMaximize(bool vertically, bool horizontally)` is `Q_INVOKABLE` in `window.h` (6.7.5 and 6.8.0;
`maximizeMode` itself is read-only), and `maximizable` is false for a fixed-size window and for one a KWin rule
forces maximized (`XdgToplevelWindow`/`X11Window::isMaximizable`, observed source). The only other approach,
writing a frame to a window that stays maximized, would leave a maximized window at a tile size and fight the
client.

**Decision.**

- A setting, `maximizedOnOpen` (`tile`, the default, or `keep`): a flat key with a choice in the settings dialog,
  and a context setting in the JSON document (the context the window opens in decides). Validated before
  activation like every key.
- **Which windows.** Only windows opened while Plastile runs (`windowAdded`, not suspended). Windows adopted at
  start, at a re-enable or reload, at a resume or by `reconcile` are left as they are. Only windows that would
  otherwise tile, in a context that places them: rule floats and exclusions, dialogs and transients, user floats,
  native-tile yields, multi-context windows, the floating layout and unassigned zones members keep their maximize.
  A window that opens full screen or minimized keeps it (full screen on open stays honoured), decided then and not
  revisited when the user later restores it. A window the layout has no room for (it would overflow and float)
  keeps its maximize: un-maximized, it would float at KWin's restore geometry, not tile.
- **When.** Once per window, at its first readiness: in the first flush after it is classified, which is after the
  bounded late-metadata wait (BEHAVIOR §1). A maximize reported before its first tile settled still counts (a
  client that sets it after its first commit; KWin reports a commit's geometry before its acknowledged states, so
  that maximize can arrive just after the tile, in the same commit): the open phase ends 1 ms after the first tile
  settles (`Date.now()` resolution; no timer) and at most `deadlineMs` (750 ms) after the decision. A window whose
  context is not shown (it opened on another desktop or activity) is decided when that context is shown: nothing is
  written to a window whose context is hidden (O07), and an un-maximize then would leave it at its restore
  geometry (on Wayland a 0x0 configure: the client's own size) until shown, a second placement.
- **How.** The window takes part in the flush's solve with its maximize suspension lifted. Only when that solve
  gives it a slot does the adapter call `setMaximize(false, false)` (when `maximizable` is true), before the solve
  writes anything; then the solve writes its tile. If KWin refuses, the window stays maximized and the context is
  solved again without it, still before any write. The tile is a plan write on a fresh ledger entry, written even when the maximized
  frame already equals it (no gaps, one window), because KWin's un-maximize moved its requested geometry to the
  restore rectangle. On Wayland KWin's configure timer sends both as one configure; until the client acknowledges
  it, KWin still reports `maximizeMode` 3, which is then not a suspension.
- **Bounded.** At most one un-maximize per window. After it, any maximize is honoured as T17 specifies. If KWin
  still reports the window maximized when the wait ends (`deadlineMs`; the client asked to be maximized again
  before acknowledging), it is honoured: the tile request is cancelled and nothing is corrected. A suspend during
  that wait ends it as well: a window KWin still reports maximized is suspended as for any maximize, so the
  resume leaves it maximized unless the client acknowledged the un-maximize meanwhile. Not maximizable:
  it stays maximized, explained.
- **Said.** Explain's `onOpen` (the inspector's *On open* row) and the trace (`open-maximized` with
  `action: unmaximized | kept`, `unmaximized` when KWin reports it, `remaximized`) record what happened. No new
  counter: the committed replay fixtures pin the counter set.

**Evidence.** Unit (mock compositor modelling KWin 6.7.5's `setMaximize`: X11 synchronous, xdg-toplevel reported on
the client's commit, one configure per turn; `tests/core/maximizedOpen.test.ts`, 19 tests; adapter and runtime with
the fake KWin, `tests/core/adapter.test.ts`); 13 mutations of the engine (no un-maximize, no ack mask, decided while
suspended or at start, no deadline give-up, no late watch, unbounded re-un-maximize, no forced first write, `keep`
ignored, full screen not honoured, floating layout un-maximized, no fresh ledger, watch ended at once) each fail a
test. Nested KWin 6.7.5 (virtual backend, reference host), each scenario passed at least twice, six engine
mutations each fail a scenario:

- `maximized-open-tile-T17`: a fixture that maps maximized (`--start-maximized`) receives exactly one configure
  without the maximized state, at its tile size, and none asking for its own size; KWin's frames for it (a passive
  listener script) go from the maximize area to the tile; no correction. A later maximize through KWin's maximize
  action and through a real double click on the title bar (libei input) stays maximized; restoring returns it to
  its tile.
- `maximized-open-keep-T17`: with `keep` it stays maximized, receives no un-maximized configure and no write.
- `maximized-open-startup-T17`: windows maximized when Plastile starts, after a reload, and opened while tiling was
  suspended stay maximized.
- `maximized-open-remaximize-T17`: a client that asks to be maximized again before acknowledging the un-maximize
  (`--remaximize-once`) ends maximized, with one un-maximized configure in its log and no write or correction for
  2 s afterwards.
- `maximized-open-xwayland-T17`: an X11 window mapped with `_NET_WM_STATE` maximized is un-maximized and tiled with
  one write. KWin's `X11Window::maximize` configures the restore geometry synchronously inside `setMaximize`, so
  the client sees two `ConfigureNotify` (restore size, then tile) in one turn.
- `maximized-open-late-T17`: a client that calls `set_maximized` right after its mapping commit
  (`--maximize-after-map`), also a 40 ms client whose maximize KWin reports in the same commit as the tile, ends
  tiled and not maximized.

*Review amendment (2026-10-19, branch `wf/maximized-open-review`).* The first implementation un-maximized the
window in the open check, before the solve, and did so whatever the context's visibility. Two defects followed,
both reproduced in nested KWin 6.7.5 against that engine: a window that opened maximized on a desktop not shown
got a 0x0 un-maximized configure while hidden and a second placement when shown; a window the layout had no room
for (minimum sizes) got a 0x0 configure and became an overflow float at the client's own size, while explain said
it was un-maximized on open. Now the un-maximize happens in the solve that gives the window a slot, a hidden
context defers the decision, and overflow and minimized-on-open keep the maximize. Evidence: unit
(`tests/core/maximizedOpen.test.ts`, 26 tests; 18 engine mutations, the branch's own and the amendment's, each fail
a test) and two more nested scenarios, each passed three times:

- `maximized-open-hidden-T17`: a window placed on desktop 2 (a placer script, as a KWin rule would) while desktop 1
  is shown stays maximized and receives no un-maximized configure; when desktop 2 is shown, it gets one configure,
  un-maximized at its tile size, and the trace records `deferred` then `unmaximized`. The original engine fails 5
  of 9 checks (its configures: maximized, then `0x0` while hidden).
- `maximized-open-overflow-T17`: with two 700 px minimum widths on a 1280 px output, the window stays maximized,
  receives no un-maximized configure, the peer is not written, and explain says there is no room. The original
  engine fails 3 of 5 checks (a `0x0` configure, then an overflow float).

**Consequences.**

- Applications that open maximized are tiled. A user who wants them maximized sets `keep`, or maximizes them
  (kept). An application that maximizes itself again after the un-maximize keeps its maximize; Plastile does not
  insist.
- Plastile now changes one window state besides geometry, activation and the border: it clears the maximize of a
  window that opened maximized, once.
- On X11 the client sees KWin's restore geometry for an instant before its tile (both in one KWin turn; one
  Plastile write). Passing the tile as `setMaximize`'s restore rectangle would avoid it, but the third argument's
  conversion from a script value is not verified, so it is not used.
- Not verified: a KWin rule that forces maximize (unit and fake-KWin only: `maximizable` false); KWin 6.8.0 (same
  source semantics, not run); the physical case that prompted it (the owner's kitty), which is the runbook's to
  confirm.
- A KWin rule *Maximized: Apply initially* is the user's configuration, but Plastile cannot tell it from an
  application's own maximize: with `tile` such a window is un-maximized. A *Force* rule makes the window not
  maximizable (observed source), so Plastile leaves it maximized; `keep` is the other way out.
- Session restore: an application that the session manager restores maximized after Plastile started arrives
  maximized and is un-maximized, as any window opened while Plastile runs (follows from the rule; not tested).

**Revisit if** a common application maximizes itself repeatedly after mapping, users report windows they wanted
maximized being tiled, or KWin exposes whether a maximize came from the user.

## ADR-022: No for...of over a Map or Set in src/; a type-aware build guard enforces it

**Status:** accepted (2026-10-19), branch `wf/qv4-iteration`, reviewed on `wf/qv4-iteration-review`. Constrains the coding style of `src/`; nothing in
behaviour changes except the five sites below, which now do what the unit tests always assumed. The adapter's re-entrant
re-key that exposed them was removed afterwards on `wf/rekey` (follow-up below).

**Context.** QV4 (Qt 6.12.0) walks a `Map`, a `Set`, or one of their `keys()`/`values()`/`entries()` iterators with
`for...of` as if it held an index into a compacted list. Deleting the current entry, or one before it, therefore
skips the entry after it. `forEach` follows ECMAScript, and so does every engine Node runs. Arrays behave the same in
both engines. Insertion never differs. This was measured in the `qml` tool, which loads the library KWin loads
([qv4iter](../../probes/perf/qv4iter/run.py), [evidence](../status/evidence/qv4-iteration-cases.json): 210 cases,
80 differ. All of them walk a Map or Set through its iterator while entries are deleted: `for...of`, a hand-written
`next()` loop, `yield*`, or `Array.from` with a callback). No unit test can see the difference.

The G2 review (§16.9) found the deviation in the apply loop. It also noted that deletions through called functions
had not been audited. That audit covered all 45 `for...of` sites over a Map, Set or iterator in `src/` (listed by
the guard below) and followed each body's call graph through the engine, ledger, trace, adapter, configuration
callbacks and persistence. Five sites could delete from the collection they walk. All five go through one edge:

- Every HostPort read that resolves an output key (`visibleDesktop`, `workArea`, `outputs`, `activeOutput`) goes
  through `KwinAdapter.keyOf`.
- So does the configuration's `settingsFor`/`rulesFor`, through `ContextNames.outputNameOf`.
- If KWin lists an output the adapter has not keyed yet (an identical monitor, before `screensChanged` reaches the
  script), `keyOf` rebuilt the keys and called `engine.outputsRekeyed` synchronously (until the follow-up below).
- `outputsRekeyed` deletes and re-adds the renamed contexts and their `emptied`, `dirty` and `retained` entries.

The five sites and what QV4 did there:

| Site | Collection | QV4 outcome (V8 outcome) |
|---|---|---|
| `markVisibleDirty` (desktop or activity switch) | `contexts` | a context that became visible is not solved |
| `configure`, the settings snapshot | `contexts` | a shown context keeps its old gaps |
| `releaseAllZones` (suspend, unload) | `contexts` | a context's zones are not released |
| `collectEmpty` | `emptied` | an empty context is not collected |
| `contextPreferences` (persistence save) | `contexts` | a context's preference is not saved (V8: one saved twice, once under its stale key) |

The other 40 sites could not delete from what they walk. No path from their bodies reaches a deletion, assuming
KWin does not emit `windowRemoved` inside a property write. The apply loop's earlier hazard (G2 §16.9) was already
removed by `d6f5647`.

**Decision.**

- `src/` uses `for...of` only over arrays, tuples and strings. A Map or Set is walked with `forEach`, which QV4 runs
  as ECMAScript does. Use a first-match flag where a loop exits early. Iterate an array snapshot
  (`Array.from(m.keys())`, `[...set]`) only when visiting each original entry once is the intended semantics; a
  snapshot does not visit an entry re-added under a new key, which `collectEmpty` needs.
- `contextPreferences` takes a copy, resolves every context's preferences first, and reads the keys afterwards.
  Each context is saved once, under its current key.
- **The guard:** [tools/itercheck.ts](../../tools/itercheck.ts) runs the TypeScript checker on
  `tsconfig.runtime.json`. It rejects any `for...of` whose expression is not array-like: a Map, a Set, their readonly
  forms and iterators, `Iterable<T>`, a type parameter constrained to one of them, or a union containing one. It
  also rejects the same walk written other ways (review, below):
  - `Array.from(x, callback)` or a typed array's `from` over a non-array, recognised by the resolved signature, so
    through an alias of `Array`, `Array["from"]` or a destructured `from` too;
  - a built-in `from` used other than by a direct call (`Array.from.call`, `const f = Array.from`);
  - `next()` on an iterator held in a variable or property (one step from a fresh iterator,
    `m.keys().next().value`, is allowed);
  - `yield*` over a non-array.

  [tools/build.mjs](../../tools/build.mjs) fails with the
  sites and a pointer to [PERFORMANCE §7.1](../validation/PERFORMANCE.md#71-qv4-iteration-allocates-measured). The
  check is on `src/`, not the bundle, because the bundle has lost the types.
- **QV4-level proof:** [tests/core/qv4iteration.test.ts](../../tests/core/qv4iteration.test.ts) runs in
  `npm test` when a Qt 6 `qml` tool is installed ([qv4.ts](../../tests/core/qv4.ts) lists where it looks). Without
  one it skips and says so, unless `PLASTILE_REQUIRE_QV4=1`, which makes it fail.
  - It requires `forEach` and array iteration in QV4 to match ECMAScript.
  - It runs [qv4Scenarios.ts](../../tests/core/qv4Scenarios.ts) bundled in QV4 and in V8 and requires equal results.
    Each scenario drives one of the paths above: the real adapter over the fake KWin surface, or the engine with the
    mock compositor.

**Evidence** ([qv4-iteration-engine.json](../status/evidence/qv4-iteration-engine.json); QV4 in the `qml` tool,
offscreen; not KWin, not nested). The same scenarios ran against three commits' `src/`:

| `src/` at | QV4 | V8 |
|---|---|---|
| `eca2df5` (apply loop still `for...of`) | 6 of 6 fail | `saved-preferences` fails |
| `5229536` (the audit's base) | 5 fail (`apply-leaves` passes) | `saved-preferences` fails |
| this change | all pass | all pass, identical results |

Unit tests passed on `5229536` (493/493), which shows that Node does not see these hazards. Guard tests: 26 rejected
and 25 allowed forms ([itercheck.test.ts](../../tests/core/itercheck.test.ts)). A planted `for...of` over
`rects.values()` fails `node tools/build.mjs`.

Nested, at `cca6109` (`src/` as in `4648e24`): the full suite passed, 1897/1897 checks and 141/141 scenarios run, with
the expected skip `output-negative-origin-G02` (KWin 6.7.5, virtual backend). This does not exercise the five
hazards: the virtual backend reports no EDID, so output keys are connector names and `outputsRekeyed` is never
reached (see `replug-identity-O05`).

**Review (branch `wf/qv4-iteration-review`, 2026-10-19).** Checks run in the `qml` tool (Qt 6.12.0) and in Node:

- **Mutation check.** Each fix was reverted on its own in a scratch copy, and `qv4iteration.test.ts` fails for every
  one: the four `forEach` sites back to `for...of` (QV4 differs from V8), `collectEmpty` as an array copy (V8 leaves the
  re-keyed empty context uncollected), and `contextPreferences` as live `for...of` or `forEach` (V8 saves one
  preference twice).
- **A test gap, fixed.** `contextPreferences` as a one-pass copy (`for (const c of Array.from(...))`, each key read
  right after its `prefsOf`) passed the scenario while saving one context under its stale key. The scenario checked
  the keys on a second `contextPreferences()` call, which re-keys nothing. It now checks the keys of the call in which
  the re-key happens, and the one-pass copy fails. The two-pass form is needed.
- **Guard evasions, closed.** The guard accepted four walks that QV4 runs as it runs `for...of`, skipping an entry
  after a deletion. They were hand-written `next()` loops, `yield*`, `Array.from` with a callback through an alias,
  `Array["from"]` or a destructured `from`, and `Array.from.call`. Each now has a probe kind in
  [cases.js](../../probes/perf/qv4iter/cases.js) and a rejected case in the guard tests. `src/` contained none of them,
  at `5229536` or after, so no runtime code changes. Not checked: array destructuring of a Map or Set. A default
  initializer runs between its steps, but QV4 gave the ECMAScript result in the two deleting cases tried.
- **Audit recount.** The extended guard finds 45 sites at `5229536`, all of them `for...of`, which matches the audit.
- **Command-path cost (nested, KWin 6.7.5, virtual backend; not physical).** The G2 P03 protocol ran 5 units per
  variant, interleaved, from a clean harness tree, at 32 windows, instrumented
  ([qv4-iteration-perf.json](../status/evidence/qv4-iteration-perf.json)). All 10 units passed.
  - Solve span, `5229536` → `4648e24`, p50 and p99 in ms: ratio 0.095 → 0.094 and 0.167 → 0.166; swap 0.103 → 0.102
    and 0.171 → 0.170; master 0.101 → 0.101 and 0.170 → 0.172. The run-bootstrap intervals overlap in every cell.
  - Outer span p99: ratio 1.62 → 1.62, swap 1.27 → 1.30, master 1.54 → 1.60, focus 1.36 → 1.37. These intervals overlap too.
  - One difference: noop outer p50 0.346 → 0.359 ms. The intervals only just separate, [0.159, 0.346] against
    [0.348, 0.372], and the distribution is bimodal at 1000 samples. It is not attributed to a line.

**Consequences.**

- The style rule costs a closure per `forEach` call instead of an iterator per loop plus a result object per step
  (PERFORMANCE §7.1).
- Early exits need a flag, and the loop visits every entry. The five such sites walk all windows
  (`disarmIfIdle`), the outputs, one context's plan, a window's suspensions, or at most 64 float preferences.
- The CI core job has no Qt, so it skips the QV4 tests. Since the follow-up, the `native-tools` job installs the
  `qml` tool and runs them with `PLASTILE_REQUIRE_QV4=1`; its first hosted run
  (run 39300522170) ran 17/17 with none skipped. The build guard runs everywhere.
- ~~The adapter's re-entrant edge itself is kept.~~ Removed by the follow-up below, with the two further effects the
  review found (the triggering lookup answered for the old key; a dirty context renamed during a flush was not
  solved in it). The engine keeps `forEach` at the five sites: they do not rely on the adapter.
- Nothing here is physical.

**Follow-up: the re-entrant edge removed (branch `wf/rekey`, 2026-10-19).**

- **Queries are read-only.** `KwinAdapter.outputKey`/`keyOf` (reached from `outputs`, `activeOutput`, `workArea`,
  `visibleDesktop`, `sendToOutput`, `showDesktop`, `outputNameOf` and `membershipOf`) never call the engine.
- **What a query returns.**
  - An output in the committed keys answers with its committed key, the key the engine's contexts use. This holds
    even when the screen list has already changed that key: when a twin appears, DP-1 keeps answering
    `edid:LG/27UL/` until the commit.
  - An output not committed yet (the twin) answers with its key in the oldest staged key set that has it
    (`edid:LG/27UL/@DP-2`), the key under which it enters the engine.
  - An output KWin does not list answers with its connector name once the committed keys lack it, as before.
    One that KWin stopped listing but the committed keys still have (a monitor unplugged, `screensChanged` not
    delivered yet) keeps its committed key until the next commit. The old `keyOf` did the same until its next
    miss; now the miss no longer commits, so that answer can last until the deferred turn. A monitor moved to
    another connector in that window answers with the same EDID key on both connectors, the key it keeps after
    the commit.
  - Every query therefore agrees with the engine's state at that moment. The triggering lookup no longer answers
    null.
- **Staging.** A lookup that meets an output no key set has stages `outputKeys(screens)`, if that differs from the
  last staged set, and queues the adapter's existing coalesced deferred turn (`Qt.callLater`).
- **Commit.** At the deferred turn, or at `screensChanged` if that comes first, the stages are committed oldest
  first, then (at `screensChanged`) the current screen list. Each commit calls `outputsRekeyed` with the renames
  from the previous committed set, as the old `keyOf` did at each miss.
  - So the engine receives the same `outputsRekeyed` calls with the same arguments in the same order as before.
    Only the timing changes, to a safe point outside every engine call.
  - The deferral has zero delay and is not a settle timer. It runs only after a topology change was seen, never on
    the command path, and it is the adapter's existing turn, whose callback checks `alive`. `detach` drops the
    stages.
- **Key semantics are unchanged.** `outputKeys` itself did not change: EDID triple keys, connector-qualified keys for
  identical monitors, connector names without EDID. The existing key tests pass unchanged (`outputs.test.ts`:
  E16, O05, twin re-key, overrides by connector name).
- **Convergence: the same final state as before** (unit layer and QV4 in the `qml` tool; not KWin, not nested):
  - [rekey.test.ts](../../tests/core/rekey.test.ts) runs nine event orders with the new adapter and with the old
    `keyOf` put back on one instance. The orders: a window opening on the twin; a window moving to it; a desktop
    switch; a command; a configuration change; a persistence save; `screensChanged` first; the twin leaving; the
    twin coming and going before `screensChanged`.
  - It requires, in every order, no `outputsRekeyed` while another engine call runs, and equal final contexts
    (id, layout, members), frames, saved preferences and `check()`.
  - The contexts are compared as a sorted list. A context renamed after the twin's context was created is
    re-inserted after it, so the engine's insertion order can differ; nothing else does.
  - The test also checks the staged order for the come-and-go case. There the renames are DP-1 → `@DP-1`, then
    `@DP-2` → plain, as before.
  - Two tests added in review (`wf/rekey-review`) stage two key sets before a commit, the second renaming an
    output the first added (DP-2 appears, then DP-1 goes and another monitor comes). They require both renames in
    order, DP-2 answering with its first staged key until the commit, and the same final state as the old
    adapter. In the engine test the first commit's `outputsRekeyed` reads `outputs()` and meets the monitor only
    the second set has: it re-stages the same keys, and that later commit renames nothing (two re-keys in total).
  - Against the old adapter (`cd59372`), 9 of its 15 tests fail. The 6 that pass are the `screensChanged`/`detach`
    test and five orders in which the old adapter also re-keyed outside engine calls.
  - Mutation check (review, unit): committing only the last staged set, answering from the newest stage, not
    committing on the deferred turn, dropping the stages at `screensChanged`, and answering a committed output with
    its staged key each fail at least one test. Skipping the de-duplication of equal stages fails none; it only
    saves an empty commit.
- **The QV4 scenarios still guard the forEach rule.** [qv4Scenarios.ts](../../tests/core/qv4Scenarios.ts) runs each
  adapter scenario in two modes:
  - `adapter/…` is the adapter as it is. It requires no `outputsRekeyed` inside an engine call and exactly one
    afterwards.
  - `reentrant/…` commits the keys synchronously at the first key-resolving read, before that read answers, as the
    old `keyOf` did. The deletion therefore still happens inside the engine's real loops.
  - Both modes report the state after settling (`final`), and `rekey.test.ts` requires the two to be equal.
  - [Evidence](../status/evidence/output-rekey-convergence.json): `probes/perf/qv4iter/engine.ts`, the same scenario
    file over `src/` at `cd59372` and at this change, in QV4 (Qt 6.12.0) and V8.
    - All 10 scenarios pass in both engines at this change.
    - At `cd59372` the four `adapter/…` scenarios fail on their re-key count: the re-key happened inside an engine
      call.
    - `final` is identical between the two commits in every scenario and both engines.
  - Mutation check, each fix reverted on its own, QV4: `markVisibleDirty`, `configure` and `releaseAllZones` as
    `for...of` fail their `reentrant/…` scenario. `collectEmpty` as `for...of` fails `engine/collect-emptied`.
    `contextPreferences` as live `for...of` fails `reentrant/saved-preferences` in QV4 and V8.
- **Remaining.** Whether KWin delivers events in the orders tested is still untested. A nested session cannot test
  it, because the virtual backend reports no EDID. It needs a physical session with two identical monitors. The
  orders matter less now: a lookup inside a loop no longer changes the engine.

**Revisit if** a Qt release iterates Maps and Sets as ECMAScript does (the QV4 semantics test reports the count of
deviations), or if TypeScript's checker API changes `isArrayType`/`isTupleType`.

## ADR-023: Window motion is an optional transform-only KWin effect (Plastile Motion)

**Status:** accepted (2026-10-25), merged to main as `f43de02`; task T31 reopened. Supersedes ADR-018. Refines ADR-006 without
changing it: Plastile's geometry stays instantaneous.

**Context.** The owner asked for an animation when windows move: the deliberate feature decision T31 and ADR-018
required. G2 has passed (nested). ADR-006 forbids animating real window sizes, and
[KWIN_INTERNALS §11](../research/KWIN_INTERNALS.md#11-effects-and-presentation) puts presentation in a KWin effect
that owns only the picture. A KWin script cannot transform how a window is drawn; only an effect can.

**Decision.**

- **What ships.** A separate KPackage, `effect/`: a scripted (JavaScript) KWin effect with id `plastile_motion`,
  `KPackageStructure` `KWin/Effect`, `X-Plasma-API` `javascript`, `EnabledByDefault` false. It is original code.
  A scripted effect needs no binary built against an exact KWin ABI (a native effect would; KWIN_INTERNALS §11).
  Every API it uses is the same in KWin 6.7.5 and 6.8.1 source (below).
- **Plastile is unchanged.** It still issues one immediate frame request per window per command. Nothing in `src/`
  animates, waits or knows whether the effect runs. The `animation` configuration key stays inert. The script has
  no way to reach the effect, and Plastile never writes kwinrc. Its error message now names the effect.
- **How it animates.** On `EffectWindow.windowFrameGeometryChanged(window, old)`, KWin has already applied the new
  frame. The effect calls `animate()` with two attributes:
  - `Effect.Position`: the frame centre, in absolute coordinates, from the old centre to the new one;
  - `Effect.Size`: the frame size, absolute, from the old size to the new one.

  With no anchor metadata, `AnimationEffect` scales about the centre and translates to the interpolated centre, so
  the picture is the linear blend of the two rectangles, eased.
- **Retargeting.** A change that arrives while the window animates calls `retarget()` on both animations, with the
  new target and the full duration. KWin restarts each timeline from the value it painted last; both values are
  absolute, so they stay valid after the real frame moved. Ten commands therefore make one animation that ends
  one duration after the last. If KWin already ended it, a new animation starts from the frame it ended at.
  A change within 0.5 px (added after a bug hunt) leaves a running animation as it is: KWin re-snaps a frame to the
  device-pixel grid when the client commits at a new output's scale (`XdgToplevelWindow::handleRoleCommit`,
  `snapToPixels`), for example a fraction of a pixel just after a move to an output with another scale. Such
  changes retarget it only once they add up to more than 0.5 px from its target.
- **No timers.** Every decision is taken in a KWin signal handler. The grace periods below compare
  `Date.now()` with a timestamp stored in an earlier handler; no timer is created. `Date.now()` is wall-clock time
  (QV4 reads `QDateTime::currentMSecsSinceEpoch`), so it can step back (an NTP correction, a manual time change).
  A stamp ahead of the current time counts as expired (added after a bug hunt): a step back can shorten a grace
  period, never lengthen it.
- **What is not animated** (`motionDecide`, with the reason it logs):
  - `instant`: the global animation speed is "Instant" (`effects.animationTimeFactor` 0). This is the reduced-motion
    switch, read at every change. A switch to it also stops running animations (added after a bug hunt): KWin
    reconfigures every effect when the speed changes (`Options::animationSpeedChanged` ->
    `EffectsHandler::reconfigureEffects`, which emits the script's `configChanged`), and the effect then cancels
    every animation it runs.
  - `type`: windows that are not managed normal windows, popups, and internal windows such as Plastile's inspector.
  - `invalid`, `unchanged`: a rectangle under 1 px, or a change within 0.5 px (which does not stop a running
    animation; see Retargeting).
  - `offscreen` (added in review): either rectangle overlaps no output the window was on, or its centre has a
    negative coordinate. The scrolling layout parks columns off every output (above the top output, so at negative
    y); a column scrolled in or out appears or disappears, which is not a move. `AnimationEffect` also treats a
    negative `Position` value as "unset" and leaves that axis unanimated (`animationeffect.cpp`, `case Position`,
    `anim.from[0] >= 0.0 && anim.to[0] >= 0.0`), so such a change used to log `start` while one axis jumped. The
    output a rectangle belongs to is the window's output when the effect saw that frame.
  - `maximize`: the next geometry change after `windowMaximizedStateAboutToChange`, within 1 s. KWin applies the
    frame before it updates the maximize state (`XdgToplevelWindow::handleRoleCommit` calls `updateGeometry` before
    `handleStatesAcknowledged`), so the effect marks the request instead. KWin's own maximize effect animates it.
  - `fullscreen`: the window is fullscreen, or either rectangle is its output's full geometry. This covers both
    orders of state and geometry. Consequence: a tiled window that covers its whole output (no panel, all gaps 0,
    one window) is treated as fullscreen, and its move out of that rectangle is not animated.
  - `interactive`: any window is in an interactive move or resize. Peers moved by a live resize follow the pointer.
    The resized window's late commits within 300 ms after the release are also left alone. The placement after a
    *move* (the drop) does animate.
  - `fullscreen-effect`: a fullscreen effect such as Overview is active.
  - `hidden`: the window is not visible (other desktop or activity, minimized, show-desktop).
  - `transition`: within 300 ms after a desktop, activity or output change, a show-desktop toggle, or the window's own
    minimize, desktop-membership or hidden change. Such a change also stops every running animation. An output
    change is a screen added or removed, or (added in review) `virtualScreenGeometryChanged`: an output's scale, mode
    or position changed the union of the outputs, after which KWin and Plastile re-fit every window.
  - `opening`: within 500 ms after the window appeared. Its first placement belongs to the open animation.
  - `grabbed`: another effect holds an add, close, minimize or unminimize grab on the window.
- **Interruption and cleanup.**
  - An excluded change (other than one within 0.5 px), a maximize request, a closing window, a transition or a
    switch of the global speed to "Instant" calls `cancel()`. `cancel()` does not repaint (`AnimationEffect::cancel`),
    so the effect damages the area the animation covered, plus a shadow margin.
  - A closing window is never kept alive by a move animation.
  - Unloading destroys the effect's JavaScript engine with all its connections. `AnimationEffect`'s destructor
    drops every animation, and `EffectsHandler::unloadEffect` repaints the whole scene.
- **No channel to Plastile.** The effect cannot tell Plastile's writes from other programmatic changes:
  - KWin scripts cannot set an effect window's data roles;
  - the window `tag` is the client's;
  - a scripted effect has no D-Bus or other input from scripts;
  - timing correlation would need a shared clock and would guess.

  So every qualifying programmatic change animates: Plastile's, another script's, KWin's keyboard quick tile, KWin
  keeping a window on screen, and a normal window that resizes itself (a short scale of its new content).
- **Settings.** `[Effect-plastile_motion]` holds three keys (KConfigXT, KWin's generic scripted-effect dialog):
  - `Duration`: 0 means the 180 ms default; up to 2000. It is multiplied by the global animation speed.
  - `Easing`: OutCubic (default), OutQuart, OutQuad, InOutCubic or Linear.
  - `Debug`: logs every decision as `plastile_motion start|retarget|end|skip|cancel`. It is not in the dialog.
- **Packaging.**
  - `tools/install.sh install` and `upgrade` also install the effect; `remove` removes both.
  - `install-effect` and `remove-effect` act on the effect alone, and `status` shows it and its kwinrc key.
  - The installer never writes kwinrc. It prints how to enable the effect: System Settings > Desktop Effects, or
    `kwriteconfig6 --notify`, which KWin's config watcher turns into a load (`EffectsHandler::configChanged`).
  - `tools/release.py` builds `dist/plastile_motion-<version>.zip` reproducibly, with the script's version.

**What the picture does.**

- KWin applies an xdg window's new size when the client commits it. The texture being scaled is therefore already
  the new content: during the animation it is stretched or squeezed when the aspect ratio changes.
- An X11 window's frame changes first, so its old content is scaled until the client redraws.
- There is no cross-fade. `CrossFadePrevious` renders the old window offscreen when each animation starts, with
  the GL context, inside the commit handler.

**Hit-testing.**

- Input, focus and the client's size are at the real frame from the first moment. For up to one duration the
  picture lags behind them: a click lands on the window's new rectangle even where its picture has not arrived yet.
- Measured in `motion-hit-test-T31`: a click at a moved window's real centre, while the screen still showed something
  else there, activated that window.

**Where it loads.**

- KWin loads scripted effects only when `EffectsHandler::animationsSupported()` is true: OpenGL on a hardware
  renderer, unless `KWIN_EFFECTS_FORCE_ANIMATIONS` says otherwise.
- QPainter compositing (the CI sandbox, KWin 6.7.5) and llvmpipe (CI Nix, KWin 6.8.0) do not load it. The motion
  scenarios SKIP there with that reason, and a user on such a renderer gets no animation.

**Upstream sources relied on** (read for API semantics, nothing copied). Each link pins the revision that was read:

- KWin v6.8.1, `1b798c05`:
  - [scriptedeffect.cpp](https://github.com/KDE/kwin/blob/1b798c05c19b1124edb1e16623191fcd2c128fd0/src/scripting/scriptedeffect.cpp)
    and [scriptedeffect.h](https://github.com/KDE/kwin/blob/1b798c05c19b1124edb1e16623191fcd2c128fd0/src/scripting/scriptedeffect.h):
    the script API, `animate`, `retarget`, `cancel`, `readConfig`, `animationTime`, and `animationEnded`, which
    reports id 0;
  - [animationeffect.cpp](https://github.com/KDE/kwin/blob/1b798c05c19b1124edb1e16623191fcd2c128fd0/src/effect/animationeffect.cpp):
    the Position and Size paint maths, retarget from the interpolated value, cancel without repaint, destructor;
  - [effectwindow.h](https://github.com/KDE/kwin/blob/1b798c05c19b1124edb1e16623191fcd2c128fd0/src/effect/effectwindow.h):
    properties and per-window signals;
  - [effecthandler.cpp](https://github.com/KDE/kwin/blob/1b798c05c19b1124edb1e16623191fcd2c128fd0/src/effect/effecthandler.cpp):
    `animationsSupported`, `unloadEffect` repaint, `configChanged` load and unload;
  - [workspacescene.cpp](https://github.com/KDE/kwin/blob/1b798c05c19b1124edb1e16623191fcd2c128fd0/src/scene/workspacescene.cpp);
  - [xdgshellwindow.cpp](https://github.com/KDE/kwin/blob/1b798c05c19b1124edb1e16623191fcd2c128fd0/src/xdgshellwindow.cpp):
    commit ordering;
  - [effectsmodel.cpp](https://github.com/KDE/kwin/blob/1b798c05c19b1124edb1e16623191fcd2c128fd0/src/kcms/common/effectsmodel.cpp):
    what System Settings writes.
- KWin v6.7.5, `ab7df7cc`:
  [workspacescene.cpp](https://github.com/KDE/kwin/blob/ab7df7ccb7c6af20f4b279cd6220f7cd3d2267d7/src/scene/workspacescene.cpp)
  (no OpenGL context means no scripted effects) and
  [effectwindow.h](https://github.com/KDE/kwin/blob/ab7df7ccb7c6af20f4b279cd6220f7cd3d2267d7/src/effect/effectwindow.h)
  (the same signals).
- The installed KWin 6.8.1 maximize effect, `/usr/share/kwin/effects/maximize/contents/code/main.js`
  (GPL-2.0-or-later), was read as an example of the scripted API only.

The licence remains the owner's decision (ADR-012). The effect's metadata says `Undecided`, as the script's does.
(Decided on 2026-10-26: both say `GPL-3.0-or-later`, ADR-012.)

**Evidence.**

- **Unit:** [motion.test.ts](../../tests/core/motion.test.ts), 21 tests (2 added in review, 3 after a bug hunt). They cover the
  metadata and settings schema, the duration and easing rules, every `motionDecide` reason, and the shipped `main.js` run
  against a fake scripted-effect host: start, retarget, end, cancel and repaint, the interaction rules, the transition
  cancel, closing, a backward clock step, a sub-pixel change mid-animation and a switch to "Instant" mid-animation.
- **Nested:** [scenarios_motion.py](../../tests/integration/scenarios_motion.py). The setup: KWin 6.8.1, OpenGL ES
  on the host GPU, virtual backend at 60 Hz. The effect is loaded through the nested bus's `/Effects` or the nested
  kwinrc. The oracles are KWin's frames, the fixtures' protocol logs and ScreenShot2 images of the composited
  output. The results and their numbers are in
  [STATUS](../status/STATUS.md#window-motion-t31-adr-023-nested-kwin-681) and the evidence file
  [motion-T31.json](../status/evidence/motion-T31.json).

**Consequences.**

- With the effect off, nothing changes. With it on:
  - the client and engine work are unchanged (`motion-client-cost-T31`: the same configures, the same Plastile
    counters, the same frames);
  - the visual settle time grows by one duration;
  - presentation work grows by one transformed window per animated window for that duration.
- The latency protocol must run with identical effects on both sides
  ([PERFORMANCE §6.1](../validation/PERFORMANCE.md#61-the-motion-effect-in-latency-measurements)).
- Open, physical only:
  - smoothness at 144, 100 and 60 Hz;
  - perceived lag of the picture behind input;
  - how the stretched content looks with real applications;
  - the GPU cost per frame.

  None of these can be judged in a nested session.
- Known limitations: `offscreen` and `transition` make a scrolled-in column, and the re-fit after an output
  change, appear at once; a window covering its whole output counts as fullscreen (above).

**Review (2026-10-25, branch `wf/motion-review`).** An adversarial review added the `offscreen` rule and the
`virtualScreenGeometryChanged` transition (both above), two unit tests, and the nested scenario `motion-edges-T31`.
That scenario failed 3 of its checks on the previous effect: parked columns logged `start` while one axis jumped,
and a scale change animated every window. It passes on the fixed effect. `virtualScreenGeometryChanged` is
emitted from `Workspace::geometryChanged` in both KWin 6.7.5 and 6.8.1 (`effecthandler.cpp`). Results are in
[STATUS](../status/STATUS.md#window-motion-t31-adr-023-nested-kwin-681).

## ADR-024: An alpha before G3, declaring KWin 6.7 and 6.8

**Status:** accepted 2026-10-26 by the owner, who asked for an alpha and to proceed after the recommendation
below; the licence (ADR-012) and the experimental layouts (ADR-014) stay owner decisions, and the alpha is not
distributed before the licence is chosen. (The licence was chosen on 2026-10-26: GPL-3.0-or-later, ADR-012.)

**Context.** ROADMAP §10 has one release step, gate G3, and G3 is open on physical items: latency at 144 Hz and
100 Hz (G3-3), a multi-hour normal-use soak, unplug and suspend (skipped by the owner), physical uninstall, and
the runbook repeated on the current build ([G3 checklist](../status/G3_CHECKLIST.md)). Every G1/G2 gate is met,
the first-release feature set is implemented, and a whole-project bug hunt left no critical or high findings.
The earlier rule was that KWin 6.8 is not declared supported until its physical checks are finished (G3-1b).

**Decision.** Insert a pre-release step: an alpha, version 0.1.0, which does not need the open G3 gates but
publishes them as known limitations ([release notes draft](../release/0.1.0-alpha.md), checklist
[§6](../status/G3_CHECKLIST.md#6-alpha-before-g3)). For the alpha the docs declare KWin 6.7 and 6.8 on Wayland,
each with what was exercised: 6.7.5 nested on the host and in CI, physical runbook at `97fec4a`; 6.8.1 the full
nested suite on the host (2045/2045 at `ee6f8ef`) and normal use on the reference desktop since 2026-10-25
without the runbook; 6.8.0 a provisional CI job whose reload RSS bound fails in some runs on KWin 6.8.0's own
growth ([q09-kwin68-control](../status/evidence/q09-kwin68-control.json)).

**Consequences.** G3 is unchanged: G3-1b stays open for the qualified release, which needs the physical runbook
on 6.8 before 6.8 counts toward G3-1. The alpha and the release candidate share version 0.1.0, so the qualified
release must carry a higher version. Alpha users are the first physical testers other than the owner; the
limitations list in the release notes is the contract for what was not checked.
