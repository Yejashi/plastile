import { test } from "node:test";
import assert from "node:assert/strict";
import { inset, rect, type Rect } from "../../src/core/geometry.ts";
import { bsp, checkBsp, leaves, reinsert, type BspNode, type BspBranch, type BspState } from "../../src/core/layouts/bsp.ts";
import type { BspSettings, Constraints, ContextSettings, WindowId } from "../../src/core/types.ts";
import type { LayoutCommand, SolveInput } from "../../src/core/layouts/layout.ts";
import { assertTiling, input, minC, prng, settings } from "./helpers.ts";

const S = settings();

function bspSettings(patch: Partial<BspSettings>, rest: Partial<ContextSettings> = {}): ContextSettings {
  return settings({ ...rest, bsp: { ...S.bsp, ...patch } });
}

/** Insert ids in order, each anchored after the previous one (as if it had focus). */
function grow(ids: WindowId[], s: ContextSettings = S, area?: Rect): BspState {
  let st = bsp.initial(s);
  let prev: WindowId | null = null;
  for (const id of ids) {
    st = bsp.insert(st, id, prev, input(leaves(st), { settings: s, area }));
    prev = id;
  }
  return st;
}

function br(n: BspNode | null): BspBranch {
  assert.ok(n && n.kind === "branch", "expected a branch");
  return n;
}

function cmd(st: BspState, c: LayoutCommand, inp: SolveInput) {
  return bsp.command(st, c, inp);
}

/**
 * Oracle (independent of the solver): every slot edge either lies on the inner area
 * boundary or faces another slot exactly `gap` away (span overlap allowing for a gap
 * junction opposite a tiny slot), and no two slots that share a span are closer
 * than `gap`. Holds for any guillotine tiling with shared cuts; catches lost pixels
 * and wrong gaps.
 */
function assertGaps(slots: Map<WindowId, Rect>, inner: Rect, gap: number) {
  const list = [...slots.entries()];
  const overlaps = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 0;
  for (const [id, r] of list) {
    const ySpan = (s: Rect) => overlaps(r.y - gap, r.y + r.height + gap, s.y, s.y + s.height);
    const xSpan = (s: Rect) => overlaps(r.x - gap, r.x + r.width + gap, s.x, s.x + s.width);
    const checks: Array<[string, boolean, (s: Rect) => boolean]> = [
      ["right", r.x + r.width === inner.x + inner.width, (s) => s.x === r.x + r.width + gap && ySpan(s)],
      ["left", r.x === inner.x, (s) => s.x + s.width + gap === r.x && ySpan(s)],
      ["bottom", r.y + r.height === inner.y + inner.height, (s) => s.y === r.y + r.height + gap && xSpan(s)],
      ["top", r.y === inner.y, (s) => s.y + s.height + gap === r.y && xSpan(s)],
    ];
    for (const [edge, onBoundary, faces] of checks) {
      if (onBoundary) continue;
      assert.ok(list.some(([o, s]) => o !== id && faces(s)), `${id} ${edge} edge neither on boundary nor ${gap} px from a neighbour`);
    }
  }
  for (let i = 0; i < list.length; ++i)
    for (let j = i + 1; j < list.length; ++j) {
      const [ia, a] = list[i], [ib, b] = list[j];
      const dx = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
      const dy = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
      if (dy < 0) assert.ok(dx >= gap, `${ia} and ${ib} are ${dx} px apart horizontally`);
      if (dx < 0) assert.ok(dy >= gap, `${ia} and ${ib} are ${dy} px apart vertically`);
    }
}

function assertMinima(slots: Map<WindowId, Rect>, constraints: Map<WindowId, Constraints>) {
  for (const [id, s] of slots) {
    const c = constraints.get(id);
    if (!c) continue;
    assert.ok(s.width >= c.minFrame.width, `${id} width ${s.width} below minimum ${c.minFrame.width}`);
    assert.ok(s.height >= c.minFrame.height, `${id} height ${s.height} below minimum ${c.minFrame.height}`);
  }
}

// H n3 [ n1 a | V n5 [ n2 b / n4 c ] ]
const ABC = grow(["a", "b", "c"]);

test("insert builds a persistent tree with stable ids; duplicates are ignored", () => {
  assert.equal(bsp.initial(S).root, null);
  const one = grow(["a"]);
  assert.deepEqual(one, { root: { kind: "leaf", id: "n1", window: "a" }, nextId: 2 });
  const root = br(ABC.root);
  assert.equal(root.id, "n3");
  assert.equal(root.axis, "horizontal");
  assert.equal(root.ratio, 0.5);
  assert.deepEqual(root.a, { kind: "leaf", id: "n1", window: "a" });
  const right = br(root.b);
  assert.equal(right.id, "n5");
  assert.equal(right.axis, "vertical", "alternate: opposite of the parent's axis");
  assert.deepEqual([right.a.id, right.b.id], ["n2", "n4"]);
  assert.equal(ABC.nextId, 6);
  assert.deepEqual(leaves(ABC), ["a", "b", "c"]);
  assert.deepEqual(checkBsp(ABC), []);
  assert.equal(bsp.insert(ABC, "b", "a", input(["a", "b", "c"])), ABC, "duplicate insert returns the same state");
});

