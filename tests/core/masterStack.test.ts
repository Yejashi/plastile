import { test } from "node:test";
import assert from "node:assert/strict";
import { inset, rect, shareCuts, type Rect } from "../../src/core/geometry.ts";
import { allocate } from "../../src/core/layouts/allocate.ts";
import { masterStack } from "../../src/core/layouts/masterStack.ts";
import type { Constraints, WindowId } from "../../src/core/types.ts";
import { assertTiling, input, minC, prng, settings } from "./helpers.ts";

const S = settings();

/** Floating-point slack for oracles on fractional areas (values are sums of a few floats). */
const EPS = 1e-6;

/**
 * Oracle for any area, fractional included (independent of the solver): slots lie in
 * `inner`, are at least 1 px and at least their minimum, never come closer than `gap`,
 * and every edge lies on the inner boundary or faces a neighbour exactly `gap` away
 * (no lost or doubled pixels at shared edges).
 */
function assertCover(slots: Map<WindowId, Rect>, inner: Rect, gap: number, constraints: Map<WindowId, Constraints>) {
  const list = [...slots.entries()];
  const near = (a: number, b: number) => Math.abs(a - b) <= EPS;
  const spans = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > EPS;
  for (const [id, r] of list) {
    assert.ok(r.width >= 1 - EPS && r.height >= 1 - EPS, `${id} below 1 px ${JSON.stringify(r)}`);
    assert.ok(r.x >= inner.x - EPS && r.y >= inner.y - EPS && r.x + r.width <= inner.x + inner.width + EPS &&
      r.y + r.height <= inner.y + inner.height + EPS, `${id} ${JSON.stringify(r)} outside ${JSON.stringify(inner)}`);
    const min = constraints.get(id)?.minFrame;
    if (min) assert.ok(r.width >= min.width - EPS && r.height >= min.height - EPS, `${id} ${r.width}x${r.height} below minimum ${min.width}x${min.height}`);
    const ySpan = (s: Rect) => spans(r.y - gap, r.y + r.height + gap, s.y, s.y + s.height);
    const xSpan = (s: Rect) => spans(r.x - gap, r.x + r.width + gap, s.x, s.x + s.width);
    const edges: Array<[string, boolean, (s: Rect) => boolean]> = [
      ["right", near(r.x + r.width, inner.x + inner.width), (s) => near(s.x, r.x + r.width + gap) && ySpan(s)],
      ["left", near(r.x, inner.x), (s) => near(s.x + s.width + gap, r.x) && ySpan(s)],
      ["bottom", near(r.y + r.height, inner.y + inner.height), (s) => near(s.y, r.y + r.height + gap) && xSpan(s)],
      ["top", near(r.y, inner.y), (s) => near(s.y + s.height + gap, r.y) && xSpan(s)],
    ];
    for (const [edge, onBoundary, faces] of edges) {
      if (!onBoundary) assert.ok(list.some(([o, s]) => o !== id && faces(s)), `${id} ${edge} edge neither on boundary nor ${gap} px from a neighbour`);
    }
  }
  for (let i = 0; i < list.length; ++i)
    for (let j = i + 1; j < list.length; ++j) {
      const [ia, a] = list[i], [ib, b] = list[j];
      const dx = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
      const dy = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
      if (dy < -EPS) assert.ok(dx >= gap - EPS, `${ia} and ${ib} are ${dx} px apart horizontally`);
      if (dx < -EPS) assert.ok(dy >= gap - EPS, `${ia} and ${ib} are ${dy} px apart vertically`);
    }
}

/**
 * Feasibility from the definition (BEHAVIOR §4, not the solver): every slot is at least
 * 1 px and its minimum; masters share one column, the rest another, separated by gaps.
 */
function msFeasible(ids: WindowId[], masterCount: number, inner: Rect, gap: number, constraints: Map<WindowId, Constraints>): boolean {
  const w = (id: WindowId) => Math.max(1, constraints.get(id)?.minFrame.width ?? 0);
  const h = (id: WindowId) => Math.max(1, constraints.get(id)?.minFrame.height ?? 0);
  const m = Math.max(0, Math.min(masterCount, ids.length));
  const cols = m === 0 || m === ids.length ? [ids] : [ids.slice(0, m), ids.slice(m)];
  const width = cols.reduce((s, col) => s + Math.max(...col.map(w)), 0) + gap * (cols.length - 1);
  if (width > inner.width) return false;
  return cols.every((col) => col.reduce((s, id) => s + h(id), 0) + gap * (col.length - 1) <= inner.height);
}

