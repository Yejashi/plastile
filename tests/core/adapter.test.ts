// The real KwinAdapter and runtime driven through a fake KWin script surface (fakeKwin.ts).
// Oracles are the fake windows' frames and the script write log, never engine claims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../../src/runtime/main.ts";
import { KwinAdapter } from "../../src/adapters/kwin/adapter.ts";
import { desktop, fakeEnv, FakeQt, FakeWorkspace, output, type FakeWindow, type R } from "./fakeKwin.ts";

const GAP = 8;

function bottomOf(r: R): number { return r.y + r.height; }

/** Oracle: inside `area` with at least GAP to its edges, no two frames overlapping. */
function assertTiles(wins: FakeWindow[], area: R): void {
  const fs = wins.map((w) => w.frameGeometry as R);
  for (const [i, f] of fs.entries()) {
    const name = wins[i].caption;
    assert.ok(f.x >= area.x + GAP - 0.5 && f.y >= area.y + GAP - 0.5, `${name} too close to the area edge ${JSON.stringify(f)}`);
    assert.ok(f.x + f.width <= area.x + area.width - GAP + 0.5 && bottomOf(f) <= bottomOf(area) - GAP + 0.5,
      `${name} outside ${JSON.stringify(area)}: ${JSON.stringify(f)}`);
  }
  for (let i = 0; i < fs.length; ++i)
    for (let j = i + 1; j < fs.length; ++j) {
      const a = fs[i], b = fs[j];
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const oy = Math.min(bottomOf(a), bottomOf(b)) - Math.max(a.y, b.y);
      assert.ok(ox <= 0.5 || oy <= 0.5, `${wins[i].caption} overlaps ${wins[j].caption}`);
    }
}

function writesPerWindow(ws: FakeWorkspace, since: number): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of ws.writes.slice(since)) m.set(w.caption, (m.get(w.caption) ?? 0) + 1);
  return m;
}

function setup(outputs = 1, n = 3, cfg: Record<string, unknown> = {}) {
  const outs = [output("O1", { x: 0, y: 0, width: 1280, height: 800 })];
  if (outputs > 1) outs.push(output("O2", { x: 1280, y: 0, width: 1280, height: 800 }));
  const ws = new FakeWorkspace(outs, [desktop("D1")]);
  const qt = new FakeQt();
  const wins: FakeWindow[] = [];
  for (let i = 1; i <= n; ++i) {
    const w = ws.window({ caption: `w${i}`, resourceClass: `app${i}`, frameGeometry: { x: 20 * i, y: 20 * i, width: 400, height: 300 } });
    ws.windows.push(w);
    wins.push(w);
  }
  const f = fakeEnv(ws, qt, cfg);
  const rt = createRuntime(f.env);
  qt.drain();
  return { ws, qt, wins, rt, f };
}

// ------------------------------------------------------------------ O07 work areas

test("O07: a panel added after load re-solves once into the new area, each tile written at most once", () => {
  const { ws, qt, wins, rt } = setup();
  const area = { x: 0, y: 0, width: 1280, height: 760 };
  // KWin's addWaylandWindow: rearrange() (new area, checkWorkspacePosition moves tiles that
  // intersect the strut) runs synchronously BEFORE windowAdded is emitted.
  ws.areas.set("O1", area);
  for (const w of wins) {
    const f = w.frameGeometry as R;
    if (bottomOf(f) > bottomOf(area)) ws.kwinSetFrame(w, { ...f, height: bottomOf(area) - f.y });
  }
  const before = ws.writes.length;
  ws.add(ws.panel({ frameGeometry: { x: 0, y: 760, width: 1280, height: 40 } }));
  qt.drain();
  assertTiles(wins, area);
  const lowest = Math.max(...wins.map((w) => bottomOf(w.frameGeometry)));
  assert.equal(lowest, bottomOf(area) - GAP, "lowest tile bottom == area bottom - gap");
  for (const [cap, n] of writesPerWindow(ws, before)) assert.ok(n <= 1, `${cap} written ${n} times`);
  rt.shutdown();
});

