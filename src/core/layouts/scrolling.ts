// Scrolling layout (experimental, ADR-014; design: docs/design/SCROLLING.md).
//
// One strip per context: columns laid out left to right in strip coordinates (0 at the
// left edge of the first column), each holding windows stacked vertically by weight. A
// viewport offset selects which part of the strip is projected into the work area.
// Columns that lie entirely inside the area are visible; every other column is parked at
// a rectangle that intersects no output, keeping its size so parking is a position-only
// write. The focused column is always visible. Pure: no KWin access, no state mutation.

import { inset, intersects, rect, TOLERANCE, type Rect } from "../geometry.ts";
import type { ContextSettings, ScrollingSettings, WindowId } from "../types.ts";
import { allocate } from "./allocate.ts";
import type { CommandOutcome, Layout, LayoutCommand, SolveInput, SolveResult } from "./layout.ts";
import { solveWithOverflow, type Attempt } from "./masterStack.ts";

export interface ScrollColumn {
  /** Stable for the column's lifetime (explanations, tests); never reused within a strip. */
  readonly id: number;
  /** Windows top to bottom. */
  readonly windows: readonly WindowId[];
  /** Width as a fraction of the usable width (presets 1/3, 1/2, 2/3, 1), before minimum clamping. */
  readonly width: number;
  /** Height weights; a missing entry weighs 1. */
  readonly weights: Readonly<Record<WindowId, number>>;
}

export interface ScrollState {
  readonly columns: readonly ScrollColumn[];
  readonly nextId: number;
  /** x offset of the visible window into the strip (strip coordinates, logical px). */
  readonly viewport: number;
}

/** Distance between a parked column and its output (SCROLLING §3). */
export const PARK_MARGIN = 64;
export const WIDTH_MIN = 0.1;
export const WIDTH_MAX = 1;

const NO_MIN = { width: 0, height: 0 };

// ------------------------------------------------------------------ strip model

/** A column as projected: its participating windows, strip x and pixel width. */
export interface PlacedColumn {
  readonly column: ScrollColumn;
  readonly ids: readonly WindowId[];
  readonly x: number;
  readonly width: number;
}

export interface Strip {
  /** Outer area (work area minus outer gaps). */
  readonly area: Rect;
  /** Whole-pixel usable width used for widths and viewport arithmetic. */
  readonly span: number;
  readonly gap: number;
  readonly columns: readonly PlacedColumn[];
  /** Strip width from the first column's left edge to the last column's right edge. */
  readonly total: number;
}