test("insert keeps unrelated subtrees by identity; remove collapses into the sibling", () => {
  const withD = bsp.insert(ABC, "d", "a", input(["a", "b", "c"]));
  assert.equal(br(withD.root).b, br(ABC.root).b, "right subtree untouched by inserting next to a");
  assert.equal(br(br(withD.root).a).a, br(ABC.root).a, "split leaf object is reused");
  assert.deepEqual(leaves(withD), ["a", "d", "b", "c"]);

  const noB = bsp.remove(withD, "b");
  assert.equal(br(noB.root).id, "n3");
  assert.equal(br(noB.root).a, br(withD.root).a, "left subtree untouched by removing b");
  assert.equal(br(noB.root).b, br(br(withD.root).b).b, "sibling leaf c replaces its parent, same object");
  assert.deepEqual(leaves(noB), ["a", "d", "c"]);
  assert.equal(noB.nextId, withD.nextId);
  assert.equal(bsp.remove(noB, "zzz"), noB, "absent remove is a no-op");

  let st = noB;
  for (const id of ["a", "d", "c"]) st = bsp.remove(st, id);
  assert.equal(st.root, null);
  assert.deepEqual(checkBsp(st), []);
});

test("insert target: focused anchor vs last leaf", () => {
  const focused = bsp.insert(ABC, "d", "a", input(["a", "b", "c"]));
  assert.deepEqual(leaves(focused), ["a", "d", "b", "c"]);
  const noAnchor = bsp.insert(ABC, "d", null, input(["a", "b", "c"]));
  assert.deepEqual(leaves(noAnchor), ["a", "b", "c", "d"], "no anchor: split the last DFS leaf");
  const stale = bsp.insert(ABC, "d", "gone", input(["a", "b", "c"]));
  assert.deepEqual(leaves(stale), ["a", "b", "c", "d"], "unknown anchor: split the last DFS leaf");
  const last = bspSettings({ insert: "last" });
  const lastMode = bsp.insert(ABC, "d", "a", input(["a", "b", "c"], { settings: last }));
  assert.deepEqual(leaves(lastMode), ["a", "b", "c", "d"], "insert=last ignores the anchor");
});

test("axis policies: alternate, longest, fixed", () => {
  const portrait = rect(0, 0, 1080, 1920);
  const alt = grow(["a", "b"], S, portrait);
  assert.equal(br(alt.root).axis, "horizontal", "alternate: root-level target splits horizontally");
  const longest = bspSettings({ axis: "longest" });
  assert.equal(br(grow(["a", "b"], longest, portrait).root).axis, "vertical", "portrait slot splits along height");
  assert.equal(br(grow(["a", "b"], longest).root).axis, "horizontal", "landscape slot splits along width");
  // Very wide area: a's half is still wider than tall, so longest keeps horizontal where alternate would not.
  const wide = rect(0, 0, 3000, 500);
  const wl = grow(["a", "b", "c"], longest, wide);
  assert.equal(br(br(wl.root).b).axis, "horizontal");
  assert.equal(br(br(grow(["a", "b", "c"], S, wide).root).b).axis, "vertical");
  // Alternate continues to alternate down a chain.
  const chain = grow(["a", "b", "c", "d", "e"]);
  const axes: string[] = [];
  let n: BspNode = chain.root!;
  while (n.kind === "branch") { axes.push(n.axis); n = n.b; }
  assert.deepEqual(axes, ["horizontal", "vertical", "horizontal", "vertical"]);
  for (const axis of ["horizontal", "vertical"] as const) {
    const fixed = grow(["a", "b", "c", "d"], bspSettings({ axis }));
    let m: BspNode = fixed.root!;
    while (m.kind === "branch") { assert.equal(m.axis, axis); m = m.b; }
  }
});

test("initialRatio is applied and clamped", () => {
  const st = grow(["a", "b"], bspSettings({ initialRatio: 0.3 }));
  assert.equal(br(st.root).ratio, 0.3);
  assert.equal(br(grow(["a", "b"], bspSettings({ initialRatio: 2 })).root).ratio, 0.95);
});

