# KDE tiling: source-level state of the art

## 1. Findings that should shape Plastile

There is no single demonstrated fastest KDE tiler in the evidence gathered here. These projects have different interaction models, feature sets, dependency boundaries, and historical compatibility targets. Their repositories do not provide a common input-to-presentation benchmark. Treat any speed ordering inferred from language, stars, a promotional website, or a short demo as unsupported.

The strongest implementation ideas are nevertheless clear:

1. **Keep a layout model independent of live windows.** Krohnkite/Bismuth separate driver, controller, layout, and window state. Polonium separates abstract tiles from native KWin tiles. Karousel separates desktop, grid, columns, wrappers, and window states. This makes deterministic replay and independent testing possible.
2. **Batch related invalidations, not unrelated user intentions.** Polonium queues and simplifies events. PlasmaZones coalesces affected screens through queued work and also offers synchronous operations. A command such as swap should execute immediately when safe; repeated lifecycle signals can converge into one solve.
3. **Distinguish a requested rectangle from the current frame.** KWin Wayland resizing is asynchronous. PlasmaZones explicitly compares the commanded rectangle and tracks command stamps. Immediate read-back equality is an insufficient completion test.
4. **Make context explicit.** Output, desktop, and activity identity must travel with work. Polonium builds display identities; PlasmaZones exposes the tradeoff in queued work keyed only by screen. Karousel illustrates the consequences of choosing one selected output for a desktop model.
5. **Window ownership and cleanup are part of speed.** A duplicate instance or stale callback can multiply work and destabilize the desktop. Bismuth and Karousel contain explicit connection cleanup; the Krohnkite continuation's README warns about duplicate instances on reload.
6. **Animation belongs to presentation.** A compositor effect can animate a rendered transform without asking every application to redraw at every intermediate size. Layout commands must continue while an optional effect retargets.
7. **A native tile tree is useful, but mutations have consequences.** KWin updates managed windows and emits signals when tile geometry changes. Reconstructing a tree through temporary minimum sizes can create unnecessary geometry and notification churn even if KWin coalesces some protocol configures.

These are architectural conclusions from the pinned paths below. Their effect on a particular machine is a hypothesis until measured. The [source index](SOURCE_INDEX.md) records immutable refs and acquisition boundaries. The [KWin report](KWIN_INTERNALS.md) explains the underlying mechanisms.

## 2. Four implementation families

| Family | Examples | Geometry authority | Main benefit | Main cost or constraint |
|---|---|---|---|---|
| Script-owned dynamic layout | Krohnkite, Bismuth, Grid-Tiling-Kwin, legacy kwin-tiling | Script model requests window rectangles | Flexible policies and simple deployment inside KWin | Must handle feedback, constraints, scope, and restore correctly |
| Automation around native tiles | Polonium, Fluid Tile | KWin tile tree plus script policy | Native tile editing and connected resizing | Shared tree ownership, mutation side effects, API changes |
| Scrolling layout | Karousel; PlasmaZones scrolling engine | Strip/column model projected onto a viewport | Stable preferred widths and focus-driven navigation | Off-screen windows, focus, transient visibility, hit-testing, multi-output semantics |
| Zones / compiled hybrid | KZones, Mudeer; PlasmaZones hybrid | Preset rectangles or daemon/effect placement protocol | Direct placement or richer native integration | Zones are not an automatic layout; a hybrid adds IPC/state/ABI costs |

The category boundaries describe the inspected code, not an exhaustive marketing feature list. A project may combine several families.

## 3. P01: original Krohnkite

**Snapshot:** `esjeon/krohnkite`, commit `bc6fe23afe4e` (2022). This is historical Plasma-era source, not the Plasma 6 continuation.

