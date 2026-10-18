# Scrolling layout addendum (M8, T36)

**Status:** proposal written before implementation, as [ROADMAP §11](../implementation/ROADMAP.md#11-m8-optional-scrolling-mode)
requires. It refines [BEHAVIOR_SPEC §13](BEHAVIOR_SPEC.md#13-later-scrolling-mode). It reuses the engine's event, ownership,
ledger and teardown machinery and adds a separate viewport model. It does not extend master/stack
state. Scrolling ships disabled and opt-in (`layout: "scrolling"`), as an experimental layout, under
[ADR-014](DECISIONS.md#adr-014-start-m8m9-as-experimental-opt-in-layouts-before-g3-physical-sign-off).

## 1. Evidence this design depends on

Measured in nested KWin 6.7.5 ([probe](../../probes/scrolling/offscreen.py),
[evidence](../status/evidence/scrolling-offscreen-e15.json)), plus observed source at v6.7.5:

- A script can place a window entirely outside every output, and KWin leaves it there. The window
  keeps the nearest output as its `output`.
- An output topology change makes KWin pull such a window partly back on screen (x −2000 became −280).
  KWin owns that correction; a script cannot prevent it.
- `opacity`, `minimized`, `skipTaskbar` and `keepBelow` are script-writable, but input picking ignores
  opacity (only minimized, hidden, other-desktop/activity and show-desktop windows are skipped, input.cpp),
  so a transparent window over an output still takes clicks. Opacity is not a hiding mechanism.
- `checkWorkspacePosition`/`checkOffscreenPosition` runs on client-area updates and desktop sends
  (window.cpp:4117–4135, workspace.cpp:2497 and 1676). That explains the pull-back seen in the probe.

Inference to verify in the physical session: a window outside the union of all output rectangles
cannot receive pointer input, because no output covers its pixels. The nested backend cannot show
where pixels land on real monitors.

## 2. Model

One strip per context `(output, desktop, activity)`, as for every other layout (ADR-009). A strip is:

| Field | Meaning |
|---|---|
| `columns` | Ordered list; each column has a stable id, ordered window ids (stacked vertically), a width, and per-window height weights |
| `width` | Column width as a fraction of the usable area width (presets cycle 1/3, 1/2, 2/3, 1), clamped to member minima |
| `viewport` | x offset of the visible window into the strip, in strip coordinates |
| `policy` | `"centered"` (the focused column is centred when it fits) or `"lazy"` (scroll just enough to show it). Default `lazy` |

Strip coordinates are logical pixels starting at 0 at the left edge of the first column. Columns are laid
out left to right with the inner gap between them. A column's windows split its height by weight, with
shared-edge rounding like the other layouts.

The layout keeps window order across focus changes. Insertion puts a new window in a new column after
the focused column, or at the end when nothing is focused. Removing a window removes it from its
column; an empty column is dropped and the viewport is clamped.

## 3. Projection and parking

Solving projects the strip into the work area: `screenX = area.x + outerGap + stripX - viewport`.

- A column whose projected rectangle lies entirely inside the area (within tolerance) is **visible**
  and receives that rectangle.
- A column that would cross either area edge or lie outside it is **parked**. Its windows keep their
  column size (position-only writes, so no client configure) and move to a parking rectangle that
  intersects no output, so parked windows never appear on, or take input from, any monitor.
- KWin assigns `window.output` from the frame centre: an off-output centre maps to the nearest output
  (`outputAt(center)`, v6.7.5 window.cpp:3361; probe E15 saw x = 3060 report the right-hand output). The
  parking rectangle is therefore chosen so that its centre's nearest output is the strip's own output.
  Candidates are checked in this order: directly above the output (`y = output.top - height - 64`, x
  inside the output's span), directly below it, left of it, right of it. The first candidate that
  intersects no output and whose centre is nearest to this output wins. If none qualifies, for example
  an output enclosed on all four sides, the column is not parked. It is clamped to the nearest area edge and
  left visible, with an explanation.
- Because KWin can still reassign the output during a later topology change, every parking write is
  recorded in the ledger as an expected observation. An output change for a window that Plastile parked
  does not re-key its context. The next solve re-parks it or brings it back.
- The focused column is always visible. If it is wider than the area, it is placed at the area's left
  edge and clipped by the output; that is the one case where part of a window can be off-area.

`SolveResult` gains an optional `virtual` map with each window's rectangle in work-area coordinates
before parking. Directional focus and swap use these virtual rectangles, so "focus right" means the
next column in the strip even when it is parked. Ordinary layouts leave `virtual` unset.

## 4. Focus, scrolling and commands

Focus is coupled to the viewport. A focus change, whether from a Plastile command, Alt+Tab, a
click or an application activation, scrolls the strip so that the focused window's column is visible
under the strip's policy, and then solves once. For a transient dialog the parent's column is
scrolled into view; the dialog itself floats. This makes scrolling the one layout in which focus
changes cause geometry writes. They are position-only writes to the columns that cross the visible
edge.

| Command | Effect |
|---|---|
| `plastile.focus.left/right` | Focus the nearest window in the previous/next column (virtual rectangles); scrolls |
| `plastile.focus.up/down` | Focus within the column; no scroll |
| `plastile.swap.left/right` | Move the focused column one position left/right |
| `plastile.scroll.consume` / `plastile.scroll.expel` | Move the focused window into the column on its left / out into its own column |
| `plastile.scroll.width-cycle` | Cycle the focused column through the width presets |
| `plastile.scroll.center` | Centre the focused column |
| `plastile.resize.grow/shrink` | Change the focused column width by the ratio step |

All of these go through the existing dispatcher and transaction. Focus targets are resolved once at
dispatch.

## 5. Lifecycle and safety rules

1. **Nothing stays parked when Plastile stops owning the context.** Unload, suspend, switching the
   context to another layout, a configuration that disables the context, and `reconcile` all unpark.
   Unparking places parked windows back inside their output's work area, either at their virtual
   position clamped into the area or centred when that is invalid. This is tested by forcing each exit path while
   windows are parked.
2. After an output topology change, KWin may have pulled parked windows back. The normal topology
   flush re-solves the strip and re-parks them. The brief visible transient is a documented limitation.
3. A parked window that becomes active, for example through Alt+Tab or a notification, scrolls into
   view through rule 4 above. A parked window is never left active.
4. No opacity, minimize or taskbar change is used to hide windows, so disabling Plastile cannot leave
   a window transparent or minimized.
5. No animation is introduced: scrolling is instantaneous (ADR-006).
6. Floating, fullscreen, maximized and minimized windows keep the existing suspension rules. A
   suspended member keeps its column slot until it rejoins.

## 6. Tests

- Pure: projection never intersects a neighbouring output; parking position is outside `bounds` for
  side-by-side, stacked, negative-origin and L-shaped arrangements; focus-to-scroll for both policies;
  consume/expel/width-cycle/swap; empty-column removal; virtual navigation; and coverage and overlap of
  visible columns with an independent oracle.
- Replay: focus changes produce position-only writes and no client resizes; rapid left/right/left
  reversal converges; nothing remains parked after suspend, layout switch and stop.
- Nested KWin: parked windows are outside every output (oracle reads real frames); Alt+Tab-style
  activation of a parked window scrolls it into view; topology change followed by re-park; unload with
  parked windows leaves every window inside an output.
- Physical session (open gate): no visible pixels or pointer input from parked windows on neighbouring
  monitors at mixed scales; focus and scroll latency measured against a scrolling baseline (Karousel)
  with the same workload, never against a master/stack solver.
