// Engine scenarios whose outcome depends on how a Map or Set is iterated while it changes.
// tests/core/qv4iteration.test.ts runs runAll() in Node (V8, ECMAScript) and, bundled, in QV4 (the
// qml tool: KWin's JavaScript engine without KWin) and requires the same result from both. QV4's
// for...of over a Map, Set or one of their iterators skips the entry after one deleted at or
// before its position (docs/validation/PERFORMANCE.md §7.1); a Node test cannot see that.
//
// Every scenario drives a real re-entrant path from src/: a call made inside a loop over an engine
// collection ends in a call that deletes from that collection.
//
//  - The adapter edge (scenarios marked `adapter`): any HostPort read that resolves an output key,
//    and the configuration's settingsFor (through ContextNames.outputNameOf), goes through
//    KwinAdapter.keyOf. When KWin lists an output the adapter has not keyed yet (a twin monitor,
//    before screensChanged reaches the script) keyOf rebuilds the keys and calls
//    engine.outputsRekeyed synchronously, which deletes and re-adds the renamed contexts (and their
//    `emptied`, `dirty` and `retained` entries). These run the real KwinAdapter over the fake KWin
//    surface (fakeKwin.ts); the order of events is chosen so that the first key lookup after the
//    twin appears is made inside the loop. Whether KWin ever delivers events in that order was not
//    tested.
//  - The engine edge (scenarios marked `engine`): the mock compositor calls back into the engine
//    synchronously from a host call, as KWin's signals do.
//
// Each scenario returns { ok, ...observations }: ok is the expected (ECMAScript) outcome.

import { rect, type Rect } from "../../src/core/geometry.ts";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import type { Engine } from "../../src/core/engine.ts";
import { Engine as EngineClass } from "../../src/core/engine.ts";
import type { Membership } from "../../src/core/types.ts";
import type { FrameWrite, RuntimeServices } from "../../src/core/ports.ts";
import { KwinAdapter } from "../../src/adapters/kwin/adapter.ts";
import { compileConfig } from "../../src/config/index.ts";
import { engineOptions } from "../../src/runtime/main.ts";
import { MockHost } from "./mockHost.ts";
import { desktop, FakeQt, FakeWorkspace, output, type FakeDesktop, type FakeOutput, type FakeWindow, type R } from "./fakeKwin.ts";

const LG1: R = { x: 0, y: 0, width: 1280, height: 800 };
const DELL: R = { x: 1280, y: 0, width: 1280, height: 800 };
const LG2: R = { x: 2560, y: 0, width: 1280, height: 800 };

function edid(name: string, g: R, manufacturer: string, model: string, serialNumber: string): FakeOutput {
  return { ...output(name, g), manufacturer, model, serialNumber };
}

function txt(r: R | Rect): string { return `${r.x},${r.y} ${r.width}x${r.height}`; }

function inside(r: R, a: R): boolean {
  return r.x >= a.x && r.y >= a.y && r.x + r.width <= a.x + a.width && r.y + r.height <= a.y + a.height;
}

function overlap(a: R, b: R): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Tiled in `area`: every frame inside it, none overlapping another, and none left at its opening frame. */
function tiledIn(ws: FakeWindow[], area: R, opened: R): boolean {
  for (let i = 0; i < ws.length; ++i) {
    const f = ws[i].frameGeometry as R;
    if (!inside(f, area) || txt(f) === txt(opened)) return false;
    for (let j = i + 1; j < ws.length; ++j) if (overlap(f, ws[j].frameGeometry as R)) return false;
  }
  return true;
}

interface Rig {
  ws: FakeWorkspace;
  qt: FakeQt;
  adapter: KwinAdapter;
  engine: Engine;
  d: FakeDesktop[];
  lg1: FakeOutput;
  dell: FakeOutput;
  /** A second LG 27UL: identical to lg1, so both are keyed by EDID plus connector once it is known. */
  lg2: FakeOutput;
  win(caption: string, o: FakeOutput, d: FakeDesktop): FakeWindow;
  /** KWin lists the twin first; screensChanged has not reached the script yet. */
  twinAppears(): void;
  frames(): Record<string, string>;
}

const OPENED: R = { x: 40, y: 40, width: 300, height: 200 };