**Implementation path.** `KWinDriver.main()` loads configuration, connects workspace events and shortcuts, wraps existing clients, then asks `TilingEngine.arrange()` to arrange all screens. A `WrapperMap` associates KWin clients with engine windows. The engine maintains a `LayoutStore` and `WindowStore`, picks a layout for the surface, calculates geometry, and calls each window's commit method. The tile layout is master/stack; other classes implement monocle, quarter, spiral, and desktop-oriented alternatives. See [driver](SOURCE_INDEX.md#p01-driver), [engine](SOURCE_INDEX.md#p01-engine), [layout](SOURCE_INDEX.md#p01-layout), and [window state](SOURCE_INDEX.md#p01-state).

**Scheduling.** The driver wraps callbacks in `enter()`. If already inside a handler, it returns rather than processing another nested event. This prevents a synchronous signal cascade when its own property assignments cause KWin signals. Newly added clients are handled after their first `windowShown`, with a 50 ms fallback. This is a readiness workaround, not a general per-action 50 ms delay.

**Geometry.** `KWinWindow.commit()` updates border/layer flags and applies an adjusted rectangle. `adjustGeometry()` accounts for fixed sizes, min/max constraints, and resize increments. Floating geometry is remembered independently in the engine state. The implementation uses old names such as `activeClient`, integer screens/desktops, and `client.geometry`; these must not be copied into a modern adapter. See [window adapter](SOURCE_INDEX.md#p01-window).

**Strengths.** Small, understandable layered architecture; layouts are largely separate from KWin; explicit floating state; constraint handling; keyboard-first interaction. The repository includes an independent test driver, which is an important precedent for testing policy without a compositor.

**Weaknesses and latency implications.** `arrange()` traverses all current screens and filters window collections, even when one context changed. A coarse re-entry guard can discard a genuine nested state change as well as self-generated noise. The engine and adapter do not provide a full asynchronous request/observation protocol. Broad commits can repeat property writes. These are possible work amplifiers, not measurements of observed lag.

**Take into Plastile:** driver/core separation, per-layout state, restore semantics, and a test driver. **Improve:** affected-context invalidation, command diffing, and deferred reconciliation rather than dropping all nested events.

## 4. P02: anametologin's Krohnkite continuation

**Snapshot:** GitHub commit `f5865562955c` (December 2025). The README explicitly moves the project to Codeberg; that current home was inaccessible during this audit. Do not label this snapshot as the latest Codeberg implementation.

**Implementation path.** The continuation retains the driver/engine/layout/window organization, modernizes the API for KWin 6, and adds more layouts and surface policies. The driver is substantially larger: it handles moving windows across outputs, grouped operations, pointer behavior, and modern workspace/window signals. The engine gathers `currentSurfaces`, derives tileable sets and capacity, optionally transfers overflow windows, then arranges each surface. See [driver](SOURCE_INDEX.md#p02-driver), [engine](SOURCE_INDEX.md#p02-engine), and [window adapter](SOURCE_INDEX.md#p02-window).

**Scheduling and workarounds.** It retains the coarse `entered` guard. Output transfer paths poll through 20 ms timer steps with bounded waits; the grouped transfer path inspected has a 100 ms maximum wait. Timer objects are pooled and created as QML objects. These waits apply to specific transfer paths; do not attribute them to all focus or placement commands. The geometry adapter applies a rectangle, optionally checks neighboring outputs for confinement, and can schedule pointer movement. See [timer pool](SOURCE_INDEX.md#p02-timer).

**Strengths.** A valuable collection of real KWin 6 edge cases; mature layout vocabulary; explicit output topology; per-surface policies; boundaries inherited from the original.

**Weaknesses and latency implications.** More policy in one large driver increases coupling and makes it harder to isolate the cost of a simple command. Cross-output polling adds a timer-dependent tail. Global arrangement and overflow transfers can expand a local operation into work across outputs. The [README](SOURCE_INDEX.md#p02-readme) warns that toggling the script can start multiple instances and recommends restarting for configuration changes. That warning makes reload correctness a mandatory Plastile release gate; it is not a statement about an independently tested current Codeberg release.

**Take into Plastile:** the practical event/capability checklist and surface policies. **Improve:** signal-driven transfers with generation-checked deadlines, a narrow adapter, and deterministic unload/reload.

## 5. P03: Bismuth

**Snapshot:** `Bismuth-Forge/bismuth`, commit `ef69afe69f61` (December 2022); repository archived in 2024. Its architecture is frequently misdescribed as an entirely native tiler.

**Implementation path.** The layout/management engine remains TypeScript under `src/kwinscript`. A QML entry point wires it to KWin. Supporting C++ provides actions, configuration integration, and a TypeScript proxy; a KCM supplies settings pages, and a decoration component provides appearance integration. `Controller::registerAction()` creates `QAction`s, sets component metadata, registers shortcuts with KGlobalAccel, and connects callbacks. See [script driver](SOURCE_INDEX.md#p03-driver), [engine](SOURCE_INDEX.md#p03-engine), [C++ action bridge](SOURCE_INDEX.md#p03-core), [proxy](SOURCE_INDEX.md#p03-proxy), and [KCM](SOURCE_INDEX.md#p03-kcm).

**Lifecycle.** `DriverImpl` records signal/callback pairs and `drop()` disconnects them, tolerating already-deleted objects. Event handlers use a re-entry guard. This improves explicit resource ownership over relying on garbage collection or an undefined workspace sentinel. Existing clients are adopted through a management method, with ignored clients filtered before binding most behavior.

**Strengths.** Strong product integration: configuration pages, discoverable shortcut actions, appearance, and connection lifecycle. The TypeScript/C++ boundary demonstrates that a native helper can be added surgically without rewriting the solver.

**Weaknesses and latency implications.** More build/distribution dependencies and older KWin APIs. The architecture inherits broad arrangement and coarse event suppression patterns. A C++ helper does not establish that the layout path is faster than other scripts. A native settings UI is a usability feature, not latency evidence.

**Take into Plastile:** action IDs, explicit cleanup, coherent settings, and selective native helpers. **Avoid:** adding a compiled dependency before an actual missing capability or measured bottleneck requires one.

## 6. P04: Polonium's newer implementation

**Snapshot:** `zeroxoneafour/polonium`, commit `227967ed4482` (September 2026). A historical issue announced an end to the earlier project in 2024; the current source has changed. Treating Polonium as simply dead would miss this implementation.

**Implementation path.** A declarative QML root supplies the workspace/API, an event timer, shortcuts, settings, and optional D-Bus integration. The controller owns drivers keyed by a display identity containing desktop, activity, and output. Window/workspace handlers generate typed events. An abstract tiling engine produces engine tiles; a driver maps them onto native KWin tiles. See [controller](SOURCE_INDEX.md#p04-controller), [events](SOURCE_INDEX.md#p04-events), [driver](SOURCE_INDEX.md#p04-driver), and [QML root](SOURCE_INDEX.md#p04-main).

**Scheduling.** Events and post-events are queued. `processEvents()` simplifies the queue, determines affected displays, rebuilds each relevant native tree, and runs post-events. Configuration defaults `RebuildDelay` to 10 ms. While processing, most newly queued events are rejected unless explicitly forced. Event simplification cancels opposing tile operations, merges commands into an initial add, cancels create/delete pairs, and removes duplicates. Some passes search previously accumulated events, so worst-case burst simplification can be quadratic. The timer is a QML timer; its requested interval is not a measured dispatch bound. See [config](SOURCE_INDEX.md#p04-config) and [event simplifier](SOURCE_INDEX.md#p04-events).

**Native tree reconciliation.** `buildLayout()` traverses engine/native pairs breadth first. A direction mismatch removes existing children. Child counts are matched by removal/splitting. Existing siblings may first be sized to a temporary minimum (`0.15001`) before the final relative sizes are applied in reverse order. The driver hooks native tile geometry/child signals and uses `Tile.manage(window)` when the assignment changed. It can also update engine sizes from edited native tiles. See [reconciler](SOURCE_INDEX.md#p04-build) and [BSP engine](SOURCE_INDEX.md#p04-btree).

**Strengths.** Strongest small-project example here of native KWin tile integration with a modular engine and event normalization. It explicitly considers multiple displays, native editing, persistence, and tile-to-engine mapping. Commands and events have shapes that can be tested independently.

**Weaknesses and latency implications.** The controller deliberately avoids rebuilding other activities because KWin tile roots are shared across activities; that is a real backend constraint. Queue deferral adds scheduling delay. Coarse suppression while processing risks missing unrelated state. Temporary sibling resizing can emit many changes. Correctness and speed depend on how much native tree structure survives each operation. None of these prove that the current implementation is slow; they identify what an apples-to-apples benchmark must count.

**Take into Plastile:** typed events, abstract/native separation, affected-display sets, native manage/unmanage, and bidirectional resize integration. **Improve:** an incremental structural diff, stable node identities, explicit ownership of the native editor, and preservation of essential events while applying a transaction.

## 7. P05: Karousel

**Snapshot:** `peterfajdiga/karousel`, commit `8b9f0b62b292` (August 2026).

**Implementation path.** `World` coordinates client and desktop managers. A desktop contains a grid of columns; columns contain windows, including stacked arrangements. Scrollers and clampers implement centered, grouped, or lazy viewport behavior. Columns are kept in a linked list; moving or resizing a column updates following x positions. The layout projects its strip using the desktop's scroll offset, keeping preferred window widths rather than squeezing every window onto a screen. See [world](SOURCE_INDEX.md#p05-world), [context](SOURCE_INDEX.md#p05-context), [grid](SOURCE_INDEX.md#p05-grid), and [column](SOURCE_INDEX.md#p05-column).

**Geometry and event handling.** `ClientWrapper.place()` avoids fighting an active resize, records a last placement, assigns `frameGeometry`, and contains an off-screen Wayland workaround that nudges x and reapplies. A manipulation guard distinguishes its own operations; the tiled state compares real rectangle fields and rate-limits external geometry corrections. Explicit state classes cover floating, tiled, minimized, pinned, and docked behavior. Signal ownership is collected in `SignalManager`. See [wrapper](SOURCE_INDEX.md#p05-wrapper), [tiled state](SOURCE_INDEX.md#p05-tiled), and [signal manager](SOURCE_INDEX.md#p05-signals).

**Delays and context.** Grid resize completion uses a 50 ms delayer, with a comment about preventing frozen contents after resize. `World` has a 1000 ms screen-resize delayer to allow dock/client-area settlement. These are special-path delays, not the ordinary keyboard path. The inspected desktop manager keys desktops by activity and desktop and uses one `selectedScreen`, rather than a full independent `(output, desktop, activity)` strip map. That limits the meaning of simultaneous multi-output support. Do not infer capability from a screenshot on one ultrawide.

**Strengths.** Thoughtful interaction policies, explicit state transitions, scoped cleanup, alternative scrolling policies, and a substantial mock/flow-test collection. Particularly useful for learning about preferred widths, external resize, transient positioning, and focus passing.

**Weaknesses and latency implications.** A scrolling strip introduces off-screen visibility, opacity, stacking, and input concerns that ordinary tiling does not have. A focused-window change may reposition many windows. Geometry nudges can multiply writes. The chosen context model and special settle delays are constraints to evaluate. Mock tests are valuable but cannot establish physical presentation latency or Wayland client behavior.

**Take into Plastile:** state-specific handling, flow fixtures, preferred-width policy, and cleanup. **Defer:** scrolling until basic automatic tiling and output/context handling are stable. Use a separate viewport model rather than adding an x-offset hack to master/stack.

## 8. P06: Fluid Tile

**Snapshot:** `Serroda/fluid-tile`, GitHub mirror commit `a980ec9c19e4` (March 2026). Current Codeberg contents were inaccessible.

**Implementation path.** A QML root creates an ES-module `Engine`. Separate modules handle blocklists, desktops, tiles, windows, UI, shortcuts, userspace, and timers. The script uses the existing native tile layout as the target structure. It assigns windows to tiles, selects alternate layouts or creates desktops when capacity is exhausted, and extends windows to occupy otherwise empty tile space. See [engine](SOURCE_INDEX.md#p06-main), [windows](SOURCE_INDEX.md#p06-windows), and [tiles](SOURCE_INDEX.md#p06-tiles).

**State and scheduling.** Window properties such as a shadow tile and avoidance flags preserve assignments through maximize and tile changes. A per-ID timer helper restarts an existing timer job, otherwise adds a QML Timer delegate through an `Instantiator`. Zero-delay deferral is used where geometry has not yet settled; another-screen tile exchange uses a configurable extension delay. The inspected QML defaults are 350 ms for that tile-change extension and 300 ms for desktop removal. These settings do not delay every new window. See [timer](SOURCE_INDEX.md#p06-timer) and [QML configuration](SOURCE_INDEX.md#p06-qml).

**Strengths.** A practical design for users who want automatic placement into their Meta+T layout. Modules are accessible; overflow and empty-space policies are visible; multiple screens and alternate layouts are explicit concerns.

**Weaknesses and latency implications.** Shadow properties and avoidance booleans encode a distributed state machine. Asynchronous callbacks must remain consistent with the native tile that may have been removed or edited. Repeated full-window/desktop scans and QML model changes can amplify work. A restartable timer can defer work until a burst becomes quiet; this is suitable for cleanup but risky for core command responsiveness. Native layout editing and extension may make it unclear which representation owns a window's final size.

**Take into Plastile:** explicit overflow modes and native-layout automation. **Improve:** typed side-table state, context generations, immediate versus maintenance scheduling lanes, and a documented native-tree ownership model.

## 9. P07: PlasmaZones

**Snapshot:** `fuddlesworth/PlasmaZones`, commit `b0345bd89c71` (October 2026). This is a much larger compiled hybrid, not simply another small KWin script.

**Implementation path.** A KWin effect handles native windows, input/render integration, and geometry application. A daemon and libraries implement placement policies, layouts, scrolling, rules, persistence, overlays, and configuration. A D-Bus client/geometry-handler boundary carries commands and batched placements. The effect's bridge accesses `KWin::Window`, filters deleted windows, and handles native geometry details. See [daemon boundary](SOURCE_INDEX.md#p07-daemon), [batch handler](SOURCE_INDEX.md#p07-batch), and [bridge](SOURCE_INDEX.md#p07-bridge).

**Scheduling.** The autotile engine gathers pending screen IDs and posts one `QMetaObject::invokeMethod(..., Qt::QueuedConnection)` when needed. User operations can retile synchronously, removing an already-pending retile for that screen. Invalid/transient geometry has a separate bounded retry path. The inspected code explicitly documents a tradeoff: deferred screen-keyed work resolves against the context current when processed, so an old context may remain stale until a later operation. This is a valuable limitation to improve in Plastile by carrying full context keys and revisions. See [retile scheduler](SOURCE_INDEX.md#p07-retile).

**Geometry correctness.** The effect distinguishes committed `frameGeometry` from `moveResizeGeometry`, the outstanding commanded geometry. It assigns command stamps, invalidates earlier deferred work, avoids redundant requests, and handles rapid reversals while an animation or Wayland configure is in flight. A specific stale-ack path covers commanding the current committed size while another size remains outstanding. Per-window deferred operations are cancellable and parented to an owner, with pending state consumed before invoking callbacks. See [geometry application](SOURCE_INDEX.md#p07-apply) and [deferred commits](SOURCE_INDEX.md#p07-deferred).

**Animation.** Native animation code owns active transitions, clock integration, retargeting, and repaint regions. Cleanup distinguishes ordinary settings changes from paint callbacks with a current GL context. This is a concrete example of why optional presentation effects should be independent from policy and geometry ownership. See [animator](SOURCE_INDEX.md#p07-animation) and [clock](SOURCE_INDEX.md#p07-clock).

**Configurability.** Luau algorithms receive a bounded context and return validated rectangles. Metadata is cached at load. The implementation distinguishes a shared VM for trusted bundled scripts from dedicated capped engines for user scripts, and calls algorithms with a watchdog. It validates window counts, degenerate areas, and returned zones. This is richer than evaluating arbitrary JavaScript inside the compositor. See [Luau adapter](SOURCE_INDEX.md#p07-luau). The audit did not trace every underlying watchdog instruction, allocator, or library implementation; do not claim a complete sandbox audit.

**Strengths.** The most extensive example in this set of explicit asynchronous placement, command generations, native presentation, batched IPC, and rich configurability. It supplies useful solutions to cases small scripts often handle with broad ignore flags.

**Weaknesses and latency implications.** Complexity is itself a maintenance cost: many state holders, daemon/effect synchronization, serialization, restart recovery, native lifetime hazards, and a much larger compatibility surface. Native code still runs in compositor-sensitive paths. IPC adds scheduling boundaries even when asynchronous. A compiled architecture can improve access and timing precision while also introducing more opportunities for latency. Its own compatibility layer documents changes between KWin 6.7 and 6.8 render APIs. See [compatibility shim](SOURCE_INDEX.md#p07-compat).

**Take into Plastile:** requested/observed separation, command stamps, per-window cancellation, batching, bounded retries, and presentation ownership. **Do not copy the entire architecture:** prove that a small in-process script cannot meet the target or lacks a required API before adding a daemon/effect or embedded language.

## 10. P08: KZones

**Snapshot:** `gerritdevriese/kzones`, commit `e261b5ffb7af` (September 2026).

**Implementation path.** A declarative QML UI represents layouts and zones, offers a top selector and drag overlay, and registers keyboard placement commands. `moveClientToZone()` obtains a zone item's global position, rounds its rectangle, clears maximize, and assigns the window frame. It can remember old geometry and attach zone/layout/context markers to windows. See [QML implementation](SOURCE_INDEX.md#p08-qml), [configuration](SOURCE_INDEX.md#p08-core), and [selector](SOURCE_INDEX.md#p08-selector).

**Scheduling.** The overlay has a repeat timer controlled by `mainDialog.visible`; it samples pointer/hover state and refreshes area data while the UI is shown. It is not an always-on idle pointer loop in the inspected path. Per-tick work depends on the number of visible zone items and layout data.

**Strengths.** Discoverable mouse interaction and configurable zones; a useful precedent for a later Plastile zone picker. A direct keyboard placement can be far simpler than an automatic reflow.

**Weaknesses and latency implications.** Scene geometry is used as a placement source, coupling visual hierarchy to exact window coordinates. Repeated UI traversal, coordinate mapping, rounding, and hover scanning deserve profiling. Dynamic window markers and duplicated context logic are easy to get wrong across output offsets and Activities. A zone snapper does not by itself answer how automatic insertion, deletion, or connected resize should work.

**Take into Plastile:** optional selection UI. **Improve:** compute geometry from a pure zone model; let the UI render it. Never require constructing the overlay to execute a keyboard zone command.

## 11. P09: Mudeer

**Snapshot:** `darkstego/Mudeer`, commit `0967c4637fe5` (September 2026).

**Implementation path.** `Tile` describes positions using slot counts and spans. `getGeometry()` calculates a rectangle from an available area, including integer remainders; `rotate()` supports portrait monitors. The `move()` shortcut path picks the active window, obtains maximize/fullscreen area, applies style/gap/middle-width options, clears maximize in ordinary modes, then assigns `frameGeometry`. Sequential shortcut presses can form vertical combinations. See [main implementation](SOURCE_INDEX.md#p09-main).

**Strengths.** Very small direct path: active window, arithmetic, one target. It is a good control case for the integration overhead of a manual placement command. Shortcut behavior is explicit and easy to understand.

**Weaknesses and latency implications.** It does not supply automatic insertion/reflow, a persistent tree, or general shared resizing. Constant-sized placement arithmetic cannot be compared directly with a full automatic tiler. Null-active-window handling, constraints, span rounding, and maximize transitions still need testing. Configuration reads in a shortcut do not prove disk I/O: KWin's implementation/cache must be considered before making that claim.

**Take into Plastile:** a minimal placement baseline and a pure fractional-region representation. **Improve:** common command validation and shared geometry reconciliation instead of special shortcut-only correctness rules.

## 12. P10: legacy kwin-tiling

**Snapshot:** `kwin-scripts/kwin-tiling`, commit `ab03bc34d76f` (November 2022). The README explicitly calls it unmaintained.

**Implementation path.** A manager connects workspace/client signals to tile lists and context layouts. Layout modules include half, grid, spiral, blade, and an i3-style container tree. `Tiling._updateAllTiles()` resizes the screen model, visits layout rectangles, intersects with the screen, applies gaps, and sends geometry through tile wrappers. See [manager](SOURCE_INDEX.md#p10-manager), [tiling](SOURCE_INDEX.md#p10-tiling), and [i3 layout](SOURCE_INDEX.md#p10-i3).

**Scheduling.** QML provides a 500 ms screen-resize timer and a 1 ms geometry-change timer. The latter is not evidence of 1 ms callback timing. The code uses old QtQuick/KWin imports and client/screen APIs. Drag operations deliberately avoid updates when a tile hovers over itself.

**Strengths.** Historically broad layout experiments, reusable container-tree ideas, and explicit management of events around tiles. Useful for learning interaction alternatives.

**Weaknesses and latency implications.** Old APIs, global mutable coordination, broad tile updates, and timer-based settlement. The 500 ms delay affects screen reconfiguration, which users may perceive during hotplug/resolution changes, but does not establish keyboard latency. Porting this source directly would bring a large legacy compatibility burden.

**Take into Plastile:** tree operations and no-op detection ideas. **Use as historical prior art**, not the initial runtime base.

## 13. P11: modern Grid-Tiling-Kwin

**Snapshot:** `lingtjien/Grid-Tiling-Kwin`, commit `725c25b8242c` (August 2026). Its current source is more modern than older descriptions of an abandoned tiny script suggest.

**Implementation path.** QML invokes ES modules organized by activity, desktop, output, and per-column lists. Layout traversal reaches outputs and lists; a list calculates row heights and dividers, stores `renderGeometry`, then changes border and frame properties. Storing internal state before external writes is intentional because KWin properties emit signals. Capacity policies can try other outputs/desktops and ultimately leave windows floating. See [manager](SOURCE_INDEX.md#p11-manager), [layout](SOURCE_INDEX.md#p11-layout), [output](SOURCE_INDEX.md#p11-output), and [list](SOURCE_INDEX.md#p11-list).

**Scheduling and ownership.** Context/window-add transitions use a configurable delay (10 ms default). A QML component creates single-use timers. In optional force mode, a geometry signal may reapply `renderGeometry` when not moving/resizing/fullscreen. The main module records workspace signal handlers for destruction; the manager records window handlers. See [configuration](SOURCE_INDEX.md#p11-config) and [main](SOURCE_INDEX.md#p11-main).

**Strengths.** A concise grid model with modern modules, output/desktop capacity handling, restoration, and explicit ordering before writes. A useful baseline between minimal placement and a flexible tree engine.

**Weaknesses and latency implications.** Broad render traversal and timers may create avoidable work. Force geometry can fight client constraints or late geometry changes unless convergence is bounded. Some context changes move the current desktop as a side effect; Plastile should make such focus/follow behavior an explicit preference. A rigid grid has less structural expressiveness than persistent BSP.

**Take into Plastile:** simple per-context decomposition and stable internal state before external writes. **Improve:** explicit side-table records, scoped dirty sets, bounded constraint handling, and no involuntary desktop switching by default.

## 14. KWin's built-in tiles and X11 replacement

KWin supplies native root tiles, split/remove/resize operations, padding, relative and absolute geometry, window association, connected resizing, and an editor. It also owns Wayland configure/commit, focus, effects, outputs, and desktop changes. Native tiling is infrastructure; a complete automatic policy still needs insertion, overflow, exception, restore, and configuration semantics. Modern scripts should prefer `rootTile(output, desktop)` and `tile.manage/unmanage` over deprecated `tilingForScreen` and assignments to `window.tile`. See [KWin internals](KWIN_INTERNALS.md).

The older alternative runs Plasma with a different X11 window manager. In i3, `tree_render()` calculates container geometry via `render_con()` and then pushes X11 changes with `x_push_changes()`. Its layout distinguishes split, stacked, tabbed, fullscreen, and dock containers. bspwm's `arrange()` obtains the monitor/desktop rectangle and calls `apply_layout()` recursively over a binary tree; its window functions issue XCB geometry requests. Both maintain EWMH state for desktops and clients. See [i3 tree](SOURCE_INDEX.md#i3-tree), [i3 rendering](SOURCE_INDEX.md#i3-render), [bspwm tree](SOURCE_INDEX.md#bsp-tree), and [bspwm window operations](SOURCE_INDEX.md#bsp-window).

Those are good algorithm and transaction-boundary references. They are not drop-in replacements for KWin in a Plasma Wayland session: there, KWin is also the compositor and display server. Replacing it changes the session integration problem, not just window placement. Plastile's initial design preserves KWin.

## 15. Comparative assessment and adoption map

| Concern | Most useful source examples | Plastile requirement |
|---|---|---|
| Small, testable dynamic engine | Krohnkite, Bismuth | Pure solver and narrow adapter |
| Native tile integration | New Polonium, Fluid Tile, KWin | Incremental mutation and explicit tree ownership |
| Typed event batching | New Polonium | Preserve semantics; use indexed coalescing rather than repeated queue searches |
| Low-delay batching | PlasmaZones retile scheduler | One queued flush per affected full context; no quiet-period wait for commands |
| Outstanding Wayland requests | PlasmaZones, KWin xdg implementation | Desired/requested/observed state, revisions, bounded reconciliation |
| Lifecycle cleanup | Bismuth, Karousel, Grid-Tiling-Kwin | Connection registry, cancellation, reload tests |
| Direct placement baseline | Mudeer | Separate integration overhead from algorithm cost |
| Scrolling semantics | Karousel, PlasmaZones | Dedicated viewport model; defer until basic correctness |
| Manual zone UX | KZones | Model-derived geometry and lazy UI |
| Rich configuration | Bismuth, PlasmaZones | Validated data, scoped overrides, explained rule matches |
| Animation | PlasmaZones, KWin effects | Optional transform-only presentation and retargeting |
| Persistent split structure | Polonium, bspwm, legacy i3 layout | Stable nodes and deterministic structural operations |

**What remains unproven:** comparative p95/p99 latency, physical frame pacing, current Codeberg changes, CPU/memory overhead under an identical workload, and the full compatibility of any project on the user's system. The plan addresses these with specific experiments rather than declaring a winner from static source.

## 16. Recommended direction

Use a small TypeScript core in a KWin declarative script, with a single geometry adapter and a direct-geometry provisional backend. This is a deployment and scope decision, not a claim that JavaScript is fastest. Prototype native tile application with the same core and workload before locking the backend. If native tiles win on correctness and measured responsiveness, select them and implement stable tree reconciliation. If the script lacks required requested-geometry visibility, rendering control, or accurate instrumentation, first reproduce the exact limitation; then add a narrow native bridge or migrate the runtime deliberately.

Do not start by combining every upstream feature. A responsive four-layout automatic tiler with trustworthy state and measurements is a stronger base than a feature-rich implementation that needs timers and force-reapply loops to appear correct. The [roadmap](../implementation/ROADMAP.md) and [backlog](../implementation/BACKLOG.md) turn these findings into implementable work.