test("O07: a panel removed restores the area even when KWin's rearrange runs after the first deferred turn", () => {
  const { ws, qt, wins, rt } = setup();
  const reduced = { x: 0, y: 0, width: 1280, height: 760 };
  ws.areas.set("O1", reduced);
  const panel = ws.panel({ frameGeometry: { x: 0, y: 760, width: 1280, height: 40 } });
  ws.add(panel);
  qt.drain();
  assertTiles(wins, reduced);
  const before = ws.writes.length;
  // removeWindow(): scheduleRearrange() is a 0 ms timer; here it lands after the adapter's
  // first deferred turn (worst case), so the area is still the reduced one at that turn.
  ws.remove(panel);
  qt.turn();
  ws.areas.delete("O1");
  qt.drain();
  const full = { x: 0, y: 0, width: 1280, height: 800 };
  assertTiles(wins, full);
  assert.equal(Math.max(...wins.map((w) => bottomOf(w.frameGeometry))), 800 - GAP);
  for (const [cap, n] of writesPerWindow(ws, before)) assert.ok(n <= 1, `${cap} written ${n} times`);
  rt.shutdown();
});

test("O07: a panel on one output re-solves only that output (zero writes to the other)", () => {
  const { ws, qt, wins, rt } = setup(2, 3);
  // w2 and w3 go to O2.
  for (const w of [wins[1], wins[2]]) { w.output = ws.screens[1]; w.outputChanged.emit(); }
  qt.drain();
  const o2 = { x: 1280, y: 0, width: 1280, height: 760 };
  const w1Before = wins[0].frameGeometry;
  ws.areas.set("O2", o2);
  const before = ws.writes.length;
  ws.add(ws.panel({ output: ws.screens[1], frameGeometry: { x: 1280, y: 760, width: 1280, height: 40 } }));
  qt.drain();
  assertTiles([wins[1], wins[2]], o2);
  assert.deepEqual(wins[0].frameGeometry, w1Before);
  assert.equal(writesPerWindow(ws, before).get("w1") ?? 0, 0, "no write to the other output's tile");
  rt.shutdown();
});

test("O07: a panel's own frame change without an area change writes nothing", () => {
  const { ws, qt, rt } = setup();
  ws.areas.set("O1", { x: 48, y: 0, width: 1232, height: 800 });
  const left = ws.panel({ frameGeometry: { x: 0, y: 0, width: 48, height: 800 } });
  ws.add(left);
  qt.drain();
  const before = ws.writes.length;
  // KWin reconfigures the panel (e.g. another panel took the bottom edge first): its frame
  // changes, the usable area does not.
  ws.kwinSetFrame(left, { x: 0, y: 0, width: 48, height: 760 });
  qt.drain();
  assert.equal(ws.writes.length, before);
  rt.shutdown();
});

// ---------------------------------------------------------------- generations

test("the adapter retains no per-window state after windows are removed", () => {
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1")]);
  const qt = new FakeQt();
  const f = fakeEnv(ws, qt);
  const rt = createRuntime(f.env);
  for (let i = 0; i < 1000; ++i) {
    const t = ws.window({ tooltip: true, normalWindow: false });
    ws.add(t);
    ws.remove(t);
  }
  const n = ws.window({ caption: "n" });
  ws.add(n);
  ws.remove(n);
  qt.drain();
  rt.shutdown();
  // Probe the adapter directly: a fresh one, 1000 windows through it, then every container empty.
  const a = new KwinAdapter(ws as never, qt as never);
  const engine = new Proxy({}, { get: () => () => {} });
  a.attach(engine as never, false);
  for (let i = 0; i < 1000; ++i) {
    const t = ws.window({ tooltip: true, normalWindow: false });
    ws.add(t);
    ws.remove(t);
  }
  assert.equal(a.windowCount(), 0);
  for (const [k, v] of Object.entries(a)) {
    if (v instanceof Map || v instanceof Set) assert.ok(v.size <= ws.screens.length, `adapter.${k} retains ${v.size} entries`);
  }
  a.detach();
});