test("solve: exact slots with shared cuts and gaps", () => {
  const r = bsp.solve(ABC, input(["a", "b", "c"]));
  assert.deepEqual(r.slots.get("a"), rect(8, 8, 948, 1064));
  assert.deepEqual(r.slots.get("b"), rect(964, 8, 948, 528));
  assert.deepEqual(r.slots.get("c"), rect(964, 544, 948, 528));
  assert.deepEqual(r.overflow, []);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.raise, []);
  assert.deepEqual(bsp.solve(bsp.initial(S), input([])).slots.size, 0);
});

test("solve: odd sizes and negative origins tile exactly (G01/G02)", () => {
  for (const area of [rect(-1921, -37, 1919, 1079), rect(-3840, 0, 1080, 1921), rect(5, 7, 101, 77)]) {
    for (let n = 1; n <= 9; ++n) {
      const ids = Array.from({ length: n }, (_, i) => `w${i}`);
      for (const axis of ["alternate", "longest", "vertical"] as const) {
        const s = bspSettings({ axis }, area.width < 200 ? { gaps: { inner: 3, outer: { top: 1, right: 2, bottom: 3, left: 4 } } } : {});
        const st = grow(ids, s, area);
        const r = bsp.solve(st, input(ids, { area, settings: s }));
        if (r.overflow.length) continue; // tiny area with many windows: covered by the overflow tests
        assert.equal(r.slots.size, n);
        assertTiling(r.slots, area);
        assertGaps(r.slots, inset(area, s.gaps.outer), s.gaps.inner);
      }
    }
  }
});

test("single window gaps follow settings.singleWindowGaps", () => {
  const area = rect(0, 0, 1920, 1080);
  assert.deepEqual(bsp.solve(grow(["a"]), input(["a"])).slots.get("a"), rect(8, 8, 1904, 1064));
  const s = settings({ singleWindowGaps: false });
  assert.deepEqual(bsp.solve(grow(["a"], s), input(["a"], { settings: s })).slots.get("a"), area);
  // A single *participant* (others suspended) is treated the same way.
  const r = bsp.solve(grow(["a", "b"], s), input(["b"], { settings: s, members: ["a", "b"] }));
  assert.deepEqual(r.slots.get("b"), area);
});

test("suspended members are virtually collapsed without gaps; tree is untouched", () => {
  const snapshot = JSON.stringify(ABC);
  const noC = bsp.solve(ABC, input(["a", "b"], { members: ["a", "b", "c"] }));
  assert.deepEqual(noC.slots.get("a"), rect(8, 8, 948, 1064));
  assert.deepEqual(noC.slots.get("b"), rect(964, 8, 948, 1064), "b takes the whole column");
  assert.equal(noC.slots.has("c"), false);
  const noA = bsp.solve(ABC, input(["b", "c"], { members: ["a", "b", "c"] }));
  assert.deepEqual(noA.slots.get("b"), rect(8, 8, 1904, 528));
  assert.deepEqual(noA.slots.get("c"), rect(8, 544, 1904, 528));
  const onlyC = bsp.solve(ABC, input(["c"], { members: ["a", "b", "c"] }));
  assert.deepEqual(onlyC.slots.get("c"), rect(8, 8, 1904, 1064));
  assert.equal(JSON.stringify(ABC), snapshot);
  // Unknown participants are explained, not silently tiled.
  const ghost = bsp.solve(ABC, input(["a", "b", "c", "x"]));
  assert.equal(ghost.slots.has("x"), false);
  assert.ok(ghost.notes.some((n) => n.startsWith("x: not in bsp tree")));
});

test("minima aggregate bottom-up and clamp ratios with a note (L02)", () => {
  // Right column minimum width is the max of b and c: 1300.
  const constraints = new Map([["b", minC(1000, 0)], ["c", minC(1300, 0)]]);
  const r = bsp.solve(ABC, input(["a", "b", "c"], { constraints }));
  assert.deepEqual(r.overflow, []);
  assert.equal(r.slots.get("b")!.width, 1300);
  assert.equal(r.slots.get("c")!.width, 1300);
  assert.equal(r.slots.get("a")!.width, 1904 - 8 - 1300);
  assert.ok(r.notes.some((n) => n.includes("branch n3") && n.includes("clamped")), r.notes.join("; "));
  assertMinima(r.slots, constraints);
  // A vertical branch's minimum height is the sum plus the gap.
  const tall = new Map([["b", minC(0, 700)], ["c", minC(0, 300)]]);
  const t = bsp.solve(ABC, input(["a", "b", "c"], { constraints: tall }));
  assert.equal(t.slots.get("b")!.height, 700, "b pinned at its minimum");
  assert.equal(t.slots.get("c")!.height, 1064 - 8 - 700);
  assert.ok(t.notes.some((n) => n.includes("branch n5") && n.includes("clamped")));
  // A suspended window's minimum does not constrain the tree.
  const s = bsp.solve(ABC, input(["a", "b"], { constraints, members: ["a", "b", "c"] }));
  assert.equal(s.slots.get("b")!.width, 1000);
});

