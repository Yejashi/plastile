// Persistent binary space partition layout (BEHAVIOR_SPEC §5, ARCHITECTURE §9).
// The tree is an immutable value: every change path-copies the ancestors of the
// touched node, so unrelated subtrees keep their objects and IDs. All traversals
// use explicit stacks; a 5000-leaf linked-list tree must not overflow the QV4 or
// V8 call stack (L05).

import { inset, rect, type Rect, type Size } from "../geometry.ts";
import type { ContextSettings, WindowId } from "../types.ts";
import { allocate } from "./allocate.ts";
import type { CommandOutcome, Layout, LayoutCommand, SolveInput } from "./layout.ts";
import { solveWithOverflow, type Attempt } from "./masterStack.ts";

/** horizontal: a left, b right. vertical: a above b. */
export type BspAxis = "horizontal" | "vertical";

export interface BspLeaf {
  readonly kind: "leaf";
  readonly id: string;
  readonly window: WindowId;
}

export interface BspBranch {
  readonly kind: "branch";
  readonly id: string;
  readonly axis: BspAxis;
  /** Share of side `a` along `axis`, in (0, 1). */
  readonly ratio: number;
  readonly a: BspNode;
  readonly b: BspNode;
}

export type BspNode = BspLeaf | BspBranch;

export interface BspState {
  readonly root: BspNode | null;
  readonly nextId: number;
}

export type BspSide = "left" | "right" | "top" | "bottom";

export const RATIO_MIN = 0.05;
export const RATIO_MAX = 0.95;

// Ratios are quantized on every write. With r = k/1e9, q(1 - q(1 - r)) === r
// exactly, so rotate/mirror round trips return bit-identical ratios (plain 1 - r
// is not an involution in binary floating point for r < 0.5).
const QUANTUM = 1e9;

function quantize(r: number): number {
  return Math.round(r * QUANTUM) / QUANTUM;
}

function clampRatio(r: number): number {
  return quantize(Math.min(RATIO_MAX, Math.max(RATIO_MIN, r)));
}

function flip(r: number): number {
  return quantize(1 - r);
}

// ---- Structural helpers ------------------------------------------------------

interface Step {
  readonly branch: BspBranch;
  readonly side: "a" | "b";
}

interface Located {
  readonly leaf: BspLeaf;
  /** Ancestors from the root down to the leaf's parent. */
  readonly path: Step[];
}

function branch(id: string, axis: BspAxis, ratio: number, a: BspNode, b: BspNode): BspBranch {
  return { kind: "branch", id, axis, ratio, a, b };
}

function leaf(id: string, window: WindowId): BspLeaf {
  return { kind: "leaf", id, window };
}

function withChild(br: BspBranch, side: "a" | "b", child: BspNode): BspBranch {
  return side === "a" ? branch(br.id, br.axis, br.ratio, child, br.b) : branch(br.id, br.axis, br.ratio, br.a, child);
}

/** Replace the node at the end of `path` (the child on the last step's side) and copy ancestors. */
function replaceAt(path: readonly Step[], node: BspNode | null): BspNode | null {
  let cur = node;
  for (let i = path.length - 1; i >= 0; --i) cur = withChild(path[i].branch, path[i].side, cur as BspNode);
  return cur;
}

/** Remove the subtree at the end of `path`; its parent collapses into the surviving sibling. */
function removeAt(path: readonly Step[]): BspNode | null {
  if (path.length === 0) return null;
  const last = path[path.length - 1];
  const sibling = last.side === "a" ? last.branch.b : last.branch.a;
  return replaceAt(path.slice(0, -1), sibling);
}

/** First leaf in DFS (a-then-b) order matching `pred`, with its ancestor path. */
function findLeaf(root: BspNode | null, pred: (l: BspLeaf) => boolean): Located | null {
  if (!root) return null;
  // Pre-order with an explicit path: when a node at depth d is popped, path[0..d-2]
  // are already its ancestors, so truncating and pushing its own step is enough.
  const nodes: BspNode[] = [root];
  const depths: number[] = [0];
  const parents: Array<BspBranch | null> = [null];
  const path: Step[] = [];
  while (nodes.length > 0) {
    const n = nodes.pop()!;
    const d = depths.pop()!;
    const p = parents.pop()!;
    if (p !== null) {
      path.length = d - 1;
      path.push({ branch: p, side: p.a === n ? "a" : "b" });
    }
    if (n.kind === "leaf") {
      if (pred(n)) return { leaf: n, path: path.slice() };
      continue;
    }
    nodes.push(n.b, n.a);
    depths.push(d + 1, d + 1);
    parents.push(n, n);
  }
  return null;
}

