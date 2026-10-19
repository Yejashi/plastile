// Master/stack layout: masters in one column, the rest stacked in the other.
// Order comes from the context; this state holds only ratio, master count and
// per-window row weights.

import { inset, rect, centreIn, type Rect } from "../geometry.ts";
import type { ContextSettings, WindowId, Constraints } from "../types.ts";
import { allocate, allocateFlat } from "./allocate.ts";
import type { CommandOutcome, Layout, LayoutCommand, SolveInput, SolveResult } from "./layout.ts";

export interface MasterStackState {
  readonly ratio: number;
  readonly masterCount: number;
  readonly weights: Readonly<Record<WindowId, number>>;
}

export const RATIO_MIN = 0.05;
export const RATIO_MAX = 0.95;
export const MASTER_COUNT_MAX = 8;

const NO_MIN = { width: 0, height: 0 };

function minOf(c: ReadonlyMap<WindowId, Constraints>, id: WindowId) {
  return c.get(id)?.minFrame ?? NO_MIN;
}

function outerArea(input: SolveInput, n: number): Rect {
  const g = input.settings.gaps;
  if (n === 1 && !input.settings.singleWindowGaps) return input.area;
  return inset(input.area, g.outer);
}

interface Attempt {
  slots: Map<WindowId, Rect>;
  failure: string | null;
  notes: string[];
}

// The solve runs on every layout command inside KWin's QV4, where iterators, spreads and
// per-item arrays are garbage-collected heap objects (G2 report §16). The helpers below use
// index loops over ranges of `ids` and flat cut arrays; they compute the same numbers in the
// same order as the map/spread/slice forms they replace.

/** Widest minimum frame width of ids[from, to), and at least `floor`. */
function widestMin(c: ReadonlyMap<WindowId, Constraints>, ids: readonly WindowId[], from: number, to: number,
  floor: number): number {
  let w = floor;
  for (let i = from; i < to; ++i) w = Math.max(w, minOf(c, ids[i]).width);
  return w;
}

/** Rows for ids[from, to) in one column at x/width: null on success, else the failure. */
function column(x: number, width: number, a: Rect, ids: readonly WindowId[], from: number, to: number,
  state: MasterStackState, input: SolveInput, slots: Map<WindowId, Rect>): string | null {
  const gap = input.settings.gaps.inner;
  const n = to - from;
  const weights = new Array<number>(n);
  const mins = new Array<number>(n);
  for (let i = 0; i < n; ++i) {
    const id = ids[from + i];
    weights[i] = state.weights[id] ?? 1;
    mins[i] = minOf(input.constraints, id).height;
  }
  const rows = allocateFlat(a.y, a.height, weights, mins, gap);
  if (rows === null) {
    let need = 0;
    for (let i = 0; i < n; ++i) need += mins[i];
    return `column of ${n} needs ${need + gap * (n - 1)} px height, has ${a.height}`;
  }
  for (let i = 0; i < n; ++i) slots.set(ids[from + i], rect(x, rows[2 * i], width, rows[2 * i + 1] - rows[2 * i]));
  return null;
}

function attempt(state: MasterStackState, ids: readonly WindowId[], input: SolveInput): Attempt {
  const notes: string[] = [];
  const slots = new Map<WindowId, Rect>();
  const n = ids.length;
  if (n === 0) return { slots, failure: null, notes };
  const a = outerArea(input, n);
  const gap = input.settings.gaps.inner;
  const m = Math.max(0, Math.min(state.masterCount, n));
  if (m === 0 || m === n) {
    // One column: every window a master, or none.
    const minW = widestMin(input.constraints, ids, 0, n, 0);
    if (minW > a.width) return { slots, failure: `needs ${minW} px width, has ${a.width}`, notes };
    const f = column(a.x, a.width, a, ids, 0, n, state, input, slots);
    return { slots, failure: f, notes };
  }
  const minMaster = widestMin(input.constraints, ids, 0, m, -Infinity);
  const minStack = widestMin(input.constraints, ids, m, n, -Infinity);
  const cols = allocateFlat(a.x, a.width, [state.ratio, 1 - state.ratio], [minMaster, minStack], gap);
  if (cols === null) return { slots, failure: `columns need ${minMaster + gap + minStack} px width, have ${a.width}`, notes };
  const usable = a.width - gap;
  const achieved = (cols[1] - cols[0]) / usable;
  if (Math.abs(achieved - state.ratio) > 1 / Math.max(1, usable)) notes.push(`ratio ${state.ratio.toFixed(3)} clamped to ${achieved.toFixed(3)} by minimum widths`);
  const f1 = column(cols[0], cols[1] - cols[0], a, ids, 0, m, state, input, slots);
  if (f1) return { slots, failure: `master ${f1}`, notes };
  const f2 = column(cols[2], cols[3] - cols[2], a, ids, m, n, state, input, slots);
  if (f2) return { slots, failure: `stack ${f2}`, notes };
  return { slots, failure: null, notes };
}

