// Mock compositor + runtime services for deterministic engine replay tests.
//
// Encodes KWin 6.7.5 behaviour, measured in nested KWin (M0/M1) and read in the
// source (src/xdgshellwindow.cpp moveResizeInternal, sendConfigure,
// handleNextWindowGeometry):
//  - xdg-shell (the default): a frame write whose size equals the committed size
//    applies its position synchronously and emits frameGeometryChanged inside the
//    setter (re-entrancy). A write that changes the size sends a configure carrying
//    size and position, and nothing changes until the client commits it; the window
//    then lands at that configure's bounds, position and size together;
//  - a size request equal to the committed size sends no configure even while another
//    configure is in flight (E04); the earlier configure still commits later, at its
//    own bounds;
//  - delay modes follow the fixture's --delay-mode: "latest" (a newer configure
//    replaces an unanswered one and keeps the first deadline) or "each" (queued:
//    every configure commits in order, so intermediate sizes are observed). A delay
//    of 0 commits on the next event-loop turn (drain), never inside the write;
//  - X11 clients (`x11`) are moved and resized synchronously inside the write;
//  - a client may clamp to its own minimum (KWin itself does not clamp xdg-toplevels);
//  - `ignore` acks configures but keeps its size (fixture --ignore-size), so a commit
//    still moves the window to the configure's position;
//  - at scales other than 1 the committed frame can differ from the request by up to
//    one device pixel (commitOffset; measured 0.571 px at scale 1.75);
//  - setMaximize(false, false) (ADR-021): X11 clears maximizeMode inside the call and moves the
//    frame to its restore geometry; an xdg-toplevel gets a configure (the restore geometry) and
//    KWin reports maximizeMode 0 only when the client commits it. KWin's configure timer
//    coalesces it with a frame write in the same turn into one configure (scheduleConfigure).
//    `remaximize` is a client that sets maximized again before acknowledging: its commit keeps
//    the maximize and the maximize area (`maxArea`).

import { rect, rectOf, type Rect } from "../../src/core/geometry.ts";
import type { FrameWrite, HostPort, OutputInfo, RuntimeServices, WindowSnapshot } from "../../src/core/ports.ts";
import type { Constraints, Membership, WindowMeta, WindowStates } from "../../src/core/types.ts";
import { Engine, type EngineOptions } from "../../src/core/engine.ts";

/** A configure in flight: its bounds (position and size) and when the client commits it. */
export interface Configure {
  readonly rect: Rect;
  readonly at: number;
  /** Carries an un-maximize: the window reports maximized=false when the client commits it. */
  readonly unmax?: boolean;
}

