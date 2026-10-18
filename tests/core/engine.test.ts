// Engine replay tests with the mock compositor. IDs refer to docs/validation/TEST_MATRIX.md.
// Oracles are the mock compositor's committed frames and write log, not engine claims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect, rectNear } from "../../src/core/geometry.ts";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import { MockHost, meta } from "./mockHost.ts";
import { assertTiling } from "./helpers.ts";

const AREA = rect(0, 0, 1280, 800);

function setup(ids: string[] = ["a", "b", "c"], patch: Record<string, object> = {}) {
  const h = new MockHost();
  const e = h.start();
  for (const id of ids) h.open(id, patch[id] ?? {});
  h.drain();
  return { h, e };
}

function tiledFrames(h: MockHost, ids: string[]) {
  return new Map(ids.map((id) => [id, h.windows.get(id)!.frame] as const));
}

test("adoption: existing windows tile with one solve per visible context", () => {
  const h = new MockHost();
  const snaps = ["a", "b", "c"].map((id) => h.snapshot(h.make(id)));
  const e = h.start({}, snaps);
  assert.equal(e.counters.solves, 1);
  assertTiling(tiledFrames(h, ["a", "b", "c"]), AREA);
  assert.deepEqual(e.check(), []);
});

test("C01: duplicate discovery creates one record and one member", () => {
  const { h, e } = setup(["a"]);
  e.windowAdded(h.snapshot(h.windows.get("a")!));
  h.drain();
  assert.deepEqual(e.membersOf({ output: "O1", desktop: "D1", activity: "default" }), ["a"]);
  assert.deepEqual(e.check(), []);
});

test("C02/C03: events after removal or for an old generation are rejected", () => {
  const { h, e } = setup(["a", "b"]);
  const old = h.windows.get("a")!;
  h.close("a");
  h.drain();
  const writes = h.writes.length;
  e.frameObserved("a", old.gen, rect(0, 0, 10, 10));
  e.statesChanged("a", old.gen, { ...old.states, minimized: true });
  e.windowAdded(h.snapshot(old)); // resurrection attempt with the dead generation
  h.drain();
  assert.equal(h.writes.length, writes);
  assert.ok(e.counters.staleEvents >= 3);
  assert.deepEqual(e.membersOf({ output: "O1", desktop: "D1", activity: "default" }), ["b"]);
});

test("C04: create then remove before the flush performs no writes", () => {
  const h = new MockHost();
  const e = h.start();
  h.open("x");
  h.close("x");
  h.drain();
  assert.equal(h.writes.length, 0);
  assert.equal(e.counters.solves, 0);
  assert.deepEqual(e.check(), []);
});

test("C05: two grow commands both apply", () => {
  const { h, e } = setup(["a", "b"]);
  h.active = "a";
  const w0 = h.windows.get("a")!.frame.width;
  e.execute("plastile.resize.grow");
  h.advance(10);
  e.execute("plastile.resize.grow");
  h.advance(10);
  const w2 = h.windows.get("a")!.frame.width;
  assert.ok(Math.abs(w2 - w0 - 2 * 0.05 * (1280 - 16 - 8)) <= 2, `grew ${w2 - w0}`);
});

test("C06: geometry signals during a write do not re-solve recursively", () => {
  const { h, e } = setup(["a", "b", "c"]);
  const solves = e.counters.solves;
  h.active = "a";
  e.execute("plastile.swap.master"); // moves windows: synchronous observations inside writes
  assert.ok(e.counters.observationsDuringApply > 0);
  assert.equal(e.counters.solves, solves + 1);
  h.drain();
  assert.equal(e.counters.solves, solves + 1, "observations must not trigger solves");
});

test("C07: removal during apply is preserved and peers are still applied", () => {
  const { h, e } = setup(["a", "b", "c"]);
  // Close "b" from inside the first write of the next solve.
  const orig = h.applyFrame.bind(h);
  let fired = false;
  h.applyFrame = (id, gen, t) => {
    if (!fired) { fired = true; h.close("b"); }
    return orig(id, gen, t);
  };
  h.active = "a";
  e.execute("plastile.layout.monocle");
  h.applyFrame = orig;
  h.drain();
  assert.deepEqual(e.membersOf({ output: "O1", desktop: "D1", activity: "default" }), ["a", "c"]);
  assert.ok(rectNear(h.windows.get("c")!.frame, rect(8, 8, 1264, 784)), "peer applied after removal");
  assert.deepEqual(e.check(), []);
});

test("C08: an exception inside apply releases guards; the next command works", () => {
  const { h, e } = setup(["a", "b"]);
  const orig = h.applyFrame.bind(h);
  h.applyFrame = () => { throw new Error("boom"); };
  h.active = "a";
  e.execute("plastile.swap.master");
  h.applyFrame = orig;
  assert.ok(e.counters.errors >= 1);
  // Guards were released: later commands run and issue requests again.
  const r = e.execute("plastile.swap.master");
  assert.equal(r.status, "accepted");
  const r2 = e.execute("plastile.swap.master");
  assert.equal(r2.status, "accepted");
  assert.equal(r2.requested, true);
});

test("C09/C13: a burst across two contexts solves each at most once per flush", () => {
  const h = new MockHost();
  h.outs.push({ id: "O2", name: "O2", geometry: rect(1280, 0, 1280, 800), scale: 1 });
  h.visible.set("O2", "D1");
  const e = h.start();
  const flushes0 = e.counters.flushes; // start() runs one adoption flush itself
  for (let i = 0; i < 20; ++i) h.open(`w${i}`, { membership: { output: i % 2 ? "O2" : "O1", desktops: ["D1"], onAllDesktops: false, activities: [] } });
  h.drain();
  assert.equal(e.counters.solves, 2);
  assert.equal(e.counters.flushes - flushes0, 1);
});

