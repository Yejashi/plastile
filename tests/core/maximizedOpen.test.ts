// A window that arrives maximized (ADR-021, BEHAVIOR §3): the application or KWin chose the
// maximize, not the user. With maximizedOnOpen "tile" (the default) Plastile clears it once,
// in the same flush as the window's first tile write, and a maximize after that is honoured
// as T17 always did. Unit layer, mock compositor (tests/core/mockHost.ts models KWin 6.7.5's
// setMaximize: X11 synchronous; xdg-toplevel reported on the client's commit, one configure
// per turn). Oracles: the mock's frames, its write and configure logs and its un-maximize calls;
// explain and the trace only for what Plastile says about it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect, rectNear, type Rect } from "../../src/core/geometry.ts";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import type { ContextSettings, WindowStates } from "../../src/core/types.ts";
import { MockHost, NO_STATES, meta, type MockWindow } from "./mockHost.ts";
import { describeWindow } from "../../src/runtime/inspect.ts";

const FULL = rect(0, 0, 1280, 800);           // the output: KWin's maximize area (no panel)
const ALONE = rect(8, 8, 1264, 784);          // one tile with the default 8 px gaps
const MAXED: WindowStates = { ...NO_STATES, maximized: true };

function keep(): ContextSettings { return { ...DEFAULT_SETTINGS, maximizedOnOpen: "keep" }; }

/** Opens `id` as an application that maps maximized (its frame is the maximize area). */
function openMaximized(h: MockHost, id: string, patch: Partial<MockWindow> = {}): MockWindow {
  return h.open(id, { states: MAXED, frame: FULL, ...patch });
}

function kinds(h: MockHost, id: string): string[] {
  return h.engine.trace.snapshot().filter((r) => r.id === id).map((r) => r.kind);
}

function onlyTile(h: MockHost, id: string): Rect {
  const w = h.windows.get(id)!;
  assert.equal(w.states.maximized, false, `${id}: no longer maximized (KWin's state)`);
  return w.frame;
}

// ------------------------------------------------------------------ the decision

test("ADR-021: a Wayland window that opens maximized is un-maximized and tiled with one configure; no fight", () => {
  const h = new MockHost();
  h.start();
  h.open("a");
  h.advance(10);
  h.windows.get("a")!.delay = 0;
  const w = openMaximized(h, "b", { delay: 16 });
  h.drain();                                            // the flush: un-maximize and tile in one turn
  assert.deepEqual(h.unmaximizes, ["b"], "one un-maximize, for the new window");
  assert.equal(h.writesTo("b"), 1, "one placement write");
  assert.equal(h.configuresSent.get("b"), 1, "KWin sends one configure: the un-maximize and the tile together");
  assert.equal(w.states.maximized, true, "KWin reports it only when the client acknowledges");
  assert.equal(h.engine.explain("b")!.suspended, null, "not suspended while the acknowledgement is on its way");
  h.advance(50);
  const f = onlyTile(h, "b");
  assert.ok(f.x > 600 && f.width < 700, `b tiled beside a: ${JSON.stringify(f)}`);
  const a = h.windows.get("a")!.frame;
  assert.ok(a.x === 8 && a.width < 1264 && a.x + a.width < f.x, `a reflowed to the left of b: ${JSON.stringify(a)}`);
  assert.equal(h.writesTo("b"), 1, "no correction afterwards");
  h.advance(3000);
  assert.equal(h.writesTo("b"), 1);
  assert.equal(h.unmaximizes.length, 1);
  assert.equal(h.engine.counters.corrections, 0);
  const x = h.engine.explain("b")!;
  assert.match(String(x.onOpen), /^unmaximized on open: it opened maximized/);
  assert.deepEqual(x.suspensions, []);
  const tr = h.engine.trace.snapshot().filter((r) => r.id === "b" && r.kind === "open-maximized");
  assert.deepEqual(tr.map((r) => r.data), [{ action: "unmaximized" }], "the trace records why");
  assert.ok(kinds(h, "b").indexOf("unmaximized") > kinds(h, "b").indexOf("open-maximized"), "then KWin's report");
  const v = describeWindow(x, { desktopNameOf: () => "Desktop 1", shortcuts: null, area: null });
  assert.ok(v.rows.some((r) => r.label === "On open" && /^Unmaximized on open/.test(r.text)), "the inspector says so");
  assert.deepEqual(h.engine.check(), []);
});

