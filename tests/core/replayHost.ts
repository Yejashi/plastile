// Replay player for recorded event streams (T10, T14; format in src/runtime/replay.ts).
//
// A mock host that answers the engine from a recording instead of simulating a compositor:
//  - inputs are delivered to the engine in recorded order, nested where KWin nested them;
//  - every host operation the engine makes (frame writes, activation, the deadline, ...) must
//    be the next one recorded for that input, with the same arguments; it returns the recorded
//    result after delivering the inputs KWin emitted inside it. Anything else is a Divergence;
//  - queries (clock, outputs, work areas, frames, ...) are answered from a memo that the recorded
//    answer changes update at the query (the nth of its key in that input) where they were seen;
//  - deferred callbacks and the deadline run only where the recording says they ran.
// The engine is the real one, built from the recorded configuration exactly as the runtime does
// (src/runtime/main.ts engineOptions and diffConfig).

import { readFileSync } from "node:fs";
import type { Rect } from "../../src/core/geometry.ts";
import type { FrameWrite, HostPort, OutputInfo, RuntimeServices, WindowSnapshot } from "../../src/core/ports.ts";
import type { Membership, WindowMeta } from "../../src/core/types.ts";
import { Engine } from "../../src/core/engine.ts";
import { compileConfig, type ConfigSnapshot } from "../../src/config/index.ts";
import { diffConfig } from "../../src/config/diff.ts";
import { engineOptions } from "../../src/runtime/main.ts";
import { modelSnapshot, REPLAY_FORMAT, replayJson, type CallNode, type InputNode } from "../../src/runtime/replay.ts";

export interface ReplayFixture {
  format: string;
  name?: string;
  description?: string;
  captured?: Record<string, unknown>;
  titles: string;
  truncated: boolean;
  anomalies: number;
  nodes: number;
  config: Record<string, unknown>;
  events: InputNode[];
  writes: Array<{ id: string; gen: number; target: Rect }>;
  expect: { model: Record<string, unknown> | null; counters: Record<string, number>; trace: unknown[] };
  /** KWin's own frames at the end of the capture (the independent oracle), by recorded window id. */
  oracle?: Record<string, { fixture: number; frame: Rect }>;
}

const revive = (_k: string, v: unknown): unknown => (v === "Infinity" ? Infinity : v);

/** A value as it reads back from a recording (JSON with Infinity, see replayJson). */
export function recorded<T>(v: T): T { return JSON.parse(replayJson(v), revive) as T; }

/** Parse a recording: "Infinity" (unbounded sizes) becomes Infinity again. */
export function parseReplay(text: string): ReplayFixture {
  const f = JSON.parse(text, revive) as ReplayFixture;
  if (f.format !== REPLAY_FORMAT) throw new Error(`not a ${REPLAY_FORMAT} recording: ${String(f.format)}`);
  return f;
}

export function loadReplay(path: string | URL): ReplayFixture {
  return parseReplay(readFileSync(path, "utf8"));
}

export class Divergence extends Error {
  override name = "Divergence";
}

interface Scope {
  node: InputNode;
  path: string;
  /** Recorded host operations consumed so far. */
  done: number;
  /** Recorded query answers applied so far (by index into node.q). */
  applied: boolean[];
  /** Queries asked so far in this input, per key. */
  asked: Map<string, number>;
}

/** A write the replayed engine issued, with the recorded input it happened under. */
export interface ReplayWrite {
  id: string;
  gen: number;
  target: Rect;
  path: string;
  t: number;
  /** The outputs as last reported to the engine when it issued the write. */
  outputs: readonly OutputInfo[];
}

export interface ReplayOptions {
  /** Called after every top-level input with the engine and the input (fixture-specific checks). */
  after?: (node: InputNode, index: number, host: ReplayHost) => void;
}

export class ReplayHost implements HostPort, RuntimeServices {
  readonly fixture: ReplayFixture;
  engine!: Engine;
  readonly writes: ReplayWrite[] = [];
  /** Model invariant violations (engine.check) after any top-level input, with the input's path. */
  readonly violations: string[] = [];
  /** The last frame each window reported (snapshots and frame observations), by recorded id. */
  readonly frames = new Map<string, Rect>();
  /** Generation of each window at its removal. */
  readonly removed = new Map<string, number>();
  /** Model just before the stop input (null when the recording has none). */
  model: Record<string, unknown> | null = null;
  private memo = new Map<string, unknown>();
  private scopes: Scope[] = [];
  private fnIds = new Map<() => void, number>();
  private pending = new Map<number, () => void>();
  private timer: { id: number; fn: () => void } | null = null;
  private snapshot: ConfigSnapshot | null = null;
  private revision = 0;
  private opts: ReplayOptions;

  constructor(fixture: ReplayFixture, opts: ReplayOptions = {}) {
    this.fixture = fixture;
    this.opts = opts;
  }