function outerArea(input: SolveInput, n: number): Rect {
  if (n === 1 && !input.settings.singleWindowGaps) return input.area;
  return inset(input.area, input.settings.gaps.outer);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Pixel width of a column: its fraction of (span + gap) minus one gap, never below a member's minimum. */
export function columnPixels(fraction: number, span: number, gap: number, minWidth: number): number {
  return Math.max(1, Math.floor(fraction * (span + gap) - gap + 1e-9), Math.ceil(minWidth - 1e-9));
}

/** Lay out the columns that hold at least one of `ids` (participants). */
export function strip(state: ScrollState, input: SolveInput, ids: readonly WindowId[]): Strip {
  const set = new Set(ids);
  const area = outerArea(input, ids.length);
  const gap = input.settings.gaps.inner;
  const span = Math.max(1, Math.floor(area.width + 1e-9));
  const columns: PlacedColumn[] = [];
  let x = 0;
  for (const column of state.columns) {
    const members = column.windows.filter((id) => set.has(id));
    if (members.length === 0) continue;
    let minW = 0;
    for (const id of members) minW = Math.max(minW, (input.constraints.get(id)?.minFrame ?? NO_MIN).width);
    const width = columnPixels(column.width, span, gap, minW);
    columns.push({ column, ids: members, x, width });
    x += width + gap;
  }
  return { area, span, gap, columns, total: columns.length ? x - gap : 0 };
}

export function columnIndex(state: ScrollState, id: WindowId): number {
  for (let i = 0; i < state.columns.length; ++i) if (state.columns[i].windows.indexOf(id) >= 0) return i;
  return -1;
}

/** Participants in strip order: columns left to right, windows top to bottom. */
export function stripOrder(state: ScrollState, ids: readonly WindowId[]): WindowId[] {
  const set = new Set(ids);
  const out: WindowId[] = [];
  for (const c of state.columns) for (const id of c.windows) if (set.has(id)) out.push(id);
  for (const id of ids) if (out.indexOf(id) < 0) out.push(id);
  return out;
}

/**
 * Viewport that shows `focus` under the policy. Lazy scrolls just enough and keeps the
 * viewport inside the strip (no empty space beside it); centred centres the focused column
 * whenever it fits. A column wider than the area starts at the area's left edge.
 */
export function viewportFor(st: Strip, viewport: number, focus: WindowId | null, policy: ScrollingSettings["policy"]): number {
  const maxVp = Math.max(0, st.total - st.span);
  let f: PlacedColumn | null = null;
  if (focus !== null) for (const c of st.columns) if (c.ids.indexOf(focus) >= 0) { f = c; break; }
  if (f === null) return clamp(viewport, 0, maxVp);
  if (f.width >= st.span) return f.x;
  if (policy === "centered") return Math.round(f.x + f.width / 2 - st.span / 2);
  let v = viewport;
  if (f.x < v) v = f.x;
  else if (f.x + f.width > v + st.span) v = f.x + f.width - st.span;
  return clamp(v, 0, maxVp);
}

/** State that holds every participant: a member missing from the columns gets its own column at the end. */
function withMembers(state: ScrollState, ids: readonly WindowId[], settings: ContextSettings): ScrollState {
  let s = state;
  for (const id of ids) if (columnIndex(s, id) < 0) s = addColumn(s, id, null, settings);
  return s;
}

function addColumn(state: ScrollState, id: WindowId, after: WindowId | null, settings: ContextSettings, width?: number): ScrollState {
  const col: ScrollColumn = { id: state.nextId, windows: [id], width: width ?? settings.scrolling.defaultWidth, weights: {} };
  const ai = after === null ? -1 : columnIndex(state, after);
  const at = ai < 0 ? state.columns.length : ai + 1;
  const columns = state.columns.slice();
  columns.splice(at, 0, col);
  return { columns, nextId: state.nextId + 1, viewport: state.viewport };
}

function withColumns(state: ScrollState, columns: readonly ScrollColumn[]): ScrollState {
  return { columns, nextId: state.nextId, viewport: state.viewport };
}

function dropWeight(w: Readonly<Record<WindowId, number>>, id: WindowId): Record<WindowId, number> {
  const out: Record<WindowId, number> = {};
  for (const k of Object.keys(w)) if (k !== id) out[k] = w[k];
  return out;
}

// ------------------------------------------------------------- projection/parking

interface Projection extends Attempt {
  readonly strip: Strip;
  readonly viewport: number;
}

function project(state: ScrollState, input: SolveInput, ids: readonly WindowId[], focus: WindowId | null): Projection {
  const st = strip(state, input, ids);
  const viewport = viewportFor(st, state.viewport, focus, input.settings.scrolling.policy);
  const slots = new Map<WindowId, Rect>();
  const a = st.area;
  for (const c of st.columns) {
    const sx = a.x + c.x - viewport;
    const weights = c.ids.map((id) => c.column.weights[id] ?? 1);
    const mins = c.ids.map((id) => (input.constraints.get(id)?.minFrame ?? NO_MIN).height);
    const rows = allocate(a.y, a.height, weights, mins, st.gap);
    if (rows === null) {
      const need = mins.reduce((s, m) => s + Math.max(1, m), 0) + st.gap * (c.ids.length - 1);
      return { slots, failure: `column ${c.column.id} of ${c.ids.length} needs ${need} px height, has ${a.height}`, notes: [], strip: st, viewport };
    }
    for (let i = 0; i < c.ids.length; ++i) slots.set(c.ids[i], rect(sx, rows[i][0], c.width, rows[i][1] - rows[i][0]));
  }
  return { slots, failure: null, notes: [], strip: st, viewport };
}

/** KWin's Workspace::outputAt distance: squared distance to the closest pixel of the output (v6.7.5 workspace.cpp:1199). */
export function outputDistance(px: number, py: number, o: Rect): number {
  const cx = clamp(px, o.x, o.x + o.width - 1), cy = clamp(py, o.y, o.y + o.height - 1);
  return (cx - px) * (cx - px) + (cy - py) * (cy - py);
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Strictly nearest to `own` by KWin's rule: a tie could make KWin pick another output. */
export function nearestIsOwn(px: number, py: number, own: Rect, outputs: readonly Rect[]): boolean {
  const d = outputDistance(px, py, own);
  for (const o of outputs) {
    if (sameRect(o, own)) continue;
    if (outputDistance(px, py, o) <= d) return false;
  }
  return true;
}

function spanClamp(x: number, w: number, start: number, len: number): number {
  return w >= len ? start : clamp(x, start, start + len - w);
}

/**
 * Parking place for a column rectangle (SCROLLING §3): directly above its output, below,
 * left, then right of it; the first candidate that intersects no output and where the
 * centre of every window in the column (`parts`, in the same coordinates as `col`) is
 * strictly nearest to its own output, since KWin assigns each window's output from its own
 * centre. Null when none qualifies (an enclosed output).
 */
export function parkingSpot(col: Rect, own: Rect, outputs: readonly Rect[], parts: readonly Rect[] = [col]): { x: number; y: number } | null {
  const hx = spanClamp(col.x, col.width, own.x, own.width);
  const vy = spanClamp(col.y, col.height, own.y, own.height);
  const candidates = [
    { x: hx, y: own.y - col.height - PARK_MARGIN },
    { x: hx, y: own.y + own.height + PARK_MARGIN },
    { x: own.x - col.width - PARK_MARGIN, y: vy },
    { x: own.x + own.width + PARK_MARGIN, y: vy },
  ];
  for (const c of candidates) {
    const r = rect(c.x, c.y, col.width, col.height);
    let free = true;
    for (const o of outputs) if (intersects(r, o, 0)) { free = false; break; }
    if (!free) continue;
    const dx = c.x - col.x, dy = c.y - col.y;
    let near = true;
    for (const p of parts) if (!nearestIsOwn(p.x + dx + p.width / 2, p.y + dy + p.height / 2, own, outputs)) { near = false; break; }
    if (near) return c;
  }
  return null;
}

function solve(state0: ScrollState, input: SolveInput): SolveResult {
  const state = withMembers(state0, input.ids, input.settings);
  const focus = input.focused;
  const r = solveWithOverflow(input.ids, input, (ids) => project(state, input, ids, focus));
  const kept = input.ids.filter((id) => r.slots.has(id));
  const p = project(state, input, kept, focus);
  const virtual = r.slots; // maxima already fitted inside their slots
  const slots = new Map<WindowId, Rect>();
  const parked: WindowId[] = [];
  const notes = r.notes.slice();
  const a = p.strip.area;
  for (const c of p.strip.columns) {
    const sx = a.x + c.x - p.viewport;
    const focused = focus !== null && c.ids.indexOf(focus) >= 0;
    const inside = sx >= a.x - TOLERANCE && sx + c.width <= a.x + a.width + TOLERANCE;
    let dx = 0, dy = 0;
    if (!focused && !inside) {
      const col = rect(sx, a.y, c.width, a.height);
      const parts: Rect[] = [];
      for (const id of c.ids) { const v = virtual.get(id); if (v) parts.push(v); }
      const spot = input.output && input.outputs ? parkingSpot(col, input.output, input.outputs, parts) : null;
      if (spot) {
        dx = spot.x - sx;
        dy = spot.y - a.y;
        for (const id of c.ids) parked.push(id);
      } else {
        // Nowhere outside every output nearest to this one: keep it on its own output at the
        // nearer area edge rather than let KWin assign it to a neighbour (SCROLLING §3).
        const tx = c.width >= a.width ? a.x : sx < a.x ? a.x : a.x + a.width - c.width;
        dx = tx - sx;
        notes.push(`column ${c.column.id}: no parking place outside every output nearest to this one; clamped to the area edge`);
      }
    }
    for (const id of c.ids) {
      const v = virtual.get(id);
      if (!v) continue;
      slots.set(id, dx === 0 && dy === 0 ? v : rect(v.x + dx, v.y + dy, v.width, v.height));
    }
  }
  return { slots, overflow: r.overflow, notes, raise: [], virtual, parked };
}

// ----------------------------------------------------------------- operations

type Outcome = CommandOutcome<ScrollState>;

function same(state: ScrollState, reason: string): Outcome {
  return { state, changed: false, reason };
}

/** Move `id` into the column on its left (appended at the bottom). */
export function consume(state: ScrollState, id: WindowId): Outcome {
  const i = columnIndex(state, id);
  if (i < 0) return same(state, "window not in the strip");
  if (i === 0) return same(state, "no column on the left");
  const src = state.columns[i], dst = state.columns[i - 1];
  const columns = state.columns.slice();
  columns[i - 1] = { id: dst.id, windows: [...dst.windows, id], width: dst.width, weights: dst.weights };
  const rest = src.windows.filter((w) => w !== id);
  if (rest.length === 0) columns.splice(i, 1);
  else columns[i] = { id: src.id, windows: rest, width: src.width, weights: dropWeight(src.weights, id) };
  return { state: withColumns(state, columns), changed: true };
}

/** Move `id` out of a shared column into its own column just right of it, with the same width. */
export function expel(state: ScrollState, id: WindowId): Outcome {
  const i = columnIndex(state, id);
  if (i < 0) return same(state, "window not in the strip");
  const src = state.columns[i];
  if (src.windows.length < 2) return same(state, "already alone in its column");
  const columns = state.columns.slice();
  columns[i] = { id: src.id, windows: src.windows.filter((w) => w !== id), width: src.width, weights: dropWeight(src.weights, id) };
  columns.splice(i + 1, 0, { id: state.nextId, windows: [id], width: src.width, weights: {} });
  return { state: { columns, nextId: state.nextId + 1, viewport: state.viewport }, changed: true };
}

function setWidth(state: ScrollState, i: number, width: number): ScrollState {
  const c = state.columns[i];
  const columns = state.columns.slice();
  columns[i] = { id: c.id, windows: c.windows, width, weights: c.weights };
  return withColumns(state, columns);
}

/** Next preset strictly wider than the column's width, wrapping to the first. */
export function cycleWidth(state: ScrollState, id: WindowId, presets: readonly number[]): Outcome {
  const i = columnIndex(state, id);
  if (i < 0) return same(state, "window not in the strip");
  if (presets.length === 0) return same(state, "no width presets");
  const cur = state.columns[i].width;
  let next = presets[0];
  for (const p of presets) if (p > cur + 1e-6) { next = p; break; }
  if (Math.abs(next - cur) < 1e-9) return same(state, "only one width preset");
  return { state: setWidth(state, i, next), changed: true };
}

/** Change the column's width fraction by `delta` (grow/shrink). */
export function resizeColumn(state: ScrollState, id: WindowId, delta: number): Outcome {
  const i = columnIndex(state, id);
  if (i < 0) return same(state, "window not in the strip");
  const cur = state.columns[i].width;
  const next = clamp(cur + delta, WIDTH_MIN, WIDTH_MAX);
  if (Math.abs(next - cur) < 1e-9) return same(state, "width at limit");
  return { state: setWidth(state, i, next), changed: true };
}

/** Swap the column holding `id` with its neighbour on that side. */
export function moveColumn(state: ScrollState, id: WindowId, dir: "left" | "right"): Outcome {
  const i = columnIndex(state, id);
  if (i < 0) return same(state, "window not in the strip");
  const j = dir === "left" ? i - 1 : i + 1;
  if (j < 0 || j >= state.columns.length) return same(state, `no column ${dir}`);
  const columns = state.columns.slice();
  columns[i] = state.columns[j];
  columns[j] = state.columns[i];
  return { state: withColumns(state, columns), changed: true };
}

/** Neighbour of `id` within its column among participants, or null at the column's end. */
export function columnNeighbour(state: ScrollState, id: WindowId, dir: "up" | "down", ids: readonly WindowId[]): WindowId | null {
  const i = columnIndex(state, id);
  if (i < 0) return null;
  const set = new Set(ids);
  const list = state.columns[i].windows.filter((w) => set.has(w) || w === id);
  const k = list.indexOf(id) + (dir === "up" ? -1 : 1);
  return k >= 0 && k < list.length ? list[k] : null;
}

/** Exchange two windows' places wherever they are in the strip; height weights stay with the slot. */
export function swapWindows(state: ScrollState, a: WindowId, b: WindowId): ScrollState {
  const ia = columnIndex(state, a), ib = columnIndex(state, b);
  if (ia < 0 || ib < 0 || a === b) return state;
  const wa = state.columns[ia].weights[a], wb = state.columns[ib].weights[b];
  const columns = state.columns.map((c, i) => {
    if (i !== ia && i !== ib) return c;
    const weights: Record<WindowId, number> = {};
    for (const k of Object.keys(c.weights)) if (k !== a && k !== b) weights[k] = c.weights[k];
    if (i === ia && wa !== undefined) weights[b] = wa;
    if (i === ib && wb !== undefined) weights[a] = wb;
    return { id: c.id, windows: c.windows.map((w) => (w === a ? b : w === b ? a : w)), width: c.width, weights };
  });
  return withColumns(state, columns);
}

/** Centre the column holding `focus` (lazy: as far as the strip's ends allow). */
export function centre(state: ScrollState, focus: WindowId, input: SolveInput): Outcome {
  const st = strip(state, input, input.ids);
  let f: PlacedColumn | null = null;
  for (const c of st.columns) if (c.ids.indexOf(focus) >= 0) { f = c; break; }
  if (f === null) return same(state, "window not in the strip");
  let v = f.width >= st.span ? f.x : Math.round(f.x + f.width / 2 - st.span / 2);
  if (input.settings.scrolling.policy === "lazy") v = clamp(v, 0, Math.max(0, st.total - st.span));
  if (v === state.viewport) return same(state, "already centred");
  return { state: { columns: state.columns, nextId: state.nextId, viewport: v }, changed: true };
}

/** Interactive resize of a column edge (width) or a row boundary inside a column (weights). */
function resizeBoundary(state: ScrollState, cmd: Extract<LayoutCommand, { kind: "resize-boundary" }>, input: SolveInput): Outcome {
  const i = columnIndex(state, cmd.id);
  if (i < 0) return same(state, "window not in the strip");
  const st = strip(state, input, input.ids);
  if (cmd.edge === "left" || cmd.edge === "right") {
    // Dragging the right edge right, or the left edge left, widens the column.
    const px = cmd.edge === "right" ? cmd.delta : -cmd.delta;
    return resizeColumn(state, cmd.id, px / (st.span + st.gap));
  }
  const col = state.columns[i];
  const set = new Set(input.ids);
  const ids = col.windows.filter((w) => set.has(w));
  const ci = ids.indexOf(cmd.id);
  const ni = cmd.edge === "bottom" ? ci + 1 : ci - 1;
  if (ci < 0 || ni < 0 || ni >= ids.length) return same(state, "no divider on that edge");
  const a = st.area;
  const minH = ids.map((id) => Math.max(1, (input.constraints.get(id)?.minFrame ?? NO_MIN).height));
  const rows = allocate(a.y, a.height, ids.map((id) => col.weights[id] ?? 1), minH, st.gap);
  if (rows === null) return same(state, "no space");
  const h = rows.map(([b, e]) => e - b);
  const limit = 0.05 * (a.height - st.gap * (ids.length - 1));
  const floorC = Math.max(minH[ci], limit), floorN = Math.max(minH[ni], limit);
  const want = cmd.edge === "bottom" ? cmd.delta : -cmd.delta;
  const d = Math.min(Math.max(0, h[ni] - floorN), Math.max(Math.min(0, floorC - h[ci]), want));
  if (Math.abs(d) < 0.5) return same(state, "row at limit");
  h[ci] += d;
  h[ni] -= d;
  const mean = h.reduce((s, x) => s + x, 0) / h.length;
  const weights: Record<WindowId, number> = { ...col.weights };
  for (let k = 0; k < ids.length; ++k) weights[ids[k]] = h[k] / mean;
  const columns = state.columns.slice();
  columns[i] = { id: col.id, windows: col.windows, width: col.width, weights };
  return { state: withColumns(state, columns), changed: true };
}

// --------------------------------------------------------------------- layout

export const scrolling: Layout<ScrollState> = {
  kind: "scrolling",

  initial(): ScrollState {
    return { columns: [], nextId: 1, viewport: 0 };
  },

  /** A new window gets a new column right of the focused column (`after`), or at the end. */
  insert(state, id, after, input) {
    if (columnIndex(state, id) >= 0) return state;
    return addColumn(state, id, after, input.settings);
  },

  remove(state, id) {
    const i = columnIndex(state, id);
    if (i < 0) return state;
    const c = state.columns[i];
    const columns = state.columns.slice();
    const rest = c.windows.filter((w) => w !== id);
    if (rest.length === 0) columns.splice(i, 1); // an empty column is dropped; the viewport is clamped at the next solve
    else columns[i] = { id: c.id, windows: rest, width: c.width, weights: dropWeight(c.weights, id) };
    return withColumns(state, columns);
  },

  rebuild(state, members, input) {
    const keep = new Set(members);
    const columns: ScrollColumn[] = [];
    for (const c of state.columns) {
      const ws = c.windows.filter((w) => keep.has(w));
      if (ws.length) columns.push(ws.length === c.windows.length ? c : { id: c.id, windows: ws, width: c.width, weights: c.weights });
    }
    return withMembers(withColumns(state, columns), members, input.settings);
  },

  reveal(state, focus, input) {
    const st = strip(state, input, input.ids);
    const v = viewportFor(st, state.viewport, focus, input.settings.scrolling.policy);
    return v === state.viewport ? state : { columns: state.columns, nextId: state.nextId, viewport: v };
  },

  solve,

  command(state: ScrollState, cmd: LayoutCommand, input: SolveInput): Outcome {
    switch (cmd.kind) {
      case "ratio":
        if (input.focused === null) return same(state, "no focused column");
        return resizeColumn(state, input.focused, cmd.delta);
      case "equalize": {
        if (state.columns.every((c) => Object.keys(c.weights).length === 0)) return same(state, "already equal");
        return { state: withColumns(state, state.columns.map((c) => ({ id: c.id, windows: c.windows, width: c.width, weights: {} }))), changed: true };
      }
      case "resize-boundary":
        return resizeBoundary(state, cmd, input);
      default:
        return same(state, `${cmd.kind} not supported by scrolling`);
    }
  },

  swap: swapWindows,
};
