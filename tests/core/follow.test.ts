// Follow on send (T24, BEHAVIOR §2: follow is opt-in and separate from send). Oracles: the
// mock's visible desktops, active window and frames; the fake KWin's per-output desktops.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect, rectNear } from "../../src/core/geometry.ts";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import type { ContextKey, ContextSettings } from "../../src/core/types.ts";
import { createRuntime } from "../../src/runtime/main.ts";
import { MockHost } from "./mockHost.ts";
import { desktop, fakeEnv, FakeQt, FakeWorkspace, output } from "./fakeKwin.ts";

const FOLLOW: ContextSettings = { ...DEFAULT_SETTINGS, followOnSend: true };
const FULL1 = rect(8, 8, 1264, 784);
const FULL2 = rect(1288, 8, 1264, 784);

function oneOutput(settingsFor?: (k: ContextKey) => ContextSettings) {
  const h = new MockHost();
  const e = h.start(settingsFor ? { settingsFor } : {});
  h.open("a"); h.open("b");
  h.drain();
  h.active = "b";
  return { h, e };
}

/** Two outputs with per-output desktops: O1 shows D1, O2 shows D2. */
function twoOutputs(settingsFor?: (k: ContextKey) => ContextSettings) {
  const h = new MockHost();
  h.perOutputDesktops = true;
  h.outs.push({ id: "O2", name: "O2", geometry: rect(1280, 0, 1280, 800), scale: 1 });
  h.visible.set("O2", "D2");
  const e = h.start(settingsFor ? { settingsFor } : {});
  h.open("a"); h.open("b");
  h.drain();
  h.active = "b";
  return { h, e };
}

test("T24: by default, send-to-desktop leaves the view and focus where they were", () => {
  const { h, e } = oneOutput();
  const activations = e.counters.activations;
  assert.equal(e.execute("plastile.move.desktop-next").status, "accepted");
  h.drain();
  assert.deepEqual(h.windows.get("b")!.membership.desktops, ["D2"]);
  assert.equal(h.visible.get("O1"), "D1", "the view stays");
  assert.deepEqual(h.shown, []);
  assert.equal(e.counters.activations, activations, "no activation");
  assert.ok(rectNear(h.windows.get("a")!.frame, FULL1), "the source reflowed");
});

test("T24: followOnSend shows the destination desktop and activates the sent window", () => {
  const { h, e } = oneOutput(() => FOLLOW);
  h.active = "b";
  assert.equal(e.execute("plastile.move.desktop-next").status, "accepted");
  assert.deepEqual(h.shown, [{ output: "O1", desktop: "D2" }], "shown on the window's output, within the command");
  assert.equal(h.active, "b");
  h.drain();
  assert.equal(h.visible.get("O1"), "D2");
  assert.ok(rectNear(h.windows.get("b")!.frame, FULL1), `b tiled on D2: ${JSON.stringify(h.windows.get("b")!.frame)}`);
});

test("T24: send-to-output never switches the target output's desktop: KWin moves the window onto it", () => {
  // KWin keeps an interactively sent window on the destination's current desktop, so it is
  // visible there with or without follow; follow adds only the activation.
  for (const settingsFor of [undefined, () => FOLLOW]) {
    const { h, e } = twoOutputs(settingsFor);
    const activations = e.counters.activations;
    assert.equal(e.execute("plastile.move.output-next").status, "accepted");
    h.drain();
    const b = h.windows.get("b")!;
    assert.equal(b.membership.output, "O2");
    assert.deepEqual(b.membership.desktops, ["D2"], "KWin put it on O2's current desktop");
    assert.deepEqual(h.shown, [], "no desktop switch");
    assert.equal(h.visible.get("O2"), "D2");
    assert.ok(rectNear(b.frame, FULL2), `b tiled on O2: ${JSON.stringify(b.frame)}`);
    assert.ok(rectNear(h.windows.get("a")!.frame, FULL1));
    assert.equal(e.counters.activations - activations, settingsFor ? 1 : 0, "follow activates the window");
  }
});

test("T24: the follow decision is the source context's (an override for one output)", () => {
  const h = new MockHost();
  const e = h.start({ settingsFor: (k) => (k.desktop === "D2" ? FOLLOW : DEFAULT_SETTINGS) });
  h.open("a"); h.open("b");
  h.drain();
  h.active = "b";
  e.execute("plastile.move.desktop-next"); // from D1, which does not follow, to D2, which would
  h.drain();
  assert.deepEqual(h.shown, []);
  assert.equal(h.visible.get("O1"), "D1");
});

test("T24: through the runtime, followOnSend switches the output's desktop and activates (fake KWin)", () => {
  const cfg = { configJson: JSON.stringify({ schemaVersion: 1, defaults: { followOnSend: true } }) };
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1", 1), desktop("D2", 2)]);
  const qt = new FakeQt();
  const wins = [1, 2].map((i) => ws.window({ caption: `w${i}`, resourceClass: `app${i}` }));
  for (const w of wins) ws.windows.push(w);
  const rt = createRuntime(fakeEnv(ws, qt, cfg).env);
  qt.drain();
  ws.activeWindow = wins[1];
  rt.dispatch("plastile.move.desktop-next");
  qt.drain();
  assert.equal(ws.current.get("O1")!.name, "D2", "the desktop is shown");
  assert.equal(ws.activeWindow, wins[1], "and the window activated");
  assert.deepEqual(wins[1].frameGeometry, { x: 8, y: 8, width: 1264, height: 784 }, "tiled alone on D2");
  rt.shutdown();
});
