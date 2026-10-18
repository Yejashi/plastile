// Directional focus fixtures (BEHAVIOR §7, T23): half-plane filter, orthogonal overlap,
// distance, stable tie-break, no wrap at area edges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rect, type Rect } from "../../src/core/geometry.ts";
import { adjacentOutput, neighbour, outputOrder, wrapNeighbour, type Direction } from "../../src/core/navigation.ts";
import { bsp, leaves } from "../../src/core/layouts/bsp.ts";
import { masterStack } from "../../src/core/layouts/masterStack.ts";
import type { WindowId } from "../../src/core/types.ts";
import { input, prng, settings } from "./helpers.ts";

const S = settings();

type Row = [from: WindowId, dir: Direction, want: WindowId | null];

function table(rects: Map<WindowId, Rect>, rows: Row[]) {
  for (const [from, dir, want] of rows) assert.equal(neighbour(from, dir, rects), want, `${from} ${dir}`);
}

function wrapTable(rects: Map<WindowId, Rect>, rows: Row[]) {
  for (const [from, dir, want] of rows) assert.equal(wrapNeighbour(from, dir, rects), want, `wrap ${from} ${dir}`);
}

test("master/stack: neighbours, ties in stable order, nothing beyond the area edges", () => {
  // m | s1 / s2 at 1920x1080: s1 and s2 tie for m's right (same overlap and distance).
  const r = masterStack.solve(masterStack.initial(S), input(["m", "s1", "s2"])).slots;
  table(r, [
    ["m", "right", "s1"], ["m", "up", null], ["m", "down", null], ["m", "left", null],
    ["s1", "left", "m"], ["s1", "down", "s2"], ["s1", "up", null], ["s1", "right", null],
    ["s2", "left", "m"], ["s2", "up", "s1"], ["s2", "down", null], ["s2", "right", null],
  ]);
  // The review's case: a full-height master has nothing above or below it, although the
  // first and last stack windows' centres are above and below its centre.
  const four = masterStack.solve(masterStack.initial(S), input(["m", "s1", "s2", "s3"])).slots;
  table(four, [["m", "up", null], ["m", "down", null], ["s2", "up", "s1"], ["s2", "down", "s3"], ["s3", "left", "m"]]);
});

test("BSP: irregular rectangles prefer orthogonal overlap, then distance", () => {
  // [a | (b / (c | d))]: from d, left reaches c (adjacent), not a.
  let st = bsp.initial(S);
  for (const [id, after] of [["a", null], ["b", "a"], ["c", "b"], ["d", "c"]] as const) {
    st = bsp.insert(st, id, after, input(leaves(st)));
  }
  const r = bsp.solve(st, input(["a", "b", "c", "d"])).slots;
  table(r, [
    ["a", "right", "b"], ["b", "down", "c"], ["c", "up", "b"], ["d", "up", "b"],
    ["d", "left", "c"], ["c", "left", "a"], ["c", "right", "d"], ["d", "right", null], ["a", "left", null],
  ]);
});

test("ranking: overlap beats proximity, distance beats overlap amount, order breaks ties", () => {
  const cur = rect(0, 0, 100, 100);
  table(new Map([["cur", cur], ["near", rect(110, 300, 100, 100)], ["far", rect(400, 0, 100, 100)]]),
    [["cur", "right", "far"]]);
  table(new Map([["cur", cur], ["wide", rect(300, 0, 100, 100)], ["close", rect(110, 90, 100, 100)]]),
    [["cur", "right", "close"]]);
  table(new Map([["cur", cur], ["p", rect(110, 0, 50, 100)], ["q", rect(110, 0, 50, 100)]]), [["cur", "right", "p"]]);
  table(new Map([["cur", cur], ["q", rect(110, 0, 50, 100)], ["p", rect(110, 0, 50, 100)]]), [["cur", "right", "q"]]);
  // Touching tiles (no gap) count as beyond; an unknown origin has no neighbour.
  table(new Map([["cur", cur], ["t", rect(100, 0, 100, 100)]]), [["cur", "right", "t"], ["t", "left", "cur"], ["x", "left", null]]);
});