test("window generations stay unique when an id is registered again", () => {
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1")]);
  const qt = new FakeQt();
  const a = new KwinAdapter(ws as never, qt as never);
  const seen: number[] = [];
  const engine = new Proxy({}, { get: (_t, k) => (k === "windowAdded" ? (s: { gen: number }) => seen.push(s.gen) : () => {}) });
  a.attach(engine as never, false);
  const w = ws.window({ caption: "x" });
  ws.add(w);
  ws.remove(w);
  w.deleted = false;
  ws.add(w); // same internalId (not expected from KWin, but must not reuse a generation)
  assert.equal(seen.length, 2);
  assert.ok(seen[1] > seen[0], `generations ${seen}`);
  a.detach();
});

// ---------------------------------------------------------------- title rules

const FLOAT_BAR = JSON.stringify({ schemaVersion: 1, rules: [{ id: "bar", match: { title: { glob: "bar*" } }, actions: { mode: "floating" } }] });

test("title rules activated by a reconfigure see later caption changes (existing and new windows)", () => {
  const { ws, qt, wins, rt, f } = setup(1, 2);
  const [w1, w2] = wins;
  assert.ok(w1.frameGeometry.width < 700 && w2.frameGeometry.width < 700, "two tiles side by side");
  f.cfg.configJson = FLOAT_BAR;
  f.configChanged.emit();
  qt.drain();
  // w2 retitles to match the floating rule: w1 must take the whole area.
  w2.caption = "bar 1";
  w2.captionChanged.emit();
  qt.drain();
  assert.equal(w1.frameGeometry.width, 1280 - 2 * GAP, "w1 fills the width once w2 floats");
  // A window opened after the reconfigure is watched as well.
  const w3 = ws.window({ caption: "w3", resourceClass: "app3" });
  ws.add(w3);
  qt.drain();
  assert.ok(w1.frameGeometry.width < 700, "w3 tiles next to w1");
  w3.caption = "bar 3";
  w3.captionChanged.emit();
  qt.drain();
  assert.equal(w1.frameGeometry.width, 1280 - 2 * GAP, "w3 floats after its retitle");
  rt.shutdown();
});

test("a title rule matches the caption current at activation, not the one seen at registration", () => {
  const { qt, wins, rt, f } = setup(1, 2);
  const [w1, w2] = wins;
  // Caption changed while no title rule was active: nothing is connected, nothing is read.
  w2.caption = "bar 2";
  w2.captionChanged.emit();
  qt.drain();
  assert.ok(w1.frameGeometry.width < 700);
  f.cfg.configJson = FLOAT_BAR;
  f.configChanged.emit();
  qt.drain();
  assert.equal(w1.frameGeometry.width, 1280 - 2 * GAP, "w2 floats on activation");
  rt.shutdown();
});

test("title watching stops when title rules are removed again", () => {
  const { qt, wins, rt, f } = setup(1, 2, { configJson: FLOAT_BAR });
  const w2 = wins[1];
  assert.ok(w2.captionChanged.fns.length > 0);
  f.cfg.configJson = "";
  f.configChanged.emit();
  qt.drain();
  assert.equal(w2.captionChanged.fns.length, 0);
  rt.shutdown();
});

// ------------------------------------------------------------- desktop names

test("renaming a desktop re-resolves desktopName overrides (settings and enabled)", () => {
  const cfg = { configJson: JSON.stringify({ schemaVersion: 1, overrides: [
    { id: "wide", match: { desktopName: { glob: "Wide*" } }, set: { gaps: { inner: 40 } } },
    { id: "chat", match: { desktopName: { glob: "Chat*" } }, set: { enabled: false } },
  ] }) };
  const { ws, qt, wins, rt } = setup(1, 2, cfg);
  const [w1, w2] = wins;
  const gap = () => w2.frameGeometry.x - (w1.frameGeometry.x + w1.frameGeometry.width);
  assert.equal(gap(), GAP);
  const d = ws.desktops[0];
  d.name = "Wide 1";
  d.nameChanged.emit();
  qt.drain();
  assert.equal(gap(), 40, "the override's inner gap applies after the rename");
  d.name = "Chat 2";
  d.nameChanged.emit();
  qt.drain();
  // Tiling disabled here: a new window is left where KWin put it and the others keep their frames.
  const f1 = w1.frameGeometry, f2 = w2.frameGeometry;
  const w3 = ws.window({ caption: "w3", resourceClass: "app3", frameGeometry: { x: 300, y: 200, width: 500, height: 400 } });
  ws.add(w3);
  qt.drain();
  assert.deepEqual([w1.frameGeometry, w2.frameGeometry, w3.frameGeometry], [f1, f2, { x: 300, y: 200, width: 500, height: 400 }]);
  d.name = "Desktop 1";
  d.nameChanged.emit();
  qt.drain();
  assertTiles([w1, w2, w3], { x: 0, y: 0, width: 1280, height: 800 });
  rt.shutdown();
});

