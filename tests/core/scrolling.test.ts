// Scrolling layout (experimental, docs/design/SCROLLING.md): pure strip, projection and parking.
// Oracles are independent of the solver: geometric properties of the returned rectangles and
// KWin's output-assignment rule re-implemented here from workspace.cpp:1199 (v6.7.5).

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect, type Rect } from "../../src/core/geometry.ts";
import { neighbour } from "../../src/core/navigation.ts";
import type { ContextSettings, ScrollingSettings, WindowId } from "../../src/core/types.ts";
import type { SolveInput } from "../../src/core/layouts/layout.ts";
import {
  centre, columnNeighbour, consume, cycleWidth, expel, moveColumn, parkingSpot, resizeColumn, scrolling, stripOrder,
  swapWindows, type ScrollState,
} from "../../src/core/layouts/scrolling.ts";
import { input as baseInput, minC, prng, settings } from "./helpers.ts";

const O1 = rect(0, 0, 1280, 800);
const AREA = O1; // no panels: the work area is the output

function sset(patch: Partial<ScrollingSettings> = {}, rest: Partial<ContextSettings> = {}): ContextSettings {
  const s = settings(rest);
  return { ...s, scrolling: { ...s.scrolling, ...patch } };
}

function sin(ids: WindowId[], opts: { area?: Rect; settings?: ContextSettings; focused?: WindowId | null;
  outputs?: Rect[]; output?: Rect; constraints?: SolveInput["constraints"] } = {}): SolveInput {
  const outputs = opts.outputs ?? [O1];
  return { ...baseInput(ids, { area: opts.area ?? AREA, settings: opts.settings ?? sset(), focused: opts.focused ?? null,
    constraints: opts.constraints as never }), outputs, output: opts.output ?? outputs[0] };
}

/** Columns from a list of window groups, in order, via the layout's own insert (each after the previous). */
function build(groups: WindowId[][], s: ContextSettings = sset()): ScrollState {
  let st = scrolling.initial(s);
  let prev: WindowId | null = null;
  for (const g of groups) {
    st = scrolling.insert(st, g[0], prev, sin([g[0]], { settings: s }));
    prev = g[0];
    for (const id of g.slice(1)) {
      st = scrolling.insert(st, id, prev, sin([id], { settings: s }));
      st = consume(st, id, sin(g, { settings: s })).state;
    }
  }
  return st;
}

/** Input where a, b and c take part. */
const ABC = sin(["a", "b", "c"]);

