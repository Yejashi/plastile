# Window behavior specification

This document specifies proposed product behavior. Implement it through the model/command layer, then verify it in KWin. Defaults are deliberately conservative; options may change a default only when their alternative semantics are equally explicit.

## 1. Eligibility and initial adoption

Classify a discovered window using stable window-type flags, transient relationships, application metadata, and compiled rules. Normal resizable application windows are eligible. Panels, desktop surfaces, notifications, menus, tooltips, lock/session UI, launchers, applet popups, compositor internals, and Plastile's own UI are excluded. Dialogs, transient utility windows, and fixed-size windows float by default. A rule can explicitly opt a dialog into management, but cannot make a shell/lock surface an ordinary tile by accident.

Do not tile a 1×1 helper merely because it appears in the window list. Do not use a hardcoded application blocklist as the only classification system. Retain useful default exceptions such as known portal/bridge helpers, but explain whether a decision came from type, metadata, a built-in exception, or a user rule.

If required context/metadata is temporarily missing, keep the window visible and pending, subscribe to relevant changes, and use a bounded readiness deadline. Do not impose a fixed delay on every new window. Create→remove before adoption must produce no geometry write and no stale access.

On enabling the script with existing windows, enumerate once, classify, seed deterministic order from a documented stacking/focus policy, then perform one solve per visible context. Never focus every adopted window in turn.

## 2. Contexts and insertion

Default context: output ID, desktop ID, activity ID. Use the window's intended membership/output, not necessarily the pointer output or global active screen. If the user commands “send to output,” the command resolves its destination once. New windows join their application-selected context unless a rule explicitly changes placement.

Default insertion is after the focused tiled window within that context, otherwise at the end. Master/stack optionally inserts as master. BSP inserts at the focused leaf using the configured split policy. Existing order is preserved after unrelated focus changes. New windows do not switch the visible desktop by default; follow behavior is opt-in and separate from send behavior.

Initial policy for windows on all desktops or multiple desktops/activities is floating. This avoids one real frame receiving competing targets. A later pinned-column or per-context membership feature requires a separate decision and tests for one active geometry authority.

*Observed behavior (nested KWin 6.7.5, `membership-*-T24` and `send-activity-switch-T24`; the points above do not specify these):*

- A multi-context window receives no frame request while it is multi-context: none when it becomes one (it stays at its last tiled frame), none on desktop or activity switches, none when peers are sent around it. Plastile's `move.desktop-*` is a no-op for it ("no other desktop") when it is on all desktops or on several, and `window.toggle-float` cannot tile it ("cannot tile: on all desktops" and similar). `move.output-*` and, for a window on one desktop and several activities, `move.desktop-*` are accepted: Plastile asks KWin to transfer the window (KWin places it), the window still floats, and Plastile issues no frame request.
- When its membership narrows to one context, it tiles there: one request, issued when that context is shown. When it widens again, it floats where it is, with no restore request.
- KWin reports a window on both of exactly two activities as on all activities (`activities == []`).
- A send to another desktop that lands with an activity switch writes nothing after the switch. If KWin reports both before Plastile's next flush (the send made inside the switch's signal), the hidden source context is solved once when shown again. A send made just before the switch is solved while its source is still shown. The switch reaches Plastile only after KWin's round trip to kactivitymanagerd. Either way, each moved window is written once.

## 3. State transition table

| Trigger | Model action | Geometry/focus result |
|---|---|---|
| Eligible window opens | Insert once in its context | One context solve; preserve intended activation policy |
| Window closes | Tombstone and remove leaf/order entry | One affected-context solve; focus nearest valid successor only when KWin focus policy requires help |
| Toggle float from tiled | Remove/suspend its tile according to layout policy; retain insertion hint | Restore last user floating rectangle or a bounded centered default; do not jump outputs |
| Toggle tile from floating | Save current float rectangle; insert at remembered valid hint or current insertion rule | One solve; preserve application focus unless command implies activation |
| Minimize tiled window | Suspend participation while retaining restore hint | No requests to minimized window; reflow peers once |
| Unminimize | Reinsert using restore hint | One solve; respect requested activation |
| Enter fullscreen | Suspend ordinary placement; retain layout slot policy | KWin owns fullscreen geometry; no ordinary tile request |
| Leave fullscreen | Clear suspension; restore tiled/float intent | One solve if tiled; no stale pre-fullscreen callback |
| Maximize | Suspend according to configured native maximize policy | Native maximize is respected; no force-back loop |
| Restore maximize | Resume prior tiled/float intent | One solve/restore; preserve border ownership |
| User begins move | Give interaction temporary geometry authority | Do not snap back during drag |
| User ends move | Commit swap/reinsert/float policy based on explicit drop intent | One final solve; no repeating hover-induced reflow by default |
| User begins resize | Record boundary and initial layout state | Dragged frame follows interaction; update feasible preview/peers only at bounded frequency |
| User ends resize | Convert accepted boundary to ratio/weight | One solve; retain stable order |
| App changes size itself | Reconcile constraints/external action | Bounded correction or diagnosed float; never endless resize |
| Output disappears | Cancel old requests, preserve logical preferences, migrate visible windows safely | No off-screen orphan; deterministic fallback output |
| Script unloads | Invalidate callbacks, disconnect, release owned state | Restore owned properties without overwriting subsequent user changes |

