// Replay of recorded event streams (T10, T14). Each fixture in tests/fixtures/replay/ was
// recorded from a real nested KWin session, never written by hand:
//
//   npm run build && make -C fixtures/client
//   python3 tests/integration/scenarios_replay.py [--only NAME[,NAME]] [--out DIR]
//
// which loads the production bundle through the recording root tools/replay/record.qml into a
// disposable nested KWin (tools/nested.py), drives one lifecycle shape with fixture clients and
// unloads; the runtime prints the recording at unload (src/runtime/replay.ts). The fixture keeps
// how, where and with which KWin it was captured ("captured"), the recorded stream ("events"),
// the frame writes in it, what the engine inside KWin ended with ("expect": its model before
// stop, counters and trace after stop) and KWin's own final frames ("oracle", read by a one-shot
// script independent of Plastile). Titles are redacted and ids normalized by the recorder.
//
// The player (replayHost.ts) is a mock host that answers from the recording and fails at the
// first host operation that differs. The nested scenario `replay-capture-T10` re-captures every
// shape and runs this file on the fresh recordings (PLASTILE_REPLAY_DIR). A recorded fixture goes
// stale when the engine's behaviour changes on purpose: re-capture it with the command above.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rect } from "../../src/core/geometry.ts";
import { ReplayRecorder, replayJson, type InputNode } from "../../src/runtime/replay.ts";
import type { Engine } from "../../src/core/engine.ts";
import type { HostPort } from "../../src/core/ports.ts";
import { createRuntime } from "../../src/runtime/main.ts";
import { Divergence, loadReplay, parseReplay, ReplayHost, type ReplayFixture } from "./replayHost.ts";
import { desktop, fakeEnv, FakeQt, FakeWorkspace, output } from "./fakeKwin.ts";

const DIR = process.env.PLASTILE_REPLAY_DIR ?? fileURLToPath(new URL("../fixtures/replay/", import.meta.url));
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
/** The shapes the capture script records; each must be present in the committed directory. */
const SHAPES = ["open-close-burst", "output-unplug-replug", "quick-tile-yield", "ratio-reversal", "remove-during-apply"];

/** Compared as recorded (counters and trace pass through JSON in the recording). */
function plain(v: unknown): unknown { return JSON.parse(replayJson(v)); }

/**
 * The engine's model restricted to the fields the recording has: diagnostic fields added to
 * explain and the context summary after a capture (`suspended`, `paused`, `tiled`) have no
 * recorded truth. A recorded field the engine no longer has still fails.
 */
function recordedFields(actual: unknown, recorded: unknown): unknown {
  if (Array.isArray(actual) && Array.isArray(recorded)) return actual.map((v, i) => recordedFields(v, recorded[i]));
  if (actual && recorded && typeof actual === "object" && typeof recorded === "object" && !Array.isArray(actual)) {
    const out: Record<string, unknown> = {};
    const a = actual as Record<string, unknown>, r = recorded as Record<string, unknown>;
    for (const k of Object.keys(a)) if (k in r) out[k] = recordedFields(a[k], r[k]);
    return out;
  }
  return actual;
}

function within(r: Rect, o: Rect, tol = 0.5): boolean {
  return r.x >= o.x - tol && r.y >= o.y - tol && r.x + r.width <= o.x + o.width + tol && r.y + r.height <= o.y + o.height + tol;
}

function near(a: Rect, b: Rect, tol = 0.5): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}

/** Top-level inputs with their index. */
function inputs(f: ReplayFixture, k?: string, arg0?: unknown): Array<{ n: InputNode; i: number }> {
  return f.events.map((n, i) => ({ n, i })).filter((x) => (k === undefined || x.n.k === k) && (arg0 === undefined || x.n.a[0] === arg0));
}

/** Writes issued while handling top-level inputs [from, to). */
function writesBetween(h: ReplayHost, from: number, to = Infinity) {
  return h.writes.filter((w) => { const i = Number(w.path.slice(1).split(".")[0]); return i >= from && i < to; });
}

