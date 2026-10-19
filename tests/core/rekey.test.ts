// Output re-keying without re-entrancy (ADR-022, consequences). KwinAdapter's queries are read-only:
// a query that meets an output the committed keys lack (an identical monitor KWin lists before
// screensChanged reaches the script) stages the new keys and answers from them; the engine is
// re-keyed at the next safe point (the adapter's deferred turn, or screensChanged), never inside the
// engine call that made the query. These tests run the real adapter and engine over the fake KWin
// (unit layer; no KWin, no QV4).
//
// "As before" is the adapter before this change: `legacy()` puts its keyOf back on one adapter
// instance (a miss committed the keys on the spot, calling engine.outputsRekeyed from the query).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../../src/core/engine.ts";
import type { RuntimeServices } from "../../src/core/ports.ts";
import { KwinAdapter, type OutputKey } from "../../src/adapters/kwin/adapter.ts";
import type { KOutput } from "../../src/adapters/kwin/kwinTypes.ts";
import { compileConfig } from "../../src/config/index.ts";
import { engineOptions } from "../../src/runtime/main.ts";
import { countRekeys, runAll } from "./qv4Scenarios.ts";
import { desktop, FakeQt, FakeWorkspace, output, type FakeDesktop, type FakeOutput, type FakeWindow, type R } from "./fakeKwin.ts";

const LG1: R = { x: 0, y: 0, width: 1280, height: 800 };
const DELL: R = { x: 1280, y: 0, width: 1280, height: 800 };
const LG2: R = { x: 2560, y: 0, width: 1280, height: 800 };
const PLAIN = "edid:LG/27UL/";

function edid(name: string, g: R, manufacturer: string, model: string, serialNumber: string): FakeOutput {
  return { ...output(name, g), manufacturer, model, serialNumber };
}

/** The adapter's keyOf before this change, on one instance: a miss commits the current screen list at once. */
function legacy(a: KwinAdapter): void {
  const x = a as unknown as { keys: Map<string, OutputKey>; updateKeys(): void; outputKey(o: KOutput): OutputKey | null };
  x.outputKey = (o: KOutput): OutputKey | null => {
    let k = x.keys.get(o.name);
    if (!k) {
      x.updateKeys();
      k = x.keys.get(o.name);
    }
    return k ?? null;
  };
}

/** Every engine event the adapter delivers, in order. */
function recorder(): { calls: Array<[string, unknown[]]>; sink: unknown } {
  const calls: Array<[string, unknown[]]> = [];
  const sink = new Proxy({}, { get: (_t, p) => (...a: unknown[]) => { calls.push([String(p), a]); } });
  return { calls, sink };
}

function rekeys(calls: Array<[string, unknown[]]>): Array<Array<[string, string]>> {
  return calls.filter((c) => c[0] === "outputsRekeyed").map((c) => [...(c[1][0] as Map<string, string>)]);
}