function findWindow(root: BspNode | null, window: WindowId): Located | null {
  return findLeaf(root, (l) => l.window === window);
}

/** Last leaf in DFS order: follow `b` from the root. */
function lastLeaf(root: BspNode): Located {
  const path: Step[] = [];
  let cur = root;
  while (cur.kind === "branch") {
    path.push({ branch: cur, side: "b" });
    cur = cur.b;
  }
  return { leaf: cur, path };
}

/** Visit every node after its children (iterative post-order). */
function postOrder(root: BspNode, visit: (n: BspNode) => void): void {
  const nodes: BspNode[] = [root];
  const expanded: boolean[] = [false];
  while (nodes.length > 0) {
    const n = nodes.pop()!;
    const done = expanded.pop()!;
    if (n.kind === "leaf" || done) {
      visit(n);
      continue;
    }
    nodes.push(n, n.b, n.a);
    expanded.push(true, false, false);
  }
}

/**
 * Rebuild the tree bottom-up through `f`. A branch whose `f` result is the branch
 * itself and whose children are unchanged keeps its object identity.
 */
function mapBranches(root: BspNode, f: (br: BspBranch, a: BspNode, b: BspNode) => BspNode): BspNode {
  const out = new Map<BspNode, BspNode>();
  postOrder(root, (n) => {
    if (n.kind === "leaf") { out.set(n, n); return; }
    const a = out.get(n.a)!;
    const b = out.get(n.b)!;
    const base = a === n.a && b === n.b ? n : branch(n.id, n.axis, n.ratio, a, b);
    out.set(n, f(base, a, b));
  });
  return out.get(root)!;
}

// ---- Public helpers ----------------------------------------------------------

/** Windows in DFS (a-then-b) order. */
export function leaves(state: BspState): WindowId[] {
  const out: WindowId[] = [];
  if (!state.root) return out;
  const stack: BspNode[] = [state.root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.kind === "leaf") out.push(n.window);
    else stack.push(n.b, n.a);
  }
  return out;
}

/** Invariant violations; empty when the state is valid. */
export function checkBsp(state: BspState): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(state.nextId) || state.nextId < 1) errors.push(`nextId ${state.nextId} is not a positive integer`);
  if (!state.root) return errors;
  const windows = new Set<WindowId>();
  const ids = new Set<string>();
  const seen = new Set<BspNode>();
  const stack: BspNode[] = [state.root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) { errors.push(`node object ${n.id} reachable twice`); continue; }
    seen.add(n);
    if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
    const m = /^n(\d+)$/.exec(n.id);
    if (m && Number(m[1]) >= state.nextId) errors.push(`node id ${n.id} not below nextId ${state.nextId}`);
    if (n.kind === "leaf") {
      if (windows.has(n.window)) errors.push(`duplicate window ${n.window}`);
      windows.add(n.window);
      continue;
    }
    if (!(n.ratio > 0 && n.ratio < 1)) errors.push(`branch ${n.id} ratio ${n.ratio} outside (0,1)`);
    if (n.axis !== "horizontal" && n.axis !== "vertical") errors.push(`branch ${n.id} has invalid axis ${String(n.axis)}`);
    stack.push(n.b, n.a);
  }
  return errors;
}

/**
 * Structural move: take `id`'s leaf out and split `target`'s leaf, placing the
 * moved leaf on `side` of it. The new branch gets ratio 0.5 (no settings here).
 */
export function reinsert(state: BspState, id: WindowId, target: WindowId, side: BspSide): BspState {
  if (id === target) return state;
  const moved = findWindow(state.root, id);
  if (!moved || !findWindow(state.root, target)) return state;
  const root = removeAt(moved.path);
  const t = findWindow(root, target)!;
  const axis: BspAxis = side === "left" || side === "right" ? "horizontal" : "vertical";
  const first = side === "left" || side === "top";
  const br = branch(`n${state.nextId}`, axis, 0.5, first ? moved.leaf : t.leaf, first ? t.leaf : moved.leaf);
  return { root: replaceAt(t.path, br), nextId: state.nextId + 1 };
}

// ---- Solving -----------------------------------------------------------------

