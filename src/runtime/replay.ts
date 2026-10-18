// Replay recording (T10, T14): the engine's normalized event stream, captured at its ports in a
// live KWin session, for deterministic replay with a mock host (tests/core/replayHost.ts).
//
// Recording builds only: tools/replay/record.qml passes RuntimeEnv.record. The production root
// never creates a recorder, so the engine there talks to the adapter directly and pays nothing.
//
// Format (REPLAY_FORMAT), a tree in delivery order:
//  - an input node is one call into the engine: {k, t, a, q?, c?}. k is an engine event
//    (windowAdded, frameObserved, ...) or "start", "command", "reconcile", "config", "stop",
//    "turn" (a deferred callback the engine scheduled ran) or "fire" (its deadline expired);
//    t is the normalized clock at delivery (informational) and a the normalized arguments;
//  - c lists the host operations the engine made while handling it, in order: {h, a, r, n?}:
//    the method, its arguments, the host's result, and the inputs KWin delivered synchronously
//    inside the call (n: frameGeometryChanged inside a frame write, windowActivated inside an
//    activation). Arming the one-shot deadline is one of them ("deadline");
//  - q lists the query answers that changed while handling the node: [key, nth, value], where nth
//    counts the earlier queries of that key in the same node (0: the first). An answer equal to the
//    previous answer for its key is not recorded: the player answers from its memo.
//
// Normalization: window, output, desktop and activity ids become w1, o1, d1, a1 in order of first
// appearance (output connector names are kept: configuration matches them); the clock starts at
// NOW_BASE; process ids keep only their sign; titles are replaced by TITLE unless the recording
// asks for them. Formatting happens once, at export.

import type { Rect } from "../core/geometry.ts";
import type { Engine } from "../core/engine.ts";
import type { FrameWrite, HostPort, OutputInfo, RuntimeServices, WindowSnapshot } from "../core/ports.ts";
import type { Constraints, Membership, WindowMeta } from "../core/types.ts";
import type { EngineSink } from "../adapters/kwin/adapter.ts";

export const REPLAY_FORMAT = "plastile-replay/1";
/** Normalized clock value of the recorder's creation. */
export const NOW_BASE = 1000;
/** A recorded title when titles are redacted (an empty title stays empty). */
export const TITLE = "[title]";
const DEFAULT_CAPACITY = 200000;

export interface RecordOptions {
  /** Keep window titles (default: redacted). */
  readonly titles?: boolean;
  /** Nodes kept before the recording stops at an input boundary (marked truncated). */
  readonly capacity?: number;
}

export type QueryRecord = [string, number, unknown];

export interface InputNode {
  k: string;
  t: number;
  a: unknown[];
  q?: QueryRecord[];
  c?: CallNode[];
  err?: string;
}

export interface CallNode {
  h: string;
  a: unknown[];
  r: unknown;
  n?: InputNode[];
}

/** Context names for configuration matchers (main.ts ContextNames). */
interface Names {
  outputNameOf(key: string): string;
  desktopNameOf(id: string): string;
}

type Frame = { input: InputNode; asked: Map<string, number> } | { call: CallNode } | { query: string };

const SEP = "␟";

/** JSON with Infinity spelled out (unbounded maximum sizes); the player revives it. */
export function replayJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x === Infinity ? "Infinity" : x));
}

