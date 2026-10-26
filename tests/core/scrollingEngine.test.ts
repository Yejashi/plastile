// Scrolling layout replay tests (experimental, docs/design/SCROLLING.md §6) with the mock
// compositor. Oracles are the mock's committed frames and write log: a write is position-only
// when its size equals the frame it replaced, and no configure is then in flight.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect, rectNear, type Rect } from "../../src/core/geometry.ts";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import type { ContextSettings } from "../../src/core/types.ts";
import { MockHost, meta } from "./mockHost.ts";

const SCROLL: ContextSettings = { ...DEFAULT_SETTINGS, layout: "scrolling" };
const KEY = { output: "O1", desktop: "D1", activity: "default" };

function overlap(a: Rect, b: Rect): boolean {
  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0;
}

function inside(outer: Rect, r: Rect, tol = 0.5): boolean {
  return r.x >= outer.x - tol && r.y >= outer.y - tol && r.x + r.width <= outer.x + outer.width + tol &&
    r.y + r.height <= outer.y + outer.height + tol;
}

/** Open windows one by one as KWin does: mapped, then activated. */
function setup(ids: string[], settings: ContextSettings = SCROLL, configure?: (h: MockHost) => void) {
  const h = new MockHost();
  configure?.(h);
  const e = h.start({ settingsFor: () => settings });
  for (const id of ids) {
    h.open(id);
    h.activate(id);
    h.drain();
  }
  return { h, e };
}

function parkedIds(h: MockHost, ids: string[]): string[] {
  return ids.filter((id) => h.outs.every((o) => !overlap(h.windows.get(id)!.frame, o.geometry)));
}

/** Every window lies inside its output's work area (the exit-path oracle). */
function assertAllInside(h: MockHost, ids: string[], label: string) {
  for (const id of ids) {
    const w = h.windows.get(id)!;
    const area = h.workArea(w.membership.output!, w.membership.desktops[0])!;
    assert.ok(inside(area, w.frame), `${label}: ${id} at ${JSON.stringify(w.frame)} is outside ${JSON.stringify(area)}`);
  }
}

test("scrolling: opening windows activates each; the active column is visible, others parked off every output", () => {
  const ids = ["a", "b", "c", "d"];
  const { h, e } = setup(ids);
  assert.deepEqual(e.check(), []);
  const active = h.windows.get("d")!.frame;
  assert.ok(inside(rect(0, 0, 1280, 800), active), "the newest (active) window is visible");
  assert.deepEqual(parkedIds(h, ids), ["a", "b"]);
  for (const id of ["a", "b"]) assert.equal(e.explain(id)!.parked, true);
  for (const id of ids) assert.equal(h.windows.get(id)!.configures.length, 0, "every client committed");
});

test("adoption: the window active before Plastile started is in a visible column", () => {
  const h = new MockHost();
  const snaps = ["a", "b", "c", "d"].map((id) => h.snapshot(h.make(id)));
  h.active = "d";
  h.start({ settingsFor: () => SCROLL }, snaps);
  h.drain();
  assert.ok(inside(rect(0, 0, 1280, 800), h.windows.get("d")!.frame));
  assert.deepEqual(parkedIds(h, ["a", "b", "c", "d"]), ["a", "b"]);
});

test("focus commands produce position-only writes and no client resizes", () => {
  const ids = ["a", "b", "c", "d"];
  const { h, e } = setup(ids);
  const before = h.writes.length;
  const sizes = new Map(ids.map((id) => [id, { ...h.windows.get(id)!.frame }]));
  for (const cmd of ["left", "left", "left", "right", "right", "right"]) {
    const r = e.execute("plastile.focus." + cmd);
    assert.equal(r.status, "accepted", cmd);
    h.drain();
    const vis = ids.filter((id) => inside(rect(0, 0, 1280, 800), h.windows.get(id)!.frame));
    assert.ok(vis.includes(h.active!), `focused ${h.active} is visible after focus ${cmd}`);
  }
  for (const w of h.writes.slice(before)) {
    const s = sizes.get(w.id)!;
    assert.equal(w.target.width, s.width, `${w.id}: width unchanged`);
    assert.equal(w.target.height, s.height, `${w.id}: height unchanged`);
  }
  for (const id of ids) assert.equal(h.windows.get(id)!.configures.length, 0, `${id}: no configure sent`);
  assert.ok(h.writes.length > before, "scrolling wrote positions");
});

