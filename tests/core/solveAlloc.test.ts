// The low-allocation solve path (G2 report §16) must compute exactly what the code it replaced
// computed. The reference below is the master/stack solver and allocate() as they were before
// that change (b60e618 .. eca2df5), copied verbatim apart from names; the property tests compare
// every slot, overflow and note bit for bit over random contexts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { centreIn, inset, rect, type Rect } from "../../src/core/geometry.ts";
import { allocate, allocateFlat } from "../../src/core/layouts/allocate.ts";
import { masterStack, type MasterStackState } from "../../src/core/layouts/masterStack.ts";
import type { SolveInput, SolveResult } from "../../src/core/layouts/layout.ts";
import type { Constraints, WindowId } from "../../src/core/types.ts";
import { input, prng, settings } from "./helpers.ts";

// ------------------------------------------------------------------ reference (pre-§16 code)
function refAllocate(start: number, length: number, weights: readonly number[], minsIn: readonly number[],
  gap: number): Array<[number, number]> | null {
  const n = weights.length;
  const mins = minsIn.map((m) => Math.max(1, m));
  if (n === 0) return [];
  const usable = length - gap * (n - 1);
  let minSum = 0;
  for (const m of mins) minSum += Math.max(0, m);
  if (usable < minSum - 1e-9 || usable <= 0) return null;
  const size = new Array<number>(n).fill(0);
  const pinned = new Array<boolean>(n).fill(false);
  for (let pass = 0; pass <= n; ++pass) {
    let free = usable;
    let wsum = 0;
    for (let i = 0; i < n; ++i) {
      if (pinned[i]) free -= size[i];
      else wsum += safeWeight(weights[i]);
    }
    let violated = false;
    for (let i = 0; i < n; ++i) {
      if (pinned[i]) continue;
      size[i] = wsum > 0 ? free * safeWeight(weights[i]) / wsum : 0;
    }
    for (let i = 0; i < n; ++i) {
      if (!pinned[i] && size[i] < mins[i] - 1e-9) {
        pinned[i] = true;
        size[i] = Math.max(0, mins[i]);
        violated = true;
      }
    }
    if (!violated) break;
  }
  const end = start + length;
  const tail = new Array<number>(n).fill(0);
  for (let i = n - 2; i >= 0; --i) tail[i] = tail[i + 1] + gap + mins[i + 1];
  const out: Array<[number, number]> = [];
  let acc = 0;
  let begin = start;
  for (let i = 0; i < n; ++i) {
    acc += size[i];
    let cut = end;
    if (i < n - 1) {
      const want = start + acc + gap * i;
      const lo = begin + mins[i];
      const hi = end - tail[i];
      const ilo = Math.ceil(lo), ihi = Math.floor(hi);
      cut = ilo <= ihi ? Math.min(ihi, Math.max(ilo, Math.round(want))) : Math.min(hi, Math.max(lo, want));
    }
    out.push([begin, cut]);
    begin = cut + gap;
  }
  return out;
}

function safeWeight(w: number): number {
  return Number.isFinite(w) && w > 0 ? w : 1;
}

const NO_MIN = { width: 0, height: 0 };
const minOf = (c: ReadonlyMap<WindowId, Constraints>, id: WindowId) => c.get(id)?.minFrame ?? NO_MIN;

interface Attempt { slots: Map<WindowId, Rect>; failure: string | null; notes: string[] }

function refColumn(x: number, width: number, a: Rect, ids: readonly WindowId[], state: MasterStackState,
  inp: SolveInput, slots: Map<WindowId, Rect>): string | null {
  const gap = inp.settings.gaps.inner;
  const weights = ids.map((id) => state.weights[id] ?? 1);
  const mins = ids.map((id) => minOf(inp.constraints, id).height);
  const rows = refAllocate(a.y, a.height, weights, mins, gap);
  if (rows === null) return `column of ${ids.length} needs ${mins.reduce((s, m) => s + m, 0) + gap * (ids.length - 1)} px height, has ${a.height}`;
  for (let i = 0; i < ids.length; ++i) slots.set(ids[i], rect(x, rows[i][0], width, rows[i][1] - rows[i][0]));
  return null;
}