test("infeasible minima float the newest participant, repeatedly (G08 float-new)", () => {
  const constraints = new Map([["b", minC(0, 600)], ["c", minC(0, 600)]]);
  const r = bsp.solve(ABC, input(["a", "b", "c"], { constraints }));
  assert.deepEqual(r.overflow, ["c"]);
  assert.deepEqual(r.slots.get("b"), rect(964, 8, 948, 1064), "b fills the collapsed column");
  assert.ok(r.notes.some((n) => n.startsWith("c: does not fit") && n.includes("needs")), r.notes.join("; "));
  const huge = new Map([["a", minC(1000, 0)], ["b", minC(1000, 0)], ["c", minC(1000, 0)]]);
  const h = bsp.solve(ABC, input(["a", "b", "c"], { constraints: huge }));
  assert.deepEqual(h.overflow, ["c", "b"]);
  assert.deepEqual(h.slots.get("a"), rect(8, 8, 1904, 1064));
});

test("max-size windows are centred in their slot (G09)", () => {
  const constraints = new Map<WindowId, Constraints>([["a", { minFrame: { width: 0, height: 0 }, maxFrame: { width: 500, height: 400 }, fixed: false }]]);
  const r = bsp.solve(ABC, input(["a", "b", "c"], { constraints }));
  assert.deepEqual(r.slots.get("a"), rect(8 + 224, 8 + 332, 500, 400));
  assert.ok(r.notes.some((n) => n.startsWith("a: centred")));
});

test("ratio command grows the focused side of its parent divider", () => {
  const all = ["a", "b", "c"];
  const a = cmd(ABC, { kind: "ratio", delta: 0.05 }, input(all, { focused: "a" }));
  assert.ok(a.changed);
  assert.equal(br(a.state.root).ratio, 0.55);
  assert.equal(br(a.state.root).b, br(ABC.root).b, "unrelated subtree kept");
  const b = cmd(ABC, { kind: "ratio", delta: 0.05 }, input(all, { focused: "b" }));
  assert.equal(br(br(b.state.root).b).ratio, 0.55);
  const c = cmd(ABC, { kind: "ratio", delta: 0.05 }, input(all, { focused: "c" }));
  assert.equal(br(br(c.state.root).b).ratio, 0.45, "focused in side b: ratio decreases");
  const before = bsp.solve(ABC, input(all)).slots.get("c")!.height;
  assert.ok(bsp.solve(c.state, input(all)).slots.get("c")!.height > before);

  let st = ABC;
  let steps = 0;
  for (;;) {
    const o = cmd(st, { kind: "ratio", delta: 0.05 }, input(all, { focused: "a" }));
    if (!o.changed) { assert.equal(o.reason, "ratio at limit"); break; }
    st = o.state;
    ++steps;
  }
  assert.equal(steps, 9);
  assert.equal(br(st.root).ratio, 0.95);
  assert.equal(cmd(ABC, { kind: "ratio", delta: 0.05 }, input(all)).reason, "no focused tile");
  assert.equal(cmd(ABC, { kind: "ratio", delta: 0.05 }, input(all, { focused: "x" })).reason, "no focused tile");
  assert.equal(cmd(grow(["a"]), { kind: "ratio", delta: 0.05 }, input(["a"], { focused: "a" })).reason, "no divider");
});

test("equalize resets every ratio and reports already-equal", () => {
  const all = ["a", "b", "c"];
  assert.equal(cmd(ABC, { kind: "equalize" }, input(all)).reason, "already equal");
  const skew = cmd(cmd(ABC, { kind: "ratio", delta: 0.2 }, input(all, { focused: "a" })).state,
    { kind: "ratio", delta: 0.1 }, input(all, { focused: "c" })).state;
  const eq = cmd(skew, { kind: "equalize" }, input(all));
  assert.ok(eq.changed);
  assert.deepEqual(eq.state, ABC);
  assert.equal(cmd(eq.state, { kind: "equalize" }, input(all)).changed, false);
  assert.equal(cmd(bsp.initial(S), { kind: "equalize" }, input([])).reason, "already equal");
});

