// KWin adapter: the only module that touches live KWin objects.
//
// Owns the window registry, every signal connection (registry-owned and
// disconnected on teardown: M0 measured that unowned closures survive unload),
// value snapshots for the engine, and the HostPort operations. Uses only the
// script surface verified in docs/status/API_PROFILE.md, plus signals measured in
// nested KWin 6.7.5 where noted below.

import { rectOf, type Rect, type Size } from "../../core/geometry.ts";
import type { FrameWrite, HostPort, OutputInfo, WindowSnapshot } from "../../core/ports.ts";
import type { Engine } from "../../core/engine.ts";
import type { Constraints, Membership, WindowKind, WindowMeta, WindowStates } from "../../core/types.ts";
import type { KDesktop, KOutput, KQt, KSignal, KWindow, KWorkspace } from "./kwinTypes.ts";

const UNBOUNDED = 2147483647;

interface Conn { signal: KSignal; fn: (...args: unknown[]) => void }

interface Entry {
  w: KWindow;
  id: string;
  gen: number;
  conns: Conn[];
  meta: WindowMeta;
  /** Geometry/state signals connected (managed kinds; not panels or passive surfaces). */
  hooked: boolean;
  /** captionChanged connection, present only while title rules are active. */
  caption: Conn | null;
  /** Sizes around the last frame request until the client answers it (constraint refresh on deviation). */
  req: { from: Size; to: Size } | null;
}

/** Constraint re-reads are bounded: one per frame request that the client answered with another size. */
const SIZE_TOL = 1;