test("focus to a visible column scrolls nothing and writes nothing (lazy)", () => {
  const { h, e } = setup(["a", "b", "c"]);
  // c active, b and c visible.
  const writes = h.writes.length, solves = e.counters.solves;
  assert.equal(e.execute("plastile.focus.left").status, "accepted");
  h.drain();
  assert.equal(h.active, "b");
  assert.equal(h.writes.length, writes);
  assert.equal(e.counters.solves, solves);
});

test("rapid left/right/left reversals converge to the strip for the final focus", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const { h, e } = setup(ids);
  for (const cmd of ["left", "right", "left", "left", "right", "left", "left", "left"]) e.execute("plastile.focus." + cmd);
  h.drain();
  h.advance(1000);
  assert.equal(h.active, "a");
  // Final frames equal a fresh engine's for the same focus.
  const g = setup(ids);
  for (let i = 0; i < 4; ++i) g.e.execute("plastile.focus.left");
  g.h.drain();
  assert.equal(g.h.active, "a");
  for (const id of ids) assert.deepEqual(h.windows.get(id)!.frame, g.h.windows.get(id)!.frame, id);
  assert.equal(e.outstandingCount(), 0);
});

test("activation of a parked window (Alt+Tab, an application) scrolls it into view in the next flush", () => {
  const ids = ["a", "b", "c", "d"];
  const { h } = setup(ids);
  assert.ok(parkedIds(h, ids).includes("a"));
  h.activate("a");
  h.drain();
  assert.ok(inside(rect(0, 0, 1280, 800), h.windows.get("a")!.frame));
  assert.ok(!parkedIds(h, ids).includes("a"));
});

test("an activated transient scrolls its parent's column into view; the dialog floats", () => {
  const ids = ["a", "b", "c", "d"];
  const { h, e } = setup(ids);
  const dlg = h.open("dlg", { meta: meta("a-dialog", { kind: "dialog", transient: true, transientFor: "a" }), frame: rect(300, 300, 300, 200) });
  h.activate(dlg.id);
  h.drain();
  assert.equal(e.modeOf("dlg"), "floating");
  assert.ok(inside(rect(0, 0, 1280, 800), h.windows.get("a")!.frame), "parent column visible");
});

test("consume, expel, width-cycle, center and swap are accepted and keep the model valid", () => {
  const ids = ["a", "b", "c"];
  const { h, e } = setup(ids);
  assert.equal(e.execute("plastile.scroll.consume").status, "accepted"); // c joins b's column
  h.drain();
  const b = h.windows.get("b")!.frame, c = h.windows.get("c")!.frame;
  assert.equal(b.x, c.x, "same column");
  assert.ok(c.y > b.y);
  assert.equal(e.execute("plastile.scroll.expel").status, "accepted");
  h.drain();
  assert.notEqual(h.windows.get("c")!.frame.x, h.windows.get("b")!.frame.x);
  const w0 = h.windows.get("c")!.frame.width;
  assert.equal(e.execute("plastile.scroll.width-cycle").status, "accepted");
  h.drain();
  assert.ok(h.windows.get("c")!.frame.width > w0, "half -> two thirds");
  assert.equal(e.execute("plastile.swap.left").status, "accepted");
  h.drain();
  assert.ok(h.windows.get("c")!.frame.x < h.windows.get("b")!.frame.x || parkedIds(h, ids).includes("b"));
  assert.equal(e.execute("plastile.resize.shrink").status, "accepted");
  assert.notEqual(e.execute("plastile.scroll.center").status, "rejected");
  h.drain();
  assert.deepEqual(e.check(), []);
  assert.ok(inside(rect(0, 0, 1280, 800), h.windows.get(h.active!)!.frame));
});