test("T10: the committed directory holds every recorded shape, each captured in nested KWin with its version", () => {
  if (process.env.PLASTILE_REPLAY_DIR) return; // fresh captures are checked by the scenario
  assert.deepEqual(FILES.map((f) => f.replace(/\.json$/, "")), SHAPES);
  for (const file of FILES) {
    const f = loadReplay(join(DIR, file));
    const c = f.captured ?? {};
    assert.match(String(c.kwin), /^\d+\.\d+\.\d+/, `${file}: KWin version`);
    assert.match(String(c.layer), /nested KWin/, `${file}: layer`);
    assert.match(String(c.how), /scenarios_replay\.py --only /, `${file}: how it was captured`);
    assert.equal(f.titles, "redacted", `${file}: titles redacted by default`);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(JSON.stringify(f)), `${file}: no KWin uuid survives normalization`);
  }
});

for (const file of FILES) {
  const path = join(DIR, file);

  test(`T10 replay ${file}: the engine reproduces the recorded writes, model, counters and trace`, () => {
    const f = loadReplay(path);
    assert.equal(f.truncated, false, "complete recording");
    assert.equal(f.anomalies, 0, "every input was recordable");
    const h = new ReplayHost(f).run(); // throws Divergence at the first differing host operation
    assert.deepEqual(h.violations, [], "model invariants after every input");
    assert.deepEqual(h.writes.map((w) => ({ id: w.id, gen: w.gen, target: w.target })), f.writes, "plan/writes");
    assert.ok(f.expect.model !== null);
    assert.deepEqual(recordedFields(h.model, f.expect.model), f.expect.model, "final model equals the one the engine in KWin had");
    assert.deepEqual(plain(h.engine.counters), plain(f.expect.counters), "counters equal KWin's");
    assert.deepEqual(plain(h.engine.trace.snapshot()), plain(f.expect.trace), "trace equals KWin's");
  });

  test(`T10 replay ${file}: lifecycle invariants over the recorded stream`, () => {
    const f = loadReplay(path);
    const h = new ReplayHost(f).run();
    // A removed window receives nothing after its removal (tombstone; C02, C07).
    const removedAt = new Map(inputs(f, "windowRemoved").map((x) => [x.n.a[0] as string, x.i]));
    for (const w of h.writes) {
      const at = removedAt.get(w.id);
      assert.ok(at === undefined || Number(w.path.slice(1).split(".")[0]) < at, `write to ${w.id} after its removal (${w.path})`);
    }
    assert.deepEqual(h.afterRemoval, [], "no write after a removal delivered inside a host call either");
    // Every write is a positive finite rectangle inside an output that existed when it was issued.
    for (const w of h.writes) {
      const t = w.target;
      assert.ok([t.x, t.y, t.width, t.height].every(Number.isFinite) && t.width >= 1 && t.height >= 1, `${w.path}: ${JSON.stringify(t)}`);
      assert.ok(w.outputs.some((o) => within(t, o.geometry)), `${w.path}: ${JSON.stringify(t)} outside every output then`);
    }
    // The stream is complete: the last frame each window reported is KWin's own final frame (oracle).
    for (const [id, o] of Object.entries(f.oracle ?? {})) {
      const last = h.frames.get(id);
      assert.ok(last && near(last, o.frame), `${id} (fixture ${o.fixture}): last observed ${JSON.stringify(last)}, KWin ${JSON.stringify(o.frame)}`);
    }
  });

  test(`T10 replay ${file}: two replays are identical (determinism)`, () => {
    const a = new ReplayHost(loadReplay(path)).run(), b = new ReplayHost(loadReplay(path)).run();
    assert.deepEqual(a.writes, b.writes);
    assert.equal(replayJson(a.engine.trace.snapshot()), replayJson(b.engine.trace.snapshot()));
    assert.deepEqual(a.engine.counters, b.engine.counters);
    assert.deepEqual(a.model, b.model);
  });
}

// ------------------------------------------------------------------ per shape
// Semantic checks on what each recorded shape must show. They read the replayed engine and the
// recorded stream; the geometry they compare is what KWin reported (frameObserved), not the plan.

/** After each top-level input: the frames KWin had reported, and the engine's solve count. */
interface After { frames: Map<string, Rect>; solves: number }