test("C10: context changes before the flush use the explicit new context", () => {
  const { h, e } = setup(["a", "b"]);
  const w = h.windows.get("b")!;
  h.sendToDesktop("b", w.gen, "D2");
  h.drain();
  assert.deepEqual(e.membersOf({ output: "O1", desktop: "D1", activity: "default" }), ["a"]);
  assert.deepEqual(e.membersOf({ output: "O1", desktop: "D2", activity: "default" }), ["b"]);
  assert.ok(rectNear(h.windows.get("a")!.frame, rect(8, 8, 1264, 784)), "source reflowed once");
});

test("C11: a no-op command issues zero writes", () => {
  const { h, e } = setup(["a", "b", "c"]);
  h.active = "a";
  const n = h.writes.length;
  const r = e.execute("plastile.layout.master-stack");
  assert.equal(r.status, "noop");
  e.execute("plastile.context.reset");
  h.drain();
  assert.equal(h.writes.length, n, "re-solving an unchanged plan writes nothing");
});

test("C12: focus-only navigation solves nothing and writes nothing", () => {
  const { h, e } = setup(["a", "b", "c"]);
  h.active = "a";
  const solves = e.counters.solves, writes = h.writes.length;
  const r = e.execute("plastile.focus.right");
  assert.equal(r.status, "accepted");
  assert.equal(h.active, "b");
  e.execute("plastile.focus.down");
  assert.equal(h.active, "c");
  e.execute("plastile.focus.left");
  assert.equal(h.active, "a");
  assert.equal(e.counters.solves, solves);
  assert.equal(h.writes.length, writes);
});

test("C14: idle after settling leaves no timers or deferred work", () => {
  const { h, e } = setup(["a", "b"], { b: { delay: 200 } });
  h.advance(2000);
  const flushes = e.counters.flushes, deadlines = e.counters.deadlines;
  h.advance(60_000);
  assert.equal(e.counters.flushes, flushes);
  assert.equal(e.counters.deadlines, deadlines);
  assert.equal(e.outstandingCount(), 0);
});

test("G04: one slow client does not delay peers; its request stays pending without a busy loop", () => {
  const { h, e } = setup(["a", "b", "c"], { c: { delay: 400 } });
  h.active = "a";
  e.execute("plastile.resize.grow");
  h.advance(1);
  assert.ok(e.outstandingCount() >= 1);
  const a = h.windows.get("a")!.frame, b = h.windows.get("b")!.frame;
  assert.ok(a.width > 640 && b.x === a.x + a.width + 8, "fast peers settled immediately");
  const writes = h.writes.length;
  h.advance(300);
  assert.equal(h.writes.length, writes, "no repeated writes while outstanding");
  h.advance(200);
  assert.equal(e.outstandingCount(), 0);
});

test("G05/G06: A->B->A with a delayed client ends at A with one correction", () => {
  const { h, e } = setup(["a", "b", "c"], { c: { delay: 300 } });
  h.advance(1000);
  const A = { ...h.windows.get("c")!.frame };
  h.active = "a";
  e.execute("plastile.resize.grow");
  h.advance(50);
  e.execute("plastile.resize.shrink");
  h.advance(2000);
  assert.ok(rectNear(h.windows.get("c")!.frame, A), `c ended at ${JSON.stringify(h.windows.get("c")!.frame)}`);
  assert.equal(e.counters.stale, 1);
  assert.equal(e.counters.corrections, 1);
  assert.equal(e.outstandingCount(), 0);
});

test("G08/E07: a client obeying a larger minimum is learned once; no oscillation", () => {
  const h = new MockHost();
  const e = h.start();
  h.open("a");
  h.open("b");
  h.open("c", { clampToMin: true, constraints: { minFrame: { width: 0, height: 0 }, maxFrame: { width: Infinity, height: Infinity }, fixed: false } });
  // The client's real minimum is invisible to the script: it clamps on commit.
  h.windows.get("c")!.constraints = { minFrame: { width: 600, height: 500 }, maxFrame: { width: Infinity, height: Infinity }, fixed: false };
  h.advance(5000);
  const writes = h.writes.length;
  h.advance(5000);
  assert.equal(h.writes.length, writes, "converged: no further writes");
  assert.ok(e.counters.learned >= 1);
  const ex = e.explain("c")!;
  assert.ok(String(ex.exception).includes("learned") || ex.mode === "floating", JSON.stringify(ex));
});

test("G03: device-pixel snapping at scale 1.75 settles; nothing is learned, floated or re-written", () => {
  const h = new MockHost();
  h.outs = [{ id: "O1", name: "O1", geometry: rect(0, 0, 731.4286, 457.1429), scale: 1.75 }];
  h.areas.set("O1/D1", rect(0, 0, 731.4286, 457.1429));
  const e = h.start();
  const snap = { width: 0, height: 1 / 1.75 }; // one device pixel taller than requested
  h.open("a", { commitOffset: snap });
  h.open("b", { commitOffset: snap });
  h.drain();
  h.advance(5000);
  const writes = h.writes.length;
  h.advance(5000);
  assert.equal(h.writes.length, writes, "converged: no repeated fractional corrections");
  assert.equal(e.counters.learned, 0, "a device pixel is not a size constraint");
  assert.equal(e.counters.overflow, 0);
  for (const id of ["a", "b"]) assert.equal(e.explain(id)!.mode, "tiled");
});

test("G11: an application resizing itself is corrected at most twice, then left alone", () => {
  const { h, e } = setup(["a", "b"]);
  for (let i = 0; i < 6; ++i) {
    h.userSetFrame("b", rect(700, 50, 300 + i, 300));
    h.drain();
  }
  h.advance(5000);
  assert.ok(e.counters.corrections <= 2, `corrections ${e.counters.corrections}`);
  assert.ok(e.counters.diverged >= 1);
});

