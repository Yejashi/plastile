// Output identity (T30, API_PROFILE E16) and context hygiene. The real KwinAdapter and runtime
// are driven through the fake KWin surface; oracles are the fake windows' frames, not engine claims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect } from "../../src/core/geometry.ts";
import { createRuntime } from "../../src/runtime/main.ts";
import { KwinAdapter, outputKeys } from "../../src/adapters/kwin/adapter.ts";
import { MockHost } from "./mockHost.ts";
import { assertTiling } from "./helpers.ts";
import { desktop, fakeEnv, FakeQt, FakeWorkspace, output, type FakeOutput, type FakeWindow, type R } from "./fakeKwin.ts";

function edid(name: string, g: R, manufacturer: string, model: string, serialNumber: string): FakeOutput {
  return { ...output(name, g), manufacturer, model, serialNumber };
}

const LEFT = { x: 0, y: 0, width: 1280, height: 800 };
const RIGHT = { x: 1280, y: 0, width: 1280, height: 800 };

function moveTo(ws: FakeWorkspace, w: FakeWindow, o: FakeOutput, frame: R): void {
  w.output = o;
  ws.kwinSetFrame(w, frame);
  w.outputChanged.emit();
}

function contexts(lines: string[], rt: ReturnType<typeof createRuntime>): Array<{ id: string; layout: string; members: number }> {
  rt.dispatch("plastile.inspect.counters");
  return JSON.parse(lines[lines.length - 1].replace(/^plastile counters /, "")).contexts;
}

test("E16: output keys use the EDID triple when KWin exposes it, the connector otherwise; twins are told apart by connector", () => {
  const keys = outputKeys([
    output("Virtual-1", LEFT),
    edid("DP-1", RIGHT, "Dell", "U2720Q", "ABC"),
    edid("DP-2", LEFT, "LG", "27UL", ""),
    edid("HDMI-A-1", RIGHT, "LG", "27UL", ""),
  ]);
  assert.deepEqual([...keys.entries()], [
    ["Virtual-1", { key: "Virtual-1", identity: "connector" }],
    ["DP-1", { key: "edid:Dell/U2720Q/ABC", identity: "edid" }],
    ["DP-2", { key: "edid:LG/27UL/@DP-2", identity: "ambiguous" }],
    ["HDMI-A-1", { key: "edid:LG/27UL/@HDMI-A-1", identity: "ambiguous" }],
  ]);
});

test("T30/O05: a monitor replugged on another connector gets its context and layout back", () => {
  const dell = edid("HDMI-A-1", RIGHT, "Dell", "U2720Q", "ABC");
  const ws = new FakeWorkspace([output("DP-1", LEFT), dell], [desktop("D1")]);
  const qt = new FakeQt();
  const wins = [1, 2, 3].map((i) => ws.window({ caption: `w${i}`, resourceClass: `app${i}`, output: i === 1 ? ws.screens[0] : dell,
    frameGeometry: i === 1 ? { x: 10, y: 10, width: 400, height: 300 } : { x: 1300 + 10 * i, y: 10, width: 400, height: 300 } }));
  for (const w of wins) ws.windows.push(w);
  const f = fakeEnv(ws, qt);
  const rt = createRuntime(f.env);
  qt.drain();
  assert.ok(contexts(f.lines, rt).some((c) => c.id.startsWith("edid:Dell/U2720Q/ABC␟")), "the context is keyed by EDID");
  ws.activeWindow = wins[1];
  ws.activeScreen = dell;
  rt.dispatch("plastile.layout.monocle");
  qt.drain();
  // Unplug: KWin moves the windows to the remaining output, then reports the new screen list.
  ws.screens = [ws.screens[0]];
  for (const w of [wins[1], wins[2]]) moveTo(ws, w, ws.screens[0], { x: 100, y: 100, width: 400, height: 300 });
  ws.screensChanged.emit();
  qt.drain();
  assertTiling(new Map(wins.map((w) => [w.caption, w.frameGeometry])), LEFT);
  // The same monitor comes back on another connector; KWin moves its windows back.
  const again = edid("DP-3", RIGHT, "Dell", "U2720Q", "ABC");
  ws.current.set("DP-3", ws.desktops[0]);
  ws.screens = [ws.screens[0], again];
  ws.screensChanged.emit();
  for (const w of [wins[1], wins[2]]) moveTo(ws, w, again, { x: 1300, y: 100, width: 400, height: 300 });
  qt.drain();
  for (const w of [wins[1], wins[2]]) {
    assert.deepEqual(w.frameGeometry, { x: 1288, y: 8, width: 1264, height: 784 }, `${w.caption}: monocle again on the same monitor`);
  }
  assert.deepEqual(wins[0].frameGeometry, { x: 8, y: 8, width: 1264, height: 784 });
  rt.shutdown();
});

test("T30: user overrides still match the connector name (outputName)", () => {
  const cfg = { configJson: JSON.stringify({ schemaVersion: 1, overrides: [{ id: "hdmi", match: { outputName: "HDMI-A-1" }, set: { gaps: { inner: 40 } } }] }) };
  const dell = edid("HDMI-A-1", LEFT, "Dell", "U2720Q", "ABC");
  const ws = new FakeWorkspace([dell], [desktop("D1")]);
  const qt = new FakeQt();
  const wins = [1, 2].map((i) => ws.window({ caption: `w${i}`, resourceClass: `app${i}` }));
  for (const w of wins) ws.windows.push(w);
  const rt = createRuntime(fakeEnv(ws, qt, cfg).env);
  qt.drain();
  const [a, b] = wins.map((w) => w.frameGeometry as R);
  assert.equal(b.x - (a.x + a.width), 40);
  rt.shutdown();
});