test("a parked column left of the view closing, minimized or restored does not move the columns on screen", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const { h, e } = setup(ids);
  e.execute("plastile.focus.left");
  e.execute("plastile.focus.left");
  e.execute("plastile.focus.right");
  h.drain();
  const shown = () => ids.filter((id) => h.windows.get(id)!.alive && !h.windows.get(id)!.states.minimized
    && inside(rect(0, 0, 1280, 800), h.windows.get(id)!.frame)).map((id) => `${id}@${h.windows.get(id)!.frame.x}`);
  assert.equal(h.active, "d");
  assert.deepEqual(shown(), ["c@8", "d@644"]);
  const writesTo = (from: number, id: string) => h.writes.slice(from).filter((w) => w.id === id).length;
  const w0 = h.writes.length;
  h.setStates("b", { minimized: true });
  h.drain();
  assert.deepEqual(shown(), ["c@8", "d@644"], "b minimized");
  h.setStates("b", { minimized: false });
  h.drain();
  assert.deepEqual(shown(), ["c@8", "d@644"], "b restored");
  h.close("a");
  h.drain();
  h.advance(1000);
  assert.deepEqual(shown(), ["c@8", "d@644"], "a closed");
  assert.equal(h.active, "d");
  assert.equal(writesTo(w0, "c") + writesTo(w0, "d"), 0, "no write to a window on screen");
  // Closing a column on screen still closes the gap: d takes c's place.
  h.close("c");
  h.drain();
  assert.deepEqual(shown(), ["d@8", "e@644"]);
  assert.deepEqual(e.check(), []);
});

test("swap and consume next to a column whose only window is minimized act on the visible neighbour", () => {
  const ids = ["a", "b", "c"];
  {
    const { h, e } = setup(ids);
    h.activate("a");
    h.drain();
    h.setStates("b", { minimized: true });
    h.drain();
    const c0 = h.windows.get("c")!.frame;
    assert.equal(e.execute("plastile.swap.right").status, "accepted");
    h.drain();
    const a = h.windows.get("a")!.frame, c = h.windows.get("c")!.frame;
    assert.ok(c.x < a.x, `the first press moves a right of c: a ${JSON.stringify(a)} c ${JSON.stringify(c)}`);
    assert.notDeepEqual(c, c0);
  }
  {
    const { h, e } = setup(ids);
    h.setStates("b", { minimized: true });
    h.drain();
    h.activate("c");
    h.drain();
    assert.equal(e.execute("plastile.scroll.consume").status, "accepted");
    h.drain();
    const a = h.windows.get("a")!.frame, c = h.windows.get("c")!.frame;
    assert.equal(a.x, c.x, "c joined a's column, the visible one");
    // With its column-mate a minimized, c is alone as shown: expel has nothing to do.
    h.setStates("a", { minimized: true });
    h.drain();
    assert.equal(e.execute("plastile.scroll.expel").status, "noop");
  }
});

test("grow, shrink and width-cycle on a column held wide by a minimum: only changes that show are accepted", () => {
  const min900 = { minFrame: { width: 900, height: 1 }, maxFrame: { width: Infinity, height: Infinity }, fixed: false };
  const h = new MockHost();
  const e = h.start({ settingsFor: () => SCROLL });
  h.open("a", { constraints: min900 });
  h.activate("a");
  h.open("b");
  h.activate("b");
  h.drain();
  h.activate("a");
  h.drain();
  assert.equal(h.windows.get("a")!.frame.width, 900);
  const writes = h.writes.length;
  const r = e.execute("plastile.resize.shrink");
  assert.equal(r.status, "noop");
  assert.equal(r.reason, "width clamped by minimum size");
  assert.equal(h.writes.length, writes);
  assert.equal(e.execute("plastile.resize.grow").status, "accepted");
  h.drain();
  assert.ok(h.windows.get("a")!.frame.width > 900, "the first grow shows");
  assert.equal(e.execute("plastile.scroll.width-cycle").status, "accepted");
  h.drain();
  assert.equal(h.windows.get("a")!.frame.width, 1264, "the next preset wider than shown: full width");
});

test("focus left/right: no wrap by default; with focusWrap the strip wraps to its other end; up/down never wrap", () => {
  const ids = ["a", "b", "c", "d"];
  {
    const { h, e } = setup(ids);
    assert.equal(h.active, "d");
    assert.equal(e.execute("plastile.focus.right").status, "noop");
    assert.equal(h.active, "d");
  }
  const { h, e } = setup(ids, { ...SCROLL, focusWrap: true });
  assert.equal(e.execute("plastile.focus.right").status, "accepted");
  assert.equal(h.active, "a");
  h.drain();
  assert.ok(inside(rect(0, 0, 1280, 800), h.windows.get("a")!.frame), "the first column scrolled into view");
  assert.equal(e.execute("plastile.focus.left").status, "accepted");
  assert.equal(h.active, "d", "left from the first column wraps to the last");
  h.drain();
  for (const dir of ["up", "down"]) assert.equal(e.execute("plastile.focus." + dir).status, "noop", dir);
});

