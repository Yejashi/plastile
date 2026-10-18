// Work-area invalidation (O07) at the engine level, with the mock compositor.
// Oracles are the mock compositor's committed frames and write log, not engine claims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect, type Rect } from "../../src/core/geometry.ts";
import { MockHost } from "./mockHost.ts";
import { assertTiling } from "./helpers.ts";

function writesSince(h: MockHost, n: number): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of h.writes.slice(n)) m.set(w.id, (m.get(w.id) ?? 0) + 1);
  return m;
}

function frames(h: MockHost, ids: string[]): Map<string, Rect> {
  return new Map(ids.map((id) => [id, h.windows.get(id)!.frame] as const));
}

test("O07: a tile KWin moved off a new panel is re-solved once, never corrected back to its old slot", () => {
  const h = new MockHost();
  h.start();
  for (const id of ["a", "b", "c"]) h.open(id, { delay: 30 });
  h.advance(100);
  const area = rect(0, 0, 1280, 760);
  // KWin's rearrange: the area shrinks and checkWorkspacePosition moves the tiles that
  // intersect the new strut (observed as external changes) before the panel is announced.
  h.areas.set("O1/D1", area);
  for (const id of ["a", "c"]) {
    const f = h.windows.get(id)!.frame;
    h.userSetFrame(id, rect(f.x, f.y, f.width, 760 - f.y));
  }
  const n = h.writes.length;
  h.engine.workAreaChanged(["O1"]);
  h.advance(200);
  for (const [id, k] of writesSince(h, n)) assert.equal(k, 1, `${id} written ${k} times`);
  for (const w of h.writes.slice(n)) {
    assert.ok(w.target.y + w.target.height <= 760, `no write toward the old area: ${JSON.stringify(w.target)}`);
  }
  assertTiling(frames(h, ["a", "b", "c"]), area);
  assert.equal(h.engine.outstandingCount(), 0);
});

test("O07: workAreaChanged re-solves only the named outputs' contexts", () => {
  const h = new MockHost();
  h.outs = [
    { id: "O1", name: "O1", geometry: rect(0, 0, 1280, 800), scale: 1 },
    { id: "O2", name: "O2", geometry: rect(1280, 0, 1280, 800), scale: 1 },
  ];
  h.visible.set("O2", "D1");
  h.start();
  h.open("a");
  h.open("b", { membership: { output: "O2", desktops: ["D1"], onAllDesktops: false, activities: [] } });
  h.open("c", { membership: { output: "O2", desktops: ["D1"], onAllDesktops: false, activities: [] } });
  h.advance(10);
  const n = h.writes.length;
  // Both areas change, only O2 is reported: O1 must not be touched by this call.
  h.areas.set("O1/D1", rect(0, 0, 1280, 700));
  h.areas.set("O2/D1", rect(1280, 0, 1280, 760));
  h.engine.workAreaChanged(["O2"]);
  h.advance(10);
  const w = writesSince(h, n);
  assert.equal(w.get("a") ?? 0, 0);
  assert.equal(w.get("b"), 1);
  assert.equal(w.get("c"), 1);
  assertTiling(frames(h, ["b", "c"]), rect(1280, 0, 1280, 760));
});

test("O07: a panel going away gives an overflow float one new attempt (BEHAVIOR §11)", () => {
  const h = new MockHost();
  h.areas.set("O1/D1", rect(0, 0, 1280, 500));
  h.start();
  const min = { minFrame: { width: 0, height: 300 }, maxFrame: { width: Infinity, height: Infinity }, fixed: false };
  for (const id of ["a", "b", "c"]) h.open(id, { constraints: min });
  h.advance(10);
  // Stack of b and c needs 2 x 300 + gaps: c does not fit in 500 px and floats.
  assert.equal(h.engine.modeOf("c"), "floating");
  const n = h.writes.length;
  h.areas.set("O1/D1", rect(0, 0, 1280, 800));
  h.engine.workAreaChanged(["O1"]);
  h.advance(10);
  assert.equal(h.engine.modeOf("c"), "tiled");
  assert.ok(h.writes.slice(n).some((w) => w.id === "c"), "c is placed into a slot");
  assertTiling(frames(h, ["a", "b", "c"]), rect(0, 0, 1280, 800));
});

test("an external change is still corrected once when its context is not being re-solved", () => {
  const h = new MockHost();
  h.start();
  for (const id of ["a", "b"]) h.open(id);
  h.advance(10);
  const slot = h.windows.get("b")!.frame;
  const n = h.writes.length;
  h.userSetFrame("b", rect(slot.x + 5, slot.y, slot.width - 40, slot.height));
  h.advance(10);
  assert.deepEqual(h.writes.slice(n).map((x) => x.id), ["b"]);
  assert.deepEqual(h.windows.get("b")!.frame, slot);
});