/** Logical work areas as KWin reports them under fractional scaling: RectF(pos, mode / scale). */
const FRACTIONAL_AREAS = [
  rect(0, 0, 2560 / 1.5, 1440 / 1.5), // 1706.667 x 960
  rect(0, 0, 1366 / 1.25, 768 / 1.25), // 1092.8 x 614.4
  rect(1920, 0, 1920 / 1.75, 1080 / 1.75), // 1097.143 x 617.143, right of a 1920 output
  rect(-1280, 44.667, 2560 / 2, 1600 / 2 - 44.667), // fractional panel reservation on top
];

test("shareCuts covers the span exactly with gaps for odd sizes (G01)", () => {
  for (const length of [1079, 1080, 1919, 7, 101]) {
    for (let n = 1; n <= 7; ++n) {
      if (length < 8 * (n - 1) + n) continue; // infeasible spans are allocate()'s job
      const cuts = shareCuts(3, length, new Array(n).fill(1), 8);
      assert.equal(cuts[0][0], 3);
      assert.equal(cuts[n - 1][1], 3 + length);
      for (let i = 1; i < n; ++i) assert.equal(cuts[i][0] - cuts[i - 1][1], 8, "gap must be exact");
    }
  }
});

test("allocate respects minima and reports infeasibility", () => {
  const a = allocate(0, 1000, [1, 1, 1], [600, 0, 0], 10)!;
  assert.ok(a[0][1] - a[0][0] >= 600);
  assert.equal(a[2][1], 1000);
  assert.equal(allocate(0, 100, [1, 1], [60, 60], 0), null);
});

test("allocate keeps feasible splits on fractional spans and fractional minima (G03)", () => {
  const check = (start: number, length: number, weights: number[], mins: number[], gap: number) => {
    const a = allocate(start, length, weights, mins, gap);
    assert.ok(a !== null, `feasible split refused: ${JSON.stringify([start, length, weights, mins, gap])}`);
    assert.equal(a[0][0], start);
    assert.equal(a[a.length - 1][1], start + length);
    for (let i = 0; i < a.length; ++i) {
      assert.ok(a[i][1] - a[i][0] >= Math.max(1, mins[i]) - EPS, `interval ${i} ${JSON.stringify(a[i])} below ${mins[i]}`);
      if (i > 0) assert.ok(Math.abs(a[i][0] - a[i - 1][1] - gap) <= EPS, "gap must be exact");
    }
    return a;
  };
  // 2560x1440 at 150 % with 8 px outer gaps, stack window minimum 900 px.
  const ms = check(8, 2560 / 1.5 - 16, [0.55, 0.45], [1, 900], 8);
  assert.ok(Number.isInteger(ms[0][1]), "inner cut stays on a whole pixel when one fits");
  check(0, 1366 / 1.25, [0.5, 0.5], [1, 700], 8); // 1092.8 px
  // Fractional minimum on an integer span: [0,699) [699,1000) is valid.
  assert.deepEqual(check(0, 1000, [0.9, 0.1], [0, 300.4], 0), [[0, 699], [699, 1000]]);
  check(44.667, 755.333, [1, 1, 1], [200.5, 0, 300.25], 8); // fractional start
  // Under a pixel of slack: the only valid cut is fractional, and it is used.
  assert.deepEqual(check(0, 1001, [1, 1], [500.5, 500.5], 0), [[0, 500.5], [500.5, 1001]]);
  assert.equal(allocate(0, 1000.5, [1, 1], [500.5, 500.5], 0), null, "sum of minima exceeds the span");

  const rnd = prng(1706);
  for (let iter = 0; iter < 3000; ++iter) {
    const n = 1 + Math.floor(rnd() * 6);
    const gap = Math.floor(rnd() * 3) * 4;
    const start = Math.floor(rnd() * 4000) - 2000 + (rnd() < 0.5 ? 0 : [0.333, 0.5, 0.667, 0.8][Math.floor(rnd() * 4)]);
    const length = (200 + Math.floor(rnd() * 3000)) / [1, 1.25, 1.5, 1.75, 2][Math.floor(rnd() * 5)];
    const weights = Array.from({ length: n }, () => 0.05 + rnd());
    const mins = Array.from({ length: n }, () => rnd() < 0.5 ? 0 : Math.floor(rnd() * length / n) + (rnd() < 0.5 ? 0 : rnd()));
    const need = mins.reduce((s, m) => s + Math.max(1, m), 0) + gap * (n - 1);
    if (need <= length) check(start, length, weights, mins, gap);
    else if (need > length + EPS) assert.equal(allocate(start, length, weights, mins, gap), null);
  }
});