test("G12: a client that ignores requests diverges after a bounded budget", () => {
  const { h, e } = setup(["a", "b"], { b: { ignore: true, delay: 10 } });
  h.advance(10_000);
  const writes = h.writes.length;
  h.advance(10_000);
  assert.equal(h.writes.length, writes, "no endless retries");
  const ex = e.explain("b")!;
  assert.ok(ex.exception !== null, "explained exception");
});

test("L09/L12: overlapping suspensions — clearing one does not retile", () => {
  const { h, e } = setup(["a", "b"]);
  h.setStates("b", { fullscreen: true });
  h.setStates("b", { minimized: true });
  h.drain();
  const writes = h.writes.filter((w) => w.id === "b").length;
  h.setStates("b", { fullscreen: false });
  h.drain();
  assert.equal(h.writes.filter((w) => w.id === "b").length, writes, "still minimized: no request");
  assert.ok(rectNear(h.windows.get("a")!.frame, rect(8, 8, 1264, 784)), "peer reflowed to full area");
  h.setStates("b", { minimized: false });
  h.drain();
  assert.ok(h.windows.get("b")!.frame.x > 600, "reinserted in its old slot");
  assert.deepEqual(e.membersOf({ output: "O1", desktop: "D1", activity: "default" }), ["a", "b"]);
});

test("L10/L11: fullscreen and maximize are not fought", () => {
  const { h } = setup(["a", "b"]);
  h.setStates("a", { maximized: true });
  h.userSetFrame("a", rect(0, 0, 1280, 800));
  h.drain();
  h.advance(3000);
  assert.ok(rectNear(h.windows.get("a")!.frame, rect(0, 0, 1280, 800)), "maximized frame kept");
  assert.equal(h.writes.filter((w) => w.id === "a" && w.t > 0).length, 0);
});

test("L08: float -> user move/resize -> tile -> float restores the latest floating rect", () => {
  const { h, e } = setup(["a", "b"]);
  h.active = "b";
  e.execute("plastile.window.toggle-float");
  h.drain();
  h.userSetFrame("b", rect(300, 200, 500, 400));
  e.execute("plastile.window.toggle-float");
  h.drain();
  assert.equal(e.modeOf("b"), "tiled");
  e.execute("plastile.window.toggle-float");
  h.drain();
  assert.ok(rectNear(h.windows.get("b")!.frame, rect(300, 200, 500, 400)), JSON.stringify(h.windows.get("b")!.frame));
});

test("L13: a native quick tile yields; adopt-native takes it back", () => {
  const { h, e } = setup(["a", "b"]);
  const b = h.windows.get("b")!;
  b.nativeTile = true;
  e.nativeTileChanged("b", b.gen, true);
  h.userSetFrame("b", rect(0, 0, 640, 800));
  h.drain();
  h.advance(2000);
  assert.equal(e.modeOf("b"), "native");
  assert.ok(rectNear(b.frame, rect(0, 0, 640, 800)), "not snapped back");
  h.active = "b";
  e.execute("plastile.window.adopt-native");
  h.drain();
  assert.equal(e.modeOf("b"), "tiled");
  assert.equal(b.nativeTile, false);
});

test("L15: a window on an inactive desktop is not placed until that desktop is shown", () => {
  const { h, e } = setup(["a"]);
  h.open("z", { membership: { output: "O1", desktops: ["D2"], onAllDesktops: false, activities: [] } });
  h.drain();
  assert.equal(h.writes.filter((w) => w.id === "z").length, 0);
  h.visible.set("O1", "D2");
  e.visibilityChanged();
  h.drain();
  assert.ok(rectNear(h.windows.get("z")!.frame, rect(8, 8, 1264, 784)));
});

test("L16: all-desktop and dialog windows float by default", () => {
  const { h, e } = setup(["a"]);
  h.open("pin", { membership: { output: "O1", desktops: [], onAllDesktops: true, activities: [] } });
  h.open("dlg", { meta: meta("dlg", { kind: "dialog" }) });
  h.open("dock", { meta: meta("dock", { kind: "dock" }) });
  h.drain();
  assert.equal(e.modeOf("pin"), "floating");
  assert.equal(e.modeOf("dlg"), "floating");
  assert.equal(e.modeOf("dock"), "excluded");
  assert.equal(h.writes.filter((w) => ["pin", "dlg", "dock"].includes(w.id)).length, 0);
});

test("late metadata: pending window classified at the readiness deadline", () => {
  const h = new MockHost();
  const e = h.start();
  h.open("late", { meta: meta("", {}) });
  h.drain();
  assert.equal(e.modeOf("late"), "pending");
  assert.equal(h.writes.length, 0);
  h.advance(400);
  assert.equal(e.modeOf("late"), "tiled");
});

test("O06: an invalid work area keeps the last valid placement", () => {
  const { h, e } = setup(["a", "b"]);
  const before = tiledFrames(h, ["a", "b"]);
  h.areas.set("O1/D1", rect(0, 0, 0, 0));
  e.topologyChanged();
  h.drain();
  assert.deepEqual(tiledFrames(h, ["a", "b"]), before);
  h.areas.delete("O1/D1");
  e.topologyChanged();
  h.drain();
  assertTiling(tiledFrames(h, ["a", "b"]), AREA);
});

test("suspend releases ownership; resume re-solves once", () => {
  const { h, e } = setup(["a", "b"]);
  h.active = "a";
  e.execute("plastile.runtime.toggle-suspend");
  h.userSetFrame("a", rect(10, 10, 300, 300));
  const r = e.execute("plastile.swap.master");
  assert.equal(r.status, "rejected");
  h.drain();
  assert.ok(rectNear(h.windows.get("a")!.frame, rect(10, 10, 300, 300)));
  e.execute("plastile.runtime.toggle-suspend");
  h.drain();
  assertTiling(tiledFrames(h, ["a", "b"]), AREA);
});