// Hidden contexts (physical runbook, KWin 6.7.5): a panel added while another desktop is shown.
// KWin's own work-area check moves the windows of the hidden desktop into the new area (trace:
// external {frame: x 4480 w 1872, desired: x 4488 w 1904}). Plastile must not write to a window
// whose context is not shown: the observation invalidates its context, which is re-solved with
// the new area when shown. No correction is spent and nothing diverges.

/** Two tiled windows on D1, then D2 shown. Returns the host and D1's original slots. */
function hiddenD1(): { h: MockHost; slots: Map<string, Rect> } {
  const h = new MockHost();
  h.start();
  for (const id of ["a", "b"]) h.open(id);
  h.advance(10);
  const slots = frames(h, ["a", "b"]);
  h.showDesktop("O1", "D2");
  h.advance(10);
  return { h, slots };
}

/** KWin's checkWorkspacePosition: confine a hidden window to the shrunk area (x and width). */
function kwinConfine(h: MockHost, id: string, area: Rect): void {
  const f = h.windows.get(id)!.frame;
  const right = Math.min(f.x + f.width, area.x + area.width);
  const x = Math.max(area.x, Math.min(f.x, right - 1));
  h.userSetFrame(id, rect(x, f.y, right - x, f.height));
}

for (const order of ["area-first", "kwin-first"] as const) {
  test(`hidden work-area change (${order}): no write, correction or divergence while hidden; tiled into the new area when shown`, () => {
    const { h } = hiddenD1();
    const c0 = { ...h.engine.counters };
    const n = h.writes.length;
    const area = rect(0, 0, 1232, 800); // a 48 px panel on the right edge
    h.areas.set("O1/D1", area);
    h.areas.set("O1/D2", area);
    if (order === "area-first") {
      // The physical order: the area-change flush runs, then KWin's rearrange moves the hidden tiles.
      h.engine.workAreaChanged(["O1"]);
      h.advance(10);
      for (const id of ["a", "b"]) kwinConfine(h, id, area);
    } else {
      for (const id of ["a", "b"]) kwinConfine(h, id, area);
      h.engine.workAreaChanged(["O1"]);
    }
    h.advance(5000); // past every convergence deadline
    assert.equal(h.writes.length, n, `no write while hidden: ${JSON.stringify(h.writes.slice(n))}`);
    assert.equal(h.engine.counters.corrections, c0.corrections);
    assert.equal(h.engine.counters.diverged, c0.diverged);
    for (const id of ["a", "b"]) assert.equal(h.engine.explain(id)!.exception, null, `${id} explained as normal`);
    h.showDesktop("O1", "D1");
    h.advance(10);
    assertTiling(frames(h, ["a", "b"]), area);
    assert.equal(h.engine.counters.corrections, c0.corrections, "the show-time solve is a plan, not a correction");
    for (const [id, k] of writesSince(h, n)) assert.equal(k, 1, `${id} written ${k} times`);
    assert.equal(h.engine.counters.diverged, c0.diverged);
    assert.equal(h.engine.outstandingCount(), 0);
  });
}

test("an external move of a hidden window is not corrected while hidden; it is re-tiled when shown", () => {
  const { h, slots } = hiddenD1();
  const c0 = { ...h.engine.counters };
  const n = h.writes.length;
  const s = slots.get("b")!;
  // Three times: more than the correction budget would allow if each counted.
  h.userSetFrame("b", rect(s.x + 30, s.y + 20, s.width - 60, s.height - 40));
  h.advance(5000);
  h.userSetFrame("b", rect(s.x + 10, s.y + 10, s.width - 90, s.height - 50));
  h.advance(5000);
  h.userSetFrame("b", rect(s.x + 15, s.y + 10, s.width - 70, s.height - 50));
  h.advance(5000);
  assert.equal(h.writes.length, n, "no write while hidden");
  assert.equal(h.engine.counters.diverged, c0.diverged);
  assert.equal(h.engine.counters.corrections, c0.corrections);
  h.showDesktop("O1", "D1");
  h.advance(10);
  assert.deepEqual(writesSince(h, n), new Map([["b", 1]]));
  assert.deepEqual(frames(h, ["a", "b"]), slots);
  assert.equal(h.engine.counters.diverged, c0.diverged);
});