function opened(o: FakeOutput): R { return { ...OPENED, x: o.geometry.x + OPENED.x }; }

/** The real adapter and engine over the fake KWin, wired as src/runtime/main.ts wires them. */
function rig(flat: Record<string, unknown>, place: (r: Rig) => void): Rig {
  const d = [desktop("D1", 1), desktop("D2", 2)];
  const lg1 = edid("DP-1", LG1, "LG", "27UL", "");
  const dell = edid("HDMI-A-1", DELL, "Dell", "U2720Q", "ABC");
  const lg2 = edid("DP-2", LG2, "LG", "27UL", "");
  const ws = new FakeWorkspace([lg1, dell], d);
  const qt = new FakeQt();
  const adapter = new KwinAdapter(ws as never, qt as never);
  const snap = compileConfig(flat, 1);
  if (!snap.ok) throw new Error("configuration rejected");
  const svc: RuntimeServices = { now: () => 0, callLater: (fn) => qt.callLater(fn), deadline: () => () => {}, log: () => {} };
  const engine = new EngineClass(adapter, svc, engineOptions(snap.snapshot, adapter));
  const r: Rig = {
    ws, qt, adapter, engine, d, lg1, dell, lg2,
    win(caption, o, dk) {
      const w = ws.window({ caption, resourceClass: caption, desktopFileName: caption, output: o, desktops: [dk], frameGeometry: opened(o) });
      ws.windows.push(w);
      return w;
    },
    twinAppears() {
      ws.current.set(lg2.name, ws.current.get(lg1.name)!);
      ws.screens = [lg2, lg1, dell];
    },
    frames() {
      const out: Record<string, string> = {};
      for (const w of ws.windows) out[w.caption] = txt(w.frameGeometry);
      return out;
    },
  };
  place(r);
  const initial = adapter.attach(engine, snap.snapshot.usesTitleRules);
  engine.start(initial);
  qt.drain();
  return r;
}

/** Topology event: every context's settings are dropped; hidden contexts stay without until they are used. */
function topology(r: Rig): void {
  r.ws.virtualScreenGeometryChanged.emit();
  r.qt.drain();
}

function ids(r: Rig): string[] { return r.engine.contextSummary().map((c) => c.id); }

// ----------------------------------------------------------------------------------------- adapter

/**
 * engine.markVisibleDirty (visibilityChanged): a desktop switch is the first key lookup after the
 * twin appeared. The context switched to (HDMI-A-1 / D2, three windows that were never shown) must
 * be marked and solved.
 */
function visibilitySwitch(): unknown {
  let c: FakeWindow[] = [];
  const r = rig({}, (x) => {
    x.win("a1", x.lg1, x.d[0]); x.win("a2", x.lg1, x.d[0]);           // context A: DP-1 / D1 (shown)
    c = [x.win("c1", x.dell, x.d[1]), x.win("c2", x.dell, x.d[1])];    // context C: HDMI-A-1 / D2 (hidden)
    x.win("b1", x.lg1, x.d[1]);                                         // context B: DP-1 / D2 (hidden)
  });
  const c3 = r.ws.window({ caption: "c3", resourceClass: "c3", desktopFileName: "c3", output: r.dell, desktops: [r.d[1]],
    frameGeometry: opened(r.dell) });
  r.ws.add(c3); // opened while D2 is hidden: its context changes unseen
  r.qt.drain();
  r.twinAppears();
  r.ws.setCurrentDesktopForScreen(r.d[1], r.lg1); // currentDesktopChanged -> engine.visibilityChanged
  r.qt.drain();
  c = [...c, c3];
  return { ok: tiledIn(c, DELL, opened(r.dell)), frames: r.frames(), contexts: ids(r), check: r.engine.check() };
}

/**
 * engine.configure: the settings comparison over the contexts. A hidden context without cached
 * settings resolves them first; that lookup re-keys DP-1's contexts. The shown HDMI-A-1 context
 * after it must still be compared, and re-solved with the new gap.
 */