interface Laid {
  readonly attempt: Attempt;
  /** Solved rectangle per participating node (keyed by node object). */
  readonly rects: Map<BspNode, Rect>;
  /** Aggregated frame minima per node that has at least one participant. */
  readonly minima: Map<BspNode, Size>;
}

const NO_MIN: Size = { width: 0, height: 0 };

function leafMin(input: SolveInput, window: WindowId, useMinima: boolean): Size {
  const m = useMinima ? input.constraints.get(window)?.minFrame ?? NO_MIN : NO_MIN;
  // allocate() never yields a slot below 1 px. Minima stay exact (frame minima are
  // fractional at fractional scales); allocate() places cuts for fractional minima.
  return { width: Math.max(1, m.width), height: Math.max(1, m.height) };
}

/** Bottom-up minima. Subtrees without participants are absent (virtually collapsed). */
function aggregateMinima(root: BspNode, live: ReadonlySet<WindowId>, input: SolveInput, useMinima: boolean): Map<BspNode, Size> {
  const gap = input.settings.gaps.inner;
  const out = new Map<BspNode, Size>();
  postOrder(root, (n) => {
    if (n.kind === "leaf") {
      if (live.has(n.window)) out.set(n, leafMin(input, n.window, useMinima));
      return;
    }
    const a = out.get(n.a);
    const b = out.get(n.b);
    if (a && b) {
      out.set(n, n.axis === "horizontal"
        ? { width: a.width + gap + b.width, height: Math.max(a.height, b.height) }
        : { width: Math.max(a.width, b.width), height: a.height + gap + b.height });
    } else if (a || b) {
      out.set(n, (a ?? b)!);
    }
  });
  return out;
}

function layOut(root: BspNode | null, ids: readonly WindowId[], input: SolveInput, useMinima: boolean): Laid {
  const slots = new Map<WindowId, Rect>();
  const notes: string[] = [];
  const rects = new Map<BspNode, Rect>();
  const live = new Set(ids);
  const minima = root ? aggregateMinima(root, live, input, useMinima) : new Map<BspNode, Size>();
  const done = (failure: string | null): Laid => ({ attempt: { slots, failure, notes }, rects, minima });
  if (!root || !minima.has(root)) {
    for (const id of ids) notes.push(`${id}: not in bsp tree; no slot`);
    return done(null);
  }

  let participants = 0;
  for (const m of minima.keys()) if (m.kind === "leaf") ++participants;
  const g = input.settings.gaps;
  const area = participants === 1 && !input.settings.singleWindowGaps ? input.area : inset(input.area, g.outer);
  const need = minima.get(root)!;
  // Same slack as allocate(): fractional minima sum with rounding noise.
  if (need.width > area.width + 1e-9 || need.height > area.height + 1e-9) {
    return done(`tree needs ${need.width}x${need.height} px, has ${area.width}x${area.height}`);
  }

  const nodes: BspNode[] = [root];
  const boxes: Rect[] = [area];
  while (nodes.length > 0) {
    const n = nodes.pop()!;
    const r = boxes.pop()!;
    rects.set(n, r);
    if (n.kind === "leaf") { slots.set(n.window, r); continue; }
    const ma = minima.get(n.a);
    const mb = minima.get(n.b);
    if (!ma || !mb) {
      // One side has no participants: the other side takes the whole rect, no gap.
      nodes.push(ma ? n.a : n.b);
      boxes.push(r);
      continue;
    }
    const horizontal = n.axis === "horizontal";
    const start = horizontal ? r.x : r.y;
    const length = horizontal ? r.width : r.height;
    const cuts = allocate(start, length, [n.ratio, 1 - n.ratio],
      horizontal ? [ma.width, mb.width] : [ma.height, mb.height], g.inner);
    if (cuts === null) return done(`branch ${n.id} (${n.axis}) cannot fit minima in ${length} px`);
    const usable = length - g.inner;
    const achieved = (cuts[0][1] - cuts[0][0]) / usable;
    if (Math.abs(achieved - n.ratio) > 1 / Math.max(1, usable)) {
      notes.push(`branch ${n.id}: ratio ${n.ratio.toFixed(3)} clamped to ${achieved.toFixed(3)} by minimum sizes`);
    }
    const ra = horizontal ? rect(cuts[0][0], r.y, cuts[0][1] - cuts[0][0], r.height) : rect(r.x, cuts[0][0], r.width, cuts[0][1] - cuts[0][0]);
    const rb = horizontal ? rect(cuts[1][0], r.y, cuts[1][1] - cuts[1][0], r.height) : rect(r.x, cuts[1][0], r.width, cuts[1][1] - cuts[1][0]);
    nodes.push(n.b, n.a);
    boxes.push(rb, ra);
  }
  for (const id of ids) if (!slots.has(id)) notes.push(`${id}: not in bsp tree; no slot`);
  return done(null);
}