/** Independent re-implementation of KWin's outputAt (closest pixel, first output wins ties). */
function kwinOutputAt(px: number, py: number, outputs: readonly Rect[]): Rect {
  let best = outputs[0], bestD = Infinity;
  for (const o of outputs) {
    const cx = Math.min(Math.max(px, o.x), o.x + o.width - 1), cy = Math.min(Math.max(py, o.y), o.y + o.height - 1);
    const d = (cx - px) ** 2 + (cy - py) ** 2;
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function overlap(a: Rect, b: Rect): boolean {
  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0;
}

function inside(outer: Rect, r: Rect, tol = 0.5): boolean {
  return r.x >= outer.x - tol && r.y >= outer.y - tol && r.x + r.width <= outer.x + outer.width + tol &&
    r.y + r.height <= outer.y + outer.height + tol;
}

/**
 * Oracle over one solve: visible slots lie inside the area and do not overlap; parked slots
 * intersect no output and KWin would assign them to the strip's own output; every slot has
 * its virtual size (parking is position-only); the focused window is visible.
 */
function assertStrip(st: ScrollState, inp: SolveInput, label = "") {
  const res = scrolling.solve(st, inp);
  const virtual = res.virtual!;
  const parked = new Set(res.parked ?? []);
  const outputs = inp.outputs!;
  const visible: Array<[WindowId, Rect]> = [];
  for (const [id, r] of res.slots) {
    const v = virtual.get(id)!;
    assert.ok(v, `${label}${id} has a virtual rectangle`);
    assert.equal(r.width, v.width, `${label}${id} keeps its width`);
    assert.equal(r.height, v.height, `${label}${id} keeps its height`);
    if (parked.has(id)) {
      for (const o of outputs) assert.ok(!overlap(r, o), `${label}${id} parked at ${JSON.stringify(r)} overlaps output ${JSON.stringify(o)}`);
      const at = kwinOutputAt(r.x + r.width / 2, r.y + r.height / 2, outputs);
      assert.deepEqual(at, inp.output, `${label}${id} parked centre maps to another output: ${JSON.stringify(r)} own ${JSON.stringify(inp.output)}`);
    } else {
      assert.ok(inside(inp.area, r) || id === inp.focused, `${label}${id} visible but outside the area ${JSON.stringify(r)}`);
      visible.push([id, r]);
    }
  }
  for (let i = 0; i < visible.length; ++i) for (let j = i + 1; j < visible.length; ++j) {
    assert.ok(!overlap(visible[i][1], visible[j][1]), `${label}${visible[i][0]} overlaps ${visible[j][0]}`);
  }
  if (inp.focused !== null && res.slots.has(inp.focused)) assert.ok(!parked.has(inp.focused), `${label}focused window is parked`);
  return res;
}

// ----------------------------------------------------------------- model

test("insertion goes after the focused column, or at the end when nothing is focused", () => {
  let st = build([["a"], ["b"], ["c"]]);
  st = scrolling.insert(st, "d", "a", sin(["d"]));
  assert.deepEqual(st.columns.map((c) => c.windows), [["a"], ["d"], ["b"], ["c"]]);
  st = scrolling.insert(st, "e", null, sin(["e"]));
  assert.deepEqual(st.columns.map((c) => c.windows), [["a"], ["d"], ["b"], ["c"], ["e"]]);
  assert.equal(new Set(st.columns.map((c) => c.id)).size, 5, "column ids are unique");
  assert.equal(st.columns[0].width, 0.5, "new columns take the default width");
});

test("removal drops a window and collapses an empty column; ids stay stable", () => {
  let st = build([["a", "b"], ["c"], ["d"]]);
  const ids = st.columns.map((c) => c.id);
  st = scrolling.remove(st, "c");
  assert.deepEqual(st.columns.map((c) => c.windows), [["a", "b"], ["d"]]);
  assert.deepEqual(st.columns.map((c) => c.id), [ids[0], ids[2]]);
  st = scrolling.remove(st, "a");
  assert.deepEqual(st.columns.map((c) => c.windows), [["b"], ["d"]]);
  assert.equal(st.columns[0].id, ids[0], "a column keeps its id while it has windows");
});

test("rebuild keeps known structure, drops non-members and appends new members", () => {
  const st = build([["a", "b"], ["c"]]);
  const r = scrolling.rebuild(st, ["b", "c", "x"], sin(["b", "c", "x"]));
  assert.deepEqual(r.columns.map((c) => c.windows), [["b"], ["c"], ["x"]]);
});

test("the viewport is clamped after the strip shrinks", () => {
  let st = build([["a"], ["b"], ["c"], ["d"]]);
  st = scrolling.reveal!(st, "d", sin(["a", "b", "c", "d"]));
  assert.ok(st.viewport > 0);
  st = scrolling.remove(scrolling.remove(st, "d"), "c");
  const res = scrolling.solve(st, sin(["a", "b"]));
  assert.equal(res.parked!.length, 0, "two half columns fit: nothing parked after the strip shrank");
  assert.equal(res.slots.get("a")!.x, 8);
});

test("the view is held by a column: columns leaving or joining left of it move nothing on screen", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const st = scrolling.reveal!(build([["a"], ["b"], ["c"], ["d"], ["e"]]), "d", sin(ids, { focused: "d" }));
  const xs = (s: ScrollState, part: string[], focused = "d") => {
    const res = scrolling.solve(s, sin(part, { focused }));
    return part.filter((id) => !res.parked!.includes(id)).map((id) => `${id}@${res.slots.get(id)!.x}`);
  };
  assert.deepEqual(xs(st, ids), ["c@8", "d@644"]);
  assert.deepEqual(xs(scrolling.remove(st, "a"), ["b", "c", "d", "e"]), ["c@8", "d@644"], "a closed");
  assert.deepEqual(xs(st, ["a", "c", "d", "e"]), ["c@8", "d@644"], "b suspended");
  assert.deepEqual(xs(st, ["c", "d", "e"]), ["c@8", "d@644"], "a and b suspended");
  // The column holding the view closes or is suspended: the next column takes its place.
  assert.deepEqual(xs(scrolling.remove(st, "c"), ["a", "b", "d", "e"]), ["d@8", "e@644"]);
  assert.deepEqual(xs(st, ["a", "b", "d", "e"]), ["d@8", "e@644"]);
  // Rearranging columns keeps the view where it is in the strip: c moved right shows d, then c.
  const moved = moveColumn(st, "c", "right", sin(ids, { focused: "c" })).state;
  assert.deepEqual(xs(moved, ids, "c"), ["c@644", "d@8"]);
});

// ------------------------------------------------------------ projection

test("projection: half columns, the third is parked; visible columns tile the area exactly", () => {
  const st = build([["a"], ["b"], ["c"]]);
  const res = assertStrip(st, sin(["a", "b", "c"], { focused: "a" }));
  assert.deepEqual(res.slots.get("a"), rect(8, 8, 628, 784));
  assert.deepEqual(res.slots.get("b"), rect(644, 8, 628, 784));
  assert.deepEqual(res.parked, ["c"]);
  // Coverage oracle: two visible columns plus one gap span the inner width exactly.
  const a = res.slots.get("a")!, b = res.slots.get("b")!;
  assert.equal(b.x - (a.x + a.width), 8);
  assert.equal(b.x + b.width, 1280 - 8);
  // The virtual rectangle continues the strip to the right.
  assert.deepEqual(res.virtual!.get("c"), rect(1280, 8, 628, 784));
});

test("thirds and two-thirds columns cover the inner width without crossing the edge", () => {
  for (const width of [1279, 1280, 1281, 1706.6666666666667]) {
    const s = sset({ defaultWidth: 1 / 3 });
    const st = build([["a"], ["b"], ["c"]], s);
    const area = rect(0, 0, width, 800);
    const res = assertStrip(st, sin(["a", "b", "c"], { settings: s, focused: "a", area, outputs: [area] }));
    assert.equal(res.parked!.length, 0, `three thirds fit in ${width}`);
    const st2 = cycleWidth(build([["a"], ["b"]], s), "a", s.scrolling.widthPresets, sin(["a", "b"], { settings: s, area, outputs: [area] })).state; // a: 1/2
    const st3 = cycleWidth(st2, "a", s.scrolling.widthPresets, sin(["a", "b"], { settings: s, area, outputs: [area] })).state; // a: 2/3, b: 1/3
    const r3 = assertStrip(st3, sin(["a", "b"], { settings: s, focused: "a", area, outputs: [area] }));
    assert.equal(r3.parked!.length, 0, `2/3 + 1/3 fit in ${width}`);
  }
});

test("column windows split the height by weight with gaps; minimum heights hold", () => {
  const st = build([["a", "b"], ["c"]]);
  const res = assertStrip(st, sin(["a", "b", "c"], { focused: "a", constraints: new Map([["b", minC(0, 500)]]) }));
  const a = res.slots.get("a")!, b = res.slots.get("b")!;
  assert.equal(a.x, b.x);
  assert.equal(b.y - (a.y + a.height), 8);
  assert.ok(b.height >= 500);
  assert.equal(a.y, 8);
  assert.equal(b.y + b.height, 792);
});

test("a column is never narrower than a member's minimum; a focused column wider than the area starts at its left edge", () => {
  const st = build([["a"], ["b"]]);
  const c = new Map([["b", minC(1500, 0)]]);
  const res = assertStrip(st, sin(["a", "b"], { focused: "b", constraints: c }));
  assert.deepEqual(res.slots.get("b"), rect(8, 8, 1500, 784));
  assert.deepEqual(res.parked, ["a"]);
});

test("a column whose minimum heights cannot fit overflows its newest window (float-new)", () => {
  const st = build([["a", "b"]]);
  const res = scrolling.solve(st, sin(["a", "b"], { constraints: new Map([["a", minC(0, 500)], ["b", minC(0, 500)]]) }));
  assert.deepEqual(res.overflow, ["b"]);
  assert.ok(res.slots.has("a") && !res.slots.has("b"));
});

// ---------------------------------------------------------------- parking

const ARRANGEMENTS: Record<string, Rect[]> = {
  "side by side": [rect(0, 0, 1280, 800), rect(1280, 0, 1280, 800)],
  "side by side, offset": [rect(0, 200, 1280, 800), rect(1280, 0, 1920, 1080)],
  stacked: [rect(0, 0, 1280, 800), rect(0, 800, 1280, 800)],
  "negative origin": [rect(-1920, -300, 1920, 1080), rect(0, 0, 1280, 800)],
  "L-shaped": [rect(0, 0, 1280, 800), rect(1280, 0, 1280, 800), rect(0, 800, 1280, 800)],
  "three in a row": [rect(0, 0, 1280, 800), rect(1280, 0, 1280, 800), rect(2560, 0, 1280, 800)],
  "fractional scale": [rect(0, 0, 1706.6666666666667, 960), rect(1706.6666666666667, 0, 1280, 800)],
};

test("parked columns intersect no output and stay nearest to their own output (every arrangement)", () => {
  for (const [name, outs] of Object.entries(ARRANGEMENTS)) {
    for (const own of outs) {
      const st = build([["a"], ["b", "c"], ["d"], ["e"], ["f"]]);
      const ids = ["a", "b", "c", "d", "e", "f"];
      for (const focus of ids) {
        const area = rect(own.x, own.y + 30, own.width, own.height - 30); // a panel on top
        const inp = sin(ids, { area, focused: focus, outputs: outs, output: own });
        const s2 = scrolling.reveal!(st, focus, inp);
        const res = assertStrip(s2, inp, `${name} ${JSON.stringify(own)} focus ${focus}: `);
        assert.ok(res.parked!.length > 0, `${name}: something is parked`);
      }
    }
  }
});

test("parking candidates are tried above, below, left, right of the own output", () => {
  const col = rect(1300, 8, 600, 784);
  // Alone: above.
  assert.deepEqual(parkingSpot(col, O1, [O1]), { x: 680, y: -784 - 64 });
  // An output above: below.
  const above = rect(0, -800, 1280, 800);
  assert.deepEqual(parkingSpot(col, O1, [O1, above]), { x: 680, y: 800 + 64 });
  // Above and below taken: left.
  const below = rect(0, 800, 1280, 800);
  assert.deepEqual(parkingSpot(col, O1, [O1, above, below]), { x: -600 - 64, y: 8 });
  // Enclosed on all four sides: nothing qualifies.
  const left = rect(-1280, 0, 1280, 800), rightO = rect(1280, 0, 1280, 800);
  assert.equal(parkingSpot(col, O1, [O1, above, below, left, rightO]), null);
});

test("a candidate whose centre KWin would assign to a neighbour is rejected", () => {
  // A tall neighbour on the right reaching above: a parked column above O1 near the right edge
  // would be closer to the neighbour than to O1; the candidate x is clamped into O1's span, so
  // the centre stays over O1 horizontally and O1 is strictly nearest.
  const outs = [rect(0, 0, 1280, 800), rect(1280, -2000, 1280, 3000)];
  const spot = parkingSpot(rect(2000, 8, 1270, 784), outs[0], outs)!;
  const at = kwinOutputAt(spot.x + 635, spot.y + 392, outs);
  assert.deepEqual(at, outs[0]);
});

test("an enclosed output: the column is clamped to the nearer area edge, with an explanation", () => {
  const own = rect(0, 0, 1280, 800);
  const outs = [own, rect(0, -800, 1280, 800), rect(0, 800, 1280, 800), rect(-1280, 0, 1280, 800), rect(1280, 0, 1280, 800)];
  const st = build([["a"], ["b"], ["c"]]);
  const res = scrolling.solve(st, sin(["a", "b", "c"], { focused: "a", outputs: outs, output: own }));
  assert.equal(res.parked!.length, 0);
  assert.deepEqual(res.slots.get("c"), rect(1280 - 8 - 628, 8, 628, 784));
  assert.ok(res.notes.some((n) => n.includes("clamped to the area edge")));
});

// -------------------------------------------------------- focus and scrolling

test("lazy: focusing a parked column scrolls just enough; a visible one does not scroll", () => {
  const ids = ["a", "b", "c", "d"];
  let st = build([["a"], ["b"], ["c"], ["d"]]);
  st = scrolling.reveal!(st, "a", sin(ids));
  assert.equal(st.viewport, 0);
  assert.equal(scrolling.reveal!(st, "b", sin(ids)), st, "b is visible: same state");
  st = scrolling.reveal!(st, "c", sin(ids));
  assert.equal(st.viewport, 636, "c becomes the rightmost visible column");
  let res = assertStrip(st, sin(ids, { focused: "c" }));
  assert.deepEqual(res.parked!.slice().sort(), ["a", "d"]);
  assert.equal(res.slots.get("c")!.x + res.slots.get("c")!.width, 1272);
  st = scrolling.reveal!(st, "a", sin(ids));
  assert.equal(st.viewport, 0, "back to the start");
  res = assertStrip(st, sin(ids, { focused: "a" }));
  assert.deepEqual(res.parked!.slice().sort(), ["c", "d"]);
});

test("centered: the focused column is centred whenever it fits", () => {
  const s = sset({ policy: "centered", defaultWidth: 1 / 3 });
  const ids = ["a", "b", "c", "d", "e"];
  let st = build([["a"], ["b"], ["c"], ["d"], ["e"]], s);
  st = scrolling.reveal!(st, "c", sin(ids, { settings: s }));
  const res = assertStrip(st, sin(ids, { settings: s, focused: "c" }));
  const c = res.slots.get("c")!;
  assert.ok(Math.abs(c.x + c.width / 2 - 640) <= 1, `centred: ${JSON.stringify(c)}`);
  // The first column centred too (centred policy does not clamp to the strip's start).
  st = scrolling.reveal!(st, "a", sin(ids, { settings: s }));
  const a = assertStrip(st, sin(ids, { settings: s, focused: "a" })).slots.get("a")!;
  assert.ok(Math.abs(a.x + a.width / 2 - 640) <= 1);
});

test("center command: centres in lazy mode as far as the strip's ends allow", () => {
  const s = sset({ defaultWidth: 1 / 3 });
  const ids = ["a", "b", "c", "d", "e"];
  const st = build([["a"], ["b"], ["c"], ["d"], ["e"]], s);
  const o = centre(st, "c", sin(ids, { settings: s }));
  assert.ok(o.changed);
  const c = assertStrip(o.state, sin(ids, { settings: s, focused: "c" })).slots.get("c")!;
  assert.ok(Math.abs(c.x + c.width / 2 - 640) <= 1);
  assert.equal(centre(st, "a", sin(ids, { settings: s })).changed, false, "the first column cannot move right of the start");
});

// --------------------------------------------------------------- commands

test("consume and expel move a window between columns", () => {
  let st = build([["a"], ["b"], ["c"]]);
  let o = consume(st, "b", ABC);
  assert.ok(o.changed);
  st = o.state;
  assert.deepEqual(st.columns.map((c) => c.windows), [["a", "b"], ["c"]]);
  assert.equal(consume(st, "a", ABC).changed, false, "no column on the left");
  o = expel(st, "a", ABC);
  assert.deepEqual(o.state.columns.map((c) => c.windows), [["b"], ["a"], ["c"]]);
  assert.equal(expel(build([["a"]]), "a", sin(["a"])).changed, false, "already alone");
});

test("width-cycle steps through the presets and wraps; resize changes the fraction within bounds", () => {
  const presets = [1 / 3, 1 / 2, 2 / 3, 1];
  let st = build([["a"]]);
  const seen: number[] = [];
  for (let i = 0; i < 5; ++i) { st = cycleWidth(st, "a", presets, sin(["a"])).state; seen.push(st.columns[0].width); }
  assert.deepEqual(seen, [2 / 3, 1, 1 / 3, 1 / 2, 2 / 3]);
  st = resizeColumn(st, "a", 0.5, sin(["a"])).state;
  assert.equal(st.columns[0].width, 1);
  assert.equal(resizeColumn(st, "a", 0.05, sin(["a"])).changed, false, "width at limit");
});

test("width commands start from the width a minimum holds the column at; nothing hidden changes", () => {
  // a is shown 900 px wide (its minimum) although its stored fraction is 1/2 (628 px).
  const st = build([["a"], ["b"]]);
  const inp = sin(["a", "b"], { focused: "a", constraints: new Map([["a", minC(900, 1)]]) });
  const width = (s: ScrollState) => scrolling.solve(s, inp).virtual!.get("a")!.width;
  assert.equal(width(st), 900);
  const shrink = resizeColumn(st, "a", -0.05, inp);
  assert.equal(shrink.changed, false);
  assert.equal(shrink.reason, "width clamped by minimum size");
  const grow = resizeColumn(st, "a", 0.05, inp);
  assert.ok(grow.changed);
  assert.ok(width(grow.state) > 900, "the first grow widens the column on screen");
  // A 100 px drag of the right edge makes the column 100 px wider, so the release does not snap back.
  const drag = scrolling.command(st, { kind: "resize-boundary", id: "a", edge: "right", delta: 100 }, inp);
  assert.ok(drag.changed);
  assert.equal(width(drag.state), 1000);
  // Width cycle: the next preset wider than the shown 900 px (0.71) is full width, then back to the minimum.
  const presets = [1 / 3, 1 / 2, 2 / 3, 1];
  const c1 = cycleWidth(st, "a", presets, inp);
  assert.equal(c1.state.columns[0].width, 1);
  assert.equal(width(c1.state), 1264);
  const c2 = cycleWidth(c1.state, "a", presets, inp);
  assert.equal(width(c2.state), 900);
  // A minimum wider than the area: no width change shows, so every width command is a no-op.
  const huge = sin(["a", "b"], { focused: "a", constraints: new Map([["a", minC(1400, 1)]]) });
  assert.equal(resizeColumn(st, "a", 0.05, huge).changed, false);
  assert.equal(cycleWidth(st, "a", presets, huge).changed, false);
});

test("swap moves the focused column; swapping windows keeps column structure", () => {
  const st = build([["a", "b"], ["c"]]);
  const m = moveColumn(st, "c", "left", ABC);
  assert.deepEqual(m.state.columns.map((c) => c.windows), [["c"], ["a", "b"]]);
  assert.equal(moveColumn(st, "c", "right", ABC).changed, false);
  const s2 = swapWindows(st, "b", "c");
  assert.deepEqual(s2.columns.map((c) => c.windows), [["a", "c"], ["b"]]);
  assert.equal(columnNeighbour(st, "a", "down", ["a", "b", "c"]), "b");
  assert.equal(columnNeighbour(st, "a", "up", ["a", "b", "c"]), null);
  assert.deepEqual(stripOrder(m.state, ["a", "b", "c"]), ["c", "a", "b"]);
});

test("column commands skip columns that show nothing (only suspended members)", () => {
  const st = build([["a"], ["b"], ["c"]]);
  const AC = sin(["a", "c"]); // b is minimized: its column keeps its slot but is not laid out
  const cols = (s: ScrollState) => s.columns.map((c) => c.windows);
  assert.deepEqual(cols(moveColumn(st, "a", "right", AC).state), [["b"], ["c"], ["a"]], "a moves past c on the first press");
  assert.deepEqual(cols(moveColumn(st, "c", "left", AC).state), [["c"], ["a"], ["b"]]);
  assert.equal(moveColumn(st, "c", "right", AC).changed, false);
  assert.equal(moveColumn(build([["a"], ["b"]]), "a", "right", sin(["a"])).changed, false, "nothing shown on the right");
  assert.deepEqual(cols(consume(st, "c", AC).state), [["a", "c"], ["b"]], "c joins the shown column on its left");
  assert.equal(consume(build([["b"], ["c"]]), "c", sin(["c"])).changed, false, "nothing shown on the left");
  const shared = build([["a"], ["b", "c"]]);
  assert.equal(expel(shared, "c", AC).changed, false, "alone as shown: its column-mate is suspended");
  assert.ok(expel(shared, "c", ABC).changed);
  // Adjacent shown columns still simply swap.
  assert.deepEqual(cols(moveColumn(st, "b", "right", ABC).state), [["a"], ["c"], ["b"]]);
});

test("virtual navigation: right means the next column even when it is parked", () => {
  const ids = ["a", "b", "c", "d"];
  const st = build([["a"], ["b", "x"], ["c"], ["d"]]);
  const all = [...ids, "x"];
  const res = scrolling.solve(st, sin(all, { focused: "a" }));
  assert.ok(res.parked!.includes("c"));
  const v = res.virtual!;
  assert.equal(neighbour("b", "right", v), "c");
  assert.equal(neighbour("c", "right", v), "d");
  assert.equal(neighbour("d", "right", v), null, "no wrap");
  assert.equal(neighbour("c", "left", v) === "b" || neighbour("c", "left", v) === "x", true);
});

test("resize-boundary: dragging a column edge changes its width; a row edge changes weights", () => {
  const st = build([["a", "b"], ["c"]]);
  const inp = sin(["a", "b", "c"], { focused: "a" });
  const w = scrolling.command(st, { kind: "resize-boundary", id: "a", edge: "right", delta: 127.2 }, inp);
  assert.ok(w.changed);
  assert.ok(Math.abs(w.state.columns[0].width - 0.6) < 1e-9);
  const h = scrolling.command(st, { kind: "resize-boundary", id: "a", edge: "bottom", delta: 100 }, inp);
  assert.ok(h.changed);
  const res = scrolling.solve(h.state, inp);
  assert.ok(res.slots.get("a")!.height > res.slots.get("b")!.height);
});

// ---------------------------------------------------------------- property

test("property: random strips, outputs, focus and policies satisfy the strip oracle", () => {
  const rnd = prng(36);
  const arrangements = Object.values(ARRANGEMENTS);
  for (let iter = 0; iter < 300; ++iter) {
    const outs = arrangements[Math.floor(rnd() * arrangements.length)];
    const own = outs[Math.floor(rnd() * outs.length)];
    const s = sset({ policy: rnd() < 0.5 ? "lazy" : "centered", defaultWidth: [1 / 3, 1 / 2, 2 / 3, 1][Math.floor(rnd() * 4)] },
      { gaps: { inner: Math.floor(rnd() * 20), outer: { top: 4, right: 4, bottom: 4, left: 4 } } });
    const n = 1 + Math.floor(rnd() * 9);
    const ids = Array.from({ length: n }, (_, i) => `w${i}`);
    let st = scrolling.initial(s);
    for (const id of ids) {
      const after = st.columns.length && rnd() < 0.5 ? st.columns[Math.floor(rnd() * st.columns.length)].windows[0] : null;
      st = scrolling.insert(st, id, after, sin([id], { settings: s }));
      if (rnd() < 0.3) st = consume(st, id, sin(ids, { settings: s })).state;
      if (rnd() < 0.3) st = cycleWidth(st, id, s.scrolling.widthPresets, sin(ids, { settings: s })).state;
    }
    const constraints = new Map<WindowId, ReturnType<typeof minC>>();
    for (const id of ids) if (rnd() < 0.2) constraints.set(id, minC(Math.floor(rnd() * 900), Math.floor(rnd() * 200)));
    const area = rect(own.x, own.y + 24, own.width, own.height - 24);
    // A focus sequence: each reveal then solve satisfies the oracle.
    for (let k = 0; k < 4; ++k) {
      const focus = ids[Math.floor(rnd() * n)];
      const inp = sin(ids, { settings: s, area, focused: focus, outputs: outs, output: own, constraints });
      st = scrolling.reveal!(st, focus, inp);
      const res = assertStrip(st, inp, `iter ${iter} focus ${focus}: `);
      // Virtual rectangles keep strip order left to right with exactly one gap between columns.
      const order = stripOrder(st, ids).filter((id) => res.virtual!.has(id));
      let prevX: number | null = null, prevRight: number | null = null;
      for (const id of order) {
        const v = res.virtual!.get(id)!;
        if (v.x === prevX) continue; // the same column
        if (prevRight !== null) assert.ok(Math.abs(v.x - prevRight - s.gaps.inner) < 1e-6, `iter ${iter}: column spacing`);
        prevX = v.x;
        prevRight = v.x + v.width;
      }
    }
  }
});