function sameSize(a: Size, b: Size): boolean {
  return Math.abs(a.width - b.width) <= SIZE_TOL && Math.abs(a.height - b.height) <= SIZE_TOL;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Window kinds that never need geometry/state signal hookups. */
const PASSIVE_KINDS: ReadonlySet<WindowKind> = new Set<WindowKind>([
  "tooltip", "popup", "menu", "dnd-icon", "osd", "notification", "applet-popup", "splash",
]);

export function kindOf(w: KWindow): WindowKind {
  if (w.desktopWindow) return "desktop";
  if (w.dock) return "dock";
  if (w.tooltip) return "tooltip";
  if (w.notification || w.criticalNotification) return "notification";
  if (w.onScreenDisplay) return "osd";
  if (w.appletPopup) return "applet-popup";
  if (w.dndIcon) return "dnd-icon";
  if (w.menu || w.dropdownMenu || w.popupMenu || w.comboBox) return "menu";
  if (w.popupWindow) return "popup";
  if (w.splash) return "splash";
  if (w.toolbar) return "toolbar";
  if (w.utility) return "utility";
  if (w.dialog) return "dialog";
  if (w.normalWindow) return "normal";
  return "other";
}

/** Caption of Plastile's own inspector window (package/contents/ui/Inspector.qml, runtime/inspect.ts). */
export const OWN_UI_TITLE = "Plastile inspector";

/**
 * Plastile's own UI: a QML window the script creates is a KWin internal window, which
 * reports no application id and no client process (pid -1, measured in nested KWin 6.7.5).
 * Together with the fixed caption that identifies the inspector; a client window with the
 * same caption still has an application id or a process.
 */
export function isOwnUi(w: KWindow): boolean {
  return w.caption === OWN_UI_TITLE && !w.resourceClass && !w.desktopFileName && !(w.pid > 0);
}

export function metaOf(w: KWindow): WindowMeta {
  return {
    appId: String(w.resourceClass || w.desktopFileName || ""),
    resourceName: String(w.resourceName || ""),
    title: String(w.caption || ""),
    role: String(w.windowRole || ""),
    kind: kindOf(w),
    transient: !!w.transient,
    transientFor: w.transientFor ? String(w.transientFor.internalId) : null,
    modal: !!w.modal,
    special: !!w.specialWindow,
    managed: !!w.managed && !w.deleted,
    resizeable: !!w.resizeable,
    moveable: !!w.moveable,
    skipTaskbar: !!w.skipTaskbar,
    pid: w.pid,
    own: isOwnUi(w),
  };
}

export function membershipOf(w: KWindow): Membership {
  const desks: string[] = [];
  const ds = w.desktops;
  for (let i = 0; i < ds.length; ++i) desks.push(String(ds[i].id));
  const acts: string[] = [];
  const as = w.activities;
  for (let i = 0; i < as.length; ++i) acts.push(String(as[i]));
  return { output: w.output ? w.output.name : null, desktops: desks, onAllDesktops: !!w.onAllDesktops, activities: acts };
}

export function statesOf(w: KWindow): WindowStates {
  return {
    minimized: !!w.minimized,
    fullscreen: !!w.fullScreen,
    maximized: w.maximizeMode !== 0,
    interactive: w.move ? "move" : w.resize ? "resize" : "none",
    hidden: !!w.hidden,
  };
}

/**
 * minSize/maxSize are client-space (M0); frame constraints add decoration margins.
 * `resizeable` defaults to the live property; refreshes pass the sampled metadata value
 * because KWin reports any window as not resizable while fullscreen is requested
 * (observed source: xdgshellwindow.cpp:682-686, x11window.cpp:3459), which is a state, not
 * a size constraint.
 */
export function constraintsOf(w: KWindow, resizeable: boolean = !!w.resizeable): Constraints {
  const f = w.frameGeometry, c = w.clientGeometry;
  const mw = Math.max(0, f.width - c.width), mh = Math.max(0, f.height - c.height);
  const min = w.minSize, max = w.maxSize;
  const minW = min.width > 0 ? min.width + mw : 0, minH = min.height > 0 ? min.height + mh : 0;
  const maxW = max.width > 0 && max.width < UNBOUNDED ? max.width + mw : Infinity;
  const maxH = max.height > 0 && max.height < UNBOUNDED ? max.height + mh : Infinity;
  const fixed = !resizeable || (maxW !== Infinity && maxH !== Infinity && Math.abs(maxW - minW) < 1 && Math.abs(maxH - minH) < 1);
  return { minFrame: { width: minW, height: minH }, maxFrame: { width: maxW, height: maxH }, fixed };
}

export class KwinAdapter implements HostPort {
  private ws: KWorkspace;
  private qt: KQt;
  private entries = new Map<string, Entry>();
  /** Adapter-wide generation counter: unique across re-registration without a per-id table. */
  private lastGen = 0;
  private globals: Conn[] = [];
  private outputConns: Conn[] = [];
  private desktopConns: Conn[] = [];
  private engine: Engine | null = null;
  private watchTitles = false;
  private alive = true;
  /** Last usable area (MaximizeArea) per output name; KWin keeps one per output, not per desktop. */
  private areas = new Map<string, Rect>();
  private topologyPending = false;
  /** Deferred work-area checks still allowed for the current panel event (0: none pending). */
  private areaChecks = 0;
  private deferredQueued = false;
  /** Inside a frame write: re-entrant constraint refreshes are deferred to the next turn. */
  private writing = false;
  private pendingRefresh: Entry[] = [];
  /** Desktop names changed (configuration matchers read them); set by the runtime. */
  onDesktopNamesChanged: (() => void) | null = null;
  /** One coalesced callback for topology and work-area invalidation (stable identity for callLater). */
  private readonly deferredFlush = (): void => {
    this.deferredQueued = false;
    if (!this.alive || !this.engine) return;
    if (this.pendingRefresh.length > 0) {
      const list = this.pendingRefresh;
      this.pendingRefresh = [];
      for (const e of list) this.refreshConstraints(e);
    }
    if (this.topologyPending) {
      // The engine re-solves every context; only refresh the area cache.
      this.topologyPending = false;
      this.areaChecks = 0;
      this.areas.clear();
      this.readAreas();
      this.engine.topologyChanged();
      return;
    }
    if (this.areaChecks > 0) {
      this.areaChecks--;
      const changed = this.readAreas();
      if (changed.length > 0) {
        this.areaChecks = 0;
        this.engine.workAreaChanged(changed);
      } else if (this.areaChecks > 0) {
        // KWin defers the rearrange after a strut window goes away (Workspace::removeWindow ->
        // scheduleRearrange(), a 0 ms timer): look once more on the next turn, then stop.
        this.queueDeferred();
      }
    }
  };

  constructor(ws: KWorkspace, qt: KQt) {
    this.ws = ws;
    this.qt = qt;
  }

  // ----------------------------------------------------------------- lifecycle
  attach(engine: Engine, watchTitles: boolean): WindowSnapshot[] {
    this.engine = engine;
    this.watchTitles = watchTitles;
    this.own(this.ws.windowAdded, (w) => this.onAdded(w as KWindow), this.globals);
    this.own(this.ws.windowRemoved, (w) => this.onRemoved(w as KWindow), this.globals);
    this.own(this.ws.windowActivated, (w) => this.onActivated(w as KWindow | null), this.globals);
    const vis = () => { if (this.alive && this.engine) this.engine.visibilityChanged(); };
    this.own(this.ws.currentDesktopChanged, vis, this.globals);
    this.own(this.ws.currentActivityChanged, vis, this.globals);
    this.own(this.ws.activitiesChanged, () => this.scheduleTopology(), this.globals);
    this.own(this.ws.desktopsChanged, () => { this.watchDesktops(); this.scheduleTopology(); }, this.globals);
    this.own(this.ws.screensChanged, () => { this.watchOutputs(); this.scheduleTopology(); }, this.globals);
    this.own(this.ws.screenOrderChanged, () => this.scheduleTopology(), this.globals);
    this.own(this.ws.virtualScreenGeometryChanged, () => this.scheduleTopology(), this.globals);
    this.watchOutputs();
    this.watchDesktops();
    this.readAreas();
    const out: WindowSnapshot[] = [];
    const list = this.ws.windows;
    for (let i = 0; i < list.length; ++i) {
      const s = this.register(list[i]);
      if (s) out.push(s);
    }
    return out;
  }

  /** Disconnect everything owned; called after the engine stopped (invalidate first). */
  detach(): void {
    this.alive = false;
    for (const e of this.entries.values()) this.release(e);
    this.entries.clear();
    this.disconnectAll(this.globals);
    this.disconnectAll(this.outputConns);
    this.disconnectAll(this.desktopConns);
    this.areas.clear();
    this.pendingRefresh = [];
    this.engine = null;
    this.onDesktopNamesChanged = null;
  }

  connectionCount(): number {
    let n = this.globals.length + this.outputConns.length + this.desktopConns.length;
    for (const e of this.entries.values()) n += e.conns.length;
    return n;
  }

  windowCount(): number { return this.entries.size; }

  private own(signal: KSignal, fn: (...args: unknown[]) => void, into: Conn[]): Conn {
    signal.connect(fn);
    const c = { signal, fn };
    into.push(c);
    return c;
  }

  /** Disconnect one owned connection early (it stays owned until then). */
  private drop(c: Conn, from: Conn[]): void {
    const i = from.indexOf(c);
    if (i >= 0) from.splice(i, 1);
    try { c.signal.disconnect(c.fn); } catch (_e) { /* object already destroyed */ }
  }

  private disconnectAll(list: Conn[]): void {
    for (let i = list.length - 1; i >= 0; --i) {
      try { list[i].signal.disconnect(list[i].fn); } catch (_e) { /* object already destroyed */ }
    }
    list.length = 0;
  }

  private watchOutputs(): void {
    this.disconnectAll(this.outputConns);
    const outs = this.ws.screens;
    for (let i = 0; i < outs.length; ++i) this.own(outs[i].geometryChanged, () => this.scheduleTopology(), this.outputConns);
  }

  /** Desktop names feed configuration matchers; KWin's desktopsChanged does not cover a rename. */
  private watchDesktops(): void {
    this.disconnectAll(this.desktopConns);
    const ds = this.ws.desktops;
    const renamed = (): void => { if (this.alive && this.onDesktopNamesChanged) this.onDesktopNamesChanged(); };
    for (let i = 0; i < ds.length; ++i) if (ds[i].nameChanged) this.own(ds[i].nameChanged, renamed, this.desktopConns);
  }

  private queueDeferred(): void {
    if (this.deferredQueued || !this.alive) return;
    this.deferredQueued = true;
    this.qt.callLater(this.deferredFlush);
  }

  private scheduleTopology(): void {
    if (this.topologyPending || !this.alive) return;
    this.topologyPending = true;
    this.queueDeferred();
  }

  /**
   * Re-read every output's usable area and return the outputs whose area changed. The
   * desktop argument is passed for the API's sake: KWin 6.7.5 keeps one MaximizeArea per
   * output (observed source: workspace_wrapper.cpp:286-292 ignores it). Bounded: one
   * clientArea call per output, only on panel and topology events.
   */
  private readAreas(): string[] {
    const changed: string[] = [];
    const outs = this.ws.screens;
    for (let i = 0; i < outs.length; ++i) {
      const o = outs[i];
      const d = this.ws.currentDesktopForScreen(o) ?? (this.ws.desktops.length ? this.ws.desktops[0] : null);
      if (!d) continue;
      const a = rectOf(this.ws.clientArea(this.ws.MaximizeArea, o, d));
      const prev = this.areas.get(o.name);
      if (prev && sameRect(prev, a)) continue;
      this.areas.set(o.name, a);
      changed.push(o.name);
    }
    return changed;
  }

  /**
   * A panel (strut window) appeared, went away or changed its frame: the usable area may
   * have changed. There is no script-visible work-area signal, so compare the areas.
   * `now`: KWin already rearranged (a new strut window: Workspace::addWaylandWindow calls
   * rearrange() before windowAdded), so check synchronously; this marks the contexts dirty
   * before the flush that would otherwise write tiles KWin just moved off the panel back to
   * their old slots. Otherwise (and when nothing changed yet) look on the next two turns.
   */
  private panelChanged(now: boolean): void {
    if (!this.alive || !this.engine) return;
    if (now) {
      const changed = this.readAreas();
      if (changed.length > 0) { this.engine.workAreaChanged(changed); return; }
    }
    this.areaChecks = 2;
    this.queueDeferred();
  }

  // ------------------------------------------------------------------ registry
  private idOf(w: KWindow): string { return String(w.internalId); }

  private register(w: KWindow): WindowSnapshot | null {
    if (!w || w.deleted) return null;
    const id = this.idOf(w);
    if (this.entries.has(id)) return this.snapshot(this.entries.get(id)!);
    const gen = ++this.lastGen;
    const e: Entry = { w, id, gen, conns: [], meta: metaOf(w), hooked: false, caption: null, req: null };
    this.entries.set(id, e);
    if (e.meta.kind === "dock") {
      // Panels change the usable area; KWin has no script-visible work-area signal.
      this.own(w.frameGeometryChanged, () => this.panelChanged(false), e.conns);
    } else if (!PASSIVE_KINDS.has(e.meta.kind) && e.meta.kind !== "desktop") {
      this.hook(e);
    }
    return this.snapshot(e);
  }

  private hook(e: Entry): void {
    const w = e.w, id = e.id, gen = e.gen;
    e.hooked = true;
    const eng = () => (this.alive ? this.engine : null);
    this.own(w.frameGeometryChanged, () => {
      const g = eng();
      if (!g) return;
      const f = rectOf(w.frameGeometry);
      g.frameObserved(id, gen, f);
      const q = e.req;
      // The previous size still showing (a move applied before the resize) is not an answer.
      if (q === null || sameSize(f, q.from)) return;
      e.req = null;
      // Answered with a size other than the requested one: the client or KWin (X11 size
      // hints) applied a constraint Plastile may not know. Re-read once per request.
      if (!sameSize(f, q.to)) this.refreshConstraints(e);
    }, e.conns);
    const states = () => { const g = eng(); if (g) g.statesChanged(id, gen, statesOf(w)); };
    for (const s of [w.minimizedChanged, w.fullScreenChanged, w.maximizedChanged, w.moveResizedChanged,
                     w.interactiveMoveResizeStarted, w.interactiveMoveResizeFinished, w.hiddenChanged]) {
      this.own(s, states, e.conns);
    }
    const membership = () => { const g = eng(); if (g) g.membershipChanged(id, gen, membershipOf(w)); };
    for (const s of [w.outputChanged, w.desktopsChanged, w.activitiesChanged]) this.own(s, membership, e.conns);
    this.own(w.tileChanged, () => { const g = eng(); if (g) g.nativeTileChanged(id, gen, w.tile !== null); }, e.conns);
    const metadata = () => {
      const g = eng();
      if (!g) return;
      e.meta = metaOf(w);
      g.metadataChanged(id, gen, e.meta);
      g.constraintsChanged(id, gen, constraintsOf(w));
    };
    for (const s of [w.windowClassChanged, w.transientChanged, w.modalChanged]) this.own(s, metadata, e.conns);
    // minSize/maxSize have no NOTIFY signal. KWin emits maximizeableChanged whenever an
    // xdg-toplevel's min or max size changes (observed source: xdgshellwindow.cpp:1214-1226;
    // measured for Kate and the fixture in nested KWin 6.7.5), and for X11 clients when the
    // maximize action flips, e.g. on becoming fixed-size (x11window.cpp:1912, 3052).
    if (w.maximizeableChanged) this.own(w.maximizeableChanged, () => this.refreshConstraints(e), e.conns);
    // A decoration change alters the frame/client margin used for frame-space constraints.
    // It is current only at the clientGeometryChanged that follows decorationChanged
    // (measured order: decorationPolicyChanged, decorationChanged, clientGeometryChanged),
    // so that signal is watched once instead of on every resize.
    if (w.decorationChanged && w.clientGeometryChanged) {
      let margin: Conn | null = null;
      const settled = (): void => {
        if (margin) { this.drop(margin, e.conns); margin = null; }
        this.refreshConstraints(e);
      };
      this.own(w.decorationChanged, () => { if (!margin) margin = this.own(w.clientGeometryChanged, settled, e.conns); }, e.conns);
    }
    this.watchCaption(e, this.watchTitles);
  }

  /** Re-read constraints (only at the refresh points above). Deferred while a frame write is in progress. */
  private refreshConstraints(e: Entry): void {
    if (!this.alive || !this.engine || this.entries.get(e.id) !== e) return;
    if (this.writing) {
      if (this.pendingRefresh.indexOf(e) < 0) this.pendingRefresh.push(e);
      this.queueDeferred();
      return;
    }
    this.engine.constraintsChanged(e.id, e.gen, constraintsOf(e.w, e.meta.resizeable));
  }

  private watchCaption(e: Entry, on: boolean): void {
    if (on && !e.caption) e.caption = this.own(e.w.captionChanged, () => this.onCaption(e), e.conns);
    else if (!on && e.caption) { this.drop(e.caption, e.conns); e.caption = null; }
  }

  /** Title-only update: one property read; the engine re-evaluates only when title rules exist. */
  private onCaption(e: Entry): void {
    if (!this.alive || !this.engine || this.entries.get(e.id) !== e) return;
    const title = String(e.w.caption || "");
    if (title === e.meta.title) return;
    e.meta = Object.assign({}, e.meta, { title });
    this.engine.metadataChanged(e.id, e.gen, e.meta);
  }

  /**
   * Title rules were activated or removed by a configuration change. On activation the
   * current captions are read once (they may have changed while unwatched), before the
   * engine re-classifies with the new configuration.
   */
  setWatchTitles(on: boolean): void {
    if (on === this.watchTitles) return;
    this.watchTitles = on;
    for (const e of this.entries.values()) {
      if (!e.hooked) continue;
      this.watchCaption(e, on);
      if (on) this.onCaption(e);
    }
  }

  private release(e: Entry): void { this.disconnectAll(e.conns); }

  private snapshot(e: Entry): WindowSnapshot {
    const w = e.w;
    return {
      id: e.id, gen: e.gen, meta: e.meta, membership: membershipOf(w), states: statesOf(w),
      constraints: constraintsOf(w), frame: rectOf(w.frameGeometry), nativeTile: w.tile !== null,
    };
  }

  liveSnapshots(): WindowSnapshot[] {
    const out: WindowSnapshot[] = [];
    const list = this.ws.windows;
    for (let i = 0; i < list.length; ++i) {
      const w = list[i];
      if (!w || w.deleted) continue;
      const e = this.entries.get(this.idOf(w));
      out.push(e ? this.snapshot(e) : this.register(w)!);
    }
    return out;
  }

  private onAdded(w: KWindow): void {
    if (!this.alive || !this.engine) return;
    const s = this.register(w);
    if (!s) return;
    this.engine.windowAdded(s);
    if (s.meta.kind === "dock") this.panelChanged(true);
  }

  private onRemoved(w: KWindow): void {
    if (!w) return;
    const id = this.idOf(w);
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.release(e);
    e.caption = null;
    e.req = null;
    if (this.alive && this.engine) {
      this.engine.windowRemoved(id, e.gen);
      if (e.meta.kind === "dock") this.panelChanged(false);
    }
  }

  private onActivated(w: KWindow | null): void {
    if (!this.alive || !this.engine) return;
    this.engine.activeChanged(w ? this.idOf(w) : null);
  }

  private entry(id: string, gen: number): Entry | null {
    const e = this.entries.get(id);
    if (!e || e.gen !== gen || e.w.deleted) return null;
    return e;
  }

  private get(id: string, gen: number): KWindow | null {
    const e = this.entry(id, gen);
    return e ? e.w : null;
  }

  // ---------------------------------------------------------------- HostPort
  applyFrame(id: string, gen: number, t: Rect): FrameWrite | null {
    const e = this.entry(id, gen);
    if (!e) return null;
    const w = e.w;
    const before = rectOf(w.frameGeometry);
    e.req = sameSize(before, t) ? null
      : { from: { width: before.width, height: before.height }, to: { width: t.width, height: t.height } };
    this.writing = true;
    try {
      w.frameGeometry = this.qt.rect(t.x, t.y, t.width, t.height);
    } finally {
      this.writing = false;
    }
    return { before, after: rectOf(w.frameGeometry) };
  }

  frame(id: string, gen: number): Rect | null {
    const w = this.get(id, gen);
    return w ? rectOf(w.frameGeometry) : null;
  }

  activate(id: string, gen: number): boolean {
    const w = this.get(id, gen);
    if (!w) return false;
    this.ws.activeWindow = w;
    return true;
  }

  raise(id: string, gen: number): boolean {
    const w = this.get(id, gen);
    if (!w) return false;
    this.ws.raiseWindow(w);
    return true;
  }

  releaseNativeTile(id: string, gen: number): boolean {
    const w = this.get(id, gen);
    if (!w || w.tile === null) return false;
    return !!w.tile.unmanage(w);
  }

  setNoBorder(id: string, gen: number, v: boolean): boolean {
    const w = this.get(id, gen);
    if (!w) return false;
    w.noBorder = v;
    return true;
  }

  noBorder(id: string, gen: number): boolean | null {
    const w = this.get(id, gen);
    return w ? !!w.noBorder : null;
  }

  sendToOutput(id: string, gen: number, output: string): boolean {
    const w = this.get(id, gen);
    const o = this.outputByName(output);
    if (!w || !o) return false;
    this.ws.sendClientToScreen(w, o);
    return true;
  }

  sendToDesktop(id: string, gen: number, desktop: string): boolean {
    const w = this.get(id, gen);
    const d = this.desktopById(desktop);
    if (!w || !d) return false;
    w.desktops = [d];
    return true;
  }

  activeWindow(): string | null {
    const w = this.ws.activeWindow;
    return w ? this.idOf(w) : null;
  }

  activeOutput(): string | null {
    const o = this.ws.activeScreen;
    return o ? o.name : null;
  }

  outputs(): readonly OutputInfo[] {
    const out: OutputInfo[] = [];
    const s = this.ws.screens;
    for (let i = 0; i < s.length; ++i) {
      out.push({ id: s[i].name, name: s[i].name, geometry: rectOf(s[i].geometry), scale: s[i].devicePixelRatio });
    }
    // Deterministic topology order: left-to-right, then top-to-bottom (not enumeration index).
    out.sort((a, b) => a.geometry.x - b.geometry.x || a.geometry.y - b.geometry.y || (a.id < b.id ? -1 : 1));
    return out;
  }

  workArea(output: string, desktop: string): Rect | null {
    const o = this.outputByName(output);
    const d = this.desktopById(desktop);
    if (!o || !d) return null;
    return rectOf(this.ws.clientArea(this.ws.MaximizeArea, o, d));
  }

  visibleDesktop(output: string): string | null {
    const o = this.outputByName(output);
    if (!o) return null;
    const d = this.ws.currentDesktopForScreen(o);
    return d ? String(d.id) : null;
  }

  desktops(): readonly string[] {
    const out: string[] = [];
    const ds = this.ws.desktops;
    for (let i = 0; i < ds.length; ++i) out.push(String(ds[i].id));
    return out;
  }

  currentActivity(): string { return String(this.ws.currentActivity || "default"); }

  activityCount(): number { return this.ws.activities.length; }

  private outputByName(name: string): KOutput | null {
    const s = this.ws.screens;
    for (let i = 0; i < s.length; ++i) if (s[i].name === name) return s[i];
    return null;
  }

  private desktopById(id: string): KDesktop | null {
    const ds = this.ws.desktops;
    for (let i = 0; i < ds.length; ++i) if (String(ds[i].id) === id) return ds[i];
    return null;
  }

  /** Context names for configuration matching. */
  outputNameOf(id: string): string { return id; }
  desktopNameOf(id: string): string { return this.desktopById(id)?.name ?? ""; }
}