test("stop invalidates deferred work and restores owned borders only", () => {
  const h = new MockHost();
  const e = h.start({ rulesFor: (m) => (m.appId === "a" ? { border: "none", ruleIds: ["r1"] } : null) });
  h.open("a");
  h.open("b");
  h.drain();
  assert.equal(h.windows.get("a")!.noBorder, true);
  e.stop();
  assert.equal(h.windows.get("a")!.noBorder, false, "owned border restored");
  const writes = h.writes.length;
  h.open("c");
  h.advance(5000);
  assert.equal(h.writes.length, writes, "no work after stop");
});

test("layout switching preserves order; monocle raises the focused member", () => {
  const { h, e } = setup(["a", "b", "c"]);
  h.active = "b";
  e.execute("plastile.layout.monocle");
  assert.deepEqual(h.raises.slice(-1), ["b"]);
  for (const id of ["a", "b", "c"]) assert.ok(rectNear(h.windows.get(id)!.frame, rect(8, 8, 1264, 784)));
  e.execute("plastile.focus.next");
  assert.equal(h.active, "c");
  assert.deepEqual(h.raises.slice(-1), ["c"]);
  e.execute("plastile.layout.master-stack");
  h.drain();
  assert.deepEqual(e.membersOf({ output: "O1", desktop: "D1", activity: "default" }), ["a", "b", "c"]);
  assertTiling(tiledFrames(h, ["a", "b", "c"]), AREA);
});

test("randomized lifecycle: invariants hold and windows converge", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const h = new MockHost();
  const e = h.start();
  const live: string[] = [];
  const cmds = ["plastile.swap.next", "plastile.resize.grow", "plastile.resize.shrink", "plastile.focus.next",
    "plastile.layout.next", "plastile.window.toggle-float", "plastile.master.increase", "plastile.master.decrease"];
  for (let i = 0; i < 600; ++i) {
    const p = rnd();
    if (p < 0.25 && live.length < 10) { const id = `w${i}`; h.open(id, { delay: Math.floor(rnd() * 3) * 100 }); live.push(id); }
    else if (p < 0.4 && live.length) { const id = live.splice(Math.floor(rnd() * live.length), 1)[0]; h.close(id); }
    else if (p < 0.5 && live.length) { const id = live[Math.floor(rnd() * live.length)]; h.setStates(id, { minimized: !h.windows.get(id)!.states.minimized }); }
    else if (live.length) { h.active = live[Math.floor(rnd() * live.length)]; e.execute(cmds[Math.floor(rnd() * cmds.length)]); }
    h.advance(Math.floor(rnd() * 120));
    assert.deepEqual(e.check(), [], `step ${i}`);
  }
  h.advance(10_000);
  assert.equal(e.outstandingCount(), 0, "all requests settled or diverged");
  assert.equal(e.counters.errors, 0);
});

test("O01: an external transfer to another output is not written back (frame event before output event)", () => {
  const h = new MockHost();
  h.outs.push({ id: "O2", name: "O2", geometry: rect(1280, 0, 1280, 800), scale: 1 });
  h.visible.set("O2", "D1");
  const e = h.start();
  h.open("a"); h.open("b");
  h.drain();
  const b = h.windows.get("b")!;
  // KWin's sendClientToScreen: geometry first, then the output change.
  h.userSetFrame("b", rect(1746, 236, 400, 328));
  b.membership = { ...b.membership, output: "O2" };
  e.membershipChanged("b", b.gen, b.membership);
  h.drain();
  assert.equal(b.membership.output, "O2");
  assert.ok(b.frame.x >= 1280, `written back to ${JSON.stringify(b.frame)}`);
  assert.ok(rectNear(b.frame, rect(1288, 8, 1264, 784)), "tiled on the destination output");
  assert.ok(rectNear(h.windows.get("a")!.frame, rect(8, 8, 1264, 784)), "source reflowed");
});

test("I01: a drag keeps the model (no reflow, no writes) and a drop on another tile swaps once", () => {
  const { h, e } = setup(["a", "b", "c"]);
  const slots = tiledFrames(h, ["a", "b", "c"]);
  const solves = e.counters.solves, writes = h.writes.length;
  h.setStates("c", { interactive: "move" });
  for (let i = 0; i < 20; ++i) { h.userSetFrame("c", rect(700 - i * 30, 400 - i * 10, 400, 300)); h.drain(); }
  assert.equal(e.counters.solves, solves, "no solve during the drag");
  assert.equal(h.writes.length, writes, "no write during the drag");
  assert.ok(rectNear(h.windows.get("b")!.frame, slots.get("b")!), "peer not reflowed");
  h.userSetFrame("c", rect(150, 300, 400, 300)); // centre over a's slot
  h.setStates("c", { interactive: "none" });
  h.drain();
  assert.equal(e.counters.solves, solves + 1, "one release commit");
  assert.ok(rectNear(h.windows.get("c")!.frame, slots.get("a")!), "c took a's slot");
  assert.ok(rectNear(h.windows.get("a")!.frame, slots.get("c")!), "a took c's slot");
});

test("I01: a drop outside any tile snaps back with one solve", () => {
  const { h, e } = setup(["a", "b"]);
  const slots = tiledFrames(h, ["a", "b"]);
  h.setStates("b", { interactive: "move" });
  h.userSetFrame("b", rect(5000, 5000, 400, 300));
  h.setStates("b", { interactive: "none" });
  h.drain();
  assert.ok(rectNear(h.windows.get("b")!.frame, slots.get("b")!));
  assert.ok(e.counters.solves >= 1);
});

test("I03: a user resize of the master edge becomes the new ratio", () => {
  const { h } = setup(["a", "b"]);
  const a0 = h.windows.get("a")!.frame;
  h.setStates("a", { interactive: "resize" });
  h.userSetFrame("a", rect(a0.x, a0.y, a0.width + 100, a0.height));
  h.setStates("a", { interactive: "none" });
  h.drain();
  const a1 = h.windows.get("a")!.frame, b1 = h.windows.get("b")!.frame;
  assert.ok(Math.abs(a1.width - (a0.width + 100)) <= 1, `master width ${a1.width}`);
  assert.equal(b1.x, a1.x + a1.width + 8, "peer follows the divider");
});

