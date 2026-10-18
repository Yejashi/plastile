// Persistence (T27, ADR-013): snapshot round trip and validation, migrations with fixtures,
// conservative float matching (Q06), the persister's load/save policy, and the runtime wiring.
// Oracles: the fixture texts, the fake store's slots and write log, and the fake/mock windows'
// frames; never the engine's own claims about where a window is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rect, rectNear } from "../../src/core/geometry.ts";
import { buildSnapshot, contentKey, MAX_CONTEXTS, MAX_TEXT, parse, SCHEMA_VERSION, serialize, validate } from "../../src/persist/snapshot.ts";
import { migrate, type RawSnapshot } from "../../src/persist/migrate.ts";
import { identityKey, matchFloat } from "../../src/persist/match.ts";
import { DEBOUNCE_MS, Persister, type StateStore } from "../../src/runtime/persistence.ts";
import { createRuntime } from "../../src/runtime/main.ts";
import { Engine } from "../../src/core/engine.ts";
import { MockHost, meta } from "./mockHost.ts";
import { assertTiling } from "./helpers.ts";
import { desktop, fakeEnv, FakeQt, FakeWorkspace, output } from "./fakeKwin.ts";

const FIX = new URL("../fixtures/persist/", import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIX), "utf8");
const DESK = "5c5f0a2e-7a1b-4c3d-9e8f-000000000001";

/** In-memory Persistence.qml: two slots, a write log, and a manually fired one-shot timer. */
class FakeStore implements StateStore {
  slots = ["", ""];
  writes: Array<{ slot: number; text: string }> = [];
  timer: { ms: number; fn: () => void } | null = null;
  schedules = 0;
  openError = "";
  open(): string { return this.openError; }
  read(slot: number): string { return this.slots[slot]; }
  write(slot: number, text: string): void { this.slots[slot] = text; this.writes.push({ slot, text }); }
  location(): string { return "memory"; }
  schedule(ms: number, fn: () => void): void { this.timer = { ms, fn }; this.schedules++; }
  cancel(): void { this.timer = null; }
  fire(): void { const t = this.timer; this.timer = null; if (t) t.fn(); }
}

// ------------------------------------------------------------------ snapshot

test("T27: a v1 fixture parses, and serializing it gives the same text (canonical form, round trip)", () => {
  const text = fixture("v1.json").trim();
  const p = parse(text);
  assert.ok(p.ok, p.ok ? "" : p.reason);
  assert.equal(p.snapshot.schemaVersion, SCHEMA_VERSION);
  assert.equal(p.snapshot.generation, 7);
  assert.deepEqual(p.snapshot.contexts.map((c) => [c.outputKey, c.layout, c.masterStack?.ratio ?? null]),
    [["Virtual-0", null, 0.65], ["edid:Dell/U2720Q/ABC", "bsp", null]]);
  assert.equal(p.snapshot.floats[0].appId, "plastile-solo");
  assert.equal(serialize(p.snapshot), text);
});

test("T27: buildSnapshot from the engine's preferences round-trips through parse", () => {
  const s = buildSnapshot(
    [{ key: { output: "DP-1", desktop: DESK, activity: "a1" }, prefs: { layout: "monocle", masterStack: null } },
     { key: { output: "DP-2", desktop: DESK, activity: "a1" }, prefs: { layout: null, masterStack: { ratio: 0.7, masterCount: 2 } } }],
    [{ app: { appId: "org.kde.kate", resourceName: "kate", role: "MainWindow#1" },
       float: { rect: rect(10.5, 20, 640, 480), output: "DP-1", area: rect(0, 0, 1920, 1050) } }],
    3, "2026-10-18T00:00:00.000Z");
  const p = parse(serialize(s));
  assert.ok(p.ok, p.ok ? "" : p.reason);
  assert.deepEqual(p.snapshot, s);
  assert.equal(contentKey(p.snapshot), contentKey({ ...s, generation: 99, savedAt: "later" }), "content ignores generation and time");
});

