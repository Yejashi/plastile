// Zones layout (experimental, ADR-014, docs/design/ZONES.md): manual placement into predefined
// regions. Only windows the user or a rule assigned to a zone are placed; every other member is
// an ordinary floating window (no slot, no writes). Zone geometry comes from the normalized model
// here and nowhere else: the optional overlay draws the rectangles projectZones() returns.

import { inset, rect, type Rect } from "../geometry.ts";
import type { GapSettings, WindowId, ZoneLayout, ZoneRect, ZoneSettings } from "../types.ts";
import type { CommandOutcome, Layout, LayoutCommand, SolveInput, SolveResult } from "./layout.ts";
import { fitMaxima } from "./masterStack.ts";

/** Configuration limits (ZONES §1). */
export const MAX_ZONE_LAYOUTS = 16;
export const MAX_ZONES = 32;
export const MIN_ZONE_FRACTION = 0.02;
/** Normalized coordinates are compared on a 1e-6 grid, so 0.3333 + 0.3334 and 0.6667 are one edge. */
const GRID = 1e6;

export function canonical(u: number): number {
  return Math.round(u * GRID) / GRID;
}

export interface ZoneState {
  /** Zone layout chosen by command in this context; null follows the configured `zones.layout`. */
  readonly layout: string | null;
  /** Zone index (0-based) per assigned window. */
  readonly assigned: Readonly<Record<WindowId, number>>;
  /** Stacking recency, oldest first: assignment and activation move a window to the end. */
  readonly order: readonly WindowId[];
}

const EMPTY_LAYOUT: ZoneLayout = { id: "", zones: [] };

function findLayout(list: readonly ZoneLayout[], id: string): ZoneLayout | null {
  for (const l of list) if (l.id === id) return l;
  return null;
}

/** The zone layout a context shows: the command's choice, else the configured one, else the first. */
export function activeZoneLayout(state: ZoneState | null, z: ZoneSettings): ZoneLayout {
  if (state && state.layout !== null) {
    const chosen = findLayout(z.layouts, state.layout);
    if (chosen) return chosen;
  }
  return findLayout(z.layouts, z.layout) ?? z.layouts[0] ?? EMPTY_LAYOUT;
}

/**
 * Project normalized zones into a work area, with the arithmetic of the other layouts: the area
 * is inset by the outer gaps; each interior normalized edge u becomes one cut, rounded once to a
 * whole pixel at `start + u * (length + gap) - gap` (area edges stay exact, so a fractional area
 * keeps fractional outer edges). A zone ending at u ends at the cut and a zone starting at u
 * starts one inner gap after it, so two zones sharing an edge meet with exactly one inner gap and
 * zones of equal fractions get equal sizes, the same pixels allocate() gives (masterStack,
 * BSP). The gap is taken only from zone sides that are not on the area edge.
 */
export function projectZones(zones: readonly ZoneRect[], area: Rect, gaps: GapSettings): Rect[] {
  const a = inset(area, gaps.outer);
  const g = gaps.inner;
  const cut = (u: number, start: number, length: number): number => Math.round(start + u * (length + g) - g);
  const begin = (u: number, start: number, length: number): number => (u <= 0 ? start : cut(u, start, length) + g);
  const end = (u: number, start: number, length: number): number => (u >= 1 ? start + length : cut(u, start, length));
  const out: Rect[] = [];
  for (const z of zones) {
    const u0 = canonical(z.x), u1 = canonical(z.x + z.width);
    const v0 = canonical(z.y), v1 = canonical(z.y + z.height);
    const x0 = begin(u0, a.x, a.width), x1 = end(u1, a.x, a.width);
    const y0 = begin(v0, a.y, a.height), y1 = end(v1, a.y, a.height);
    out.push(rect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)));
  }
  return out;
}

/** The zone (0-based) a window is assigned to, or null. */
export function zoneOf(state: ZoneState, id: WindowId): number | null {
  const i = state.assigned[id];
  return i === undefined ? null : i;
}

function without(state: ZoneState, id: WindowId): { assigned: Record<WindowId, number>; order: WindowId[] } {
  const assigned: Record<WindowId, number> = {};
  for (const k of Object.keys(state.assigned)) if (k !== id) assigned[k] = state.assigned[k];
  return { assigned, order: state.order.filter((x) => x !== id) };
}

/** Assign `id` to zone `index` of a layout with `count` zones; it becomes the top of its zone. */
export function assignZone(state: ZoneState, id: WindowId, index: number, count: number, layoutId = ""): CommandOutcome<ZoneState> {
  if (!(index >= 0 && index < count)) {
    return { state, changed: false, reason: `zone ${index + 1} does not exist in zone layout "${layoutId}" (${count} zones)` };
  }
  if (state.assigned[id] === index) return { state, changed: false, reason: `already in zone ${index + 1}` };
  const rest = without(state, id);
  rest.assigned[id] = index;
  rest.order.push(id);
  return { state: { layout: state.layout, assigned: rest.assigned, order: rest.order }, changed: true };
}

/** Next/previous zone, wrapping; an unassigned window goes to zone 1 (ZONES §3). */
export function stepZone(state: ZoneState, id: WindowId, dir: 1 | -1, count: number, layoutId = ""): CommandOutcome<ZoneState> {
  if (count === 0) return { state, changed: false, reason: `zone layout "${layoutId}" has no zones` };
  const cur = zoneOf(state, id);
  if (cur === null) return assignZone(state, id, 0, count, layoutId);
  if (count === 1 && cur === 0) return { state, changed: false, reason: "the zone layout has one zone" };
  return assignZone(state, id, cur >= count ? 0 : (cur + dir + count) % count, count, layoutId);
}

