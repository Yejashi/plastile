// The single policy authority and single geometry writer (ADR-004, ADR-005).
//
// Events update the model immediately but never solve inline; they mark full
// contexts dirty and schedule one stable flush. Commands run immediately unless
// a transaction is applying, in which case they queue in order. Every external
// frame write goes through applyTarget() and the requested/observed ledger.

import { frameTolerance, isValidArea, rectNear, rectOf, type Rect, type Size } from "./geometry.ts";
import { classify } from "./classify.ts";
import { COMMAND_IDS, type CommandResult, type CommandStatus } from "./commands.ts";
import { DEFAULT_SETTINGS } from "./defaults.ts";
import { newCounters, Trace, type Counters } from "./diagnostics.ts";
import { neighbour, type Direction } from "./navigation.ts";
import type { HostPort, RuntimeServices, WindowSnapshot } from "./ports.ts";
import * as L from "./reconcile/ledger.ts";
import type { Layout, LayoutCommand, SolveInput } from "./layouts/layout.ts";
import { masterStack, type MasterStackState } from "./layouts/masterStack.ts";
import { bsp, reinsert as bspReinsert } from "./layouts/bsp.ts";
import { monocle, floating } from "./layouts/monocle.ts";
import {
  contextId, sameContext, type ActivityId, type Constraints, type ContextId, type ContextKey, type ContextSettings, type Decision,
  type LayoutKind, type Membership, type OutputId, type PlacementMode, type Suspension, type WindowId, type WindowMeta,
  type WindowStates,
} from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLayout = Layout<any>;

const LAYOUTS: Record<LayoutKind, AnyLayout> = {
  "master-stack": masterStack,
  bsp,
  monocle,
  floating,
};
const LAYOUT_CYCLE: readonly LayoutKind[] = ["master-stack", "bsp", "monocle", "floating"];
const DIVERGED = "did not reach its target after bounded corrections";

export interface WindowRules {
  readonly mode?: "tiled" | "floating" | "excluded";
  readonly border?: "normal" | "none" | "keep";
  readonly insert?: "end" | "after-focus" | "master";
  /** Every matched rule, in evaluation order. */
  readonly ruleIds: readonly string[];
  /** Field-level reasons: which rule set each final action (CONFIGURATION §4). */
  readonly reasons?: Readonly<Record<string, string>>;
}

export interface EngineOptions {
  /** Effective settings for a context (configuration precedence resolved by the caller). */
  settingsFor?: (key: ContextKey) => ContextSettings;
  /** Rule actions for a window (cached by the caller on metadata/config revision). */
  rulesFor?: (meta: WindowMeta, key: ContextKey | null) => WindowRules | null;
  /** True when rules depend on the title (otherwise title changes do not reclassify). */
  titleRules?: boolean;
  /** Convergence deadline for an outstanding request (not a delay before first response). */
  deadlineMs?: number;
  /** Bounded wait for late metadata before classifying anyway. */
  readinessMs?: number;
  traceCapacity?: number;
  traceEnabled?: boolean;
  /** Optional high-resolution clock (ns) for measurement builds; never required. */
  clockNs?: () => number;
}

/** Timing of the most recent solve+apply (only when a clockNs is supplied). */
export interface SolveTiming {
  readonly windows: number;
  readonly solveNs: number;
  readonly applyNs: number;
  readonly writes: number;
}

interface Rec {
  id: WindowId;
  gen: number;
  meta: WindowMeta;
  membership: Membership;
  states: WindowStates;
  base: Constraints;
  learnedMin: Size | null;
  learnedMax: Size | null;
  frame: Rect;
  nativeTile: boolean;
  /**
   * An explicit native tile action (quick tile, Tile.manage, tile editor) yielded this
   * window. Sticky: KWin clearing the tile later does not re-adopt it; only adopt-native
   * or toggle-float does (BEHAVIOR §9).
   */
  nativeYield: boolean;
  /** Tile associations we released ourselves (so the resulting signal is not a user action). */
  releasingTile: boolean;
  decision: Decision;
  mode: PlacementMode;
  userMode: "tiled" | "floating" | null;
  ctx: ContextKey | null;
  suspensions: Set<Suspension>;
  ledger: L.LedgerEntry;
  floatRect: Rect | null;
  insertedAt: number;
  exception: string | null;
  readyBy: number | null;
  border: { original: boolean; applied: boolean } | null;
  rules: WindowRules | null;
}

interface Ctx {
  key: ContextKey;
  id: ContextId;
  members: WindowId[];
  layoutOverride: LayoutKind | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  states: Partial<Record<LayoutKind, any>>;
  focus: WindowId[];
  revision: number;
  applied: number;
  plan: Map<WindowId, Rect>;
  settings: ContextSettings | null;
  /** Consecutive failed solves (bounded retry). */
  failures: number;
}

export class Engine {
  readonly counters: Counters = newCounters();
  readonly trace: Trace;
  private readonly host: HostPort;
  private readonly svc: RuntimeServices;
  private opts: Required<Pick<EngineOptions, "deadlineMs" | "readinessMs">> & EngineOptions;

  private recs = new Map<WindowId, Rec>();
  private tombstones = new Map<WindowId, number>();
  private contexts = new Map<ContextId, Ctx>();
  private dirty = new Set<ContextId>();
  private corrections = new Set<WindowId>();
  /** Overflow floats to reconsider at the next flush: by window, by context, or all. */
  private retryWindows = new Set<WindowId>();
  private retryContexts = new Set<ContextId>();
  private retryAll = false;
  /** Output scales, refreshed on adoption and topology changes (not per command). */
  private scales = new Map<OutputId, number>();
  private endedInteractions = new Map<WindowId, "move" | "resize">();
  private queued: Array<{ id: string; arg: unknown }> = [];
  private applying = 0;
  private flushScheduled = false;
  private cancelDeadline: (() => void) | null = null;
  private deadlineAt = Infinity;
  private seq = 0;
  private insertSeq = 0;
  /** Last solve timing; null unless EngineOptions.clockNs is set. */
  lastTiming: SolveTiming | null = null;
  /** Duration of the last host activation call (KWin's own focus work), when measured. */
  lastActivateNs: number | null = null;
  private revision = 0;
  private alive = true;
  private suspended = false;
  /** Activity count and current activity the context keys were derived from. */
  private actCount = 0;
  private actCurrent = "";

  /** Stable identity so Qt.callLater coalesces repeated scheduling. */
  private readonly flushFn = (): void => this.flush();
  private readonly deadlineFn = (): void => this.onDeadline();

  constructor(host: HostPort, svc: RuntimeServices, opts: EngineOptions = {}) {
    this.host = host;
    this.svc = svc;
    this.opts = { deadlineMs: 750, readinessMs: 300, ...opts };
    this.trace = new Trace(opts.traceCapacity ?? 2048, opts.traceEnabled ?? true);
  }

  // ------------------------------------------------------------------ lifecycle

  /** Adopt existing windows: classify once, seed order, one solve per visible context. */
  start(initial: readonly WindowSnapshot[]): void {
    this.refreshScales();
    this.actCount = this.host.activityCount();
    this.actCurrent = this.host.currentActivity();
    for (const s of initial) this.add(s, false);
    this.markVisibleDirty();
    this.flushNow();
  }

  /** Stop owning geometry: invalidate deferred work and restore still-owned properties. */
  stop(): void {
    if (!this.alive) return;
    this.alive = false;
    this.releaseOwnership();
    this.recs.clear();
    this.contexts.clear();
    this.dirty.clear();
    this.corrections.clear();
    this.retryWindows.clear();
    this.retryContexts.clear();
    this.endedInteractions.clear();
    this.queued = [];
  }

  /**
   * Diagnostic recovery: resync membership from the live inventory. Records without a
   * live window are dropped; user float choices are kept. Not an idle operation.
   */
  reconcile(live: readonly WindowSnapshot[]): void {
    if (!this.alive) return;
    const ids = new Set(live.map((s) => s.id));
    for (const r of [...this.recs.values()]) {
      if (!ids.has(r.id)) { this.tombstones.set(r.id, r.gen); this.drop(r); this.counters.removed++; }
    }
    for (const s of live) this.add(s, false);
    for (const c of this.contexts.values()) { c.revision++; this.markDirty(c.key); }
    this.trace.record(this.svc.now(), "reconcile", undefined, { windows: live.length });
    this.ensureFlush();
  }

