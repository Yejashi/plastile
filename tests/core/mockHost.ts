// Mock compositor + runtime services for deterministic engine replay tests.
//
// Encodes behaviour measured in nested KWin 6.7.5 (M0/M1):
//  - a position change applies synchronously and emits frameGeometryChanged
//    inside the setter (re-entrancy);
//  - a size change is asynchronous: configure now, commit after the client delay
//    (newer configures supersede older ones, "latest" delay mode);
//  - a size request equal to the committed size is dropped (no configure) even
//    while another configure is in flight (E04);
//  - a client may clamp to its own minimum (KWin itself does not clamp);
//  - at scales other than 1 the committed frame can differ from the request by up to
//    one device pixel (commitOffset; measured 0.571 px at scale 1.75).

import { rect, rectOf, type Rect } from "../../src/core/geometry.ts";
import type { FrameWrite, HostPort, OutputInfo, RuntimeServices, WindowSnapshot } from "../../src/core/ports.ts";
import type { Constraints, Membership, WindowMeta, WindowStates } from "../../src/core/types.ts";
import { Engine, type EngineOptions } from "../../src/core/engine.ts";

export interface MockWindow {
  id: string;
  gen: number;
  meta: WindowMeta;
  membership: Membership;
  states: WindowStates;
  constraints: Constraints;
  frame: Rect;                 // committed/observed frame
  pending: { width: number; height: number; at: number } | null;
  delay: number;               // client commit delay (ms)
  clampToMin: boolean;         // client obeys its own minimum
  ignore: boolean;             // client ignores requested sizes
  commitOffset: { width: number; height: number }; // committed minus requested size (device-pixel snapping)
  nativeTile: boolean;
  noBorder: boolean;
  alive: boolean;
}

export function meta(appId = "app", patch: Partial<WindowMeta> = {}): WindowMeta {
  return {
    appId, resourceName: appId, title: appId, role: "", kind: "normal", transient: false, transientFor: null,
    modal: false, special: false, managed: true, resizeable: true, moveable: true, skipTaskbar: false, pid: 1,
    own: false, ...patch,
  };
}

export const NO_STATES: WindowStates = { minimized: false, fullscreen: false, maximized: false, interactive: "none", hidden: false };
export const FREE: Constraints = { minFrame: { width: 0, height: 0 }, maxFrame: { width: Infinity, height: Infinity }, fixed: false };

export class MockHost implements HostPort, RuntimeServices {
  t = 0;
  windows = new Map<string, MockWindow>();
  outs: OutputInfo[] = [{ id: "O1", name: "O1", geometry: rect(0, 0, 1280, 800), scale: 1 }];
  visible = new Map<string, string>([["O1", "D1"]]);
  desks = ["D1", "D2"];
  activities = 1;
  activity = "default";
  active: string | null = null;
  areas = new Map<string, Rect | null>();
  engine!: Engine;
  logs: Array<{ level: string; message: string }> = [];
  writes: Array<{ id: string; target: Rect; t: number }> = [];
  raises: string[] = [];
  private later: Array<() => void> = [];
  private timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  private nextGen = 1;

  start(opts: EngineOptions = {}, initial: WindowSnapshot[] = []): Engine {
    this.engine = new Engine(this, this, opts);
    this.engine.start(initial);
    return this.engine;
  }

  // ---------------------------------------------------------------- services
  now(): number { return this.t; }
  callLater(fn: () => void): void { if (!this.later.includes(fn)) this.later.push(fn); }
  deadline(ms: number, fn: () => void): () => void {
    const t = { at: this.t + ms, fn, cancelled: false };
    this.timers.push(t);
    return () => { t.cancelled = true; };
  }
  log(level: string, message: string): void { this.logs.push({ level, message }); }

  /** Run deferred callbacks until quiescent (bounded). */
  drain(): number {
    let n = 0;
    while (this.later.length && n < 1000) {
      const fns = this.later; this.later = [];
      for (const fn of fns) { fn(); n++; }
    }
    return n;
  }

