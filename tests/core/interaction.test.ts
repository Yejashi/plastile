// Focus wrap and cross-output focus (T23, BEHAVIOR §7), live peer resize (T29, BEHAVIOR §8)
// and commands during an interactive resize (I05). Oracles: the mock compositor's active
// window, committed frames and write log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect, rectNear, type Rect } from "../../src/core/geometry.ts";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import type { ContextSettings } from "../../src/core/types.ts";
import { MockHost } from "./mockHost.ts";
import { assertTiling } from "./helpers.ts";

const AREA = rect(0, 0, 1280, 800);

function setup(ids: string[], s: Partial<ContextSettings> = {}) {
  const h = new MockHost();
  const settings: ContextSettings = { ...DEFAULT_SETTINGS, ...s };
  const e = h.start({ settingsFor: () => settings });
  for (const id of ids) h.open(id);
  h.drain();
  return { h, e };
}

function frames(h: MockHost, ids: string[]): Map<string, Rect> {
  return new Map(ids.map((id) => [id, h.windows.get(id)!.frame] as const));
}

// ------------------------------------------------------------------ focus wrap

test("T23: directional focus does not wrap by default", () => {
  const { h, e } = setup(["m", "s1", "s2"]);
  h.activate("s1");
  const r = e.execute("plastile.focus.right");
  assert.equal(r.status, "noop");
  assert.equal(h.active, "s1");
});

test("T23: focusWrap wraps within the context; focus only (no solve, no write)", () => {
  const { h, e } = setup(["m", "s1", "s2"], { focusWrap: true });
  h.activate("s1");
  const solves = e.counters.solves, writes = h.writes.length;
  const rows: Array<[string, string, string | null]> = [
    ["focus.right", "s1", "m"], ["focus.left", "m", "s1"], ["focus.up", "s1", "s2"], ["focus.down", "s2", "s1"],
  ];
  for (const [cmd, from, want] of rows) {
    h.activate(from);
    const r = e.execute("plastile." + cmd);
    assert.equal(r.status, "accepted", `${cmd} from ${from}`);
    assert.equal(h.active, want, `${cmd} from ${from}`);
  }
  h.activate("m");
  assert.equal(e.execute("plastile.focus.up").status, "noop", "no diagonal wrap from the full-height master");
  assert.equal(e.counters.solves, solves);
  assert.equal(h.writes.length, writes);
});

test("T23: focusWrap never crosses to another output", () => {
  const h = new MockHost();
  h.outs.push({ id: "O2", name: "O2", geometry: rect(1280, 0, 1280, 800), scale: 1 });
  h.visible.set("O2", "D1");
  const settings: ContextSettings = { ...DEFAULT_SETTINGS, focusWrap: true };
  const e = h.start({ settingsFor: () => settings });
  h.open("a");
  h.open("b", { membership: { output: "O2", desktops: ["D1"], onAllDesktops: false, activities: [] } });
  h.drain();
  h.activate("a");
  for (const cmd of ["left", "right", "up", "down"]) {
    assert.equal(e.execute("plastile.focus." + cmd).status, "noop", cmd);
    assert.equal(h.active, "a", cmd);
  }
});

// ------------------------------------------------------------- cross-output focus

/** Three outputs enumerated out of topology order: R (right), L (left), M (middle). */
function threeOutputs() {
  const h = new MockHost();
  h.outs = [
    { id: "R", name: "R", geometry: rect(2560, 0, 1280, 800), scale: 1 },
    { id: "L", name: "L", geometry: rect(0, 0, 1280, 800), scale: 1 },
    { id: "M", name: "M", geometry: rect(1280, 0, 1280, 800), scale: 1 },
  ];
  for (const o of h.outs) h.visible.set(o.id, "D1");
  const e = h.start();
  const on = (o: string, desk = "D1") => ({ membership: { output: o, desktops: [desk], onAllDesktops: false, activities: [] } });
  h.open("l1", on("L")); h.open("l2", on("L"));
  h.open("m1", on("M")); h.open("m2", on("M"));
  h.open("r1", on("R"));
  h.drain();
  return { h, e, on };
}

test("T23: focus.output-next/previous follow topology order, cyclic, not enumeration order", () => {
  const { h, e } = threeOutputs();
  h.activate("l1");
  const seq: Array<[string, string]> = [
    ["output-next", "m1"], ["output-next", "r1"], ["output-next", "l1"],
    ["output-previous", "r1"], ["output-previous", "m1"], ["output-previous", "l1"],
  ];
  const solves = e.counters.solves, writes = h.writes.length;
  for (const [cmd, want] of seq) {
    const r = e.execute("plastile.focus." + cmd);
    assert.equal(r.status, "accepted", cmd);
    assert.equal(h.active, want, `${cmd} -> ${want}`);
  }
  assert.equal(e.counters.solves, solves, "focus only: no solve");
  assert.equal(h.writes.length, writes, "focus only: no write");
});

