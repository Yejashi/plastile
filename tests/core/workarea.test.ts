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
