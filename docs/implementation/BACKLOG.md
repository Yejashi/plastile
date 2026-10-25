# Agent implementation backlog

All tasks are **unstarted** in the planning commit. Dependencies refer to task IDs. File paths are suggested production boundaries, not existing files. Each task should produce a scoped commit and an evidence note. A mock result does not close a compositor or physical-session criterion.

## T00 — Establish environment and implementation status

**Milestone:** M0. **Depends on:** none.

Inspect repository instructions and actual machine capabilities. Record OS, KWin/Plasma/Qt/KF package versions, Wayland/X11, GPU/renderer, outputs/scales/refresh/VRR, effects/rules/shortcuts, and nested-session tooling. Create the status/evidence directory convention and ignore generated/private artifacts appropriately.

**Acceptance:** a reproducible environment profile identifies exactly which tests can run. No source snapshot version is reported as installed. State the next task and all unavailable physical validation. Do not change the user's active compositor to collect this information.

## T01 — Refresh and verify API/source profile

**Milestone:** M0. **Depends on:** T00.

Read the pinned KWin window/workspace/tile paths and compare to the installed version. Refresh Codeberg sources if accessible. Produce a table mapping every required operation to a real property/signal/invokable and its lifetime/argument semantics. Include output transfer, per-output desktops, constraint visibility, native tile association, and reload.

**Acceptance:** unresolved capabilities have explicit probe/reproducer tasks. Internal C++ methods are not listed as script APIs. New refs are recorded without silently replacing original research evidence.

## T02 — Minimal declarative package and teardown probe

**Milestone:** M0. **Depends on:** T01.

Create the smallest loadable package with one root, one disposable shortcut, a connection registry, and a generation-checked deferred callback. Log adoption/removal of a controlled fixture window. Implement unload that invalidates callbacks before disconnecting/destroying resources.

**Acceptance:** enable/disable repeatedly with a live window and pending callback. Exactly one handler fires per shortcut, no callback fires after teardown, and connection/object counts return to baseline. Verify package metadata and entry format in actual KWin.

## T03 — Timing and controlled-client fixture

**Milestone:** M0. **Depends on:** T02.

Build/choose a client with min/max constraints, delayed resize response, app-initiated resize, transient child, and render markers. Establish monotonic timestamps with calibrated resolution and a way to correlate input, request, observed frame, client commit, and presentation where available. Native measurement-only tooling may be separate from the production runtime.

**Acceptance:** demonstrate a deliberately delayed commit and show distinct request/observation times. Document unobservable stages rather than estimating them from a log. Timestamp overhead and clock-domain conversion are measured.

## T04 — Baselines and repeatable workloads

**Milestone:** M0. **Depends on:** T03.

Run no-tiler and native quick-tile controls. Select an installed-compatible automatic upstream baseline and Mudeer-style direct placement control; use Karousel only for later scrolling comparisons. Define deterministic workload seeds and preserve configuration/effects.

**Acceptance:** raw samples, exact versions, fixture parameters, and workload order can reproduce the baseline. Each tiler runs separately. Report unsupported versions rather than patching an upstream project extensively and still calling it the original baseline.

## T05 — Direct geometry spike

**Milestone:** M1. **Depends on:** T02, T03.

Implement a tiny pure master/stack calculator and direct adapter for controlled windows. Include outgoing request registration before writes, scalar rectangle diffing, one scheduled flush, immediate commands, and no-op detection. Add counters for solve/write/observation/correction.

**Acceptance:** ratio, swap, and no-op workloads work; A→B→A with delayed client commit is recorded. A focus-only command writes no geometry. Code remains isolated from production modules until G1.

## T06 — Native tile spike

**Milestone:** M1. **Depends on:** T02, T03.

Project the same small layout into a disposable native root. Use `manage/unmanage`, native minima/padding verified against the release, stable nodes, and explicit root ownership. Count every native structural and geometry operation.

**Acceptance:** ratio change does not destroy the tree; no-op produces no mutations; close/removal and unload do not leave ghost membership. Record native-editor and activity behavior. Do not overwrite a real user's existing layout as part of the experiment.