test("ADR-021: an X11 window mapped with _NET_WM_STATE_MAXIMIZED: KWin clears it inside the call; one write", () => {
  const h = new MockHost();
  h.start();
  openMaximized(h, "x", { x11: true, restore: rect(300, 200, 640, 480) });
  h.drain();
  assert.deepEqual(h.unmaximizes, ["x"]);
  assert.ok(rectNear(onlyTile(h, "x"), ALONE), "tiled, not left at its restore geometry");
  assert.equal(h.writesTo("x"), 1);
  h.advance(2000);
  assert.equal(h.writesTo("x"), 1, "no correction");
  assert.equal(h.engine.counters.corrections, 0);
  assert.equal(h.engine.outstandingCount(), 0);
});

test("ADR-021: maximizedOnOpen keep leaves it maximized and says why; no write, no un-maximize", () => {
  const h = new MockHost();
  h.start({ settingsFor: keep });
  h.open("a");
  h.drain();
  openMaximized(h, "b");
  h.drain(); h.advance(2000);
  assert.deepEqual(h.unmaximizes, []);
  assert.equal(h.writesTo("b"), 0);
  assert.ok(rectNear(h.windows.get("b")!.frame, FULL));
  assert.ok(rectNear(h.windows.get("a")!.frame, ALONE), "the peer tiles without it, as for any maximized window");
  const x = h.engine.explain("b")!;
  assert.equal(x.onOpen, "it opened maximized and stays maximized (maximizedOnOpen: keep)");
  assert.match(String(x.suspended), /suspended while it is maximized/);
});

test("ADR-021: a maximize the user makes after the window was tiled is honoured as before (T17)", () => {
  const h = new MockHost();
  h.start();
  h.open("a"); h.open("b");
  h.drain();
  const writes = h.writes.length;
  h.setStates("b", { maximized: true });
  h.userSetFrame("b", FULL);
  h.drain(); h.advance(3000);
  assert.deepEqual(h.unmaximizes, [], "never un-maximized");
  assert.equal(h.writesTo("b"), 1, "only its first tile");
  assert.ok(rectNear(h.windows.get("b")!.frame, FULL));
  assert.ok(h.writes.length > writes, "the peer reflowed");
  assert.equal(h.engine.explain("b")!.onOpen, undefined, "nothing happened on open");
});

test("ADR-021: windows already open when Plastile starts are left maximized (initial adoption)", () => {
  const h = new MockHost();
  const a = h.make("a", { states: MAXED, frame: FULL }), b = h.make("b");
  h.start({}, [h.snapshot(a), h.snapshot(b)]);
  h.drain(); h.advance(2000);
  assert.deepEqual(h.unmaximizes, []);
  assert.equal(h.writesTo("a"), 0);
  assert.ok(rectNear(h.windows.get("b")!.frame, ALONE));
});

test("ADR-021: windows opened while tiling is suspended are adopted at resume as they are", () => {
  const h = new MockHost();
  h.start();
  h.open("a");
  h.drain();
  h.engine.execute("plastile.runtime.toggle-suspend");
  openMaximized(h, "b");
  h.open("c", { meta: meta(""), states: MAXED, frame: FULL });   // late metadata, still pending at resume
  h.drain();
  h.engine.execute("plastile.runtime.toggle-suspend");
  h.engine.metadataChanged("c", h.windows.get("c")!.gen, meta("c"));
  h.drain(); h.advance(2000);
  assert.deepEqual(h.unmaximizes, [], "a resume is a re-adoption: nothing is un-maximized");
  assert.equal(h.writesTo("b"), 0);
  assert.equal(h.writesTo("c"), 0);
});

test("ADR-021: the decision waits for late metadata (the bounded readiness wait), then un-maximizes once", () => {
  const h = new MockHost();
  h.start();
  const w = openMaximized(h, "p", { meta: meta("") });
  h.drain();
  assert.deepEqual(h.unmaximizes, [], "pending: nothing decided yet");
  assert.equal(h.engine.modeOf("p"), "pending");
  h.advance(100);
  h.engine.metadataChanged("p", w.gen, meta("late.app"));
  h.drain();
  assert.deepEqual(h.unmaximizes, ["p"]);
  assert.ok(rectNear(onlyTile(h, "p"), ALONE));
  // The deadline path decides the same way.
  const q = openMaximized(h, "q", { meta: meta("") });
  h.drain();
  assert.equal(h.unmaximizes.length, 1);
  h.advance(400);                                       // readinessMs 300
  assert.deepEqual(h.unmaximizes, ["p", "q"], "classified at the readiness deadline, then decided");
  assert.equal(q.states.maximized, false);
});

// ------------------------------------------------------------------ what stays maximized