Suspensions can overlap. For example, a minimized fullscreen window must not receive a tile request just because one of the two suspensions cleared. Tests must exercise combinations, not just each row independently.

## 4. Master/stack behavior

- A context has stable order, master count, split orientation, and master ratio.
- One tiled window fills the usable area by default, without setting native maximized state solely for appearance. An optional singleton-maximize policy must be explicit and test state transitions.
- Additional windows divide the stack area using equal weights initially. Resize can update weights without changing order.
- Grow/shrink changes the nearest meaningful divider; it clamps to feasible minima. If no divider applies, return a no-op result with a reason.
- Swap-with-master exchanges IDs/order positions, not the applications' titles or metadata.
- Closing a master promotes the next eligible window deterministically.
- Gaps use shared edges; odd output dimensions must not accumulate uncovered pixels or overlaps.

## 5. BSP behavior

Maintain a persistent binary tree. A branch has a stable ID, axis, and ratio; a leaf has a stable ID and a window reference. Insertion replaces one leaf with a branch containing the old/new leaves. Removal collapses the parent into the surviving sibling. Focus changes leave the tree unchanged.

Directional movement may swap leaf contents; a separate command moves/reinserts structure. These are different operations and must have different command IDs/help text. Rotation changes branch axes/order according to a documented clockwise/counterclockwise rule. Mirroring flips a chosen axis. Balance/equalize is an explicit command, never an accidental side effect of adding a window.

Aggregate constraints before solving. For horizontal branches, minimum width is the sum of child minima plus the intervening gap, and minimum height is the maximum child minimum height; reverse the roles for vertical branches. Maxima and aspect/increment constraints require adapter-aware handling. Do not claim a simple rectangle minimum solver satisfies every X11 hint. If the tree is infeasible, apply the configured overflow fallback and explain which constraint failed.

## 6. Monocle, floating, and stacking

Monocle retains order and the most recently focused eligible member. Default presentation stacks full-area tiled frames, raises/activates the selected member, and preserves ordinary floating dialogs above their parents. It does not repeatedly minimize peers as focus changes. A minimize-rest variant is later opt-in because it changes taskbar and application behavior.

Floating windows retain ordinary KDE movement/resize behavior. Plastile may restore a rectangle when explicitly floating a tile, but then yields until the next explicit tile command or relevant rule change. Do not continuously constrain floating windows to a tile. Keep them visible on output changes; avoid shrinking below legitimate client minima.

Layer changes (`keepAbove`, `keepBelow`) and borders are independent preferences with restore ownership. Do not blanket set all tiles below all other windows merely to make dialogs appear correct. Test dialogs, menus, overview, and task switchers with default stacking first.

## 7. Focus and navigation

Focus-only commands should not solve geometry in non-scrolling layouts. Directional focus uses target rectangles from the current valid plan, filters candidates to a direction half-plane, prefers overlap on the orthogonal axis, then distance, then stable order/ID tie-breaking. Document wrap behavior; default is no wrap across outputs unless configured.

Cross-output focus is a distinct command or enabled fallback, never an accidental result of rectangle sorting. Resolve using output topology rather than array order. Mouse focus policies remain KDE-controlled unless an explicit Plastile mode changes them. Cursor warping is disabled by default and only offered if a supported integration is available; an external shell tool is not a hidden requirement for ordinary focus.

When a tiled window closes, allow KWin's normal activation handling first unless testing establishes a need for an explicit focus successor. If a successor is requested, validate it is live, visible, not minimized, and in the intended context. Do not steal focus from a modal transient or a newly activated application.

## 8. Drag and resize policies

Initial drag default: preserve the model during movement, show an optional lightweight insertion/swap preview, and commit once on release. Dragging out of managed placement can float the window only under an explicit gesture/modifier/drop rule. A normal move must not trigger per-pixel whole-desktop retiling.