function shape(name: string, fn: (f: ReplayFixture, h: ReplayHost, at: Map<number, Map<string, Rect>>, after: After[]) => void): void {
  const file = FILES.find((x) => x === `${name}.json`);
  test(`T10 shape ${name}`, { skip: file ? false : "not in this directory" }, () => {
    const f = loadReplay(join(DIR, file!));
    const after: After[] = [];
    const h = new ReplayHost(f, { after: (_n, _i, host) => { after.push({ frames: new Map(host.frames), solves: host.engine.counters.solves }); } }).run();
    fn(f, h, new Map(after.map((x, i) => [i, x.frames])), after);
  });
}

shape("open-close-burst", (f, h, _at, after) => {
  const added = inputs(f, "windowAdded"), removed = inputs(f, "windowRemoved");
  assert.equal(added.length, 6, "six windows mapped during the burst");
  assert.equal(removed.length, 6, "and six closed");
  assert.equal(inputs(f, "start")[0].n.a.length, 1);
  assert.equal((inputs(f, "start")[0].n.a[0] as unknown[]).length, 3, "three adopted at start");
  // Coalescing: the six additions and the six removals each needed at most one solve per window (C09 bound).
  const solves = (from: number, to: number) => after[to - 1].solves - after[from - 1].solves;
  assert.ok(solves(added[0].i, removed[0].i) <= 6, `burst add solves ${solves(added[0].i, removed[0].i)}`);
  assert.ok(solves(removed[0].i, f.events.length - 1) <= 6, `burst remove solves ${solves(removed[0].i, f.events.length - 1)}`);
  const model = h.model as { contexts: Array<{ order: string[] }> };
  assert.equal(model.contexts.reduce((n, c) => n + c.order.length, 0), 3, "three tiled windows at the end");
});

shape("remove-during-apply", (f, h, at) => {
  const rm = inputs(f, "windowRemoved");
  assert.equal(rm.length, 1);
  const gone = rm[0].n.a[0] as string;
  const grow = inputs(f, "command", "plastile.resize.grow")[0];
  const toGone = writesBetween(h, grow.i).filter((w) => w.id === gone);
  assert.ok(toGone.length >= 1, "the grow requested a new frame for the window that then closed");
  const lastFrame = at.get(rm[0].i - 1)!.get(gone)!;
  assert.ok(!near(lastFrame, toGone[toGone.length - 1].target), "it closed before committing that request (removal while outstanding)");
  assert.ok(writesBetween(h, rm[0].i).some((w) => w.id !== gone), "peers re-solved and written after the removal");
  // Peers still applied: each remaining window ends at its planned tile, as KWin reported it.
  const model = h.model as { windows: Record<string, { slot: Rect | null; mode: string }> };
  assert.deepEqual(Object.keys(model.windows).sort(), [...h.frames.keys()].filter((id) => id !== gone).sort(), "the closed window has no record");
  for (const [id, w] of Object.entries(model.windows)) {
    assert.equal(w.mode, "tiled");
    assert.ok(w.slot && near(h.frames.get(id)!, w.slot), `${id} at its tile: ${JSON.stringify(h.frames.get(id))} vs ${JSON.stringify(w.slot)}`);
  }
});