test("rotate: documented clockwise rule, inverse and 4x identity, ids preserved", () => {
  const all = ["a", "b", "c"];
  const skew = cmd(cmd(ABC, { kind: "ratio", delta: 0.17 }, input(all, { focused: "a" })).state,
    { kind: "ratio", delta: 0.33 }, input(all, { focused: "b" })).state;
  const cw = cmd(skew, { kind: "rotate", clockwise: true }, input(all));
  assert.ok(cw.changed);
  // [a | (b over c)] -> [a over (c | b)]
  const root = br(cw.state.root);
  assert.equal(root.axis, "vertical");
  assert.equal(root.id, "n3");
  assert.equal(root.ratio, br(skew.root).ratio, "unswapped branch keeps its ratio");
  assert.equal(root.a.id, "n1");
  const inner = br(root.b);
  assert.equal(inner.axis, "horizontal");
  assert.deepEqual([inner.a.id, inner.b.id], ["n4", "n2"]);
  assert.ok(Math.abs(inner.ratio - (1 - br(br(skew.root).b).ratio)) < 1e-9);
  const s = bsp.solve(cw.state, input(all)).slots;
  assert.ok(s.get("a")!.y < s.get("b")!.y && s.get("c")!.x < s.get("b")!.x, "a on top, c bottom-left, b bottom-right");

  const back = cmd(cw.state, { kind: "rotate", clockwise: false }, input(all));
  assert.deepEqual(back.state, skew, "cw then ccw is the identity");
  let four = skew;
  for (let i = 0; i < 4; ++i) four = cmd(four, { kind: "rotate", clockwise: true }, input(all)).state;
  assert.deepEqual(four, skew, "four clockwise rotations are the identity");
  let fourCcw = skew;
  for (let i = 0; i < 4; ++i) fourCcw = cmd(fourCcw, { kind: "rotate", clockwise: false }, input(all)).state;
  assert.deepEqual(fourCcw, skew);
  assert.equal(cmd(grow(["a"]), { kind: "rotate", clockwise: true }, input(["a"])).reason, "nothing to rotate");
});

test("rotate: slots rotate geometrically by 90 degrees (square area, no gaps)", () => {
  const size = 1000;
  const area = rect(0, 0, size, size);
  const s = settings({ gaps: { inner: 0, outer: { top: 0, right: 0, bottom: 0, left: 0 } } });
  const rnd = prng(7);
  for (let iter = 0; iter < 50; ++iter) {
    const n = 2 + Math.floor(rnd() * 6);
    const ids = Array.from({ length: n }, (_, i) => `w${i}`);
    let st = bsp.initial(s);
    for (const id of ids) {
      const ls = leaves(st);
      st = bsp.insert(st, id, ls.length ? ls[Math.floor(rnd() * ls.length)] : null, input(ls, { settings: s, area }));
    }
    const inp = input(ids, { settings: s, area });
    const before = bsp.solve(st, inp).slots;
    const after = bsp.solve(cmd(st, { kind: "rotate", clockwise: true }, inp).state, inp).slots;
    for (const id of ids) {
      const r = before.get(id)!, q = after.get(id)!;
      // Clockwise in screen coordinates (y down): (x, y, w, h) -> (S - y - h, x, h, w).
      const want = rect(size - r.y - r.height, r.x, r.height, r.width);
      for (const k of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(q[k] - want[k]) <= 2, `${id}.${k} ${q[k]} vs ${want[k]}`);
    }
  }
});

test("mirror flips the chosen axis; twice is the identity", () => {
  const all = ["a", "b", "c"];
  const skew = cmd(ABC, { kind: "ratio", delta: 0.13 }, input(all, { focused: "a" })).state;
  const h = cmd(skew, { kind: "mirror", axis: "horizontal" }, input(all));
  assert.ok(h.changed);
  assert.equal(br(h.state.root).a, br(skew.root).b, "vertical subtree untouched by a horizontal mirror");
  const hs = bsp.solve(h.state, input(all)).slots;
  const ss = bsp.solve(skew, input(all)).slots;
  assert.equal(hs.get("a")!.x + hs.get("a")!.width, 1912, "a moved to the right edge");
  assert.equal(hs.get("a")!.width, ss.get("a")!.width, "widths preserved");
  assert.deepEqual(cmd(h.state, { kind: "mirror", axis: "horizontal" }, input(all)).state, skew);
  const v = cmd(skew, { kind: "mirror", axis: "vertical" }, input(all));
  assert.deepEqual(leaves(v.state), ["a", "c", "b"]);
  assert.equal(br(v.state.root).a, br(skew.root).a);
  assert.deepEqual(cmd(v.state, { kind: "mirror", axis: "vertical" }, input(all)).state, skew);
  const flat = grow(["a", "b"], bspSettings({ axis: "horizontal" }));
  assert.equal(cmd(flat, { kind: "mirror", axis: "vertical" }, input(["a", "b"])).reason, "nothing to mirror");
});