  /** Advance the fake clock, delivering commits and deadlines in time order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (let guard = 0; guard < 10000; ++guard) {
      this.drain();
      const nextCommit = Math.min(...[...this.windows.values()].filter((w) => w.pending && w.alive).map((w) => w.pending!.at), Infinity);
      const live = this.timers.filter((x) => !x.cancelled);
      const nextTimer = Math.min(...live.map((x) => x.at), Infinity);
      const next = Math.min(nextCommit, nextTimer);
      if (next > end) break;
      this.t = Math.max(this.t, next);
      for (const w of this.windows.values()) if (w.pending && w.alive && w.pending.at <= this.t) this.commit(w);
      for (const x of live) if (x.at <= this.t && !x.cancelled) { x.cancelled = true; x.fn(); }
    }
    this.t = end;
    this.drain();
  }

  private commit(w: MockWindow): void {
    const p = w.pending!;
    w.pending = null;
    let width = p.width, height = p.height;
    if (w.clampToMin) { width = Math.max(width, w.constraints.minFrame.width); height = Math.max(height, w.constraints.minFrame.height); }
    if (w.ignore) return;
    width += w.commitOffset.width;
    height += w.commitOffset.height;
    w.frame = rect(w.frame.x, w.frame.y, width, height);
    this.engine.frameObserved(w.id, w.gen, w.frame);
  }

  // ------------------------------------------------------------------- host
  applyFrame(id: string, gen: number, target: Rect): FrameWrite | null {
    const w = this.windows.get(id);
    if (!w || !w.alive || w.gen !== gen) return null;
    const before = rectOf(w.frame);
    this.writes.push({ id, target, t: this.t });
    const sizeSame = Math.abs(target.width - w.frame.width) < 0.5 && Math.abs(target.height - w.frame.height) < 0.5;
    if (!sizeSame) w.pending = { width: target.width, height: target.height, at: this.t + w.delay };
    // (sizeSame while pending: KWin sends no configure; the pending one still commits — E04)
    if (Math.abs(target.x - w.frame.x) >= 0.5 || Math.abs(target.y - w.frame.y) >= 0.5) {
      w.frame = rect(target.x, target.y, w.frame.width, w.frame.height);
      this.engine.frameObserved(w.id, w.gen, w.frame); // synchronous, inside the write
    }
    if (w.delay === 0 && w.pending) this.commit(w);
    return { before, after: rectOf(w.frame) };
  }
  frame(id: string, gen: number): Rect | null {
    const w = this.windows.get(id);
    return w && w.alive && w.gen === gen ? rectOf(w.frame) : null;
  }
  activate(id: string): boolean { if (!this.windows.get(id)?.alive) return false; this.active = id; this.engine.activeChanged(id); return true; }
  raise(id: string): boolean { this.raises.push(id); return true; }
  releaseNativeTile(id: string, gen: number): boolean {
    const w = this.windows.get(id);
    if (!w || w.gen !== gen || !w.nativeTile) return false;
    w.nativeTile = false;
    this.engine.nativeTileChanged(id, gen, false);
    return true;
  }
  setNoBorder(id: string, _gen: number, v: boolean): boolean { const w = this.windows.get(id); if (!w) return false; w.noBorder = v; return true; }
  noBorder(id: string): boolean | null { return this.windows.get(id)?.noBorder ?? null; }
  sendToOutput(id: string, gen: number, output: string): boolean {
    const w = this.windows.get(id);
    if (!w || w.gen !== gen) return false;
    w.membership = { ...w.membership, output };
    this.engine.membershipChanged(id, gen, w.membership);
    return true;
  }
  sendToDesktop(id: string, gen: number, desktop: string): boolean {
    const w = this.windows.get(id);
    if (!w || w.gen !== gen) return false;
    w.membership = { ...w.membership, desktops: [desktop] };
    this.engine.membershipChanged(id, gen, w.membership);
    return true;
  }
  activeWindow(): string | null { return this.active; }
  activeOutput(): string | null { return this.outs[0]?.id ?? null; }
  outputs(): readonly OutputInfo[] { return this.outs; }
  workArea(output: string, desktop: string): Rect | null {
    const k = `${output}/${desktop}`;
    if (this.areas.has(k)) return this.areas.get(k)!;
    return this.outs.find((o) => o.id === output)?.geometry ?? null;
  }
  visibleDesktop(output: string): string | null { return this.visible.get(output) ?? null; }
  desktops(): readonly string[] { return this.desks; }
  currentActivity(): string { return this.activity; }
  activityCount(): number { return this.activities; }

  // ------------------------------------------------------------ test driving
  /** Create a window (not yet announced). */
  make(id: string, patch: Partial<MockWindow> = {}): MockWindow {
    const w: MockWindow = {
      id, gen: this.nextGen++, meta: meta(id), membership: { output: "O1", desktops: ["D1"], onAllDesktops: false, activities: [] },
      states: NO_STATES, constraints: FREE, frame: rect(100, 100, 400, 300), pending: null, delay: 0, clampToMin: false,
      ignore: false, commitOffset: { width: 0, height: 0 }, nativeTile: false, noBorder: false, alive: true, ...patch,
    };
    this.windows.set(id, w);
    return w;
  }

  snapshot(w: MockWindow): WindowSnapshot {
    return { id: w.id, gen: w.gen, meta: w.meta, membership: w.membership, states: w.states, constraints: w.constraints,
             frame: rectOf(w.frame), nativeTile: w.nativeTile };
  }

  open(id: string, patch: Partial<MockWindow> = {}): MockWindow {
    const w = this.make(id, patch);
    this.engine.windowAdded(this.snapshot(w));
    return w;
  }

  close(id: string): void {
    const w = this.windows.get(id)!;
    w.alive = false;
    this.engine.windowRemoved(id, w.gen);
    if (this.active === id) this.active = null;
  }

  setStates(id: string, patch: Partial<WindowStates>): void {
    const w = this.windows.get(id)!;
    w.states = { ...w.states, ...patch };
    this.engine.statesChanged(id, w.gen, w.states);
  }

  /** The user/app moves or resizes a window directly (not through Plastile). */
  userSetFrame(id: string, r: Rect): void {
    const w = this.windows.get(id)!;
    w.frame = r;
    this.engine.frameObserved(id, w.gen, r);
  }

  framesOf(ids: string[]): Record<string, Rect> {
    const out: Record<string, Rect> = {};
    for (const id of ids) out[id] = rectOf(this.windows.get(id)!.frame);
    return out;
  }
}
