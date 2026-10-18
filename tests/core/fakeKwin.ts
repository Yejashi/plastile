// A fake KWin declarative-script surface for driving the real KwinAdapter and runtime
// in Node. It models only what the adapter reads and connects to (kwinTypes.ts), plus
// the KWin 6.7.5 behaviours the adapter tests depend on:
//  - signals are synchronous; a script's frameGeometry write applies synchronously and
//    emits frameGeometryChanged inside the setter (no client delay is modelled here);
//  - MaximizeArea is per output: the desktop argument of clientArea is ignored
//    (observed source: kwin v6.7.5 src/scripting/workspace_wrapper.cpp:286-292);
//  - Qt.callLater runs queued functions on the next turn, deduplicated by identity.
// Oracles in tests are this fake's window frames and script write log.

export class Sig {
  fns: Array<(...a: unknown[]) => void> = [];
  connect(fn: (...a: unknown[]) => void): void { this.fns.push(fn); }
  disconnect(fn: (...a: unknown[]) => void): void {
    const i = this.fns.indexOf(fn);
    if (i >= 0) this.fns.splice(i, 1);
  }
  emit(...a: unknown[]): void { for (const f of [...this.fns]) f(...a); }
}

export interface R { x: number; y: number; width: number; height: number }

export interface FakeDesktop { id: string; name: string; x11DesktopNumber: number; nameChanged: Sig }

export function desktop(name: string, n = 1): FakeDesktop {
  return { id: "desk-" + name, name, x11DesktopNumber: n, nameChanged: new Sig() };
}

export interface FakeOutput { name: string; geometry: R; devicePixelRatio: number; manufacturer: string; model: string;
  serialNumber: string; geometryChanged: Sig }

export function output(name: string, g: R): FakeOutput {
  return { name, geometry: g, devicePixelRatio: 1, manufacturer: "", model: "", serialNumber: "", geometryChanged: new Sig() };
}

const WINDOW_SIGNALS = ["frameGeometryChanged", "clientGeometryChanged", "minimizedChanged", "fullScreenChanged",
  "maximizedChanged", "moveResizedChanged", "interactiveMoveResizeStarted", "interactiveMoveResizeFinished", "outputChanged",
  "desktopsChanged", "activitiesChanged", "tileChanged", "captionChanged", "windowClassChanged", "transientChanged",
  "hiddenChanged", "modalChanged", "maximizeableChanged", "decorationChanged", "decorationPolicyChanged"] as const;

let uid = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FakeWindow = any;

/** Decoration margins of a server-side decorated window: title bar on top only. */
export const TITLEBAR = 30;

export class FakeWorkspace {
  windows: FakeWindow[] = [];
  screens: FakeOutput[];
  desktops: FakeDesktop[];
  activities: string[] = [""];
  currentActivity = "";
  activeWindow: FakeWindow = null;
  activeScreen: FakeOutput;
  MaximizeArea = 2;
  /** Per-output usable area; the output geometry when absent. */
  areas = new Map<string, R>();
  current = new Map<string, FakeDesktop>();
  /** Script frame writes, in order (the adapter is the only script writer). */
  writes: Array<{ caption: string; rect: R }> = [];
  clientAreaCalls = 0;
  windowAdded = new Sig(); windowRemoved = new Sig(); windowActivated = new Sig();
  currentDesktopChanged = new Sig(); currentActivityChanged = new Sig(); activitiesChanged = new Sig();
  screensChanged = new Sig(); screenOrderChanged = new Sig(); desktopsChanged = new Sig();
  virtualScreenGeometryChanged = new Sig();

  constructor(screens: FakeOutput[], desktops: FakeDesktop[]) {
    this.screens = screens;
    this.desktops = desktops;
    this.activeScreen = screens[0];
    for (const s of screens) this.current.set(s.name, desktops[0]);
  }

  currentDesktopForScreen(o: FakeOutput): FakeDesktop | null { return this.current.get(o.name) ?? null; }
  clientArea(_opt: number, o: FakeOutput, _d: FakeDesktop): R {
    this.clientAreaCalls++;
    const a = this.areas.get(o.name) ?? o.geometry;
    return { ...a };
  }
  raiseWindow(_w: FakeWindow): void { /* stacking is not modelled */ }
  sendClientToScreen(w: FakeWindow, o: FakeOutput): void { w.output = o; w.outputChanged.emit(); }

  /** A new window mapped by a client. */
  add(w: FakeWindow): void { this.windows.push(w); this.windowAdded.emit(w); }
  remove(w: FakeWindow): void {
    this.windows = this.windows.filter((x) => x !== w);
    w.deleted = true;
    this.windowRemoved.emit(w);
  }

  /** KWin itself moves/resizes a window (e.g. checkWorkspacePosition): not a script write. */
  kwinSetFrame(w: FakeWindow, r: R): void { w._setFrame(r, false); }

