// First-run feedback (the first physical session's report: twice "not working" while monocle,
// chosen by two Meta+Shift+Space presses and restored at login, looked like a dead tiler, and
// the default log level hid every sign of life). Unit layer, fake KWin surface:
//  - `notice` lines at the default level: started, stopped, a layout a command chose,
//    pause/resume, saved layouts restored at load, explain;
//  - Plasma's OSD (org.kde.osdService.showText) on a later turn, one call in flight, off when
//    configured or when the service failed;
//  - the counters split tiled and suspended members.
// Oracles: the printed log lines and the recorded D-Bus requests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../../src/runtime/main.ts";
import { layoutMessage, Osd, OSD_IFACE, OSD_PATH, OSD_SERVICE } from "../../src/runtime/osd.ts";
import type { BusCall } from "../../src/runtime/shortcuts.ts";
import type { StateStore } from "../../src/runtime/persistence.ts";
import { buildSnapshot, serialize } from "../../src/persist/snapshot.ts";
import { desktop, fakeEnv, FakeQt, FakeWorkspace, output, type FakeWindow } from "./fakeKwin.ts";

interface Req { call: BusCall; done: (r: unknown[]) => void; fail: () => void }

function last(lines: string[]): string {
  return lines[lines.length - 1] ?? "";
}

function rig(cfg: Record<string, unknown> = {}, opts: { desktops?: number; outputs?: number; state?: StateStore } = {}) {
  const outs = [output("eDP-1", { x: 0, y: 0, width: 1280, height: 800 })];
  if ((opts.outputs ?? 1) > 1) outs.push(output("DP-2", { x: 1280, y: 0, width: 1280, height: 800 }));
  const desks = Array.from({ length: opts.desktops ?? 1 }, (_v, i) => desktop(`Desktop ${i + 1}`, i + 1));
  const ws = new FakeWorkspace(outs, desks);
  const qt = new FakeQt();
  const wins: FakeWindow[] = [];
  for (let i = 1; i <= 2; ++i) {
    const w = ws.window({ caption: `w${i}`, resourceClass: `app${i}`, resourceName: `app${i}`,
      frameGeometry: { x: 20 * i, y: 20 * i, width: 400, height: 300 } });
    ws.windows.push(w);
    wins.push(w);
  }
  const f = fakeEnv(ws, qt, cfg);
  const reqs: Req[] = [];
  f.env.dbus = (call: BusCall, done: (r: unknown[]) => void, fail: () => void) => { reqs.push({ call, done, fail }); };
  if (opts.state) f.env.state = opts.state;
  const rt = createRuntime(f.env);
  const osd = () => reqs.filter((r) => r.call.service === OSD_SERVICE);
  const notices = () => f.lines.filter((l) => l.startsWith("plastile notice "));
  return { ws, qt, wins, f, rt, reqs, osd, notices };
}

test("notice lines show at the default level: started (windows, revision, layout per visible context), stopped", () => {
  const r = rig();
  assert.deepEqual(r.notices(), ["plastile notice started 0.1.0: 2 windows, configuration revision 1; layout master-stack on eDP-1 / Desktop 1"]);
  assert.ok(!r.f.lines.some((l) => l.startsWith("plastile info ")), "info stays hidden at warn");
  r.rt.shutdown();
  assert.equal(last(r.notices()), "plastile notice stopped");
  const two = rig({}, { outputs: 2, desktops: 3 });
  assert.match(two.notices()[0], /^plastile notice started 0\.1\.0: 2 windows, configuration revision 1; layout master-stack on eDP-1 \/ Desktop 1; layout master-stack on DP-2 \/ Desktop 1$/);
  two.rt.shutdown();
  for (const level of ["error", "off"]) {
    const q = rig({ diagnostics: level });
    q.rt.dispatch("plastile.layout.monocle");
    q.rt.shutdown();
    assert.deepEqual(q.notices(), [], `${level} hides notices`);
  }
  const info = rig({ diagnostics: "info" });
  assert.equal(info.notices().length, 1, "info and debug show notices too");
  info.rt.shutdown();
});

