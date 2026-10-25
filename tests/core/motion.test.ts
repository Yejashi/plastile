// The optional Plastile Motion KWin effect (effect/, ADR-023), unit layer: its package metadata and
// settings schema, its pure rules, and its behaviour against a fake scripted-effect host. The host
// imitates the API KWin's ScriptedEffect gives the script (src/scripting/scriptedeffect.cpp,
// v6.8.1); it is not KWin. Visual results are checked in nested KWin (tests/integration/scenarios_motion.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const EFFECT = new URL("../../effect/", import.meta.url);
const SOURCE = readFileSync(new URL("contents/code/main.js", EFFECT), "utf8");
const META = JSON.parse(readFileSync(new URL("metadata.json", EFFECT), "utf8"));
const XML = readFileSync(new URL("contents/config/main.xml", EFFECT), "utf8");
const UI = readFileSync(new URL("contents/ui/config.ui", EFFECT), "utf8");
const PACKAGE_META = JSON.parse(readFileSync(new URL("../../package/metadata.json", import.meta.url), "utf8"));

type Rect = { x: number; y: number; width: number; height: number };
// Values created inside the vm context have that realm's prototypes; compare them as plain data.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
type Fn = (...args: any[]) => void;

class Signal {
  private slots: Fn[] = [];
  connect(f: Fn) { this.slots.push(f); }
  emit(...args: unknown[]) { for (const f of [...this.slots]) f(...args); }
  get count() { return this.slots.length; }
}

const SIGNALS = ["windowFrameGeometryChanged", "windowMaximizedStateAboutToChange", "windowStartUserMovedResized",
  "windowFinishUserMovedResized", "windowFullScreenChanged", "minimizedChanged", "windowDesktopsChanged",
  "windowHiddenChanged"];

class FakeWindow {
  [k: string]: unknown;
  caption: string;
  geometry: Rect;
  expandedGeometry: Rect;
  managed = true; normalWindow = true; popupWindow = false; internalWindow: object | null = null; deleted = false;
  fullScreen = false; move = false; resize = false; visible = true; minimized = false;
  screen = { geometry: { x: 0, y: 0, width: 1280, height: 800 } };
  constructor(caption: string, g: Rect) {
    this.caption = caption;
    this.geometry = { ...g };
    this.expandedGeometry = { x: g.x - 20, y: g.y - 20, width: g.width + 40, height: g.height + 40 };
    for (const s of SIGNALS) this[s] = new Signal();
  }
  sig(name: string) { return this[name] as Signal; }
  /** KWin has applied a new frame: emit windowFrameGeometryChanged(window, old). */
  setFrame(g: Rect) {
    const old = this.geometry;
    this.geometry = { ...g };
    this.expandedGeometry = { x: g.x - 20, y: g.y - 20, width: g.width + 40, height: g.height + 40 };
    this.sig("windowFrameGeometryChanged").emit(this, old);
  }
}

type Anim = { id: number; window: FakeWindow; type: number; from: any; to: any; duration: number; curve: number };