  /** Replay the whole recording. Throws Divergence at the first host operation that differs. */
  run(): this {
    this.snapshot = this.compile(this.fixture.config);
    this.engine = new Engine(this, this, this.options(this.snapshot));
    this.fixture.events.forEach((n, i) => {
      if (n.k === "stop") this.model = recorded(modelSnapshot(this.engine, this.windowIds()));
      this.deliver(n, `#${i}`);
      const errs = this.engine.isAlive() ? this.engine.check() : [];
      for (const e of errs) this.violations.push(`#${i} ${n.k}: ${e}`);
      if (this.opts.after) this.opts.after(n, i, this);
    });
    return this;
  }

  /** Every window id the recording names, in order of first appearance. */
  windowIds(): string[] {
    const seen = new Set<string>();
    const visit = (n: InputNode): void => {
      if (n.k === "start" || n.k === "reconcile") for (const s of n.a[0] as WindowSnapshot[]) seen.add(s.id);
      else if (n.k === "windowAdded") seen.add((n.a[0] as WindowSnapshot).id);
      for (const c of n.c || []) for (const x of c.n || []) visit(x);
    };
    for (const n of this.fixture.events) visit(n);
    return [...seen];
  }

  // ------------------------------------------------------------------- delivery
  private compile(flat: Record<string, unknown>): ConfigSnapshot {
    const r = compileConfig(flat, ++this.revision);
    if (r.ok) return r.snapshot;
    // The runtime keeps the defaults when the first configuration is rejected (main.ts loadConfig).
    const d = compileConfig({}, this.revision);
    if (!d.ok) throw new Error("default configuration rejected");
    return d.snapshot;
  }

  private options(snap: ConfigSnapshot) {
    return engineOptions(snap, {
      outputNameOf: (k) => this.answer(`outputName|${k}`) as string,
      desktopNameOf: (id) => this.answer(`desktopName|${id}`) as string,
    });
  }

  private deliver(node: InputNode, path: string): void {
    const scope: Scope = { node, path, done: 0, applied: (node.q || []).map(() => false), asked: new Map() };
    this.scopes.push(scope);
    try {
      this.dispatch(node, path);
    } finally {
      this.scopes.pop();
    }
    const calls = node.c ? node.c.length : 0;
    if (scope.done !== calls) {
      throw new Divergence(`${path} ${node.k}: the engine made ${scope.done} host operations, the recording ${calls}; ` +
        `next recorded: ${replayJson(node.c![scope.done])}`);
    }
    // Answers the replayed engine did not ask for still describe the host from here on.
    (node.q || []).forEach((q, i) => { if (!scope.applied[i]) this.memo.set(q[0], q[2]); });
  }

  private dispatch(node: InputNode, path: string): void {
    const e = this.engine, a = node.a;
    const id = a[0] as string, gen = a[1] as number;
    switch (node.k) {
      case "start": {
        const ss = a[0] as WindowSnapshot[];
        for (const s of ss) this.frames.set(s.id, s.frame);
        e.start(ss);
        return;
      }
      case "reconcile": {
        const ss = a[0] as WindowSnapshot[];
        for (const s of ss) this.frames.set(s.id, s.frame);
        e.reconcile(ss);
        return;
      }
      case "windowAdded": {
        const s = a[0] as WindowSnapshot;
        this.frames.set(s.id, s.frame);
        e.windowAdded(s);
        return;
      }
      case "windowRemoved": this.removed.set(id, gen); e.windowRemoved(id, gen); return;
      case "metadataChanged": e.metadataChanged(id, gen, a[2] as WindowMeta); return;
      case "membershipChanged": e.membershipChanged(id, gen, a[2] as Membership); return;
      case "statesChanged": e.statesChanged(id, gen, a[2] as never); return;
      case "constraintsChanged": e.constraintsChanged(id, gen, a[2] as never); return;
      case "nativeTileChanged": e.nativeTileChanged(id, gen, a[2] as boolean); return;
      case "frameObserved": this.frames.set(id, a[2] as Rect); e.frameObserved(id, gen, a[2] as Rect); return;
      case "activeChanged": e.activeChanged(a[0] as string | null); return;
      case "visibilityChanged": e.visibilityChanged(); return;
      case "topologyChanged": e.topologyChanged(); return;
      case "outputsRekeyed": e.outputsRekeyed(new Map(a[0] as Array<[string, string]>)); return;
      case "workAreaChanged": e.workAreaChanged(a[0] as string[]); return;
      case "command": e.execute(a[0] as string); return;
      case "config": {
        const flat = a[0] as Record<string, unknown> | null;
        if (flat === null) { e.configure(this.options(this.snapshot!)); return; }
        const prev = this.snapshot;
        this.snapshot = this.compile(flat);
        const d = diffConfig(prev, this.snapshot);
        e.configure({ ...this.options(this.snapshot), changes: { rules: d.rules, settings: d.settings } });
        return;
      }
      case "stop": e.stop(); return;
      case "turn": {
        const fn = this.pending.get(a[0] as number);
        if (!fn) throw new Divergence(`${path} turn: callback ${String(a[0])} ran in KWin but the engine did not schedule it`);
        this.pending.delete(a[0] as number);
        fn();
        return;
      }
      case "fire": {
        const t = this.timer;
        if (!t || t.id !== a[0]) throw new Divergence(`${path} fire: the deadline expired in KWin but the engine has none armed`);
        this.timer = null;
        t.fn();
        return;
      }
      default: throw new Error(`${path}: unknown input kind ${node.k}`);
    }
  }