function configureGaps(): unknown {
  const r = rig({ gapInner: "8" }, (x) => {
    x.win("a1", x.lg1, x.d[0]); x.win("a2", x.lg1, x.d[0]);   // A: DP-1 / D1 (shown)
    x.win("c1", x.dell, x.d[1]);                                // C: HDMI-A-1 / D2 (hidden)
    x.win("d1", x.dell, x.d[0]); x.win("d2", x.dell, x.d[0]);   // D: HDMI-A-1 / D1 (shown)
    x.win("b1", x.lg1, x.d[1]);                                 // B: DP-1 / D2 (hidden)
  });
  topology(r);
  r.twinAppears();
  const next = compileConfig({ gapInner: "20" }, 2);
  if (!next.ok) throw new Error("configuration rejected");
  r.engine.configure({ ...engineOptions(next.snapshot, r.adapter), changes: { rules: false, settings: true } });
  r.qt.drain();
  const gap = (a: string, b: string): number => {
    const fa = r.ws.windows.find((w) => w.caption === a)!.frameGeometry as R;
    const fb = r.ws.windows.find((w) => w.caption === b)!.frameGeometry as R;
    return fb.x - (fa.x + fa.width);
  };
  return { ok: gap("d1", "d2") === 20 && gap("a1", "a2") === 20, gapA: gap("a1", "a2"), gapD: gap("d1", "d2"),
           frames: r.frames(), contexts: ids(r), check: r.engine.check() };
}

/**
 * engine.contextPreferences (what persistence saves): a hidden context's preferences need its
 * settings, and that lookup re-keys DP-1's contexts. Every context's preference must be saved,
 * once, under the context's current key.
 */
function savedPreferences(): unknown {
  const ratios: Record<string, number> = { a1: 0.45, c1: 0.6, d1: 0.7, b1: 0.65 };
  const r = rig({}, (x) => {
    x.win("a1", x.lg1, x.d[0]);    // A: DP-1 / D1 (shown)
    x.win("c1", x.dell, x.d[1]);   // C: HDMI-A-1 / D2 (hidden)
    x.win("d1", x.dell, x.d[0]);   // D: HDMI-A-1 / D1 (shown)
    x.win("b1", x.lg1, x.d[1]);    // B: DP-1 / D2 (hidden)
  });
  for (const w of r.ws.windows) {
    const m = r.adapter.liveSnapshots().find((s) => s.meta.appId === w.caption)!.membership;
    const key = { output: m.output!, desktop: m.desktops[0], activity: r.ws.currentActivity || "default" };
    r.engine.setContextPreferences(key, { layout: null, masterStack: { ratio: ratios[w.caption], masterCount: 1 } });
  }
  r.qt.drain();
  topology(r);
  r.twinAppears();
  const saved = r.engine.contextPreferences().map((p) => `${p.key.output}␟${p.key.desktop}=${p.prefs.masterStack?.ratio}`);
  const live = ids(r);
  const keys = r.engine.contextPreferences().map((p) => `${p.key.output}␟${p.key.desktop}`);
  const ok = saved.length === 4 && keys.every((k) => live.some((id) => id.startsWith(k + "␟")))
    && Object.keys(ratios).every((k) => saved.some((s) => s.endsWith("=" + ratios[k])));
  return { ok, saved, contexts: live };
}

/**
 * engine.releaseAllZones (suspend): releasing a zoned window records its float rectangle, which
 * reads the work area and re-keys DP-1's contexts. The HDMI-A-1 context after it must be released
 * too: a window the user moves while tiling is suspended stays where it was put on resume.
 */
function suspendZones(): unknown {
  let a1: FakeWindow = null, c1: FakeWindow = null;
  const r = rig({ layout: "zones" }, (x) => {
    a1 = x.win("a1", x.lg1, x.d[0]);   // A: DP-1 / D1
    c1 = x.win("c1", x.dell, x.d[0]);  // C: HDMI-A-1 / D1
  });
  for (const w of [a1, c1]) {
    r.ws.activeWindow = w;
    r.ws.activeScreen = w.output;
    r.engine.execute("plastile.zone.assign-1");
    r.qt.drain();
  }
  const zoned = txt(c1.frameGeometry);
  topology(r);
  r.twinAppears();
  r.engine.execute("plastile.runtime.toggle-suspend");
  r.qt.drain();
  const moved: R = { x: 1500, y: 300, width: 420, height: 260 };
  r.ws.kwinSetFrame(c1, moved); // the user moves it while tiling is suspended
  r.engine.execute("plastile.runtime.toggle-suspend");
  r.qt.drain();
  return { ok: zoned !== txt(moved) && txt(c1.frameGeometry) === txt(moved), zoned, frames: r.frames(), contexts: ids(r) };
}