test("L09/L10/L11: clearing the last suspension re-solves once and peers give the space back", () => {
  for (const state of ["minimized", "maximized", "fullscreen", "hidden"] as const) {
    const { h, e } = setup(["a", "b"]);
    const slots = tiledFrames(h, ["a", "b"]);
    h.setStates("b", { [state]: true });
    h.drain();
    assert.ok(rectNear(h.windows.get("a")!.frame, rect(8, 8, 1264, 784)), `${state}: peer took the area`);
    const solves = e.counters.solves;
    h.setStates("b", { [state]: false });
    h.drain();
    assert.equal(e.counters.solves, solves + 1, `${state}: one solve when the suspension clears`);
    assert.ok(rectNear(h.windows.get("a")!.frame, slots.get("a")!), `${state}: peer back in its slot`);
    assertTiling(tiledFrames(h, ["a", "b"]), AREA);
  }
});

test("I01/L11: a drag that ends in KWin's drag-to-maximize is not a swap; unmaximize re-tiles in place", () => {
  const { h, e } = setup(["a", "b", "c"]);
  const slots = tiledFrames(h, ["a", "b", "c"]);
  const b = slots.get("b")!;
  h.setStates("c", { interactive: "move" });
  h.userSetFrame("c", rect(b.x + b.width / 2 - 282, 0, 565, 388)); // centre inside b's slot
  // KWin clears the interactive flag, then maximizes (electric border) before it reports the end.
  h.setStates("c", { interactive: "none", maximized: true });
  h.userSetFrame("c", rect(0, 0, 1280, 800));
  h.drain();
  assert.deepEqual(e.membersOf({ output: "O1", desktop: "D1", activity: "default" }), ["a", "b", "c"], "order unchanged");
  h.setStates("c", { maximized: false });
  h.userSetFrame("c", rect(b.x + b.width / 2 - 282, 0, 565, 388)); // KWin restores the pre-maximize frame
  h.drain();
  for (const id of ["a", "b", "c"]) assert.ok(rectNear(h.windows.get(id)!.frame, slots.get(id)!), `${id} back in its slot`);
});

test("G04: a client slower than the deadline is not learned as a constraint and still reaches its slot", () => {
  const ref = setup(["a", "b"]).h; // same layout with prompt clients: the slot b must reach
  const slot = ref.windows.get("b")!.frame;
  const { h, e } = setup(["a", "b"], { b: { delay: 1000 } });
  h.advance(10_000);
  assert.equal(e.counters.learned, 0);
  const ex = e.explain("b")!;
  assert.equal(ex.learnedMin, null);
  assert.equal(ex.learnedMax, null);
  assert.ok(rectNear(h.windows.get("b")!.frame, slot), `b at ${JSON.stringify(h.windows.get("b")!.frame)}`);
  assert.equal(ex.exception, null, "converged: no stale divergence explanation");
  assertTiling(tiledFrames(h, ["a", "b"]), AREA);
});

test("G12: a client that never answers is not learned as a constraint", () => {
  const { h, e } = setup(["a", "b"], { b: { ignore: true, delay: 10 } });
  h.advance(10_000);
  assert.equal(e.counters.learned, 0);
  assert.equal(e.explain("b")!.learnedMax, null);
});

test("G09: a client that rounds its size down (character cells) is accepted, and grows with its slot", () => {
  const { h, e } = setup(["a", "b"], { b: { commitOffset: { width: -7, height: -10 } } });
  h.advance(5000);
  assert.equal(e.counters.learned, 0, "rounding is not a maximum");
  const writes = h.writes.length;
  h.advance(5000);
  assert.equal(h.writes.length, writes, "accepted: no repeated requests");
  h.close("a");
  h.advance(5000);
  const b = h.windows.get("b")!.frame;
  assert.ok(b.width >= 1264 - 7 && b.height >= 784 - 10, `b grew with its slot: ${JSON.stringify(b)}`);
  assert.ok(b.x === 8 && b.y === 8, "placed at the slot origin");
  const settled = h.writes.length;
  h.advance(5000);
  assert.equal(h.writes.length, settled, "converged after growing");
});

test("G11 after reload: a window adopted already at its slot is corrected when the app resizes itself", () => {
  const first = setup(["a", "b"]).h;
  const fa = first.windows.get("a")!.frame, fb = first.windows.get("b")!.frame;
  const h = new MockHost();
  const snaps = [h.snapshot(h.make("a", { frame: fa })), h.snapshot(h.make("b", { frame: fb }))];
  const e = h.start({}, snaps);
  h.drain();
  assert.equal(h.writes.length, 0, "reload writes nothing");
  h.userSetFrame("b", rect(fb.x, fb.y, 300, 300));
  h.advance(5000);
  assert.ok(rectNear(h.windows.get("b")!.frame, fb), `b back in its slot: ${JSON.stringify(h.windows.get("b")!.frame)}`);
  assert.ok(e.counters.corrections >= 1 && e.counters.corrections <= 2);
});

test("G11 after I03: the window resized by the user is still corrected when the app resizes itself", () => {
  const { h, e } = setup(["a", "b"]);
  const a0 = h.windows.get("a")!.frame;
  h.setStates("a", { interactive: "resize" });
  h.userSetFrame("a", rect(a0.x, a0.y, a0.width + 100, a0.height));
  h.setStates("a", { interactive: "none" });
  h.drain();
  const a1 = { ...h.windows.get("a")!.frame };
  const corrections = e.counters.corrections;
  h.userSetFrame("a", rect(a1.x, a1.y, 300, 300));
  h.advance(5000);
  assert.ok(rectNear(h.windows.get("a")!.frame, a1), `a back in its slot: ${JSON.stringify(h.windows.get("a")!.frame)}`);
  assert.ok(e.counters.corrections > corrections);
});