test("desktop rename connections are owned and re-owned when desktops change", () => {
  const { ws, qt, rt } = setup(1, 1);
  const d1 = ws.desktops[0];
  assert.equal(d1.nameChanged.fns.length, 1);
  const d2 = desktop("D2", 2);
  ws.desktops = [d1, d2];
  ws.desktopsChanged.emit();
  qt.drain();
  assert.equal(d1.nameChanged.fns.length, 1);
  assert.equal(d2.nameChanged.fns.length, 1);
  rt.shutdown();
  assert.equal(d1.nameChanged.fns.length + d2.nameChanged.fns.length, 0, "teardown disconnects them");
});

// ------------------------------------------------------------ constraint refresh

const FULL = { x: 0, y: 0, width: 1280, height: 800 };

test("a minimum size set after mapping (no NOTIFY) is picked up from maximizeableChanged and honoured", () => {
  const { qt, wins, rt } = setup(1, 2);
  const [w1, w2] = wins;
  assert.ok(w1.frameGeometry.width < 760);
  // An xdg-toplevel commits set_min_size later (Kate does, twice): KWin emits only maximizeableChanged.
  w1.minSize = { width: 760, height: 300 };
  w1.maximizeableChanged.emit(true);
  qt.drain();
  assert.ok(w1.frameGeometry.width >= 760, `w1 honours its new minimum: ${JSON.stringify(w1.frameGeometry)}`);
  assertTiles([w1, w2], FULL);
  rt.shutdown();
});

test("a decoration change re-reads the frame/client margin once the client geometry follows", () => {
  const { qt, wins, rt, ws } = setup(1, 3);
  const w3 = wins[2];
  // Stack window with a 500 px client minimum: its frame minimum is 500 + the 30 px title bar.
  w3.minSize = { width: 0, height: 500 };
  w3.maximizeableChanged.emit(true);
  qt.drain();
  assert.equal(w3.frameGeometry.height, 530);
  const before = ws.writes.length;
  w3.noBorder = true; // the user (or a border rule) removes the decoration
  qt.drain();
  assert.equal(w3.frameGeometry.height, 500, "the frame minimum follows the removed title bar");
  assertTiles(wins, FULL);
  assert.ok(ws.writes.length - before <= 2, "one re-solve");
  // The one-shot watch is gone: an ordinary resize re-reads nothing.
  assert.equal(w3.clientGeometryChanged.fns.length, 0);
  rt.shutdown();
});

test("fullscreen (KWin reports not resizable, drops the decoration) keeps the window's slot", () => {
  const { qt, wins, rt } = setup(1, 3);
  const w2 = wins[1];
  const slot = w2.frameGeometry;
  // KWin: isResizable() is false while fullscreen is requested (xdgshellwindow.cpp:682-686),
  // and the decoration goes away with fullscreen.
  w2.resizeable = false;
  w2.fullScreen = true;
  w2.fullScreenChanged.emit();
  w2._setFrame({ x: 0, y: 0, width: 1280, height: 800 }, false);
  w2._setDecorated(false);
  qt.drain();
  w2.minimized = true;
  w2.minimizedChanged.emit();
  w2.resizeable = true;
  w2.fullScreen = false;
  w2.fullScreenChanged.emit();
  w2._setDecorated(true);
  w2._setFrame(slot, false);
  qt.drain();
  w2.minimized = false;
  w2.minimizedChanged.emit();
  qt.drain();
  assert.deepEqual(w2.frameGeometry, slot, "back in its own slot (order kept)");
  assertTiles(wins, FULL);
  rt.shutdown();
});