/** Apply max-size constraints: a slot larger than the window's maximum gets a centred frame. */
export function fitMaxima(slots: Map<WindowId, Rect>, input: SolveInput, notes: string[]): void {
  // forEach, not for-of: no iterator result or entry array per slot. Replacing an existing
  // key's value during forEach visits every key once, in insertion order, as for-of does.
  slots.forEach((slot, id) => {
    const c = input.constraints.get(id);
    if (!c) return;
    const w = Math.min(slot.width, c.maxFrame.width);
    const h = Math.min(slot.height, c.maxFrame.height);
    if (w < slot.width || h < slot.height) {
      slots.set(id, centreIn(slot, { width: w, height: h }));
      notes.push(`${id}: centred at maximum size ${w}x${h}`);
    }
  });
}

/**
 * Shared overflow policy, float-new (BEHAVIOR §11): existing windows keep their tiles and
 * a window that cannot fit next to them floats. When everything does not fit, windows
 * are admitted in insertion order and each one that would make the layout infeasible
 * overflows, with the failure it caused. A window that cannot fit at all (its minimum
 * exceeds the area even alone) is therefore floated itself, instead of every newer
 * window being floated ahead of it. Attempts keep context order.
 */
export function solveWithOverflow(ids: readonly WindowId[], input: SolveInput,
  tryIds: (ids: readonly WindowId[]) => Attempt): SolveResult {
  const done = (r: Attempt, overflow: WindowId[], notes: string[]): SolveResult => {
    for (let i = 0; i < r.notes.length; ++i) notes.push(r.notes[i]);
    fitMaxima(r.slots, input, notes);
    return { slots: r.slots, overflow, notes, raise: [] };
  };
  const all = tryIds(ids);
  if (all.failure === null) return done(all, [], []);
  // Ties keep context order explicitly (QV4's sort need not be stable).
  const at = new Map<WindowId, number>();
  ids.forEach((id, i) => at.set(id, i));
  const seq = (id: WindowId) => input.insertedAt.get(id) ?? 0;
  const older = (a: WindowId, b: WindowId) => seq(a) - seq(b) || at.get(a)! - at.get(b)!;
  const kept = new Set<WindowId>();
  const failed = new Map<WindowId, string>();
  let fits = tryIds([]);
  for (const id of ids.slice().sort(older)) {
    const r = tryIds(ids.filter((x) => kept.has(x) || x === id));
    if (r.failure === null) { kept.add(id); fits = r; } else failed.set(id, r.failure);
  }
  // Report newest first, the order in which float-new gives windows up.
  const overflow = [...failed.keys()].sort((a, b) => older(b, a));
  const notes = overflow.map((id) => `${id}: does not fit (${failed.get(id)}); overflow float-new`);
  return done(fits, overflow, notes);
}

export type { Attempt };

function clampRatio(r: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
}

export const masterStack: Layout<MasterStackState> = {
  kind: "master-stack",

  initial(settings: ContextSettings): MasterStackState {
    return { ratio: clampRatio(settings.masterStack.ratio), masterCount: settings.masterStack.masterCount, weights: {} };
  },

  insert(state) { return state; },

  remove(state, id) {
    if (!(id in state.weights)) return state;
    const weights: Record<WindowId, number> = {};
    for (const k of Object.keys(state.weights)) if (k !== id) weights[k] = state.weights[k];
    return { ratio: state.ratio, masterCount: state.masterCount, weights };
  },

  rebuild(state) { return state; },

  solve(state, input) {
    return solveWithOverflow(input.ids, input, (ids) => attempt(state, ids, input));
  },

  command(state: MasterStackState, cmd: LayoutCommand, input: SolveInput): CommandOutcome<MasterStackState> {
    switch (cmd.kind) {
      case "ratio": {
        // One column (a single window, or every window a master) has no divider (BEHAVIOR §4).
        const range = feasibleRatio(state, input);
        if (range === null) return { state, changed: false, reason: "no divider" };
        return moveDivider(state, range, cmd.delta);
      }
      case "master-count": {
        const next = Math.max(0, Math.min(MASTER_COUNT_MAX, state.masterCount + cmd.delta));
        if (next === state.masterCount) return { state, changed: false, reason: "master count at limit" };
        return { state: { ratio: state.ratio, masterCount: next, weights: state.weights }, changed: true };
      }
      case "equalize": {
        if (Object.keys(state.weights).length === 0) return { state, changed: false, reason: "already equal" };
        return { state: { ratio: state.ratio, masterCount: state.masterCount, weights: {} }, changed: true };
      }
      case "resize-boundary":
        return resizeBoundary(state, cmd, input);
      default:
        return { state, changed: false, reason: `${cmd.kind} not supported by master-stack` };
    }
  },
};

