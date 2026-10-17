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