test("scroll commands outside a scrolling context are no-ops", () => {
  const h = new MockHost();
  const e = h.start();
  h.open("a"); h.activate("a"); h.drain();
  assert.equal(e.execute("plastile.scroll.width-cycle").status, "noop");
});

test("layout.next from scrolling enters the ordinary cycle; scrolling is never reached by the cycle", () => {
  const { h, e } = setup(["a", "b", "c"]);
  assert.equal(e.execute("plastile.layout.next").status, "accepted");
  assert.equal(e.contextSummary()[0].layout, "master-stack");
  for (let i = 0; i < 4; ++i) { e.execute("plastile.layout.next"); assert.notEqual(e.contextSummary()[0].layout, "scrolling"); }
  assert.equal(e.execute("plastile.layout.scrolling").status, "accepted");
  assert.equal(e.contextSummary()[0].layout, "scrolling");
  h.drain();
});

// ------------------------------------------------------------- exit paths

const EXITS: Array<[string, (h: MockHost, e: ReturnType<MockHost["start"]>) => void]> = [
  ["suspend", (_h, e) => { e.execute("plastile.runtime.toggle-suspend"); }],
  ["layout switch to bsp", (_h, e) => { e.execute("plastile.layout.bsp"); }],
  ["layout switch to floating", (_h, e) => { e.execute("plastile.layout.floating"); }],
  ["layout switch to monocle", (_h, e) => { e.execute("plastile.layout.monocle"); }],
  ["context disabled by configuration", (_h, e) => { e.configure({ settingsFor: () => ({ ...SCROLL, enabled: false }) }); }],
  ["configured layout changed", (_h, e) => { e.configure({ settingsFor: () => ({ ...SCROLL, layout: "master-stack" }) }); }],
  ["stop", (_h, e) => { e.stop(); }],
];

for (const [name, exit] of EXITS) {
  test(`nothing stays parked after ${name}`, () => {
    const ids = ["a", "b", "c", "d"];
    const { h, e } = setup(ids);
    assert.ok(parkedIds(h, ids).length >= 2);
    exit(h, e);
    h.drain();
    h.advance(1000);
    assertAllInside(h, ids, name);
    assert.deepEqual(parkedIds(h, ids), []);
  });
}

for (const [name, exit] of EXITS) {
  test(`nothing stays parked after ${name}, also a column parked while its resize is still in flight`, () => {
    const ids = ["a", "b", "c"];
    const h = new MockHost();
    const e = h.start({ settingsFor: () => SCROLL });
    for (const id of ids) {
      h.open(id, id === "a" ? { delay: 200 } : {});
      h.activate(id);
      h.advance(300);
    }
    h.activate("a");
    h.advance(300);
    assert.equal(e.execute("plastile.scroll.width-cycle").status, "accepted");
    h.advance(20);
    assert.equal(e.execute("plastile.focus.right").status, "accepted");
    h.drain();
    const a = h.windows.get("a")!;
    assert.equal(e.explain("a")!.parked, true);
    assert.ok(inside(rect(0, 0, 1280, 800), a.frame), "its committed frame is still visible: the parking configure is in flight");
    exit(h, e);
    h.drain();
    h.advance(1000);
    assertAllInside(h, ids, name);
  });
}

const TO_FLOATING: Array<[string, (e: ReturnType<MockHost["start"]>) => void]> = [
  ["by command", (e) => { e.execute("plastile.layout.floating"); }],
  ["by configuration", (e) => { e.configure({ settingsFor: () => ({ ...SCROLL, layout: "floating" }) }); }],
];