test("L13/L14: a native yield survives the tile being released and later reclassification", () => {
  const { h, e } = setup(["a", "b"]);
  const b = h.windows.get("b")!;
  b.nativeTile = true;
  e.nativeTileChanged("b", b.gen, true);       // Tile.manage / quick tile: yield
  h.userSetFrame("b", rect(0, 0, 640, 800));
  h.drain();
  b.nativeTile = false;
  e.nativeTileChanged("b", b.gen, false);      // Tile.unmanage or dragged out by the user
  h.drain();
  assert.equal(e.modeOf("b"), "native");
  const writes = h.writes.filter((w) => w.id === "b").length;
  e.configure({});                             // configuration activation reclassifies every window
  h.drain();
  e.metadataChanged("b", b.gen, meta("b", { title: "renamed", resourceName: "b2" }));
  h.drain();
  h.advance(2000);
  assert.equal(e.modeOf("b"), "native", "still yielded until the user re-adopts it");
  assert.equal(h.writes.filter((w) => w.id === "b").length, writes, "no write to the yielded window");
  assert.ok(rectNear(b.frame, rect(0, 0, 640, 800)));
  h.active = "b";
  assert.equal(e.execute("plastile.window.adopt-native").status, "accepted");
  h.drain();
  assert.equal(e.modeOf("b"), "tiled");
  assertTiling(tiledFrames(h, ["a", "b"]), AREA);
});

test("L13: a window already natively tiled at adoption stays yielded when its tile goes away", () => {
  const h = new MockHost();
  const snaps = [h.snapshot(h.make("a")), h.snapshot(h.make("b", { nativeTile: true, frame: rect(0, 0, 640, 800) }))];
  const e = h.start({}, snaps);
  h.drain();
  assert.equal(e.modeOf("b"), "native");
  const b = h.windows.get("b")!;
  b.nativeTile = false;
  e.nativeTileChanged("b", b.gen, false);
  e.configure({});
  h.drain();
  assert.equal(e.modeOf("b"), "native");
  h.active = "b";
  assert.equal(e.execute("plastile.window.toggle-float").status, "accepted", "toggle re-adopts");
  assert.equal(e.modeOf("b"), "tiled");
});

test("L08/L13: toggle-float on a window that cannot tile is a no-op without side effects", () => {
  const fixed = { minFrame: { width: 400, height: 300 }, maxFrame: { width: 400, height: 300 }, fixed: true };
  const { h, e } = setup(["a", "x"], { x: { constraints: fixed } });
  const x = h.windows.get("x")!;
  assert.equal(e.modeOf("x"), "floating");
  x.nativeTile = true;
  e.nativeTileChanged("x", x.gen, true);
  h.userSetFrame("x", rect(0, 0, 640, 800));
  h.drain();
  const before = e.explain("x")!;
  h.active = "x";
  const r = e.execute("plastile.window.toggle-float");
  assert.equal(r.status, "noop");
  assert.equal(x.nativeTile, true, "native tile not released");
  const after = e.explain("x")!;
  assert.equal(after.mode, "native");
  assert.equal(after.userMode, before.userMode);
  // A fixed floating window: same, no sticky tile request left behind.
  const { h: h2, e: e2 } = setup(["a", "y"], { y: { constraints: fixed } });
  h2.active = "y";
  assert.equal(e2.execute("plastile.window.toggle-float").status, "noop");
  assert.equal(e2.explain("y")!.userMode, null);
});

test("Q10/T16: explain lists every matched rule and the rule behind each action, not only the mode rule", () => {
  const h = new MockHost();
  const e = h.start({ rulesFor: (m) => (m.appId === "a"
    ? { border: "none", insert: "end", ruleIds: ["no-borders", "append"], reasons: { border: "rule no-borders", insert: "rule append" } }
    : null) });
  h.open("a");
  h.open("b");
  h.drain();
  const ex = e.explain("a")!;
  assert.equal(h.windows.get("a")!.noBorder, true, "the border rule applies");
  assert.deepEqual(ex.rules, { ids: ["no-borders", "append"], actions: { border: "none", insert: "end" },
                               reasons: { border: "rule no-borders", insert: "rule append" } });
  assert.equal(e.explain("b")!.rules, null);
});

test("C14/Q10: suspended means no owned border writes; resume re-applies the border rule", () => {
  const h = new MockHost();
  const e = h.start({ rulesFor: (m) => (m.appId.startsWith("x") ? { border: "none", ruleIds: ["r1"] } : null) });
  h.open("x1");
  h.open("b");
  h.drain();
  assert.equal(h.windows.get("x1")!.noBorder, true);
  h.active = "b";
  e.execute("plastile.runtime.toggle-suspend");
  assert.equal(h.windows.get("x1")!.noBorder, false, "suspend restores the owned border");
  h.open("x2");
  e.configure({ rulesFor: (m) => (m.appId.startsWith("x") ? { border: "none", ruleIds: ["r1"] } : null) });
  h.drain();
  assert.equal(h.windows.get("x2")!.noBorder, false, "no border written while suspended");
  assert.equal(h.windows.get("x1")!.noBorder, false);
  e.execute("plastile.runtime.toggle-suspend");
  h.drain();
  assert.equal(h.windows.get("x1")!.noBorder, true, "resume re-applies");
  assert.equal(h.windows.get("x2")!.noBorder, true);
  e.stop();
  assert.equal(h.windows.get("x2")!.noBorder, false, "owned after resume, restored at stop");
});

