// Persistence (T27; ADR-013, write path ADR-020): snapshot round trip and validation, migrations
// with fixtures, conservative float matching (Q06), the asynchronous persister's load/save policy,
// and the runtime wiring. Oracles: the fixture texts, the fake helper's slots and request log, and
// the fake/mock windows' frames; never the engine's own claims about where a window is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rect, rectNear } from "../../src/core/geometry.ts";
import {
  buildSnapshot, contentOf, MAX_CONTEXTS, MAX_HINT, MAX_TEXT, parse, SCHEMA_VERSION, serialize, validate, type Snapshot,
} from "../../src/persist/snapshot.ts";
import { MIGRATIONS, migrate, type RawSnapshot } from "../../src/persist/migrate.ts";
import { identityKey, matchFloat } from "../../src/persist/match.ts";
import { DEBOUNCE_MS, LOAD_HOLD_MS, Persister, type StateStore } from "../../src/runtime/persistence.ts";
import { createRuntime } from "../../src/runtime/main.ts";
import { Engine } from "../../src/core/engine.ts";
import { MockHost, meta } from "./mockHost.ts";
import { assertTiling } from "./helpers.ts";
import { desktop, fakeEnv, FakeQt, FakeWorkspace, output } from "./fakeKwin.ts";

const FIX = new URL("../fixtures/persist/", import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIX), "utf8");
const DESK = "5c5f0a2e-7a1b-4c3d-9e8f-000000000001";

/**
 * In-memory Persistence.qml plus helper: two slots, requests that stay pending until the test
 * answers them (replies are asynchronous, as over D-Bus), and a manually fired one-shot timer.
 */
class FakeStore implements StateStore {
  slots = ["", ""];
  /** Writes the helper stored, in order. */
  writes: Array<{ slot: number; text: string }> = [];
  /** Every Write issued, answered or not. */
  issued: Array<{ slot: number; text: string }> = [];
  reads: Array<{ done: (t: unknown) => void; fail: () => void }> = [];
  pending: Array<{ slot: number; text: string; done: (ok: boolean) => void }> = [];
  timer: { ms: number; fn: () => void } | null = null;
  schedules = 0;
  /** The helper is not installed: every request fails. */
  absent = false;
  read(done: (t: unknown) => void, fail: () => void): void { this.reads.push({ done, fail }); }
  write(slot: number, text: string, done: (ok: boolean) => void): void {
    this.issued.push({ slot, text });
    this.pending.push({ slot, text, done });
  }
  schedule(ms: number, fn: () => void): void { this.timer = { ms, fn }; this.schedules++; }
  cancel(): void { this.timer = null; }
  fire(): void { const t = this.timer; this.timer = null; if (t) t.fn(); }
  /** Deliver the oldest Read reply (the slots as they are now). */
  answerRead(reply?: unknown): void {
    const r = this.reads.shift();
    assert.ok(r, "a Read is pending");
    if (this.absent) r.fail(); else r.done(reply === undefined ? this.slots.slice() : reply);
  }
  /** Deliver the oldest Write reply; ok false: the helper failed (or is gone). */
  answerWrite(ok = true): void {
    const w = this.pending.shift();
    assert.ok(w, "a Write is pending");
    if (ok && !this.absent) { this.slots[w.slot] = w.text; this.writes.push({ slot: w.slot, text: w.text }); }
    w.done(ok && !this.absent);
  }
  answerAll(): void {
    while (this.reads.length) this.answerRead();
    while (this.pending.length) this.answerWrite();
  }
}

// ------------------------------------------------------------------ snapshot

test("T27: a current-version fixture parses, and serializing it gives the same text (canonical form, round trip)", () => {
  assert.equal(SCHEMA_VERSION, 2);
  const text = fixture("v2-from-v1.json").trim();
  const p = parse(text);
  assert.ok(p.ok, p.ok ? "" : p.reason);
  assert.equal(p.snapshot.schemaVersion, SCHEMA_VERSION);
  assert.equal(p.migratedFrom, 2);
  assert.equal(p.snapshot.generation, 7);
  assert.deepEqual(p.snapshot.contexts.map((c) => [c.outputKey, c.layout, c.masterStack?.ratio ?? null]),
    [["Virtual-0", null, 0.65], ["edid:Dell/U2720Q/ABC", "bsp", null]]);
  assert.equal(p.snapshot.floats[0].appId, "plastile-solo");
  assert.equal(p.snapshot.floats[0].windowHint, "");
  assert.equal(serialize(p.snapshot), text);
});

test("T27: a version-1 file still loads: migrated to version 2, every float without a window hint", () => {
  const p = parse(fixture("v1.json").trim());
  assert.ok(p.ok, p.ok ? "" : p.reason);
  assert.equal(p.migratedFrom, 1);
  assert.equal(p.snapshot.schemaVersion, 2);
  assert.deepEqual(p.snapshot.floats.map((f) => f.windowHint), [""]);
  assert.equal(serialize(p.snapshot), fixture("v2-from-v1.json").trim(), "the same data as the migration's output fixture");
});

test("T27: buildSnapshot from the engine's preferences round-trips through parse", () => {
  const s = buildSnapshot(
    [{ key: { output: "DP-1", desktop: DESK, activity: "a1" }, prefs: { layout: "monocle", masterStack: null } },
     { key: { output: "DP-2", desktop: DESK, activity: "a1" }, prefs: { layout: null, masterStack: { ratio: 0.7, masterCount: 2 } } }],
    [{ app: { appId: "org.kde.kate", resourceName: "kate", role: "MainWindow#1" },
       float: { rect: rect(10.5, 20, 640, 480), output: "DP-1", area: rect(0, 0, 1920, 1050) },
       window: "{0a1b2c3d-0000-4000-8000-00000000000a}" }],
    3, "2026-10-18T00:00:00.000Z");
  const p = parse(serialize(s));
  assert.ok(p.ok, p.ok ? "" : p.reason);
  assert.deepEqual(p.snapshot, s);
  assert.equal(p.snapshot.floats[0].windowHint, "{0a1b2c3d-0000-4000-8000-00000000000a}", "the window hint is kept");
  assert.equal(contentOf(serialize(p.snapshot)), contentOf(serialize({ ...s, generation: 99, savedAt: "later" })),
    "content ignores generation and time");
});