/** A fake scripted-effect host: records animate/retarget/cancel/addRepaint and logs. */
function host(opts: { config?: Record<string, unknown>; factor?: number; windows?: FakeWindow[] } = {}) {
  let clock = 1_000_000;
  let nextId = 1;
  const running = new Map<number, Anim>();
  const calls = { animate: [] as Anim[][], retarget: [] as [number, any, number][], cancel: [] as number[][],
    repaint: [] as number[][], log: [] as string[] };
  const config = { ...(opts.config ?? {}) };
  const grabbed = new Set<FakeWindow>();
  const effectsObj: Record<string, any> = {
    animationTimeFactor: opts.factor ?? 1, hasActiveFullScreenEffect: false,
    stackingOrder: opts.windows ?? [],
    addRepaint: (...r: number[]) => calls.repaint.push(r),
  };
  for (const s of ["windowAdded", "windowClosed", "windowDeleted", "desktopChanged", "currentActivityChanged",
    "screenAdded", "screenRemoved", "showingDesktopChanged"]) effectsObj[s] = new Signal();
  const effectObj = {
    readConfig: (k: string, d: unknown) => (k in config ? config[k] : d),
    configChanged: new Signal(), animationEnded: new Signal(),
    isGrabbed: (w: FakeWindow) => grabbed.has(w),
  };
  const ctx: Record<string, any> = {
    effects: effectsObj, effect: effectObj,
    Effect: { Position: 9, Size: 7, WindowAddedGrabRole: 1, WindowClosedGrabRole: 2, WindowMinimizedGrabRole: 3,
      WindowUnminimizedGrabRole: 4 },
    QEasingCurve: { Linear: 0, OutQuad: 2, OutCubic: 7, InOutCubic: 8, OutQuart: 11 },
    Date: { now: () => clock },
    console: { info: (s: string) => calls.log.push(s) },
    Map, JSON, Math, Number, String, isFinite,
    animate(o: any) {
      const ids: number[] = [];
      const batch: Anim[] = [];
      for (const a of o.animations) {
        const anim = { id: nextId++, window: o.window, type: a.type, from: plain(a.from), to: plain(a.to), duration: o.duration, curve: o.curve };
        running.set(anim.id, anim);
        ids.push(anim.id);
        batch.push(anim);
      }
      calls.animate.push(batch);
      return ids;
    },
    retarget(id: number, to: any, ms: number) {
      calls.retarget.push([id, plain(to), ms]);
      const a = running.get(id);
      if (!a) return false;
      a.to = to;
      return true;
    },
    cancel(ids: number[]) {
      calls.cancel.push([...ids]);
      for (const id of ids) running.delete(id);
      return true;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx, { filename: "effect/contents/code/main.js" });
  return {
    ctx, calls, running, config, grabbed,
    advance(ms: number) { clock += ms; },
    /** KWin ends every running animation of `w` (both report through animationEnded(w, 0)). */
    end(w: FakeWindow) {
      for (const [id, a] of [...running]) if (a.window === w) { running.delete(id); effectObj.animationEnded.emit(w, 0); }
    },
    add(w: FakeWindow) { effectsObj.windowAdded.emit(w); },
    effects: effectsObj,
  };
}

const A: Rect = { x: 8, y: 8, width: 691, height: 784 };
const B: Rect = { x: 707, y: 404, width: 565, height: 388 };
const C: Rect = { x: 707, y: 8, width: 565, height: 388 };
const centre = (r: Rect) => ({ value1: r.x + r.width / 2, value2: r.y + r.height / 2 });
const size = (r: Rect) => ({ value1: r.width, value2: r.height });

test("effect metadata: a KWin/Effect javascript package, disabled by default, versioned with the script", () => {
  assert.equal(META.KPackageStructure, "KWin/Effect");
  assert.equal(META["X-Plasma-API"], "javascript");
  assert.equal(META.KPlugin.Id, "plastile_motion");
  assert.equal(META.KPlugin.EnabledByDefault, false, "nothing changes for a user who does not enable it");
  assert.equal(META.KPlugin.Version, PACKAGE_META.KPlugin.Version, "the effect ships with the script's version");
  assert.equal(META.KPlugin.License, PACKAGE_META.KPlugin.License, "licence follows the project decision (ADR-012)");
  assert.equal(META["X-KDE-ConfigModule"], "kcm_kwin4_genericscripted");
  assert.ok(typeof META.KPlugin.Name === "string" && typeof META.KPlugin.Description === "string");
  assert.ok(!("X-KWin-Exclusive-Category" in META), "it does not replace another effect");
});

test("effect settings: main.xml entries, the keys main.js reads and the config.ui widgets agree", () => {
  const entries = [...XML.matchAll(/<entry name="([^"]+)" type="([^"]+)">/g)].map((m) => m[1]).sort();
  const read = [...SOURCE.matchAll(/readConfig\("([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(read, entries);
  const widgets = [...UI.matchAll(/name="kcfg_([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(widgets, ["Duration", "Easing"], "Debug is diagnostics only, not in the dialog");
  const items = (UI.split('name="kcfg_Easing"')[1].split("</widget>")[0].match(/<item>/g) ?? []).length;
  const easings = plain(vm.runInNewContext(SOURCE + "; MOTION_EASINGS", { Map, console }));
  assert.equal(items, easings.length, "one combo item per easing, in index order");
  assert.match(XML, /<entry name="Easing" type="Int">[\s\S]*?<max>4<\/max>/);
});

test("effect script: no timers, no polling, no file or network access", () => {
  for (const banned of ["setTimeout", "setInterval", "Qt.callLater", "XMLHttpRequest", "callDBus", "readFile"]) {
    assert.ok(!SOURCE.includes(banned), banned);
  }
  assert.doesNotThrow(() => new vm.Script(SOURCE));
});

test("duration: default 180 ms scaled by the global animation speed; instant (factor 0) disables", () => {
  const h = host();
  const d = h.ctx.motionDuration;
  assert.equal(d(0, 1), 180);
  assert.equal(d(0, 0.5), 90);
  assert.equal(d(250, 2), 500);
  assert.equal(d(0, 0), 0);
  assert.equal(d(300, 0), 0, "a configured duration does not override 'instant'");
  assert.equal(d(0, Number.NaN), 0);
  assert.equal(h.ctx.motionEasingName(3), "InOutCubic");
  assert.equal(h.ctx.motionEasingName(9), "OutCubic");
  assert.equal(h.ctx.motionEasingName(-1), "OutCubic");
});

test("decide: each rule names its reason", () => {
  const h = host();
  const base = { duration: 180, managed: true, normal: true, popup: false, internal: false, deleted: false, old: A, next: B,
    screen: { x: 0, y: 0, width: 1280, height: 800 }, statePendingAt: null, fullScreen: false, userMoveResize: false,
    interactions: 0, fullScreenEffect: false, visible: true, minimized: false, now: 10_000, suppressUntil: 0, addedAt: null,
    grabbed: false };
  const decide = (p: object) => h.ctx.motionDecide({ ...base, ...p });
  assert.equal(decide({}), "");
  assert.equal(decide({ duration: 0 }), "instant");
  assert.equal(decide({ normal: false }), "type");
  assert.equal(decide({ internal: true }), "type");
  assert.equal(decide({ old: { x: 0, y: 0, width: 0, height: 10 } }), "invalid");
  assert.equal(decide({ next: { ...A, x: A.x + 0.4 } }), "unchanged");
  assert.equal(decide({ statePendingAt: 9_500 }), "maximize");
  assert.equal(decide({ statePendingAt: 8_000 }), "", "a stale maximize request expires");
  assert.equal(decide({ fullScreen: true }), "fullscreen");
  assert.equal(decide({ next: { x: 0, y: 0, width: 1280, height: 800 } }), "fullscreen");
  assert.equal(decide({ userMoveResize: true }), "interactive");
  assert.equal(decide({ interactions: 1 }), "interactive", "another window's interactive resize moves peers");
  assert.equal(decide({ fullScreenEffect: true }), "fullscreen-effect");
  assert.equal(decide({ visible: false }), "hidden");
  assert.equal(decide({ suppressUntil: 10_001 }), "transition");
  assert.equal(decide({ addedAt: 9_600 }), "opening");
  assert.equal(decide({ addedAt: 9_400 }), "");
  assert.equal(decide({ grabbed: true }), "grabbed");
});

test("a programmatic change animates the visual from the old frame to the new one (Position + Size, absolute)", () => {
  const w = new FakeWindow("w", A);
  const h = host({ windows: [w] });
  w.setFrame(B);
  assert.equal(h.calls.animate.length, 1);
  const [pos, sz] = h.calls.animate[0];
  assert.deepEqual([pos.type, pos.from, pos.to], [9, centre(A), centre(B)]);
  assert.deepEqual([sz.type, sz.from, sz.to], [7, size(A), size(B)]);
  assert.equal(pos.duration, 180);
  assert.equal(pos.curve, 7, "OutCubic by default");
  assert.equal(h.calls.log.length, 0, "silent unless Debug is set");
});

test("rapid changes retarget the running animation instead of queueing or restarting from the old frame", () => {
  const w = new FakeWindow("w", A);
  const h = host({ windows: [w], config: { Debug: true } });
  w.setFrame(B);
  h.advance(20);
  w.setFrame(C);
  h.advance(20);
  w.setFrame(A);
  assert.equal(h.calls.animate.length, 1, "one animation for three changes");
  const [pos, sz] = h.calls.animate[0];
  assert.deepEqual(h.calls.retarget, [[pos.id, centre(C), 180], [sz.id, size(C), 180], [pos.id, centre(A), 180],
    [sz.id, size(A), 180]], "each retarget restarts the full duration towards the newest frame");
  assert.equal(h.calls.cancel.length, 0);
  assert.equal(h.calls.log.filter((l) => l.includes(" retarget ")).length, 2);
  h.end(w);
  assert.equal(h.calls.log.filter((l) => l.includes(" end ")).length, 1, "one end line per window");
  w.setFrame(B);
  assert.equal(h.calls.animate.length, 2, "after the end a new change starts afresh");
  assert.deepEqual(h.calls.animate[1][0].from, centre(A));
});

test("an animation that already ended in KWin is restarted from the frame it ended at", () => {
  const w = new FakeWindow("w", A);
  const h = host({ windows: [w] });
  w.setFrame(B);
  h.running.clear();   // ended without the script hearing yet
  w.setFrame(C);
  assert.equal(h.calls.animate.length, 2);
  assert.deepEqual(h.calls.animate[1][0].from, centre(B));
});

test("maximize: the requested transition is not animated and cancels a running animation (with a repaint)", () => {
  const w = new FakeWindow("w", A);
  const h = host({ windows: [w] });
  w.setFrame(B);
  w.sig("windowMaximizedStateAboutToChange").emit(w, true, true);
  assert.equal(h.calls.cancel.length, 1);
  assert.equal(h.calls.repaint.length, 1, "cancel() does not repaint by itself");
  w.setFrame({ x: 0, y: 0, width: 1280, height: 772 });
  assert.equal(h.calls.animate.length, 1, "the maximize geometry is the maximize effect's");
  h.advance(50);
  w.setFrame(B);
  assert.equal(h.calls.animate.length, 2, "the request claims one change only");
});

test("interactive move/resize: nothing animates during it; a move's drop animates, a resize's late commits do not", () => {
  const w = new FakeWindow("w", A);
  const peer = new FakeWindow("peer", B);
  const h = host({ windows: [w, peer] });
  peer.setFrame(C);
  w.resize = true;
  w.sig("windowStartUserMovedResized").emit(w);
  assert.equal(h.calls.cancel.length, 0, "no animation of w to cancel");
  w.setFrame({ ...A, width: 650 });
  peer.setFrame(B);
  assert.equal(h.calls.animate.length, 1, "peers moved by a live resize follow the pointer, unanimated");
  w.resize = false;
  w.sig("windowFinishUserMovedResized").emit(w);
  w.setFrame({ ...A, width: 640 });
  assert.equal(h.calls.animate.length, 1, "a late commit of the resize is not animated");
  peer.setFrame(C);
  assert.equal(h.calls.animate.length, 2, "a peer's placement after the release animates");
  h.advance(400);
  w.move = true;
  w.sig("windowStartUserMovedResized").emit(w);
  w.setFrame({ ...A, x: 300 });
  w.move = false;
  w.sig("windowFinishUserMovedResized").emit(w);
  w.setFrame(A);
  assert.equal(h.calls.animate.length, 3, "the drop placement after a move animates");
});

test("a new window's first placement is not animated; later changes are", () => {
  const h = host();
  const w = new FakeWindow("new", { x: 440, y: 250, width: 400, height: 300 });
  h.add(w);
  w.setFrame(B);
  assert.equal(h.calls.animate.length, 0);
  h.advance(600);
  w.setFrame(C);
  assert.equal(h.calls.animate.length, 1);
});

test("hidden, minimized, desktop/activity/output transitions and full-screen effects are not animated", () => {
  const w = new FakeWindow("w", A);
  const h = host({ windows: [w] });
  h.effects.desktopChanged.emit();
  w.setFrame(B);
  h.advance(400);
  w.visible = false;
  w.setFrame(C);
  w.visible = true;
  w.sig("minimizedChanged").emit(w);
  w.setFrame(A);
  h.advance(400);
  h.effects.hasActiveFullScreenEffect = true;
  w.setFrame(B);
  h.effects.hasActiveFullScreenEffect = false;
  h.effects.screenRemoved.emit();
  w.setFrame(C);
  assert.equal(h.calls.animate.length, 0);
  h.advance(400);
  w.setFrame(A);
  assert.equal(h.calls.animate.length, 1, "positive control");
});

test("global speed 'instant' disables every animation; non-normal and internal windows never animate", () => {
  const w = new FakeWindow("w", A);
  const h = host({ windows: [w], factor: 0 });
  w.setFrame(B);
  assert.equal(h.calls.animate.length, 0);
  h.effects.animationTimeFactor = 1;
  w.setFrame(C);
  assert.equal(h.calls.animate.length, 1, "the speed is read at each change, no reconfigure needed");
  const d = new FakeWindow("dialog", A); d.normalWindow = false;
  const i = new FakeWindow("inspector", A); i.internalWindow = {};
  h.add(d); h.add(i);
  h.advance(600);
  d.setFrame(B); i.setFrame(B);
  assert.equal(h.calls.animate.length, 1);
});

test("configured duration and easing are read at load and on configChanged", () => {
  const w = new FakeWindow("w", A);
  const h = host({ windows: [w], config: { Duration: 300, Easing: 4 }, factor: 0.5 });
  w.setFrame(B);
  assert.equal(h.calls.animate[0][0].duration, 150);
  assert.equal(h.calls.animate[0][0].curve, 0, "Linear");
  h.config.Easing = 1;
  (h.ctx.effect.configChanged as Signal).emit();
  h.end(w);
  w.setFrame(C);
  assert.equal(h.calls.animate[1][0].curve, 11, "OutQuart");
});

test("a window closing mid-animation is released at once and its interaction count is dropped", () => {
  const w = new FakeWindow("w", A);
  const other = new FakeWindow("other", C);
  const h = host({ windows: [w, other] });
  w.setFrame(B);
  w.move = true;
  w.sig("windowStartUserMovedResized").emit(w);
  h.effects.windowClosed.emit(w);
  assert.equal(h.calls.cancel.length, 1, "the move animation does not keep the closed window alive");
  other.setFrame(A);
  assert.equal(h.calls.animate.length, 2, "the closed window's interaction no longer suppresses others");
});

test("a desktop, activity or output change stops every running animation (with a repaint)", () => {
  const w = new FakeWindow("w", A);
  const v = new FakeWindow("v", C);
  const still = new FakeWindow("still", B);
  const h = host({ windows: [w, v, still] });
  w.setFrame(B);
  v.setFrame(A);
  h.effects.screenRemoved.emit();
  assert.equal(h.calls.cancel.length, 2, "one cancel per animated window, none for the still one");
  assert.equal(h.calls.repaint.length, 2);
  w.setFrame(C);
  assert.equal(h.calls.animate.length, 2, "the output change's own reflow is not animated");
});