test("ADR-022: a query never re-keys; a committed output answers with its committed key, the twin with its staged key", () => {
  const lg1 = edid("DP-1", LG1, "LG", "27UL", "");
  const dell = edid("HDMI-A-1", DELL, "Dell", "U2720Q", "ABC");
  const lg2 = edid("DP-2", LG2, "LG", "27UL", "");
  const ws = new FakeWorkspace([lg1, dell], [desktop("D1")]);
  const qt = new FakeQt();
  const a = new KwinAdapter(ws as never, qt as never);
  const w = ws.window({ caption: "t", resourceClass: "t", output: lg1 });
  ws.windows.push(w);
  const { calls, sink } = recorder();
  a.attach(sink as never, false);
  assert.deepEqual(a.outputs().map((o) => o.id), [PLAIN, "edid:Dell/U2720Q/ABC"]);
  // The twin: KWin lists it, screensChanged has not reached the script.
  ws.current.set("DP-2", ws.desktops[0]);
  ws.screens = [lg2, lg1, dell];
  ws.activeScreen = lg2;
  assert.deepEqual(a.outputs().map((o) => [o.id, o.name, o.identity]),
    [[PLAIN, "DP-1", "edid"], ["edid:Dell/U2720Q/ABC", "HDMI-A-1", "edid"], ["edid:LG/27UL/@DP-2", "DP-2", "ambiguous"]]);
  assert.equal(a.activeOutput(), "edid:LG/27UL/@DP-2");
  // Before this change the first lookup above re-keyed DP-1 and this read answered null.
  assert.deepEqual(a.workArea(PLAIN, "desk-D1"), LG1);
  assert.equal(a.visibleDesktop(PLAIN), "desk-D1");
  assert.equal(a.outputNameOf(PLAIN), "DP-1");
  assert.equal(a.outputNameOf("edid:LG/27UL/@DP-2"), "DP-2");
  assert.equal(a.outputNameOf("edid:LG/27UL/@DP-1"), "edid:LG/27UL/@DP-1", "the new key is not committed yet");
  w.output = lg2;
  w.outputChanged.emit(); // a window event: its membership carries the twin's staged key
  const m = calls.filter((c) => c[0] === "membershipChanged").map((c) => (c[1][2] as { output: string }).output);
  assert.deepEqual(m, ["edid:LG/27UL/@DP-2"]);
  assert.deepEqual(rekeys(calls), [], "no query re-keyed the engine");
  // The adapter's deferred turn commits: DP-1 takes its connector-qualified key.
  qt.drain();
  assert.deepEqual(rekeys(calls), [[[PLAIN, "edid:LG/27UL/@DP-1"]]]);
  assert.deepEqual(a.outputs().map((o) => o.id), ["edid:LG/27UL/@DP-1", "edid:Dell/U2720Q/ABC", "edid:LG/27UL/@DP-2"]);
  assert.equal(a.outputNameOf(PLAIN), PLAIN);
  // screensChanged arrives later: nothing left to rename; the topology is re-solved.
  ws.screensChanged.emit();
  qt.drain();
  assert.equal(rekeys(calls).length, 1);
  assert.ok(calls.some((c) => c[0] === "topologyChanged"));
  a.detach();
  assert.equal(a.connectionCount(), 0);
});

test("ADR-022: screensChanged before the deferred turn commits once; detach drops a staged commit", () => {
  const lg1 = edid("DP-1", LG1, "LG", "27UL", "");
  const lg2 = edid("DP-2", LG2, "LG", "27UL", "");
  const ws = new FakeWorkspace([lg1], [desktop("D1")]);
  const qt = new FakeQt();
  const a = new KwinAdapter(ws as never, qt as never);
  const { calls, sink } = recorder();
  a.attach(sink as never, false);
  ws.screens = [lg1, lg2];
  a.outputs();
  ws.screensChanged.emit(); // KWin's own signal commits first
  assert.deepEqual(rekeys(calls), [[[PLAIN, "edid:LG/27UL/@DP-1"]]]);
  qt.drain();
  assert.equal(rekeys(calls).length, 1, "the deferred turn finds nothing staged");
  // Unload while a commit is staged: the queued turn does nothing.
  const lg3 = edid("DP-3", LG1, "LG", "27UL", "");
  ws.screens = [lg1, lg2, lg3];
  a.outputs();
  a.detach();
  qt.drain();
  assert.equal(rekeys(calls).length, 1, "no re-key after detach");
  assert.equal(a.connectionCount(), 0);
});

test("ADR-022: staged key sets are committed in order, as the old adapter committed them, so a twin that comes and goes converges", () => {
  // DP-2 appears (staged: DP-1 -> @DP-1, DP-2 @DP-2), then DP-1 goes before any commit (staged: DP-2 plain).
  const run = (old: boolean): Array<Array<[string, string]>> => {
    const lg1 = edid("DP-1", LG1, "LG", "27UL", "");
    const lg2 = edid("DP-2", LG2, "LG", "27UL", "");
    const ws = new FakeWorkspace([lg1], [desktop("D1")]);
    const qt = new FakeQt();
    const a = new KwinAdapter(ws as never, qt as never);
    if (old) legacy(a);
    const { calls, sink } = recorder();
    a.attach(sink as never, false);
    ws.screens = [lg1, lg2];
    assert.equal(a.outputNameOf("edid:LG/27UL/@DP-2"), "DP-2");
    ws.screens = [lg2];
    a.outputs();
    if (!old) assert.deepEqual(rekeys(calls), [], "staged, not committed");
    ws.screensChanged.emit();
    qt.drain();
    a.detach();
    return rekeys(calls);
  };
  assert.deepEqual(run(false), run(true));
  assert.deepEqual(run(false), [[[PLAIN, "edid:LG/27UL/@DP-1"]], [["edid:LG/27UL/@DP-2", PLAIN]]]);
});