test("master/stack: feasible layouts on fractional work areas are not overflowed (G03)", () => {
  const area = FRACTIONAL_AREAS[0];
  const inner = inset(area, S.gaps.outer);
  const constraints = new Map([["b", minC(900, 0)]]);
  const r = masterStack.solve(masterStack.initial(S), input(["a", "b"], { area, constraints }));
  assert.deepEqual(r.overflow, []);
  assertCover(r.slots, inner, S.gaps.inner, constraints);
  assert.ok(Number.isInteger(r.slots.get("b")!.x), "inner cut on a whole pixel");

  const rnd = prng(150);
  let feasible = 0;
  for (let iter = 0; iter < 2000; ++iter) {
    const area = FRACTIONAL_AREAS[iter % FRACTIONAL_AREAS.length];
    const inner = inset(area, S.gaps.outer);
    const n = 1 + Math.floor(rnd() * 6);
    const ids = Array.from({ length: n }, (_, i) => `w${i}`);
    const frac = () => (rnd() < 0.5 ? 0 : [0.333, 0.571, 0.667][Math.floor(rnd() * 3)]);
    const constraints = new Map(ids.filter(() => rnd() < 0.6)
      .map((id) => [id, minC(Math.floor(rnd() * inner.width * 0.7) + frac(), Math.floor(rnd() * inner.height / 2) + frac())] as const));
    const st = { ratio: 0.05 + rnd() * 0.9, masterCount: Math.floor(rnd() * 3), weights: {} };
    const r = masterStack.solve(st, input(ids, { area, constraints }));
    assert.equal(r.slots.size + r.overflow.length, n);
    if (msFeasible(ids, st.masterCount, inner, S.gaps.inner, constraints)) {
      ++feasible;
      assert.deepEqual(r.overflow, [], `feasible layout overflowed: ${r.notes.join("; ")}`);
    }
    assertCover(r.slots, inner, S.gaps.inner, constraints);
    assert.deepEqual([...masterStack.solve(st, input(ids, { area, constraints })).slots], [...r.slots], "deterministic");
  }
  assert.ok(feasible > 500, `only ${feasible} feasible samples`);
});

test("single window fills the area inside outer gaps", () => {
  const st = masterStack.initial(S);
  const r = masterStack.solve(st, input(["a"]));
  assert.deepEqual(r.slots.get("a"), rect(8, 8, 1904, 1064));
});

test("master/stack tiles without overlap and with exact inner gaps on odd areas", () => {
  const area = rect(-1920, 17, 1919, 1079); // negative origin, odd dimensions (G01/G02)
  for (let n = 1; n <= 9; ++n) {
    const ids = Array.from({ length: n }, (_, i) => `w${i}`);
    const st = masterStack.initial(S);
    const r = masterStack.solve(st, input(ids, { area }));
    assert.equal(r.slots.size, n);
    assert.equal(r.overflow.length, 0);
    assertTiling(r.slots, area);
    if (n >= 2) {
      const m = r.slots.get("w0")!, s0 = r.slots.get("w1")!;
      assert.equal(s0.x - (m.x + m.width), 8, "column gap");
      assert.equal(m.x, area.x + 8);
      const last = r.slots.get(`w${n - 1}`)!;
      assert.equal(last.y + last.height, area.y + area.height - 8, "stack reaches bottom outer gap");
      assert.equal(last.x + last.width, area.x + area.width - 8, "stack reaches right outer gap");
    }
  }
});

test("solve is deterministic and order-stable", () => {
  const st = masterStack.initial(S);
  const a = masterStack.solve(st, input(["a", "b", "c"]));
  const b = masterStack.solve(st, input(["a", "b", "c"]));
  assert.deepEqual([...a.slots], [...b.slots]);
});