## T07 — Compare spikes and resolve G1

**Milestone:** M1. **Depends on:** T04, T05, T06.

Run the M1 experiment table for both paths with matched targets and clients. Compare correctness, pipeline percentiles, mutation counts, configure counts where observable, and teardown. Update ADR-003 with the selected production backend and exact reasons.

**Acceptance:** there is one selected default and a documented capability/latency tradeoff. No claim is based solely on language, subjective smoothness, or solver microbenchmarks. Failed cases become executable regressions.

## T08 — Narrow native capability spike, conditional

**Milestone:** M1/G4. **Depends on:** T07 identifying a concrete limitation.

Implement only the smallest missing capability: requested-geometry observation, high-resolution tracing, transform presentation, or another demonstrated API gap. Build against exact packaged KWin headers and isolate the integration boundary.

**Acceptance:** identical fixtures demonstrate the problem is resolved and quantify overhead. Load/unload and failure behavior pass. If no missing capability exists, close this task as not required with G1 evidence; do not add native code speculatively.

## T09 — Core identities and model

**Milestone:** M2. **Depends on:** T07.

Implement window/context records, instance/window/topology generations, stable ordering, mode plus suspension state, and property ownership. Keep live Qt objects in the adapter registry. Define model invariants and assertion/debug helpers.

**Acceptance:** add/remove/reuse-ID/context-move sequences preserve invariants. Tombstones invalidate stale events. Titles/classes are never primary identity. Model tests require no KWin globals.

## T10 — Event normalizer and signal registry

**Milestone:** M2. **Depends on:** T09.

Map real runtime signals into the vocabulary in the architecture document. Snapshot safe values before deferral. Separate structural events from expected property observations. Register/disconnect every signal through an owner.

**Acceptance:** removal during a geometry callback is preserved; duplicate discoveries do not duplicate records; membership changes dirty old and new contexts; destroyed native wrappers are not touched by later callbacks. Add normalized replay fixtures.

## T11 — Scheduler and typed dispatcher

**Milestone:** M2. **Depends on:** T10.

Implement immediate commands, ordered commands received during apply, indexed lifecycle coalescing, full-context dirty reason sets, and one stable deferred flush. Use `try/finally` for guards. Introduce no recurring idle timer.

**Acceptance:** a burst solves each affected context at most once per flush; real repeated ratio commands retain their accumulated semantics; create/remove cancellation works; a thrown callback does not freeze later commands; no context is resolved from mutable global focus after deferral.

## T12 — Geometry primitives and master/stack solver

**Milestone:** M2. **Depends on:** T09.

Implement value rectangles, shared cut allocation, gap accounting, simple feasibility, stable master/stack order, singleton behavior, master count/ratio, and overflow fallback. Add exact examples with odd dimensions and negative origins.

**Acceptance:** positive finite rectangles, coverage/gap conservation, deterministic results, no accidental overlap, stable order, and sensible infeasibility output. Property tests use an independent coverage/minimum oracle rather than reproducing the solver formula.

## T13 — Placement plan, diff, and production adapter

**Milestone:** M2. **Depends on:** T11, T12, selected-backend evidence T07.

Implement one geometry writer, plan validation, owned-property diffs, request registration before writes, and safe per-window application. For a native selection, implement an incremental node projector and root ownership; for direct geometry, manage native-yield semantics explicitly.

**Acceptance:** no-op plan makes zero external mutations; focus-only command makes zero geometry requests; one ordinary target makes one request per changed window; a window disappearing halfway through a batch does not abort peer updates or leave guards set.

## T14 — Diagnostics and replay harness

**Milestone:** M2. **Depends on:** T10, T11, T13.

Add bounded in-memory event/transaction traces, stage counters, reason IDs, and replay serialization. Keep formatting/export off hot paths. Build deterministic replay from normalized fixtures with a mock clock and adapter.