test("ADR-021: full screen on open, dialogs, rule floats and excluded windows keep their maximize", () => {
  const h = new MockHost();
  h.start({
    rulesFor: (m) => m.appId === "float.me" ? { mode: "floating", ruleIds: ["f"] }
      : m.appId === "skip.me" ? { mode: "excluded", ruleIds: ["x"] } : null,
  });
  h.open("fs", { states: { ...MAXED, fullscreen: true }, frame: FULL });
  h.open("dlg", { states: MAXED, frame: FULL, meta: meta("dlg", { kind: "dialog" }) });
  h.open("fl", { states: MAXED, frame: FULL, meta: meta("float.me") });
  h.open("ex", { states: MAXED, frame: FULL, meta: meta("skip.me") });
  h.drain(); h.advance(2000);
  assert.deepEqual(h.unmaximizes, []);
  for (const id of ["fs", "dlg", "fl", "ex"]) assert.equal(h.writesTo(id), 0, id);
  assert.equal(h.windows.get("fs")!.states.fullscreen, true);
});

test("ADR-021: the floating layout and an unassigned zones member place nothing, so they stay maximized", () => {
  const h = new MockHost();
  h.start({ settingsFor: () => ({ ...DEFAULT_SETTINGS, layout: "floating" }) });
  openMaximized(h, "a");
  h.drain(); h.advance(1000);
  assert.deepEqual(h.unmaximizes, []);
  const z = new MockHost();
  z.start({ settingsFor: () => ({ ...DEFAULT_SETTINGS, layout: "zones" }) });
  openMaximized(z, "a");
  z.drain(); z.advance(1000);
  assert.deepEqual(z.unmaximizes, [], "zones without an assignment");
});

test("ADR-021: KWin refuses (not maximizable: a forcing window rule): it stays maximized, explained, no write", () => {
  const h = new MockHost();
  h.start();
  openMaximized(h, "r", { maximizable: false });
  h.drain(); h.advance(2000);
  assert.equal(h.writesTo("r"), 0);
  assert.equal(h.windows.get("r")!.states.maximized, true);
  const x = h.engine.explain("r")!;
  assert.match(String(x.onOpen), /KWin does not allow un-maximizing it/);
  assert.match(String(x.suspended), /while it is maximized/);
});

// ------------------------------------------------------------------ bounded edge cases

test("ADR-021: a client that sets maximized after its first commit (before its tile settles) is un-maximized once", () => {
  const h = new MockHost();
  h.start();
  const w = h.open("late", { delay: 30 });
  h.drain();                                           // tiled: its first configure is on its way
  assert.equal(h.writesTo("late"), 1);
  h.advance(5);
  w.frame = FULL;
  h.setStates("late", { maximized: true });            // the client's own set_maximized, acknowledged
  h.drain();
  assert.deepEqual(h.unmaximizes, ["late"], "still its open phase");
  h.advance(100);
  assert.ok(rectNear(onlyTile(h, "late"), ALONE));
  assert.equal(h.engine.counters.corrections, 0, "placed by a plan write, not a correction");
  // After its tile settled, a maximize is the user's or the application's later choice: honoured.
  h.setStates("late", { maximized: true });
  h.userSetFrame("late", FULL);
  h.drain(); h.advance(2000);
  assert.deepEqual(h.unmaximizes, ["late"], "never twice");
  assert.ok(rectNear(h.windows.get("late")!.frame, FULL));
  assert.match(String(h.engine.explain("late")!.onOpen), /^maximized again after Plastile un-maximized it/);
  assert.ok(kinds(h, "late").includes("remaximized"));
});

test("ADR-021: the open phase is bounded in time even when the first tile never settles", () => {
  const h = new MockHost();
  h.start();
  h.open("slow", { delay: 5000 });
  h.drain();
  h.advance(1000);                                     // past deadlineMs (750) without a commit
  h.setStates("slow", { maximized: true });
  h.drain();
  assert.deepEqual(h.unmaximizes, [], "outside the open phase: honoured");
});

test("ADR-021: an application that maximizes itself again after the un-maximize is honoured; no second fight", () => {
  const h = new MockHost();
  h.start();
  h.open("a");
  h.drain();
  const w = openMaximized(h, "b", { delay: 10 });
  h.drain(); h.advance(50);
  assert.equal(w.states.maximized, false);
  const writes = h.writesTo("b");
  for (let i = 0; i < 5; ++i) {                       // toggles: maximize, restore, maximize, ...
    h.setStates("b", { maximized: true });
    h.userSetFrame("b", FULL);
    h.drain(); h.advance(20);
    h.setStates("b", { maximized: false });
    h.drain(); h.advance(50);
  }
  h.setStates("b", { maximized: true });
  h.userSetFrame("b", FULL);
  h.drain(); h.advance(3000);
  assert.deepEqual(h.unmaximizes, ["b"], "one un-maximize per window, ever");
  assert.ok(rectNear(h.windows.get("b")!.frame, FULL), "the last maximize stands");
  assert.ok(h.writesTo("b") <= writes + 5, `bounded: only the restores re-tile it (${h.writesTo("b") - writes} writes)`);
  assert.match(String(h.engine.explain("b")!.onOpen), /^maximized again/);
});