// --------------------------------------------------------- the engine converges to the same state

interface Rig {
  ws: FakeWorkspace;
  qt: FakeQt;
  engine: Engine;
  count: { total: number; inside: number };
  d: FakeDesktop[];
  lg1: FakeOutput;
  dell: FakeOutput;
  lg2: FakeOutput;
  wins: Record<string, FakeWindow>;
}

function rig(old: boolean, twinFirst: boolean): Rig {
  const d = [desktop("D1", 1), desktop("D2", 2)];
  const lg1 = edid("DP-1", LG1, "LG", "27UL", "");
  const dell = edid("HDMI-A-1", DELL, "Dell", "U2720Q", "ABC");
  const lg2 = edid("DP-2", LG2, "LG", "27UL", "");
  const ws = new FakeWorkspace(twinFirst ? [lg1, dell, lg2] : [lg1, dell], d);
  const qt = new FakeQt();
  const adapter = new KwinAdapter(ws as never, qt as never);
  if (old) legacy(adapter);
  const snap = compileConfig({}, 1);
  if (!snap.ok) throw new Error("configuration rejected");
  const svc: RuntimeServices = { now: () => 0, callLater: (fn) => qt.callLater(fn), deadline: () => () => {}, log: () => {} };
  const engine = new Engine(adapter, svc, engineOptions(snap.snapshot, adapter));
  const count = countRekeys(engine);
  const wins: Record<string, FakeWindow> = {};
  const place = (caption: string, o: FakeOutput, dk: FakeDesktop): void => {
    const w = ws.window({ caption, resourceClass: caption, desktopFileName: caption, output: o, desktops: [dk],
      frameGeometry: { x: o.geometry.x + 40, y: 40, width: 300, height: 200 } });
    ws.windows.push(w);
    wins[caption] = w;
  };
  place("a1", lg1, d[0]); place("a2", lg1, d[0]); place("b1", lg1, d[1]);
  place("c1", dell, d[0]); place("c2", dell, d[1]);
  if (twinFirst) { place("t1", lg2, d[0]); place("t2", lg2, d[0]); }
  const initial = adapter.attach(engine, snap.snapshot.usesTitleRules);
  engine.start(initial);
  qt.drain();
  // User preferences on DP-1's contexts, so the saved state shows where they end up.
  for (const [desk, ratio] of [["desk-D1", 0.4], ["desk-D2", 0.7]] as Array<[string, number]>) {
    const key = twinFirst ? "edid:LG/27UL/@DP-1" : PLAIN;
    engine.setContextPreferences({ output: key, desktop: desk, activity: "default" }, { layout: null, masterStack: { ratio, masterCount: 1 } });
  }
  qt.drain();
  return { ws, qt, engine, count, d, lg1, dell, lg2, wins };
}

function twin(r: Rig): void {
  r.ws.current.set("DP-2", r.ws.current.get("DP-1")!);
  r.ws.screens = [r.lg2, r.lg1, r.dell];
}

/** A topology event: every context's cached settings are dropped, so the next settings lookup reads the host. */
function topology(r: Rig): void {
  r.ws.virtualScreenGeometryChanged.emit();
  r.qt.drain();
}

function move(r: Rig, w: FakeWindow, o: FakeOutput): void {
  w.output = o;
  r.ws.kwinSetFrame(w, { x: o.geometry.x + 50, y: 50, width: 300, height: 200 });
  w.outputChanged.emit();
}

/** The state reached once every turn ran and screensChanged was delivered. */
function settle(r: Rig): unknown {
  r.qt.drain();
  r.ws.screensChanged.emit();
  r.qt.drain();
  const frames: Record<string, string> = {};
  for (const w of r.ws.windows) frames[w.caption] = JSON.stringify(w.frameGeometry);
  return {
    // Sorted: a context renamed after the twin's context was created is re-inserted after it, so the
    // engine's insertion order (the order contexts are listed and solved in) can differ; nothing else does.
    contexts: r.engine.contextSummary().map((c) => `${c.id}:${c.layout}:${c.members}/${c.tiled}`).sort(),
    frames,
    prefs: r.engine.contextPreferences().map((p) => `${p.key.output}␟${p.key.desktop}=${JSON.stringify(p.prefs)}`),
    check: r.engine.check(),
  };
}

