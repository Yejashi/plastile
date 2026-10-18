# Zones addendum (M9, T37)

**Status:** proposal written before implementation, per [ROADMAP §12](../implementation/ROADMAP.md#12-m9-optional-manual-zones-and-layout-authoring).
It refines [BEHAVIOR_SPEC §14](BEHAVIOR_SPEC.md#14-later-zone-mode) and ships opt-in and experimental under
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
  model's rectangles); overlay created only on show and destroyed on unload; no timers while hidden.
- Physical session (open gate): overlay rendering, numbers legible at mixed scales.