test("late metadata: suspending during the readiness wait does not leave the window pending forever", () => {
  const h = new MockHost();
  const e = h.start();
  h.open("a");
  h.open("late", { meta: meta("", {}) });
  h.drain();
  h.active = "a";
  e.execute("plastile.runtime.toggle-suspend");
  h.advance(100);
  e.execute("plastile.runtime.toggle-suspend");
  h.advance(1000);
  assert.equal(e.modeOf("late"), "tiled");
  h.advance(60_000);
  assert.equal(e.outstandingCount(), 0);
});

test("C12: in monocle a focus change selects and raises once, with no deferred solve", () => {
  const { h, e } = setup(["a", "b", "c"]);
  h.active = "a";
  e.execute("plastile.layout.monocle");
  h.drain();
  const solves = e.counters.solves, raises = h.raises.length, writes = h.writes.length;
  assert.equal(e.execute("plastile.focus.next").status, "accepted");
  h.drain();
  assert.equal(h.active, "b");
  assert.equal(e.counters.solves, solves, "no solve");
  assert.deepEqual(h.raises.slice(raises), ["b"], "one raise");
  h.active = "c";
  e.activeChanged("c"); // the user clicks another member (KWin raises it itself)
  h.drain();
  assert.equal(e.counters.solves, solves);
  assert.equal(h.writes.length, writes);
  assert.deepEqual(h.raises.slice(raises), ["b"], "no extra raise");
});

test("C08: an exception while solving one context does not drop the other dirty contexts", () => {
  const h = new MockHost();
  h.outs.push({ id: "O2", name: "O2", geometry: rect(1280, 0, 1280, 800), scale: 1 });
  h.visible.set("O2", "D1");
  const e = h.start();
  const onO2 = { membership: { output: "O2", desktops: ["D1"], onAllDesktops: false, activities: [] } };
  h.open("a");
  h.open("b", onO2);
  h.drain();
  const orig = h.workArea.bind(h);
  let failures = 1;
  h.workArea = (o, d) => { if (o === "O1" && failures > 0) { failures--; throw new Error("boom"); } return orig(o, d); };
  h.open("a2");
  h.open("b2", onO2);
  h.drain();
  assert.ok(e.counters.errors >= 1);
  assertTiling(tiledFrames(h, ["b", "b2"]), rect(1280, 0, 1280, 800));
  assert.ok(h.windows.get("b2")!.frame.x > 1280 + 600, "the healthy context was placed");
  assertTiling(tiledFrames(h, ["a", "a2"]), AREA);
  assert.ok(h.windows.get("a2")!.frame.x > 600, "the failed context was retried once");
  // A context that keeps failing is retried a bounded number of times, then left alone.
  failures = Infinity;
  const flushes = e.counters.flushes;
  h.open("a3");
  h.drain();
  assert.ok(e.counters.flushes - flushes <= 3, `bounded retries (${e.counters.flushes - flushes} flushes)`);
  h.workArea = orig;
});

test("L06/L08: in the floating layout the user's latest placement is what a later return restores", () => {
  const { h, e } = setup(["a", "b"]);
  h.active = "b";
  e.execute("plastile.window.toggle-float");
  h.drain();
  h.userSetFrame("b", rect(300, 200, 500, 400));
  e.execute("plastile.window.toggle-float"); // tiled again
  h.drain();
  e.execute("plastile.layout.floating");
  h.drain();
  assert.ok(rectNear(h.windows.get("b")!.frame, rect(300, 200, 500, 400)), "floating layout restores b's float rect");
  h.setStates("b", { interactive: "move" });
  h.userSetFrame("b", rect(900, 400, 300, 300));
  h.setStates("b", { interactive: "none" });
  h.drain();
  e.execute("plastile.layout.master-stack");
  h.drain();
  e.execute("plastile.layout.floating");
  h.drain();
  assert.ok(rectNear(h.windows.get("b")!.frame, rect(900, 400, 300, 300)), `latest placement restored: ${JSON.stringify(h.windows.get("b")!.frame)}`);
  // Floating a member of the floating layout keeps it where the user put it.
  e.execute("plastile.window.toggle-float");
  h.drain();
  assert.equal(e.modeOf("b"), "floating");
  assert.ok(rectNear(h.windows.get("b")!.frame, rect(900, 400, 300, 300)));
});

test("G08/BEHAVIOR §11: an overflow float is reconsidered when the area, constraints, peers or configuration change", () => {
  const min700 = { minFrame: { width: 700, height: 0 }, maxFrame: { width: Infinity, height: Infinity }, fixed: false };
  const free = { minFrame: { width: 0, height: 0 }, maxFrame: { width: Infinity, height: Infinity }, fixed: false };
  const wide = () => setup(["a", "b", "c"], { a: { constraints: min700 }, b: { constraints: min700 }, c: { constraints: min700 } });
  {
    const { h, e } = wide();
    assert.deepEqual(["a", "b", "c"].map((id) => e.modeOf(id)), ["tiled", "floating", "floating"]);
    assert.ok(String(e.explain("c")!.exception).startsWith("overflow"));
    h.outs = [{ ...h.outs[0], geometry: rect(0, 0, 3840, 2160) }];
    e.topologyChanged();
    h.drain();
    assert.deepEqual(["a", "b", "c"].map((id) => e.modeOf(id)), ["tiled", "tiled", "tiled"], "larger output");
    assertTiling(tiledFrames(h, ["a", "b", "c"]), rect(0, 0, 3840, 2160));
    assert.equal(e.explain("c")!.exception, null);
  }
  {
    const { h, e } = wide();
    const c = h.windows.get("c")!;
    c.constraints = free;
    e.constraintsChanged("c", c.gen, free);
    h.drain();
    assert.equal(e.modeOf("c"), "tiled", "its own minimum dropped");
    assert.equal(e.modeOf("b"), "floating", "an unrelated overflow float is left alone");
    assertTiling(tiledFrames(h, ["a", "c"]), AREA);
  }
  {
    const { h, e } = wide();
    h.close("a");
    h.drain();
    assert.equal(e.modeOf("b"), "tiled", "a peer left");
    assert.equal(e.modeOf("c"), "floating", "still only one fits (float-new keeps the older one)");
    assert.ok(rectNear(h.windows.get("b")!.frame, rect(8, 8, 1264, 784)));
  }
  {
    const { h, e } = wide();
    e.configure({ settingsFor: () => ({ ...DEFAULT_SETTINGS, layout: "monocle" }) });
    h.drain();
    assert.deepEqual(["a", "b", "c"].map((id) => e.modeOf(id)), ["tiled", "tiled", "tiled"], "configuration activation");
  }
});

