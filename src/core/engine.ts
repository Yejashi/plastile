// The single policy authority and single geometry writer (ADR-004, ADR-005).
//
// Events update the model immediately but never solve inline; they mark full
// contexts dirty and schedule one stable flush. Commands run immediately unless
// a transaction is applying, in which case they queue in order. Every external
// frame write goes through applyTarget() and the requested/observed ledger.

import { contains, frameTolerance, isValidArea, rect, rectNear, rectOf, type Rect, type Size } from "./geometry.ts";
import { classify, TINY_PX, TINY_REASON } from "./classify.ts";
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
  centre as scrollCentre, columnNeighbour, consume as scrollConsume, cycleWidth, expel as scrollExpel, moveColumn, scrolling,
  stripOrder, type ScrollState,
} from "./layouts/scrolling.ts";
import {
  activeZoneLayout, assignZone, bumpZone, nextZoneLayout, projectZones, pruneZones, releaseZones, stepZone, unassignZone, zoneOf, zones,
  type ZoneState,
} from "./layouts/zones.ts";
import {
  contextId, sameContext, type ActivityId, type Constraints, type ContextId, type ContextKey, type ContextSettings, type Decision,
  type DesktopId, type LayoutKind, type Membership, type OutputId, type PlacementMode, type Suspension, type WindowId, type WindowMeta,
  type WindowStates,
} from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLayout = Layout<any>;

const LAYOUTS: Record<LayoutKind, AnyLayout> = {
  "master-stack": masterStack,
  bsp,
  monocle,
  floating,
  scrolling,
  zones,
};
/** Scrolling and zones are experimental and opt-in (ADR-014): selected explicitly, never by the cycle. */
const LAYOUT_CYCLE: readonly LayoutKind[] = ["master-stack", "bsp", "monocle", "floating"];
const DIVERGED = "did not reach its target after bounded corrections";
/** Preferences kept for dropped (empty) contexts, most recent first out last. */
export const RETAINED_MAX = 64;

export interface WindowRules {
  readonly mode?: "tiled" | "floating" | "excluded";
  readonly border?: "normal" | "none" | "keep";
  readonly insert?: "end" | "after-focus" | "master";
  /** Minimum usable frame size for the tile (0 = none); a smaller slot overflows (CONFIGURATION §4). */
  readonly minSize?: Size;
  /** Zones layout (experimental): zone number (1-based) assigned when the window joins a zones context. */
  readonly zone?: number;
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
  /**
   * configure() only: what this activation changed (src/config/diff.ts). Absent: anything may
   * have, as on a first activation, so everything is re-evaluated.
   */
  changes?: ConfigChanges;
}

/**
 * What a context holds beyond its configuration: an explicit layout choice and a master
 * ratio/count set by command (window-specific structure such as BSP trees is not kept).
 */
export interface ContextPrefs {
  readonly layout: LayoutKind | null;
  readonly masterStack: { readonly ratio: number; readonly masterCount: number } | null;
}

/** The parts of a configuration activation the engine depends on. */
export interface ConfigChanges {
  /** Window rule matching may give other results. */
  readonly rules: boolean;
  /** Context settings may resolve to other values. */
  readonly settings: boolean;
}

/** What the zones overlay draws (Engine.zoneOverlay): absolute logical rectangles on one output. */
export interface ZoneOverlayModel {
  readonly output: OutputId;
  /** The output's geometry (the overlay window covers it) and its work area. */
  readonly geometry: Rect;
  readonly area: Rect;
  readonly layout: string;
  /** Zone number (1-based), its projected rectangle, and how many windows are assigned to it. */
  readonly zones: ReadonlyArray<{ readonly n: number; readonly rect: Rect; readonly windows: number }>;
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

/** A window Plastile placed outside every output (scrolling, SCROLLING §3). */
interface Parked {
  /** The strip's context: its output is the one the parking place is nearest to. */
  readonly ctx: ContextKey;
  /** Where it was parked, and where it would be in an unbounded work area. */
  readonly rect: Rect;
  readonly virtual: Rect;
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
  /** Contexts that became (or were created) empty: collected at the end of a flush. */
  private emptied = new Set<ContextId>();
  /** Preferences of collected contexts, restored when the context is used again (bounded). */
  private retained = new Map<ContextId, { key: ContextKey; prefs: ContextPrefs }>();
  /** Outputs last reported as identical monitors told apart by connector (diagnostic, E16). */
  private ambiguousOutputs = "";
  private dirty = new Set<ContextId>();
  private corrections = new Set<WindowId>();
  /** Overflow floats to reconsider at the next flush: by window, by context, or all. */
  private retryWindows = new Set<WindowId>();
  private retryContexts = new Set<ContextId>();
  private retryAll = false;
  /** Output scales, refreshed on adoption and topology changes (not per command). */
  private scales = new Map<OutputId, number>();
  private endedInteractions = new Map<WindowId, "move" | "resize">();
  /** Windows currently parked by a scrolling strip (recorded before each parking write). */
  private parked = new Map<WindowId, Parked>();
  /** Zones: the last explanation per window (minimum size does not fit, rule zone missing). */
  private zoneNotes = new Map<WindowId, string>();
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
    this.emptied.clear();
    this.retained.clear();
    this.dirty.clear();
    this.corrections.clear();
    this.retryWindows.clear();
    this.retryContexts.clear();
    this.endedInteractions.clear();
    this.parked.clear();
    this.zoneNotes.clear();
    this.queued = [];
  }