test("an output resolution change while hidden: KWin's move is not corrected; tiled into the new geometry when shown", () => {
  const { h } = hiddenD1();
  const c0 = { ...h.engine.counters };
  const n = h.writes.length;
  const geo = rect(0, 0, 1024, 768);
  h.outs = [{ ...h.outs[0], geometry: geo }];
  h.engine.topologyChanged();
  h.advance(10);
  for (const id of ["a", "b"]) kwinConfine(h, id, geo);
  h.advance(5000);
  assert.equal(h.writes.length, n, "no write while hidden");
  assert.equal(h.engine.counters.corrections, c0.corrections);
  assert.equal(h.engine.counters.diverged, c0.diverged);
  h.showDesktop("O1", "D1");
  h.advance(10);
  assertTiling(frames(h, ["a", "b"]), geo);
  for (const [id, k] of writesSince(h, n)) assert.equal(k, 1, `${id} written ${k} times`);
});

test("a correction queued while shown is not written once its desktop is hidden before the flush", () => {
  const h = new MockHost();
  h.start();
  for (const id of ["a", "b"]) h.open(id);
  h.advance(10);
  const slots = frames(h, ["a", "b"]);
  const s = slots.get("b")!;
  const n = h.writes.length;
  h.userSetFrame("b", rect(s.x + 5, s.y, s.width - 40, s.height)); // queues a correction
  h.showDesktop("O1", "D2"); // in the same event-loop turn
  h.advance(5000);
  assert.equal(h.writes.length, n, "no write after the switch");
  h.showDesktop("O1", "D1");
  h.advance(10);
  assert.deepEqual(writesSince(h, n), new Map([["b", 1]]));
  assert.deepEqual(frames(h, ["a", "b"]), slots);
});

test("a hidden window whose correction budget was spent while shown does not diverge on a KWin move", () => {
  const h = new MockHost();
  h.start();
  h.open("a");
  h.open("b", { delay: 1600 }); // slower than two deadlines: corrected twice, then it commits
  h.advance(3000);
  assert.equal(h.engine.explain("b")!.ledger && (h.engine.explain("b")!.ledger as { corrections: number }).corrections, 2);
  assert.equal(h.engine.counters.diverged, 0);
  h.showDesktop("O1", "D2");
  h.advance(10);
  const n = h.writes.length;
  const area = rect(0, 0, 1232, 800);
  h.areas.set("O1/D1", area);
  h.engine.workAreaChanged(["O1"]);
  h.advance(10);
  kwinConfine(h, "b", area);
  h.advance(5000);
  assert.equal(h.writes.length, n, "no write while hidden");
  assert.equal(h.engine.counters.diverged, 0, "a KWin move of a hidden window is not the application fighting");
  assert.equal(h.engine.explain("b")!.exception, null);
  h.showDesktop("O1", "D1");
  h.advance(5000);
  assertTiling(frames(h, ["a", "b"]), area);
  assert.equal(h.engine.counters.diverged, 0);
});

test("a request outstanding when its desktop is hidden is neither corrected, learned nor diverged at its deadline", () => {
  const h = new MockHost();
  h.start();
  h.open("a");
  h.open("b", { delay: 400 }); // a slow client: its first configure is still in flight
  h.advance(1);
  const n = h.writes.length;
  const c0 = { ...h.engine.counters };
  h.showDesktop("O1", "D2");
  // KWin confines the hidden window before its client answers (the configure is lost with it).
  const area = rect(0, 0, 1232, 800);
  h.areas.set("O1/D1", area);
  h.windows.get("b")!.configures = [];
  kwinConfine(h, "b", area);
  h.engine.workAreaChanged(["O1"]);
  h.advance(5000);
  assert.equal(h.writes.length, n, "no write while hidden");
  assert.equal(h.engine.counters.corrections, c0.corrections);
  assert.equal(h.engine.counters.diverged, c0.diverged);
  assert.equal(h.engine.counters.learned, c0.learned, "KWin's confinement is not the client's constraint");
  assert.equal(h.engine.explain("b")!.learnedMax, null);
  assert.equal(h.engine.outstandingCount(), 0, "the deadline is not left armed");
  h.showDesktop("O1", "D1");
  h.advance(1000);
  assertTiling(frames(h, ["a", "b"]), area);
  assert.equal(h.engine.counters.diverged, c0.diverged);
});

test("a visible context's external drift still gets its bounded correction, then diverges (no regression)", () => {
  const { h, slots } = hiddenD1();
  h.showDesktop("O1", "D1");
  h.advance(10);
  const s = slots.get("b")!;
  const n = h.writes.length;
  const c0 = { ...h.engine.counters };
  h.windows.get("b")!.ignore = true; // the client keeps its own size whatever is requested
  h.userSetFrame("b", rect(s.x, s.y, s.width - 40, s.height));
  h.advance(5000);
  const k = writesSince(h, n).get("b") ?? 0;
  assert.ok(k >= 1 && k <= 2, `bounded corrections: ${k}`);
  assert.ok(h.engine.counters.corrections > c0.corrections);
  assert.equal(h.engine.counters.diverged, c0.diverged + 1);
});