  isAlive(): boolean { return this.alive; }
  isSuspended(): boolean { return this.suspended; }

  private releaseOwnership(): void {
    if (this.cancelDeadline) { this.cancelDeadline(); this.cancelDeadline = null; }
    this.deadlineAt = Infinity;
    for (const r of this.recs.values()) {
      L.cancel(r.ledger);
      this.restoreBorder(r);
    }
  }

  // ------------------------------------------------------------------- events

  windowAdded(s: WindowSnapshot): void {
    if (!this.alive) return;
    this.add(s, true);
  }

  private add(s: WindowSnapshot, schedule: boolean): void {
    const dead = this.tombstones.get(s.id);
    if (dead !== undefined && s.gen <= dead) { this.counters.staleEvents++; return; }
    const existing = this.recs.get(s.id);
    if (existing && existing.gen >= s.gen) { this.updateSnapshot(existing, s); return; } // C01
    if (existing) this.drop(existing);
    const r: Rec = {
      id: s.id, gen: s.gen, meta: s.meta, membership: s.membership, states: s.states, base: s.constraints,
      learnedMin: null, learnedMax: null, frame: rectOf(s.frame), nativeTile: s.nativeTile, nativeYield: s.nativeTile,
      releasingTile: false,
      decision: { mode: "floating", source: "default", reason: "unclassified", ruleIds: [] },
      mode: "pending", userMode: null, ctx: null, suspensions: suspensionsOf(s.states),
      ledger: L.newEntry(rectOf(s.frame)), floatRect: null, insertedAt: ++this.insertSeq, exception: null,
      readyBy: null, border: null, rules: null,
    };
    this.recs.set(r.id, r);
    this.counters.adopted++;
    this.trace.record(this.svc.now(), "add", r.id);
    if (s.meta.appId === "" && s.meta.kind === "normal" && !s.meta.special) {
      // Late metadata: stay visible and pending, bounded by a readiness deadline.
      r.readyBy = this.svc.now() + this.opts.readinessMs;
      this.armDeadline(r.readyBy);
    } else {
      this.reclassify(r, "added");
    }
    if (schedule) this.ensureFlush();
  }

  private updateSnapshot(r: Rec, s: WindowSnapshot): void {
    r.meta = s.meta; r.membership = s.membership; r.states = s.states; r.base = s.constraints;
    r.frame = rectOf(s.frame); r.nativeTile = s.nativeTile;
    if (s.nativeTile) r.nativeYield = true;
    r.suspensions = suspensionsOf(s.states);
    this.reclassify(r, "resync");
  }

  windowRemoved(id: WindowId, gen: number): void {
    const r = this.recs.get(id);
    this.tombstones.set(id, Math.max(gen, this.tombstones.get(id) ?? 0));
    if (this.tombstones.size > 4096) this.tombstones.delete(this.tombstones.keys().next().value as WindowId);
    if (!r || r.gen > gen) return;
    this.drop(r);
    this.counters.removed++;
    this.trace.record(this.svc.now(), "remove", id);
    this.ensureFlush();
  }

  private drop(r: Rec): void {
    L.cancel(r.ledger);
    if (r.mode === "tiled" && r.ctx) this.retryOverflow(contextId(r.ctx));
    this.leaveContext(r);
    this.corrections.delete(r.id);
    this.endedInteractions.delete(r.id);
    this.recs.delete(r.id);
  }

  private live(id: WindowId, gen: number): Rec | null {
    const r = this.recs.get(id);
    if (!r || r.gen !== gen) { this.counters.staleEvents++; return null; }
    return r;
  }

  metadataChanged(id: WindowId, gen: number, meta: WindowMeta): void {
    const r = this.live(id, gen);
    if (!r) return;
    const prev = r.meta;
    r.meta = meta;
    const relevant = prev.appId !== meta.appId || prev.kind !== meta.kind || prev.transient !== meta.transient
      || prev.resizeable !== meta.resizeable || prev.special !== meta.special || prev.modal !== meta.modal
      || prev.resourceName !== meta.resourceName || (this.opts.titleRules === true && prev.title !== meta.title);
    if (r.mode === "pending" && meta.appId !== "") { r.readyBy = null; this.reclassify(r, "metadata"); }
    else if (relevant) this.reclassify(r, "metadata");
    this.ensureFlush();
  }

  membershipChanged(id: WindowId, gen: number, m: Membership): void {
    const r = this.live(id, gen);
    if (!r) return;
    r.membership = m;
    if (isOverflow(r)) this.retryOverflow(null, r.id); // another context may have room
    this.reclassify(r, "membership");
    this.ensureFlush();
  }

  statesChanged(id: WindowId, gen: number, st: WindowStates): void {
    const r = this.live(id, gen);
    if (!r) return;
    const prevInteractive = r.states.interactive;
    r.states = st;
    const prevSet = r.suspensions;
    const next = suspensionsOf(st);
    const changed = !sameSet(next, prevSet);
    r.suspensions = next;
    if (changed) {
      this.trace.record(this.svc.now(), "suspensions", id, [...next]);
      if (next.size > 0) L.cancel(r.ledger); // KWin or the user owns the frame now; never fight it
      const onlyInteractive = (x: Set<Suspension>) => x.size === 0 || (x.size === 1 && x.has("interactive"));
      // Starting a drag changes no slot; its end is interpreted once by interactionEnded.
      // Any KWin-owned state appearing or clearing changes participation: one solve.
      if (!(onlyInteractive(prevSet) && onlyInteractive(next)) && r.ctx && r.mode === "tiled") this.markDirty(r.ctx);
      this.ensureFlush();
    }
    if (prevInteractive !== "none" && st.interactive === "none") {
      // Interpret the drop in the next flush: on Escape KWin reports the end of the
      // interaction before restoring the start geometry (measured with real input).
      this.endedInteractions.set(id, prevInteractive);
      this.ensureFlush();
    }
  }

  constraintsChanged(id: WindowId, gen: number, c: Constraints): void {
    const r = this.live(id, gen);
    if (!r) return;
    if (sameConstraints(r.base, c)) return;
    r.base = c;
    r.learnedMin = null; r.learnedMax = null;
    // Its own overflow, or a peer's in its context, may be resolved by the new constraints.
    if (isOverflow(r)) this.retryOverflow(null, r.id);
    else if (r.mode === "tiled" && r.ctx) this.retryOverflow(contextId(r.ctx));
    this.reclassify(r, "constraints");
    if (r.ctx && r.mode === "tiled") this.markDirty(r.ctx);
    this.ensureFlush();
  }

  nativeTileChanged(id: WindowId, gen: number, hasTile: boolean): void {
    const r = this.live(id, gen);
    if (!r) return;
    if (r.releasingTile) { r.releasingTile = false; r.nativeTile = hasTile; return; }
    if (r.nativeTile === hasTile) return;
    r.nativeTile = hasTile;
    if (hasTile) {
      // Explicit native quick tile / tile editor action: yield until adopted (BEHAVIOR §9).
      r.userMode = null;
      r.nativeYield = true;
      this.reclassify(r, "native-tile");
      this.ensureFlush();
    }
    // A released tile keeps the yield (mode stays native): only an explicit adopt ends it.
  }

  frameObserved(id: WindowId, gen: number, frame: Rect): void {
    const r = this.live(id, gen);
    if (!r) return;
    const f = rectOf(frame);
    r.frame = f;
    this.counters.observations++;
    if (this.applying > 0) this.counters.observationsDuringApply++;
    if (r.mode === "floating" && r.suspensions.size === 0 && r.ledger.status !== "pending") r.floatRect = f;
    if (r.mode !== "tiled") { L.observe(r.ledger, f); return; }
    if (this.inFloatingLayout(r)) {
      // The floating layout places nothing: where the user puts a member is its float
      // rectangle, so a later return to floating does not restore an older snapshot.
      if (this.participates(r)) r.floatRect = f;
      L.observe(r.ledger, f);
      return;
    }
    if (r.suspensions.has("interactive")) return; // the user owns the frame during the drag
    const o = L.observe(r.ledger, f);
    switch (o) {
      case "settled":
        this.counters.settled++;
        if (r.exception === DIVERGED) r.exception = null; // a slow client got there after all
        this.trace.record(this.svc.now(), "settled", id);
        this.disarmIfIdle();
        break;
      case "stale":
        this.counters.stale++;
        if (this.ownsGeometry(r)) { this.corrections.add(id); this.ensureFlush(); }
        break;
      case "superseded": this.counters.superseded++; break; // the newer configure follows; deadline-bounded

      case "partial": this.counters.partial++; break;
      case "external":
        this.counters.external++;
        // An application (or another tool) changed a settled tile: bounded correction, then stop.
        if (this.ownsGeometry(r) && r.ledger.desired) {
          if (L.canCorrect(r.ledger)) { this.corrections.add(id); this.ensureFlush(); }
          else if (r.ledger.status !== "diverged") {
            L.diverge(r.ledger);
            this.counters.diverged++;
            r.exception = "keeps changing its own size; Plastile stopped correcting it";
          }
        }
        break;
      default: break;
    }
  }