/**
 * Event orders after a twin monitor appears (or goes), each run with the old and the new adapter.
 * `dp1`: DP-1's key at the end (qualified while the twin is listed, plain once it is gone).
 */
const QUALIFIED = "edid:LG/27UL/@DP-1";
const ORDERS: Record<string, { twinFirst?: boolean; dp1?: string; act(r: Rig): void }> = {
  "screensChanged first": { act: (r) => { twin(r); } },
  "a window opens on the twin": { act: (r) => {
    twin(r);
    const w = r.ws.window({ caption: "n1", resourceClass: "n1", desktopFileName: "n1", output: r.lg2, desktops: [r.d[0]] });
    r.ws.add(w);
  } },
  "a window moves from DP-1 to the twin": { act: (r) => { twin(r); move(r, r.wins.a2, r.lg2); } },
  "a desktop switch on DP-1": { act: (r) => { twin(r); r.ws.setCurrentDesktopForScreen(r.d[1], r.lg1); } },
  "a command on DP-1's context": { act: (r) => {
    twin(r);
    r.ws.activeWindow = r.wins.a1;
    r.ws.activeScreen = r.lg1;
    r.engine.execute("plastile.layout.monocle");
  } },
  "a configuration change": { act: (r) => {
    topology(r);
    twin(r);
    const next = compileConfig({ gapInner: "20" }, 2);
    if (!next.ok) throw new Error("configuration rejected");
    const host = (r.engine as unknown as { host: KwinAdapter }).host;
    r.engine.configure({ ...engineOptions(next.snapshot, host), changes: { rules: false, settings: true } });
  } },
  "a persistence save": { act: (r) => { topology(r); twin(r); r.engine.contextPreferences(); } },
  "the twin goes, its windows move to DP-1": { twinFirst: true, dp1: PLAIN, act: (r) => {
    r.ws.screens = [r.lg1, r.dell];
    move(r, r.wins.t1, r.lg1);
    move(r, r.wins.t2, r.lg1);
  } },
  "the twin comes and goes before screensChanged": { dp1: PLAIN, act: (r) => {
    twin(r);
    const w = r.ws.window({ caption: "n1", resourceClass: "n1", desktopFileName: "n1", output: r.lg2, desktops: [r.d[0]] });
    r.ws.add(w);
    r.ws.screens = [r.lg1, r.dell];
    move(r, w, r.lg1);
  } },
};

for (const [name, o] of Object.entries(ORDERS)) {
  test(`ADR-022: ${name}: no re-key inside an engine call, and the same final contexts, frames and preferences as before`, () => {
    const now = rig(false, !!o.twinFirst);
    o.act(now);
    const nowFinal = settle(now);
    const old = rig(true, !!o.twinFirst);
    o.act(old);
    const oldFinal = settle(old);
    assert.equal(now.count.inside, 0, "outputsRekeyed was called inside another engine call");
    assert.deepEqual(nowFinal, oldFinal);
    assert.deepEqual((nowFinal as { check: string[] }).check, []);
    const ids = (nowFinal as { contexts: string[] }).contexts;
    const dp1 = o.dp1 ?? QUALIFIED;
    assert.ok(ids.some((id) => id.startsWith(`${dp1}␟desk-D1␟`)), `DP-1's context is keyed ${dp1}: ${ids.join(", ")}`);
    assert.ok(!ids.some((id) => id.startsWith(`${dp1 === PLAIN ? QUALIFIED : PLAIN}␟`)), `no context under DP-1's other key: ${ids.join(", ")}`);
  });
}

test("ADR-022: the QV4 scenarios converge to the same final state with the deferred commit and with the re-entrant one", () => {
  const all = runAll() as Record<string, { ok: boolean; final?: unknown; rekeys?: { total: number; inside: number } }>;
  for (const name of Object.keys(all).filter((n) => n.startsWith("adapter/"))) {
    const twinName = name.replace("adapter/", "reentrant/");
    assert.ok(all[name].ok, `${name}: ${JSON.stringify(all[name])}`);
    assert.ok(all[twinName].ok, `${twinName}: ${JSON.stringify(all[twinName])}`);
    assert.deepEqual(all[name].rekeys, { total: 1, inside: 0 }, name);
    assert.deepEqual(all[twinName].rekeys, { total: 1, inside: 1 }, twinName);
    assert.deepEqual(all[name].final, all[twinName].final, `${name}: final state`);
  }
});