/** Achievable master ratio interval from column minimum widths; null without two columns. */
function feasibleRatio(state: MasterStackState, input: SolveInput): { lo: number; hi: number; usable: number } | null {
  const ids = input.ids;
  const m = Math.max(0, Math.min(state.masterCount, ids.length));
  if (m === 0 || m >= ids.length) return null;
  const usable = outerArea(input, ids.length).width - input.settings.gaps.inner;
  if (usable <= 0) return null;
  let minMaster = 1, minStack = 1;
  for (let i = 0; i < ids.length; ++i) {
    const w = Math.max(1, minOf(input.constraints, ids[i]).width);
    if (i < m) minMaster = Math.max(minMaster, w); else minStack = Math.max(minStack, w);
  }
  return { lo: minMaster / usable, hi: 1 - minStack / usable, usable };
}

/**
 * Move the divider by `delta` (ratio units) from where it is shown. Column minima can hold
 * the divider away from the stored ratio; stepping the stored value would move it inside
 * that hidden range (grow stuck below the minimum, a drag snapping back). The shown result,
 * clamped to the feasible range, becomes the stored ratio (BEHAVIOR §4, §8).
 */
function moveDivider(state: MasterStackState, range: { lo: number; hi: number; usable: number },
  delta: number): CommandOutcome<MasterStackState> {
  const shown = (r: number) => Math.min(range.hi, Math.max(range.lo, r));
  const base = shown(state.ratio);
  const free = clampRatio(base + delta);
  const next = clampRatio(shown(free));
  if (Math.abs(shown(next) - base) * range.usable < 0.5) {
    return { state, changed: false, reason: free === clampRatio(base) ? "ratio at limit" : "ratio clamped by minimum sizes" };
  }
  return { state: { ratio: next, masterCount: state.masterCount, weights: state.weights }, changed: true };
}

/** Convert an accepted boundary movement (pixels) into ratio/weight changes. */
function resizeBoundary(state: MasterStackState, cmd: Extract<LayoutCommand, { kind: "resize-boundary" }>,
  input: SolveInput): CommandOutcome<MasterStackState> {
  const ids = input.ids;
  const idx = ids.indexOf(cmd.id);
  if (idx < 0) return { state, changed: false, reason: "window not tiled here" };
  const m = Math.max(0, Math.min(state.masterCount, ids.length));
  const isMaster = idx < m;
  const a = outerArea(input, ids.length);
  if ((cmd.edge === "left" || cmd.edge === "right")) {
    const range = feasibleRatio(state, input);
    if (range === null) return { state, changed: false, reason: "no vertical divider" };
    // Master is on the left: its right edge, or the stack's left edge, is the divider. A
    // positive delta moves an edge right (engine: frame - slot), which grows the master
    // from either side.
    if (cmd.edge !== (isMaster ? "right" : "left")) return { state, changed: false, reason: "edge is not the divider" };
    return moveDivider(state, range, cmd.delta / range.usable);
  }
  // Horizontal divider inside a column: the neighbours trade pixels from the rows as shown.
  // Minimum heights can hold rows away from their weights, so the column's shown heights
  // become its weights (they reproduce the same rows), then the boundary moves by the
  // drag, clamped so neither row drops below its minimum or 5 % of the column.
  const col = isMaster ? ids.slice(0, m) : ids.slice(m);
  const ci = col.indexOf(cmd.id);
  const ni = cmd.edge === "bottom" ? ci + 1 : ci - 1;
  if (ni < 0 || ni >= col.length) return { state, changed: false, reason: "no divider on that edge" };
  const gap = input.settings.gaps.inner;
  const minH = col.map((id) => Math.max(1, minOf(input.constraints, id).height));
  const rows = allocate(a.y, a.height, col.map((id) => state.weights[id] ?? 1), minH, gap);
  if (rows === null) return { state, changed: false, reason: "no space" };
  const h = rows.map(([b, e]) => e - b);
  const limit = 0.05 * (a.height - gap * (col.length - 1));
  const floorC = Math.max(minH[ci], limit), floorN = Math.max(minH[ni], limit);
  const want = cmd.edge === "bottom" ? cmd.delta : -cmd.delta; // pixels the dragged row gains
  const d = Math.min(Math.max(0, h[ni] - floorN), Math.max(Math.min(0, floorC - h[ci]), want));
  if (Math.abs(d) < 0.5) {
    return { state, changed: false, reason: (want > 0 ? floorN : floorC) > limit ? "row clamped by minimum sizes" : "weight at limit" };
  }
  h[ci] += d;
  h[ni] -= d;
  const mean = h.reduce((s, x) => s + x, 0) / h.length;
  const weights: Record<WindowId, number> = { ...state.weights };
  for (let i = 0; i < col.length; ++i) weights[col[i]] = h[i] / mean;
  return { state: { ratio: state.ratio, masterCount: state.masterCount, weights }, changed: true };
}