shape("ratio-reversal", (f, h, at) => {
  const grows = inputs(f, "command", "plastile.resize.grow"), shrinks = inputs(f, "command", "plastile.resize.shrink");
  assert.equal(grows.length, 2);
  assert.equal(shrinks.length, 2);
  const last = f.events.length - 2; // before stop
  for (let k = 0; k < 2; ++k) {
    const before: Map<string, Rect> = at.get(grows[k].i - 1)!;
    const end: Map<string, Rect> = at.get(k + 1 < grows.length ? grows[k + 1].i - 1 : last)!;
    for (const [id, r] of before) assert.ok(near(end.get(id)!, r), `reversal ${k + 1}: ${id} back at A`);
    // B was requested while the client still showed A (a 300 ms client), and A requested again (not skipped).
    const ws = writesBetween(h, grows[k].i, shrinks[k].i + 1);
    assert.ok(ws.some((w) => !near(w.target, before.get(w.id)!)), `reversal ${k + 1}: B requested`);
    const back = writesBetween(h, shrinks[k].i, shrinks[k].i + 1);
    assert.ok(back.length >= 1 && back.every((w) => near(w.target, before.get(w.id)!)), `reversal ${k + 1}: A requested again`);
    // A late commit of B never becomes the target: every later write (corrections of stale commits included) is A.
    const later = writesBetween(h, shrinks[k].i, k + 1 < grows.length ? grows[k + 1].i : Infinity);
    assert.ok(later.every((w) => near(w.target, before.get(w.id)!)), `reversal ${k + 1}: only A written after the shrink`);
  }
  // The shape is the delayed one: A was requested again before any client committed B, and B
  // commits arrived after it (stale). A capture whose clients answered before the shrink fails here.
  for (let k = 0; k < 2; ++k) {
    const before: Map<string, Rect> = at.get(grows[k].i - 1)!;
    const atShrink: Map<string, Rect> = at.get(shrinks[k].i - 1)!;
    for (const [id, r] of before) assert.ok(near(atShrink.get(id)!, r), `reversal ${k + 1}: ${id} had not committed B when A was requested again`);
    const b = writesBetween(h, grows[k].i, grows[k].i + 1);
    const lateB: InputNode[] = f.events.slice(shrinks[k].i + 1, k + 1 < grows.length ? grows[k + 1].i : f.events.length)
      .filter((n) => n.k === "frameObserved" && b.some((w) => w.id === n.a[0] && near(w.target, n.a[2] as Rect)));
    assert.ok(lateB.length >= 1, `reversal ${k + 1}: a client committed B after the shrink (a late commit)`);
  }
  // Bounded: at most one correction per window per reversal, each for a stale commit (E04).
  const c = h.engine.counters;
  assert.ok(c.corrections <= 3 * grows.length && c.corrections <= c.stale, JSON.stringify({ corrections: c.corrections, stale: c.stale }));
  assert.equal(c.diverged, 0);
});

shape("output-unplug-replug", (f, h, at) => {
  const counts = f.events.map((n) => (n.q || []).filter((q) => q[0] === "outputs").map((q) => (q[2] as unknown[]).length)).flat();
  const one = counts.indexOf(1);
  assert.ok(counts[0] === 2 && one > 0 && counts.lastIndexOf(2) > one, `outputs 2 -> 1 -> 2 (${counts.join(",")})`);
  assert.ok(inputs(f, "topologyChanged").length >= 2, "topology changes delivered");
  // The grow left a request outstanding when the output went away: a window it wrote never
  // reported that frame between the grow and the first input that saw one output.
  const grow = inputs(f, "command", "plastile.resize.grow")[0];
  const gone = f.events.findIndex((n) => (n.q || []).some((q) => q[0] === "outputs" && (q[2] as unknown[]).length === 1));
  assert.ok(grow && gone > grow.i, "the grow precedes the unplug");
  const committed = (id: string, r: Rect) => { for (let j = grow.i; j < gone; ++j) if (near(at.get(j)!.get(id)!, r)) return true; return false; };
  assert.ok(writesBetween(h, grow.i, grow.i + 1).some((w) => !committed(w.id, w.target)), "a grow request was still outstanding at the unplug");
  const model = h.model as { windows: Record<string, { mode: string; context: { output: string } }> };
  const modes = Object.values(model.windows).map((w) => w.mode);
  assert.deepEqual(modes, ["tiled", "tiled", "tiled", "tiled"], "all four tiled again at the end");
});

shape("quick-tile-yield", (f, h) => {
  const tile = inputs(f, "nativeTileChanged").filter((x) => x.n.a[2] === true);
  assert.equal(tile.length, 1, "KWin attached one native tile");
  const id = tile[0].n.a[0] as string;
  const adopt = inputs(f, "command", "plastile.window.adopt-native")[0];
  assert.ok(adopt.i > tile[0].i);
  assert.deepEqual(writesBetween(h, tile[0].i, adopt.i).filter((w) => w.id === id), [], "yielded: no write while KWin's tile holds it");
  assert.ok(writesBetween(h, tile[0].i, adopt.i).length >= 1, "its peers retiled without it");
  const release = f.events[adopt.i].c!.find((c) => c.h === "releaseNativeTile");
  assert.ok(release && release.a[0] === id, "adopt-native released KWin's tile");
  assert.ok(writesBetween(h, adopt.i).some((w) => w.id === id), "and tiled it again");
  assert.equal(h.engine.modeOf(id), null, "stopped at the end");
  assert.equal((h.model as { windows: Record<string, { mode: string }> }).windows[id].mode, "tiled");
});

