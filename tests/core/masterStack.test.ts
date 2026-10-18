import { test } from "node:test";
import assert from "node:assert/strict";
import { rect, shareCuts } from "../../src/core/geometry.ts";
import { allocate } from "../../src/core/layouts/allocate.ts";
import { masterStack } from "../../src/core/layouts/masterStack.ts";
import { assertTiling, input, minC, prng, settings } from "./helpers.ts";

const S = settings();

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