test("T27: the snapshot is bounded: at most MAX_CONTEXTS contexts, the first (most important) kept", () => {
  const many = Array.from({ length: MAX_CONTEXTS + 10 }, (_, i) => ({
    key: { output: "O", desktop: `D${i}`, activity: "a" }, prefs: { layout: "bsp" as const, masterStack: null } }));
  const s = buildSnapshot(many, [], 1, "t");
  assert.equal(s.contexts.length, MAX_CONTEXTS);
  assert.equal(s.contexts[0].desktopId, "D0");
  assert.ok(parse(serialize(s)).ok);
});

test("T27/Q07: invalid, partial, empty and oversized texts are rejected as a whole", () => {
  const inv = parse(fixture("invalid.json"));
  assert.ok(!inv.ok && !inv.future);
  assert.match(inv.ok ? "" : inv.reason, /contexts\[0\]\.masterStack\.ratio: must be strictly between 0 and 1 \(and 2 more\)/);
  const part = parse(fixture("partial.json"));
  assert.ok(!part.ok && /not valid JSON/.test(part.reason), "a torn write is not JSON");
  assert.ok(!parse("").ok);
  assert.ok(!parse(" ".repeat(MAX_TEXT + 1)).ok);
  assert.ok(!parse("[1,2]").ok);
  const base = JSON.parse(fixture("v1.json")) as RawSnapshot;
  const variant = (f: (o: any) => void): boolean => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const o = JSON.parse(JSON.stringify(base));
    f(o);
    return validate(o).ok;
  };
  assert.ok(variant(() => {}), "control: the unmodified fixture validates");
  assert.ok(!variant((o) => { o.extra = 1; }), "unknown top-level key");
  assert.ok(!variant((o) => { delete o.floats; }), "missing key");
  assert.ok(!variant((o) => { o.generation = -1; }), "negative generation");
  assert.ok(!variant((o) => { o.contexts.push(o.contexts[0]); }), "duplicate context");
  assert.ok(!variant((o) => { o.contexts[0].masterStack.masterCount = 2.5; }), "fractional master count");
  assert.ok(!variant((o) => { o.contexts[0].masterStack.masterCount = 9; }), "master count above the limit");
  assert.ok(!variant((o) => { o.contexts[0].outputKey = ""; }), "empty output key");
  assert.ok(!variant((o) => { o.floats[0].rect.width = 0; }), "empty float rectangle");
  assert.ok(!variant((o) => { o.floats[0].area.x = "0"; }), "string coordinate");
  assert.ok(!variant((o) => { o.floats.push(o.floats[0]); }), "duplicate application identity");
  assert.ok(!variant((o) => { o.floats[0].appId = ""; }), "no application id");
});

// ----------------------------------------------------------------- migration