  activeChanged(id: WindowId | null): void {
    if (!this.alive || id === null) return;
    const r = this.recs.get(id);
    if (!r || !r.ctx || r.mode !== "tiled") return;
    const c = this.ctxFor(r.ctx);
    c.focus = [id, ...c.focus.filter((x) => x !== id)].slice(0, 16);
    // Monocle frames do not depend on the selection, and KWin raises an activated
    // window itself (the focus command raises explicitly): record it, no solve (C12).
    if (this.layoutKind(c) === "monocle") c.states.monocle = { selected: id };
  }

  /** Visible desktop/activity changed on some output. */
  visibilityChanged(): void {
    if (!this.alive) return;
    this.trace.record(this.svc.now(), "visibility");
    this.syncActivities();
    this.markVisibleDirty(true);
    this.ensureFlush();
  }

  /** Outputs added/removed/changed, or work areas changed. */
  topologyChanged(): void {
    if (!this.alive) return;
    this.trace.record(this.svc.now(), "topology");
    this.refreshScales();
    this.syncActivities();
    this.retryOverflow("*"); // work areas may have grown
    for (const c of this.contexts.values()) { c.settings = null; this.markDirty(c.key); }
    this.ensureFlush();
  }

  /**
   * The usable area changed on these outputs (a panel appeared, went away or moved):
   * invalidate only their contexts' geometry, without touching policy order or settings.
   */
  workAreaChanged(outputs: readonly OutputId[]): void {
    if (!this.alive) return;
    this.trace.record(this.svc.now(), "topology", undefined, { workArea: outputs });
    for (const c of this.contexts.values()) {
      if (outputs.indexOf(c.key.output) < 0) continue;
      this.markDirty(c.key);
      this.retryOverflow(c.id); // the area may have grown (BEHAVIOR §11)
    }
    this.ensureFlush();
  }

  /** New configuration activated: settings/rules functions replaced atomically. */
  configure(opts: EngineOptions): void {
    this.trace.record(this.svc.now(), "configure");
    const before = new Map<Ctx, ContextSettings>();
    for (const c of this.contexts.values()) if (c.states["master-stack"] !== undefined) before.set(c, this.ctxSettings(c));
    this.opts = { ...this.opts, ...opts, deadlineMs: opts.deadlineMs ?? this.opts.deadlineMs,
                  readinessMs: opts.readinessMs ?? this.opts.readinessMs };
    if (opts.traceCapacity !== undefined && opts.traceCapacity !== this.trace.capacity) this.trace.resize(opts.traceCapacity);
    if (opts.traceEnabled !== undefined) this.trace.enabled = opts.traceEnabled;
    for (const c of this.contexts.values()) c.settings = null;
    for (const [c, old] of before) this.rebaseMasterStack(c, old);
    for (const r of this.recs.values()) this.reclassify(r, "config");
    for (const c of this.contexts.values()) this.markDirty(c.key);
    this.retryOverflow("*");
    this.ensureFlush();
  }

  /**
   * Carry a newly configured master ratio and master count into a live master-stack
   * state, field by field, unless the user changed that field by command in this
   * context (it no longer equals the value configured before): session commands own
   * what they set until a reset (CONFIGURATION §3, BEHAVIOR §12).
   */
  private rebaseMasterStack(c: Ctx, old: ContextSettings): void {
    const ms = c.states["master-stack"] as MasterStackState;
    const was = masterStack.initial(old), now = masterStack.initial(this.ctxSettings(c));
    const ratio = ms.ratio === was.ratio ? now.ratio : ms.ratio;
    const masterCount = ms.masterCount === was.masterCount ? now.masterCount : ms.masterCount;
    if (ratio === ms.ratio && masterCount === ms.masterCount) return;
    c.states["master-stack"] = { ...ms, ratio, masterCount };
    c.revision++;
  }

  // ------------------------------------------------------- classification/model

  private singleContextKey(m: Membership): ContextKey | null {
    if (m.output === null || m.onAllDesktops || m.desktops.length !== 1) return null;
    const activity = this.activityKey(m);
    return activity === null ? null : { output: m.output, desktop: m.desktops[0], activity };
  }

  /**
   * Activity part of a context key (ADR-009). With at most one activity (also without
   * the activity service: one placeholder) every window belongs to the current activity
   * whatever its own list says; with several, only a window on exactly one activity has
   * a single context. Keys always name a real (or the placeholder) activity, so a
   * context never outlives a change in the number of activities unnoticed.
   */
  private activityKey(m: Membership): ActivityId | null {
    if (this.host.activityCount() <= 1) return this.host.currentActivity();
    return m.activities.length === 1 ? m.activities[0] : null;
  }

  /**
   * Re-key windows whose context depends on global activity state. Adding or removing
   * an activity emits only Workspace.activitiesChanged, and an activity service starting
   * late only currentActivityChanged (measured, KWin 6.7.5): no window signal follows.
   * Keys depend on global state only while at most one activity exists, so switching
   * among several activities re-keys nothing.
   */
  private syncActivities(): void {
    const n = this.host.activityCount(), cur = this.host.currentActivity();
    if (n === this.actCount && cur === this.actCurrent) return;
    const rekey = n <= 1 || this.actCount <= 1;
    this.actCount = n;
    this.actCurrent = cur;
    if (!rekey) return;
    this.trace.record(this.svc.now(), "activities", undefined, { count: n });
    // Members in context order first: windows moving together keep their relative order.
    const order: Rec[] = [];
    const seen = new Set<WindowId>();
    for (const c of this.contexts.values()) {
      for (const id of c.members) {
        const r = this.recs.get(id);
        if (r && !seen.has(id)) { seen.add(id); order.push(r); }
      }
    }
    for (const r of this.recs.values()) if (!seen.has(r.id)) order.push(r);
    for (const r of order) if (r.mode !== "pending") this.reclassify(r, "activities");
  }

  private effectiveConstraints(r: Rec): Constraints {
    if (!r.learnedMin && !r.learnedMax) return r.base;
    return {
      minFrame: {
        width: Math.max(r.base.minFrame.width, r.learnedMin?.width ?? 0),
        height: Math.max(r.base.minFrame.height, r.learnedMin?.height ?? 0),
      },
      maxFrame: {
        width: Math.min(r.base.maxFrame.width, r.learnedMax?.width ?? Infinity),
        height: Math.min(r.base.maxFrame.height, r.learnedMax?.height ?? Infinity),
      },
      fixed: r.base.fixed,
    };
  }

  private reclassify(r: Rec, why: string): void {
    const key = this.singleContextKey(r.membership);
    r.rules = this.opts.rulesFor ? this.opts.rulesFor(r.meta, key) : null;
    r.decision = classify({
      meta: r.meta, membership: r.membership, constraints: r.base, frameSize: r.frame,
      singleContext: key !== null, rule: r.rules,
    });
    let mode: PlacementMode = r.decision.mode;
    if (mode !== "excluded") {
      if (r.nativeYield) mode = "native";
      else if (r.userMode === "floating") mode = "floating";
      else if (r.userMode === "tiled" && this.whyNotTileable(r, key) === null) mode = "tiled";
      else if (r.exception !== null && mode === "tiled" && r.exception.startsWith("overflow")) mode = "floating";
    }
    if (mode === "tiled" && !(this.settingsFor(key!).enabled)) mode = "floating";
    this.transition(r, mode, key, why);
    if (!this.suspended) this.applyBorderPolicy(r); // suspended: no owned property writes
  }

