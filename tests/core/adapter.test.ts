// The real KwinAdapter and runtime driven through a fake KWin script surface (fakeKwin.ts).
// Oracles are the fake windows' frames and the script write log, never engine claims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../../src/runtime/main.ts";
import { constraintsOf, KwinAdapter } from "../../src/adapters/kwin/adapter.ts";
import { desktop, fakeEnv, FakeQt, FakeWorkspace, output, Sig, type FakeWindow, type R } from "./fakeKwin.ts";

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

test("O07: a panel that only changes its exclusive zone (auto-hide, dodge) re-solves from its repaint", () => {
  const { ws, qt, wins, rt } = setup();
  const reduced = { x: 0, y: 0, width: 1280, height: 760 };
  const full = { x: 0, y: 0, width: 1280, height: 800 };
  ws.areas.set("O1", reduced);
  const panel = ws.panel({ frameGeometry: { x: 0, y: 760, width: 1280, height: 40 } });
  ws.add(panel);
  qt.drain();
  assertTiles(wins, reduced);
  // Dodge windows: the panel repaints with its frame unchanged; KWin's rearrange applies the
  // full area after the adapter's first deferred turn (worst case, as measured).
  let before = ws.writes.length;
  panel.damaged.emit();
  qt.turn();
  ws.areas.delete("O1");
  qt.drain();
  assertTiles(wins, full);
  assert.equal(Math.max(...wins.map((w) => bottomOf(w.frameGeometry))), 800 - GAP, "the tiles use the grown area");
  for (const [cap, n] of writesPerWindow(ws, before)) assert.ok(n <= 1, `${cap} written ${n} times`);
  // Auto-hide off: hiddenChanged, then the reduced area again.
  before = ws.writes.length;
  panel.hiddenChanged.emit();
  qt.turn();
  ws.areas.set("O1", reduced);
  qt.drain();
  assertTiles(wins, reduced);
  assert.equal(Math.max(...wins.map((w) => bottomOf(w.frameGeometry))), 760 - GAP, "the tiles left the panel again");
  for (const [cap, n] of writesPerWindow(ws, before)) assert.ok(n <= 1, `${cap} written ${n} times`);
  // A repaint that changed nothing writes nothing.
  before = ws.writes.length;
  panel.damaged.emit();
  qt.drain();
  assert.equal(ws.writes.length, before);
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

test("X11 CSD: frame-space constraints subtract the shadow the client geometry includes (zenity)", () => {
  const ws = new FakeWorkspace([output("O1", FULL)], [desktop("1")]);
  // zenity --info under GDK_BACKEND=x11, measured in nested KWin 6.7.5: frame 300x226, client 344x270
  // (_GTK_FRAME_EXTENTS 22), WM_NORMAL_HINTS min = max = 344x270, resizeable false.
  const w = ws.window({ frameGeometry: { x: 490, y: 287, width: 300, height: 226 }, csdShadow: 22, resizeable: false,
                        minSize: { width: 344, height: 270 }, maxSize: { width: 344, height: 270 } }, false);
  assert.deepEqual(constraintsOf(w), { minFrame: { width: 300, height: 226 }, maxFrame: { width: 300, height: 226 }, fixed: true });
  // Bounded below by 0: a hint smaller than the shadow is no negative minimum.
  w.minSize = { width: 10, height: 10 };
  assert.deepEqual(constraintsOf(w).minFrame, { width: 0, height: 0 });
});

test("X11 CSD client that resizes itself after KWin's synchronous echo gets its hints re-read (gnome-calculator)", () => {
  const { ws, qt, wins, rt } = setup(1, 2);
  // Mapped with no hints visible (KWin 6.7.5 reports minSize 0x0 at windowAdded for GTK4 X11 clients).
  const w3 = ws.window({ caption: "calc", resourceClass: "gnome-calculator", csdShadow: 25,
                         frameGeometry: { x: 400, y: 100, width: 360, height: 616 } }, false);
  ws.add(w3);
  // WM_NORMAL_HINTS arrive before the flush with no script-visible signal.
  w3.minSize = { width: 410, height: 666 };
  qt.drain(); // the stack slot is shorter than 616: KWin applies it inside the setter (echo)
  assert.ok(w3.frameGeometry.height < 616, "precondition: the slot is below the real minimum");
  // GTK enforces its minimum itself: a ConfigureRequest back to 666 client (616 frame) px.
  ws.kwinSetFrame(w3, { ...w3.frameGeometry, height: 616 });
  qt.drain();
  assert.equal(w3.frameGeometry.height, 616, `honours the 616 px frame minimum, not the 666 px client one: ${JSON.stringify(w3.frameGeometry)}`);
  assertTiles([...wins, w3], FULL);
  rt.shutdown();
});

// ------------------------------------------------- T10 destroyed wrappers, T16 excluded surfaces

/**
 * From now on every property read or write of `w` (except `allow`) is recorded and throws, as
 * a destroyed KWin wrapper would fail; its signals can still be emitted. Returns the record.
 */
function poison(w: FakeWindow, allow: readonly string[] = []): string[] {
  const touched: string[] = [];
  for (const k of Object.getOwnPropertyNames(w)) {
    if (allow.includes(k)) continue;
    const d = Object.getOwnPropertyDescriptor(w, k)!;
    if (d.value instanceof Sig || typeof d.value === "function") continue;
    const hit = (op: string) => (): never => { touched.push(op + " " + k); throw new Error(`destroyed wrapper: ${op} ${k}`); };
    Object.defineProperty(w, k, { configurable: true, get: hit("read"), set: hit("write") });
  }
  return touched;
}

function signalsOf(w: FakeWindow): Sig[] {
  return Object.getOwnPropertyNames(w).map((k) => Object.getOwnPropertyDescriptor(w, k)!.value).filter((v) => v instanceof Sig);
}

/** An engine stand-in that records every call the adapter makes into it. */
function recordingEngine() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const engine = new Proxy({}, { get: (_t, k) => (...args: unknown[]) => { calls.push({ fn: String(k), args }); } });
  const added = () => calls.filter((c) => c.fn === "windowAdded").map((c) => c.args[0] as { id: string; gen: number });
  return { calls, engine, added };
}

/** Every HostPort operation that takes a window id and generation; all must refuse. */
function assertRefused(a: KwinAdapter, id: string, gen: number, why: string): void {
  const r = { x: 0, y: 0, width: 640, height: 480 };
  assert.equal(a.applyFrame(id, gen, r), null, `applyFrame ${why}`);
  assert.equal(a.frame(id, gen), null, `frame ${why}`);
  assert.equal(a.activate(id, gen), false, `activate ${why}`);
  assert.equal(a.raise(id, gen), false, `raise ${why}`);
  assert.equal(a.releaseNativeTile(id, gen), false, `releaseNativeTile ${why}`);
  assert.equal(a.setNoBorder(id, gen, true), false, `setNoBorder ${why}`);
  assert.equal(a.noBorder(id, gen), null, `noBorder ${why}`);
  assert.equal(a.sendToOutput(id, gen, "O1"), false, `sendToOutput ${why}`);
  assert.equal(a.sendToDesktop(id, gen, "desk-D1"), false, `sendToDesktop ${why}`);
}

test("T10: a removed or deleted window's wrapper is never touched again; a re-added id answers only its new generation", () => {
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1")]);
  const qt = new FakeQt();
  const a = new KwinAdapter(ws as never, qt as never);
  const { calls, engine, added } = recordingEngine();
  a.attach(engine as never, true); // title watching on: captionChanged is hooked as well
  const base = a.connectionCount();
  const w = ws.window({ caption: "dead" });
  ws.add(w);
  const { id, gen } = added()[0];
  const sigs = signalsOf(w);
  assert.ok(sigs.some((s) => s.fns.length > 0), "precondition: the live window is hooked");
  assert.deepEqual(a.frame(id, gen), w.frameGeometry, "precondition: the live entry answers");

  ws.remove(w);
  assert.deepEqual(calls.filter((c) => c.fn === "windowRemoved").map((c) => c.args), [[id, gen]]);
  const touched = poison(w);
  calls.length = 0;
  // (a) KWin may still deliver queued signals of the destroyed wrapper.
  for (const s of sigs) assert.doesNotThrow(() => s.emit(), "a late signal reaches no handler");
  qt.drain();
  assert.deepEqual(calls.map((c) => c.fn), [], "no engine work from a removed window's signals");
  assert.equal(a.connectionCount(), base, "every per-window connection released");
  // (b) Engine-held handles to the removed window.
  const writes = ws.writes.length, active = ws.activeWindow;
  assertRefused(a, id, gen, "after removal");
  assert.deepEqual(touched, [], "the dead wrapper was not read or written");
  assert.equal(ws.writes.length, writes);
  assert.equal(ws.activeWindow, active);

  // The same id registered again (a new wrapper): the old generation is rejected without
  // touching either wrapper; the new generation works.
  const w2 = ws.window({ caption: "reborn", internalId: id });
  ws.add(w2);
  const gen2 = added()[added().length - 1].gen;
  assert.ok(gen2 > gen, `new generation ${gen2} > ${gen}`);
  const fg2 = w2.frameGeometry;
  assertRefused(a, id, gen, "for the old generation");
  assert.deepEqual(w2.frameGeometry, fg2, "the new window was not moved by an old-generation call");
  assert.equal(w2.noBorder, false, "nor its border changed");
  assert.notEqual(ws.activeWindow, w2, "nor activated");
  assert.equal(ws.writes.length, writes);
  const t = { x: 8, y: 8, width: 632, height: 784 };
  assert.deepEqual(a.applyFrame(id, gen2, t)?.after, t);
  assert.deepEqual(a.frame(id, gen2), t);
  assert.equal(a.activate(id, gen2), true);
  assert.equal(ws.activeWindow, w2);
  calls.length = 0;
  for (const s of sigs) s.emit();
  assert.deepEqual(calls.map((c) => c.fn), [], "the old wrapper's signals still reach nothing");
  ws.kwinSetFrame(w2, { ...t, x: 20 }); // a move after the answered request: an observation only
  assert.deepEqual(calls.map((c) => [c.fn, c.args[0], c.args[1]]), [["frameObserved", id, gen2]]);

  // A wrapper KWin marked deleted before windowRemoved arrives: only `deleted` (and the id,
  // for the removal) may be read.
  const w3 = ws.window({ caption: "closing" });
  ws.add(w3);
  const s3 = added()[added().length - 1];
  w3.deleted = true;
  const touched3 = poison(w3, ["deleted", "internalId"]);
  assertRefused(a, s3.id, s3.gen, "for a deleted wrapper");
  ws.remove(w3);
  assert.deepEqual(touched3, [], "the deleted wrapper was not read or written");
  assert.equal(ws.writes.length, writes + 1, "only the new generation's write");
  a.detach();
  assert.equal(a.connectionCount(), 0);
  assert.deepEqual(touched, []);
});

/** Frame/client geometry churn plus the signals that only re-read the frame margin, tile or title. */
function geometryChurn(ws: FakeWorkspace, qt: FakeQt, w: FakeWindow): void {
  for (let i = 0; i < 5; ++i) {
    ws.kwinSetFrame(w, { x: 100 + i, y: 40 + i, width: 600 + 10 * i, height: 60 + 10 * i });
    w.clientGeometryChanged.emit();
  }
  for (const s of ["tileChanged", "captionChanged", "maximizeableChanged", "decorationPolicyChanged", "decorationChanged",
                   "clientGeometryChanged"]) w[s].emit();
  qt.drain();
}

/** Every state, membership and metadata signal of `w`, in one event-loop turn. */
function stateChurn(ws: FakeWorkspace, qt: FakeQt, w: FakeWindow, setStates: boolean): void {
  const flip = (k: string, on: unknown, off: unknown, s: string) => {
    if (setStates) w[k] = on;
    w[s].emit();
    if (setStates) w[k] = off;
    w[s].emit();
  };
  flip("minimized", true, false, "minimizedChanged");
  flip("fullScreen", true, false, "fullScreenChanged");
  flip("maximizeMode", 3, 0, "maximizedChanged");
  flip("hidden", true, false, "hiddenChanged");
  if (setStates) w.move = true;
  w.interactiveMoveResizeStarted.emit();
  w.moveResizedChanged.emit();
  ws.kwinSetFrame(w, { x: 300, y: 200, width: 600, height: 60 });
  if (setStates) w.move = false;
  w.interactiveMoveResizeFinished.emit();
  w.moveResizedChanged.emit();
  for (const s of ["outputChanged", "desktopsChanged", "activitiesChanged", "transientChanged", "modalChanged"]) w[s].emit();
  qt.drain();
}

function inspectCounters(rt: { dispatch(id: string): unknown }, lines: string[]) {
  rt.dispatch("plastile.inspect.counters");
  return JSON.parse(lines[lines.length - 1].replace(/^plastile counters /, "")) as
    { counters: { flushes: number; solves: number; writes: number }; connections: number };
}

test("T16: excluded surfaces (shell app id, passive kinds) incur no solve or write, and no flush for geometry churn", () => {
  const { ws, qt, wins, rt, f } = setup(1, 2);
  const tiles = wins.map((w) => w.frameGeometry);
  const surfaces: Array<{ name: string; w: FakeWindow; passive: boolean }> = [
    { name: "krunner", passive: false, w: ws.window({ caption: "KRunner", resourceClass: "org.kde.krunner",
                                                       desktopFileName: "org.kde.krunner", skipTaskbar: true }) },
    { name: "tooltip", passive: true, w: ws.window({ caption: "", tooltip: true, normalWindow: false }, false) },
    { name: "osd", passive: true, w: ws.window({ caption: "", onScreenDisplay: true, normalWindow: false }, false) },
  ];
  const conns: Record<string, number> = {};
  for (const s of surfaces) {
    const c0 = inspectCounters(rt, f.lines);
    ws.add(s.w);
    qt.drain();
    const c1 = inspectCounters(rt, f.lines);
    conns[s.name] = c1.connections - c0.connections;
    assert.equal(c1.counters.writes, c0.counters.writes, `${s.name}: mapping it writes nothing`);
    assert.equal(c1.counters.solves, c0.counters.solves, `${s.name}: mapping it solves nothing`);
    // A passive surface is not read again after registration: no handler exists to read it.
    const touched = s.passive ? poison(s.w) : [];
    geometryChurn(ws, qt, s.w);
    const c2 = inspectCounters(rt, f.lines);
    assert.equal(c2.counters.flushes - c1.counters.flushes, 0, `${s.name}: flushes for geometry churn`);
    assert.equal(c2.counters.solves - c1.counters.solves, 0, `${s.name}: solves for geometry churn`);
    assert.equal(c2.counters.writes - c1.counters.writes, 0, `${s.name}: writes for geometry churn`);
    stateChurn(ws, qt, s.w, !s.passive);
    const c3 = inspectCounters(rt, f.lines);
    // Measured, not a goal: the engine schedules a flush on any suspension, membership or
    // metadata change, also of an excluded window (engine.ts statesChanged: ensureFlush()), and
    // that flush finds no dirty context. One coalesced empty flush per turn at most.
    assert.ok(c3.counters.flushes - c2.counters.flushes <= (s.passive ? 0 : 1), `${s.name}: flushes for state churn`);
    assert.equal(c3.counters.solves - c2.counters.solves, 0, `${s.name}: solves for state churn`);
    assert.equal(c3.counters.writes - c2.counters.writes, 0, `${s.name}: writes for state churn`);
    assert.deepEqual(touched, [], `${s.name}: never read after registration`);
  }
  // Passive kinds get no connection at all (adapter.ts:429, PASSIVE_KINDS at adapter.ts:51-53).
  // The app-id exclusion is a core decision (classify.ts EXCLUDED_APPS); the adapter hooks by
  // kind only (adapter.ts:426-431), so a normal-kind shell surface keeps its 17 hooks
  // (adapter.ts:439-502): windowClassChanged (adapter.ts:486) can turn it into an ordinary
  // window; while excluded it owns no geometry, so its events queue no solve or write.
  assert.deepEqual(conns, { krunner: 17, tooltip: 0, osd: 0 });
  assert.deepEqual(wins.map((w) => w.frameGeometry), tiles, "the tiles were not touched");
  rt.shutdown();
});