test("T27/Q07: an unknown future schema is rejected as such, never downgraded", () => {
  const p = parse(fixture("future.json"));
  assert.ok(!p.ok && p.future, JSON.stringify(p));
  assert.match(p.ok ? "" : p.reason, /schema version 99 is newer than this Plastile's 1/);
});

test("T27: migrations run in order from the stored version; a missing or broken step rejects", () => {
  const v1 = JSON.parse(fixture("v1.json")) as RawSnapshot;
  assert.deepEqual(migrate(v1, 1), { ok: true, value: v1, from: 1 }, "current version: unchanged");
  // A synthetic chain (the shipped chain is empty: v1 is the first schema).
  const steps = {
    1: (o: RawSnapshot) => ({ ...o, schemaVersion: 2, renamed: o.contexts }),
    2: (o: RawSnapshot) => { const { renamed, ...rest } = o; return { ...rest, schemaVersion: 3, contexts: renamed }; },
  };
  const m = migrate(v1, 3, steps);
  assert.ok(m.ok);
  assert.equal(m.value.schemaVersion, 3);
  assert.deepEqual(m.value.contexts, v1.contexts);
  assert.equal(m.from, 1);
  assert.equal(v1.schemaVersion, 1, "the input is not mutated");
  assert.deepEqual(migrate(v1, 3, { 1: steps[1] }), { ok: false, reason: "no migration from schema version 2", future: false });
  assert.ok(!migrate(v1, 2, { 1: (o) => o }).ok, "a step must produce the next version");
  assert.ok(!migrate({ schemaVersion: 0 }, 1).ok);
  assert.ok(!migrate({ schemaVersion: "1" }, 1).ok);
  assert.ok(!migrate(null, 1).ok);
});

// ------------------------------------------------------------------ matching

test("Q06: a saved float matches only when exactly one live window has the application identity", () => {
  const key = identityKey({ appId: "org.kde.kate", resourceName: "kate", role: "" })!;
  const saved = new Map([[key, "entry"]]);
  assert.deepEqual(matchFloat(saved, key, 1), { kind: "restore", entry: "entry" });
  assert.deepEqual(matchFloat(saved, key, 2), { kind: "ambiguous", count: 2 });
  assert.deepEqual(matchFloat(saved, key, 0), { kind: "none" });
  assert.deepEqual(matchFloat(saved, identityKey({ appId: "org.kde.kate", resourceName: "kate", role: "x" }), 1), { kind: "none" },
    "the role is part of the identity");
  assert.equal(identityKey({ appId: "", resourceName: "kate", role: "" }), null, "no application id: never matched");
});

function savedFloat(appId: string, r = rect(300, 200, 500, 400)) {
  return { app: { appId, resourceName: appId, role: "" }, float: { rect: r, output: "O1", area: rect(0, 0, 1280, 800) } };
}

test("T27/Q06: restored floats apply to the one live window of their application; two instances keep ordinary insertion", () => {
  {
    const h = new MockHost();
    const snaps = ["a", "solo"].map((id) => h.snapshot(h.make(id)));
    const e = new Engine(h, h, {});
    h.engine = e;
    e.restoreFloats([savedFloat("solo")]); // the runtime restores before start()
    e.start(snaps);
    h.drain();
    assert.equal(e.modeOf("solo"), "floating");
    assert.ok(rectNear(h.windows.get("solo")!.frame, rect(300, 200, 500, 400)), JSON.stringify(h.windows.get("solo")!.frame));
    assert.equal(e.modeOf("a"), "tiled");
    assert.equal(e.counters.restored, 1);
    assert.deepEqual(e.floatPreferences().map((p) => p.app.appId), ["solo"], "now the live window's preference");
  }
  {
    const h = new MockHost();
    const two = [h.make("x1", { meta: meta("solo") }), h.make("x2", { meta: meta("solo") })].map((w) => h.snapshot(w));
    const e = h.start();
    // Restore before the windows are known, as the runtime does (start() above adopts nothing).
    e.restoreFloats([savedFloat("solo")]);
    for (const s of two) e.windowAdded(s);
    h.drain();
    assert.deepEqual([e.modeOf("x1"), e.modeOf("x2")], ["tiled", "tiled"], "ambiguous: ordinary insertion");
    assert.equal(e.counters.restored, 0);
    assert.ok(e.counters.restoreAmbiguous >= 1);
    assert.equal(e.floatPreferences().length, 1, "the saved preference is kept for a later unambiguous start");
  }
});

test("T27: a floated window closed and opened again in the same session floats where it was (one window only)", () => {
  const h = new MockHost();
  const e = h.start();
  h.open("a"); h.open("solo");
  h.drain();
  h.active = "solo";
  e.execute("plastile.window.toggle-float");
  h.drain();
  h.userSetFrame("solo", rect(120, 90, 420, 330));
  h.close("solo");
  h.drain();
  assert.deepEqual(e.floatPreferences().map((p) => p.app.appId), ["solo"], "still saved after the window closed");
  h.open("solo2", { meta: meta("solo") });
  h.drain();
  assert.equal(e.modeOf("solo2"), "floating");
  assert.ok(rectNear(h.windows.get("solo2")!.frame, rect(120, 90, 420, 330)), JSON.stringify(h.windows.get("solo2")!.frame));
  // A second instance while the first is open does not take the position: the first one holds it.
  h.open("solo3", { meta: meta("solo") });
  h.drain();
  assert.equal(e.modeOf("solo3"), "tiled");
});

test("T27: floating a window records its application's preference; tiling it again forgets it", () => {
  const h = new MockHost();
  const e = h.start();
  let changes = 0;
  e.onPersistChange = () => { changes++; };
  h.open("a"); h.open("b");
  h.drain();
  h.active = "b";
  e.execute("plastile.window.toggle-float");
  h.drain();
  h.userSetFrame("b", rect(100, 120, 400, 300));
  assert.deepEqual(e.floatPreferences().map((p) => [p.app.appId, p.float.rect]), [["b", rect(100, 120, 400, 300)]]);
  assert.ok(changes >= 2, `float use marks persistence dirty (${changes})`);
  e.execute("plastile.window.toggle-float");
  h.drain();
  assert.deepEqual(e.floatPreferences(), []);
  const before = changes;
  e.execute("plastile.focus.next");
  assert.equal(changes, before, "focus is not a preference");
  e.execute("plastile.resize.grow");
  assert.equal(changes, before + 1, "a ratio step is");
});

// ----------------------------------------------------------------- persister

function model() {
  const h = new MockHost();
  const e = h.start();
  return { h, e };
}

function snapText(generation: number, ratio: number, desktop = "D1"): string {
  return serialize(buildSnapshot([{ key: { output: "O1", desktop, activity: "default" },
    prefs: { layout: null, masterStack: { ratio, masterCount: 1 } } }], [], generation, "t"));
}

test("T27: load takes the newest valid slot; a damaged slot costs one diagnostic and is the next one written", () => {
  const { h, e } = model();
  const store = new FakeStore();
  store.slots = [snapText(4, 0.7), "{\"schemaVersion\":1,\"gen"];
  const logs: string[] = [];
  const p = new Persister(store, e, { now: () => h.t, log: (lv, m) => { logs.push(`${lv} ${m}`); }, stamp: () => "t" });
  const s = p.load();
  assert.equal(s?.generation, 4);
  assert.deepEqual(logs.filter((l) => l.startsWith("warn")).length, 1, logs.join("\n"));
  assert.match(logs[0], /slot 1: not valid JSON .*using slot 0 \(generation 4\)/);
  assert.equal(e.contextPreferences()[0].prefs.masterStack?.ratio, 0.7);
  // The next save goes to the damaged slot, keeping the valid one.
  e.setContextPreferences({ output: "O1", desktop: "D1", activity: "default" }, { layout: "bsp", masterStack: null });
  p.markDirty();
  h.t += DEBOUNCE_MS;
  store.fire();
  assert.deepEqual(store.writes.map((w) => w.slot), [1]);
  assert.equal(store.slots[0], snapText(4, 0.7), "previous valid snapshot untouched");
  const again = parse(store.slots[1]);
  assert.ok(again.ok && again.snapshot.generation === 5);
});

test("T27: newest generation wins regardless of slot; both damaged gives defaults and one diagnostic", () => {
  {
    const { h, e } = model();
    const store = new FakeStore();
    store.slots = [snapText(8, 0.62), snapText(9, 0.68)];
    const p = new Persister(store, e, { now: () => h.t, log: () => {}, stamp: () => "t" });
    assert.equal(p.load()?.generation, 9);
    assert.equal(e.contextPreferences()[0].prefs.masterStack?.ratio, 0.68);
  }
  {
    const { h, e } = model();
    const store = new FakeStore();
    store.slots = ["garbage", fixture("partial.json")];
    const logs: string[] = [];
    const p = new Persister(store, e, { now: () => h.t, log: (lv, m) => { logs.push(`${lv} ${m}`); }, stamp: () => "t" });
    assert.equal(p.load(), null);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^warn saved state rejected: slot 0: .*; slot 1: .*; using defaults$/);
    assert.deepEqual(e.contextPreferences(), []);
    assert.equal(p.state, "active");
  }
});