test("resize-boundary moves the touching divider by pixels", () => {
  const all = ["a", "b", "c"];
  const inp = input(all);
  const base = bsp.solve(ABC, inp).slots;
  const moved = (c: LayoutCommand) => {
    const o = cmd(ABC, c, inp);
    assert.ok(o.changed, JSON.stringify(c));
    return bsp.solve(o.state, inp).slots;
  };
  const aRight = moved({ kind: "resize-boundary", id: "a", edge: "right", delta: 100 });
  assert.ok(Math.abs(aRight.get("a")!.width - base.get("a")!.width - 100) <= 1);
  const bLeft = moved({ kind: "resize-boundary", id: "b", edge: "left", delta: -100 });
  assert.ok(Math.abs(bLeft.get("b")!.width - base.get("b")!.width - 100) <= 1, "left edge moving left grows b");
  assert.ok(Math.abs(bLeft.get("c")!.width - base.get("c")!.width - 100) <= 1, "c shares b's column");
  const bBottom = moved({ kind: "resize-boundary", id: "b", edge: "bottom", delta: 50 });
  assert.ok(Math.abs(bBottom.get("b")!.height - base.get("b")!.height - 50) <= 1);
  const cTop = moved({ kind: "resize-boundary", id: "c", edge: "top", delta: -50 });
  assert.ok(Math.abs(cTop.get("c")!.height - base.get("c")!.height - 50) <= 1);
  for (const [id, edge] of [["a", "left"], ["a", "top"], ["b", "right"], ["b", "top"], ["c", "bottom"]] as const) {
    assert.equal(cmd(ABC, { kind: "resize-boundary", id, edge, delta: 10 }, inp).reason, "no divider on that edge", `${id} ${edge}`);
  }
  assert.equal(cmd(ABC, { kind: "resize-boundary", id: "x", edge: "left", delta: 10 }, inp).reason, "window not tiled here");
  const big = cmd(ABC, { kind: "resize-boundary", id: "a", edge: "right", delta: 5000 }, inp);
  assert.equal(br(big.state.root).ratio, 0.95);
  assert.equal(cmd(big.state, { kind: "resize-boundary", id: "a", edge: "right", delta: 10 }, inp).reason, "ratio at limit");
  // Collapsed branch (c suspended): b's bottom edge is the output edge, no divider.
  const sus = input(["a", "b"], { members: all });
  assert.equal(cmd(ABC, { kind: "resize-boundary", id: "b", edge: "bottom", delta: 10 }, sus).reason, "no divider on that edge");
  assert.ok(cmd(ABC, { kind: "resize-boundary", id: "b", edge: "left", delta: 10 }, sus).changed);
  // Deeper: a nested horizontal split whose divider is on the wrong side defers to the ancestor.
  const deep = bsp.insert(ABC, "d", "a", input(all)); // a's leaf becomes V[a/d]; then
  const deeper = bsp.insert(deep, "e", "d", input(["a", "d", "b", "c"])); // d becomes H[d|e]
  const inp5 = input(["a", "d", "e", "b", "c"]);
  const eRight = cmd(deeper, { kind: "resize-boundary", id: "e", edge: "right", delta: 40 }, inp5);
  assert.ok(eRight.changed, "e's right edge is the root divider");
  assert.ok(br(eRight.state.root).ratio > br(deeper.root).ratio);
  const dRight = cmd(deeper, { kind: "resize-boundary", id: "d", edge: "right", delta: 40 }, inp5);
  assert.equal(br(dRight.state.root).ratio, br(deeper.root).ratio, "d's right edge is the inner divider");
});

test("unsupported commands report a reason", () => {
  const o = cmd(ABC, { kind: "master-count", delta: 1 }, input(["a", "b", "c"]));
  assert.equal(o.changed, false);
  assert.equal(o.reason, "master-count not supported by bsp");
  assert.equal(o.state, ABC);
});

test("swap exchanges leaf contents only", () => {
  const sw = bsp.swap!(ABC, "a", "c");
  assert.deepEqual(leaves(sw), ["c", "b", "a"]);
  const root = br(sw.root);
  assert.equal(root.a.id, "n1");
  assert.equal(br(root.b).b.id, "n4");
  assert.equal(br(root.b).a, br(br(ABC.root).b).a, "b's leaf object untouched");
  assert.deepEqual(checkBsp(sw), []);
  assert.deepEqual(bsp.swap!(sw, "a", "c"), ABC);
  assert.equal(bsp.swap!(ABC, "a", "x"), ABC);
  assert.equal(bsp.swap!(ABC, "a", "a"), ABC);
  const r = bsp.solve(sw, input(["a", "b", "c"]));
  assert.deepEqual(r.slots.get("c"), rect(8, 8, 948, 1064));
});