test("ratio command clamps at limits and accumulates steps (C05)", () => {
  let st = masterStack.initial(S);
  const inp = input(["a", "b"]);
  const one = masterStack.command(st, { kind: "ratio", delta: 0.05 }, inp);
  const two = masterStack.command(one.state, { kind: "ratio", delta: 0.05 }, inp);
  assert.ok(Math.abs(two.state.ratio - 0.65) < 1e-9);
  st = { ...st, ratio: 0.95 };
  const lim = masterStack.command(st, { kind: "ratio", delta: 0.05 }, inp);
  assert.equal(lim.changed, false);
  assert.equal(lim.reason, "ratio at limit");
});

test("ratio is clamped by minimum widths and reports a no-op (L02)", () => {
  const constraints = new Map([["b", minC(1200, 0)]]);
  const inp = input(["a", "b"], { constraints });
  const st = masterStack.initial(S);
  const r = masterStack.solve(st, inp);
  assert.ok(r.slots.get("b")!.width >= 1200);
  assert.ok(r.notes.some((n) => n.includes("clamped")));
  const grow = masterStack.command(st, { kind: "ratio", delta: 0.05 }, inp);
  assert.equal(grow.changed, false);
  assert.equal(grow.reason, "ratio clamped by minimum sizes");
});

test("infeasible minima float the newest window (G08 float-new)", () => {
  const constraints = new Map([["c", minC(0, 900)], ["b", minC(0, 400)]]);
  const r = masterStack.solve(masterStack.initial(S), input(["a", "b", "c"], { constraints }));
  assert.deepEqual(r.overflow, ["c"]);
  assert.equal(r.slots.size, 2);
  assert.ok(r.notes.some((n) => n.startsWith("c: does not fit")));
});

test("max-size windows are centred in their slot, not stretched (G09)", () => {
  const constraints = new Map([["a", { minFrame: { width: 0, height: 0 }, maxFrame: { width: 500, height: 400 }, fixed: false }]]);
  const r = masterStack.solve(masterStack.initial(S), input(["a"], { constraints }));
  const a = r.slots.get("a")!;
  assert.equal(a.width, 500);
  assert.equal(a.height, 400);
  assert.ok(a.x > 8 && a.y > 8);
});

test("randomized: tiling invariants hold across counts, areas, ratios and minima", () => {
  const rnd = prng(42);
  for (let iter = 0; iter < 400; ++iter) {
    const n = 1 + Math.floor(rnd() * 12);
    const area = rect(Math.floor(rnd() * 4000) - 2000, Math.floor(rnd() * 2000) - 1000,
      400 + Math.floor(rnd() * 3500), 300 + Math.floor(rnd() * 2000));
    const ids = Array.from({ length: n }, (_, i) => `w${i}`);
    const constraints = new Map(ids.filter(() => rnd() < 0.3)
      .map((id) => [id, minC(Math.floor(rnd() * 700), Math.floor(rnd() * 500))] as const));
    const st = { ratio: 0.05 + rnd() * 0.9, masterCount: Math.floor(rnd() * 4), weights: {} };
    const r = masterStack.solve(st, input(ids, { area, constraints }));
    assert.equal(r.slots.size + r.overflow.length, n);
    assertTiling(r.slots, area);
    for (const [id, s] of r.slots) {
      const c = constraints.get(id);
      if (c) {
        assert.ok(s.width >= c.minFrame.width, `${id} width below minimum`);
        assert.ok(s.height >= c.minFrame.height, `${id} height below minimum`);
      }
    }
  }
});

test("resize-boundary moves the divider and row weights", () => {
  const st = masterStack.initial(S);
  const inp = input(["a", "b", "c"]);
  const r = masterStack.command(st, { kind: "resize-boundary", id: "a", edge: "right", delta: 95 }, inp);
  assert.ok(r.changed && r.state.ratio > st.ratio);
  const w = masterStack.command(st, { kind: "resize-boundary", id: "b", edge: "bottom", delta: 100 }, inp);
  assert.ok(w.changed);
  const after = masterStack.solve(w.state, inp);
  const before = masterStack.solve(st, inp);
  assert.ok(Math.abs(after.slots.get("b")!.height - before.slots.get("b")!.height - 100) <= 1);
  const none = masterStack.command(st, { kind: "resize-boundary", id: "a", edge: "left", delta: 10 }, inp);
  assert.equal(none.changed, false);
});