  /** Why an explicit tile request cannot be honoured (null when it can), from the current decision. */
  private whyNotTileable(r: Rec, key: ContextKey | null): string | null {
    if (r.decision.mode === "excluded" || key === null || r.decision.source === "membership") return r.decision.reason;
    if (!r.meta.resizeable || r.base.fixed) return "fixed size";
    if (!this.settingsFor(key).enabled) return "tiling is disabled here";
    return null;
  }

  private transition(r: Rec, mode: PlacementMode, key: ContextKey | null, why: string): void {
    const wasTiled = r.mode === "tiled";
    const prevCtx = r.ctx;
    if (wasTiled && (mode !== "tiled" || !sameContext(prevCtx, key))) {
      this.leaveContext(r);
      if (why !== "overflow") this.retryOverflow(contextId(prevCtx!)); // its space is free now
    }
    if (mode === "floating" && wasTiled === false && r.floatRect === null && r.suspensions.size === 0) r.floatRect = r.frame;
    r.mode = mode;
    const nextCtx = mode === "tiled" || mode === "floating" ? key : null;
    if (!sameContext(prevCtx, nextCtx)) {
      // Targets belong to a context: a transfer (e.g. KWin moved the window to another
      // output, emitting frameGeometryChanged before outputChanged) must not leave a
      // queued correction that writes it back to the old context's slot.
      r.ledger = L.newEntry(r.frame);
      this.corrections.delete(r.id);
    }
    r.ctx = nextCtx;
    if (mode === "tiled" && (!wasTiled || !sameContext(prevCtx, key))) this.joinContext(r);
    if (mode !== "tiled") L.cancel(r.ledger);
    this.trace.record(this.svc.now(), "mode", r.id, { mode, why, source: r.decision.source });
  }

  private settingsFor(key: ContextKey): ContextSettings {
    return this.opts.settingsFor ? this.opts.settingsFor(key) : DEFAULT_SETTINGS;
  }

  private ctxFor(key: ContextKey): Ctx {
    const id = contextId(key);
    let c = this.contexts.get(id);
    if (!c) {
      c = { key, id, members: [], layoutOverride: null, states: {}, focus: [], revision: 0, applied: -1,
            plan: new Map(), settings: null, failures: 0 };
      this.contexts.set(id, c);
    }
    return c;
  }

  private ctxSettings(c: Ctx): ContextSettings {
    if (!c.settings) c.settings = this.settingsFor(c.key);
    return c.settings;
  }