test("fallback for irregular rectangles reaches past the facing edge, never beside it", () => {
  // A max-size frame centred in the left column: nothing lies fully above it, b reaches
  // above its top edge with its centre higher, so up selects b.
  const centred = new Map([["a", rect(232, 340, 500, 400)], ["b", rect(964, 8, 948, 528)], ["c", rect(964, 544, 948, 528)]]);
  table(centred, [["a", "up", "b"], ["a", "down", "c"], ["a", "right", "b"], ["a", "left", null]]);
  // Overlapping (stale) rectangles: one reaching above the current frame qualifies; one
  // beside it with the same top edge does not.
  table(new Map([["cur", rect(0, 100, 1000, 900)], ["over", rect(200, -200, 600, 600)]]), [["cur", "up", "over"]]);
  const side = new Map([["cur", rect(0, 100, 1000, 900)], ["side", rect(900, 100, 500, 300)]]);
  table(side, [["side", "up", null], ["cur", "up", null], ["side", "down", "cur"]]);
});

test("randomized BSP tilings: results lie in the direction's half-plane; null only at the edge", () => {
  const dirs: Direction[] = ["left", "right", "up", "down"];
  const beyond = (dir: Direction, cur: Rect, c: Rect) =>
    dir === "left" ? c.x + c.width <= cur.x : dir === "right" ? c.x >= cur.x + cur.width
      : dir === "up" ? c.y + c.height <= cur.y : c.y >= cur.y + cur.height;
  const overlaps = (dir: Direction, cur: Rect, c: Rect) => dir === "left" || dir === "right"
    ? Math.min(cur.y + cur.height, c.y + c.height) > Math.max(cur.y, c.y)
    : Math.min(cur.x + cur.width, c.x + c.width) > Math.max(cur.x, c.x);
  const rnd = prng(23);
  let picks = 0, edges = 0;
  for (let iter = 0; iter < 500; ++iter) {
    const n = 2 + Math.floor(rnd() * 9);
    const area = rect(Math.floor(rnd() * 2000) - 1000, Math.floor(rnd() * 1000) - 500, 800 + Math.floor(rnd() * 3000), 600 + Math.floor(rnd() * 1500));
    const s = settings({ bsp: { ...S.bsp, axis: (["alternate", "longest", "horizontal", "vertical"] as const)[iter % 4] } });
    let st = bsp.initial(s);
    for (let i = 0; i < n; ++i) {
      const ls = leaves(st);
      st = bsp.insert(st, `w${i}`, ls.length ? ls[Math.floor(rnd() * ls.length)] : null, input(ls, { settings: s, area }));
    }
    const rects = bsp.solve(st, input(leaves(st), { settings: s, area })).slots;
    for (const [from, cur] of rects) {
      for (const dir of dirs) {
        const got = neighbour(from, dir, rects);
        const pool = [...rects].filter(([id, c]) => id !== from && beyond(dir, cur, c));
        if (got === null) {
          assert.equal(pool.length, 0, `${from} ${dir}: null although ${pool.map(([id]) => id)} lie beyond`);
          ++edges;
          continue;
        }
        ++picks;
        const c = rects.get(got)!;
        assert.ok(beyond(dir, cur, c), `${from} ${dir} picked ${got} ${JSON.stringify(c)} outside the half-plane of ${JSON.stringify(cur)}`);
        if (pool.some(([, p]) => overlaps(dir, cur, p))) assert.ok(overlaps(dir, cur, c), `${from} ${dir}: overlap preferred`);
      }
    }
  }
  assert.ok(picks > 1000 && edges > 1000, `${picks} picks, ${edges} edge cases`);
});