function refAttempt(state: MasterStackState, ids: readonly WindowId[], inp: SolveInput): Attempt {
  const notes: string[] = [];
  const slots = new Map<WindowId, Rect>();
  const n = ids.length;
  if (n === 0) return { slots, failure: null, notes };
  const a = n === 1 && !inp.settings.singleWindowGaps ? inp.area : inset(inp.area, inp.settings.gaps.outer);
  const gap = inp.settings.gaps.inner;
  const m = Math.max(0, Math.min(state.masterCount, n));
  const masters = ids.slice(0, m);
  const stack = ids.slice(m);
  if (masters.length === 0 || stack.length === 0) {
    const all = masters.length ? masters : stack;
    const minW = Math.max(0, ...all.map((id) => minOf(inp.constraints, id).width));
    if (minW > a.width) return { slots, failure: `needs ${minW} px width, has ${a.width}`, notes };
    const f = refColumn(a.x, a.width, a, all, state, inp, slots);
    return { slots, failure: f, notes };
  }
  const minMaster = Math.max(...masters.map((id) => minOf(inp.constraints, id).width));
  const minStack = Math.max(...stack.map((id) => minOf(inp.constraints, id).width));
  const cols = refAllocate(a.x, a.width, [state.ratio, 1 - state.ratio], [minMaster, minStack], gap);
  if (cols === null) return { slots, failure: `columns need ${minMaster + gap + minStack} px width, have ${a.width}`, notes };
  const usable = a.width - gap;
  const achieved = (cols[0][1] - cols[0][0]) / usable;
  if (Math.abs(achieved - state.ratio) > 1 / Math.max(1, usable)) notes.push(`ratio ${state.ratio.toFixed(3)} clamped to ${achieved.toFixed(3)} by minimum widths`);
  const f1 = refColumn(cols[0][0], cols[0][1] - cols[0][0], a, masters, state, inp, slots);
  if (f1) return { slots, failure: `master ${f1}`, notes };
  const f2 = refColumn(cols[1][0], cols[1][1] - cols[1][0], a, stack, state, inp, slots);
  if (f2) return { slots, failure: `stack ${f2}`, notes };
  return { slots, failure: null, notes };
}

function refFitMaxima(slots: Map<WindowId, Rect>, inp: SolveInput, notes: string[]): void {
  for (const [id, slot] of slots) {
    const c = inp.constraints.get(id);
    if (!c) continue;
    const w = Math.min(slot.width, c.maxFrame.width);
    const h = Math.min(slot.height, c.maxFrame.height);
    if (w < slot.width || h < slot.height) {
      slots.set(id, centreIn(slot, { width: w, height: h }));
      notes.push(`${id}: centred at maximum size ${w}x${h}`);
    }
  }
}

function refSolve(state: MasterStackState, inp: SolveInput): SolveResult {
  const ids = inp.ids;
  const tryIds = (x: readonly WindowId[]) => refAttempt(state, x, inp);
  const done = (r: Attempt, overflow: WindowId[], notes: string[]): SolveResult => {
    notes.push(...r.notes);
    refFitMaxima(r.slots, inp, notes);
    return { slots: r.slots, overflow, notes, raise: [] };
  };
  const all = tryIds(ids);
  if (all.failure === null) return done(all, [], []);
  const at = new Map<WindowId, number>();
  ids.forEach((id, i) => at.set(id, i));
  const seq = (id: WindowId) => inp.insertedAt.get(id) ?? 0;
  const older = (a: WindowId, b: WindowId) => seq(a) - seq(b) || at.get(a)! - at.get(b)!;
  const kept = new Set<WindowId>();
  const failed = new Map<WindowId, string>();
  let fits = tryIds([]);
  for (const id of ids.slice().sort(older)) {
    const r = tryIds(ids.filter((x) => kept.has(x) || x === id));
    if (r.failure === null) { kept.add(id); fits = r; } else failed.set(id, r.failure);
  }
  const overflow = [...failed.keys()].sort((a, b) => older(b, a));
  const notes = overflow.map((id) => `${id}: does not fit (${failed.get(id)}); overflow float-new`);
  return done(fits, overflow, notes);
}