  private layoutKind(c: Ctx): LayoutKind {
    return c.layoutOverride ?? this.ctxSettings(c).layout;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private layoutState(c: Ctx, kind: LayoutKind): any {
    if (c.states[kind] === undefined) {
      const lay = LAYOUTS[kind];
      c.states[kind] = lay.rebuild(lay.initial(this.ctxSettings(c)), c.members, this.solveInput(c, null));
    }
    return c.states[kind];
  }

  private joinContext(r: Rec): void {
    const c = this.ctxFor(r.ctx!);
    if (c.members.includes(r.id)) return;
    const s = this.ctxSettings(c);
    const insert = r.rules?.insert ?? s.masterStack.insert;
    const focus = c.focus.find((id) => c.members.includes(id)) ?? null;
    let at = c.members.length;
    if (insert === "master") at = 0;
    else if (insert === "after-focus" && focus !== null) at = c.members.indexOf(focus) + 1;
    c.members.splice(at, 0, r.id);
    const anchor = at > 0 ? c.members[at - 1] : null;
    const input = this.solveInput(c, null);
    for (const kind of Object.keys(c.states) as LayoutKind[]) {
      c.states[kind] = LAYOUTS[kind].insert(c.states[kind], r.id, kind === "bsp" ? (focus ?? anchor) : anchor, input);
    }
    c.revision++;
    this.markDirty(c.key);
  }

  private leaveContext(r: Rec): void {
    if (!r.ctx) return;
    const c = this.contexts.get(contextId(r.ctx));
    if (!c) return;
    const i = c.members.indexOf(r.id);
    if (i < 0) return;
    c.members.splice(i, 1);
    c.focus = c.focus.filter((x) => x !== r.id);
    c.plan.delete(r.id);
    for (const kind of Object.keys(c.states) as LayoutKind[]) c.states[kind] = LAYOUTS[kind].remove(c.states[kind], r.id);
    c.revision++;
    this.markDirty(c.key);
  }

  /**
   * Takes part in the solve. An interactive move/resize keeps its slot (the model is
   * preserved during the drag, BEHAVIOR §8); only KWin-owned states remove it.
   */
  private participates(r: Rec): boolean {
    if (r.mode !== "tiled" || r.ctx === null) return false;
    for (const s of r.suspensions) if (s !== "interactive") return false;
    return true;
  }

  /** Participates and may receive frame requests (the user owns the frame while dragging). */
  private writable(r: Rec): boolean {
    return this.participates(r) && !r.suspensions.has("interactive");
  }

  /** Writable and its context actually places windows (the floating layout does not). */
  private ownsGeometry(r: Rec): boolean {
    if (!this.writable(r)) return false;
    const c = this.contexts.get(contextId(r.ctx!));
    return !!c && this.layoutKind(c) !== "floating";
  }

  private inFloatingLayout(r: Rec): boolean {
    const c = r.ctx ? this.contexts.get(contextId(r.ctx)) : undefined;
    return !!c && this.layoutKind(c) === "floating";
  }

  // ---------------------------------------------------------------- scheduling

  private markDirty(key: ContextKey): void {
    this.dirty.add(contextId(key));
  }

  private markVisibleDirty(onlyStale = false): void {
    for (const c of this.contexts.values()) {
      if (this.isVisible(c.key) && (!onlyStale || c.applied !== c.revision || this.dirty.has(c.id))) this.dirty.add(c.id);
    }
  }

  private ensureFlush(): void {
    if (this.flushScheduled || !this.alive) return;
    this.flushScheduled = true;
    this.svc.callLater(this.flushFn);
  }

  /** Run pending work now (used at adoption and by tests). */
  flushNow(): void { this.flush(); }

  private flush(): void {
    if (!this.alive) return;
    this.flushScheduled = false;
    this.counters.flushes++;
    try {
      this.syncActivities();
      const queued = this.queued;
      this.queued = [];
      for (const q of queued) this.execute(q.id, q.arg);
      if (this.suspended) { this.dirty.clear(); this.corrections.clear(); this.endedInteractions.clear(); return; }
      this.retryOverflows();
      if (this.endedInteractions.size) {
        const ended = [...this.endedInteractions];
        this.endedInteractions.clear();
        for (const [id, kind] of ended) {
          const r = this.recs.get(id);
          if (r && r.states.interactive === "none") this.contained("interaction end", () => this.interactionEnded(r, kind));
        }
      }
      this.runCorrections();
      const ids = [...this.dirty];
      this.dirty.clear();
      for (const id of ids) {
        const c = this.contexts.get(id);
        if (!c) continue;
        if (!this.isVisible(c.key)) { if (c.members.length) c.revision++; continue; }
        this.solveContained(c);
      }
    } catch (e) {
      this.counters.errors++;
      this.svc.log("error", "flush failed", String(e));
    }
    if (this.dirty.size > 0 || this.corrections.size > 0 || this.queued.length > 0) this.ensureFlush();
    else this.disarmIfIdle();
  }

  /** Ask for overflow floats to be reconsidered: "*" for all, a context id, or one window. */
  private retryOverflow(ctx: ContextId | "*" | null, id?: WindowId): void {
    if (ctx === "*") this.retryAll = true;
    else if (ctx !== null) this.retryContexts.add(ctx);
    if (id !== undefined) this.retryWindows.add(id);
    this.ensureFlush();
  }

  /**
   * Give overflow floats one new attempt when their inputs changed: output area, layout
   * parameters (configuration), constraints, or a peer leaving (BEHAVIOR §11). They
   * rejoin in insertion order; a solve that still cannot fit them floats the newest
   * again, which asks for no further retry. Unrelated events (focus) never retry.
   */
  private retryOverflows(): void {
    if (!this.retryAll && this.retryContexts.size === 0 && this.retryWindows.size === 0) return;
    const all = this.retryAll, ctxs = this.retryContexts, ids = this.retryWindows;
    this.retryAll = false;
    this.retryContexts = new Set();
    this.retryWindows = new Set();
    const list: Rec[] = [];
    for (const r of this.recs.values()) {
      if (isOverflow(r) && (all || ids.has(r.id) || (r.ctx !== null && ctxs.has(contextId(r.ctx))))) list.push(r);
    }
    list.sort((a, b) => a.insertedAt - b.insertedAt);
    for (const r of list) {
      r.exception = null;
      this.reclassify(r, "overflow-retry");
    }
  }

  private runCorrections(): void {
    if (this.corrections.size === 0) return;
    const ids = [...this.corrections];
    this.corrections.clear();
    for (const id of ids) {
      const r = this.recs.get(id);
      if (!r || !this.ownsGeometry(r) || !r.ledger.desired) continue;
      // A dirty context is re-solved in this flush and its fresh target supersedes the old
      // one (e.g. KWin moved a tile off a new panel before the area change was known).
      if (this.dirty.has(contextId(r.ctx!))) continue;
      if (rectNear(r.frame, r.ledger.desired, r.ledger.tol) || rectNear(r.frame, r.ledger.accepted, r.ledger.tol)) continue;
      if (!L.canCorrect(r.ledger)) continue;
      this.contained("correction", () => this.write(r, r.ledger.desired!, "correction"));
    }
  }

  /** Run one unit of flush work; an exception is logged and stays inside that unit. */
  private contained(what: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (e) {
      this.counters.errors++;
      this.svc.log("error", what + " failed", String(e));
      return false;
    }
  }

  /**
   * Solve one context without letting its failure abandon the others in the same
   * flush (ARCHITECTURE §7, §13). A failed context is retried once in the next flush,
   * which recovers a transient error; one that keeps failing waits for its next event.
   */
  private solveContained(c: Ctx): void {
    if (this.contained("solve " + c.id, () => this.solveAndApply(c))) { c.failures = 0; return; }
    if (++c.failures <= 1) this.markDirty(c.key);
    else this.trace.record(this.svc.now(), "quarantine", c.id, { failures: c.failures });
  }

  private isVisible(key: ContextKey): boolean {
    return this.host.visibleDesktop(key.output) === key.desktop && this.host.currentActivity() === key.activity;
  }

  // ----------------------------------------------------------- solve / apply

  private solveInput(c: Ctx, area: Rect | null): SolveInput {
    const constraints = new Map<WindowId, Constraints>();
    const insertedAt = new Map<WindowId, number>();
    const ids: WindowId[] = [];
    for (const id of c.members) {
      const r = this.recs.get(id);
      if (!r) continue;
      constraints.set(id, this.effectiveConstraints(r));
      insertedAt.set(id, r.insertedAt);
      if (this.participates(r)) ids.push(id);
    }
    const active = this.host.activeWindow();
    const focused = active !== null && c.members.includes(active) ? active : (c.focus[0] ?? null);
    return {
      area: area ?? { x: 0, y: 0, width: 1920, height: 1080 },
      ids, members: c.members.slice(), constraints, settings: this.ctxSettings(c), focused, insertedAt,
    };
  }

  private solveAndApply(c: Ctx): void {
    if (c.members.length === 0 && c.plan.size === 0) { c.applied = c.revision; return; }
    const area = this.host.workArea(c.key.output, c.key.desktop);
    if (!isValidArea(area)) {
      // Temporary invalid output geometry: keep the last valid plan (O06); topology events retry.
      this.trace.record(this.svc.now(), "area-invalid", c.id);
      return;
    }
    const clock = this.opts.clockNs;
    const t0 = clock ? clock() : 0;
    const kind = this.layoutKind(c);
    const lay = LAYOUTS[kind];
    const input = this.solveInput(c, area);
    const state = this.layoutState(c, kind);
    const res = lay.solve(state, input);
    const t1 = clock ? clock() : 0;
    const writes0 = this.counters.writes;
    this.counters.solves++;
    this.trace.record(this.svc.now(), "solve", c.id, { kind, n: input.ids.length, notes: res.notes.length });
    for (const id of res.overflow) {
      const r = this.recs.get(id);
      if (!r) continue;
      this.counters.overflow++;
      r.exception = "overflow: " + (res.notes.find((n) => n.startsWith(id + ":")) ?? "does not fit");
      this.transition(r, "floating", r.ctx, "overflow");
    }
    c.plan = res.slots;
    c.applied = c.revision;
    const tol = frameTolerance(this.scales.get(c.key.output) ?? 1);
    this.applying++;
    try {
      for (const [id, target] of res.slots) {
        const r = this.recs.get(id);
        if (!r || !this.writable(r)) continue;
        r.ledger.tol = tol;
        this.applyTarget(r, target);
      }
      for (const id of res.raise) {
        const r = this.recs.get(id);
        if (r && this.host.raise(r.id, r.gen)) this.counters.raises++;
      }
    } finally {
      this.applying--;
    }
    if (clock) this.lastTiming = { windows: input.ids.length, solveNs: t1 - t0, applyNs: clock() - t1,
                                   writes: this.counters.writes - writes0 };
  }

  private refreshScales(): void {
    this.scales.clear();
    for (const o of this.host.outputs()) this.scales.set(o.id, o.scale);
  }

  private applyTarget(r: Rec, target: Rect): void {
    const now = this.host.frame(r.id, r.gen);
    if (now === null) return; // gone: removal event follows; peers continue
    const dec = L.decideWrite(r.ledger, target, now);
    switch (dec) {
      case "skip-outstanding": this.counters.skipOutstanding++; L.setDesired(r.ledger, target); return;
      case "skip-noop": this.counters.skipNoop++; L.acceptNoop(r.ledger, target, this.svc.now()); return;
      case "skip-diverged": this.counters.skipDiverged++; return;
      default: this.write(r, target, r.ledger.request && rectNear(r.ledger.request.rect, target, r.ledger.tol) ? "correction" : "plan");
    }
  }

  /** The only place that issues frame requests. */
  private write(r: Rec, target: Rect, reason: "plan" | "correction"): void {
    if (r.nativeTile) {
      r.releasingTile = true;
      if (!this.host.releaseNativeTile(r.id, r.gen)) r.releasingTile = false;
      r.nativeTile = false;
    }
    const seq = ++this.seq;
    const now = this.svc.now();
    L.beginWrite(r.ledger, target, seq, now, reason);
    let fw = null;
    this.applying++;
    try {
      fw = this.host.applyFrame(r.id, r.gen, target);
    } catch (e) {
      this.counters.errors++;
      this.svc.log("warn", "frame write failed", { id: r.id, error: String(e) });
    } finally {
      this.applying--;
    }
    if (fw === null) { L.cancel(r.ledger); return; }
    this.counters.writes++;
    if (reason === "correction") this.counters.corrections++;
    const wasOutstanding = r.ledger.outstanding;
    const settled = L.finishWrite(r.ledger, fw.before, fw.after);
    r.frame = fw.after;
    this.trace.record(now, "write", r.id, { reason, seq, settled });
    if (settled && wasOutstanding) this.counters.settled++;
    else if (!settled) this.armDeadline(now + this.opts.deadlineMs);
  }

  // ----------------------------------------------------------------- deadlines

  private armDeadline(at: number): void {
    if (!this.alive || at >= this.deadlineAt) return;
    if (this.cancelDeadline) this.cancelDeadline();
    this.deadlineAt = at;
    this.cancelDeadline = this.svc.deadline(Math.max(1, at - this.svc.now()), this.deadlineFn);
  }

  /** Cancel the deadline once no request or readiness wait is outstanding (no idle timer). */
  private disarmIfIdle(): void {
    if (!this.cancelDeadline) return;
    for (const r of this.recs.values()) {
      if (r.ledger.outstanding || r.readyBy !== null) return;
    }
    this.cancelDeadline();
    this.cancelDeadline = null;
    this.deadlineAt = Infinity;
  }

  private onDeadline(): void {
    this.cancelDeadline = null;
    this.deadlineAt = Infinity;
    if (!this.alive) return;
    this.counters.deadlines++;
    const now = this.svc.now();
    let next = Infinity;
    for (const r of [...this.recs.values()]) {
      if (r.mode === "pending" && r.readyBy !== null) {
        if (r.readyBy <= now) { r.readyBy = null; this.reclassify(r, "readiness-deadline"); }
        else next = Math.min(next, r.readyBy);
        continue;
      }
      const e = r.ledger;
      if (!e.outstanding || e.pendingSince === null) continue;
      const due = e.pendingSince + this.opts.deadlineMs;
      if (due > now) { next = Math.min(next, due); continue; }
      const x = L.expire(e, this.host.frame(r.id, r.gen));
      this.trace.record(now, "deadline", r.id, x.kind);
      if (x.kind === "learn") {
        this.counters.learned++;
        const m = L.mergeLearned(r.learnedMin, r.learnedMax, x.min, x.max);
        r.learnedMin = m.min;
        r.learnedMax = m.max;
        r.exception = `accepted ${r.frame.width}x${r.frame.height} instead of the requested size; learned as a constraint`;
        if (r.ctx) this.markDirty(r.ctx);
      } else if (x.kind === "accepted") {
        this.counters.accepted++;
      } else if (x.kind === "correct") {
        if (this.ownsGeometry(r)) this.corrections.add(r.id);
      } else if (x.kind === "diverged") {
        this.counters.diverged++;
        r.exception = DIVERGED;
      }
    }
    if (next < Infinity) this.armDeadline(next);
    this.ensureFlush();
  }

  // ------------------------------------------------------------- interaction

  private interactionEnded(r: Rec, kind: "move" | "resize"): void {
    if (r.mode !== "tiled" || !r.ctx) return;
    const c = this.ctxFor(r.ctx);
    const slot = c.plan.get(r.id);
    // KWin finished the drag with its own state (drag-to-maximize maximizes before it
    // reports the end): the drop frame is KWin's, not a swap or boundary intent.
    if (!slot || !this.participates(r)) { this.markDirty(c.key); return; }
    const f = this.host.frame(r.id, r.gen) ?? r.frame;
    if (kind === "move") {
      // Drop onto another tile swaps positions; anywhere else snaps back (one solve).
      const cx = f.x + f.width / 2, cy = f.y + f.height / 2;
      for (const [other, rect] of c.plan) {
        if (other !== r.id && cx >= rect.x && cx < rect.x + rect.width && cy >= rect.y && cy < rect.y + rect.height) {
          this.swapIn(c, r.id, other);
          break;
        }
      }
    } else {
      const input = this.solveInput(c, this.host.workArea(c.key.output, c.key.desktop));
      const kindL = this.layoutKind(c);
      const lay = LAYOUTS[kindL];
      let state = this.layoutState(c, kindL);
      const edges: Array<[LayoutCommand & { kind: "resize-boundary" }, number]> = [
        [{ kind: "resize-boundary", id: r.id, edge: "left", delta: f.x - slot.x }, Math.abs(f.x - slot.x)],
        [{ kind: "resize-boundary", id: r.id, edge: "right", delta: (f.x + f.width) - (slot.x + slot.width) }, Math.abs(f.x + f.width - slot.x - slot.width)],
        [{ kind: "resize-boundary", id: r.id, edge: "top", delta: f.y - slot.y }, Math.abs(f.y - slot.y)],
        [{ kind: "resize-boundary", id: r.id, edge: "bottom", delta: (f.y + f.height) - (slot.y + slot.height) }, Math.abs(f.y + f.height - slot.y - slot.height)],
      ];
      for (const [cmd, mag] of edges) {
        if (mag < 1) continue;
        const o = lay.command(state, cmd, input);
        if (o.changed) state = o.state;
      }
      c.states[kindL] = state;
    }
    L.cancel(r.ledger);
    r.ledger.request = null; // the user owned the frame; the next plan target is a fresh request
    c.revision++;
    this.markDirty(c.key);
    this.ensureFlush();
  }

  // ------------------------------------------------------------------ commands

  execute(id: string, arg?: unknown): CommandResult {
    const revision = this.revision;
    if (!this.alive) return result(id, "rejected", "runtime stopped", [], revision, false);
    if (!COMMAND_IDS.has(id)) return result(id, "rejected", "unknown command", [], revision, false);
    if (this.applying > 0) {
      this.queued.push({ id, arg });
      this.counters.commandsQueued++;
      this.ensureFlush();
      return result(id, "accepted", "queued during apply", [], revision, false);
    }
    this.counters.commands++;
    const writes0 = this.counters.writes;
    let out: { status: CommandStatus; reason?: string; targets: string[] };
    try {
      out = this.run(id);
    } catch (e) {
      this.counters.errors++;
      this.svc.log("error", "command failed", { id, error: String(e) });
      out = { status: "rejected", reason: "internal error", targets: [] };
    }
    if (out.status === "accepted") this.revision++;
    this.trace.record(this.svc.now(), "command", undefined, { id, status: out.status, reason: out.reason });
    return result(id, out.status, out.reason, out.targets, this.revision, this.counters.writes > writes0);
  }

  private activeRec(): Rec | null {
    const a = this.host.activeWindow();
    return a === null ? null : this.recs.get(a) ?? null;
  }

  /** Context for a command: the active window's, else the visible context of the active output. */
  private commandCtx(r: Rec | null): Ctx | null {
    if (r && r.ctx) return this.ctxFor(r.ctx);
    const out = this.host.activeOutput();
    if (out === null) return null;
    const desk = this.host.visibleDesktop(out);
    if (desk === null) return null;
    return this.ctxFor({ output: out, desktop: desk, activity: this.host.currentActivity() });
  }

  private solveNow(c: Ctx): void {
    c.revision++;
    if (this.suspended) return;
    if (this.isVisible(c.key)) {
      this.dirty.delete(c.id);
      this.solveAndApply(c);
    } else this.markDirty(c.key);
    if (this.dirty.size || this.corrections.size) this.ensureFlush();
  }

  private run(id: string): { status: CommandStatus; reason?: string; targets: string[] } {
    const ok = (targets: string[] = []) => ({ status: "accepted" as const, targets });
    const noop = (reason: string) => ({ status: "noop" as const, reason, targets: [] as string[] });
    const [, family, action] = id.split(".");
    const r = this.activeRec();

    if (family === "runtime") {
      if (action === "toggle-suspend") {
        if (!this.suspended) { this.suspended = true; this.releaseOwnership(); return ok(); }
        this.suspended = false;
        // Adopt the live state again: owned borders, the readiness waits the suspension
        // cancelled, and one solve per visible context.
        for (const w of this.recs.values()) {
          this.applyBorderPolicy(w);
          if (w.readyBy !== null) this.armDeadline(w.readyBy);
        }
        for (const c of this.contexts.values()) { c.revision++; this.markDirty(c.key); }
        this.ensureFlush();
        return ok();
      }
      if (action === "reconcile" || action === "reload-config") return noop("handled by the host adapter");
    }
    if (family === "inspect") return noop("handled by the host adapter");
    if (this.suspended) return { status: "rejected", reason: "tiling suspended", targets: [] };

    const c = this.commandCtx(r);
    if (family === "window") {
      if (!r) return noop("no active window");
      if (action === "toggle-float") return this.toggleFloat(r);
      if (action === "adopt-native") {
        if (r.mode !== "native") return noop("window is not natively tiled");
        r.releasingTile = true;
        if (!this.host.releaseNativeTile(r.id, r.gen)) r.releasingTile = false;
        r.nativeTile = false;
        r.nativeYield = false;
        r.userMode = "tiled";
        this.reclassify(r, "adopt-native");
        if (r.ctx) this.solveNow(this.ctxFor(r.ctx));
        return ok([r.id]);
      }
    }
    if (!c) return noop("no context");

    if (family === "layout") {
      const cur = this.layoutKind(c);
      let next: LayoutKind | null = null;
      if (action === "next" || action === "previous") {
        const i = LAYOUT_CYCLE.indexOf(cur);
        next = LAYOUT_CYCLE[(i + (action === "next" ? 1 : LAYOUT_CYCLE.length - 1)) % LAYOUT_CYCLE.length];
      } else if (action === "master-stack" || action === "bsp" || action === "monocle" || action === "floating") {
        next = action;
      }
      if (next !== null) {
        if (next === cur) return noop(`already ${cur}`);
        c.layoutOverride = next;
        if (next === "floating") this.restoreFloatRects(c);
        this.solveNow(c);
        return ok(c.members.slice());
      }
      const cmd: LayoutCommand | null =
        action === "rotate-clockwise" ? { kind: "rotate", clockwise: true }
        : action === "rotate-counterclockwise" ? { kind: "rotate", clockwise: false }
        : action === "mirror-horizontal" ? { kind: "mirror", axis: "horizontal" }
        : action === "mirror-vertical" ? { kind: "mirror", axis: "vertical" } : null;
      if (cmd) return this.layoutCommand(c, cmd);
    }
    if (family === "resize") {
      const kind = this.layoutKind(c);
      const step = kind === "bsp" ? this.ctxSettings(c).bsp.ratioStep : this.ctxSettings(c).masterStack.ratioStep;
      if (action === "equalize") return this.layoutCommand(c, { kind: "equalize" });
      if (action === "grow" || action === "shrink") {
        let delta = action === "grow" ? step : -step;
        // Master/stack: growing a stack window shrinks the master column.
        if (kind === "master-stack" && r && r.ctx && sameContext(r.ctx, c.key)) {
          const ms = this.layoutState(c, "master-stack");
          const idx = this.solveInput(c, null).ids.indexOf(r.id);
          if (idx >= ms.masterCount) delta = -delta;
        }
        return this.layoutCommand(c, { kind: "ratio", delta });
      }
    }
    if (family === "master") {
      if (this.layoutKind(c) !== "master-stack") return noop("master count applies to master-stack");
      return this.layoutCommand(c, { kind: "master-count", delta: action === "increase" ? 1 : -1 });
    }
    if (family === "context" && action === "reset") {
      c.layoutOverride = null;
      c.states = {};
      this.solveNow(c);
      return ok(c.members.slice());
    }
    if (family === "focus") return this.focusCommand(c, r, action);
    if (family === "swap") return this.swapCommand(c, r, action);
    if (family === "move") return this.moveCommand(c, r, action);
    return { status: "rejected", reason: "unsupported command", targets: [] };
  }

  private layoutCommand(c: Ctx, cmd: LayoutCommand): { status: CommandStatus; reason?: string; targets: string[] } {
    const kind = this.layoutKind(c);
    const area = this.host.workArea(c.key.output, c.key.desktop);
    const o = LAYOUTS[kind].command(this.layoutState(c, kind), cmd, this.solveInput(c, area));
    if (!o.changed) return { status: "noop", reason: o.reason ?? "no change", targets: [] };
    c.states[kind] = o.state;
    this.solveNow(c);
    return { status: "accepted", targets: c.members.slice() };
  }

  private toggleFloat(r: Rec): { status: CommandStatus; reason?: string; targets: string[] } {
    if (r.mode === "excluded") return { status: "noop", reason: "window is excluded: " + r.decision.reason, targets: [] };
    if (r.mode === "tiled") {
      const ctx = r.ctx;
      r.userMode = "floating";
      this.reclassify(r, "toggle-float");
      if (r.floatRect && !r.suspensions.size) this.writeRestore(r, r.floatRect);
      if (ctx) this.solveNow(this.ctxFor(ctx));
      return { status: "accepted", targets: [r.id] };
    }
    if (r.mode === "floating" || r.mode === "native") {
      // Decide before touching anything: a refused tile request changes no state.
      const why = this.whyNotTileable(r, this.singleContextKey(r.membership));
      if (why !== null) return { status: "noop", reason: "cannot tile: " + why, targets: [] };
      if (r.suspensions.size === 0) r.floatRect = r.frame;
      r.userMode = "tiled";
      r.exception = null;
      if (r.mode === "native") {
        r.releasingTile = true;
        if (!this.host.releaseNativeTile(r.id, r.gen)) r.releasingTile = false;
        r.nativeTile = false;
        r.nativeYield = false;
      }
      this.reclassify(r, "toggle-tile");
      if ((r.mode as PlacementMode) !== "tiled") return { status: "noop", reason: "cannot tile: " + r.decision.reason, targets: [] };
      this.solveNow(this.ctxFor(r.ctx!));
      return { status: "accepted", targets: [r.id] };
    }
    return { status: "noop", reason: "window not ready", targets: [] };
  }

  /** One restore write for a window leaving the tiling (not tracked for corrections). */
  private writeRestore(r: Rec, target: Rect): void {
    if (rectNear(r.frame, target)) return;
    let fw = null;
    this.applying++;
    try { fw = this.host.applyFrame(r.id, r.gen, target); }
    catch (e) { this.counters.errors++; this.svc.log("warn", "restore failed", String(e)); }
    finally { this.applying--; }
    if (fw) { this.counters.writes++; r.frame = fw.after; }
  }

  private restoreFloatRects(c: Ctx): void {
    for (const id of c.members) {
      const r = this.recs.get(id);
      if (r && r.floatRect && r.suspensions.size === 0) { L.cancel(r.ledger); this.writeRestore(r, r.floatRect); }
    }
  }

  private planRects(c: Ctx): Map<WindowId, Rect> {
    if (c.applied !== c.revision || c.plan.size === 0) {
      // Plan may be stale (e.g. desktop never shown): use observed frames of participants.
      const m = new Map<WindowId, Rect>();
      for (const id of c.members) {
        const r = this.recs.get(id);
        if (r && this.participates(r)) m.set(id, c.plan.get(id) ?? r.frame);
      }
      return m;
    }
    const m = new Map<WindowId, Rect>();
    for (const id of c.members) { const p = c.plan.get(id); if (p) m.set(id, p); }
    return m;
  }

  private activate(r: Rec): void {
    const clock = this.opts.clockNs;
    const t0 = clock ? clock() : 0;
    if (this.host.activate(r.id, r.gen)) this.counters.activations++;
    if (clock) this.lastActivateNs = clock() - t0;
  }

  private focusCommand(c: Ctx, r: Rec | null, action: string): { status: CommandStatus; reason?: string; targets: string[] } {
    const ids = this.solveInput(c, null).ids;
    if (ids.length === 0) return { status: "noop", reason: "no tiled windows", targets: [] };
    const cur = r && ids.includes(r.id) ? r.id : null;
    let target: WindowId | null = null;
    if (action === "master") target = ids[0];
    else if (action === "next" || action === "previous") {
      const i = cur === null ? -1 : ids.indexOf(cur);
      target = ids[(i + (action === "next" ? 1 : ids.length - 1) + ids.length) % ids.length];
      if (cur === null && action === "previous") target = ids[ids.length - 1];
    } else if (cur === null) target = c.focus.find((id) => ids.includes(id)) ?? ids[0];
    else target = neighbour(cur, action as Direction, this.planRects(c));
    if (target === null) return { status: "noop", reason: `nothing ${action}`, targets: [] };
    if (target === cur) return { status: "noop", reason: "already focused", targets: [] };
    const t = this.recs.get(target)!;
    this.activate(t);
    // Monocle shows one member: selecting another needs one raise, still no geometry solve.
    if (this.layoutKind(c) === "monocle") {
      c.states.monocle = { selected: target };
      if (this.host.raise(t.id, t.gen)) this.counters.raises++;
    }
    return { status: "accepted", targets: [target] };
  }

  private swapIn(c: Ctx, a: WindowId, b: WindowId): void {
    const i = c.members.indexOf(a), j = c.members.indexOf(b);
    if (i < 0 || j < 0) return;
    c.members[i] = b; c.members[j] = a;
    for (const kind of Object.keys(c.states) as LayoutKind[]) {
      const lay = LAYOUTS[kind];
      if (lay.swap) c.states[kind] = lay.swap(c.states[kind], a, b);
    }
  }

  private swapCommand(c: Ctx, r: Rec | null, action: string): { status: CommandStatus; reason?: string; targets: string[] } {
    if (!r || !this.participates(r) || !sameContext(r.ctx, c.key)) return { status: "noop", reason: "active window is not tiled here", targets: [] };
    const ids = this.solveInput(c, null).ids;
    let other: WindowId | null = null;
    if (action === "master") other = ids[0] === r.id ? (ids[1] ?? null) : ids[0];
    else if (action === "next" || action === "previous") {
      const i = ids.indexOf(r.id);
      other = ids.length < 2 ? null : ids[(i + (action === "next" ? 1 : ids.length - 1)) % ids.length];
    } else other = neighbour(r.id, action as Direction, this.planRects(c));
    if (other === null || other === r.id) return { status: "noop", reason: `nothing to swap ${action}`, targets: [] };
    this.swapIn(c, r.id, other);
    this.solveNow(c);
    return { status: "accepted", targets: [r.id, other] };
  }

  private moveCommand(c: Ctx, r: Rec | null, action: string): { status: CommandStatus; reason?: string; targets: string[] } {
    if (!r) return { status: "noop", reason: "no active window", targets: [] };
    if (action === "output-next" || action === "output-previous") {
      const outs = this.host.outputs();
      if (outs.length < 2 || r.membership.output === null) return { status: "noop", reason: "no other output", targets: [] };
      const i = outs.findIndex((o) => o.id === r.membership.output);
      const dest = outs[(i + (action === "output-next" ? 1 : outs.length - 1)) % outs.length];
      return this.host.sendToOutput(r.id, r.gen, dest.id)
        ? { status: "accepted", targets: [r.id] } : { status: "rejected", reason: "transfer refused", targets: [] };
    }
    if (action === "desktop-next" || action === "desktop-previous") {
      const ds = this.host.desktops();
      if (ds.length < 2 || r.membership.desktops.length !== 1) return { status: "noop", reason: "no other desktop", targets: [] };
      const i = ds.indexOf(r.membership.desktops[0]);
      const dest = ds[(i + (action === "desktop-next" ? 1 : ds.length - 1)) % ds.length];
      return this.host.sendToDesktop(r.id, r.gen, dest)
        ? { status: "accepted", targets: [r.id] } : { status: "rejected", reason: "transfer refused", targets: [] };
    }
    // Structural reinsert next to the directional neighbour.
    if (!this.participates(r) || !sameContext(r.ctx, c.key)) return { status: "noop", reason: "active window is not tiled here", targets: [] };
    const dir = action as Direction;
    const other = neighbour(r.id, dir, this.planRects(c));
    if (other === null) return { status: "noop", reason: `nothing ${action}`, targets: [] };
    const kind = this.layoutKind(c);
    if (kind === "bsp") {
      const side = dir === "left" ? "left" : dir === "right" ? "right" : dir === "up" ? "top" : "bottom";
      c.states.bsp = bspReinsert(this.layoutState(c, "bsp"), r.id, other, side);
    } else {
      // Order-based layouts: move to the neighbour's position in the order.
      const from = c.members.indexOf(r.id);
      c.members.splice(from, 1);
      const to = c.members.indexOf(other);
      c.members.splice(dir === "left" || dir === "up" ? to : to + 1, 0, r.id);
    }
    this.solveNow(c);
    return { status: "accepted", targets: [r.id, other] };
  }

  // ------------------------------------------------------------------- borders

  private applyBorderPolicy(r: Rec): void {
    const want = r.rules?.border;
    if (!want || want === "keep") { this.restoreBorder(r); return; }
    const noBorder = want === "none";
    if (r.mode !== "tiled") { this.restoreBorder(r); return; }
    const cur = this.host.noBorder(r.id, r.gen);
    if (cur === null || cur === noBorder) return;
    // Changed by the user since Plastile applied it: yield, as restoreBorder does (Q10).
    if (r.border && cur !== r.border.applied) return;
    if (!r.border) r.border = { original: cur, applied: noBorder };
    if (this.host.setNoBorder(r.id, r.gen, noBorder)) r.border.applied = noBorder;
  }

  /** Restore a border only if the value is still the one Plastile applied (user changes win). */
  private restoreBorder(r: Rec): void {
    if (!r.border) return;
    const cur = this.host.noBorder(r.id, r.gen);
    if (cur === r.border.applied) this.host.setNoBorder(r.id, r.gen, r.border.original);
    r.border = null;
  }

  // ------------------------------------------------------------- diagnostics

  explain(id: WindowId): Record<string, unknown> | null {
    const r = this.recs.get(id);
    if (!r) return null;
    const c = r.ctx ? this.contexts.get(contextId(r.ctx)) : undefined;
    return {
      id: r.id, appId: r.meta.appId, kind: r.meta.kind, mode: r.mode, userMode: r.userMode,
      decision: r.decision, rules: r.rules ? explainRules(r.rules) : null, context: r.ctx, layout: c ? this.layoutKind(c) : null,
      suspensions: [...r.suspensions], constraints: this.effectiveConstraints(r),
      learnedMin: r.learnedMin, learnedMax: r.learnedMax, ledger: { status: r.ledger.status, outstanding: r.ledger.outstanding,
        desired: r.ledger.desired, corrections: r.ledger.corrections }, slot: c?.plan.get(r.id) ?? null,
      exception: r.exception, nativeTile: r.nativeTile, nativeYield: r.nativeYield,
    };
  }

  /** Model invariants for tests and debug builds. Returns violations. */
  check(): string[] {
    const errs: string[] = [];
    const seen = new Map<WindowId, ContextId>();
    for (const c of this.contexts.values()) {
      for (const id of c.members) {
        const r = this.recs.get(id);
        if (!r) errs.push(`${c.id}: ghost member ${id}`);
        else if (r.mode !== "tiled") errs.push(`${c.id}: member ${id} is ${r.mode}`);
        else if (!r.ctx || contextId(r.ctx) !== c.id) errs.push(`${id}: member of ${c.id} but ctx differs`);
        if (seen.has(id)) errs.push(`${id}: in two contexts ${seen.get(id)} and ${c.id}`);
        seen.set(id, c.id);
      }
      if (new Set(c.members).size !== c.members.length) errs.push(`${c.id}: duplicate members`);
    }
    for (const r of this.recs.values()) {
      if (r.mode === "tiled" && !seen.has(r.id)) errs.push(`${r.id}: tiled but in no context`);
    }
    return errs;
  }

  /** Members of a context in order (tests/diagnostics). */
  membersOf(key: ContextKey): WindowId[] {
    return this.contexts.get(contextId(key))?.members.slice() ?? [];
  }

  modeOf(id: WindowId): PlacementMode | null {
    return this.recs.get(id)?.mode ?? null;
  }

  contextSummary(): Array<{ id: ContextId; layout: LayoutKind; members: number; revision: number; applied: number }> {
    return [...this.contexts.values()].map((c) => ({ id: c.id, layout: this.layoutKind(c), members: c.members.length,
      revision: c.revision, applied: c.applied }));
  }

  outstandingCount(): number {
    let n = 0;
    for (const r of this.recs.values()) if (r.ledger.outstanding) n++;
    return n;
  }
}

/** Matched rules, final rule actions and their per-field reasons (the decision covers mode only). */
function explainRules(w: WindowRules): Record<string, unknown> {
  const actions: Record<string, string> = {};
  if (w.mode !== undefined) actions.mode = w.mode;
  if (w.border !== undefined) actions.border = w.border;
  if (w.insert !== undefined) actions.insert = w.insert;
  return { ids: w.ruleIds.slice(), actions, reasons: { ...(w.reasons ?? {}) } };
}

/** Floated by the overflow policy (float-new), as opposed to by the user or a rule. */
function isOverflow(r: Rec): boolean {
  return r.mode === "floating" && r.exception !== null && r.exception.startsWith("overflow");
}

function suspensionsOf(s: WindowStates): Set<Suspension> {
  const out = new Set<Suspension>();
  if (s.minimized) out.add("minimized");
  if (s.fullscreen) out.add("fullscreen");
  if (s.maximized) out.add("maximized");
  if (s.interactive !== "none") out.add("interactive");
  if (s.hidden) out.add("hidden");
  return out;
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function sameConstraints(a: Constraints, b: Constraints): boolean {
  return a.fixed === b.fixed && a.minFrame.width === b.minFrame.width && a.minFrame.height === b.minFrame.height
    && a.maxFrame.width === b.maxFrame.width && a.maxFrame.height === b.maxFrame.height;
}

function result(command: string, status: CommandStatus, reason: string | undefined, targets: readonly string[],
  revision: number, requested: boolean): CommandResult {
  return reason === undefined ? { command, status, targets, revision, requested }
    : { command, status, reason, targets, revision, requested };
}