// --------------------------------------------------------- recorder round trip
test("T10: a recording made through the runtime (fake KWin) replays to the same writes, including a removal inside a geometry callback", () => {
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 }), output("O2", { x: 1280, y: 0, width: 1280, height: 800 })],
    [desktop("D1"), desktop("D2", 2)]);
  const qt = new FakeQt();
  const a = ws.window({ caption: "SECRET a", resourceClass: "a" }), b = ws.window({ caption: "SECRET b", resourceClass: "b" });
  ws.windows.push(a, b);
  const f = fakeEnv(ws, qt);
  f.env.record = {};
  const rt = createRuntime(f.env);
  qt.drain();
  const c = ws.window({ caption: "SECRET c", resourceClass: "c" });
  // KWin may emit windowRemoved for another window while a geometry handler runs: the fake removes
  // b inside c's first frameGeometryChanged, which fires inside Plastile's frame write to c.
  let once = true;
  c.frameGeometryChanged.connect(() => { if (once) { once = false; ws.remove(b); } });
  ws.add(c);
  qt.drain();
  ws.activeWindow = c;
  ws.windowActivated.emit(c);
  rt.dispatch("plastile.resize.grow");
  qt.drain();
  rt.dispatch("plastile.move.output-next");
  qt.drain();
  rt.shutdown();
  const line = f.lines.find((l) => l.startsWith("plastile replay "));
  assert.ok(line, "the recording is printed at unload");
  const rec = parseReplay(line!.slice("plastile replay ".length));
  assert.equal(rec.anomalies, 0);
  assert.ok(!line!.includes("SECRET"), "titles redacted");
  assert.ok(!/"\{\d+\}"/.test(JSON.stringify(rec.events)) && JSON.stringify(rec.events).includes('"w3"'), "window ids normalized");
  // The removal arrived nested inside the frame write to c.
  const nested = rec.events.flatMap((n) => (n.c || []).flatMap((x) => (x.n || []).map((y) => ({ call: x.h, k: y.k }))));
  assert.ok(nested.some((x) => x.call === "applyFrame" && x.k === "windowRemoved"), JSON.stringify(nested));
  const h = new ReplayHost(rec).run();
  assert.deepEqual(h.violations, []);
  assert.deepEqual(h.afterRemoval, [], "b is never written after its removal inside c's frame write");
  assert.equal(h.writes.length, ws.writes.length, "one replayed write per script write");
  assert.deepEqual(h.writes.map((w) => w.target), ws.writes.map((w) => w.rect));
  assert.deepEqual(h.model, rec.expect.model);
  assert.deepEqual(plain(h.engine.counters), plain(rec.expect.counters));
  assert.deepEqual(plain(h.engine.trace.snapshot()), plain(rec.expect.trace));
});

test("T10: the player stops at the first host operation the engine does differently", () => {
  const file = FILES.find((x) => x.startsWith("quick-tile"));
  if (!file) return; // a partial PLASTILE_REPLAY_DIR
  const f = loadReplay(join(DIR, file));
  const first = f.events[0].c!.find((c) => c.h === "applyFrame")!;
  (first.a[2] as { width: number }).width += 10; // as if the engine in KWin had planned another rectangle
  assert.throws(() => new ReplayHost(f).run(), Divergence);
});

test("T10: a host operation outside any recorded input is an anomaly, not silently dropped", () => {
  let now = 5;
  const svc = { now: () => now, callLater: () => {}, deadline: () => () => {}, log: () => {} };
  const rec = new ReplayRecorder(svc);
  const host = rec.host({ applyFrame: () => null, frame: () => null } as unknown as HostPort);
  const sink = rec.sink({ frameObserved: () => { host.applyFrame("x", 1, { x: 0, y: 0, width: 10, height: 10 }); } } as unknown as Engine);
  sink.frameObserved("x", 1, { x: 0, y: 0, width: 5, height: 5 });
  assert.equal(rec.anomalies, 0, "inside an input: recorded");
  assert.equal(rec.events[0].c![0].h, "applyFrame");
  now = 6;
  host.applyFrame("x", 1, { x: 0, y: 0, width: 20, height: 20 }); // an entry point the runtime did not route through the recorder
  assert.equal(rec.anomalies, 1);
  assert.equal(rec.events.length, 1);
});