test("T23: cross-output focus activates the most recently focused eligible window there", () => {
  const { h, e, on } = threeOutputs();
  h.activate("m2"); h.activate("m1"); h.activate("m2"); // m2 is the most recent on M
  h.activate("l2");
  assert.equal(e.execute("plastile.focus.output-next").status, "accepted");
  assert.equal(h.active, "m2", "most recent on M");
  // A floating window counts; a minimized or hidden one, or one on another desktop, does not.
  h.open("mf", { ...on("M"), meta: { ...h.windows.get("m1")!.meta, appId: "dlg", kind: "dialog" } });
  h.open("md", on("M", "D2"));
  h.drain();
  h.activate("mf"); h.activate("md");
  h.setStates("md", { minimized: true });
  h.activate("l1");
  e.execute("plastile.focus.output-next");
  assert.equal(h.active, "mf", "the floating dialog was the most recent eligible window on M");
  h.setStates("mf", { minimized: true });
  h.activate("l1");
  e.execute("plastile.focus.output-next");
  assert.equal(h.active, "m2", "minimized windows are skipped");
});

test("T23: cross-output focus without history takes the output's first tile; empty or single output is a no-op", () => {
  const { h, e } = threeOutputs();
  h.active = null; // nothing activated yet (no history): from the active output, which is R in the mock
  assert.equal(e.execute("plastile.focus.output-next").status, "accepted");
  assert.equal(h.active, "l1", "R -> L (cyclic); L has no history: its first tile");
  h.close("r1");
  h.drain();
  h.activate("m1");
  const r = e.execute("plastile.focus.output-next");
  assert.equal(r.status, "noop");
  assert.match(r.reason ?? "", /no window on output R/);
  const one = setup(["a", "b"]);
  one.h.activate("a");
  assert.equal(one.e.execute("plastile.focus.output-previous").reason, "no other output");
});

test("T23: send to output uses the same topology order", () => {
  const { h, e } = threeOutputs();
  h.activate("l1");
  e.execute("plastile.move.output-next");
  h.drain();
  assert.equal(h.windows.get("l1")!.membership.output, "M");
  h.activate("r1");
  e.execute("plastile.move.output-next");
  h.drain();
  assert.equal(h.windows.get("r1")!.membership.output, "L", "R wraps to L");
});

// ----------------------------------------------------------------- live resize

/** Resize the master's right edge interactively in `steps` frames, one event-loop turn each. */
function dragMasterEdge(h: MockHost, steps: number, by: number, drain = true) {
  const a0 = h.windows.get("a")!.frame;
  h.setStates("a", { interactive: "resize" });
  for (let i = 1; i <= steps; ++i) {
    h.userSetFrame("a", rect(a0.x, a0.y, a0.width + (by * i) / steps, a0.height));
    if (drain) h.drain();
  }
  return a0;
}

test("T29: liveResize off (default): peers do not move until release, then one commit", () => {
  const { h, e } = setup(["a", "b", "c"]);
  const b0 = h.windows.get("b")!.frame;
  const solves = e.counters.solves, writes = h.writes.length;
  dragMasterEdge(h, 5, 100);
  assert.equal(e.counters.solves, solves, "no solve during the resize");
  assert.equal(h.writes.length, writes, "no write during the resize");
  assert.ok(rectNear(h.windows.get("b")!.frame, b0));
  h.setStates("a", { interactive: "none" });
  h.drain();
  assert.equal(e.counters.solves, solves + 1, "one release commit");
  assert.equal(e.counters.liveSolves, 0);
});

test("T29: liveResize on: peers follow, one solve per turn, the resized window is never written", () => {
  const { h, e } = setup(["a", "b", "c"], { liveResize: true });
  const solves = e.counters.solves;
  const writes = h.writes.length;
  const a0 = dragMasterEdge(h, 5, 100);
  const a1 = h.windows.get("a")!.frame;
  const b1 = h.windows.get("b")!.frame, c1 = h.windows.get("c")!.frame;
  assert.equal(e.counters.liveSolves, 5, "one live solve per frame");
  assert.equal(e.counters.solves - solves, 5);
  assert.equal(b1.x, a1.x + a1.width + 8, "the stack follows the dragged edge");
  assert.equal(c1.x, b1.x);
  const during = h.writes.slice(writes);
  assert.ok(during.every((w) => w.id !== "a"), "the resized window is never written");
  assert.equal(during.length, 10, "two peers, five frames: only changed peers are written");
  // Release: the final ratio is committed once and matches the last live layout (no extra writes).
  const before = h.writes.length;
  h.setStates("a", { interactive: "none" });
  h.drain();
  assert.ok(Math.abs(h.windows.get("a")!.frame.width - (a0.width + 100)) <= 1);
  assert.equal(h.writes.slice(before).filter((w) => w.id !== "a").length, 0, "peers were already in place");
  assertTiling(frames(h, ["a", "b", "c"]), AREA);
  assert.equal(e.counters.liveSolves, 5, "no live solve after the release");
});

