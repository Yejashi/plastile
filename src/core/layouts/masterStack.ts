// Master/stack layout: masters in one column, the rest stacked in the other.
// Order comes from the context; this state holds only ratio, master count and
// per-window row weights.

import { inset, rect, centreIn, type Rect } from "../geometry.ts";
import type { ContextSettings, WindowId, Constraints } from "../types.ts";
import { allocate } from "./allocate.ts";
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

function column(x: number, width: number, a: Rect, ids: readonly WindowId[], state: MasterStackState,
  input: SolveInput, slots: Map<WindowId, Rect>): string | null {
  const gap = input.settings.gaps.inner;
  const weights = ids.map((id) => state.weights[id] ?? 1);
  const mins = ids.map((id) => minOf(input.constraints, id).height);
  const rows = allocate(a.y, a.height, weights, mins, gap);
  if (rows === null) return `column of ${ids.length} needs ${mins.reduce((s, m) => s + m, 0) + gap * (ids.length - 1)} px height, has ${a.height}`;
  for (let i = 0; i < ids.length; ++i) slots.set(ids[i], rect(x, rows[i][0], width, rows[i][1] - rows[i][0]));
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
  const masters = ids.slice(0, m);
  const stack = ids.slice(m);
  if (masters.length === 0 || stack.length === 0) {
    const all = masters.length ? masters : stack;
    const minW = Math.max(0, ...all.map((id) => minOf(input.constraints, id).width));
    if (minW > a.width) return { slots, failure: `needs ${minW} px width, has ${a.width}`, notes };
    const f = column(a.x, a.width, a, all, state, input, slots);
    return { slots, failure: f, notes };
  }
  const minMaster = Math.max(...masters.map((id) => minOf(input.constraints, id).width));
  const minStack = Math.max(...stack.map((id) => minOf(input.constraints, id).width));
  const cols = allocate(a.x, a.width, [state.ratio, 1 - state.ratio], [minMaster, minStack], gap);
  if (cols === null) return { slots, failure: `columns need ${minMaster + gap + minStack} px width, have ${a.width}`, notes };
  const usable = a.width - gap;
  const achieved = (cols[0][1] - cols[0][0]) / usable;
  if (Math.abs(achieved - state.ratio) > 1 / Math.max(1, usable)) notes.push(`ratio ${state.ratio.toFixed(3)} clamped to ${achieved.toFixed(3)} by minimum widths`);
  const f1 = column(cols[0][0], cols[0][1] - cols[0][0], a, masters, state, input, slots);
  if (f1) return { slots, failure: `master ${f1}`, notes };
  const f2 = column(cols[1][0], cols[1][1] - cols[1][0], a, stack, state, input, slots);
  if (f2) return { slots, failure: `stack ${f2}`, notes };
  return { slots, failure: null, notes };
}

/** Apply max-size constraints: a slot larger than the window's maximum gets a centred frame. */
export function fitMaxima(slots: Map<WindowId, Rect>, input: SolveInput, notes: string[]): void {
  for (const [id, slot] of slots) {
    const c = input.constraints.get(id);
    if (!c) continue;
    const w = Math.min(slot.width, c.maxFrame.width);
    const h = Math.min(slot.height, c.maxFrame.height);
    if (w < slot.width || h < slot.height) {
      slots.set(id, centreIn(slot, { width: w, height: h }));
      notes.push(`${id}: centred at maximum size ${w}x${h}`);
    }
  }
}

/** Shared overflow loop: drop the newest participant until the layout fits (float-new). */
export function solveWithOverflow(ids: readonly WindowId[], input: SolveInput,
  tryIds: (ids: readonly WindowId[]) => Attempt): SolveResult {
  let current = ids.slice();
  const overflow: WindowId[] = [];
  const notes: string[] = [];
  for (let guard = 0; guard <= ids.length; ++guard) {
    const r = tryIds(current);
    if (r.failure === null) {
      notes.push(...r.notes);
      fitMaxima(r.slots, input, notes);
      return { slots: r.slots, overflow, notes, raise: [] };
    }
    if (current.length === 0) break;
    let victim = current[current.length - 1];
    let newest = -Infinity;
    for (const id of current) {
      const t = input.insertedAt.get(id) ?? 0;
      if (t > newest) { newest = t; victim = id; }
    }
    overflow.push(victim);
    notes.push(`${victim}: does not fit (${r.failure}); overflow float-new`);
    current = current.filter((id) => id !== victim);
  }
  return { slots: new Map(), overflow, notes, raise: [] };
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
        const next = clampRatio(state.ratio + cmd.delta);
        if (next === state.ratio) return { state, changed: false, reason: "ratio at limit" };
        const nextState = { ratio: next, masterCount: state.masterCount, weights: state.weights };
        if (input.ids.length > state.masterCount && state.masterCount > 0) {
          // Feasibility: if minima pin the boundary, the step would change nothing visible.
          const before = attempt(state, input.ids, input);
          const after = attempt(nextState, input.ids, input);
          if (before.failure === null && after.failure === null && sameSlots(before.slots, after.slots)) {
            return { state, changed: false, reason: "ratio clamped by minimum sizes" };
          }
        }
        return { state: nextState, changed: true };
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

function sameSlots(a: Map<WindowId, Rect>, b: Map<WindowId, Rect>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, r] of a) {
    const s = b.get(id);
    if (!s || s.x !== r.x || s.y !== r.y || s.width !== r.width || s.height !== r.height) return false;
  }
  return true;
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
  const usable = a.width - input.settings.gaps.inner;
  if ((cmd.edge === "left" || cmd.edge === "right")) {
    if (m === 0 || m >= ids.length || usable <= 0) return { state, changed: false, reason: "no vertical divider" };
    // Master is on the left: its right edge, or the stack's left edge, is the divider.
    const toward = (isMaster && cmd.edge === "right") ? cmd.delta : (!isMaster && cmd.edge === "left") ? -cmd.delta : 0;
    if (toward === 0) return { state, changed: false, reason: "edge is not the divider" };
    const next = clampRatio(state.ratio + toward / usable);
    if (next === state.ratio) return { state, changed: false, reason: "ratio at limit" };
    return { state: { ratio: next, masterCount: state.masterCount, weights: state.weights }, changed: true };
  }
  // Horizontal divider inside a column: move weight between neighbours.
  const col = isMaster ? ids.slice(0, m) : ids.slice(m);
  const ci = col.indexOf(cmd.id);
  const neighbour = cmd.edge === "bottom" ? col[ci + 1] : col[ci - 1];
  if (neighbour === undefined) return { state, changed: false, reason: "no divider on that edge" };
  const height = a.height - input.settings.gaps.inner * (col.length - 1);
  if (height <= 0) return { state, changed: false, reason: "no space" };
  const total = col.reduce((s, id) => s + (state.weights[id] ?? 1), 0);
  const pxPerWeight = height / total;
  const dw = (cmd.edge === "bottom" ? cmd.delta : -cmd.delta) / pxPerWeight;
  const wa = (state.weights[cmd.id] ?? 1) + dw;
  const wb = (state.weights[neighbour] ?? 1) - dw;
  const minW = 0.05 * total;
  if (wa < minW || wb < minW) return { state, changed: false, reason: "weight at limit" };
  const weights: Record<WindowId, number> = { ...state.weights };
  weights[cmd.id] = wa;
  weights[neighbour] = wb;
  return { state: { ratio: state.ratio, masterCount: state.masterCount, weights }, changed: true };
}