function rect(r: Rect): Rect {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Bijective renaming of one id space, in order of first appearance. */
class Names1 {
  readonly map = new Map<string, string>();
  private readonly prefix: string;
  constructor(prefix: string) { this.prefix = prefix; }
  of(id: string): string {
    let n = this.map.get(id);
    if (n === undefined) { n = this.prefix + (this.map.size + 1); this.map.set(id, n); }
    return n;
  }
}

export class ReplayRecorder {
  readonly events: InputNode[] = [];
  private readonly stack: Frame[] = [];
  private readonly memo = new Map<string, string>();
  private readonly wrapped = new Map<() => void, () => void>();
  private readonly win = new Names1("w");
  private readonly out = new Names1("o");
  private readonly desk = new Names1("d");
  private readonly act = new Names1("a");
  private readonly titles: boolean;
  private readonly capacity: number;
  private readonly t0: number;
  private nodes = 0;
  private on = true;
  truncated = false;
  /**
   * Not replayable, expected 0: inputs that arrived outside a host call while the engine was
   * running, and host operations made outside any recorded input.
   */
  anomalies = 0;
  config: unknown = null;
  private readonly svc: RuntimeServices;

  constructor(svc: RuntimeServices, opts: RecordOptions = {}) {
    this.svc = svc;
    this.titles = opts.titles === true;
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    this.t0 = svc.now();
  }

  // ------------------------------------------------------------- normalization
  private time(t: number): number { return t - this.t0 + NOW_BASE; }
  private w(id: string | null): string | null { return id === null ? null : this.win.of(id); }
  private o(id: string | null): string | null { return id === null ? null : this.out.of(id); }
  private d(id: string | null): string | null { return id === null ? null : this.desk.of(id); }
  private a(id: string): string { return id === "" || id === "default" ? id : this.act.of(id); }

  private meta(m: WindowMeta): WindowMeta {
    return Object.assign({}, m, {
      title: this.titles || m.title === "" ? m.title : TITLE,
      transientFor: this.w(m.transientFor),
      pid: m.pid > 0 ? 1 : m.pid,
    });
  }

  private membership(m: Membership): Membership {
    return { output: this.o(m.output), desktops: m.desktops.map((x) => this.d(x)!), onAllDesktops: m.onAllDesktops,
             activities: m.activities.map((x) => this.a(x)) };
  }

  private constraints(c: Constraints): Constraints {
    return { minFrame: { width: c.minFrame.width, height: c.minFrame.height },
             maxFrame: { width: c.maxFrame.width, height: c.maxFrame.height }, fixed: c.fixed };
  }

  private snap(s: WindowSnapshot): WindowSnapshot {
    return { id: this.w(s.id)!, gen: s.gen, meta: this.meta(s.meta), membership: this.membership(s.membership),
             states: Object.assign({}, s.states), constraints: this.constraints(s.constraints), frame: rect(s.frame),
             nativeTile: s.nativeTile };
  }

  private outputs(list: readonly OutputInfo[]): OutputInfo[] {
    return list.map((x) => {
      const o: OutputInfo = { id: this.o(x.id)!, name: x.name, geometry: rect(x.geometry), scale: x.scale };
      return x.identity === undefined ? o : Object.assign(o, { identity: x.identity });
    });
  }

  /** Any value from the engine's own state (explain, trace, context ids): known ids renamed. */
  private deep(v: unknown): unknown {
    if (typeof v === "string") return this.str(v);
    if (Array.isArray(v)) return v.map((x) => this.deep(x));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object)) out[this.str(k)] = this.deep((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  }

  private str(s: string): string {
    for (const m of [this.win.map, this.out.map, this.desk.map, this.act.map]) {
      const n = m.get(s);
      if (n !== undefined) return n;
    }
    if (s.indexOf(SEP) >= 0) return s.split(SEP).map((p) => this.str(p)).join(SEP);
    // Window ids inside messages (overflow notes name the window).
    let r = s;
    this.win.map.forEach((n, id) => { if (id.length >= 8 && r.indexOf(id) >= 0) r = r.split(id).join(n); });
    return r;
  }

  // ------------------------------------------------------------------ recording
  private top(): Frame | undefined { return this.stack[this.stack.length - 1]; }

  /** One call into the engine. Only a top-level input or one KWin delivers inside a host call is recordable. */
  private input<T>(k: string, a: () => unknown[], fn: () => T): T {
    if (!this.on) return fn();
    const top = this.top();
    let into: InputNode[];
    if (top === undefined) {
      if (this.nodes >= this.capacity) { this.on = false; this.truncated = true; return fn(); }
      into = this.events;
    } else if ("call" in top) {
      into = top.call.n || (top.call.n = []);
    } else {
      this.anomalies++;
      return fn();
    }
    const node: InputNode = { k, t: this.time(this.svc.now()), a: a() };
    into.push(node);
    this.nodes++;
    this.stack.push({ input: node, asked: new Map() });
    try {
      return fn();
    } catch (e) {
      node.err = String(e);
      throw e;
    } finally {
      this.stack.pop();
    }
  }

  /** A host operation (a mutation or the deadline): recorded in order, with its result and nested inputs. */
  private call<T>(h: string, a: unknown[], fn: () => T, res: (v: T) => unknown): T {
    const top = this.top();
    if (!this.on || top === undefined || !("input" in top)) {
      // Also outside any input: an engine entry point the runtime does not route through the
      // recorder would otherwise mutate the host unrecorded and the replay diverge unexplained.
      if (this.on) this.anomalies++;
      return fn();
    }
    const node: CallNode = { h, a, r: null };
    (top.input.c || (top.input.c = [])).push(node);
    this.nodes++;
    this.stack.push({ call: node });
    try {
      const v = fn();
      node.r = res(v);
      return v;
    } finally {
      this.stack.pop();
    }
  }

  /** A read: recorded only when its answer differs from the last recorded answer for the same key. */
  private query<T>(key: () => string, fn: () => T, norm: (v: T) => unknown): T {
    const top = this.top();
    if (!this.on || top === undefined || !("input" in top)) return fn();
    this.stack.push({ query: "" });
    let v: T;
    try { v = fn(); } finally { this.stack.pop(); }
    const k = key(), n = norm(v), s = replayJson(n);
    const nth = top.asked.get(k) || 0;
    top.asked.set(k, nth + 1);
    if (this.memo.get(k) !== s) {
      this.memo.set(k, s);
      (top.input.q || (top.input.q = [])).push([k, nth, n]);
    }
    return v;
  }

  /** A stable wrapper per callback (Qt.callLater coalesces by identity) that records when it runs. */
  private wrap(fn: () => void, kind: "turn" | "fire"): () => void {
    let w = this.wrapped.get(fn);
    if (!w) {
      const id = this.wrapped.size + 1;
      w = () => this.input(kind, () => [id], fn);
      this.wrapped.set(fn, w);
    }
    return w;
  }

  // ------------------------------------------------------------------- the ports
  services(svc: RuntimeServices): RuntimeServices {
    return {
      now: () => this.query(() => "now", () => svc.now(), (t) => this.time(t)),
      callLater: (fn) => svc.callLater(this.wrap(fn, "turn")),
      deadline: (ms, fn) => this.call("deadline", [ms], () => svc.deadline(ms, this.wrap(fn, "fire")), () => null),
      log: (level, message, data) => svc.log(level, message, data),
    };
  }

  host(h: HostPort): HostPort {
    const fw = (r: FrameWrite | null) => (r ? { before: rect(r.before), after: rect(r.after) } : null);
    const same = (v: unknown) => v;
    return {
      applyFrame: (id, gen, t) => this.call("applyFrame", [this.w(id), gen, rect(t)], () => h.applyFrame(id, gen, t), fw),
      frame: (id, gen) => this.query(() => `frame|${this.w(id)}|${gen}`, () => h.frame(id, gen), (r) => (r ? rect(r) : null)),
      activate: (id, gen) => this.call("activate", [this.w(id), gen], () => h.activate(id, gen), same),
      raise: (id, gen) => this.call("raise", [this.w(id), gen], () => h.raise(id, gen), same),
      releaseNativeTile: (id, gen) => this.call("releaseNativeTile", [this.w(id), gen], () => h.releaseNativeTile(id, gen), same),
      setNoBorder: (id, gen, v) => this.call("setNoBorder", [this.w(id), gen, v], () => h.setNoBorder(id, gen, v), same),
      noBorder: (id, gen) => this.query(() => `noBorder|${this.w(id)}|${gen}`, () => h.noBorder(id, gen), same),
      sendToOutput: (id, gen, o) => this.call("sendToOutput", [this.w(id), gen, this.o(o)], () => h.sendToOutput(id, gen, o), same),
      sendToDesktop: (id, gen, d) => this.call("sendToDesktop", [this.w(id), gen, this.d(d)], () => h.sendToDesktop(id, gen, d), same),
      showDesktop: (o, d) => this.call("showDesktop", [this.o(o), this.d(d)], () => h.showDesktop(o, d), same),
      activeWindow: () => this.query(() => "activeWindow", () => h.activeWindow(), (v) => this.w(v)),
      activeOutput: () => this.query(() => "activeOutput", () => h.activeOutput(), (v) => this.o(v)),
      outputs: () => this.query(() => "outputs", () => h.outputs(), (v) => this.outputs(v)),
      workArea: (o, d) => this.query(() => `workArea|${this.o(o)}|${this.d(d)}`, () => h.workArea(o, d), (r) => (r ? rect(r) : null)),
      visibleDesktop: (o) => this.query(() => `visibleDesktop|${this.o(o)}`, () => h.visibleDesktop(o), (v) => this.d(v)),
      desktops: () => this.query(() => "desktops", () => h.desktops(), (v) => v.map((x) => this.d(x)!)),
      currentActivity: () => this.query(() => "currentActivity", () => h.currentActivity(), (v) => this.a(v)),
      activityCount: () => this.query(() => "activityCount", () => h.activityCount(), same),
    };
  }

  /** Context names read by configuration resolution (engine options). */
  names(n: Names): Names {
    return {
      outputNameOf: (k) => this.query(() => `outputName|${this.o(k)}`, () => n.outputNameOf(k), (v) => v),
      desktopNameOf: (id) => this.query(() => `desktopName|${this.d(id)}`, () => n.desktopNameOf(id), (v) => v),
    };
  }

  /** The events the adapter delivers, recorded before they reach the engine. */
  sink(e: EngineSink): EngineSink {
    return {
      windowAdded: (s) => this.input("windowAdded", () => [this.snap(s)], () => e.windowAdded(s)),
      windowRemoved: (id, gen) => this.input("windowRemoved", () => [this.w(id), gen], () => e.windowRemoved(id, gen)),
      metadataChanged: (id, gen, m) => this.input("metadataChanged", () => [this.w(id), gen, this.meta(m)], () => e.metadataChanged(id, gen, m)),
      membershipChanged: (id, gen, m) =>
        this.input("membershipChanged", () => [this.w(id), gen, this.membership(m)], () => e.membershipChanged(id, gen, m)),
      statesChanged: (id, gen, st) => this.input("statesChanged", () => [this.w(id), gen, Object.assign({}, st)], () => e.statesChanged(id, gen, st)),
      constraintsChanged: (id, gen, c) =>
        this.input("constraintsChanged", () => [this.w(id), gen, this.constraints(c)], () => e.constraintsChanged(id, gen, c)),
      nativeTileChanged: (id, gen, v) => this.input("nativeTileChanged", () => [this.w(id), gen, v], () => e.nativeTileChanged(id, gen, v)),
      frameObserved: (id, gen, f) => this.input("frameObserved", () => [this.w(id), gen, rect(f)], () => e.frameObserved(id, gen, f)),
      activeChanged: (id) => this.input("activeChanged", () => [this.w(id)], () => e.activeChanged(id)),
      visibilityChanged: () => this.input("visibilityChanged", () => [], () => e.visibilityChanged()),
      topologyChanged: () => this.input("topologyChanged", () => [], () => e.topologyChanged()),
      outputsRekeyed: (m) => this.input("outputsRekeyed", () => {
        const pairs: Array<[string, string]> = [];
        m.forEach((to, from) => pairs.push([this.o(from)!, this.o(to)!]));
        return [pairs];
      }, () => e.outputsRekeyed(m)),
      workAreaChanged: (outs) => this.input("workAreaChanged", () => [outs.map((x) => this.o(x)!)], () => e.workAreaChanged(outs)),
    };
  }

  // -------------------------------------------------------- runtime-level inputs
  start(initial: readonly WindowSnapshot[], fn: () => void): void {
    this.input("start", () => [initial.map((s) => this.snap(s))], fn);
  }

  command<T>(id: string, fn: () => T): T { return this.input("command", () => [id], fn); }

  reconcile(live: readonly WindowSnapshot[], fn: () => void): void {
    this.input("reconcile", () => [live.map((s) => this.snap(s))], fn);
  }

  /** A configuration activation (flat: the compiled kwinrc keys) or a re-resolve of the same one (null). */
  configure(flat: unknown, fn: () => void): void { this.input("config", () => [flat], fn); }

  /**
   * Stop the engine as the last input and export the recording: the stream, the writes it
   * contains, and the engine's own final model (before stop), counters and trace (after stop) as
   * expectations for the player. `ids` maps the real window ids to their recorded names for the
   * capture tool, which joins its own oracle with them and drops the map.
   */
  finish(engine: Engine, stop: () => void): string {
    const model = this.on ? modelSnapshot(engine, Array.from(this.win.map.keys())) : null;
    this.input("stop", () => [], stop);
    const ids: Record<string, string> = {};
    this.win.map.forEach((n, id) => { ids[id] = n; });
    return replayJson({
      format: REPLAY_FORMAT, titles: this.titles ? "kept" : "redacted", truncated: this.truncated, anomalies: this.anomalies,
      nodes: this.nodes, config: this.config, events: this.events, writes: writesOf(this.events),
      expect: {
        model: model === null ? null : this.deep(model),
        counters: Object.assign({}, engine.counters),
        trace: engine.trace.snapshot().map((r) => this.deep(Object.assign({}, r, { t: this.time(r.t) }))),
      },
      ids,
    });
  }
}

/** The engine's final model: every known window's explanation and every context's members, in order. */
export function modelSnapshot(engine: Engine, windows: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of windows) {
    const x = engine.explain(id);
    if (x !== null) out[id] = x;
  }
  const contexts = engine.contextSummary().map((c) => {
    const [output, desktop, activity] = c.id.split(SEP);
    return Object.assign({}, c, { order: engine.membersOf({ output, desktop, activity }) });
  });
  return { windows: out, contexts };
}

/** Frame writes in a stream, in issue order. */
export function writesOf(events: readonly InputNode[]): Array<{ id: unknown; gen: unknown; target: unknown }> {
  const out: Array<{ id: unknown; gen: unknown; target: unknown }> = [];
  const visit = (n: InputNode): void => {
    for (const c of n.c || []) {
      if (c.h === "applyFrame") out.push({ id: c.a[0], gen: c.a[1], target: c.a[2] });
      for (const x of c.n || []) visit(x);
    }
  };
  for (const e of events) visit(e);
  return out;
}