test("a layout command logs one notice and shows the OSD on a later turn; floating says tiling is off", () => {
  const r = rig();
  r.qt.drain(); // the shortcut audit's first request
  const before = r.reqs.length;
  r.ws.activeWindow = r.wins[0];
  r.rt.dispatch("plastile.layout.next");
  assert.equal(last(r.notices()), "plastile notice layout bsp on eDP-1 / Desktop 1 (was master-stack)");
  assert.equal(r.reqs.length, before, "no D-Bus call inside the command");
  r.qt.drain();
  const sent = r.osd();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].call, { service: OSD_SERVICE, path: OSD_PATH, iface: OSD_IFACE, method: "showText",
    args: ["view-grid", "BSP layout"] }, "one output, one desktop: nothing else to name");
  sent[0].done([]);
  r.rt.dispatch("plastile.layout.next");
  r.rt.dispatch("plastile.layout.next"); // monocle, then floating
  r.qt.drain();
  assert.equal(r.osd().length, 2, "the second waits for the first reply");
  assert.deepEqual(r.osd()[1].call.args, ["window-duplicate", "Floating layout (tiling off)"], "the newest replaces the waiting one");
  r.osd()[1].done([]);
  r.qt.drain();
  assert.equal(r.osd().length, 2, "nothing left to send");
  const lines = r.notices().filter((l) => l.indexOf("notice layout ") >= 0);
  assert.deepEqual(lines.map((l) => l.replace("plastile notice layout ", "")),
    ["bsp on eDP-1 / Desktop 1 (was master-stack)", "monocle on eDP-1 / Desktop 1 (was bsp)", "floating on eDP-1 / Desktop 1 (was monocle)"]);
  r.rt.shutdown();
});

test("the OSD names the desktop when there are several, and the output when there are several", () => {
  assert.equal(layoutMessage("monocle", "Desktop 2", null).text, "Monocle layout — Desktop 2");
  assert.equal(layoutMessage("monocle", null, "DP-2").text, "Monocle layout — DP-2");
  assert.equal(layoutMessage("monocle", "Desktop 2", "DP-2").text, "Monocle layout — Desktop 2 on DP-2");
  const r = rig({}, { desktops: 5, outputs: 2 });
  r.qt.drain();
  r.ws.current.set("eDP-1", r.ws.desktops[1]);
  r.ws.current.set("DP-2", r.ws.desktops[1]);
  r.ws.currentDesktopChanged.emit();
  r.ws.activeWindow = null;
  r.rt.dispatch("plastile.layout.monocle");
  r.qt.drain();
  assert.deepEqual(r.osd()[0].call.args, ["window-maximize", "Monocle layout — Desktop 2 on eDP-1"]);
  assert.equal(last(r.notices()), "plastile notice layout monocle on eDP-1 / Desktop 2 (was master-stack)");
  r.rt.shutdown();
});

test("suspend and resume: a notice and the OSD each; explain is a notice too", () => {
  const r = rig();
  r.qt.drain();
  r.rt.dispatch("plastile.runtime.toggle-suspend");
  r.qt.drain();
  r.osd()[0].done([]);
  r.rt.dispatch("plastile.runtime.toggle-suspend");
  r.qt.drain();
  assert.deepEqual(r.osd().map((q) => q.call.args), [["media-playback-pause", "Tiling paused"], ["media-playback-start", "Tiling resumed"]]);
  assert.deepEqual(r.notices().slice(1), ["plastile notice tiling paused", "plastile notice tiling resumed"]);
  r.ws.activeWindow = r.wins[0];
  r.rt.dispatch("plastile.inspect.explain-window");
  const ex = last(r.notices());
  assert.ok(ex.startsWith("plastile notice explain {"), "shown at the default level");
  assert.equal(JSON.parse(ex.slice("plastile notice explain ".length)).suspended, null);
  r.rt.shutdown();
});

test("no OSD when the option is off, without a bus, or within 30 s of a failure (one debug line, no retry by itself)", () => {
  const off = rig({ osd: "false" });
  off.qt.drain();
  off.rt.dispatch("plastile.layout.monocle");
  off.qt.drain();
  assert.equal(off.osd().length, 0, "osd=false sends nothing");
  assert.equal(off.notices().length, 2, "the notice still logs");
  off.rt.shutdown();

  const r = rig({ diagnostics: "debug" });
  r.qt.drain();
  r.rt.dispatch("plastile.layout.monocle");
  r.qt.drain();
  r.osd()[0].fail(); // plasmashell absent: ServiceUnknown
  const dbg = r.f.lines.filter((l) => l.indexOf("on-screen display unavailable") >= 0);
  assert.equal(dbg.length, 1);
  assert.match(dbg[0], /^plastile debug /);
  r.rt.dispatch("plastile.layout.bsp");
  r.rt.dispatch("plastile.runtime.toggle-suspend");
  r.qt.drain();
  assert.equal(r.osd().length, 1, "commands right after a failure send nothing");
  r.rt.dispatch("plastile.inspect.counters");
  const counters = JSON.parse(r.f.lines.find((l) => l.startsWith("plastile counters "))!.slice("plastile counters ".length));
  assert.deepEqual(counters.osd, { state: "failed", sent: 1, failures: 1 });
  assert.equal(counters.suspended, true);
  r.rt.shutdown();

  const late = rig();
  late.qt.drain();
  late.rt.dispatch("plastile.layout.monocle");
  late.rt.shutdown();
  late.qt.drain();
  assert.equal(late.osd().length, 0, "a message still waiting at unload is dropped");

  const nobus = rig();
  delete nobus.f.env.dbus;
  const rt = createRuntime(nobus.f.env);
  rt.dispatch("plastile.layout.monocle");
  nobus.qt.drain();
  assert.equal(nobus.osd().length, 0);
  rt.shutdown();
  nobus.rt.shutdown();
});