test("a window mapped already fullscreen joins the layout when it leaves fullscreen", () => {
  const { ws, qt, wins, rt } = setup(1, 2);
  const slots = wins.map((w) => w.frameGeometry);
  // Mapped with fullscreen requested: KWin reports it as not resizable (xdgshellwindow.cpp:682-686).
  const w3 = ws.window({ caption: "w3", resourceClass: "app3", fullScreen: true, resizeable: false,
                         frameGeometry: { x: 0, y: 0, width: 1280, height: 800 } }, false);
  ws.add(w3);
  qt.drain();
  assert.deepEqual(wins.map((w) => w.frameGeometry), slots, "KWin owns the fullscreen window: peers untouched");
  // Fullscreen ends: no restore geometry, so KWin lets the client choose its size (setFullScreen).
  w3.resizeable = true;
  w3.fullScreen = false;
  w3.fullScreenChanged.emit();
  ws.kwinSetFrame(w3, { x: 0, y: 0, width: 640, height: 480 });
  qt.drain();
  assertTiles([...wins, w3], FULL);
  assert.ok(w3.frameGeometry.x > 600 && w3.frameGeometry.height < 400, `w3 tiled into the stack: ${JSON.stringify(w3.frameGeometry)}`);
  rt.shutdown();
});

test("a user's border change under a border rule survives the constraint refresh it causes (Q10)", () => {
  const cfg = { configJson: JSON.stringify({ schemaVersion: 1, rules: [{ id: "nb", match: { appId: { glob: "app*" } }, actions: { border: "none" } }] }) };
  const { ws, qt, wins, rt } = setup(1, 3, cfg);
  const w2 = wins[1];
  assert.ok(wins.every((w) => w.noBorder === true), "the rule removed every border");
  w2.minSize = { width: 150, height: 150 }; // a minimum makes the margin part of the constraints
  w2.maximizeableChanged.emit(true);
  qt.drain();
  w2.noBorder = false; // the user restores the border: decoration signals, then a margin refresh
  qt.drain();
  ws.activeWindow = wins[0];
  rt.dispatch("plastile.resize.grow");
  qt.drain();
  assert.equal(w2.noBorder, false, "Plastile yields to the user's change");
  assertTiles(wins, FULL);
  rt.shutdown();
  assert.equal(w2.noBorder, false, "unload does not clobber it either");
});

test("a client answering a request with another size gets its constraints re-read once (no deadline needed)", () => {
  const { ws, qt, wins, rt } = setup(1, 2);
  const [w1, w2] = wins;
  // KWin (X11 size hints) silently starts enforcing a 600 px minimum width on w2.
  w2.minSize = { width: 600, height: 0 };
  w2._clamp = { width: 600, height: 0 };
  const w3 = ws.window({ caption: "w3", resourceClass: "app3" });
  ws.add(w3); // the stack slots change: w2's narrower request is answered with 600 px
  qt.drain();
  assert.ok(w2.frameGeometry.width >= 600);
  assertTiles([w1, w2, w3], FULL);
  rt.shutdown();
});

test("the armed decoration watcher is a transient connection: counted, dropped when the margin settles, released at detach", () => {
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1")]);
  const qt = new FakeQt();
  const a = new KwinAdapter(ws as never, qt as never);
  const engine = new Proxy({}, { get: () => () => {} });
  a.attach(engine as never, false);
  const w = ws.window({ caption: "w" });
  ws.add(w);
  const base = a.connectionCount();
  assert.equal(a.transientConnectionCount(), 0);
  // Measured on KWin 6.7.5 with a real GPU: decorationChanged ~100 ms after the first tile
  // write, and no geometry change after it, so the watcher can stay armed while idle.
  w.decorationChanged.emit();
  assert.equal(a.transientConnectionCount(), 1);
  assert.equal(a.connectionCount(), base + 1, "the watcher is an owned connection");
  w.decorationChanged.emit(); // a second change does not arm a second watcher
  assert.equal(a.transientConnectionCount(), 1);
  w.clientGeometryChanged.emit();
  qt.drain();
  assert.equal(a.transientConnectionCount(), 0, "settled: one-shot watcher dropped");
  assert.equal(a.connectionCount(), base, "steady count restored");
  w.decorationChanged.emit(); // armed again, then the adapter goes away
  a.detach();
  assert.equal(a.connectionCount(), 0, "detach releases the armed watcher too");
  assert.equal(w.clientGeometryChanged.fns.length, 0);
});