**Acceptance:** the same seed/trace yields the same model/plan; traces can explain every write; capacity remains bounded; export redacts titles by default. Instrumentation overhead is reported and disabled production mode is measured separately.

## T15 — Requested/observed convergence

**Milestone:** M3. **Depends on:** T13, T14.

Implement outstanding request generations, bounded recent-target history, old-observation recognition, deadline/correction policy, and divergence fallback. Include rapid A→B→A while the client delays B and returns to A.

**Acceptance:** the script does not treat its sequence as an xdg serial; a return-to-A request is not skipped because observed geometry is still A; late callbacks cannot overwrite a newer target. At most the configured bounded corrections occur, and a divergent client becomes a diagnosed visible exception.

## T16 — Classification and transient handling

**Milestone:** M3. **Depends on:** T10, T15.

Classify normal/dialog/helper/system windows and parent relationships. Implement bounded late-metadata readiness, exclude own UI, and keep transients floating/visible by default. Cache classification and reevaluate only relevant changes.

**Acceptance:** portal/bridge/1×1 helpers do not consume tiles; dialogs follow parent visibility appropriately; create→remove before readiness performs no write; excluded surfaces incur minimal hooks/work. Include a deliberately misleading application title/class fixture.

## T17 — Minimize, fullscreen, and maximize state

**Milestone:** M3. **Depends on:** T15, T16.

Implement orthogonal suspension transitions and restoration. Preserve tiled/float intent and property ownership. Honor native fullscreen/maximize instead of fighting it; retain peer order.

**Acceptance:** combinations and rapid toggles work under delayed commits. A minimized fullscreen window is not retiled when only fullscreen clears. Restores do not apply old output/context geometry or overwrite later user float changes.

## T18 — Constraint feasibility and bounded learning

**Milestone:** M3. **Depends on:** T12, T15.

Add min/max aggregation, fixed-size fallback, feasible ratio intervals, accepted-size learning, and explicit limitations for unavailable increment/aspect hints. Keep constraint caches versioned by metadata/observation changes.

**Acceptance:** impossible layouts produce deterministic overflow explanations; the client and tiler do not oscillate; accepted rounding differences do not cause repeated writes. Test Wayland and XWayland controlled clients separately.

## T19 — Ownership yielding and lifecycle recovery

**Milestone:** M3. **Depends on:** T15, T17.

Handle explicit user/native quick tiling, external moves, suspend/resume, and recovery reconcile. Implement safe restore of properties only while still owned. Test teardown with queued commands/deadlines.

**Acceptance:** native placement is not immediately undone; repeated enable/disable leaves one engine; resume adopts current live state without reviving closed windows. Recovery is usable but not invoked continuously to mask broken incremental events.

## T20 — G2 integration/performance gate

**Milestone:** M3. **Depends on:** T14–T19.

Run mandatory lifecycle/reversal/constraint fixtures and M1 performance workloads on actual KWin. Analyze the worst tail samples, trace amplification, and instrumentation effects. Fix unexplained regressions before adding layout scope.

**Acceptance:** G2 report includes pass/fail by scenario, actual environment, raw data, bounded correction counts, teardown evidence, and remaining API gaps. Pure replay success alone cannot close this task.

## T21 — Persistent BSP

**Milestone:** M4. **Depends on:** T20.

Implement stable branch/leaf IDs, insertion axis/ratio policy, collapse on removal, rotation/mirror, and feasible divider updates. Keep tree mutations independent from KWin and incremental native projection if applicable.

**Acceptance:** randomized operation sequences preserve leaf uniqueness, parent consistency, node counts, and unchanged subtree identity. A focus event does not reconstruct the tree. Deep unbalanced trees are bounded/handled without an unsafe recursion overflow.

## T22 — Monocle and floating completion

**Milestone:** M4. **Depends on:** T17, T20.

Implement explicit monocle selection/stacking, transient visibility, and restore/floating behavior shared with all layouts. Keep minimize-rest out of the default.

**Acceptance:** focus cycles do not minimize unrelated windows; dialogs stay usable; switching layout preserves order and user float geometry; disable does not leave opacity/layer artifacts.