/** Rects for the current tree, falling back to a minima-free partition when infeasible. */
function currentRects(root: BspNode, ids: readonly WindowId[], input: SolveInput): Laid {
  const laid = layOut(root, ids, input, true);
  return laid.attempt.failure === null ? laid : layOut(root, ids, input, false);
}

// ---- Insertion ---------------------------------------------------------------

function chooseAxis(root: BspNode, target: Located, input: SolveInput): BspAxis {
  const policy = input.settings.bsp.axis;
  if (policy === "horizontal" || policy === "vertical") return policy;
  if (policy === "alternate") {
    const parent = target.path.length > 0 ? target.path[target.path.length - 1].branch : null;
    return parent === null || parent.axis === "vertical" ? "horizontal" : "vertical";
  }
  // "longest": split the target's current slot along its longer side.
  const ids = input.members.slice();
  if (ids.indexOf(target.leaf.window) < 0) ids.push(target.leaf.window);
  const slot = currentRects(root, ids, input).rects.get(target.leaf);
  const r = slot ?? input.area;
  return r.width >= r.height ? "horizontal" : "vertical";
}

function insertAbsent(state: BspState, id: WindowId, after: WindowId | null, input: SolveInput): BspState {
  const n = state.nextId;
  if (!state.root) return { root: leaf(`n${n}`, id), nextId: n + 1 };
  const focused = input.settings.bsp.insert === "focused" && after !== null ? findWindow(state.root, after) : null;
  const target = focused ?? lastLeaf(state.root);
  const axis = chooseAxis(state.root, target, input);
  const br = branch(`n${n + 1}`, axis, clampRatio(input.settings.bsp.initialRatio), target.leaf, leaf(`n${n}`, id));
  return { root: replaceAt(target.path, br), nextId: n + 2 };
}

/** Drop leaves whose window is not kept (and repeated windows); collapse emptied branches. */
function prune(root: BspNode, keep: ReadonlySet<WindowId>): BspNode | null {
  const out = new Map<BspNode, BspNode | null>();
  const placed = new Set<WindowId>();
  postOrder(root, (n) => {
    if (n.kind === "leaf") {
      const ok = keep.has(n.window) && !placed.has(n.window);
      if (ok) placed.add(n.window);
      out.set(n, ok ? n : null);
      return;
    }
    const a = out.get(n.a)!;
    const b = out.get(n.b)!;
    if (a === null || b === null) out.set(n, a ?? b);
    else out.set(n, a === n.a && b === n.b ? n : branch(n.id, n.axis, n.ratio, a, b));
  });
  return out.get(root)!;
}

// ---- Commands ----------------------------------------------------------------

function rotateNode(br: BspBranch, clockwise: boolean): BspNode {
  // Clockwise: [a|b] -> [a over b]; [a over b] -> [b|a].
  // Counter-clockwise is the inverse: [a over b] -> [a|b]; [a|b] -> [b over a].
  const swap = clockwise ? br.axis === "vertical" : br.axis === "horizontal";
  const axis: BspAxis = br.axis === "horizontal" ? "vertical" : "horizontal";
  return swap ? branch(br.id, axis, flip(br.ratio), br.b, br.a) : branch(br.id, axis, br.ratio, br.a, br.b);
}

function edgeAxis(edge: BspSide): BspAxis {
  return edge === "left" || edge === "right" ? "horizontal" : "vertical";
}