test("ADR-021: a client that re-maximizes before acknowledging: honoured at the deadline, nothing corrected", () => {
  const h = new MockHost();
  h.start();
  h.open("a");
  h.drain();
  openMaximized(h, "m", { delay: 20, remaximize: true });
  h.drain();
  assert.deepEqual(h.unmaximizes, ["m"]);
  h.advance(3000);
  const w = h.windows.get("m")!;
  assert.equal(w.states.maximized, true, "the client kept its maximize");
  assert.ok(rectNear(w.frame, FULL));
  assert.equal(h.writesTo("m"), 1, "the one tile write; no correction");
  assert.deepEqual(h.unmaximizes, ["m"], "not asked again");
  assert.equal(h.engine.counters.corrections, 0);
  assert.ok(rectNear(h.windows.get("a")!.frame, ALONE), "the peer tiles alone again");
  const x = h.engine.explain("m")!;
  assert.match(String(x.onOpen), /stayed maximized \(the application maximized itself again\); honoured/);
  assert.match(String(x.suspended), /while it is maximized/);
  assert.equal(h.engine.outstandingCount(), 0, "no request left outstanding");
  h.advance(5000);
  assert.equal(h.writesTo("m"), 1);
});

test("ADR-021: removal while the un-maximize is on its way leaves nothing behind", () => {
  const h = new MockHost();
  h.start();
  openMaximized(h, "gone", { delay: 40 });
  h.drain();
  assert.deepEqual(h.unmaximizes, ["gone"]);
  h.close("gone");
  h.advance(2000);
  assert.equal(h.engine.modeOf("gone"), null);
  assert.equal(h.engine.counters.errors, 0);
  assert.deepEqual(h.engine.check(), []);
});

test("ADR-021: a window opened maximized on a desktop not shown is un-maximized and tiled when shown", () => {
  const h = new MockHost();
  h.start();
  openMaximized(h, "h2", { membership: { output: "O1", desktops: ["D2"], onAllDesktops: false, activities: [] } });
  h.drain(); h.advance(100);
  assert.deepEqual(h.unmaximizes, ["h2"]);
  assert.equal(h.writesTo("h2"), 0, "never written while hidden");
  h.showDesktop("O1", "D2");
  h.drain(); h.advance(100);
  assert.equal(h.writesTo("h2"), 1);
  assert.ok(rectNear(onlyTile(h, "h2"), ALONE));
});

test("ADR-021: a state signal while the acknowledgement is on its way does not suspend it again (KWin still says maximized)", () => {
  const h = new MockHost();
  h.start();
  h.open("a");
  h.drain();
  const a0 = h.writesTo("a");
  openMaximized(h, "b", { delay: 30 });
  h.drain();
  assert.equal(h.writesTo("a"), a0 + 1, "a made room once");
  h.advance(5);
  h.setStates("b", {});                                // e.g. hiddenChanged: maximizeMode still 3 before the ack
  h.drain(); h.advance(100);
  assert.equal(h.writesTo("a"), a0 + 1, "a did not reflow back and forth");
  assert.equal(h.writesTo("b"), 1);
  assert.equal(onlyTile(h, "b").width < 700, true);
  assert.deepEqual(h.engine.explain("b")!.suspensions, []);
});

test("ADR-021: no gaps, one window: the maximized frame equals the tile, and the tile is still written (not the restore size)", () => {
  const h = new MockHost();
  const noGaps = (): ContextSettings => ({ ...DEFAULT_SETTINGS, gaps: { inner: 0, outer: { top: 0, right: 0, bottom: 0, left: 0 } } });
  h.start({ settingsFor: noGaps });
  const w = openMaximized(h, "z", { delay: 10 });
  h.drain();
  assert.equal(h.writesTo("z"), 1, "written although the frame already equals the tile");
  h.advance(100);
  assert.equal(w.states.maximized, false);
  assert.ok(rectNear(w.frame, FULL), `never at its restore size: ${JSON.stringify(w.frame)}`);
  assert.equal(h.engine.counters.corrections, 0);
  assert.equal(h.configuresSent.get("z"), 1);
});