test("T27/Q07: a newer schema on disk is left alone: read-only, nothing written", () => {
  const { h, e } = model();
  const store = new FakeStore();
  store.slots = [fixture("future.json"), ""];
  const logs: string[] = [];
  const p = new Persister(store, e, { now: () => h.t, log: (lv, m) => { logs.push(`${lv} ${m}`); }, stamp: () => "t" });
  p.load();
  assert.equal(p.state, "read-only");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /newer Plastile: nothing is saved this session/);
  p.markDirty();
  assert.equal(store.timer, null, "no maintenance deadline");
  p.shutdown();
  assert.deepEqual(store.writes, []);
});

test("T27/Q05: QtCore unavailable: one diagnostic, in-memory operation, no timer", () => {
  const { h, e } = model();
  const store = new FakeStore();
  store.openError = "module \"QtCore\" is not installed";
  const logs: string[] = [];
  const p = new Persister(store, e, { now: () => h.t, log: (lv, m) => { logs.push(`${lv} ${m}`); }, stamp: () => "t" });
  assert.equal(p.load(), null);
  assert.equal(p.state, "memory");
  assert.deepEqual(logs, ["warn persistence unavailable (QtCore Settings could not be created); preferences are kept in memory only"]);
  p.markDirty();
  p.shutdown();
  assert.equal(store.schedules, 0);
  assert.deepEqual(store.writes, []);
});