test("T30: a twin monitor appearing re-keys the first one's context; its windows keep order and stay tiled", () => {
  const lg = edid("DP-1", LEFT, "LG", "27UL", "");
  const ws = new FakeWorkspace([lg], [desktop("D1")]);
  const qt = new FakeQt();
  const wins = [1, 2, 3].map((i) => ws.window({ caption: `w${i}`, resourceClass: `app${i}` }));
  for (const w of wins) ws.windows.push(w);
  const f = fakeEnv(ws, qt);
  const rt = createRuntime(f.env);
  qt.drain();
  const before = wins.map((w) => w.frameGeometry);
  ws.current.set("DP-2", ws.desktops[0]);
  ws.screens = [lg, edid("DP-2", RIGHT, "LG", "27UL", "")];
  ws.screensChanged.emit();
  qt.drain();
  const ids = contexts(f.lines, rt).filter((c) => c.members > 0).map((c) => c.id.split("␟")[0]);
  assert.deepEqual(ids, ["edid:LG/27UL/@DP-1"]);
  assert.deepEqual(wins.map((w) => w.frameGeometry), before, "same order, same slots");
  const w4 = ws.window({ caption: "w4", resourceClass: "app4" });
  ws.add(w4);
  qt.drain();
  assertTiling(new Map([...wins, w4].map((w) => [w.caption, w.frameGeometry])), LEFT);
  rt.shutdown();
});

test("T30: the adapter resolves host operations by output key", () => {
  const dell = edid("HDMI-A-1", RIGHT, "Dell", "U2720Q", "ABC");
  const ws = new FakeWorkspace([output("DP-1", LEFT), dell], [desktop("D1")]);
  const a = new KwinAdapter(ws as never, new FakeQt() as never);
  const engine = new Proxy({}, { get: () => () => {} });
  a.attach(engine as never, false);
  assert.deepEqual(a.outputs().map((o) => [o.id, o.name]), [["DP-1", "DP-1"], ["edid:Dell/U2720Q/ABC", "HDMI-A-1"]]);
  assert.deepEqual(a.workArea("edid:Dell/U2720Q/ABC", "desk-D1"), RIGHT);
  assert.equal(a.workArea("HDMI-A-1", "desk-D1"), null, "the connector is not the key of an EDID output");
  assert.equal(a.outputNameOf("edid:Dell/U2720Q/ABC"), "HDMI-A-1");
  a.detach();
});

// --------------------------------------------------------------- context hygiene

test("T30: an emptied context is dropped; its layout preferences return when it is used again", () => {
  const h = new MockHost();
  const e = h.start();
  h.open("a"); h.open("b");
  h.drain();
  h.active = "a";
  e.execute("plastile.resize.grow");
  e.execute("plastile.layout.bsp");
  e.execute("plastile.layout.master-stack"); // back to the configured layout, ratio still the user's
  h.drain();
  const wide = h.windows.get("a")!.frame.width;
  h.close("a"); h.close("b");
  h.drain();
  assert.deepEqual(e.contextSummary(), [], "no empty context kept");
  assert.equal(e.contextPreferences().length, 1, "but its preferences are");
  h.open("c"); h.open("d");
  h.drain();
  assert.equal(h.windows.get("c")!.frame.width, wide, "the user's master ratio is back");
  assert.deepEqual(e.contextPreferences().map((p) => p.prefs.masterStack?.ratio !== undefined), [true]);
  // A context the user never tuned leaves nothing behind.
  h.close("c"); h.close("d");
  h.drain();
  e.execute("plastile.context.reset");
  h.open("x");
  h.close("x");
  h.drain();
  assert.deepEqual(e.contextSummary(), []);
  assert.deepEqual(e.contextPreferences(), [], "a reset context leaves nothing behind");
});

test("T30: retained context preferences are bounded", () => {
  const h = new MockHost();
  h.desks = Array.from({ length: 200 }, (_, i) => `D${i}`);
  const e = h.start();
  for (const d of h.desks) {
    h.visible.set("O1", d);
    e.visibilityChanged();
    h.open(`w-${d}`, { membership: { output: "O1", desktops: [d], onAllDesktops: false, activities: [] } });
    h.drain();
    h.active = `w-${d}`;
    e.execute("plastile.layout.monocle");
    h.close(`w-${d}`);
    h.drain();
  }
  assert.ok(e.contextPreferences().length <= 64, `retained ${e.contextPreferences().length}`);
  assert.ok(e.contextSummary().length <= 1, `contexts ${e.contextSummary().length}`);
  // The most recent ones are the ones kept.
  const last = e.contextPreferences().map((p) => p.key.desktop);
  assert.ok(last.includes("D199") && !last.includes("D0"), "the most recent are kept");
  // A retained preference still applies when its context is used again.
  h.visible.set("O1", "D199");
  e.visibilityChanged();
  h.open("p", { membership: { output: "O1", desktops: ["D199"], onAllDesktops: false, activities: [] } });
  h.open("q", { membership: { output: "O1", desktops: ["D199"], onAllDesktops: false, activities: [] } });
  h.drain();
  for (const id of ["p", "q"]) assert.ok(rect(8, 8, 1264, 784).width === h.windows.get(id)!.frame.width, `${id} in monocle`);
});