// ------------------------------------------------------------------------------- tests
const asList = (m: Map<WindowId, Rect>) => [...m.entries()];

test("allocateFlat is allocate() flattened, number for number (random spans, minima, gaps)", () => {
  const rnd = prng(1619);
  for (let iter = 0; iter < 5000; ++iter) {
    const n = Math.floor(rnd() * 9);
    const gap = Math.floor(rnd() * 3) * 4 + (rnd() < 0.1 ? 0.5 : 0);
    const start = Math.floor(rnd() * 4000) - 2000 + (rnd() < 0.5 ? 0 : rnd());
    const length = (rnd() < 0.05 ? -1 : 1) * (1 + Math.floor(rnd() * 4000)) / [1, 1.25, 1.5, 1.75, 2][Math.floor(rnd() * 5)];
    const weights = Array.from({ length: n }, () => rnd() < 0.1 ? [0, -1, NaN, Infinity][Math.floor(rnd() * 4)] : 0.05 + rnd());
    const mins = Array.from({ length: n }, () => rnd() < 0.4 ? 0 : Math.floor(rnd() * Math.abs(length) / Math.max(1, n)) + (rnd() < 0.5 ? 0 : rnd()));
    const ref = refAllocate(start, length, weights, mins, gap);
    assert.deepEqual(allocate(start, length, weights, mins, gap), ref);
    const flat = allocateFlat(start, length, weights, mins, gap);
    assert.deepEqual(flat, ref === null ? null : ref.flat());
  }
});

test("master/stack solve is unchanged by the low-allocation rewrite (slots, overflow, notes)", () => {
  const rnd = prng(2026);
  let overflowCases = 0, clampCases = 0, maxCases = 0;
  for (let iter = 0; iter < 4000; ++iter) {
    const n = Math.floor(rnd() * 12);
    const ids = Array.from({ length: n }, (_, i) => `w${i}`);
    const constraints = new Map<WindowId, Constraints>();
    for (const id of ids) {
      if (rnd() < 0.3) continue;
      const big = rnd() < 0.15;
      constraints.set(id, {
        minFrame: { width: Math.floor(rnd() * (big ? 1500 : 400)) + (rnd() < 0.2 ? 0.5 : 0), height: Math.floor(rnd() * (big ? 900 : 300)) },
        maxFrame: rnd() < 0.2 ? { width: 200 + Math.floor(rnd() * 600), height: 150 + Math.floor(rnd() * 400) } : { width: Infinity, height: Infinity },
        fixed: false,
      });
    }
    const weights: Record<WindowId, number> = {};
    for (const id of ids) if (rnd() < 0.3) weights[id] = 0.2 + 2 * rnd();
    const state: MasterStackState = {
      ratio: 0.05 + 0.9 * rnd(), masterCount: Math.floor(rnd() * 4), weights,
    };
    const area = rect(Math.floor(rnd() * 100), Math.floor(rnd() * 50) + (rnd() < 0.2 ? 0.333 : 0),
      400 + Math.floor(rnd() * 2200) + (rnd() < 0.2 ? 0.8 : 0), 300 + Math.floor(rnd() * 1500));
    const o = () => Math.floor(rnd() * 3) * 4;
    const st = settings({ gaps: { inner: o(), outer: { top: o(), right: o(), bottom: o(), left: o() } }, singleWindowGaps: rnd() < 0.5 });
    const inp = input(ids, { area, settings: st, constraints });
    const got = masterStack.solve(state, inp);
    const want = refSolve(state, inp);
    assert.deepEqual(asList(got.slots), asList(want.slots), `slots, iteration ${iter}`);
    assert.deepEqual(got.overflow, want.overflow, `overflow, iteration ${iter}`);
    assert.deepEqual(got.notes, want.notes, `notes, iteration ${iter}`);
    if (want.overflow.length) overflowCases++;
    if (want.notes.some((x) => x.startsWith("ratio "))) clampCases++;
    if (want.notes.some((x) => x.includes("maximum size"))) maxCases++;
  }
  // The random contexts reach every branch: overflow, minimum-width clamps, maximum sizes.
  assert.ok(overflowCases > 100 && clampCases > 50 && maxCases > 100, JSON.stringify({ overflowCases, clampCases, maxCases }));
});