for (const [how, toFloating] of TO_FLOATING) {
  for (const exit of ["none", "suspend", "stop"]) {
    test(`a parked column whose float restore waits for its parking configure: floating ${how}, then ${exit}`, () => {
      // A float restore waiting for an in-flight configure (E04) of a parked window keeps it
      // parked until written, so the sweep and every exit still bring it inside (SCROLLING §5.1).
      const F = rect(300, 200, 500, 400);
      const h = new MockHost();
      const e = h.start({ settingsFor: () => SCROLL });
      for (const id of ["a", "b", "c"]) { h.open(id); h.activate(id); h.advance(300); }
      h.activate("a");
      h.advance(300);
      e.execute("plastile.window.toggle-float");
      h.drain();
      h.userSetFrame("a", F); // its float rectangle
      e.execute("plastile.window.toggle-float");
      h.drain();
      h.activate("a");
      h.advance(1000);
      h.windows.get("a")!.delay = 200;
      assert.equal(e.execute("plastile.scroll.width-cycle").status, "accepted");
      h.advance(20);
      assert.equal(e.execute("plastile.focus.left").status, "accepted");
      h.drain();
      assert.equal(e.execute("plastile.focus.left").status, "accepted");
      h.drain();
      const a = h.windows.get("a")!;
      assert.equal(e.explain("a")!.parked, true);
      assert.ok(inside(rect(0, 0, 1280, 800), a.frame) && a.configures.length > 0, "the parking configure is in flight");
      toFloating(e);
      h.drain();
      if (exit === "suspend") e.execute("plastile.runtime.toggle-suspend");
      if (exit === "stop") e.stop();
      h.drain();
      h.advance(2000);
      assertAllInside(h, ["a", "b", "c"], `${how}, ${exit}`);
      if (exit === "none") assert.ok(rectNear(a.frame, F), `at its float rectangle: ${JSON.stringify(a.frame)}`);
    });
  }
}

test("reconcile unparks, then re-parks what its strip still hides", () => {
  const ids = ["a", "b", "c", "d"];
  const { h, e } = setup(ids);
  const before = parkedIds(h, ids);
  let unparkedDuring = false;
  const orig = h.applyFrame.bind(h);
  h.applyFrame = (id, gen, t) => {
    if (before.includes(id) && inside(rect(0, 0, 1280, 800), t)) unparkedDuring = true;
    return orig(id, gen, t);
  };
  e.reconcile(ids.map((id) => h.snapshot(h.windows.get(id)!)));
  h.drain();
  assert.ok(unparkedDuring, "parked windows were brought back first");
  assert.deepEqual(parkedIds(h, ids), before, "and parked again by the solve");
  assert.deepEqual(e.check(), []);
});

test("resume after suspend parks again", () => {
  const ids = ["a", "b", "c", "d"];
  const { h, e } = setup(ids);
  const before = parkedIds(h, ids);
  e.execute("plastile.runtime.toggle-suspend");
  h.drain();
  assert.deepEqual(parkedIds(h, ids), []);
  e.execute("plastile.runtime.toggle-suspend");
  h.drain();
  assert.deepEqual(parkedIds(h, ids), before);
});

test("a parked window floated by a rule change is unparked into the work area", () => {
  const ids = ["a", "b", "c", "d"];
  const { h, e } = setup(ids);
  e.configure({ rulesFor: (m) => (m.appId === "a" ? { mode: "floating", ruleIds: ["r"] } : null), changes: { rules: true, settings: false } });
  h.drain();
  assert.equal(e.modeOf("a"), "floating");
  assertAllInside(h, ["a"], "floated");
});

// --------------------------------------------------------- outputs/topology

function twoOutputs(h: MockHost) {
  h.outs = [{ id: "O1", name: "O1", geometry: rect(0, 0, 1280, 800), scale: 1 },
            { id: "O2", name: "O2", geometry: rect(1280, 0, 1280, 800), scale: 1 }];
  h.visible.set("O2", "D1");
}

test("two outputs: parked windows intersect neither output", () => {
  const ids = ["a", "b", "c", "d"];
  const { h } = setup(ids, SCROLL, twoOutputs);
  const parked = parkedIds(h, ids);
  assert.deepEqual(parked, ["a", "b"]);
});