test("T29: frames within one event-loop turn coalesce into one live solve; an unchanged frame solves nothing", () => {
  const { h, e } = setup(["a", "b"], { liveResize: true });
  dragMasterEdge(h, 6, 120, false); // six frames, no turn in between
  h.drain();
  assert.equal(e.counters.liveSolves, 1, "one solve for one flush");
  const a = h.windows.get("a")!;
  h.userSetFrame("a", rect(a.frame.x + 0, a.frame.y, a.frame.width, a.frame.height)); // same frame: no signal in KWin either
  e.frameObserved("a", a.gen, a.frame);
  h.drain();
  assert.equal(e.counters.liveSolves, 1, "unchanged frame: no solve");
});

test("T29: cancel (KWin restores the start frame) puts peers back in their committed slots", () => {
  const { h, e } = setup(["a", "b"], { liveResize: true });
  const slots = frames(h, ["a", "b"]);
  dragMasterEdge(h, 3, 150);
  assert.ok(!rectNear(h.windows.get("b")!.frame, slots.get("b")!), "peer moved live");
  h.setStates("a", { interactive: "none" });
  h.userSetFrame("a", slots.get("a")!); // KWin restores the start geometry after reporting the end
  h.drain();
  assert.ok(rectNear(h.windows.get("b")!.frame, slots.get("b")!), "peer back in its slot");
  assert.ok(rectNear(h.windows.get("a")!.frame, slots.get("a")!));
  assert.equal(e.check().length, 0);
});

test("T29: live resize state is released on window removal, suspension and stop", () => {
  const { h, e } = setup(["a", "b", "c"], { liveResize: true });
  dragMasterEdge(h, 2, 80);
  h.close("a"); // closed mid-resize
  h.drain();
  assertTiling(frames(h, ["b", "c"]), AREA);
  // Suspend mid-resize: nothing is written for the pending frame.
  const s2 = setup(["a", "b"], { liveResize: true });
  const a0 = s2.h.windows.get("a")!.frame;
  s2.h.setStates("a", { interactive: "resize" });
  s2.e.execute("plastile.runtime.toggle-suspend");
  const w = s2.h.writes.length;
  s2.h.userSetFrame("a", rect(a0.x, a0.y, a0.width + 90, a0.height));
  s2.h.drain();
  assert.equal(s2.h.writes.length, w, "suspended: no live write");
  s2.e.stop();
  s2.h.userSetFrame("a", rect(a0.x, a0.y, a0.width + 120, a0.height));
  s2.h.drain();
  assert.equal(s2.h.writes.length, w, "stopped: no live write");
  assert.equal(e.counters.errors + s2.e.counters.errors, 0);
});

test("T29: monocle and floating layouts do not live-resize", () => {
  const { h, e } = setup(["a", "b"], { liveResize: true });
  h.activate("a");
  e.execute("plastile.layout.monocle");
  h.drain();
  dragMasterEdge(h, 3, 100);
  assert.equal(e.counters.liveSolves, 0);
});

// ------------------------------------------------------------------------- I05

test("I05: commands during an interactive resize run at once, in order; the release boundary wins", () => {
  for (const live of [false, true]) {
    const { h, e } = setup(["a", "b", "c"], { liveResize: live });
    h.activate("b");
    const a0 = h.windows.get("a")!.frame;
    h.setStates("a", { interactive: "resize" });
    h.userSetFrame("a", rect(a0.x, a0.y, a0.width + 60, a0.height));
    const order: string[] = [];
    for (const cmd of ["resize.grow", "focus.down", "swap.up", "resize.shrink", "focus.left", "layout.next", "layout.previous"]) {
      const r = e.execute("plastile." + cmd);
      assert.notEqual(r.reason, "queued during apply", `${cmd} is not queued behind the interaction`);
      order.push(`${cmd}:${r.status}`);
    }
    assert.equal(e.counters.commandsQueued, 0);
    const writesToA = h.writesTo("a");
    h.drain();
    assert.equal(h.writesTo("a"), writesToA, `live=${live}: the resized window is not written during the drag`);
    h.userSetFrame("a", rect(a0.x, a0.y, a0.width + 120, a0.height));
    h.drain();
    h.setStates("a", { interactive: "none" });
    h.drain();
    const a1 = h.windows.get("a")!.frame;
    assert.ok(Math.abs(a1.x + a1.width - (a0.x + a0.width + 120)) <= 1, `live=${live}: the released edge is committed (${JSON.stringify(a1)})`);
    assertTiling(frames(h, ["a", "b", "c"]), AREA);
    assert.equal(e.counters.errors, 0);
    assert.deepEqual(e.check(), []);
    assert.ok(order.every((x) => !x.endsWith(":rejected")), order.join(" "));
  }
});