For shared resize, record the divider and initial ratios when interaction begins. Convert the user's accepted frame boundary into a feasible ratio while distinguishing frame decorations and client constraints. If live peer updates are enabled, coalesce to at most one solve per applicable display frame and apply only changed peers. Do not delay the final release behind an arbitrary 50 ms timer unless a reproducible runtime issue requires a scoped workaround.

Cancel restores initial structural state unless the user explicitly committed another operation. Output removal, window removal, escape/cancel, script disable, and a configuration switch all terminate previews and pointer sampling. A timer active only during drag must stop on every path.

## 9. Native quick tiling and native editor coexistence

Direct backend default: an explicit native quick-tile action yields ownership for that window and records a native-managed/floating exception until the user explicitly re-adopts it. Do not immediately force its old rectangle back. The exact signal distinction must be probed; use a conservative policy if public visibility is incomplete.

If native tiles are selected at G1, define one root ownership mode:

1. **Automatic owned root:** Plastile projects its model; native edits enter an explicit adopt/manual transaction.
2. **Manual root automation:** user layout is authoritative; Plastile fills it like Fluid Tile.

Ship one initial mode with clear semantics. Do not silently alternate both. Preserve a native layout snapshot before destructive adoption when supported, and test what restoration means if the user edits it during the session. Activity switches project logical layouts into the shared native root carefully.

## 10. Outputs, work areas, and scaling

Output reconfiguration must preserve application visibility, logical ordering, and intended preferred output where possible. Choose fallback output by an explicit policy: nearest surviving output by prior center, then primary/active output, then deterministic remaining identity. Connector names may change; enumeration index is not identity.

Recompute areas when panels, rotation, scaling, or output geometry change. Dirty only affected contexts. A temporary zero-sized/invalid output snapshot does not justify placing windows at `(0,0,0,0)`. Retain the last valid plan, defer through bounded topology convergence, and revalidate the epoch before applying.

Test fractional scales, negative origins, portrait orientation, mixed refresh rates, docking/undocking, mirror-like arrangements, and per-output desktop visibility. The core stays in logical coordinates. Compare final frames against adapter-accepted constraints with explicit tolerance; physical screenshot pixels require the appropriate scale/transform conversion.

## 11. Overflow and constraints

Default overflow is `float-new`: preserve existing layout and float a newly inserted window if it cannot fit. Offer explicit alternatives such as stack-in-leaf, switch-layout, or move-to-next-context only after their behavior is implemented and tested. Automatic desktop creation/removal is optional later behavior; do not add/delete the user's desktops to hide an infeasible solver.

A window with an observed incompatible minimum becomes an explained exception. Reconsider it when output area, layout parameters, constraints, or user intent change—not on every unrelated focus event. Explanations include application identity, rule/constraint, intended slot, observed accepted frame, fallback, and how to opt in/out.

## 12. Configuration changes and suspension

Activate a valid configuration atomically. A gap/ratio change recomputes only affected contexts. A rule change reevaluates affected metadata matches; a shortcut change updates command registration without creating a second engine. An invalid revision leaves the previous configuration active with useful diagnostics.

`suspend` releases active geometry ownership and restores owned properties safely. `resume` adopts current live state with preserved user float choices and one solve per visible context. `reconcile` is a diagnostic recovery command, not an idle background operation. `reset-context` resets only the selected context's layout preferences, not global user settings.

## 13. Later scrolling mode

A scrolling layout stores columns, preferred widths, vertical weights, viewport offset, and visible range separately from master/stack. Select centered/lazy behavior explicitly. Focus a window by moving the viewport to make it visible; do not shrink all columns to fit. Define stacked-column semantics, transient follow behavior, pinned regions, and per-output strips before coding.

The main correctness gate is off-screen behavior: windows must not become permanently invisible, leak into adjacent physical outputs unexpectedly, intercept clicks in the wrong place, or remain transparent after disable. A script may lack clipping/input control needed for a polished implementation. Reproduce that limitation and evaluate a narrow effect rather than claiming script-only scrolling is equivalent to a compositor designed around it.

## 14. Later zone mode

Zones are normalized data in an output/context model. Keyboard placement computes the target without creating a UI. The overlay renders the same data and sends a zone command. Pixel rounding, panel reservations, padding, and restore behavior must match automatic layouts. Connected zone resize is optional and must not implicitly alter arbitrary overlapping zones.

See the [test matrix](../validation/TEST_MATRIX.md) for scenario IDs and [backlog](../implementation/BACKLOG.md) for implementation order.