test("focusWrap: continues from the far end of the same row or column, never diagonally", () => {
  // m | s1 / s2: wrap right from a stack window returns to the master; wrap left from the
  // master reaches the stack (s1 and s2 tie: stable order); wrap up/down cycles the stack
  // column; the full-height master has no row/column partner above or below.
  const three = masterStack.solve(masterStack.initial(S), input(["m", "s1", "s2"])).slots;
  wrapTable(three, [
    ["s1", "right", "m"], ["s2", "right", "m"], ["m", "left", "s1"], ["s2", "down", "s1"], ["s1", "up", "s2"],
    ["m", "up", null], ["m", "down", null],
    // Away from an edge the ordinary neighbour wins (wrap only applies at the edge).
    ["m", "right", "s1"], ["s2", "up", "s1"], ["s2", "left", "m"],
  ]);
  // m | s1 / s2 / s3: the column cycles both ways.
  const four = masterStack.solve(masterStack.initial(S), input(["m", "s1", "s2", "s3"])).slots;
  wrapTable(four, [["s3", "down", "s1"], ["s1", "up", "s3"], ["s3", "right", "m"], ["m", "up", null]]);
  // A 3x1 row: right from the last wraps to the first, left from the first to the last.
  const row = new Map([["a", rect(0, 0, 100, 100)], ["b", rect(110, 0, 100, 100)], ["c", rect(220, 0, 100, 100)]]);
  wrapTable(row, [["c", "right", "a"], ["a", "left", "c"], ["b", "right", "c"], ["a", "up", null], ["b", "down", null]]);
  // Irregular: [a | (b / (c | d))]. Wrap right from d reaches a (it overlaps d's rows); wrap
  // down from d reaches b, the top of d's column; wrap left from a reaches the overlapping right edge member.
  let st = bsp.initial(S);
  for (const [id, after] of [["a", null], ["b", "a"], ["c", "b"], ["d", "c"]] as const) {
    st = bsp.insert(st, id, after, input(leaves(st)));
  }
  const r = bsp.solve(st, input(["a", "b", "c", "d"])).slots;
  wrapTable(r, [["d", "right", "a"], ["b", "right", "a"], ["d", "down", "b"], ["c", "down", "b"], ["b", "up", "c"]]);
  // A lone window and an unknown origin have nothing to wrap to.
  wrapTable(new Map([["x", rect(0, 0, 10, 10)]]), [["x", "right", null], ["y", "left", null]]);
});

test("focusWrap: ties at the far end break by overlap, then stable order", () => {
  const rects = new Map([["cur", rect(400, 0, 100, 100)], ["p", rect(0, 0, 100, 50)], ["q", rect(0, 50, 100, 50)],
    ["far", rect(0, 300, 100, 100)]]);
  wrapTable(rects, [["cur", "right", "p"]]);
  const swapped = new Map([["cur", rect(400, 0, 100, 100)], ["q", rect(0, 50, 100, 50)], ["p", rect(0, 0, 100, 50)]]);
  wrapTable(swapped, [["cur", "right", "q"]]);
});

test("cross-output order follows topology, not enumeration order", () => {
  const o = (id: string, x: number, y: number) => ({ id, geometry: rect(x, y, 1280, 800) });
  // Enumerated right, left, middle: topology is left, middle, right.
  const outs = [o("R", 2560, 0), o("L", 0, 0), o("M", 1280, 0)];
  assert.deepEqual(outputOrder(outs).map((x) => x.id), ["L", "M", "R"]);
  const rows: Array<[string | null, 1 | -1, string]> = [
    ["L", 1, "M"], ["M", 1, "R"], ["R", 1, "L"], ["L", -1, "R"], ["M", -1, "L"], ["R", -1, "M"],
    [null, 1, "L"], ["gone", -1, "R"],
  ];
  for (const [from, step, want] of rows) assert.equal(adjacentOutput(outs, from, step)?.id, want, `${from} ${step}`);
  // A vertical stack orders top to bottom; a negative origin sorts first; equal origins by id.
  assert.deepEqual(outputOrder([o("low", 0, 800), o("top", 0, 0)]).map((x) => x.id), ["top", "low"]);
  assert.deepEqual(outputOrder([o("main", 0, 0), o("left", -1920, 0)]).map((x) => x.id), ["left", "main"]);
  assert.deepEqual(outputOrder([o("b", 0, 0), o("a", 0, 0)]).map((x) => x.id), ["a", "b"]);
  assert.equal(adjacentOutput([o("only", 0, 0)], "only", 1), null);
  assert.equal(adjacentOutput([], null, 1), null);
});