test("reinsert moves structure and keeps the moved leaf id", () => {
  const r = reinsert(ABC, "a", "c", "right");
  // a's parent collapses into V[b/c]; c becomes H[c|a].
  assert.deepEqual(leaves(r), ["b", "c", "a"]);
  const root = br(r.root);
  assert.equal(root.id, "n5");
  const split = br(root.b);
  assert.equal(split.axis, "horizontal");
  assert.equal(split.id, "n6");
  assert.equal(split.b.id, "n1");
  assert.equal(r.nextId, 7);
  assert.deepEqual(checkBsp(r), []);
  const slots = bsp.solve(r, input(["a", "b", "c"])).slots;
  assert.ok(slots.get("a")!.x > slots.get("c")!.x && slots.get("a")!.y === slots.get("c")!.y);
  const top = reinsert(ABC, "c", "a", "top");
  assert.deepEqual(leaves(top), ["c", "a", "b"]);
  assert.equal(br(br(top.root).a).axis, "vertical");
  const left = reinsert(ABC, "b", "c", "left");
  assert.deepEqual(leaves(left), ["a", "b", "c"]);
  assert.equal(br(br(left.root).b).axis, "horizontal");
  assert.equal(reinsert(ABC, "a", "a", "left"), ABC);
  assert.equal(reinsert(ABC, "x", "a", "left"), ABC);
  assert.equal(reinsert(ABC, "a", "x", "left"), ABC);
});

test("rebuild keeps surviving structure and inserts missing members in order", () => {
  const all = ["a", "b", "c"];
  assert.equal(bsp.rebuild(ABC, all, input(all)), ABC, "same members: same state");
  const rb = bsp.rebuild(ABC, ["c", "a", "d", "e"], input(["c", "a", "d", "e"]));
  assert.deepEqual(checkBsp(rb), []);
  assert.deepEqual(leaves(rb).slice().sort(), ["a", "c", "d", "e"]);
  assert.equal(br(rb.root).id, "n3", "root survives");
  assert.deepEqual(leaves(rb), ["a", "d", "e", "c"], "d splits a (previous member), e splits d");
  const fresh = bsp.rebuild(bsp.initial(S), ["x", "y", "z"], input(["x", "y", "z"]));
  assert.deepEqual(leaves(fresh), ["x", "y", "z"]);
  assert.deepEqual(bsp.rebuild(ABC, [], input([])).root, null);
});

test("checkBsp reports invariant violations", () => {
  const l = (id: string, w: string): BspNode => ({ kind: "leaf", id, window: w });
  const bad: BspState = {
    root: { kind: "branch", id: "n2", axis: "horizontal", ratio: 1, a: l("n1", "a"), b: { kind: "branch", id: "n2", axis: "vertical", ratio: 0.5, a: l("n3", "a"), b: l("n9", "b") } },
    nextId: 5,
  };
  const errs = checkBsp(bad);
  assert.ok(errs.some((e) => e.includes("duplicate window a")));
  assert.ok(errs.some((e) => e.includes("duplicate node id n2")));
  assert.ok(errs.some((e) => e.includes("ratio 1 outside")));
  assert.ok(errs.some((e) => e.includes("n9 not below nextId")));
  assert.deepEqual(checkBsp(bsp.initial(S)), []);
});

test("solve is pure and focus never changes the state", () => {
  const st = grow(["a", "b", "c", "d", "e"]);
  const snap = JSON.stringify(st);
  const ids = leaves(st);
  const r1 = bsp.solve(st, input(ids, { focused: "a" }));
  const r2 = bsp.solve(st, input(ids, { focused: "e" }));
  const r3 = bsp.solve(st, input(ids, { focused: null }));
  assert.deepEqual([...r1.slots], [...r2.slots]);
  assert.deepEqual([...r1.slots], [...r3.slots]);
  assert.equal(JSON.stringify(st), snap);
});