  /**
   * Diagnostic recovery: resync membership from the live inventory. Records without a
   * live window are dropped; user float choices are kept. Not an idle operation.
   */
  reconcile(live: readonly WindowSnapshot[]): void {
    if (!this.alive) return;
    // Nothing stays parked across a resync: the solves that follow park what is still hidden.
    this.sweepParked(true);
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
    this.sweepParked(true); // every parked window back inside its output's work area (SCROLLING §5)
    this.releaseAllZones(); // zoned windows keep their frames (ZONES §2)
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
    this.parked.delete(r.id);
    this.zoneNotes.delete(r.id);
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
    r.membership = this.keepParkedOutput(r, m);
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
    if (r.mode === "excluded" && r.decision.reason === TINY_REASON && f.width > TINY_PX && f.height > TINY_PX) {
      // Mapped helper-sized and sized by its client later: classify it once with its real
      // size (the decision no longer depends on the frame, so this does not repeat).
      this.reclassify(r, "grown");
      this.ensureFlush();
      return;
    }
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
    if (!r) return;
    if (!r.ctx || r.mode !== "tiled") { this.revealTransientParent(r); return; }
    const c = this.ctxFor(r.ctx);
    c.focus = [id, ...c.focus.filter((x) => x !== id)].slice(0, 16);
    // Monocle frames do not depend on the selection, and KWin raises an activated
    // window itself (the focus command raises explicitly): record it, no solve (C12).
    const kind = this.layoutKind(c);
    if (kind === "monocle") c.states.monocle = { selected: id };
    else if (kind === "scrolling") this.scrollActivated(c, id);
    else if (kind === "zones") this.zoneActivated(c, id);
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
   * Outputs whose identity key changed while they stayed connected: an identical monitor came
   * or went, so the connector now tells them apart or no longer needs to (E16). Their contexts,
   * retained preferences and window memberships take the new key with order and layout state
   * intact; the topology change that follows re-solves them. A window whose context cannot be
   * carried over (the new key is already in use) is reclassified instead.
   */
  outputsRekeyed(renames: ReadonlyMap<OutputId, OutputId>): void {
    if (!this.alive || renames.size === 0) return;
    this.trace.record(this.svc.now(), "topology", undefined, { rekeyed: renames.size });
    const moved = new Map<ContextId, ContextKey>();
    for (const c of [...this.contexts.values()]) {
      const to = renames.get(c.key.output);
      if (to === undefined) continue;
      const key: ContextKey = { output: to, desktop: c.key.desktop, activity: c.key.activity };
      const id = contextId(key);
      if (this.contexts.has(id)) continue;
      this.contexts.delete(c.id);
      if (this.dirty.delete(c.id)) this.dirty.add(id);
      if (this.emptied.delete(c.id)) this.emptied.add(id);
      moved.set(c.id, key);
      c.key = key;
      c.id = id;
      this.contexts.set(id, c);
    }
    for (const [id, kept] of [...this.retained]) {
      const to = renames.get(kept.key.output);
      if (to === undefined) continue;
      this.retained.delete(id);
      const key: ContextKey = { output: to, desktop: kept.key.desktop, activity: kept.key.activity };
      this.retained.set(contextId(key), { key, prefs: kept.prefs });
    }
    for (const [id, p] of [...this.parked]) {
      const to = renames.get(p.ctx.output);
      if (to !== undefined) this.parked.set(id, { ...p, ctx: { output: to, desktop: p.ctx.desktop, activity: p.ctx.activity } });
    }
    for (const r of [...this.recs.values()]) {
      const to = r.membership.output === null ? undefined : renames.get(r.membership.output);
      if (to === undefined) continue;
      r.membership = { ...r.membership, output: to };
      const key = r.ctx ? moved.get(contextId(r.ctx)) : undefined;
      if (key) r.ctx = key;
      else if (r.ctx !== null) this.reclassify(r, "output-identity");
    }
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

  /**
   * New configuration activated: settings/rules functions replaced atomically. Only what the
   * change can affect is invalidated (T26, BEHAVIOR §12). A rule change re-evaluates every
   * window's rules, and a context is re-solved only where a window joined or left. A settings
   * change re-solves the contexts whose effective settings differ (a gap-only change
   * reclassifies nothing) and reclassifies windows only where tiling was enabled or disabled.
   * An activation that changed neither (diagnostics) touches no window or context.
   */
  configure(opts: EngineOptions): void {
    const { changes, ...next } = opts;
    const rules = changes ? changes.rules : true, settings = changes ? changes.settings : true;
    this.trace.record(this.svc.now(), "configure", undefined, { rules, settings });
    const prevSettingsFor = this.opts.settingsFor;
    const before = new Map<Ctx, ContextSettings>();
    if (settings) for (const c of this.contexts.values()) before.set(c, this.ctxSettings(c));
    this.opts = { ...this.opts, ...next, deadlineMs: next.deadlineMs ?? this.opts.deadlineMs,
                  readinessMs: next.readinessMs ?? this.opts.readinessMs };
    if (next.traceCapacity !== undefined && next.traceCapacity !== this.trace.capacity) this.trace.resize(next.traceCapacity);
    if (next.traceEnabled !== undefined) this.trace.enabled = next.traceEnabled;
    // Whether tiling was enabled or disabled per context id, filled as contexts are compared.
    const toggled = new Map<ContextId, boolean>();
    if (settings) {
      for (const [c, old] of before) {
        c.settings = null;
        const now = this.ctxSettings(c);
        toggled.set(c.id, old.enabled !== now.enabled);
        if (sameValue(old, now)) continue;
        if (c.states["master-stack"] !== undefined) this.rebaseMasterStack(c, old);
        this.markDirty(c.key);
        this.retryOverflow(c.id); // layout parameters changed (BEHAVIOR §11)
      }
    }
    if (rules) {
      for (const r of this.recs.values()) this.reclassify(r, "config");
      this.retryOverflow("*");
    } else if (settings) {
      // Windows floating where tiling was disabled have no context object to compare.
      const prev = (k: ContextKey): ContextSettings => (prevSettingsFor ? prevSettingsFor(k) : DEFAULT_SETTINGS);
      for (const r of this.recs.values()) {
        if (r.mode === "pending" || r.mode === "excluded") continue;
        const key = this.singleContextKey(r.membership);
        if (key === null) continue;
        const id = contextId(key);
        let flipped = toggled.get(id);
        if (flipped === undefined) {
          flipped = prev(key).enabled !== this.settingsFor(key).enabled;
          toggled.set(id, flipped);
        }
        if (flipped) this.reclassify(r, "config");
      }
    }
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
    // A rule's minSize is a preference (minimum usable slot), never above what the client allows.
    const pref = r.rules?.minSize;
    if (!r.learnedMin && !r.learnedMax && !pref) return r.base;
    const maxW = Math.min(r.base.maxFrame.width, r.learnedMax?.width ?? Infinity);
    const maxH = Math.min(r.base.maxFrame.height, r.learnedMax?.height ?? Infinity);
    return {
      minFrame: {
        width: Math.max(r.base.minFrame.width, r.learnedMin?.width ?? 0, Math.min(pref?.width ?? 0, maxW)),
        height: Math.max(r.base.minFrame.height, r.learnedMin?.height ?? 0, Math.min(pref?.height ?? 0, maxH)),
      },
      maxFrame: { width: maxW, height: maxH },
      fixed: r.base.fixed,
    };
  }

  private reclassify(r: Rec, why: string): void {
    this.counters.reclassified++;
    const key = this.singleContextKey(r.membership);
    const prevMin = r.rules?.minSize;
    r.rules = this.opts.rulesFor ? this.opts.rulesFor(r.meta, key) : null;
    const nextMin = r.rules?.minSize;
    if (prevMin !== nextMin && (!prevMin || !nextMin || prevMin.width !== nextMin.width || prevMin.height !== nextMin.height)) {
      // Rule minSize changed (e.g. a title or context rule started to match): the tile's constraints changed.
      if (r.mode === "tiled" && r.ctx) { this.markDirty(r.ctx); this.retryOverflow(contextId(r.ctx)); }
      else if (isOverflow(r)) this.retryOverflow(null, r.id);
    }
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
      const kept = this.retained.get(id);
      if (kept) {
        this.retained.delete(id);
        this.applyPrefs(c, kept.prefs);
      }
      this.emptied.add(id); // collected again unless a window joins before the flush ends
    }
    return c;
  }

  private applyPrefs(c: Ctx, p: ContextPrefs): void {
    c.layoutOverride = p.layout;
    if (p.masterStack) {
      const ms = c.states["master-stack"] as MasterStackState | undefined;
      c.states["master-stack"] = { ...(ms ?? masterStack.initial(this.ctxSettings(c))), ...p.masterStack };
    }
  }

  /** Preferences a context holds beyond its configuration, or null when it holds none. */
  private prefsOf(c: Ctx): ContextPrefs | null {
    const ms = c.states["master-stack"] as MasterStackState | undefined;
    const conf = ms ? masterStack.initial(this.ctxSettings(c)) : null;
    const tuned = !!ms && !!conf && (ms.ratio !== conf.ratio || ms.masterCount !== conf.masterCount);
    if (c.layoutOverride === null && !tuned) return null;
    return { layout: c.layoutOverride, masterStack: tuned ? { ratio: ms!.ratio, masterCount: ms!.masterCount } : null };
  }

  /**
   * Drop contexts left without members, e.g. an unplugged output's or a visited desktop's,
   * so the model stays bounded (T30). What they hold beyond the configuration is kept in a
   * bounded map (oldest dropped first) and returns with the context. Runs at the end of a
   * flush, over the contexts that emptied since; a context still dirty waits for the next.
   */
  private collectEmpty(): void {
    if (this.emptied.size === 0) return;
    const later = new Set<ContextId>();
    for (const id of this.emptied) {
      const c = this.contexts.get(id);
      if (!c || c.members.length > 0) continue;
      if (this.dirty.has(id)) { later.add(id); continue; }
      const prefs = this.prefsOf(c);
      this.contexts.delete(id);
      if (prefs) this.retain(c.key, prefs);
    }
    this.emptied = later;
  }

  private retain(key: ContextKey, prefs: ContextPrefs): void {
    const id = contextId(key);
    this.retained.delete(id);
    this.retained.set(id, { key, prefs });
    if (this.retained.size > RETAINED_MAX) this.retained.delete(this.retained.keys().next().value as ContextId);
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
    // Scrolling: a new column right of the focused one, or at the end (SCROLLING §2).
    const scrollAnchor = insert === "after-focus" ? focus : null;
    for (const kind of Object.keys(c.states) as LayoutKind[]) {
      const after = kind === "bsp" ? (focus ?? anchor) : kind === "scrolling" ? scrollAnchor : anchor;
      c.states[kind] = LAYOUTS[kind].insert(c.states[kind], r.id, after, input);
    }
    if (r.rules?.zone !== undefined) this.zoneByRule(c, r, r.rules.zone);
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
    if (c.members.length === 0) this.emptied.add(c.id);
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

  /** Writable and its context actually places it (the floating layout and an unassigned zones member: no). */
  private ownsGeometry(r: Rec): boolean {
    if (!this.writable(r)) return false;
    const c = this.contexts.get(contextId(r.ctx!));
    return !!c && !this.placesNothing(c, r.id);
  }

  private inFloatingLayout(r: Rec): boolean {
    const c = r.ctx ? this.contexts.get(contextId(r.ctx)) : undefined;
    return !!c && this.placesNothing(c, r.id);
  }

  /** The context places nothing for this member: the floating layout, or zones without an assignment. */
  private placesNothing(c: Ctx, id: WindowId): boolean {
    const kind = this.layoutKind(c);
    return kind === "floating" || (kind === "zones" && !this.zoneAssigned(c, id));
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
      this.collectEmpty();
      this.sweepParked();
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
    let input = this.solveInput(c, area);
    let state = this.layoutState(c, kind);
    if (kind === "scrolling") {
      input = this.scrollInput(c, input);
      state = this.revealState(c, state, input.focused, input);
    } else if (kind === "zones") state = this.zonePrune(c, state as ZoneState, input);
    if (kind !== "zones" && c.states.zones !== undefined) this.releaseZones(c); // another layout owns the context now
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
    this.noteParking(c, res.slots, res.parked, res.virtual);
    if (kind === "zones") this.noteZones(c, res.notes);
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
    const twins: string[] = [];
    for (const o of this.host.outputs()) {
      this.scales.set(o.id, o.scale);
      if (o.identity === "ambiguous") twins.push(o.name);
    }
    // Identical monitors are told apart by connector only: a port swap swaps their contexts.
    const note = twins.join(",");
    if (note !== this.ambiguousOutputs) {
      this.ambiguousOutputs = note;
      if (note) {
        this.trace.record(this.svc.now(), "outputs-ambiguous", undefined, twins);
        this.svc.log("info", "identical monitors are told apart by their connector", twins);
      }
    }
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
    if (this.zoneInteractionEnded(c, r)) return;
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
      this.sweepParked(); // a command that ended a strip's ownership unparks at once
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
    if (family === "inspect" || id === "plastile.zone.show") return noop("handled by the host adapter");
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
        // Outside the cycle (scrolling): next enters it at the start, previous at the end.
        next = i < 0 ? LAYOUT_CYCLE[action === "next" ? 0 : LAYOUT_CYCLE.length - 1]
          : LAYOUT_CYCLE[(i + (action === "next" ? 1 : LAYOUT_CYCLE.length - 1)) % LAYOUT_CYCLE.length];
      } else if (action === "master-stack" || action === "bsp" || action === "monocle" || action === "floating"
                 || action === "scrolling" || action === "zones") {
        next = action;
      }
      if (next !== null) {
        if (next === cur) return noop(`already ${cur}`);
        if (cur === "zones") this.releaseZones(c); // zoned windows keep their frames (ZONES §2)
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
      this.releaseZones(c);
      c.layoutOverride = null;
      c.states = {};
      this.solveNow(c);
      return ok(c.members.slice());
    }
    if (family === "scroll") return this.scrollCommand(c, r, action);
    if (family === "zone") return this.zoneCommand(c, r, action);
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
      if (r && r.floatRect && r.suspensions.size === 0) { L.cancel(r.ledger); this.parked.delete(id); this.writeRestore(r, r.floatRect); }
    }
  }