test("T27: a text's content is equal exactly when contexts and floats are; generation and time do not count", () => {
  const p = parse(snapText(3, 0.6, "D1", [savedFloat("a\u0000\"b,\"contexts\":")]));
  assert.ok(p.ok);
  const s = p.snapshot;
  const same = contentOf(serialize({ ...s, generation: 99, savedAt: ",\"contexts\":[]" }));
  assert.equal(contentOf(serialize(s)), same, "a savedAt that looks like the key is escaped in JSON");
  assert.notEqual(contentOf(serialize({ ...s, floats: [] })), same);
  assert.notEqual(contentOf(serialize({ ...s, contexts: [] })), same);
  assert.ok(contentOf(serialize(s)).startsWith(',"contexts":['));
  // A text written in another key order: a different content (one unneeded save), never an equal one by accident.
  const reordered = JSON.stringify({ floats: s.floats, contexts: s.contexts, savedAt: "t", generation: 3, schemaVersion: 1 });
  assert.ok(parse(reordered).ok);
  assert.notEqual(contentOf(reordered), same);
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
  const base = JSON.parse(fixture("v2-from-v1.json")) as RawSnapshot;
  const variant = (f: (o: any) => void): boolean => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const o = JSON.parse(JSON.stringify(base));
    f(o);
    return validate(o).ok;
  };
  assert.ok(variant(() => {}), "control: the unmodified fixture validates");
  assert.ok(variant((o) => { o.contexts[1].layout = "scrolling"; }), "every layout kind, scrolling included");
  assert.ok(variant((o) => { o.contexts[1].layout = "zones"; }), "zones too (a layout chosen with plastile.layout.zones)");
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
  assert.ok(variant((o) => { o.floats[0].windowHint = "{0a1b2c3d-0000-4000-8000-00000000000a}"; }), "a window hint");
  assert.ok(variant((o) => { o.floats[0].windowHint = "x".repeat(MAX_HINT); }), "a window hint at the length bound");
  assert.ok(!variant((o) => { o.floats[0].windowHint = "x".repeat(MAX_HINT + 1); }), "a window hint over the bound");
  assert.ok(!variant((o) => { o.floats[0].windowHint = 7; }), "a window hint that is not a string");
  assert.ok(!variant((o) => { o.floats[0].windowHint = null; }), "a null window hint");
  assert.ok(!variant((o) => { delete o.floats[0].windowHint; }), "a version-2 float without its window hint");
  assert.ok(!variant((o) => { o.schemaVersion = 1; }), "validation is of the current version only (parse migrates first)");
  const long = JSON.parse(JSON.stringify(base));
  long.floats[0].windowHint = "x".repeat(MAX_HINT + 1);
  assert.match((validate(long) as { reason: string }).reason, /^floats\[0\]\.windowHint: must be a string of at most 128 characters$/);
});

// ----------------------------------------------------------------- migration