## T23 — Directional focus and structural commands

**Milestone:** M4. **Depends on:** T21, T22.

Implement deterministic directional candidate scoring, wrap options, swap versus reinsert, master promotion, ratio/equalize commands, and command no-op reasons. Resolve targets at dispatch.

**Acceptance:** fixture tables cover ties, irregular rectangles, floating exclusions, and output boundaries. Focus-only operations cause no ordinary layout solve/write. Two queued grow commands retain both steps.

## T24 — Context transfer and membership

**Milestone:** M4. **Depends on:** T19, T23.

Implement send-to-output/desktop with separate follow policy, per-output desktop visibility, activity switching, and conservative multi-membership behavior. Preserve source and destination dirty contexts.

**Acceptance:** send does not force desktop follow by default; stale transfer callbacks do nothing; source/destination reflow once; pinned/multi-context windows do not receive conflicting targets.

## T25 — Schema and deterministic rules

**Milestone:** M5. **Depends on:** T20.

Implement strict schema/defaults, precedence, exact/glob/explicit regex matchers, immutable config revisions, and explained decisions. Bound custom declarative data and pattern inputs.

**Acceptance:** invalid/unknown fields fail usefully; rule priority/order fixtures match specification; unchanged metadata uses cached results; pathological configuration limitations are documented. No executable user JS is evaluated in KWin.

## T26 — Atomic activation and shortcut integration

**Milestone:** M5. **Depends on:** T25, T23.

Implement activation validation/compilation before publish, minimum invalidation, stable shortcut IDs, conflict detection, and reload without duplicate handlers. Confirm supported settings bridge from M0.

**Acceptance:** invalid revision retains the previous config; gap-only changes do not reclassify every app unnecessarily; rapid reload produces one active engine/handler; user bindings survive updates. Meta+T is not silently stolen.

## T27 — Persistence and migration

**Milestone:** M5. **Depends on:** T24, T26.

Persist supported preferences and float geometry asynchronously via the selected supported path. Implement versioned snapshots, conservative app matching, output preference fallback, and pure schema migrations. Do not persist live Qt pointers/session IDs as durable identity.

**Acceptance:** helper unavailable still permits tiling; restart ambiguity uses normal insertion; floating restore derives from actual float use; interrupted/invalid saves retain a prior valid snapshot. Migrations have input/output fixtures.

## T28 — Lazy settings and explanations UI

**Milestone:** M5. **Depends on:** T25–T27.

Build a small schema-driven settings surface and inspect/explain-window view. Keep model data authoritative; UI sends activation/commands and never writes geometry. Preview/cancel uses config revisions.

**Acceptance:** the UI is not instantiated for keyboard-only use; cancel does not resurrect closed-window references; settings labels describe behavior; large configuration work does not enter the command path.

## T29 — Drag preview and shared resize

**Milestone:** M6. **Depends on:** T23, T24, T26.

Implement temporary user ownership, optional model-derived drop preview, one release commit, feasible divider resize, and cancellation. Restrict pointer sampling to active interaction.

**Acceptance:** no fight during drag; no full solve per pointer event; release applies promptly; escape, close, output removal, and disable all stop sampling and remove previews. Live peer resize is frame-coalesced and measured.

## T30 — Output/work-area robustness

**Milestone:** M6. **Depends on:** T24, T29.

Handle output identity/reorder/replug, negative origins, mixed fractional scales/rotation, per-output desktops, temporary invalid geometry, and panel work-area changes. Migrate safely on unplug and invalidate old topology requests first.

**Acceptance:** no off-screen orphan; no double subtraction of panels/padding; odd-dimension coverage remains correct; stale old-output callbacks make no writes. Physical and nested results are identified separately.

## T31 — Optional presentation spike

**Milestone:** M6 or later. **Depends on:** T20, T29, a deliberate feature decision.

If animation is desired, implement transform-only presentation with retargeting, reduced-motion, bounded repaint, and cleanup. Use a native effect only when required and build against exact supported KWin versions.