test("randomized: structure and tiling invariants across seeded op sequences", () => {
  const axes: BspSettings["axis"][] = ["alternate", "longest", "horizontal", "vertical"];
  const sides = ["left", "right", "top", "bottom"] as const;
  let ops = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const rnd = prng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const s = bspSettings({ axis: axes[seed % 4], insert: seed % 3 === 0 ? "last" : "focused", initialRatio: 0.2 + rnd() * 0.6 });
    let st = bsp.initial(s);
    const members = new Set<WindowId>();
    let next = 0;
    for (let step = 0; step < 150; ++step, ++ops) {
      const area = rect(Math.floor(rnd() * 4000) - 2000, Math.floor(rnd() * 2000) - 1000,
        600 + Math.floor(rnd() * 3500), 400 + Math.floor(rnd() * 2000));
      const list = [...members];
      const inp = input(list, { area, settings: s, focused: list.length ? pick(list) : null });
      const op = rnd();
      if (op < 0.35 || list.length < 2) {
        const id = `w${next++}`;
        st = bsp.insert(st, id, list.length && rnd() < 0.8 ? pick(list) : null, inp);
        members.add(id);
      } else if (op < 0.5) {
        const id = pick(list);
        st = bsp.remove(st, id);
        members.delete(id);
      } else if (op < 0.6) {
        st = bsp.swap!(st, pick(list), pick(list));
      } else if (op < 0.68) {
        st = cmd(st, { kind: "rotate", clockwise: rnd() < 0.5 }, inp).state;
      } else if (op < 0.76) {
        st = cmd(st, { kind: "mirror", axis: rnd() < 0.5 ? "horizontal" : "vertical" }, inp).state;
      } else if (op < 0.86) {
        st = reinsert(st, pick(list), pick(list), pick(sides));
      } else if (op < 0.93) {
        st = cmd(st, { kind: "ratio", delta: (rnd() - 0.5) * 0.4 }, inp).state;
      } else {
        st = cmd(st, { kind: "resize-boundary", id: pick(list), edge: pick(sides), delta: Math.floor((rnd() - 0.5) * 600) }, inp).state;
      }
      assert.deepEqual(checkBsp(st), [], `seed ${seed} step ${step}`);
      const ls = leaves(st);
      assert.equal(ls.length, members.size);
      assert.deepEqual(ls.slice().sort(), [...members].sort());

      // Solve with a random suspended subset and random minima.
      const now = [...members];
      const ids = now.filter(() => rnd() < 0.85);
      const constraints = new Map(ids.filter(() => rnd() < 0.3)
        .map((id) => [id, minC(Math.floor(rnd() * 900), Math.floor(rnd() * 600))] as const));
      const snap = JSON.stringify(st);
      const r = bsp.solve(st, input(ids, { area, settings: s, constraints, members: now }));
      assert.equal(JSON.stringify(st), snap, "solve does not mutate state");
      assert.equal(r.slots.size + r.overflow.length, ids.length);
      assertTiling(r.slots, area);
      assertMinima(r.slots, constraints);
      assertGaps(r.slots, inset(area, s.gaps.outer), s.gaps.inner);
    }
  }
  assert.ok(ops >= 500);
});

test("5000-leaf degenerate tree: iterative traversals, no stack overflow (L05)", (t) => {
  const n = 5000;
  // Linked list down the b side; ratios give every leaf an equal share.
  let node: BspNode = { kind: "leaf", id: `n${2 * n - 1}`, window: `w${n - 1}` };
  for (let i = n - 2; i >= 0; --i) {
    node = { kind: "branch", id: `n${n + i}`, axis: "horizontal", ratio: 1 / (n - i), a: { kind: "leaf", id: `n${i}`, window: `w${i}` }, b: node };
  }
  const st: BspState = { root: node, nextId: 2 * n };
  const ids = leaves(st);
  assert.equal(ids.length, n);
  assert.deepEqual(checkBsp(st), []);
  const s = settings({ gaps: { inner: 0, outer: { top: 0, right: 0, bottom: 0, left: 0 } } });
  const area = rect(0, 0, 20000, 1000);
  const t0 = performance.now();
  const r = bsp.solve(st, input(ids, { area, settings: s }));
  const solveMs = performance.now() - t0;
  assert.equal(r.slots.size, n);
  assert.deepEqual(r.overflow, []);
  for (const [, slot] of r.slots) assert.equal(slot.width, 4);
  assertTiling(r.slots, area);

  // Alternating-axis deep chain with only a few participants: virtual collapse at depth.
  const t1 = performance.now();
  const chain = bsp.rebuild(bsp.initial(S), ids, input([], { settings: S }));
  const rebuildMs = performance.now() - t1;
  assert.deepEqual(checkBsp(chain), []);
  const few = [ids[0], ids[2500], ids[n - 1]];
  const t2 = performance.now();
  const rf = bsp.solve(chain, input(few, { members: ids }));
  const fewMs = performance.now() - t2;
  assert.equal(rf.slots.size, 3);
  assertTiling(rf.slots, rect(0, 0, 1920, 1080));
  assertGaps(rf.slots, rect(8, 8, 1904, 1064), 8);

  const t3 = performance.now();
  const rot = cmd(chain, { kind: "rotate", clockwise: true }, input(few, { members: ids })).state;
  const mir = cmd(rot, { kind: "mirror", axis: "horizontal" }, input(few, { members: ids })).state;
  const rm = bsp.remove(mir, ids[n - 1]);
  const sw = bsp.swap!(rm, ids[0], ids[n - 2]);
  const opsMs = performance.now() - t3;
  assert.deepEqual(checkBsp(sw), []);
  assert.equal(leaves(sw).length, n - 1);
  t.diagnostic(`5000-leaf solve (all tiled): ${solveMs.toFixed(1)} ms; 3-participant solve: ${fewMs.toFixed(1)} ms; ` +
    `rebuild 5000: ${rebuildMs.toFixed(0)} ms; rotate+mirror+remove+swap: ${opsMs.toFixed(1)} ms`);
  assert.ok(solveMs < 2000 && fewMs < 2000, "solve stays well under interactive budgets for a pathological tree");
});