test("KWin reassigning a parked window's output does not move it to another context", () => {
  const ids = ["a", "b", "c", "d"];
  const { h, e } = setup(ids, SCROLL, twoOutputs);
  // KWin pulled "a" partly onto O2 after a topology change and reports O2 as its output.
  const w = h.windows.get("a")!;
  h.userSetFrame("a", rect(1200, 100, w.frame.width, w.frame.height));
  w.membership = { ...w.membership, output: "O2" };
  e.membershipChanged("a", w.gen, w.membership);
  assert.ok(e.membersOf(KEY).includes("a"), "still in its strip");
  assert.deepEqual(e.membersOf({ output: "O2", desktop: "D1", activity: "default" }), []);
  // The topology flush parks it again.
  e.topologyChanged();
  h.drain();
  assert.ok(parkedIds(h, ids).includes("a"));
  assert.deepEqual(e.check(), []);
});

test("an output reassignment while the strip's output is gone does re-key the window", () => {
  const ids = ["a", "b", "c", "d"];
  const { h, e } = setup(ids, SCROLL, twoOutputs);
  h.outs = [h.outs[1]];
  const w = h.windows.get("a")!;
  w.membership = { ...w.membership, output: "O2" };
  e.membershipChanged("a", w.gen, w.membership);
  assert.ok(e.membersOf({ output: "O2", desktop: "D1", activity: "default" }).includes("a"));
});

test("after a topology change the strip is re-solved and parked for the new outputs", () => {
  const ids = ["a", "b", "c", "d"];
  const { h, e } = setup(ids, SCROLL, twoOutputs);
  // A third output appears above O1: parking above O1 would now be on it, so columns go below.
  h.outs = [...h.outs, { id: "O3", name: "O3", geometry: rect(0, -800, 1280, 800), scale: 1 }];
  e.topologyChanged();
  h.drain();
  for (const id of parkedIds(h, ids)) assert.ok(h.windows.get(id)!.frame.y >= 800, `${id} parked below O1`);
  assert.deepEqual(parkedIds(h, ids), ["a", "b"]);
});

test("ordinary layouts are unaffected: no parking, no virtual navigation, focus does not solve", () => {
  const h = new MockHost();
  const e = h.start();
  for (const id of ["a", "b", "c"]) { h.open(id); h.activate(id); h.drain(); }
  const solves = e.counters.solves, writes = h.writes.length;
  e.execute("plastile.focus.left");
  h.drain();
  assert.equal(e.counters.solves, solves);
  assert.equal(h.writes.length, writes);
  for (const id of ["a", "b", "c"]) assert.equal(e.explain(id)!.parked, false);
});

test("KWin 6.8 confinement: repeated position-only pull-backs of a parked window are re-parked, never diverged", () => {
  const ids = ["a", "b", "c", "d"];
  const { h, e } = setup(ids);
  assert.deepEqual(parkedIds(h, ids), ["a", "b"]);
  const parkedAt = { ...h.windows.get("a")!.frame };
  const c0 = { ...e.counters };
  // KWin 6.8 runs confineInteractiveMove on every configure-acknowledging commit: an activation
  // change, a scale or decoration change pulls the parked window back into the work area.
  for (let i = 0; i < 5; ++i) {
    h.userSetFrame("a", rect(0, 0, parkedAt.width, parkedAt.height));
    h.drain();
    assert.ok(parkedIds(h, ids).includes("a"), `pull-back ${i + 1}: re-parked (${JSON.stringify(h.windows.get("a")!.frame)})`);
    e.activeChanged("d"); // the legitimate trigger restores the allowance
  }
  assert.equal(e.counters.diverged - c0.diverged, 0, "never diverged");
  assert.equal(e.counters.corrections - c0.corrections, 0, "the correction budget is untouched");
  assert.equal(e.counters.reparks - c0.reparks, 5);
  assert.deepEqual(e.check(), []);
});

test("re-parking is bounded: another tool pulling a parked window back without any trigger ends in divergence", () => {
  const ids = ["a", "b", "c", "d"];
  const { h, e } = setup(ids);
  const parkedAt = { ...h.windows.get("a")!.frame };
  const c0 = { ...e.counters };
  let n = 0;
  for (; n < 100 && e.counters.diverged === c0.diverged; ++n) {
    h.userSetFrame("a", rect(0, 0, parkedAt.width, parkedAt.height)); // no activation or topology event
    h.drain();
  }
  assert.ok(e.counters.diverged > c0.diverged, "diverges eventually instead of fighting forever");
  assert.ok(n <= 8 + 2 + 2, `bounded: ${n} pull-backs`);
  assert.ok(e.counters.reparks - c0.reparks <= 8, "the re-park allowance is capped");
});