// ------------------------------------------------------------------------------------------ engine

/**
 * engine.solveAndApply, the apply loop (G2 report §16.9): a frame write makes KWin report the
 * window on another output inside the write, so it leaves the context and its entry of the plan
 * being walked. The next window of the plan must still be written.
 */
function applyLeaves(): unknown {
  class Host extends MockHost {
    leaveOn: string | null = null;
    /** Each write as "<window>@<solve count>": the writes of one solve share the count. */
    log2: string[] = [];
    override applyFrame(id: string, gen: number, target: Rect): FrameWrite | null {
      this.log2.push(`${id}@${this.engine.counters.solves}`);
      const fw = super.applyFrame(id, gen, target);
      if (id === this.leaveOn) {
        this.leaveOn = null;
        const w = this.windows.get(id)!;
        w.membership = { ...w.membership, output: "O2" } as Membership;
        this.engine.membershipChanged(id, gen, w.membership);
      }
      return fw;
    }
  }
  const h = new Host();
  h.outs = [...h.outs, { id: "O2", name: "O2", geometry: rect(1280, 0, 1280, 800), scale: 1 }];
  h.visible.set("O2", "D1");
  const e = h.start({ settingsFor: () => DEFAULT_SETTINGS });
  for (const id of ["a", "b", "c", "d"]) h.open(id, { x11: true, frame: rect(100, 100, 400, 300) });
  h.drain();
  const from = h.log2.length;
  h.leaveOn = "b";
  h.open("e", { x11: true, frame: rect(100, 100, 400, 300) }); // one more window: every slot changes
  h.drain();
  const writes = h.log2.slice(from);
  const first = writes[0].split("@")[1];
  // The solve in which b left: the windows after it in the plan are written in that same solve.
  const solve = writes.filter((w) => w.endsWith("@" + first)).map((w) => w.split("@")[0]);
  return { ok: solve.includes("c") && solve.includes("d"), solve, writes, frames: h.framesOf(["a", "b", "c", "d", "e"]),
           check: e.check() };
}

/**
 * engine.collectEmpty: an emptied context's preferences need its settings; resolving them re-keys
 * an output (as KwinAdapter.keyOf does from settingsFor). Every emptied context must be collected.
 */
function collectEmptied(): unknown {
  const h = new MockHost();
  const O2 = { id: "O2", name: "O2", geometry: rect(1280, 0, 1280, 800), scale: 1 };
  h.outs = [...h.outs, O2];
  h.visible.set("O2", "D1");
  let armed = false;
  let engine: Engine | null = null;
  const e = h.start({
    settingsFor: () => {
      if (armed && engine) {
        armed = false;
        engine.outputsRekeyed(new Map([["O1", "O1b"]]));
      }
      return DEFAULT_SETTINGS;
    },
  });
  engine = e;
  h.open("x", { membership: { output: "O1", desktops: ["D1"], onAllDesktops: false, activities: [] } });
  h.open("y", { membership: { output: "O2", desktops: ["D1"], onAllDesktops: false, activities: [] } });
  h.drain();
  h.close("x");
  h.close("y");
  e.topologyChanged(); // drops every context's cached settings
  h.outs = [{ id: "O1b", name: "O1", geometry: rect(0, 0, 1280, 800), scale: 1 }, O2];
  h.visible.set("O1b", "D1");
  armed = true;
  h.drain();
  const left = e.contextSummary().map((c) => `${c.id}:${c.members}`);
  return { ok: left.length === 0, left, check: e.check() };
}

const SCENARIOS: Record<string, () => unknown> = {
  "adapter/visibility-switch": visibilitySwitch,
  "adapter/configure-gaps": configureGaps,
  "adapter/saved-preferences": savedPreferences,
  "adapter/suspend-zones": suspendZones,
  "engine/apply-leaves": applyLeaves,
  "engine/collect-emptied": collectEmptied,
};

/** Every scenario's result, or its error message. */
export function runAll(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(SCENARIOS)) {
    try { out[name] = SCENARIOS[name](); } catch (e) { out[name] = { ok: false, error: String(e) }; }
  }
  return out;
}