test("T27: saves are debounced maintenance work: re-armed after the last change, never periodic, skipped when unchanged", () => {
  const { h, e } = model();
  const store = new FakeStore();
  const p = new Persister(store, e, { now: () => h.t, log: () => {}, stamp: () => "t" });
  p.load();
  const key = { output: "O1", desktop: "D1", activity: "default" };
  e.setContextPreferences(key, { layout: "bsp", masterStack: null });
  p.markDirty();
  p.markDirty();
  assert.equal(store.schedules, 1, "one deadline for a burst of changes");
  assert.equal(store.timer?.ms, DEBOUNCE_MS);
  h.t += 1500;
  p.markDirty(); // a later change pushes the save out
  h.t += 500;
  store.fire();
  assert.equal(store.writes.length, 0, "not yet: 2 s after the last change");
  assert.equal(store.timer?.ms, 1500, "re-armed for the remainder");
  h.t += 1500;
  store.fire();
  assert.equal(store.writes.length, 1);
  assert.equal(store.timer, null, "nothing armed once saved (no periodic timer)");
  // Unchanged content: no write.
  p.markDirty();
  h.t += DEBOUNCE_MS;
  store.fire();
  assert.equal(store.writes.length, 1);
  assert.equal(p.skipped, 1);
  // A change then a clean unload: one write at unload, the deadline cancelled.
  e.setContextPreferences(key, { layout: "monocle", masterStack: null });
  p.markDirty();
  assert.notEqual(store.timer, null);
  p.shutdown();
  assert.equal(store.timer, null);
  assert.equal(store.writes.length, 2);
  assert.deepEqual(store.writes.map((w) => w.slot), [0, 1], "slots alternate");
  p.markDirty();
  assert.equal(store.timer, null, "nothing after shutdown");
});