test("T27/Q07: an unknown future schema is rejected as such, never downgraded", () => {
  const p = parse(fixture("future.json"));
  assert.ok(!p.ok && p.future, JSON.stringify(p));
  assert.match(p.ok ? "" : p.reason, /schema version 99 is newer than this Plastile's 2/);
  // The next version up is as unknown: a version-3 file is never read as version 2.
  const v3 = JSON.parse(fixture("v2-from-v1.json")) as RawSnapshot;
  v3.schemaVersion = 3;
  const q = parse(JSON.stringify(v3));
  assert.ok(!q.ok && q.future, JSON.stringify(q));
  assert.match(q.ok ? "" : q.reason, /schema version 3 is newer than this Plastile's 2/);
});

test("T27: migration 1 -> 2 matches its fixtures, adds an empty window hint to every float, and is pure", () => {
  const v1 = JSON.parse(fixture("v1.json")) as RawSnapshot;
  const copy = JSON.parse(JSON.stringify(v1));
  const m = migrate(v1, 2);
  assert.ok(m.ok);
  assert.equal(m.from, 1);
  assert.deepEqual(m.value, JSON.parse(fixture("v2-from-v1.json")), "the output fixture");
  assert.equal(JSON.stringify(m.value), fixture("v2-from-v1.json").trim(), "key order kept: the canonical text");
  assert.deepEqual(v1, copy, "the input is not mutated");
  // Shapes the step does not understand pass through for validation to reject; none throws.
  const odd = MIGRATIONS[1]({ schemaVersion: 1, floats: [1, null, [], { appId: "a" }] });
  assert.deepEqual(odd, { schemaVersion: 2, floats: [1, null, [], { appId: "a", windowHint: "" }] });
  assert.deepEqual(MIGRATIONS[1]({ schemaVersion: 1, floats: "x" }), { schemaVersion: 2, floats: "x" });
  assert.deepEqual(MIGRATIONS[1]({ schemaVersion: 1 }), { schemaVersion: 2 });
  assert.ok(!parse(JSON.stringify({ ...v1, floats: "x" })).ok, "and validation rejects them");
});

test("T27: migrations run in order from the stored version; a missing or broken step rejects", () => {
  const v1 = JSON.parse(fixture("v1.json")) as RawSnapshot;
  assert.deepEqual(migrate(v1, 1), { ok: true, value: v1, from: 1 }, "current version: unchanged");
  // A synthetic chain.
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

/** A saved float preference; `window` is its same-session window hint ("" for none, as from a version-1 file). */
function savedFloat(appId: string, r = rect(300, 200, 500, 400), window = "") {
  return { app: { appId, resourceName: appId, role: "" }, float: { rect: r, output: "O1", area: rect(0, 0, 1280, 800) }, window };
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

test("T27: a saved float that arrives while the window's tile request is in flight is restored once it settles", () => {
  // The window was floating at its saved rectangle before the reload; the first solve tiles it with a slow client, and
  // the helper's reply arrives before the client committed. KWin drops a write back to the committed size while a
  // configure is in flight (E04, modelled by MockHost), so writing at once would leave the window on its tile.
  const h = new MockHost();
  const saved = rect(300, 200, 500, 400);
  const snaps = [h.make("a"), h.make("solo", { frame: saved, delay: 40 })].map((w) => h.snapshot(w));
  const e = new Engine(h, h, {});
  h.engine = e;
  e.start(snaps);
  h.drain();
  assert.equal(e.outstandingCount() > 0, true, "precondition: the tile request is in flight");
  e.restoreFloats([savedFloat("solo", saved)]);
  h.drain();
  assert.equal(e.modeOf("solo"), "tiled", "not restored while its request is outstanding");
  h.advance(100);
  h.drain();
  assert.equal(e.modeOf("solo"), "floating");
  assert.ok(rectNear(h.windows.get("solo")!.frame, saved), JSON.stringify(h.windows.get("solo")!.frame));
  assert.equal(e.counters.restored, 1);
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

// ------------------------------------------- same-window hint (ADR-020 addendum)

/** Snapshots of the live mock windows, in creation order (what a new runtime adopts). */
function live(h: MockHost) {
  return [...h.windows.values()].filter((w) => w.alive).map((w) => h.snapshot(w));
}

test("float hint: the same window, restored before the first solve, floats where it is with no write", () => {
  const h = new MockHost();
  const at = rect(300, 200, 500, 400);
  const snaps = [h.make("a"), h.make("solo", { frame: at })].map((w) => h.snapshot(w));
  const e = new Engine(h, h, {});
  h.engine = e;
  e.restoreFloats([savedFloat("solo", at, "solo")]);
  e.start(snaps);
  h.drain();
  assert.equal(e.modeOf("solo"), "floating");
  assert.ok(rectNear(h.windows.get("solo")!.frame, at), JSON.stringify(h.windows.get("solo")!.frame));
  assert.equal(h.writesTo("solo"), 0, "already there: no write");
  assert.equal(e.counters.restored, 1);
  assert.deepEqual(e.floatPreferences().map((p) => [p.float.rect, p.window]), [[at, "solo"]]);
});

test("float hint: the same window tiled by the first solve before the reply gets one write back to its start frame", () => {
  const h = new MockHost();
  const at = rect(300, 200, 500, 400);
  const snaps = [h.make("a"), h.make("solo", { frame: at })].map((w) => h.snapshot(w));
  const e = new Engine(h, h, {});
  h.engine = e;
  e.start(snaps);
  h.drain();
  assert.equal(e.modeOf("solo"), "tiled", "precondition: tiled with defaults before the saved state arrived");
  assert.ok(!rectNear(h.windows.get("solo")!.frame, at));
  const n0 = h.writes.length;
  e.restoreFloats([savedFloat("solo", at, "solo")]);
  h.drain();
  assert.equal(e.modeOf("solo"), "floating");
  assert.ok(rectNear(h.windows.get("solo")!.frame, at), JSON.stringify(h.windows.get("solo")!.frame));
  const after = h.writes.slice(n0).filter((w) => w.id === "solo");
  assert.equal(after.length, 1, JSON.stringify(after));
  assert.ok(rectNear(after[0].target, at));
});

test("float hint: a float the user moved while Plastile was disabled keeps the moved position after re-enable", () => {
  const h = new MockHost();
  const e1 = h.start();
  h.open("a"); h.open("solo");
  h.drain();
  h.active = "solo";
  e1.execute("plastile.window.toggle-float");
  h.drain();
  const saved = rect(120, 90, 420, 330);
  h.userSetFrame("solo", saved);
  // What the first runtime saves at unload, through the stored text.
  const text = serialize(buildSnapshot(e1.contextPreferences(), e1.floatPreferences(), 1, "t"));
  const s = parse(text);
  assert.ok(s.ok && s.snapshot.floats.length === 1 && s.snapshot.floats[0].windowHint === "solo", text);
  e1.stop();
  // Disabled: the user moves the window; no Plastile sees it.
  const moved = rect(480, 260, 400, 300);
  h.windows.get("solo")!.frame = moved;
  // Re-enabled: a new runtime adopts the live windows and tiles them; the helper's reply arrives later.
  const e2 = new Engine(h, h, {});
  h.engine = e2;
  e2.start(live(h));
  h.drain();
  assert.equal(e2.modeOf("solo"), "tiled", "precondition: tiled before the reply");
  const n0 = h.writes.length;
  const store = new FakeStore();
  store.slots = [text, ""];
  const p = persister(h, e2, store);
  e2.onPersistChange = (scope) => p.markDirty(scope);
  p.load();
  store.answerRead();
  h.drain();
  assert.equal(e2.modeOf("solo"), "floating", "the user's float decision is back");
  assert.ok(rectNear(h.windows.get("solo")!.frame, moved), `where the user moved it, not the saved ${JSON.stringify(saved)}: `
    + JSON.stringify(h.windows.get("solo")!.frame));
  const after = h.writes.slice(n0).filter((w) => w.id === "solo");
  assert.equal(after.length, 1, "one write, from the tile back to the user's position");
  assert.ok(rectNear(after[0].target, moved) && !after.some((w) => rectNear(w.target, saved)), JSON.stringify(after));
  assert.deepEqual(e2.floatPreferences().map((f) => [f.float.rect, f.window]), [[moved, "solo"]], "the preference follows");
  // ... and that is what the next save stores.
  h.t += DEBOUNCE_MS;
  store.fire();
  store.answerWrite();
  const next = parse(store.slots[1]);
  assert.ok(next.ok && rectNear(next.snapshot.floats[0].rect, moved) && next.snapshot.floats[0].windowHint === "solo",
    store.slots[1]);
});

test("float hint: a hint naming no live window falls back to the application identity rule (Q06 unchanged)", () => {
  const saved = rect(300, 200, 500, 400);
  {
    // One live window of the application, a different id (relaunched, or a KWin restart): restored by identity.
    const h = new MockHost();
    const snaps = [h.make("a"), h.make("solo2", { meta: meta("solo"), frame: rect(40, 40, 300, 200) })].map((w) => h.snapshot(w));
    const e = new Engine(h, h, {});
    h.engine = e;
    e.start(snaps);
    h.drain();
    e.restoreFloats([savedFloat("solo", saved, "{gone}")]);
    h.drain();
    assert.equal(e.modeOf("solo2"), "floating");
    assert.ok(rectNear(h.windows.get("solo2")!.frame, saved), "the saved rectangle, not the window's own frame");
    assert.equal(e.counters.restored, 1);
    assert.deepEqual(e.floatPreferences().map((f) => f.window), ["solo2"], "the hint now names the window it applied to");
  }
  {
    // Two live windows of the application, neither the hinted one: ambiguous, both keep ordinary insertion.
    const h = new MockHost();
    const snaps = ["x1", "x2"].map((id) => h.snapshot(h.make(id, { meta: meta("solo") })));
    const e = new Engine(h, h, {});
    h.engine = e;
    e.start(snaps);
    h.drain();
    e.restoreFloats([savedFloat("solo", saved, "{gone}")]);
    h.drain();
    assert.deepEqual([e.modeOf("x1"), e.modeOf("x2")], ["tiled", "tiled"]);
    assert.equal(e.counters.restored, 0);
    assert.ok(e.counters.restoreAmbiguous >= 1);
    assert.equal(e.floatPreferences().length, 1, "the preference waits");
  }
});

test("float hint: with two windows of the application the hinted one is restored, the other keeps ordinary insertion", () => {
  for (const order of [["x1", "x2"], ["x2", "x1"]]) {
    const h = new MockHost();
    const at = rect(500, 300, 400, 300);
    const snaps = order.map((id) => h.snapshot(h.make(id, { meta: meta("solo"), frame: id === "x2" ? at : rect(100, 100, 400, 300) })));
    const e = new Engine(h, h, {});
    h.engine = e;
    e.start(snaps);
    h.drain();
    e.restoreFloats([savedFloat("solo", rect(300, 200, 500, 400), "x2")]);
    h.drain();
    assert.deepEqual([e.modeOf("x1"), e.modeOf("x2")], ["tiled", "floating"], order.join());
    assert.ok(rectNear(h.windows.get("x2")!.frame, at), JSON.stringify(h.windows.get("x2")!.frame));
    assert.equal(e.counters.restored, 1);
    assert.equal(e.counters.restoreAmbiguous, 0, "no ambiguity: the hint says which window it was");
    assertTiling(new Map([["x1", h.windows.get("x1")!.frame]]), rect(0, 0, 1280, 800));
  }
});

test("start-up hold (engine): no solve or write until released; events and commands meanwhile are held work", () => {
  {
    const h = new MockHost();
    const snaps = [h.make("a"), h.make("b")].map((w) => h.snapshot(w));
    const e = new Engine(h, h, {});
    h.engine = e;
    e.start(snaps, true);
    h.drain();
    assert.equal(e.isHolding(), true);
    h.open("c"); // a window opening during the hold
    h.active = "a";
    assert.equal(e.execute("plastile.resize.grow").status, "accepted", "a command runs into the model at once");
    h.drain();
    assert.equal(h.writes.length, 0, "nothing written while held");
    assert.equal(e.counters.solves, 0);
    e.restoreFloats([savedFloat("b", rect(300, 200, 500, 400), "b")]); // the saved state, then the release
    e.releaseHold();
    assert.equal(h.writes.length, 0, "the release itself writes nothing (next flush)");
    h.drain();
    assert.equal(e.counters.solves, 1, "one solve for the held work");
    assert.equal(e.modeOf("b"), "floating");
    assert.equal(h.writesTo("b"), 0, "the restored float was never tiled: no write at all");
    const f = h.framesOf(["a", "c"]);
    assertTiling(new Map(Object.entries(f)), rect(0, 0, 1280, 800));
    assert.ok(f.a.width > f.c.width, "the held ratio step is in the first solve");
    e.releaseHold(); // idempotent
    h.drain();
    assert.equal(e.counters.solves, 1);
  }
  {
    const h = new MockHost();
    const e = new Engine(h, h, {});
    h.engine = e;
    e.start([h.snapshot(h.make("a"))], true);
    e.stop();
    e.releaseHold();
    h.drain();
    assert.equal(h.writes.length, 0, "a release after stop does nothing");
  }
});

// ----------------------------------------------------------------- persister

function model() {
  const h = new MockHost();
  const e = h.start();
  return { h, e };
}

const K1 = { output: "O1", desktop: "D1", activity: "default" };
const K2 = { output: "O1", desktop: "D2", activity: "default" };

function snapText(generation: number, ratio: number, desktop = "D1", floats: Array<ReturnType<typeof savedFloat>> = []): string {
  return serialize(buildSnapshot([{ key: { output: "O1", desktop, activity: "default" },
    prefs: { layout: null, masterStack: { ratio, masterCount: 1 } } }], floats, generation, "t"));
}

function persister(h: MockHost, e: Engine, store: FakeStore, logs: string[] = []) {
  return new Persister(store, e, { now: () => h.t, log: (lv, m) => { logs.push(`${lv} ${m}`); }, stamp: () => "t" });
}

/** Load and deliver the reply. */
function loaded(h: MockHost, e: Engine, store: FakeStore, logs: string[] = []): Persister {
  const p = persister(h, e, store, logs);
  p.load();
  store.answerRead();
  return p;
}

test("T27: load requests the slots and returns at once; the reply applies the newest valid slot", () => {
  const { h, e } = model();
  const store = new FakeStore();
  store.slots = [snapText(4, 0.7), "{\"schemaVersion\":1,\"gen"];
  const logs: string[] = [];
  const p = persister(h, e, store, logs);
  p.load();
  assert.equal(p.state, "loading");
  assert.equal(store.reads.length, 1, "one Read request");
  assert.deepEqual(e.contextPreferences(), [], "nothing applied before the reply");
  store.answerRead();
  assert.equal(p.state, "active");
  assert.deepEqual(logs.filter((l) => l.startsWith("warn")).length, 1, logs.join("\n"));
  assert.match(logs[0], /slot 1: not valid JSON .*using slot 0 \(generation 4\)/);
  assert.equal(e.contextPreferences()[0].prefs.masterStack?.ratio, 0.7);
  // The next save goes to the damaged slot, keeping the valid one.
  e.setContextPreferences(K1, { layout: "bsp", masterStack: null });
  p.markDirty();
  h.t += DEBOUNCE_MS;
  store.fire();
  store.answerWrite();
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
    loaded(h, e, store);
    assert.equal(e.contextPreferences()[0].prefs.masterStack?.ratio, 0.68);
  }
  {
    const { h, e } = model();
    const store = new FakeStore();
    store.slots = ["garbage", fixture("partial.json")];
    const logs: string[] = [];
    const p = loaded(h, e, store, logs);
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
  const p = loaded(h, e, store, logs);
  assert.equal(p.state, "read-only");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /newer Plastile: nothing is saved this session/);
  p.markDirty();
  assert.equal(store.timer, null, "no maintenance deadline");
  p.shutdown();
  assert.deepEqual(store.issued, []);
});

test("T27: a version-3 slot is read-only too; a version-1 slot loads (migrated) and the next save writes version 2", () => {
  {
    const { h, e } = model();
    const store = new FakeStore();
    const v3 = JSON.parse(fixture("v2-from-v1.json")) as RawSnapshot;
    v3.schemaVersion = 3;
    store.slots = [JSON.stringify(v3), ""];
    const logs: string[] = [];
    const p = loaded(h, e, store, logs);
    assert.equal(p.state, "read-only");
    assert.match(logs[0], /schema version 3 is newer than this Plastile's 2.*nothing is saved this session/);
    e.setContextPreferences(K1, { layout: "bsp", masterStack: null });
    p.markDirty();
    p.shutdown();
    assert.deepEqual(store.issued, [], "the newer file is kept intact");
  }
  {
    const { h, e } = model();
    const store = new FakeStore();
    store.slots = [fixture("v1.json").trim(), ""];
    const logs: string[] = [];
    const p = loaded(h, e, store, logs);
    assert.equal(p.state, "active");
    assert.deepEqual(logs.filter((l) => l.startsWith("warn")), [], "no diagnostic for an older version");
    assert.equal(e.contextPreferences().find((c) => c.key.output === "Virtual-0")?.prefs.masterStack?.ratio, 0.65);
    assert.deepEqual(e.floatPreferences().map((f) => [f.app.appId, f.window]), [["plastile-solo", ""]], "no window hint");
    e.setContextPreferences(K1, { layout: "bsp", masterStack: null });
    p.markDirty();
    h.t += DEBOUNCE_MS;
    store.fire();
    store.answerWrite();
    assert.equal(store.writes[0].slot, 1, "into the other slot; the version-1 file stays as it was");
    assert.equal(store.slots[0], fixture("v1.json").trim());
    const s = parse(store.slots[1]);
    assert.ok(s.ok && s.migratedFrom === 2 && s.snapshot.generation === 8, store.slots[1]);
  }
});

test("T27: no helper: one diagnostic, in-memory operation, no timer, no write and no retry", () => {
  const { h, e } = model();
  const store = new FakeStore();
  store.absent = true;
  const logs: string[] = [];
  const p = persister(h, e, store, logs);
  p.load();
  p.markDirty({ context: K1 }); // a change while the request is pending
  store.answerRead();
  assert.equal(p.state, "memory");
  assert.equal(logs.length, 1, logs.join("\n"));
  assert.match(logs[0], /^warn persistence unavailable \(the org\.kde\.plastile\.State helper did not answer/);
  p.markDirty();
  p.shutdown();
  assert.equal(store.schedules, 0);
  assert.deepEqual(store.issued, []);
  assert.equal(store.reads.length, 0, "the Read is not repeated");
});

test("T27: a malformed Read reply counts as no helper", () => {
  for (const reply of [null, ["only one"], 7, "text"]) {
    const { h, e } = model();
    const store = new FakeStore();
    const logs: string[] = [];
    const p = persister(h, e, store, logs);
    p.load();
    store.answerRead(reply);
    assert.equal(p.state, "memory", JSON.stringify(reply));
    assert.equal(logs.length, 1);
  }
  // Array-likes are accepted (QV4 hands D-Bus string lists over as sequences, not Arrays).
  const { h, e } = model();
  const store = new FakeStore();
  const p = persister(h, e, store);
  p.load();
  store.answerRead({ length: 2, 0: snapText(3, 0.6), 1: "" });
  assert.equal(p.state, "active");
  assert.equal(e.contextPreferences()[0].prefs.masterStack?.ratio, 0.6);
});

test("T27: no save is issued before the load reply; changes made meanwhile are saved a quiet period after it", () => {
  const { h, e } = model();
  const store = new FakeStore();
  store.slots = [snapText(2, 0.6, "D2"), ""];
  const p = persister(h, e, store);
  p.load();
  e.setContextPreferences(K1, { layout: "monocle", masterStack: null });
  p.markDirty({ context: K1 });
  h.t += DEBOUNCE_MS * 3;
  assert.equal(store.timer, null, "no deadline while the load is pending");
  assert.equal(store.issued.length, 0);
  p.shutdown(); // (another instance below continues the story)
  assert.equal(store.issued.length, 0, "unload while the load is pending writes nothing: the slots' generations are unknown");
  store.answerRead(); // the reply arrives after unload: nothing happens
  assert.equal(p.state, "loading");
  assert.deepEqual(e.contextPreferences().map((c) => c.key.desktop), ["D1"], "the late reply applied nothing");

  const m = model();
  const q = persister(m.h, m.e, store);
  q.load();
  m.e.setContextPreferences(K1, { layout: "monocle", masterStack: null });
  q.markDirty({ context: K1 });
  m.h.t += 500;
  store.answerRead();
  assert.notEqual(store.timer, null, "armed once the reply arrived");
  assert.equal(store.timer!.ms, DEBOUNCE_MS - 500, "a quiet period after the last change");
  m.h.t += DEBOUNCE_MS;
  store.fire();
  assert.equal(store.issued.length, 1);
  assert.equal(store.issued[0].slot, 1, "the slot after the newest one");
  const s = parse(store.issued[0].text);
  assert.ok(s.ok && s.snapshot.generation === 3);
  assert.deepEqual(s.ok && s.snapshot.contexts.map((c) => [c.desktopId, c.layout, c.masterStack?.ratio ?? null]).sort(),
    [["D1", "monocle", null], ["D2", null, 0.6]], "the user's change and the loaded preference");
});

test("T27: a user change made before the load reply wins over the saved state (contexts and floats)", () => {
  const h = new MockHost();
  const e = h.start();
  h.open("a"); h.open("b"); h.open("solo"); h.open("kate");
  h.drain();
  const store = new FakeStore();
  store.slots = [serialize(buildSnapshot([
    { key: K1, prefs: { layout: "bsp", masterStack: null } },
    { key: K2, prefs: { layout: "monocle", masterStack: null } },
  ], [savedFloat("solo"), savedFloat("kate", rect(50, 60, 300, 200))], 5, "t")), ""];
  let scopes = 0;
  const p = persister(h, e, store);
  e.onPersistChange = (scope) => { scopes++; p.markDirty(scope); };
  p.load();
  // Before the reply: the user picks a layout here and tiles "kate" after floating it.
  h.active = "a";
  assert.equal(e.execute("plastile.layout.master-stack").status, "noop", "already master-stack: not a change");
  assert.equal(e.execute("plastile.resize.grow").status, "accepted");
  h.active = "kate";
  e.execute("plastile.window.toggle-float");
  h.drain();
  e.execute("plastile.window.toggle-float");
  h.drain();
  assert.ok(scopes >= 3, `the engine reported the decisions (${scopes})`);
  const ratio = e.contextPreferences().find((c) => c.key.desktop === "D1")!.prefs.masterStack!.ratio;
  store.answerRead();
  const prefs = new Map(e.contextPreferences().map((c) => [c.key.desktop, c.prefs]));
  assert.equal(prefs.get("D1")?.layout ?? null, null, "the user's context keeps the user's values, not the saved bsp");
  assert.equal(prefs.get("D1")?.masterStack?.ratio, ratio);
  assert.equal(prefs.get("D2")?.layout, "monocle", "an untouched context gets its saved preference");
  h.drain(); // the flush that follows the reply (the callback itself solves nothing)
  assert.equal(e.modeOf("solo"), "floating", "a saved float restores to its one live window");
  assert.ok(rectNear(h.windows.get("solo")!.frame, rect(300, 200, 500, 400)));
  assert.equal(e.modeOf("kate"), "tiled", "the user tiled kate before the reply: its saved float does not apply");
  assert.ok(!e.floatPreferences().some((f) => f.app.appId === "kate"), "and it is not saved again");
});

test("T27: the load reply only marks contexts dirty; they re-solve in the engine's next flush", () => {
  const h = new MockHost();
  const e = h.start();
  h.open("a"); h.open("b");
  h.drain();
  const w0 = h.windows.get("a")!.frame.width;
  const store = new FakeStore();
  store.slots = [snapText(1, 0.7), ""];
  const p = persister(h, e, store);
  p.load();
  store.answerRead();
  assert.equal(h.windows.get("a")!.frame.width, w0, "no geometry written inside the reply callback");
  h.drain();
  assert.ok(h.windows.get("a")!.frame.width > w0, "the flush applies the saved ratio");
  assert.equal(p.summary().dirty, false, "applying the saved state is not a change to save");
});

test("T27: saves are debounced maintenance work: one per quiet period, re-armed, never periodic, skipped when unchanged", () => {
  const { h, e } = model();
  const store = new FakeStore();
  const p = loaded(h, e, store);
  e.setContextPreferences(K1, { layout: "bsp", masterStack: null });
  for (let i = 0; i < 20; ++i) p.markDirty({ context: K1 });
  assert.equal(store.schedules, 1, "one deadline for a burst of changes");
  assert.equal(store.timer?.ms, DEBOUNCE_MS);
  h.t += 1500;
  p.markDirty(); // a later change pushes the save out
  h.t += 500;
  store.fire();
  assert.equal(store.issued.length, 0, "not yet: 2 s after the last change");
  assert.equal(store.timer?.ms, 1500, "re-armed for the remainder");
  h.t += 1500;
  store.fire();
  assert.equal(store.issued.length, 1, "one save for the burst");
  assert.equal(store.timer, null, "nothing armed once issued (no periodic timer)");
  store.answerWrite();
  assert.equal(store.timer, null);
  // Unchanged content: no write.
  p.markDirty();
  h.t += DEBOUNCE_MS;
  store.fire();
  assert.equal(store.issued.length, 1);
  assert.equal(p.skipped, 1);
  // A change then a clean unload: one write at unload, the deadline cancelled.
  e.setContextPreferences(K1, { layout: "monocle", masterStack: null });
  p.markDirty();
  assert.notEqual(store.timer, null);
  p.shutdown();
  assert.equal(store.timer, null);
  assert.equal(store.issued.length, 2);
  assert.deepEqual(store.issued.map((w) => w.slot), [0, 1], "slots alternate");
  p.markDirty();
  assert.equal(store.timer, null, "nothing after shutdown");
  store.answerWrite();
  assert.equal(p.summary().writes, 1, "a reply after unload changes nothing");
});

test("T27: one write in flight: changes during it are saved after its reply, into the other slot with the next generation", () => {
  const { h, e } = model();
  const store = new FakeStore();
  const p = loaded(h, e, store);
  e.setContextPreferences(K1, { layout: "bsp", masterStack: null });
  p.markDirty();
  h.t += DEBOUNCE_MS;
  store.fire();
  assert.equal(store.pending.length, 1);
  // The helper is slow (or stopped): more changes arrive and their quiet period passes.
  e.setContextPreferences(K1, { layout: "monocle", masterStack: null });
  p.markDirty();
  assert.equal(store.timer, null, "no deadline while a write is in flight");
  h.t += DEBOUNCE_MS * 5;
  assert.equal(store.issued.length, 1, "no second request while the first is unanswered");
  store.answerWrite();
  assert.equal(store.issued.length, 1);
  assert.notEqual(store.timer, null, "armed by the reply");
  store.fire();
  assert.equal(store.issued.length, 2, "the quiet period had passed: issued at the deadline");
  store.answerWrite();
  assert.deepEqual(store.writes.map((w) => [w.slot, (parse(w.text) as { snapshot: { generation: number } }).snapshot.generation]),
    [[0, 1], [1, 2]]);
});

test("T27: unload with a write in flight sends the final write after it, into the other slot", () => {
  const { h, e } = model();
  const store = new FakeStore();
  const p = loaded(h, e, store);
  e.setContextPreferences(K1, { layout: "bsp", masterStack: null });
  p.markDirty();
  h.t += DEBOUNCE_MS;
  store.fire();
  e.setContextPreferences(K1, { layout: "monocle", masterStack: null });
  p.markDirty();
  p.shutdown();
  assert.deepEqual(store.issued.map((w) => w.slot), [0, 1], "the final write follows the one in flight");
  store.answerAll(); // the helper answers both in arrival order after the script is gone
  const gens = store.writes.map((w) => (parse(w.text) as { snapshot: { generation: number } }).snapshot.generation);
  assert.deepEqual(gens, [1, 2], "the final state has the newest generation");
  const best = [0, 1].map((s) => parse(store.slots[s])).filter((x) => x.ok)
    .sort((a, b) => (b as { snapshot: Snapshot }).snapshot.generation - (a as { snapshot: Snapshot }).snapshot.generation)[0];
  assert.ok(best.ok && best.snapshot.contexts[0].layout === "monocle", "a later load reads the last change");
});

test("T27: a failed write costs one diagnostic, is not retried by itself, and is saved with the next change", () => {
  const { h, e } = model();
  const store = new FakeStore();
  const logs: string[] = [];
  const p = loaded(h, e, store, logs);
  logs.length = 0;
  e.setContextPreferences(K1, { layout: "bsp", masterStack: null });
  p.markDirty();
  h.t += DEBOUNCE_MS;
  store.fire();
  store.answerWrite(false);
  assert.equal(logs.filter((l) => l.startsWith("warn")).length, 1, logs.join("\n"));
  assert.equal(store.timer, null, "no retry timer");
  h.t += DEBOUNCE_MS * 10;
  assert.equal(store.issued.length, 1, "no retry");
  // The next change saves everything, including what failed.
  e.setContextPreferences(K2, { layout: "monocle", masterStack: null });
  p.markDirty();
  h.t += DEBOUNCE_MS;
  store.fire();
  assert.equal(store.issued.length, 2);
  assert.equal(store.issued[1].slot, 0, "the failed slot is written again: nothing was committed");
  store.answerWrite(false);
  assert.equal(logs.filter((l) => l.startsWith("warn")).length, 1, "a run of failures logs once");
  p.markDirty();
  h.t += DEBOUNCE_MS;
  store.fire();
  store.answerWrite(true);
  const s = parse(store.slots[0]);
  assert.ok(s.ok && s.snapshot.contexts.length === 2 && s.snapshot.generation === 1);
  assert.deepEqual(p.summary().failed, 2);
});

test("T27: a write failing while changes came in during it is followed by one save of them", () => {
  const { h, e } = model();
  const store = new FakeStore();
  const p = loaded(h, e, store);
  e.setContextPreferences(K1, { layout: "bsp", masterStack: null });
  p.markDirty();
  h.t += DEBOUNCE_MS;
  store.fire();
  p.markDirty(); // during the write
  store.answerWrite(false);
  assert.notEqual(store.timer, null, "the newer change gets its save");
  h.t += DEBOUNCE_MS;
  store.fire();
  assert.equal(store.issued.length, 2);
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
  const f = fakeEnv(ws, qt, { diagnostics: "info" });
  f.env.state = store;
  const rt = createRuntime(f.env);
  qt.drain();
  return { ws, qt, wins, f, rt };
}

test("T27: commands mark state dirty without store calls; the deadline issues one write; a reload's first solve waits for the reply", () => {
  const store = new FakeStore();
  const a = runtimeWith(store);
  store.answerRead();
  a.qt.drain();
  const w0 = a.wins[0].frameGeometry.width;
  a.ws.activeWindow = a.wins[0];
  let callsDuringCommand = 0;
  const realRead = store.read.bind(store), realWrite = store.write.bind(store);
  let inCommand = false;
  store.read = (d, f) => { if (inCommand) callsDuringCommand++; realRead(d, f); };
  store.write = (s, t, d) => { if (inCommand) callsDuringCommand++; realWrite(s, t, d); };
  inCommand = true;
  a.rt.dispatch("plastile.resize.grow");
  a.rt.dispatch("plastile.resize.grow");
  inCommand = false;
  a.qt.drain();
  assert.equal(callsDuringCommand, 0, "no store request inside command handling");
  assert.notEqual(store.timer, null, "a maintenance deadline is armed");
  const grown = a.wins[0].frameGeometry.width;
  assert.ok(grown > w0);
  // Fire the deadline after the quiet period (the runtime's clock is Date.now()).
  const realNow = Date.now;
  Date.now = () => realNow() + DEBOUNCE_MS + 10;
  try { store.fire(); } finally { Date.now = realNow; }
  assert.equal(store.issued.length, 1);
  store.answerWrite();
  a.rt.shutdown();
  assert.equal(store.issued.length, 1, "nothing new to save at unload");
  // A new runtime (reload): the first solve waits for the reply (bounded), which it then solves with.
  const b = runtimeWith(store);
  assert.equal(b.wins[0].frameGeometry.width, 400, "held: nothing is written before the saved state arrives");
  assert.equal(store.timer?.ms, LOAD_HOLD_MS, "the hold is bounded by the one-shot maintenance timer");
  store.answerRead();
  assert.equal(b.wins[0].frameGeometry.width, 400, "nothing is solved inside the reply callback");
  assert.equal(store.timer, null, "the reply ends the hold early: its deadline is cancelled");
  b.qt.drain();
  assert.equal(b.wins[0].frameGeometry.width, grown, "the first solve already has the saved ratio");
  assert.equal(b.f.lines.filter((l) => /start-up hold released .*"by":"reply"/.test(l)).length, 1, b.f.lines.join("\n"));
  b.rt.shutdown();
});

test("start-up hold: the deadline releases the first solve with defaults; a late reply then applies once", () => {
  const store = new FakeStore();
  {
    // A first runtime saves a grown ratio.
    const s0 = runtimeWith(store);
    store.answerRead();
    s0.qt.drain();
    s0.ws.activeWindow = s0.wins[0];
    s0.rt.dispatch("plastile.resize.grow");
    s0.rt.dispatch("plastile.resize.grow");
    s0.rt.shutdown(); // the final write at unload
    store.answerWrite();
    assert.ok(store.slots.some((t) => t !== ""), "precondition: saved");
  }
  const a = runtimeWith(store);
  assert.ok(a.wins.every((w) => w.frameGeometry.width === 400), "held");
  store.fire(); // LOAD_HOLD_MS passed without a reply
  a.qt.drain();
  assertTiling(new Map(a.wins.map((w) => [w.caption, w.frameGeometry])), rect(0, 0, 1280, 800));
  const w0 = a.wins[0].frameGeometry.width;
  assert.equal(a.f.lines.filter((l) => /start-up hold released .*"by":"deadline"/.test(l)).length, 1, a.f.lines.join("\n"));
  store.answerRead(); // the slow helper answers after all
  a.qt.drain();
  assert.ok(a.wins[0].frameGeometry.width > w0, "the saved ratio applies once it arrives, as a re-solve");
  assert.equal(a.f.lines.filter((l) => /start-up hold released/.test(l)).length, 1, "released once");
  a.rt.shutdown();
});

test("start-up hold: commands during the hold update the model and are solved at its end; focus is not held", () => {
  const store = new FakeStore();
  const a = runtimeWith(store);
  a.ws.activeWindow = a.wins[0];
  assert.equal(a.rt.dispatch("plastile.resize.grow")?.status, "accepted", "dispatched at once, into the model");
  a.qt.drain();
  assert.ok(a.wins.every((w) => w.frameGeometry.width === 400), "its geometry is held");
  a.rt.dispatch("plastile.focus.next");
  assert.equal(a.ws.activeWindow, a.wins[1], "activation is not geometry: immediate");
  store.answerRead(); // no saved state
  a.qt.drain();
  const ws = a.wins.map((w) => w.frameGeometry.width);
  assert.ok(ws[0] > ws[1], `the first solve includes the held ratio step (${ws})`);
  a.rt.shutdown();
});

test("start-up hold: unload during the hold cancels its deadline and releases nothing; no store means no hold", () => {
  {
    const store = new FakeStore();
    const a = runtimeWith(store);
    assert.notEqual(store.timer, null);
    a.rt.shutdown();
    assert.equal(store.timer, null, "the hold's deadline is cancelled at unload");
    assert.ok(a.wins.every((w) => w.frameGeometry.width === 400), "nothing written");
    store.answerRead(); // a reply after unload is ignored
    a.qt.drain();
    assert.ok(a.wins.every((w) => w.frameGeometry.width === 400));
    assert.equal(a.f.lines.filter((l) => /start-up hold released/.test(l)).length, 0, a.f.lines.join("\n"));
  }
  {
    const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1")]);
    const qt = new FakeQt();
    const w = ws.window({ caption: "w1", resourceClass: "app1", resourceName: "app1", frameGeometry: { x: 20, y: 20, width: 400, height: 300 } });
    ws.windows.push(w);
    const f = fakeEnv(ws, qt); // no state store
    const rt = createRuntime(f.env);
    qt.drain();
    assert.equal(w.frameGeometry.height, 784, "tiled at once: nothing to wait for");
    rt.shutdown();
  }
  {
    // The helper is absent: the failed Read ends the hold at once.
    const store = new FakeStore();
    store.absent = true;
    const a = runtimeWith(store);
    store.answerRead();
    a.qt.drain();
    assert.ok(a.wins.every((w) => w.frameGeometry.height === 784), "tiled");
    assert.equal(a.f.lines.filter((l) => /start-up hold released .*"by":"failed"/.test(l)).length, 1, a.f.lines.join("\n"));
    a.rt.shutdown();
  }
});

test("T27: without the helper the runtime tiles and reports once", () => {
  const store = new FakeStore();
  store.absent = true;
  const a = runtimeWith(store);
  store.answerRead();
  a.qt.drain();
  assert.equal(a.f.lines.filter((l) => /persistence unavailable/.test(l)).length, 1, a.f.lines.join("\n"));
  assertTiling(new Map(a.wins.map((w) => [w.caption, w.frameGeometry])), rect(0, 0, 1280, 800));
  assert.ok(a.wins.every((w) => w.frameGeometry.height === 784), "both tiled side by side");
  a.ws.activeWindow = a.wins[0];
  assert.equal(a.rt.dispatch("plastile.resize.grow")?.status, "accepted");
  a.rt.shutdown();
  assert.deepEqual(store.issued, []);
});