test("after a failure the OSD tries again on a command 30 s later (plasmashell started late or restarted); one debug line per streak", () => {
  let t = 1000;
  const calls: Array<{ args: readonly unknown[]; done: () => void; fail: () => void }> = [];
  const later: Array<() => void> = [];
  const debug: string[] = [];
  const osd = new Osd((c, done, fail) => { calls.push({ args: c.args ?? [], done: () => done([]), fail }); },
    (fn) => { if (!later.includes(fn)) later.push(fn); }, () => t, (m) => debug.push(m));
  const turn = () => { const fs = later.splice(0); for (const f of fs) f(); };
  const show = (text: string) => { osd.show({ icon: "i", text }); turn(); };
  show("A");
  calls[0].fail();                       // at login KWin starts before plasmashell
  assert.equal(osd.state(), "failed");
  t += 29999; show("B");                 // inside the window: dropped, nothing sent
  assert.equal(calls.length, 1);
  t += 1; show("C");                     // 30 s after the failure: one try
  assert.deepEqual(calls.map((c) => c.args[1]), ["A", "C"]);
  calls[1].fail();                       // still absent: same streak, no second debug line
  assert.equal(debug.length, 1);
  assert.match(debug[0], /on-screen display unavailable/);
  t += 10000; show("D");                 // 10 s after the second failure: dropped
  assert.equal(calls.length, 2);
  t += 20000; show("E");
  calls[2].done();                       // plasmashell is back: the streak ends
  assert.equal(osd.state(), "idle");
  show("F");
  assert.deepEqual(calls.map((c) => c.args[1]), ["A", "C", "E", "F"], "no message was ever resent");
  calls[3].fail();                       // plasmashell restarted: a new streak, a new line
  assert.equal(debug.length, 2);
  assert.equal(osd.failures, 3);
  assert.equal(later.length, 0, "nothing scheduled by itself: no timer, no loop");
  osd.stop();
  t += 60000; show("G");
  assert.equal(calls.length, 4, "nothing after stop");
});

test("counters show tiled and suspended members per context", () => {
  const r = rig();
  r.qt.drain();
  r.wins[0].maximizeMode = 3;
  r.wins[0].maximizedChanged.emit();
  r.qt.drain();
  r.rt.dispatch("plastile.inspect.counters");
  const c = JSON.parse(r.f.lines.find((l) => l.startsWith("plastile counters "))!.slice("plastile counters ".length));
  assert.deepEqual(c.contexts.map((x: { members: number; tiled: number; suspended: number }) => [x.members, x.tiled, x.suspended]), [[2, 1, 1]]);
  r.rt.shutdown();
});

class Store implements StateStore {
  slots = ["", ""];
  reads: Array<(t: unknown) => void> = [];
  read(done: (t: unknown) => void): void { this.reads.push(done); }
  write(_s: number, _t: string, done: (ok: boolean) => void): void { done(true); }
  schedule(): void {}
  cancel(): void {}
}

test("at load, saved layouts that differ from the configuration are named in one notice", () => {
  const store = new Store();
  const key = (d: number) => ({ output: "eDP-1", desktop: `desk-Desktop ${d}`, activity: "default" });
  store.slots[0] = serialize(buildSnapshot([
    { key: key(1), prefs: { layout: "monocle", masterStack: null } },
    { key: key(2), prefs: { layout: "master-stack", masterStack: null } }, // the configured one: not news
    { key: key(3), prefs: { layout: "bsp", masterStack: null } },
    { key: key(4), prefs: { layout: null, masterStack: { ratio: 0.6, masterCount: 1 } } },
  ], [], 1, "t"));
  const r = rig({}, { desktops: 3, state: store });
  assert.equal(store.reads.length, 1);
  store.reads[0](store.slots.slice());
  r.qt.drain();
  const restored = r.notices().filter((l) => l.indexOf("restored") >= 0);
  assert.deepEqual(restored, ["plastile notice restored saved layout monocle for eDP-1 / Desktop 1, bsp for eDP-1 / Desktop 3"]);
  r.rt.shutdown();

  const plain = new Store();
  plain.slots[0] = serialize(buildSnapshot([{ key: key(1), prefs: { layout: null, masterStack: { ratio: 0.6, masterCount: 1 } } }], [], 1, "t"));
  const q = rig({}, { state: plain });
  plain.reads[0](plain.slots.slice());
  assert.equal(q.notices().filter((l) => l.indexOf("restored") >= 0).length, 0, "a ratio alone is not announced");
  q.rt.shutdown();
});