export interface MockWindow {
  id: string;
  gen: number;
  meta: WindowMeta;
  membership: Membership;
  states: WindowStates;
  constraints: Constraints;
  frame: Rect;                 // committed/observed frame
  /** Configures sent and not yet committed, oldest first ("latest" keeps at most one). */
  configures: Configure[];
  delay: number;               // client commit delay (ms)
  delayMode: "latest" | "each";
  x11: boolean;                // KWin applies the whole write synchronously
  clampToMin: boolean;         // client obeys its own minimum
  ignore: boolean;             // client keeps its size whatever is requested
  commitOffset: { width: number; height: number }; // committed minus requested size (device-pixel snapping)
  nativeTile: boolean;
  noBorder: boolean;
  alive: boolean;
  /** KWin's isMaximizable (false: fixed size, or a KWin rule forcing maximize). */
  maximizable: boolean;
  /** Where KWin's un-maximize puts the window (geometryRestore, or the client's own size). */
  restore: Rect;
  /** The client maximizes itself again before acknowledging an un-maximize (see the header). */
  remaximize: boolean;
  /** The maximize area a re-maximizing client commits. */
  maxArea: Rect;
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

function rectEq(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export class MockHost implements HostPort, RuntimeServices {
  t = 0;
  windows = new Map<string, MockWindow>();
  outs: OutputInfo[] = [{ id: "O1", name: "O1", geometry: rect(0, 0, 1280, 800), scale: 1 }];
  visible = new Map<string, string>([["O1", "D1"]]);
  /** KWin's PerOutputVirtualDesktops: showing a desktop changes one output instead of all. */
  perOutputDesktops = false;
  /** showDesktop calls, in order. */
  shown: Array<{ output: string; desktop: string }> = [];
  desks = ["D1", "D2"];
  activities = 1;
  activity = "default";
  active: string | null = null;
  areas = new Map<string, Rect | null>();
  engine!: Engine;
  logs: Array<{ level: string; message: string }> = [];
  writes: Array<{ id: string; target: Rect; t: number }> = [];
  /** unmaximize calls that reached a window, in order. */
  unmaximizes: string[] = [];
  /** Configures sent per window (the client's view: one per coalesced turn). */
  configuresSent = new Map<string, number>();
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

  /** Run deferred callbacks and commits already due (zero-delay clients) until quiescent (bounded). */
  drain(): number {
    let n = 0;
    for (let guard = 0; guard < 1000; ++guard) {
      if (this.later.length) {
        const fns = this.later; this.later = [];
        for (const fn of fns) { fn(); n++; }
        continue;
      }
      if (!this.commitDue()) break;
    }
    return n;
  }

  /** Commit every configure due by now, oldest first. Returns whether any committed. */
  private commitDue(): boolean {
    let any = false;
    for (;;) {
      let next: MockWindow | null = null;
      for (const w of this.windows.values()) {
        const c = w.alive ? w.configures[0] : undefined;
        if (c && c.at <= this.t && (!next || c.at < next.configures[0].at)) next = w;
      }
      if (!next) return any;
      this.commit(next);
      any = true;
    }
  }

  /** Advance the fake clock, delivering commits and deadlines in time order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (let guard = 0; guard < 10000; ++guard) {
      this.drain();
      const nextCommit = Math.min(...[...this.windows.values()].filter((w) => w.configures.length && w.alive).map((w) => w.configures[0].at), Infinity);
      const live = this.timers.filter((x) => !x.cancelled);
      const nextTimer = Math.min(...live.map((x) => x.at), Infinity);
      const next = Math.min(nextCommit, nextTimer);
      if (next > end) break;
      this.t = Math.max(this.t, next);
      this.commitDue();
      for (const x of live) if (x.at <= this.t && !x.cancelled) { x.cancelled = true; x.fn(); }
    }
    this.t = end;
    this.drain();
  }

  /** The client acks and commits its oldest configure: KWin places the window at that configure's bounds. */
  private commit(w: MockWindow): void {
    const c = w.configures.shift()!;
    if (c.unmax && w.remaximize) {
      // The client asked to be maximized again before acknowledging: KWin's acknowledged states
      // never lose the maximize, and the client commits the maximize area.
      this.setFrame(w, rectOf(w.maxArea));
      return;
    }
    // KWin applies the committed geometry first, then the acknowledged states
    // (XdgSurfaceWindow::handleCommit: handleNextWindowGeometry, then handleRoleCommit).
    const ack = c.unmax === true && w.states.maximized;
    let width = c.rect.width, height = c.rect.height;
    if (w.clampToMin) { width = Math.max(width, w.constraints.minFrame.width); height = Math.max(height, w.constraints.minFrame.height); }
    if (w.ignore) { width = w.frame.width; height = w.frame.height; }
    else { width += w.commitOffset.width; height += w.commitOffset.height; }
    this.setFrame(w, rect(c.rect.x, c.rect.y, width, height));
    if (ack) {
      w.states = { ...w.states, maximized: false };
      this.engine.statesChanged(w.id, w.gen, w.states);
    }
  }

  /** KWin's updateGeometry: frameGeometryChanged only when the frame actually changed. */
  private setFrame(w: MockWindow, f: Rect): void {
    if (rectEq(f, w.frame)) return;
    w.frame = f;
    this.engine.frameObserved(w.id, w.gen, w.frame);
  }

  // ------------------------------------------------------------------- host
  applyFrame(id: string, gen: number, target: Rect): FrameWrite | null {
    const w = this.windows.get(id);
    if (!w || !w.alive || w.gen !== gen) return null;
    const before = rectOf(w.frame);
    this.writes.push({ id, target, t: this.t });
    if (w.x11) {
      // X11: KWin moves and resizes the frame at once (size hints applied synchronously).
      const min = w.clampToMin ? w.constraints.minFrame : { width: 0, height: 0 };
      this.setFrame(w, rect(target.x, target.y, Math.max(target.width, min.width), Math.max(target.height, min.height)));
    } else if (w.configures.length && w.configures[w.configures.length - 1].unmax &&
               w.configures[w.configures.length - 1].at === this.t + w.delay) {
      // The un-maximize of this same turn moved KWin's requested geometry to the restore rectangle:
      // this write replaces it, whatever its size, and KWin sends one configure carrying both.
      const last = w.configures.length - 1;
      w.configures[last] = { rect: rectOf(target), at: w.configures[last].at, unmax: true };
    } else if (Math.abs(target.width - w.frame.width) < 0.5 && Math.abs(target.height - w.frame.height) < 0.5) {
      // The committed size: no configure. The position applies synchronously inside the write,
      // and a configure already in flight still commits later at its own bounds (E04).
      this.setFrame(w, rect(target.x, target.y, w.frame.width, w.frame.height));
    } else {
      // A configure carrying size and position: nothing changes until the client commits it.
      const last = w.configures.length - 1;
      const prev = last >= 0 ? w.configures[last] : null;
      if (w.delayMode === "latest" && prev) {
        w.configures[last] = { rect: rectOf(target), at: prev.at, unmax: prev.unmax };
        this.configuresSent.set(id, (this.configuresSent.get(id) ?? 0) + 1); // sent; the client answers only the newest
      } else {
        w.configures.push({ rect: rectOf(target), at: this.t + w.delay });
        this.configuresSent.set(id, (this.configuresSent.get(id) ?? 0) + 1);
      }
    }
    return { before, after: rectOf(w.frame) };
  }
  unmaximize(id: string, gen: number): boolean {
    const w = this.windows.get(id);
    if (!w || !w.alive || w.gen !== gen || !w.states.maximized || !w.maximizable) return false;
    this.unmaximizes.push(id);
    if (w.x11) {
      // X11Window::maximize(MaximizeRestore): maximizedChanged and the restore geometry inside the call.
      w.states = { ...w.states, maximized: false };
      this.engine.statesChanged(id, gen, w.states);
      this.setFrame(w, rectOf(w.restore));
      return true;
    }
    w.configures.push({ rect: rectOf(w.restore), at: this.t + w.delay, unmax: true });
    this.configuresSent.set(id, (this.configuresSent.get(id) ?? 0) + 1);
    return true;
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
    const prev = w.membership.output === null ? undefined : this.visible.get(w.membership.output);
    w.membership = { ...w.membership, output };
    // KWin keeps an interactively sent window on the current desktop: it takes the destination
    // output's current desktop in place of the source's (Window::finishInteractiveOutputChange).
    const cur = this.visible.get(output), ds = w.membership.desktops;
    if (cur !== undefined && prev !== undefined && cur !== prev && ds.length > 0 && !ds.includes(cur)) {
      w.membership = { ...w.membership, desktops: [...ds.filter((d) => d !== prev), cur] };
    }
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
  showDesktop(output: string, desktop: string): boolean {
    if (!this.desks.includes(desktop) || !this.outs.some((o) => o.id === output)) return false;
    this.shown.push({ output, desktop });
    if (this.perOutputDesktops) this.visible.set(output, desktop);
    else for (const o of this.outs) this.visible.set(o.id, desktop);
    this.engine.visibilityChanged(); // KWin emits currentDesktopChanged inside the setter
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
      states: NO_STATES, constraints: FREE, frame: rect(100, 100, 400, 300), configures: [], delay: 0, delayMode: "latest",
      x11: false, clampToMin: false, ignore: false, commitOffset: { width: 0, height: 0 }, nativeTile: false, noBorder: false,
      alive: true, maximizable: true, restore: rect(100, 100, 400, 300), remaximize: false, maxArea: rect(0, 0, 1280, 800),
      ...patch,
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

  /** Frame writes issued to one window so far (the write log is the oracle, not engine counters). */
  writesTo(id: string): number {
    let n = 0;
    for (const w of this.writes) if (w.id === id) n++;
    return n;
  }
}