test("BEHAVIOR §12: a configured master ratio/count reaches live contexts; values the user set by command are kept", () => {
  const conf = (ratio: number, masterCount: number) => ({ ...DEFAULT_SETTINGS, masterStack: { ...DEFAULT_SETTINGS.masterStack, ratio, masterCount } });
  {
    let cur = conf(0.55, 1);
    const h = new MockHost();
    const e = h.start({ settingsFor: () => cur });
    for (const id of ["a", "b", "c"]) h.open(id);
    h.drain();
    cur = conf(0.7, 2);
    e.configure({ settingsFor: () => cur });
    h.drain();
    const [a, b, c] = ["a", "b", "c"].map((id) => h.windows.get(id)!.frame);
    assert.ok(a.x === b.x && b.y > a.y, "two masters in the left column");
    assert.ok(Math.abs(a.width - 0.7 * (1264 - 8)) <= 1, `master width ${a.width}`);
    assert.ok(c.x > a.x + a.width && c.height > 700, "one stack window");
    assertTiling(tiledFrames(h, ["a", "b", "c"]), AREA);
  }
  {
    let cur = conf(0.55, 1);
    const h = new MockHost();
    const e = h.start({ settingsFor: () => cur });
    for (const id of ["a", "b", "c"]) h.open(id);
    h.drain();
    h.active = "a";
    e.execute("plastile.resize.grow"); // the user owns the ratio in this context now
    h.drain();
    const tuned = h.windows.get("a")!.frame.width;
    cur = conf(0.7, 2);
    e.configure({ settingsFor: () => cur });
    h.drain();
    const [a, b] = ["a", "b"].map((id) => h.windows.get(id)!.frame);
    assert.equal(a.width, tuned, "the user's ratio is kept");
    assert.ok(a.x === b.x && b.y > a.y, "the untouched master count follows the configuration");
  }
});

function onActivities(activities: string[]) {
  return { membership: { output: "O1", desktops: ["D1"], onAllDesktops: false, activities } };
}

/** Activity part of every context key that has members. */
function memberActivities(e: ReturnType<MockHost["start"]>): string[] {
  return [...new Set(e.contextSummary().filter((c) => c.members > 0).map((c) => c.id.split("␟")[2]))].sort();
}

test("E08: adding and removing a second activity keeps single-activity windows tiling with new windows", () => {
  const h = new MockHost();
  h.activity = "A";
  const e = h.start();
  h.open("a", onActivities(["A"]));
  h.open("b", onActivities(["A"]));
  h.drain();
  h.activities = 2; // the user creates activity B: KWin emits only Workspace.activitiesChanged
  e.topologyChanged();
  h.drain();
  h.open("c", onActivities(["A"]));
  h.drain();
  assertTiling(tiledFrames(h, ["a", "b", "c"]), AREA);
  assert.deepEqual(memberActivities(e), ["A"]);
  const onA = tiledFrames(h, ["a", "b", "c"]);
  h.activity = "B";
  e.visibilityChanged();
  h.open("d", onActivities(["B"]));
  h.drain();
  assert.ok(rectNear(h.windows.get("d")!.frame, rect(8, 8, 1264, 784)), "a window on B tiles alone");
  h.activity = "A";
  e.visibilityChanged();
  h.drain();
  assert.deepEqual(tiledFrames(h, ["a", "b", "c"]), onA, "activity A layout unchanged");
  h.close("d");
  h.activities = 1; // B removed again
  e.topologyChanged();
  h.drain();
  h.open("f", onActivities(["A"]));
  h.drain();
  assertTiling(tiledFrames(h, ["a", "b", "c", "f"]), AREA);
  assert.equal(e.membersOf({ output: "O1", desktop: "D1", activity: "A" }).length, 4);
});

test("E08: a late activity service re-keys adopted windows; all-activity windows float once a second activity exists", () => {
  const h = new MockHost(); // no service yet: one placeholder activity, current "default"
  const e = h.start();
  for (const id of ["a", "b", "c"]) h.open(id); // activities [] (all activities)
  h.drain();
  h.activity = "A"; // the service starts: KWin emits currentActivityChanged only (still one activity)
  e.visibilityChanged();
  h.drain();
  assertTiling(tiledFrames(h, ["a", "b", "c"]), AREA);
  assert.deepEqual(memberActivities(e), ["A"]);
  h.activities = 2;
  e.topologyChanged();
  h.drain();
  for (const id of ["a", "b", "c"]) assert.equal(e.modeOf(id), "floating", `${id} is on every activity (ADR-009)`);
  assert.deepEqual(memberActivities(e), []);
  const writes = h.writes.filter((w) => ["a", "b", "c"].includes(w.id)).length;
  h.open("d", onActivities(["A"]));
  h.drain();
  assert.ok(rectNear(h.windows.get("d")!.frame, rect(8, 8, 1264, 784)), "a new window on A tiles");
  assert.equal(h.writes.filter((w) => ["a", "b", "c"].includes(w.id)).length, writes, "floating windows not written");
  h.activities = 1; // back to one activity: they are single-context again
  e.topologyChanged();
  h.drain();
  assertTiling(tiledFrames(h, ["a", "b", "c", "d"]), AREA);
});