function resizeBoundary(state: BspState, cmd: Extract<LayoutCommand, { kind: "resize-boundary" }>,
  input: SolveInput): CommandOutcome<BspState> {
  const loc = findWindow(state.root, cmd.id);
  if (!loc || input.ids.indexOf(cmd.id) < 0) return { state, changed: false, reason: "window not tiled here" };
  const laid = currentRects(state.root!, input.ids, input);
  const axis = edgeAxis(cmd.edge);
  const needSide = cmd.edge === "right" || cmd.edge === "bottom" ? "a" : "b";
  for (let i = loc.path.length - 1; i >= 0; --i) {
    const { branch: br, side } = loc.path[i];
    // A branch with a collapsed side has no visible divider; its edges are the parent's.
    if (!laid.minima.has(br.a) || !laid.minima.has(br.b)) continue;
    if (br.axis !== axis || side !== needSide) continue;
    const r = laid.rects.get(br);
    const usable = (r ? (axis === "horizontal" ? r.width : r.height) : 0) - input.settings.gaps.inner;
    if (usable <= 0) return { state, changed: false, reason: "no space" };
    // Positive delta moves the edge right/down; on either side that moves the divider
    // right/down, which grows side a.
    const next = clampRatio(br.ratio + cmd.delta / usable);
    if (next === br.ratio) return { state, changed: false, reason: "ratio at limit" };
    const nb = branch(br.id, br.axis, next, br.a, br.b);
    return { state: { root: replaceAt(loc.path.slice(0, i), nb), nextId: state.nextId }, changed: true };
  }
  return { state, changed: false, reason: "no divider on that edge" };
}

function transform(state: BspState, f: (br: BspBranch) => BspNode, reason: string): CommandOutcome<BspState> {
  if (!state.root) return { state, changed: false, reason };
  const root = mapBranches(state.root, (br) => f(br));
  if (root === state.root) return { state, changed: false, reason };
  return { state: { root, nextId: state.nextId }, changed: true };
}

// ---- Layout ------------------------------------------------------------------

export const bsp: Layout<BspState> = {
  kind: "bsp",

  initial(_settings: ContextSettings): BspState {
    return { root: null, nextId: 1 };
  },

  insert(state, id, after, input) {
    if (findWindow(state.root, id)) return state;
    return insertAbsent(state, id, after, input);
  },

  remove(state, id) {
    const loc = findWindow(state.root, id);
    if (!loc) return state;
    return { root: removeAt(loc.path), nextId: state.nextId };
  },

  rebuild(state, members, input) {
    const keep = new Set(members);
    const root = state.root ? prune(state.root, keep) : null;
    let next: BspState = root === state.root ? state : { root, nextId: state.nextId };
    const present = new Set(leaves(next));
    let prev: WindowId | null = null;
    for (const id of members) {
      if (!present.has(id)) {
        next = insertAbsent(next, id, prev, input);
        present.add(id);
      }
      prev = id;
    }
    return next;
  },

  solve(state, input) {
    return solveWithOverflow(input.ids, input, (ids) => layOut(state.root, ids, input, true).attempt);
  },

  command(state: BspState, cmd: LayoutCommand, input: SolveInput): CommandOutcome<BspState> {
    switch (cmd.kind) {
      case "ratio": {
        const loc = input.focused === null ? null : findWindow(state.root, input.focused);
        if (!loc) return { state, changed: false, reason: "no focused tile" };
        if (loc.path.length === 0) return { state, changed: false, reason: "no divider" };
        const { branch: br, side } = loc.path[loc.path.length - 1];
        const next = clampRatio(br.ratio + (side === "a" ? cmd.delta : -cmd.delta));
        if (next === br.ratio) return { state, changed: false, reason: "ratio at limit" };
        const nb = branch(br.id, br.axis, next, br.a, br.b);
        return { state: { root: replaceAt(loc.path.slice(0, -1), nb), nextId: state.nextId }, changed: true };
      }
      case "equalize":
        return transform(state, (br) => br.ratio === 0.5 ? br : branch(br.id, br.axis, 0.5, br.a, br.b), "already equal");
      case "rotate": {
        const clockwise = cmd.clockwise;
        return transform(state, (br) => rotateNode(br, clockwise), "nothing to rotate");
      }
      case "mirror": {
        const axis = cmd.axis;
        return transform(state, (br) => br.axis === axis ? branch(br.id, br.axis, flip(br.ratio), br.b, br.a) : br,
          "nothing to mirror");
      }
      case "resize-boundary":
        return resizeBoundary(state, cmd, input);
      default:
        return { state, changed: false, reason: `${cmd.kind} not supported by bsp` };
    }
  },

  swap(state, a, b) {
    if (a === b) return state;
    const la = findWindow(state.root, a);
    if (!la || !findWindow(state.root, b)) return state;
    const root1 = replaceAt(la.path, leaf(la.leaf.id, b));
    // After the first replacement `b` occurs twice; locate the original b leaf by node id.
    const lb = findLeaf(root1, (l) => l.window === b && l.id !== la.leaf.id)!;
    return { root: replaceAt(lb.path, leaf(lb.leaf.id, a)), nextId: state.nextId };
  },
};