  private planRects(c: Ctx): Map<WindowId, Rect> {
    if (this.layoutKind(c) === "scrolling") { const v = this.scrollVirtual(c); if (v) return v; }
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

  /**
   * followOnSend (T24): after a send, show the window's desktop on the output it went to and
   * activate it. The decision is the source context's, read before the send; both calls are
   * plain property writes, and the visibility change arrives as an ordinary event.
   */
  private follow(r: Rec, output: OutputId, desktop: DesktopId | null): void {
    if (desktop !== null && this.host.visibleDesktop(output) !== desktop) this.host.showDesktop(output, desktop);
    if (this.recs.get(r.id) === r) this.activate(r);
  }

  private focusCommand(c: Ctx, r: Rec | null, action: string): { status: CommandStatus; reason?: string; targets: string[] } {
    const scroll = this.layoutKind(c) === "scrolling";
    const ids = scroll ? this.scrollOrder(c) : this.solveInput(c, null).ids;
    if (ids.length === 0) return { status: "noop", reason: "no tiled windows", targets: [] };
    const cur = r && ids.includes(r.id) ? r.id : null;
    let target: WindowId | null = null;
    if (action === "master") target = ids[0];
    else if (action === "next" || action === "previous") {
      const i = cur === null ? -1 : ids.indexOf(cur);
      target = ids[(i + (action === "next" ? 1 : ids.length - 1) + ids.length) % ids.length];
      if (cur === null && action === "previous") target = ids[ids.length - 1];
    } else if (cur === null) target = c.focus.find((id) => ids.includes(id)) ?? ids[0];
    else if (scroll && (action === "up" || action === "down")) target = columnNeighbour(this.layoutState(c, "scrolling"), cur, action, ids);
    else target = neighbour(cur, action as Direction, this.planRects(c));
    if (target === null) return { status: "noop", reason: `nothing ${action}`, targets: [] };
    if (target === cur) return { status: "noop", reason: "already focused", targets: [] };
    const t = this.recs.get(target)!;
    this.activate(t);
    if (scroll) this.scrollFocused(c, target);
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
    const scroll = this.layoutKind(c) === "scrolling";
    if (scroll && action !== "master" && action !== "next" && action !== "previous") return this.scrollMove(c, r, action);
    const ids = scroll ? this.scrollOrder(c) : this.solveInput(c, null).ids;
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
      const follow = this.ctxSettings(c).followOnSend;
      if (!this.host.sendToOutput(r.id, r.gen, dest.id)) return { status: "rejected", reason: "transfer refused", targets: [] };
      // KWin moves an interactively sent window to the destination's current desktop (per-output
      // desktops; Window::finishInteractiveOutputChange) and reports it inside the send, so the
      // membership read now is where the window is shown.
      if (follow) this.follow(r, dest.id, r.membership.desktops.length === 1 ? r.membership.desktops[0] : null);
      return { status: "accepted", targets: [r.id] };
    }
    if (action === "desktop-next" || action === "desktop-previous") {
      const ds = this.host.desktops();
      if (ds.length < 2 || r.membership.desktops.length !== 1) return { status: "noop", reason: "no other desktop", targets: [] };
      const i = ds.indexOf(r.membership.desktops[0]);
      const dest = ds[(i + (action === "desktop-next" ? 1 : ds.length - 1)) % ds.length];
      const out = r.membership.output;
      const follow = this.ctxSettings(c).followOnSend;
      if (!this.host.sendToDesktop(r.id, r.gen, dest)) return { status: "rejected", reason: "transfer refused", targets: [] };
      if (follow && out !== null) this.follow(r, out, dest);
      return { status: "accepted", targets: [r.id] };
    }
    // Structural reinsert next to the directional neighbour.
    if (!this.participates(r) || !sameContext(r.ctx, c.key)) return { status: "noop", reason: "active window is not tiled here", targets: [] };
    if (this.layoutKind(c) === "scrolling") return this.scrollMove(c, r, action);
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

  // ------------------------------------------------------- scrolling (M8, experimental)
  //
  // The strip's viewport follows focus (SCROLLING §4); columns that are not fully visible
  // are parked outside every output with position-only writes. Every parking write is
  // recorded first (`parked`), so KWin reassigning a parked window's output does not move
  // it to another context, and every exit path brings parked windows back (§5).

  /** Solve input for a strip: focus from the engine's own focus history, and the output geometry. */
  private scrollInput(c: Ctx, input: SolveInput): SolveInput {
    const outs = this.host.outputs();
    const outputs: Rect[] = [];
    let own: Rect | null = null;
    for (const o of outs) {
      outputs.push(o.geometry);
      if (o.id === c.key.output) own = o.geometry;
    }
    return { ...input, focused: this.scrollFocus(c), outputs, output: own };
  }

  /**
   * The member whose column must be visible: the most recently focused participant, else the
   * active window when it is a participant (adoption: no activation was observed yet).
   */
  private scrollFocus(c: Ctx): WindowId | null {
    for (const id of c.focus) {
      const r = this.recs.get(id);
      if (r && this.participates(r) && c.members.includes(id)) return id;
    }
    const a = this.activeRec();
    return a && this.participates(a) && c.members.includes(a.id) ? a.id : null;
  }

  private revealState(c: Ctx, state: ScrollState, focus: WindowId | null, input: SolveInput): ScrollState {
    const next = scrolling.reveal!(state, focus, input);
    if (next !== state) c.states.scrolling = next;
    return next;
  }

  /** Scroll the strip so `focus` is shown; true when the viewport moved (the caller solves). */
  private scrollTo(c: Ctx, focus: WindowId | null): boolean {
    const area = this.host.workArea(c.key.output, c.key.desktop);
    if (!isValidArea(area)) return false;
    const state = this.layoutState(c, "scrolling") as ScrollState;
    if (this.revealState(c, state, focus, this.solveInput(c, area)) === state) return false;
    c.revision++;
    return true;
  }

  /** A member was activated (click, Alt+Tab, an application): bring its column into view, solved in the next flush. */
  private scrollActivated(c: Ctx, id: WindowId): void {
    if (this.suspended) return;
    const r = this.recs.get(id);
    if (!r || !this.participates(r)) return;
    if (this.scrollTo(c, id)) { this.markDirty(c.key); this.ensureFlush(); }
  }

  /** A focus command chose `target`: record it and solve once if the viewport moved. */
  private scrollFocused(c: Ctx, target: WindowId): void {
    c.focus = [target, ...c.focus.filter((x) => x !== target)].slice(0, 16);
    if (this.scrollTo(c, target) || this.dirty.has(c.id)) this.solveNow(c);
  }

  /** An activated dialog or other transient floats; its parent's column is scrolled into view. */
  private revealTransientParent(r: Rec): void {
    const parentId = r.meta.transientFor;
    if (parentId === null || this.suspended) return;
    const p = this.recs.get(parentId);
    if (!p || p.mode !== "tiled" || !p.ctx || !this.participates(p)) return;
    const c = this.contexts.get(contextId(p.ctx));
    if (!c || this.layoutKind(c) !== "scrolling") return;
    c.focus = [p.id, ...c.focus.filter((x) => x !== p.id)].slice(0, 16);
    if (this.scrollTo(c, p.id)) { this.markDirty(c.key); this.ensureFlush(); }
  }

  /** Participants in strip order (focus/swap next and previous). */
  private scrollOrder(c: Ctx): WindowId[] {
    return stripOrder(this.layoutState(c, "scrolling"), this.solveInput(c, null).ids);
  }

  /** Virtual (unparked) rectangles for directional navigation: "right" is the next column even when parked. */
  private scrollVirtual(c: Ctx): Map<WindowId, Rect> | null {
    const area = this.host.workArea(c.key.output, c.key.desktop);
    if (!isValidArea(area)) return null;
    const input = this.scrollInput(c, this.solveInput(c, area));
    return scrolling.solve(this.layoutState(c, "scrolling"), input).virtual ?? null;
  }

  /** Record parking intent before the writes, and forget windows that now have an ordinary slot. */
  private noteParking(c: Ctx, slots: ReadonlyMap<WindowId, Rect>, parked: readonly WindowId[] | undefined,
    virtual: ReadonlyMap<WindowId, Rect> | undefined): void {
    if (parked === undefined && this.parked.size === 0) return;
    const set = new Set(parked ?? []);
    for (const [id, target] of slots) {
      if (set.has(id)) this.parked.set(id, { ctx: c.key, rect: target, virtual: virtual?.get(id) ?? target });
      else this.parked.delete(id);
    }
  }

  /**
   * Bring back every parked window that its strip no longer owns (another layout, not tiled,
   * suspended, stopped), or all of them with `force` (unload, suspend, reconcile). A window
   * KWin itself sized (fullscreen, maximized) or the user is dragging is left to KWin until
   * that ends, except when forced.
   */
  private sweepParked(force = false): void {
    if (this.parked.size === 0) return;
    for (const [id, p] of [...this.parked]) {
      const r = this.recs.get(id);
      if (!r) { this.parked.delete(id); continue; }
      if (!force) {
        if (!this.suspended && this.participates(r) && sameContext(r.ctx, p.ctx)) {
          const c = this.contexts.get(contextId(p.ctx));
          if (c && this.layoutKind(c) === "scrolling") continue; // still its strip's
        }
        if (r.suspensions.has("fullscreen") || r.suspensions.has("maximized") || r.suspensions.has("interactive")) continue;
      }
      this.parked.delete(id);
      this.unpark(r, p);
    }
  }

  /**
   * One restore write placing a parked window inside its output's work area: its virtual
   * position clamped into the area (a window larger than the area is shrunk to it). Skipped
   * when the window is already inside (moved back by KWin, the user or a newer request).
   */
  private unpark(r: Rec, p: Parked): void {
    const now = this.host.frame(r.id, r.gen);
    if (now === null) return;
    let area = this.host.workArea(p.ctx.output, p.ctx.desktop);
    if (!isValidArea(area) && r.membership.output !== null) area = this.host.workArea(r.membership.output, p.ctx.desktop);
    if (!isValidArea(area)) area = this.host.outputs()[0]?.geometry ?? null;
    if (!isValidArea(area)) return;
    if (contains(area, now, frameTolerance(this.scales.get(p.ctx.output) ?? 1))) return;
    const w = Math.min(now.width, area.width), h = Math.min(now.height, area.height);
    const x = Math.min(Math.max(p.virtual.x, area.x), area.x + area.width - w);
    const y = Math.min(Math.max(p.virtual.y, area.y), area.y + area.height - h);
    L.cancel(r.ledger);
    this.trace.record(this.svc.now(), "unpark", r.id);
    this.writeRestore(r, rect(x, y, w, h));
  }

  /**
   * KWin assigns a window's output from its frame centre, and a topology change can pull a
   * parked window partly back onto another output. That output change is an expected
   * consequence of parking, not a move by the user: the window keeps its strip's output
   * (and so its context) while its output still exists; the next solve parks it again or
   * brings it into view.
   */
  private keepParkedOutput(r: Rec, m: Membership): Membership {
    const p = this.parked.get(r.id);
    if (!p || m.output === null || m.output === p.ctx.output) return m;
    const prev = r.membership;
    if (m.onAllDesktops !== prev.onAllDesktops || !sameList(m.desktops, prev.desktops) || !sameList(m.activities, prev.activities)) return m;
    if (!this.host.outputs().some((o) => o.id === p.ctx.output)) return m;
    this.trace.record(this.svc.now(), "parked-output", r.id, { reported: m.output, kept: p.ctx.output });
    return { output: p.ctx.output, desktops: m.desktops, onAllDesktops: m.onAllDesktops, activities: m.activities };
  }

  /** plastile.scroll.*: consume, expel, width-cycle, center (SCROLLING §4). */
  private scrollCommand(c: Ctx, r: Rec | null, action: string): { status: CommandStatus; reason?: string; targets: string[] } {
    if (this.layoutKind(c) !== "scrolling") return { status: "noop", reason: "the layout here is not scrolling", targets: [] };
    if (!r || !this.participates(r) || !sameContext(r.ctx, c.key)) return { status: "noop", reason: "active window is not tiled here", targets: [] };
    const state = this.layoutState(c, "scrolling") as ScrollState;
    let o;
    if (action === "consume") o = scrollConsume(state, r.id);
    else if (action === "expel") o = scrollExpel(state, r.id);
    else if (action === "width-cycle") o = cycleWidth(state, r.id, this.ctxSettings(c).scrolling.widthPresets);
    else if (action === "center") {
      const area = this.host.workArea(c.key.output, c.key.desktop);
      if (!isValidArea(area)) return { status: "noop", reason: "no usable area", targets: [] };
      o = scrollCentre(state, r.id, this.solveInput(c, area));
    } else return { status: "rejected", reason: "unsupported command", targets: [] };
    if (!o.changed) return { status: "noop", reason: o.reason ?? "no change", targets: [] };
    c.states.scrolling = o.state;
    this.solveNow(c);
    return { status: "accepted", targets: [r.id] };
  }

  /** swap/move left and right move the focused column; up and down move the window within its column. */
  private scrollMove(c: Ctx, r: Rec, action: string): { status: CommandStatus; reason?: string; targets: string[] } {
    const state = this.layoutState(c, "scrolling") as ScrollState;
    if (action === "left" || action === "right") {
      const o = moveColumn(state, r.id, action);
      if (!o.changed) return { status: "noop", reason: o.reason ?? `nothing ${action}`, targets: [] };
      c.states.scrolling = o.state;
      this.solveNow(c);
      return { status: "accepted", targets: [r.id] };
    }
    if (action !== "up" && action !== "down") return { status: "rejected", reason: "unsupported command", targets: [] };
    const other = columnNeighbour(state, r.id, action, this.solveInput(c, null).ids);
    if (other === null) return { status: "noop", reason: `nothing ${action}`, targets: [] };
    this.swapIn(c, r.id, other);
    this.solveNow(c);
    return { status: "accepted", targets: [r.id, other] };
  }

  // ---------------------------------------------------------- zones (M9, experimental)
  //
  // Manual placement (docs/design/ZONES.md): only windows assigned to a zone, by command or by a
  // rule's `zone`, are placed; the other members of a zones context are ordinary floating windows
  // (placesNothing: no slot, no writes, and where the user puts them is their float rectangle).
  // Assignments live in the context's ZoneState. Leaving the layout, a configuration that removes
  // the zone, suspending and unloading release them without moving any window (releaseZones).

  private zoneAssigned(c: Ctx, id: WindowId): boolean {
    const st = c.states.zones as ZoneState | undefined;
    return !!st && st.assigned[id] !== undefined;
  }

  private zoneState(c: Ctx): ZoneState {
    return this.layoutState(c, "zones") as ZoneState;
  }

  /** One window leaves its zone where it is: no write, and its frame becomes its float rectangle. */
  private zoneRelease(id: WindowId): void {
    this.zoneNotes.delete(id);
    const r = this.recs.get(id);
    if (!r) return;
    L.cancel(r.ledger);
    this.corrections.delete(id);
    const now = this.host.frame(r.id, r.gen);
    if (now) r.frame = now;
    if (r.suspensions.size === 0) r.floatRect = r.frame;
  }

  /** Release every assignment of a context; the zone layout choice is kept. */
  private releaseZones(c: Ctx): void {
    const st = c.states.zones as ZoneState | undefined;
    if (!st) return;
    const next = releaseZones(st);
    if (next === st) return;
    for (const id of Object.keys(st.assigned)) this.zoneRelease(id);
    c.states.zones = next;
    c.revision++;
    this.trace.record(this.svc.now(), "zone", c.id, { released: Object.keys(st.assigned).length });
  }

  private releaseAllZones(): void {
    for (const c of this.contexts.values()) this.releaseZones(c);
  }

  /** Assignments to zones the active zone layout does not have (after a configuration change) are released. */
  private zonePrune(c: Ctx, state: ZoneState, input: SolveInput): ZoneState {
    const p = pruneZones(state, activeZoneLayout(state, input.settings.zones).zones.length);
    if (p.dropped.length === 0) return state;
    for (const id of p.dropped) this.zoneRelease(id);
    c.states.zones = p.state;
    return p.state;
  }

  /** Keep each assigned window's explanation (a minimum size that does not fit its zone) for explain. */
  private noteZones(c: Ctx, notes: readonly string[]): void {
    for (const id of c.members) {
      if (!this.zoneAssigned(c, id)) continue;
      const prefix = id + ": ";
      let note: string | null = null;
      for (const n of notes) if (n.indexOf(prefix) === 0) note = n.slice(prefix.length);
      if (note === null) { this.zoneNotes.delete(id); continue; }
      if (this.zoneNotes.get(id) === note) continue;
      this.zoneNotes.set(id, note);
      this.trace.record(this.svc.now(), "zone", id, { note });
      this.svc.log("info", "zone placement", { id, note });
    }
  }

  /** An activated zoned window becomes the top of its zone (raised by KWin already; no solve). */
  private zoneActivated(c: Ctx, id: WindowId): void {
    const st = c.states.zones as ZoneState | undefined;
    if (st) c.states.zones = bumpZone(st, id);
  }

  /** A rule's `zone: n` assigns a window that joins a zones context (ZONES §2); a missing zone is explained. */
  private zoneByRule(c: Ctx, r: Rec, n: number): void {
    if (this.layoutKind(c) !== "zones") return;
    const st = this.zoneState(c);
    const layout = activeZoneLayout(st, this.ctxSettings(c).zones);
    const o = assignZone(st, r.id, n - 1, layout.zones.length, layout.id);
    if (!o.changed) {
      const why = `${r.rules?.reasons?.zone ?? "rule"}: ${o.reason}; the window floats`;
      this.zoneNotes.set(r.id, why);
      this.trace.record(this.svc.now(), "zone", r.id, { note: why });
      return;
    }
    if (r.suspensions.size === 0) r.floatRect = r.frame;
    c.states.zones = o.state;
    this.zoneNotes.delete(r.id);
  }

  /**
   * The user moved or resized a zoned window: it leaves its zone where the user put it, instead of
   * snapping back (manual placement; never fight the user). One solve, which writes nothing.
   */
  private zoneInteractionEnded(c: Ctx, r: Rec): boolean {
    if (this.layoutKind(c) !== "zones") return false;
    const st = c.states.zones as ZoneState | undefined;
    if (!st || zoneOf(st, r.id) === null) return false;
    this.zoneRelease(r.id);
    c.states.zones = unassignZone(st, r.id).state;
    r.ledger.request = null;
    c.revision++;
    this.markDirty(c.key);
    this.ensureFlush();
    this.trace.record(this.svc.now(), "zone", r.id, { released: "interaction" });
    return true;
  }

  /** plastile.zone.*: assign-1..9, next, previous, unassign, layout-next (ZONES §3). */
  private zoneCommand(c: Ctx, r: Rec | null, action: string): { status: CommandStatus; reason?: string; targets: string[] } {
    const noop = (reason?: string) => ({ status: "noop" as const, reason: reason ?? "no change", targets: [] as string[] });
    if (this.layoutKind(c) !== "zones") return noop("the layout here is not zones");
    const z = this.ctxSettings(c).zones;
    const st = this.zoneState(c);
    if (action === "layout-next") {
      const o = nextZoneLayout(st, z);
      if (!o.changed) return noop(o.reason);
      for (const id of o.dropped) this.zoneRelease(id);
      c.states.zones = o.state;
      this.solveNow(c);
      return { status: "accepted", targets: Object.keys(o.state.assigned) };
    }
    if (!r || !this.participates(r) || !sameContext(r.ctx, c.key)) {
      return noop(r && r.mode === "floating" && r.userMode === "floating"
        ? "the active window was floated by Toggle floating; toggle it back to place it in a zone"
        : "active window is not a member of this zones context");
    }
    const layout = activeZoneLayout(st, z);
    const count = layout.zones.length;
    const m = /^assign-([1-9])$/.exec(action);
    const o = m ? assignZone(st, r.id, Number(m[1]) - 1, count, layout.id)
      : action === "next" ? stepZone(st, r.id, 1, count, layout.id)
      : action === "previous" ? stepZone(st, r.id, -1, count, layout.id)
      : action === "unassign" ? unassignZone(st, r.id) : null;
    if (o === null) return { status: "rejected", reason: "unsupported command", targets: [] };
    if (!o.changed) return noop(o.reason);
    if (zoneOf(o.state, r.id) === null) this.zoneRelease(r.id); // unassigned: stays where it is
    else if (zoneOf(st, r.id) === null && r.suspensions.size === 0) r.floatRect = r.frame; // Toggle floating returns here
    c.states.zones = o.state;
    this.solveNow(c);
    return { status: "accepted", targets: [r.id] };
  }

  private zoneExplain(c: Ctx, r: Rec): Record<string, unknown> {
    const st = (c.states.zones as ZoneState | undefined) ?? null;
    const i = st ? zoneOf(st, r.id) : null;
    return { layout: activeZoneLayout(st, this.ctxSettings(c).zones).id, zone: i === null ? null : i + 1,
             note: this.zoneNotes.get(r.id) ?? null };
  }

  /**
   * What the optional overlay draws on the active output (ZONES §4): the rectangles projectZones
   * gives for the zone layout of the context shown there, the same function and inputs a solve
   * uses, so the overlay cannot disagree with placements. Pure read: creates no context.
   */
  zoneOverlay(): ZoneOverlayModel | { reason: string } {
    if (!this.alive) return { reason: "runtime stopped" };
    const out = this.host.activeOutput();
    if (out === null) return { reason: "no active output" };
    const desk = this.host.visibleDesktop(out);
    if (desk === null) return { reason: "no desktop is shown on the active output" };
    const key: ContextKey = { output: out, desktop: desk, activity: this.host.currentActivity() };
    const c = this.contexts.get(contextId(key));
    const settings = c ? this.ctxSettings(c) : this.settingsFor(key);
    const kind = c ? this.layoutKind(c) : (this.retained.get(contextId(key))?.prefs.layout ?? settings.layout);
    if (kind !== "zones") return { reason: `the layout here is ${kind}, not zones` };
    const area = this.host.workArea(out, desk);
    if (!isValidArea(area)) return { reason: "the output has no usable area" };
    let geometry: Rect = area;
    for (const o of this.host.outputs()) if (o.id === out) geometry = o.geometry;
    const st = c ? (c.states.zones as ZoneState | undefined) ?? null : null;
    const layout = activeZoneLayout(st, settings.zones);
    const rects = projectZones(layout.zones, area, settings.gaps);
    const counts = rects.map(() => 0);
    if (st) for (const id of Object.keys(st.assigned)) if (st.assigned[id] < counts.length) counts[st.assigned[id]]++;
    return { output: out, geometry, area, layout: layout.id, zones: rects.map((r, i) => ({ n: i + 1, rect: r, windows: counts[i] })) };
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
      exception: r.exception, nativeTile: r.nativeTile, nativeYield: r.nativeYield, parked: this.parked.has(r.id),
      zone: c && this.layoutKind(c) === "zones" ? this.zoneExplain(c, r) : null,
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

  /**
   * Layout preferences per context key: live contexts that hold any, then those kept for
   * collected (empty) contexts. The accessor for persistence (T27): contexts themselves may be
   * collected at any flush, so their preferences are read here rather than from the model.
   */
  contextPreferences(): Array<{ key: ContextKey; prefs: ContextPrefs }> {
    const out: Array<{ key: ContextKey; prefs: ContextPrefs }> = [];
    for (const c of this.contexts.values()) {
      const p = this.prefsOf(c);
      if (p) out.push({ key: c.key, prefs: p });
    }
    for (const kept of this.retained.values()) out.push({ key: kept.key, prefs: kept.prefs });
    return out;
  }

  /**
   * Replace a context's preferences (persistence restore): applied to a live context, which is
   * re-solved once, or kept until the context is next used.
   */
  setContextPreferences(key: ContextKey, prefs: ContextPrefs): void {
    if (!this.alive) return;
    const c = this.contexts.get(contextId(key));
    if (!c) { this.retain(key, prefs); return; }
    this.applyPrefs(c, prefs);
    c.revision++;
    this.markDirty(c.key);
    this.ensureFlush();
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
  if (w.minSize !== undefined) actions.minSize = `${w.minSize.width}x${w.minSize.height}`;
  if (w.zone !== undefined) actions.zone = String(w.zone);
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

/** Structural equality of plain data (settings): primitives, arrays and plain objects. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const k of keys) if (!sameValue(x[k], y[k])) return false;
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

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) if (a[i] !== b[i]) return false;
  return true;
}