  /** Make a toplevel. `ssd` adds a TITLEBAR px server-side title bar (frame = client + margin). */
  window(o: Record<string, unknown> = {}, ssd = true): FakeWindow {
    const frame: R = (o.frameGeometry as R) ?? { x: 10, y: 10, width: 400, height: 300 };
    const w: FakeWindow = {
      internalId: "{" + (++uid) + "}", caption: "win", resourceClass: "app", resourceName: "app", windowRole: "",
      desktopFileName: "app", pid: 1, normalWindow: true, dialog: false, utility: false, toolbar: false, menu: false,
      dropdownMenu: false, popupMenu: false, comboBox: false, splash: false, dock: false, desktopWindow: false,
      notification: false, criticalNotification: false, tooltip: false, onScreenDisplay: false, appletPopup: false,
      dndIcon: false, popupWindow: false, specialWindow: false, managed: true, deleted: false, transient: false,
      transientFor: null, modal: false, resizeable: true, moveable: true, skipTaskbar: false,
      output: this.screens[0], desktops: [this.desktops[0]], onAllDesktops: false, activities: [],
      minimized: false, fullScreen: false, maximizeMode: 0, move: false, resize: false, hidden: false,
      minSize: { width: 0, height: 0 }, maxSize: { width: 2147483647, height: 2147483647 }, tile: null,
      ...o,
    };
    for (const s of WINDOW_SIGNALS) w[s] = new Sig();
    let fg: R = { ...frame };
    let margin = o.noBorder === true || !ssd ? 0 : TITLEBAR;
    let noBorder = !!o.noBorder;
    const ws = this;
    w._setFrame = (r: R, script: boolean) => {
      if (script) ws.writes.push({ caption: String(w.caption), rect: { ...r } });
      // X11-style synchronous constraint (KWin's constrainClientSize) with hints the script cannot see yet.
      const c = w._clamp as { width: number; height: number } | undefined;
      if (script && c) r = { ...r, width: Math.max(r.width, c.width), height: Math.max(r.height, c.height + margin) };
      const changed = r.x !== fg.x || r.y !== fg.y || r.width !== fg.width || r.height !== fg.height;
      fg = { x: r.x, y: r.y, width: r.width, height: r.height };
      if (changed) { w.clientGeometryChanged.emit(); w.frameGeometryChanged.emit(); }
    };
    /** Decoration toggled by KWin: policy signal first, then the decoration, then the new client geometry (measured order). */
    w._setDecorated = (on: boolean) => {
      w.decorationPolicyChanged.emit();
      w.decorationChanged.emit();
      margin = on ? TITLEBAR : 0;
      w.clientGeometryChanged.emit();
    };
    Object.defineProperty(w, "frameGeometry", { get: () => ({ ...fg }), set: (r: R) => w._setFrame(r, true) });
    Object.defineProperty(w, "clientGeometry", {
      get: () => ({ x: fg.x, y: fg.y + margin, width: fg.width, height: fg.height - margin }),
    });
    Object.defineProperty(w, "noBorder", {
      get: () => noBorder,
      set: (v: boolean) => { if (v === noBorder) return; noBorder = v; w._setDecorated(!v); },
    });
    return w;
  }

  /** A layer-shell panel (KWin reports dock=true, normalWindow=false). */
  panel(o: Record<string, unknown> = {}): FakeWindow {
    return this.window({ dock: true, normalWindow: false, caption: "", resizeable: false, ...o }, false);
  }
}

export class FakeQt {
  later: Array<() => void> = [];
  rect(x: number, y: number, width: number, height: number): R { return { x, y, width, height }; }
  callLater(fn: () => void): void { if (!this.later.includes(fn)) this.later.push(fn); }
  /** Run one event-loop turn: the functions queued before it started. Returns how many ran. */
  turn(): number {
    const f = this.later;
    this.later = [];
    for (const x of f) x();
    return f.length;
  }
  drain(): number {
    let n = 0;
    while (this.later.length && n < 1000) n += this.turn();
    return n;
  }
}

export interface FakeEnv {
  ws: FakeWorkspace;
  qt: FakeQt;
  cfg: Record<string, unknown>;
  configChanged: Sig;
  lines: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env: any;
}

/** A RuntimeEnv over the fake workspace; `cfg` is what KWin.readConfig returns. */
export function fakeEnv(ws: FakeWorkspace, qt: FakeQt, cfg: Record<string, unknown> = {}): FakeEnv {
  const configChanged = new Sig();
  const lines: string[] = [];
  const env = {
    workspace: ws, qt, options: { configChanged },
    kwin: { readConfig: (k: string, d: unknown) => (k in cfg ? cfg[k] : d) },
    setDeadline: () => {}, clearDeadline: () => {}, print: (l: string) => { lines.push(l); },
  };
  return { ws, qt, cfg, configChanged, lines, env };
}
