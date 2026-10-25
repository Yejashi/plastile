# Zones addendum (M9, T37)

**Status:** written before implementation, per [ROADMAP §12](../implementation/ROADMAP.md#12-m9-optional-manual-zones-and-layout-authoring);
now implemented as an experimental layout and tested with mock and nested-KWin 6.7.5 scenarios only. The physical-session
checks in §5 are open. Where the implementation refines or departs from this text, [§6](#6-implementation-notes-and-deviations)
says so and why. It refines [BEHAVIOR_SPEC §14](BEHAVIOR_SPEC.md#14-later-zone-mode) and ships opt-in and experimental under
[ADR-014](DECISIONS.md#adr-014-start-m8m9-as-experimental-opt-in-layouts-before-g3-physical-sign-off).

Zones are manual placement: the user assigns a window to a predefined region. Automatic layouts
place every eligible window; a zones context places only the windows that the user or a rule assigned.
The rest stay ordinary floating windows. Zones share the engine's context, ownership, ledger and
teardown paths. Zone geometry comes from a pure normalized model. The optional overlay only
draws that model, and the overlay's item hierarchy is never the source of geometry (the KZones
weakness noted in [STATE_OF_THE_ART §10](../research/STATE_OF_THE_ART.md#10-p08-kzones)).

## 1. Model and configuration

A zone layout is validated configuration data:

```json
{
  "zoneLayouts": [
    { "id": "thirds", "zones": [
      { "x": 0, "y": 0, "width": 0.3333, "height": 1 },
      { "x": 0.3333, "y": 0, "width": 0.3334, "height": 1 },
      { "x": 0.6667, "y": 0, "width": 0.3333, "height": 1 } ] }
  ],
  "defaults": { "zones": { "layout": "thirds" } }
}
```

- Coordinates are fractions of the work area after outer gaps. Each zone must satisfy `0 <= x`,
  `x + width <= 1` (same for y and height), with width and height of at least 0.02. Values must be
  finite.
- Overlapping zones are allowed, since users want, for example, a full-height zone and two half-height
  zones. Connected resize is out of scope.
- Limits: at most 16 layouts and 32 zones per layout. Ids must be unique. Invalid data is rejected at
  activation and the previous revision is kept (CONFIGURATION §5).
- The built-in default layouts are `halves`, `thirds`, `grid-2x2` and `main-side` (60/40). A context
  uses zones when its effective `layout` is `zones`. `zones.layout` selects which zone layout is active
  for that context (through overrides as usual).

## 2. Placement rules

Zone `i` of the active zone layout is projected with the same arithmetic as the other layouts: the
work area is inset by the outer gaps, then normalized edges are scaled and shared edges rounded once.
The inner gap is subtracted only on zone sides that are not on the area edge. Two zones that share an
edge therefore meet with exactly one inner gap.

- Assigning a window to a zone gives it that zone's rectangle. If several windows share a zone they
  stack, and the most recently assigned is raised, as in monocle.
- A window whose minimum size does not fit the zone gets the zone's origin and its minimum size, plus
  an explanation. Plastile does not fight the client.
- Unassigned windows in a zones context are left alone (ordinary floating). A rule action `zone: <n>`
  can assign new windows.
- Toggling float on a zoned window unassigns it and restores its last floating rectangle.
- Switching the context to another layout, suspending, or unloading releases zone ownership. Zoned
  windows keep their current frames; nothing is moved back.

## 3. Commands (keyboard first)

| Command | Effect |
|---|---|
| `plastile.zone.assign-1` … `assign-9` | Assign the focused window to zone 1–9 of the context's zone layout (no-op with reason when the zone does not exist) |
| `plastile.zone.next` / `previous` | Move the focused zoned window to the next/previous zone; an unassigned window goes to zone 1 |
| `plastile.zone.unassign` | Release the focused window to floating |
| `plastile.zone.layout-next` | Cycle this context's zone layout; assigned windows keep their zone index when it exists, else are unassigned |
| `plastile.zone.show` | Toggle the optional overlay showing zone numbers for the active output |

Keyboard placement never needs the overlay. The commands compute targets from the model and go
through the normal transaction: one solve and one write per changed window.

## 4. Optional overlay

A lazily created full-output, input-transparent QML window draws the zone rectangles and their
numbers from the same projected rectangles the engine uses. It is created on the first
`plastile.zone.show`, hidden by the next one or by `Escape`, and destroyed on unload. While hidden it does no work and runs no
timers. No pointer polling is introduced. Drag-to-zone with a modifier is later work and would sample
the pointer only during an active drag, as ARCHITECTURE requires.

## 5. Tests

- Pure: projection equality between the model and any consumer; shared edges, odd sizes, negative
  origins and fractional areas; validation limits and error messages; assignment, next/previous,
  layout cycling with index preservation; minimum-size placement and explanation.
- Replay: assign issues one write; repeated assign is a no-op; float toggle restores the floating
  rectangle; layout switch and stop release ownership without moving windows.
- Nested KWin: keyboard assign on two outputs with different work areas (oracle frames equal the
  model's rectangles); overlay created only on show and destroyed on unload; no timers while hidden; a zone
  command while it is shown redraws it (the `zones overlay` info line, which lists each zone's rectangle and
  window count, shows the unassigned zone empty).
- Physical session (open gate): overlay rendering, numbers legible at mixed scales.

## 6. Implementation notes and deviations

Implemented in `src/core/layouts/zones.ts` (pure model, projection and assignment operations), the engine's zones
section (`src/core/engine.ts`), `src/runtime/zoneOverlay.ts` and `package/contents/ui/ZoneOverlay.qml`. Tests:
`tests/core/zones.test.ts`, `tests/core/zonesEngine.test.ts`, `tests/core/zonesRuntime.test.ts` and
`tests/integration/scenarios_zones.py` (`zones-assign-M9`, `zones-overlay-M9`).

Refinements and deviations, each with its reason:

1. **Edge arithmetic.** An interior normalized edge `u` becomes one whole-pixel cut at
   `round(start + u × (length + gap) − gap)`. The zone ending at `u` ends at the cut, and the zone starting there begins
   one inner gap later. This is the rounding of `allocate()`: halves equal master/stack at ratio 0.5, and an n×n grid
   equals `allocate()` columns and rows, on odd spans with odd gaps too (unit-tested). A first version that split the gap
   around `round(start + u × length)` was a pixel off on odd spans with odd gaps. Area edges stay exact.
2. **Normalized grid.** Coordinates are compared on a 10⁻⁶ grid, so the specification's `0.3333 + 0.3334` and `0.6667`
   are one shared edge, and `x + width ≤ 1` is checked on that grid.
3. **Minimum size.** §2 says the window gets the zone's origin and "its minimum size". It gets the larger of the zone's
   size and its minimum in each dimension, so a window too wide but not too tall keeps the zone's height.
4. **Configured layouts and the built-ins.** The 16-layout limit applies to `zoneLayouts`. A configured layout with a
   built-in's id replaces that built-in in place; others follow the built-ins, so the cycle can hold up to 20.
   `zones.layout` must name a known id (checked at activation, with the known ids in the message).
5. **Gaps.** Zones always use the outer gaps; `singleWindowGaps: false` does not apply. Otherwise the overlay would
   depend on how many windows are assigned.
6. **Stacking.** "The most recently assigned is raised" is refined to "the most recently assigned or activated". A
   window you click in a shared zone stays on top at the next solve instead of being lowered again. Raises happen only
   for zones holding two or more windows.
7. **Unassign and drags.** *Release from zone* leaves the window where it is (no write). The window's frame becomes its
   float rectangle, as for a layout switch. *Toggle floating* restores the earlier float rectangle (§2). An interactive
   move or resize of a zoned window releases it where the user put it instead of snapping back, because zones are
   manual placement and Plastile does not fight the user.
8. **Rule `zone`.** It applies when a window joins a zones context (opening, adoption at load, moving to another
   output or desktop, toggling back from floating). Selecting the zones layout, or a later rule change, does not assign
   windows that are already members. A zone the active layout does not have is explained in the window's explanation.
9. **Configuration changes.** A change of `zones.layout`, or of a zone layout's zones, keeps assignments whose zone
   exists and releases the others where they are, as *next zone layout* does. A command's zone layout choice for a
   context outlives a configuration change; *Reset this layout* drops it.
10. **Commands not listed in §3.** `plastile.layout.zones` selects the layout; the layout cycle never enters it (as for
    scrolling, ADR-014). All zones commands are unbound by default. Command ids `assign-1`…`assign-9` are the first ids
    with a digit; the package test now allows a trailing `-<digit>`.
11. **Overlay: input and Escape.** KWin delivers keys to an internal window only through a popup grab, and an
    input-transparent internal window has no grab (observed source, v6.7.5: `InternalWindow::hitTest`,
    `InternalWindow::hasPopupGrab`, `popup_input_filter.cpp`). The overlay is therefore two internal windows. The drawing
    covers the output with `Qt.WindowTransparentForInput`, so hit testing skips it. A small legend is a `Qt.Popup` that
    takes the grab and receives Escape. Consequences: while the overlay is shown, ordinary typing goes to the legend
    (global shortcuts still run first, as for the inspector), and like any popup KWin closes it on a click elsewhere
    (that press is consumed) or when a window is activated. Measured in nested KWin 6.7.5 (`zones-overlay-M9`): both
    windows exist only after `zone.show`, both are excluded as Plastile's own UI, Escape pressed through libei hides
    them, and unload destroys them. Pointer pass-through was not measured.
12. **Overlay lifecycle.** The QML component is compiled with `main.qml` at load (ADR-016 addendum), created on the
    first `zone.show`, hidden and shown again afterwards
    (KWin destroys the internal windows while hidden, so nothing is mapped), and destroyed on unload. It holds no timer
    or connection. While shown it is refreshed after every accepted Plastile command (a context reset or layout change
    that leaves zones hides it; a float updates the counts), and only then; other changes appear the next time it is
    shown. It takes rectangles, labels, a heading and a hint, and holds no zone logic, so another feature (the drop
    preview of ADR-017) can reuse it.
13. **Own UI.** `isOwnUi` accepts a second fixed caption, `Plastile zones`, under the same no-application-id,
    no-process rule as the inspector (ADR-016).
14. **Not persisted.** Assignments and a context's zone layout choice last for the KWin session only. `ContextPrefs`
    does not carry them yet (ADR-013 lists zone choices as a later persistence item).

Measured in nested KWin 6.7.5 (`zones-assign-M9`, two virtual outputs, a 48 px layer-shell panel on Virtual-1):
adoption into a zones context moved no window; each keyboard assignment was one solve and one frame write; the frames
were exactly the oracle rectangles (halves on Virtual-0; thirds below the panel on Virtual-1) and the rectangles the
overlay was given; toggling floating restored the earlier rectangle; switching to floating and unloading moved nothing.