test("T27: a save due during an interactive move or resize waits for a quiet period after it", () => {
  const { h, e } = model();
  h.open("a");
  h.drain();
  const store = new FakeStore();
  const p = new Persister(store, e, { now: () => h.t, log: () => {}, stamp: () => "t" });
  p.load();
  e.setContextPreferences({ output: "O1", desktop: "D1", activity: "default" }, { layout: "bsp", masterStack: null });
  p.markDirty();
  h.setStates("a", { interactive: "move" });
  h.t += DEBOUNCE_MS;
  store.fire();
  assert.equal(store.writes.length, 0, "not during the drag");
  assert.equal(store.timer?.ms, DEBOUNCE_MS);
  h.setStates("a", { interactive: "none" });
  h.t += DEBOUNCE_MS;
  store.fire();
  assert.equal(store.writes.length, 1, "saved once the drag ended");
});

// ------------------------------------------------------------------- runtime

function runtimeWith(store: FakeStore) {
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1")]);
  const qt = new FakeQt();
  const wins = [1, 2].map((i) => {
    const w = ws.window({ caption: `w${i}`, resourceClass: `app${i}`, resourceName: `app${i}`,
      frameGeometry: { x: 20 * i, y: 20 * i, width: 400, height: 300 } });
    ws.windows.push(w);
    return w;
  });
  const f = fakeEnv(ws, qt);
  f.env.state = store;
  const rt = createRuntime(f.env);
  qt.drain();
  return { ws, qt, wins, f, rt };
}

test("T27: a command marks state dirty without I/O; the deadline saves; the next load restores before the first solve", () => {
  const store = new FakeStore();
  const a = runtimeWith(store);
  const w0 = a.wins[0].frameGeometry.width;
  a.ws.activeWindow = a.wins[0];
  let readsDuringCommand = 0, writesDuringCommand = 0;
  const realRead = store.read.bind(store), realWrite = store.write.bind(store);
  let inCommand = false;
  store.read = (slot) => { if (inCommand) readsDuringCommand++; return realRead(slot); };
  store.write = (slot, text) => { if (inCommand) writesDuringCommand++; realWrite(slot, text); };
  inCommand = true;
  a.rt.dispatch("plastile.resize.grow");
  a.rt.dispatch("plastile.resize.grow");
  inCommand = false;
  a.qt.drain();
  assert.equal(readsDuringCommand + writesDuringCommand, 0, "no store I/O inside command handling");
  assert.notEqual(store.timer, null, "a maintenance deadline is armed");
  const grown = a.wins[0].frameGeometry.width;
  assert.ok(grown > w0);
  // Fire the deadline after the quiet period (the runtime's clock is Date.now()).
  const realNow = Date.now;
  Date.now = () => realNow() + DEBOUNCE_MS + 10;
  try { store.fire(); } finally { Date.now = realNow; }
  assert.equal(store.writes.length, 1);
  a.rt.shutdown();
  assert.equal(store.writes.length, 1, "nothing new to save at unload");
  // A new runtime (reload): the master column has the saved ratio from its first solve.
  const b = runtimeWith(store);
  assert.equal(b.wins[0].frameGeometry.width, grown);
  b.rt.shutdown();
});

test("T27/Q05: without the store (QtCore unavailable) the runtime tiles and reports once", () => {
  const store = new FakeStore();
  store.openError = "module \"QtCore\" is not installed";
  const a = runtimeWith(store);
  assert.ok(a.f.lines.filter((l) => /persistence unavailable/.test(l)).length === 1, a.f.lines.join("\n"));
  assertTiling(new Map(a.wins.map((w) => [w.caption, w.frameGeometry])), rect(0, 0, 1280, 800));
  assert.ok(a.wins.every((w) => w.frameGeometry.height === 784), "both tiled side by side");
  a.ws.activeWindow = a.wins[0];
  assert.equal(a.rt.dispatch("plastile.resize.grow")?.status, "accepted");
  a.rt.shutdown();
  assert.deepEqual(store.writes, []);
});
