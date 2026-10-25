// D6: a float rectangle belongs to the output (and work area) it was taken on. Engine replay
// with the mock compositor; the oracle is the mock's committed frames, not engine claims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { centredDefault, clampInto, contains, rect, rectNear, relocate, type Rect } from "../../src/core/geometry.ts";
import { MockHost } from "./mockHost.ts";

const O1 = rect(0, 0, 1280, 800);
const O2 = rect(1280, 0, 1920, 1080);
const FREE_SIZE = { width: 0, height: 0 };
const NO_MAX = { width: Infinity, height: Infinity };

function twoOutputs(ids = ["a", "b"]) {
  const h = new MockHost();
  h.outs = [{ id: "O1", name: "O1", geometry: O1, scale: 1 }, { id: "O2", name: "O2", geometry: O2, scale: 1 }];
  h.visible.set("O2", "D1");
  const e = h.start();
  for (const id of ids) h.open(id);
  h.drain();
  h.active = "b";
  return { h, e };
}

function frame(h: MockHost, id: string): Rect {
  return h.windows.get(id)!.frame;
}

test("geometry: clampInto, relocate and the centred default stay inside the area", () => {
  assert.deepEqual(clampInto(rect(-50, 700, 300, 200), O1), rect(0, 600, 300, 200));
  assert.deepEqual(clampInto(rect(10, 10, 2000, 900), O1), rect(0, 0, 1280, 800), "larger than the area: shrunk to it");
  // The centre keeps its relative position: (550, 400) is (0.4297, 0.5) of O1.
  assert.deepEqual(relocate(rect(300, 200, 500, 400), O1, O2), rect(1855, 340, 500, 400));
  // A rectangle near the far edge stays inside the smaller area.
  const r = relocate(rect(3000, 900, 600, 400), O2, O1);
  assert.ok(contains(O1, r), JSON.stringify(r));
  assert.deepEqual(centredDefault(O1, FREE_SIZE, NO_MAX), rect(256, 160, 768, 480));
  assert.deepEqual(centredDefault(O1, { width: 1000, height: 100 }, NO_MAX), rect(140, 160, 1000, 480), "minimum respected");
  assert.deepEqual(centredDefault(O1, { width: 5000, height: 0 }, NO_MAX), rect(0, 160, 1280, 480), "never larger than the area");
  assert.deepEqual(centredDefault(O1, FREE_SIZE, { width: 400, height: 300 }), rect(440, 250, 400, 300), "maximum respected");
});

test("D6: float on O1, tile, send to O2, float again: restored inside O2, proportionally placed", () => {
  const { h, e } = twoOutputs();
  e.execute("plastile.window.toggle-float");
  h.drain();
  h.userSetFrame("b", rect(300, 200, 500, 400));
  e.execute("plastile.window.toggle-float"); // tiled again, on O1
  h.drain();
  assert.equal(e.modeOf("b"), "tiled");
  assert.equal(e.execute("plastile.move.output-next").status, "accepted");
  h.drain();
  assert.equal(h.windows.get("b")!.membership.output, "O2");
  assert.ok(contains(O2, frame(h, "b")), `tiled on O2: ${JSON.stringify(frame(h, "b"))}`);
  e.execute("plastile.window.toggle-float");
  h.drain();
  assert.equal(e.modeOf("b"), "floating");
  assert.ok(rectNear(frame(h, "b"), rect(1855, 340, 500, 400)), `restored inside O2: ${JSON.stringify(frame(h, "b"))}`);
});

test("D6: on the output it was taken on, the float rectangle is restored exactly (L08)", () => {
  const { h, e } = twoOutputs();
  e.execute("plastile.window.toggle-float");
  h.drain();
  h.userSetFrame("b", rect(-100, 200, 500, 400)); // partly off the output: the user's choice
  e.execute("plastile.window.toggle-float");
  h.drain();
  e.execute("plastile.window.toggle-float");
  h.drain();
  assert.ok(rectNear(frame(h, "b"), rect(-100, 200, 500, 400)), JSON.stringify(frame(h, "b")));
});

test("D6: a tiled window floated without a float rectangle gets the bounded centred default of its output", () => {
  const { h, e } = twoOutputs();
  e.execute("plastile.move.output-next");
  h.drain();
  e.execute("plastile.window.toggle-float");
  h.drain();
  assert.equal(e.modeOf("b"), "floating");
  assert.ok(rectNear(frame(h, "b"), centredDefault(O2, FREE_SIZE, NO_MAX)), JSON.stringify(frame(h, "b")));
});

test("D6: after its output is unplugged, a float rectangle taken there is placed inside the remaining output", () => {
  const { h, e } = twoOutputs();
  e.execute("plastile.move.output-next");
  h.drain();
  e.execute("plastile.window.toggle-float");
  h.drain();
  h.userSetFrame("b", rect(2600, 500, 400, 300)); // float rectangle on O2
  e.execute("plastile.window.toggle-float"); // tiled on O2
  h.drain();
  // Unplug O2: KWin moves the window to O1 and reports the new screen list.
  const b = h.windows.get("b")!;
  h.outs = [h.outs[0]];
  h.visible.delete("O2");
  b.membership = { ...b.membership, output: "O1" };
  h.userSetFrame("b", rect(100, 100, 400, 300));
  e.membershipChanged("b", b.gen, b.membership);
  e.topologyChanged();
  h.drain();
  assert.equal(e.modeOf("b"), "tiled");
  e.execute("plastile.window.toggle-float");
  h.drain();
  // Centre (2800, 650) is (0.7917, 0.6019) of O2: in O1 that is (1013.3, 481.5).
  assert.ok(rectNear(frame(h, "b"), rect(813, 331, 400, 300)), JSON.stringify(frame(h, "b")));
  assert.ok(contains(O1, frame(h, "b")));
});