  /** The next recorded host operation of the current input; it must be this one. */
  private op(h: string, args: unknown[]): unknown {
    const s = this.scopes[this.scopes.length - 1];
    if (!s) throw new Divergence(`${h} outside any recorded input`);
    const rec: CallNode | undefined = s.node.c ? s.node.c[s.done] : undefined;
    const got = replayJson(args);
    if (!rec || rec.h !== h || replayJson(rec.a) !== got) {
      throw new Divergence(`${s.path} ${s.node.k}: host operation ${s.done + 1} was ${h}${got}, ` +
        `the recording has ${rec ? rec.h + replayJson(rec.a) : "none"}`);
    }
    s.done++;
    (rec.n || []).forEach((n, i) => this.deliver(n, `${s.path}.${s.done}.${i}`));
    return rec.r;
  }

  /** A query: the recorded answer change for this occurrence of the key in the current input, else the memo. */
  private answer(key: string): unknown {
    const s = this.scopes[this.scopes.length - 1];
    if (s) {
      const nth = s.asked.get(key) || 0;
      s.asked.set(key, nth + 1);
      (s.node.q || []).forEach((q, i) => {
        if (!s.applied[i] && q[0] === key && q[1] <= nth) { s.applied[i] = true; this.memo.set(key, q[2]); }
      });
    }
    return this.memo.get(key);
  }

  // ---------------------------------------------------------------- services
  now(): number { return this.answer("now") as number; }
  callLater(fn: () => void): void {
    let id = this.fnIds.get(fn);
    if (id === undefined) { id = this.fnIds.size + 1; this.fnIds.set(fn, id); }
    this.pending.set(id, fn);
  }
  deadline(ms: number, fn: () => void): () => void {
    this.op("deadline", [ms]);
    let id = this.fnIds.get(fn);
    if (id === undefined) { id = this.fnIds.size + 1; this.fnIds.set(fn, id); }
    const t = { id, fn };
    this.timer = t;
    return () => { if (this.timer === t) this.timer = null; };
  }
  log(): void { /* not recorded */ }

  // -------------------------------------------------------------------- host
  applyFrame(id: string, gen: number, target: Rect): FrameWrite | null {
    const s = this.scopes[this.scopes.length - 1];
    this.writes.push({ id, gen, target: { x: target.x, y: target.y, width: target.width, height: target.height },
                       path: s ? s.path : "", t: s ? s.node.t : 0, outputs: this.knownOutputs() });
    return this.op("applyFrame", [id, gen, { x: target.x, y: target.y, width: target.width, height: target.height }]) as FrameWrite | null;
  }
  frame(id: string, gen: number): Rect | null { return this.answer(`frame|${id}|${gen}`) as Rect | null; }
  activate(id: string, gen: number): boolean { return this.op("activate", [id, gen]) as boolean; }
  raise(id: string, gen: number): boolean { return this.op("raise", [id, gen]) as boolean; }
  releaseNativeTile(id: string, gen: number): boolean { return this.op("releaseNativeTile", [id, gen]) as boolean; }
  setNoBorder(id: string, gen: number, v: boolean): boolean { return this.op("setNoBorder", [id, gen, v]) as boolean; }
  noBorder(id: string, gen: number): boolean | null { return this.answer(`noBorder|${id}|${gen}`) as boolean | null; }
  sendToOutput(id: string, gen: number, o: string): boolean { return this.op("sendToOutput", [id, gen, o]) as boolean; }
  sendToDesktop(id: string, gen: number, d: string): boolean { return this.op("sendToDesktop", [id, gen, d]) as boolean; }
  showDesktop(o: string, d: string): boolean { return this.op("showDesktop", [o, d]) as boolean; }
  activeWindow(): string | null { return this.answer("activeWindow") as string | null; }
  activeOutput(): string | null { return this.answer("activeOutput") as string | null; }
  outputs(): readonly OutputInfo[] { return (this.answer("outputs") as OutputInfo[] | undefined) ?? []; }
  workArea(o: string, d: string): Rect | null { return (this.answer(`workArea|${o}|${d}`) as Rect | null | undefined) ?? null; }
  visibleDesktop(o: string): string | null { return (this.answer(`visibleDesktop|${o}`) as string | null | undefined) ?? null; }
  desktops(): readonly string[] { return (this.answer("desktops") as string[] | undefined) ?? []; }
  currentActivity(): string { return this.answer("currentActivity") as string; }
  activityCount(): number { return this.answer("activityCount") as number; }

  /** The outputs as last reported to the engine. */
  knownOutputs(): readonly OutputInfo[] { return (this.memo.get("outputs") as OutputInfo[] | undefined) ?? []; }
}