export function unassignZone(state: ZoneState, id: WindowId): CommandOutcome<ZoneState> {
  if (state.assigned[id] === undefined) return { state, changed: false, reason: "window is not in a zone" };
  const rest = without(state, id);
  return { state: { layout: state.layout, assigned: rest.assigned, order: rest.order }, changed: true };
}

/** Activation of an assigned window makes it the top of its zone (no geometry change). */
export function bumpZone(state: ZoneState, id: WindowId): ZoneState {
  if (state.assigned[id] === undefined || state.order[state.order.length - 1] === id) return state;
  return { layout: state.layout, assigned: state.assigned, order: [...state.order.filter((x) => x !== id), id] };
}

/** Drop assignments to zones a layout with `count` zones does not have. */
export function pruneZones(state: ZoneState, count: number): { state: ZoneState; dropped: WindowId[] } {
  const dropped = Object.keys(state.assigned).filter((id) => state.assigned[id] >= count);
  if (dropped.length === 0) return { state, dropped };
  let s = state;
  for (const id of dropped) s = unassignZone(s, id).state;
  return { state: s, dropped };
}

/**
 * Cycle to the next zone layout (list order, wrapping). Assigned windows keep their zone index
 * when the new layout has it and are unassigned otherwise (`dropped`).
 */
export function nextZoneLayout(state: ZoneState, z: ZoneSettings): { state: ZoneState; changed: boolean; dropped: WindowId[]; reason?: string } {
  if (z.layouts.length < 2) return { state, changed: false, dropped: [], reason: "only one zone layout is configured" };
  const cur = activeZoneLayout(state, z);
  let i = -1;
  for (let k = 0; k < z.layouts.length; ++k) if (z.layouts[k].id === cur.id) i = k;
  const next = z.layouts[(i + 1) % z.layouts.length];
  const pruned = pruneZones({ layout: next.id, assigned: state.assigned, order: state.order }, next.zones.length);
  return { state: pruned.state, changed: true, dropped: pruned.dropped };
}

/** Every assignment released (layout switch, suspend): the zone layout choice is kept. */
export function releaseZones(state: ZoneState): ZoneState {
  return state.order.length === 0 && Object.keys(state.assigned).length === 0 ? state : { layout: state.layout, assigned: {}, order: [] };
}

export const zones: Layout<ZoneState> = {
  kind: "zones",
  initial(): ZoneState { return { layout: null, assigned: {}, order: [] }; },
  // New members are ordinary floating windows until assigned (by command or a rule's `zone`).
  insert(state) { return state; },
  remove(state, id) { return unassignZone(state, id).state; },
  rebuild(state, members) {
    let s = state;
    for (const id of Object.keys(state.assigned)) if (members.indexOf(id) < 0) s = unassignZone(s, id).state;
    return s;
  },
  solve(state, input: SolveInput): SolveResult {
    const layout = activeZoneLayout(state, input.settings.zones);
    const rects = projectZones(layout.zones, input.area, input.settings.gaps);
    const slots = new Map<WindowId, Rect>();
    const notes: string[] = [];
    const members = new Map<number, WindowId[]>();
    for (const id of input.ids) {
      const i = state.assigned[id];
      if (i === undefined) continue;
      if (i >= rects.length) { notes.push(`${id}: zone ${i + 1} does not exist in zone layout "${layout.id}"; left floating`); continue; }
      const z = rects[i];
      const min = input.constraints.get(id)?.minFrame;
      if (min && (min.width > z.width || min.height > z.height)) {
        // Never fight the client: its minimum wins, anchored at the zone's origin.
        slots.set(id, rect(z.x, z.y, Math.max(z.width, min.width), Math.max(z.height, min.height)));
        notes.push(`${id}: minimum size ${min.width}x${min.height} does not fit zone ${i + 1} (${z.width}x${z.height}); ` +
          "placed at the zone's origin at its minimum size");
      } else slots.set(id, z);
      const list = members.get(i);
      if (list) list.push(id); else members.set(i, [id]);
    }
    fitMaxima(slots, input, notes);
    // Windows sharing a zone stack; the top one (most recently assigned or activated) is raised.
    const raise: WindowId[] = [];
    for (const list of members.values()) {
      if (list.length < 2) continue;
      let top = list[0], at = -1;
      for (const id of list) {
        const k = state.order.indexOf(id);
        if (k > at) { at = k; top = id; }
      }
      raise.push(top);
    }
    return { slots, overflow: [], notes, raise };
  },
  command(state: ZoneState, cmd: LayoutCommand): CommandOutcome<ZoneState> {
    return { state, changed: false, reason: `${cmd.kind} not supported by zones` };
  },
  /** Two windows exchange their zones (or zone and unassigned). */
  swap(state, a, b) {
    const za = state.assigned[a], zb = state.assigned[b];
    if (za === undefined && zb === undefined) return state;
    const assigned: Record<WindowId, number> = {};
    for (const k of Object.keys(state.assigned)) if (k !== a && k !== b) assigned[k] = state.assigned[k];
    if (zb !== undefined) assigned[a] = zb;
    if (za !== undefined) assigned[b] = za;
    const order = state.order.map((x) => (x === a ? b : x === b ? a : x)).filter((x) => assigned[x] !== undefined);
    for (const x of [a, b]) if (assigned[x] !== undefined && order.indexOf(x) < 0) order.push(x);
    return { layout: state.layout, assigned, order };
  },
};