test("D6: KWin moving a floating window to another output re-anchors its float rectangle there", () => {
  const { h, e } = twoOutputs();
  e.execute("plastile.window.toggle-float");
  h.drain();
  const b = h.windows.get("b")!;
  // KWin reports the frame before the output change (a drag across outputs).
  h.userSetFrame("b", rect(1500, 100, 500, 400));
  b.membership = { ...b.membership, output: "O2" };
  e.membershipChanged("b", b.gen, b.membership);
  h.drain();
  e.execute("plastile.window.toggle-float"); // tiled on O2
  h.drain();
  e.execute("plastile.window.toggle-float");
  h.drain();
  assert.ok(rectNear(frame(h, "b"), rect(1500, 100, 500, 400)), `same output: exact rectangle, ${JSON.stringify(frame(h, "b"))}`);
});

test("D6: an output that moved keeps its float rectangles at the same place on it (a neighbour's resolution changed)", () => {
  const h = new MockHost();
  h.outs = [{ id: "A", name: "A", geometry: rect(0, 0, 1920, 1080), scale: 1 }, { id: "B", name: "B", geometry: rect(1920, 0, 1920, 1080), scale: 1 }];
  h.visible = new Map([["A", "D1"], ["B", "D1"]]);
  const e = h.start();
  const onB = { output: "B", desktops: ["D1"], onAllDesktops: false, activities: [] };
  h.open("p", { membership: onB }); h.open("w", { membership: onB });
  h.drain();
  h.active = "w";
  e.execute("plastile.window.toggle-float");
  h.drain();
  h.userSetFrame("w", rect(2000, 100, 800, 600));
  e.execute("plastile.window.toggle-float"); // tiled on B: the float rectangle (2000,100) on B is remembered
  h.drain();
  // A becomes 2560x1440: KWin moves B to x=2560.
  const moved = [{ id: "A", name: "A", geometry: rect(0, 0, 2560, 1440), scale: 1 }, { id: "B", name: "B", geometry: rect(2560, 0, 1920, 1080), scale: 1 }];
  h.outs = moved;
  e.topologyChanged();
  h.drain();
  e.execute("plastile.window.toggle-float");
  h.drain();
  assert.ok(rectNear(frame(h, "w"), rect(2640, 100, 800, 600)), `same place on B: ${JSON.stringify(frame(h, "w"))}`);
  // A preference saved before the move is placed the same way.
  const h2 = new MockHost();
  h2.outs = moved;
  h2.visible = new Map([["A", "D1"], ["B", "D1"]]);
  const e2 = h2.start();
  e2.restoreFloats([{ app: { appId: "w", resourceName: "w", role: "" },
    float: { rect: rect(1940, 100, 800, 600), output: "B", area: rect(1920, 0, 1920, 1080) }, window: "" }]);
  h2.open("w", { membership: onB });
  h2.drain();
  assert.equal(e2.modeOf("w"), "floating");
  assert.ok(rectNear(h2.windows.get("w")!.frame, rect(2580, 100, 800, 600)), `same place on B: ${JSON.stringify(h2.windows.get("w")!.frame)}`);
});

test("D6/E04: floating a window again while its tile configure is in flight puts it back at its float rectangle", () => {
  const F = rect(300, 200, 500, 400);
  const toTileAndBack = (delay: number) => {
    const { h, e } = twoOutputs();
    h.windows.get("b")!.delay = delay;
    e.execute("plastile.window.toggle-float");
    h.drain();
    h.advance(500);
    h.userSetFrame("b", F);
    e.execute("plastile.window.toggle-float"); // tiled: its configure is in flight for `delay` ms
    h.drain();
    h.advance(50);
    e.execute("plastile.window.toggle-float"); // floating again before the client committed the tile
    h.drain();
    return { h, e };
  };
  for (const delay of [0, 200]) {
    const { h, e } = toTileAndBack(delay);
    h.advance(2000);
    assert.equal(e.modeOf("b"), "floating");
    assert.ok(rectNear(frame(h, "b"), F), `delay ${delay}: at its float rectangle, not its old tile: ${JSON.stringify(frame(h, "b"))}`);
    assert.deepEqual(e.floatPreferences().map((p) => p.float.rect), [F], `delay ${delay}: the saved preference is unchanged`);
  }
  {
    // Tiled again before the restore was written: the plan owns it, nothing is restored.
    const { h, e } = toTileAndBack(200);
    e.execute("plastile.window.toggle-float");
    h.drain();
    h.advance(2000);
    assert.equal(e.modeOf("b"), "tiled");
    assert.ok(rectNear(frame(h, "b"), rect(707, 8, 565, 784)), JSON.stringify(frame(h, "b")));
    assert.equal(e.outstandingCount(), 0);
  }
  {
    // A client that never commits the tile: the wait ends at the request's deadline, and the user's next placement
    // is its float rectangle again.
    const { h, e } = toTileAndBack(100_000);
    h.advance(2000);
    assert.equal(e.modeOf("b"), "floating");
    h.userSetFrame("b", rect(400, 300, 500, 400));
    assert.deepEqual(e.floatPreferences().map((p) => p.float.rect), [rect(400, 300, 500, 400)]);
  }
});
