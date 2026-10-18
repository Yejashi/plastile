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

**Status:** accepted (2026-10-18); task T31.

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
avoids it. A probe (`probes/persistence/worker/`, not committed) found that a `WorkerScript` cannot write files
inside KWin: an XHR file `PUT` needs `QML_XHR_ALLOW_FILE_WRITE` in KWin's environment, and QML module imports are
ignored in a worker. KWin scripts have no `writeConfig`. ADR-011 already allowed "an optional small helper with
asynchronous versioned messages".

**Decision.**

- **A helper process,** `plastile-state` ([helper/](../../helper/README.md)): C++17, Qt 6 Core and DBus only.
  It owns the session-bus name `org.kde.plastile.State` and serves `Read() -> as` and
  `Write(i slot, s text) -> b` on `/State`. It stores the slots as `$XDG_STATE_HOME/plastile/state-0.json` and
  `state-1.json` (directory 0700, files 0600) with `QSaveFile`, whose `fsync` now blocks only the helper. It refuses
  a slot other than 0 or 1 and texts over 1 MiB, never interprets the text, answers in arrival order, and exits
  after 60 s without a request. There is no lock file: owning the bus name makes it the only writer, and a second
  instance exits. The session bus starts it on demand from its activation file.
- **No persistence file I/O on KWin's thread.** `Persistence.qml` is a thin asynchronous store over KWin's
  `DBusCall` (org.kde.kwin 3.0, as in ADR-015): one call object per request, destroyed with its reply, plus the
  one-shot maintenance Timer for the debounce. The QtCore `Settings` path is removed.
- **Asynchronous load.** The runtime sends one `Read` at start-up and tiles with defaults at once; it never waits
  for the reply. The reply applies the newest valid slot by the same generation and slot rules, except what the user
  changed since start-up: a context whose preferences changed keeps the user's values, and an application whose
  float decision changed keeps it (the engine now says which context or application identity a preference change
  touched). Saved floats are matched against the windows live at that moment (Q06 unchanged). Affected contexts
  re-solve in the engine's next flush; the reply callback writes no geometry, and the single writer is unchanged.
  A float restored to a window whose tile request is still in flight now waits for that request to settle: KWin
  drops a write back to the committed size while a configure is outstanding (the ledger's E04 rule), so writing at
  once left the window on its tile (found by `persist-reload-restart-T27`; unit test added).
- **Saves.** Nothing is written before the load reply, or its failure, arrives; changes made meanwhile are saved a
  quiet period after it. One `Write` is in flight at a time; changes made while it waits are saved after its reply.
  Nothing is retried by itself: what a failed `Write` carried is saved with the next change or at unload, with one
  diagnostic per run of failures. A failed or absent helper at load (`ServiceUnknown`, an error reply, a malformed
  reply) gives state `memory`, one diagnostic and no further request. A clean unload sends one final `Write` if
  dirty, after a `Write` still in flight and into the other slot. An unload while the load is pending writes
  nothing: the slots' generations are not known yet.
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
  SIGKILL the next save activates a new helper.
- `persist-helper-delayed-Q05` (every request delayed 4 s): tiling starts on defaults; the saved ratio applies to
  the untouched output when the reply arrives, about 4 s later, while the output the user changed keeps the user's
  ratio; the delayed writes land in order with the latest preferences.
- `persist-reload-cycles-Q09`: each of 20 unloads saved exactly once, so a `Write` issued from
  `Component.onDestruction` is delivered (`DBusCall::call()` sends with `asyncCall` before the object is destroyed;
  observed source).
- `persist-no-helper-Q05`: without the activation file Plastile tiles, logs one diagnostic and writes nothing.
- Probe command phase: 123 commands, no state-file event inside a command handler or within 1.5 s after one, one
  save per burst.

**Consequences.**

- Persistence needs the installed helper, a second artifact beside the `.kwinscript`: `tools/install.sh
  install-helper` builds and installs it, and `tools/release.py` ships its source tarball
  `dist/plastile-state-<version>.tar.gz`. The `.kwinscript` stays script-only; with it alone Plastile keeps its
  preferences in memory and logs `plastile warn persistence unavailable` once.
- Restore is asynchronous. The first solve uses defaults and the saved preferences apply one reply later, as a
  re-solve: 5–10 ms after start in nested runs, helper activation included. A restored layout can therefore change
  once, visibly, right after start-up. A newly opened window whose saved float arrives after its first tile write
  floats one configure later.
- Changes made before the load reply are lost if the script unloads before it arrives.
- State files of earlier development builds (`state-N.ini`) are not read; no release used them.
- Unverified: whether the final `Write` at KWin's own exit (logout) reaches the helper (only script unload was
  measured); D-Bus activation on a physical session bus (dbus-broker under systemd); the CI jobs that build the
  helper; any physical-session timing.

**Revisit if** the start-up re-solve is visible as a hitch on a physical session, the load callback grows past a
frame for real snapshots, or KWin gains a supported asynchronous file write for scripts.