**Acceptance:** rapid commands never queue behind animation; visual changes do not generate intermediate real-client resize streams; hit-testing matches actual interaction; disable mid-animation restores a usable desktop. Otherwise keep animation disabled and close as deferred.

**State (2026-10-25):** closed as deferred by ADR-018, then reopened at the owner's request. It is implemented as the optional scripted effect Plastile Motion ([ADR-023](../design/DECISIONS.md#adr-023-window-motion-is-an-optional-transform-only-kwin-effect-plastile-motion)): `effect/`, `tests/core/motion.test.ts`, `tests/integration/scenarios_motion.py`. The acceptance clauses pass in nested KWin 6.8.1. Smoothness and perceived lag on physical displays are open.

## T32 — Build/package/install/update/remove

**Milestone:** M7. **Depends on:** T26, T30.

Pin build tools/dependencies, produce a reproducible KWin package, verify runtime imports/metadata, and supply scoped installation/update/removal instructions. Native components, if present, require version-specific builds and load checks.

**Acceptance:** clean environment builds; package installs in a disposable user profile; update preserves config; removal releases shortcuts/resources/owned state. No automatic restart of the user's active Wayland compositor.

## T33 — CI and compatibility suite

**Milestone:** M7. **Depends on:** T21–T30, T32.

Run pure/replay/property tests, document integration availability, and create reproducible nested fixtures for supported KWin families. Keep physical validation as an explicit release step where CI cannot provide it.

**Acceptance:** CI cannot pass by skipping mandatory tests unnoticed; version/capability matrix is accurate; known unsupported cases have clear messages. Regression fixtures cover every production workaround.

## T34 — Performance qualification and long-session churn

**Milestone:** M7. **Depends on:** T33.

Execute the full performance protocol, randomized baseline ordering, repeated bursts/commands, mixed app constraints, reload loops, and long-session resource tracking. Inspect worst samples and keep instrumentation-disabled runs.

**Acceptance:** release budgets and correctness gates pass on declared reference machines; resource growth is bounded after warmup; idle produces no periodic Plastile work; physical first-response/settled timing is reported honestly.

## T35 — Release documentation and G3

**Milestone:** M7. **Depends on:** T34.

Write actual supported versions, feature/default semantics, configuration/rule help, shortcut conflicts, recovery/uninstall steps, limitations, and benchmark methods/results. Replace planning status with exact implemented status only when justified.

**Acceptance:** G3 checklist is complete; no proposed target is presented as measured; screenshots/claims match the package; owner license/reuse decision is recorded before distribution. If physical gates remain unavailable, publish candidate status rather than declaring a fully qualified release.

## T36 — Scrolling layout, later release

**Milestone:** M8. **Depends on:** T35.

Write and implement a dedicated column/viewport model with preferred widths, centered/lazy policies, stacking, transient visibility, per-output strips, and explicit off-screen/input behavior. Reuse common state/reconciliation; test a narrow effect if clipping/input limitations reproduce.

**Acceptance:** no permanent invisibility/opacity or adjacent-output input leakage; focus/scroll policies match fixtures; rapid reversal and disable work. Benchmark against a scrolling baseline with the same workload, not a master/stack solver.

## T37 — Zones and declarative layout authoring, later release

**Milestone:** M9. **Depends on:** T35.

Implement normalized zone data, direct keyboard commands, then lazy overlay/selector/editor. Use one pure geometry model, validated limits, per-context layout selection, and floating restore. Keep executable extension support outside this task.

**Acceptance:** keyboard and UI targets agree; overlay-hidden mode does no polling; output offsets/scales/panels work; malformed layouts retain the last valid state; manual zone operations use the same ownership and request protocol.

## Recommended commit granularity

Commit runnable probes first, then a selected-backend evidence record, then pure model/scheduler/layout slices, then lifecycle fixes and fixtures, then configuration and interaction. Each commit should leave the current tests runnable. Avoid a single giant “implement tiling” change: it makes both correctness and latency regressions much harder to locate.
