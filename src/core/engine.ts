// The single policy authority and single geometry writer (ADR-004, ADR-005).
//
// Events update the model immediately but never solve inline; they mark full
// contexts dirty and schedule one stable flush. Commands run immediately unless
// a transaction is applying, in which case they queue in order. Every external
// frame write goes through applyTarget() and the requested/observed ledger.

import {
  centredDefault, clampInto, contains, frameTolerance, intersects, isFiniteRect, isValidArea, rect, rectNear, rectOf, relocate, sizeNear, type Rect,
  type Size,
} from "./geometry.ts";
import { classify, TINY_PX, TINY_REASON } from "./classify.ts";
import { COMMAND_IDS, type CommandResult, type CommandStatus } from "./commands.ts";
import { DEFAULT_SETTINGS } from "./defaults.ts";
import { newCounters, Trace, type Counters } from "./diagnostics.ts";
import { adjacentOutput, neighbour, wrapNeighbour, type Direction } from "./navigation.ts";
import type { HostPort, RuntimeServices, WindowSnapshot } from "./ports.ts";
import * as L from "./reconcile/ledger.ts";
import type { Layout, LayoutCommand, SolveInput, SolveResult } from "./layouts/layout.ts";
import { masterStack, type MasterStackState } from "./layouts/masterStack.ts";
import { bsp, reinsert as bspReinsert } from "./layouts/bsp.ts";
import { monocle, floating } from "./layouts/monocle.ts";
import { identityKey, matchFloat, type AppIdentity } from "../persist/match.ts";
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

/** Layout registry (exported for tests that substitute a layout; never mutated at runtime). */
export const LAYOUTS: Record<LayoutKind, AnyLayout> = {
  "master-stack": masterStack,
  bsp,
  monocle,
  floating,
  scrolling,
  zones,
};
/** Scrolling and zones are experimental and opt-in (ADR-014): selected explicitly, never by the cycle. */
/** Re-parks per parking target before a pull-back counts against the correction budget. */
export const REPARK_LIMIT = 8;
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

/** The window and output a command targets, resolved once at dispatch. */
interface DispatchTarget {
  readonly active: WindowId | null;
  readonly output: OutputId | null;
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

/**
 * A float rectangle with where it was taken (D6): the output's identity key and that output's
 * work area then, so a restore on another output (or after the output is gone) can place it
 * proportionally inside the current work area.
 */
export interface FloatRect {
  readonly rect: Rect;
  readonly output: OutputId;
  readonly area: Rect;
}

/**
 * What a persisted preference change touched (T27): a context's layout preferences, or the float
 * preference of an application identity (identityKey). Persistence keeps these user decisions over
 * a saved state that arrives later (ADR-020).
 */
export type PersistScope = { readonly context: ContextKey } | { readonly app: string };

/** A user's float decision for an application (T27): kept after its window closes, for persistence. */
export interface FloatPreference {
  readonly app: AppIdentity;
  readonly float: FloatRect;
  /**
   * The window the rectangle was taken from, or "" (ADR-020 addendum). A same-session hint, never
   * identity: when a live window has exactly this id it is the window the user floated, and it
   * keeps the frame it has; otherwise the application identity rule applies (Q06).
   */
  readonly window: WindowId;
}

/** User float decisions kept (newest first out last), as RETAINED_MAX is for contexts. */
export const FLOATS_MAX = 64;

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
  /** Re-parks of a parked scrolling window pulled back by KWin, for the current parking target. */
  reparks: number;
  reparkTarget: Rect | null;
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
  floatRect: FloatRect | null;
  insertedAt: number;
  exception: string | null;
  readyBy: number | null;
  border: { original: boolean; applied: boolean } | null;
  rules: WindowRules | null;
  /** Classified at least once: matched against waiting float preferences then, or at a load (T27). */
  restoreChecked: boolean;
  /**
   * The frame the window had when this runtime adopted it in start(), before any write; null for
   * windows that opened later. A float restored to the same window by its hint keeps this frame:
   * the user may have moved it while Plastile was disabled, and the first solve may have tiled it
   * before the saved state arrived (ADR-020 addendum).
   */
  startFrame: Rect | null;
  /** Activation order (0 = never activated while known): cross-output focus picks the most recent. */
  focusSeq: number;
  /**
   * A window that arrives maximized (ADR-021). "wait": opened after start(), decided in the first
   * flush after it is classified; "watch": it was not maximized then, and a maximize before its first
   * tile request settles (or `openUntil`) still counts as arriving maximized (a client that sets
   * it after its first commit); "requested": Plastile asked KWin to un-maximize it and waits for KWin
   * to report it (Wayland: the client's acknowledgement), until `openUntil`; "hidden": it arrived
   * maximized in a context not shown, decided when that context is shown (nothing is written to a
   * window whose context is hidden); "joining": it takes part in this flush's solve, and is
   * un-maximized only if that solve gives it a slot (it stays maximized when there is no room);
   * null: decided. At most one un-maximize per window: after it, a maximize is honoured as before.
   */
  open: "wait" | "watch" | "requested" | "hidden" | "joining" | null;
  openUntil: number;
  /** What happened to the window's maximize state on open, for explain (null: nothing to say). */
  openNote: string | null;
  /** Plastile un-maximized this window on open (a later maximize is noted as honoured). */
  unmaximized: boolean;
  /**
   * The next plan target is written even when the frame already equals it: KWin's un-maximize
   * moved the requested geometry to the restore rectangle, so a maximized frame equal to the tile
   * (no gaps, one window) would otherwise be configured to the restore size (ADR-021).
   */
  placeOnce: boolean;
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
  /** Output scales and geometries, refreshed on adoption and topology changes (not per command). */
  private scales = new Map<OutputId, number>();
  private outputGeom = new Map<OutputId, Rect>();
  /** Work areas read for float placement, by output and desktop; dropped on topology/work-area changes. */
  private areaCache = new Map<string, Rect>();
  private endedInteractions = new Map<WindowId, "move" | "resize">();
  /**
   * Where each interactive move/resize started (context, layout, member index). A command that
   * moves the window to another slot mid-drag (swap, layout switch, transfer) makes the drag's
   * edges refer to the old slot, so its boundary is not applied (measured on KWin 6.8, whose
   * default Meta+drag also activates the window and so retargets swap commands to it).
   */
  private interactionStart = new Map<WindowId, { ctx: ContextId; kind: LayoutKind; index: number }>();
  /** User float decisions by application identity (live or closed windows), oldest first, bounded. */
  private floatPrefs = new Map<string, FloatPreference>();
  /**
   * Float preferences waiting for a window (T27, Q06): restored from persistence and not matched yet,
   * or of a user-floated window that closed. Oldest first, bounded.
   */
  private pendingFloats = new Map<string, FloatPreference>();
  /** Windows to match against pendingFloats in the next flush (after a burst of adoptions). */
  private restoreChecks = new Set<WindowId>();
  /**
   * Contexts whose layout became floating other than by a command (a configuration activation, a
   * saved layout from the load reply): their members' float rectangles are restored in the next
   * flush, as a layout switch does, once the context is shown.
   */
  private floatLayouts = new Set<Ctx>();
  /**
   * Float restores waiting for the window's tile configure still in flight (E04: KWin drops a write
   * back to the committed size while a configure is outstanding, and the window would land on its
   * tile). Written in the flush after that configure commits (a frame of the requested size) or its
   * deadline passes; that commit is not the user's float position.
   */
  private floatRestores = new Map<WindowId, { size: Rect; until: number }>();
  /** Windows opened after start() whose arrival maximize state is decided in the next flush (ADR-021). */
  private openChecks = new Set<WindowId>();
  /** Windows that arrived maximized in a context not shown: decided when it is shown (ADR-021). */
  private openHidden = new Set<WindowId>();
  /** Windows that arrived maximized and join this flush's solve (ADR-021): un-maximized if given a slot. */
  private openJoining = new Set<WindowId>();
  /**
   * Called (cheaply, possibly from a command) when something persistence saves changed: a
   * context preference or a user float decision. The listener only marks state dirty.
   */
  onPersistChange: ((scope: PersistScope) => void) | null = null;
  /**
   * A command changed a context's layout (layout.*, context.reset), or suspended or resumed
   * tiling: the runtime logs one notice and shows the on-screen display. Called from the command;
   * the listener must not block (the OSD request is deferred to a later turn).
   */
  onLayoutChange: ((key: ContextKey, layout: LayoutKind, previous: LayoutKind) => void) | null = null;
  onSuspendChange: ((suspended: boolean) => void) | null = null;
  /** Windows being resized interactively whose frame changed since the last flush (liveResize). */
  private liveResize = new Set<WindowId>();
  /** The resized frame each live solve used, so an unchanged frame solves nothing. */
  private liveLast = new Map<WindowId, Rect>();
  /** Windows currently parked by a scrolling strip (recorded before each parking write). */
  private parked = new Map<WindowId, Parked>();
  /** Parked windows KWin pulled back (position only) to re-park in the next flush. */
  private reparkQueue = new Set<WindowId>();
  /** Zones: the last explanation per window (minimum size does not fit, rule zone missing). */
  private zoneNotes = new Map<WindowId, string>();
  private queued: Array<{ id: string; arg: unknown; target: DispatchTarget }> = [];
  /** Target resolved at dispatch for a command queued during apply (T11); null otherwise. */
  private dispatchTarget: DispatchTarget | null = null;
  private applying = 0;
  private flushScheduled = false;
  private cancelDeadline: (() => void) | null = null;
  private deadlineAt = Infinity;
  private seq = 0;
  private insertSeq = 0;
  private focusSeq = 0;
  /** Last solve timing; null unless EngineOptions.clockNs is set. */
  lastTiming: SolveTiming | null = null;
  /** Duration of the last host activation call (KWin's own focus work), when measured. */
  lastActivateNs: number | null = null;
  private revision = 0;
  private alive = true;
  private suspended = false;
  /** The first solve after start() is held until releaseHold() (start-up wait for the saved state). */
  private holding = false;
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

  /**
   * Adopt existing windows: classify once, seed order, one solve per visible context.
   *
   * With `hold`, the first solve waits for releaseHold() (ADR-020 addendum): the runtime holds
   * it until the saved state has been applied, or a bounded start-up deadline, so that a restored
   * float or ratio is the first geometry written rather than a correction of a default tile.
   * While held, events and commands update the model as usual and their geometry is kept as
   * dirty work; nothing is solved or corrected and no tile is written.
   */
  start(initial: readonly WindowSnapshot[], hold = false): void {
    this.holding = hold;
    this.refreshScales();
    this.actCount = this.host.activityCount();
    this.actCurrent = this.host.currentActivity();
    for (const s of initial) {
      this.add(s, false);
      const r = this.recs.get(s.id);
      if (r && r.gen === s.gen) r.startFrame = rectOf(s.frame);
    }
    this.markVisibleDirty();
    if (!hold) this.flushNow();
  }

  /**
   * End the start-up hold: the held work (the first solve) runs in the next flush, on a later
   * event-loop turn, so a caller such as the persistence reply callback writes no geometry itself.
   * Idempotent; nothing after stop().
   */
  releaseHold(): void {
    if (!this.holding) return;
    this.holding = false;
    this.trace.record(this.svc.now(), "hold-released");
    this.ensureFlush();
  }

  isHolding(): boolean { return this.holding; }

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
    this.interactionStart.clear();
    this.reparkQueue.clear();
    this.floatPrefs.clear();
    this.pendingFloats.clear();
    this.restoreChecks.clear();
    this.floatLayouts.clear();
    this.floatRestores.clear();
    this.openChecks.clear();
    this.openHidden.clear();
    this.openJoining.clear();
    this.onPersistChange = null;
    this.onLayoutChange = null;
    this.onSuspendChange = null;
    this.liveResize.clear();
    this.liveLast.clear();
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
    this.contexts.forEach((c) => { c.revision++; this.markDirty(c.key); });
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
    this.recs.forEach((r) => {
      L.cancel(r.ledger);
      this.restoreBorder(r);
    });
  }

  // ------------------------------------------------------------------- events

  windowAdded(s: WindowSnapshot): void {
    if (!this.alive) return;
    const r = this.add(s, true);
    // A window opened while Plastile runs: whether it arrived maximized is decided once it is
    // ready (ADR-021). Windows adopted at start(), at a resume or by reconcile are left as they are.
    if (r && !this.suspended) {
      r.open = "wait";
      if (r.mode !== "pending") this.openChecks.add(r.id);
    }
  }

  /** Returns the record when a new one was created (null: stale, or an update of a known window). */
  private add(s: WindowSnapshot, schedule: boolean): Rec | null {
    const dead = this.tombstones.get(s.id);
    if (dead !== undefined && s.gen <= dead) { this.counters.staleEvents++; return null; }
    const existing = this.recs.get(s.id);
    if (existing && existing.gen >= s.gen) { this.updateSnapshot(existing, s); return null; } // C01
    if (existing) this.drop(existing);
    const r: Rec = {
      id: s.id, gen: s.gen, meta: s.meta, membership: s.membership, states: s.states, base: s.constraints,
      learnedMin: null, learnedMax: null, frame: rectOf(s.frame), nativeTile: s.nativeTile, nativeYield: s.nativeTile,
      releasingTile: false,
      decision: { mode: "floating", source: "default", reason: "unclassified", ruleIds: [] },
      mode: "pending", userMode: null, ctx: null, suspensions: suspensionsOf(s.states),
      ledger: L.newEntry(rectOf(s.frame)), floatRect: null, insertedAt: ++this.insertSeq, exception: null,
      readyBy: null, border: null, rules: null, restoreChecked: false, startFrame: null, focusSeq: 0, reparks: 0,
      reparkTarget: null, open: null, openUntil: 0, openNote: null, unmaximized: false, placeOnce: false,
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
    return r;
  }

  private updateSnapshot(r: Rec, s: WindowSnapshot): void {
    r.meta = s.meta; r.membership = s.membership; r.states = s.states; r.base = s.constraints;
    r.frame = rectOf(s.frame); r.nativeTile = s.nativeTile;
    if (s.nativeTile) r.nativeYield = true;
    r.suspensions = this.suspensionsFor(r, s.states);
    this.reclassify(r, "resync");
  }

  windowRemoved(id: WindowId, gen: number): void {
    const r = this.recs.get(id);
    this.tombstones.set(id, Math.max(gen, this.tombstones.get(id) ?? 0));
    if (this.tombstones.size > 4096) this.tombstones.delete(this.tombstones.keys().next().value as WindowId);
    if (!r) return;
    if (r.gen > gen) { this.counters.staleEvents++; return; } // an older generation's removal
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
    this.interactionStart.delete(r.id);
    this.reparkQueue.delete(r.id);
    this.liveResize.delete(r.id);
    this.liveLast.delete(r.id);
    this.parked.delete(r.id);
    this.zoneNotes.delete(r.id);
    this.openChecks.delete(r.id);
    this.openHidden.delete(r.id);
    this.openJoining.delete(r.id);
    this.floatRestores.delete(r.id);
    this.recs.delete(r.id);
    if (r.userMode === "floating") this.releaseFloat(r);
  }

  /**
   * A user-floated window closed: its application's float preference waits for the next window of
   * that application again, as a restored one does (same matching, Q06).
   */
  private releaseFloat(r: Rec): void {
    const key = identityKey(r.meta);
    const p = key === null ? undefined : this.floatPrefs.get(key);
    if (!p || key === null) return;
    this.floatPrefs.delete(key);
    this.pendingFloats.delete(key);
    this.pendingFloats.set(key, p);
    if (this.pendingFloats.size > FLOATS_MAX) this.pendingFloats.delete(this.pendingFloats.keys().next().value as string);
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
    const wasMaximized = r.states.maximized;
    r.states = st;
    if (st.maximized && !wasMaximized) this.maximizedLater(r);
    else if (!st.maximized && r.open === "hidden") this.openShownLater(r, null); // un-maximized while hidden: nothing to decide
    const prevSet = r.suspensions;
    const next = this.suspensionsFor(r, st);
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
    if (st.interactive !== "resize") { this.liveResize.delete(id); this.liveLast.delete(id); }
    if (prevInteractive === "none" && st.interactive !== "none" && r.mode === "tiled" && r.ctx) {
      const c = this.ctxFor(r.ctx);
      this.interactionStart.set(id, { ctx: c.id, kind: this.layoutKind(c), index: c.members.indexOf(id) });
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
      // Explicit native quick tile / tile editor action: yield until adopted (BEHAVIOR §9). It
      // replaces a float decision as Toggle floating back to tiled does: the preference is forgotten.
      if (r.userMode === "floating") this.forgetFloat(r);
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
    const waiting = this.floatRestores.get(id);
    if (waiting && (r.mode === "floating" || this.inFloatingLayout(r))) {
      // A float restore waits for this window's tile configure: what arrives now is that configure
      // or the frame before it, never the user's float position. Its commit lets the restore go.
      L.observe(r.ledger, f);
      if (sizeNear(f, waiting.size, r.ledger.tol)) this.ensureFlush();
      return;
    }
    if (r.mode === "floating" && r.suspensions.size === 0 && r.ledger.status !== "pending") this.captureFloat(r, f);
    if (r.mode !== "tiled") { L.observe(r.ledger, f); return; }
    if (this.inFloatingLayout(r)) {
      // The floating layout places nothing: where the user puts a member is its float
      // rectangle, so a later return to floating does not restore an older snapshot.
      if (this.participates(r)) this.captureFloat(r, f);
      L.observe(r.ledger, f);
      return;
    }
    if (r.suspensions.has("interactive")) {
      // The user owns the frame during the drag. With liveResize, peers follow a resize in the
      // next flush: frames arriving in one event-loop turn coalesce into one solve.
      if (r.states.interactive === "resize" && this.liveResizeOn(r)) { this.liveResize.add(id); this.ensureFlush(); }
      return;
    }
    const o = L.observe(r.ledger, f);
    if (o === "settled") this.endWatch(r); // its first tile arrived: the open phase is over
    switch (o) {
      case "settled":
        this.counters.settled++;
        if (r.exception === DIVERGED) r.exception = null; // a slow client got there after all
        this.trace.record(this.svc.now(), "settled", id);
        this.disarmIfIdle();
        if (this.restoreChecks.has(id)) this.ensureFlush(); // a restore waited for this request
        break;
      case "stale":
        this.counters.stale++;
        if (this.ownsGeometry(r) && !this.shown(r)) { this.deferHidden(r, f); break; }
        if (this.ownsGeometry(r)) {
          // Recorded only when it queues a correction: the reason for that write (T14).
          this.trace.record(this.svc.now(), "stale", id, { frame: f, request: r.ledger.request?.rect ?? null, before: r.ledger.before });
          this.corrections.add(id);
          this.ensureFlush();
        }
        break;
      case "superseded": this.counters.superseded++; break; // the newer configure follows; deadline-bounded

      case "partial": this.counters.partial++; break;
      case "external":
        this.counters.external++;
        // A window on a desktop or activity that is not shown is moved by KWin itself (its
        // work-area check after a panel or output change: physical runbook, KWin 6.7.5) and is
        // never written while hidden: the change invalidates its context, re-solved when shown.
        if (this.ownsGeometry(r) && r.ledger.desired && !this.shown(r)) { this.deferHidden(r, f); break; }
        // KWin 6.8 confines a window to the work area on every configure-acknowledging commit
        // (XdgToplevelWindow::handleRoleCommit -> confineInteractiveMove), which pulls a parked
        // scrolling window back on activation, scale or decoration changes. A position-only
        // pull-back of a parked window is re-parked without spending the correction budget,
        // up to REPARK_LIMIT times per parking target; activation and topology events, the
        // legitimate triggers, restore the allowance, so another tool fighting it still ends.
        if (this.ownsGeometry(r) && r.ledger.desired && this.parked.has(id) && sizeNear(f, r.ledger.desired, r.ledger.tol)) {
          if (!rectNear(r.reparkTarget, r.ledger.desired)) { r.reparkTarget = r.ledger.desired; r.reparks = 0; }
          if (r.reparks < REPARK_LIMIT) { r.reparks++; this.reparkQueue.add(id); this.ensureFlush(); break; }
        }
        // An application (or another tool) changed a settled tile: bounded correction, then stop.
        if (this.ownsGeometry(r) && r.ledger.desired) {
          this.trace.record(this.svc.now(), "external", id, { frame: f, desired: r.ledger.desired });
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
    this.resetReparks();
    const r = this.recs.get(id);
    if (!r) return;
    r.focusSeq = ++this.focusSeq;
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
    this.recheckHiddenOpens();
    this.ensureFlush();
  }

  /** Outputs added/removed/changed, or work areas changed. */
  topologyChanged(): void {
    if (!this.alive) return;
    this.trace.record(this.svc.now(), "topology");
    this.resetReparks();
    this.refreshScales();
    this.syncActivities();
    this.retryOverflow("*"); // work areas may have grown
    this.contexts.forEach((c) => { c.settings = null; this.markDirty(c.key); });
    this.recheckHiddenOpens();
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
    this.refreshScales();
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
      // A key is live or retained, never both (the snapshot rejects a duplicate): the live state is current.
      this.retained.delete(id);
    }
    for (const [id, kept] of [...this.retained]) {
      const to = renames.get(kept.key.output);
      if (to === undefined) continue;
      this.retained.delete(id);
      const key: ContextKey = { output: to, desktop: kept.key.desktop, activity: kept.key.activity };
      // Onto a live context: that one is current. Onto another retained entry: the moved one, of the
      // monitor connected now, replaces it.
      if (!this.contexts.has(contextId(key))) this.retain(key, kept.prefs);
    }
    for (const [id, p] of [...this.parked]) {
      const to = renames.get(p.ctx.output);
      if (to !== undefined) this.parked.set(id, { ...p, ctx: { output: to, desktop: p.ctx.desktop, activity: p.ctx.activity } });
    }
    for (const r of [...this.recs.values()]) {
      const fo = r.floatRect ? renames.get(r.floatRect.output) : undefined;
      if (fo !== undefined) r.floatRect = { ...r.floatRect!, output: fo };
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
    this.areaCache.clear();
    this.contexts.forEach((c) => {
      if (outputs.indexOf(c.key.output) < 0) return;
      this.markDirty(c.key);
      this.retryOverflow(c.id); // the area may have grown (BEHAVIOR §11)
    });
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
    // forEach (PERFORMANCE §7.1): resolving a context's settings calls the host. If a host call ever
    // re-keyed outputs synchronously (outputsRekeyed deletes and re-adds contexts; KwinAdapter stopped
    // doing that from reads, ADR-022), QV4's for...of would leave a context out of the comparison.
    if (settings) this.contexts.forEach((c) => { before.set(c, this.ctxSettings(c)); });
    this.opts = { ...this.opts, ...next, deadlineMs: next.deadlineMs ?? this.opts.deadlineMs,
                  readinessMs: next.readinessMs ?? this.opts.readinessMs };
    if (next.traceCapacity !== undefined && next.traceCapacity !== this.trace.capacity) this.trace.resize(next.traceCapacity);
    if (next.traceEnabled !== undefined) this.trace.enabled = next.traceEnabled;
    // Whether tiling was enabled or disabled per context id, filled as contexts are compared.
    const toggled = new Map<ContextId, boolean>();
    if (settings) {
      before.forEach((old, c) => {
        const prefs = this.prefsOf(c); // against the configuration it had
        c.settings = null;
        const now = this.ctxSettings(c);
        toggled.set(c.id, old.enabled !== now.enabled);
        if (sameValue(old, now)) return;
        if (c.states["master-stack"] !== undefined) this.rebaseMasterStack(c, old);
        // What it holds beyond the configuration changed (a field rebased, or a value set by command
        // that the configuration now equals): saved, so the next start shows what this session does.
        if (!sameValue(prefs, this.prefsOf(c))) this.persistChanged({ context: c.key });
        if (c.layoutOverride === null && old.layout !== "floating" && now.layout === "floating") this.floatLayouts.add(c);
        this.markDirty(c.key);
        this.retryOverflow(c.id); // layout parameters changed (BEHAVIOR §11)
      });
    }
    if (rules) {
      this.recs.forEach((r) => this.reclassify(r, "config"));
      this.retryOverflow("*");
    } else if (settings) {
      // Windows floating where tiling was disabled have no context object to compare.
      const prev = (k: ContextKey): ContextSettings => (prevSettingsFor ? prevSettingsFor(k) : DEFAULT_SETTINGS);
      this.recs.forEach((r) => {
        if (r.mode === "pending" || r.mode === "excluded") return;
        const key = this.singleContextKey(r.membership);
        if (key === null) return;
        const id = contextId(key);
        let flipped = toggled.get(id);
        if (flipped === undefined) {
          flipped = prev(key).enabled !== this.settingsFor(key).enabled;
          toggled.set(id, flipped);
        }
        if (flipped) this.reclassify(r, "config");
      });
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
    this.contexts.forEach((c) => {
      for (const id of c.members) {
        const r = this.recs.get(id);
        if (r && !seen.has(id)) { seen.add(id); order.push(r); }
      }
    });
    this.recs.forEach((r) => { if (!seen.has(r.id)) order.push(r); });
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
    if (!r.restoreChecked && r.mode !== "pending") {
      // Its first classification is its adoption: only then is it matched against waiting float
      // preferences, so a window already in use never takes one on a later, unrelated reclassify.
      r.restoreChecked = true;
      if (this.pendingFloats.size > 0) this.restoreChecks.add(r.id);
    }
    if (r.open === "hidden") this.openShownLater(r, "wait"); // another context: decided again
    if (r.open === "wait" && r.mode !== "pending") this.openChecks.add(r.id); // ready: decided in the next flush
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
    if (mode === "floating" && wasTiled === false && r.floatRect === null && r.suspensions.size === 0) this.captureFloat(r, r.frame);
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
    // forEach, not for...of or a copy (PERFORMANCE §7.1): prefsOf calls the host, and a host that
    // re-keys outputs synchronously (KwinAdapter no longer does, ADR-022) makes outputsRekeyed move an
    // entry of `emptied` to the context's new id. forEach visits the moved entry, which a copy would
    // not; QV4's for...of would skip the entry after it.
    this.emptied.forEach((id) => {
      const c = this.contexts.get(id);
      if (!c || c.members.length > 0) return;
      if (this.dirty.has(id)) { later.add(id); return; }
      const prefs = this.prefsOf(c);
      this.contexts.delete(id);
      if (prefs) this.retain(c.key, prefs);
    });
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
    // Only "interactive" (or nothing) suspends it. Size checks, not for-of: iterating a Set
    // allocates an iterator per call in QV4, and this runs per member in every solve (§16).
    const s = r.suspensions;
    return s.size === 0 || (s.size === 1 && s.has("interactive"));
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
    // forEach (PERFORMANCE §7.1): isVisible reads an output from the host. A host that re-keyed outputs
    // there (KwinAdapter no longer does, ADR-022) deletes and re-adds contexts; QV4's for...of would
    // skip one.
    this.contexts.forEach((c) => {
      if (this.isVisible(c.key) && (!onlyStale || c.applied !== c.revision || this.dirty.has(c.id))) this.dirty.add(c.id);
    });
  }

  private ensureFlush(): void {
    // Held at start-up: the work stays dirty and releaseHold() flushes it.
    if (this.flushScheduled || !this.alive || this.holding) return;
    this.flushScheduled = true;
    this.svc.callLater(this.flushFn);
  }

  /** Run pending work now (used at adoption and by tests). */
  flushNow(): void { this.flush(); }

  private flush(): void {
    if (!this.alive) return;
    this.flushScheduled = false;
    if (this.holding) return; // a flush asked for before the hold (flushNow from a test or the host)
    this.counters.flushes++;
    try {
      this.syncActivities();
      const queued = this.queued;
      this.queued = [];
      for (const q of queued) {
        // Run against the target resolved when the command arrived, not the focus now (T11).
        this.dispatchTarget = q.target;
        try { this.execute(q.id, q.arg); } finally { this.dispatchTarget = null; }
      }
      if (this.suspended) {
        this.dirty.clear(); this.corrections.clear(); this.endedInteractions.clear(); this.liveResize.clear();
        return;
      }
      this.matchRestores();
      this.runFloatRestores();
      this.restoreFloatLayouts();
      this.retryOverflows();
      this.runOpenChecks();
      if (this.endedInteractions.size) {
        const ended = [...this.endedInteractions];
        this.endedInteractions.clear();
        for (const [id, kind] of ended) {
          const r = this.recs.get(id);
          if (r && r.states.interactive === "none") this.contained("interaction end", () => this.interactionEnded(r, kind));
        }
      }
      this.runCorrections();
      this.runReparks();
      const ids = [...this.dirty];
      this.dirty.clear();
      for (const id of ids) {
        const c = this.contexts.get(id);
        if (!c) continue;
        if (!this.isVisible(c.key)) { if (c.members.length) c.revision++; continue; }
        this.solveContained(c);
      }
      if (this.openJoining.size) this.deferUnsolvedJoins();
      if (this.liveResize.size) {
        // After the full solves: a context solved above from the committed state gets the
        // live boundary back in the same flush.
        const live = [...this.liveResize];
        this.liveResize.clear();
        for (const id of live) {
          const r = this.recs.get(id);
          if (r && r.states.interactive === "resize") this.contained("live resize", () => this.liveSolve(r));
        }
      }
      this.collectEmpty();
      this.sweepParked();
    } catch (e) {
      this.counters.errors++;
      this.svc.log("error", "flush failed", String(e));
    }
    if (this.dirty.size > 0 || this.corrections.size > 0 || this.queued.length > 0 || this.openChecks.size > 0) this.ensureFlush();
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
    this.recs.forEach((r) => {
      if (isOverflow(r) && (all || ids.has(r.id) || (r.ctx !== null && ctxs.has(contextId(r.ctx))))) list.push(r);
    });
    list.sort((a, b) => a.insertedAt - b.insertedAt);
    for (const r of list) {
      r.exception = null;
      this.reclassify(r, "overflow-retry");
    }
  }

  private runReparks(): void {
    if (this.reparkQueue.size === 0) return;
    const ids = [...this.reparkQueue];
    this.reparkQueue.clear();
    for (const id of ids) {
      const r = this.recs.get(id);
      if (!r || !this.ownsGeometry(r) || !this.parked.has(id) || !r.ledger.desired) continue;
      if (rectNear(r.frame, r.ledger.desired, r.ledger.tol)) continue;
      if (!this.shown(r)) { this.deferHidden(r, r.frame); continue; }
      this.counters.reparks++;
      this.contained("repark", () => this.write(r, r.ledger.desired!, "repark"));
    }
  }

  /** Activation or topology events may legitimately pull parked windows back (KWin 6.8): fresh allowance. */
  private resetReparks(): void {
    this.parked.forEach((_p, id) => {
      const r = this.recs.get(id);
      if (r) r.reparks = 0;
    });
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
      // Hidden since it was queued: never written while hidden, re-solved when shown.
      if (!this.shown(r)) { this.deferHidden(r, r.frame); continue; }
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

  /** The window's context is shown (a window without a context is never written). */
  private shown(r: Rec): boolean {
    return r.ctx !== null && this.isVisible(r.ctx);
  }

  /**
   * A window of a hidden context changed frame, or its correction or deadline came due while
   * hidden. KWin moves such windows itself (its work-area check after a panel or output change),
   * so this is not drift to correct: nothing is written while hidden, no correction is spent and
   * nothing diverges. Its context is invalidated and re-solved, against the area then current,
   * when it is shown (markVisibleDirty).
   */
  private deferHidden(r: Rec, f: Rect): void {
    this.corrections.delete(r.id);
    this.reparkQueue.delete(r.id);
    const c = r.ctx ? this.contexts.get(contextId(r.ctx)) : undefined;
    if (c && c.applied === c.revision) c.revision++;
    this.trace.record(this.svc.now(), "hidden-external", r.id, { frame: f, desired: r.ledger.desired });
  }

  // ----------------------------------------------------------- solve / apply

  private solveInput(c: Ctx, area: Rect | null): SolveInput {
    const constraints = new Map<WindowId, Constraints>();
    const insertedAt = new Map<WindowId, number>();
    const ids: WindowId[] = [];
    const members = c.members;
    for (let i = 0; i < members.length; ++i) {
      const id = members[i];
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

  /**
   * Position of `id` among the windows the context's solve takes part in (solveInput's `ids`),
   * or -1. The same order without building a whole SolveInput (its maps and KWin reads).
   */
  private participantIndex(c: Ctx, id: WindowId): number {
    const members = c.members;
    let k = 0;
    for (let i = 0; i < members.length; ++i) {
      const r = this.recs.get(members[i]);
      if (!r || !this.participates(r)) continue;
      if (members[i] === id) return k;
      k++;
    }
    return -1;
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
    let res = lay.solve(state, input);
    if (this.openJoining.size) {
      // ADR-021: a window that arrived maximized is un-maximized only now that the solve gives it a
      // slot, before any write; KWin refused: solved again without it, still before any write.
      const j = this.joinFromMaximize(res);
      if (j.again) { this.solveAndApply(c); return; }
      if (j.kept) { const kept = j.kept; res = { ...res, overflow: res.overflow.filter((id) => !kept.has(id)) }; }
    }
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
      // forEach and an index loop rather than for-of: no iterator or entry array per window in QV4 (§16).
      res.slots.forEach((target, id) => {
        const r = this.recs.get(id);
        if (!r || !this.writable(r)) return;
        r.ledger.tol = tol;
        this.applyTarget(r, target);
      });
      const raise = res.raise;
      for (let i = 0; i < raise.length; ++i) {
        const r = this.recs.get(raise[i]);
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
    this.outputGeom.clear();
    this.areaCache.clear();
    const twins: string[] = [];
    for (const o of this.host.outputs()) {
      this.scales.set(o.id, o.scale);
      this.outputGeom.set(o.id, o.geometry);
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
    // Plan validation (T13): a layout bug must never reach KWin as a NaN or empty frame.
    if (!isFiniteRect(target) || target.width < 1 || target.height < 1) {
      this.counters.invalidSlots++;
      this.trace.record(this.svc.now(), "invalid-slot", r.id, target);
      this.svc.log("warn", "layout produced an invalid slot; the window keeps its frame", { id: r.id, target });
      return;
    }
    const now = this.host.frame(r.id, r.gen);
    if (now === null) return; // gone: removal event follows; peers continue
    let dec = L.decideWrite(r.ledger, target, now);
    if (r.placeOnce) { r.placeOnce = false; if (dec === "skip-noop") dec = "write"; }
    switch (dec) {
      case "skip-outstanding": this.counters.skipOutstanding++; L.setDesired(r.ledger, target); return;
      case "skip-noop":
        this.counters.skipNoop++;
        L.acceptNoop(r.ledger, target, this.svc.now());
        this.endWatch(r); // already at its first tile
        return;
      case "skip-diverged": this.counters.skipDiverged++; return;
      default: this.write(r, target, r.ledger.request && rectNear(r.ledger.request.rect, target, r.ledger.tol) ? "correction" : "plan");
    }
  }

  /** The only place that issues frame requests. */
  private write(r: Rec, target: Rect, reason: "plan" | "correction" | "repark"): void {
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
    if (settled) this.endWatch(r); // X11: the first tile applied inside the write
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
    let waiting = this.floatRestores.size > 0;
    this.recs.forEach((r) => {
      if (!waiting && (r.ledger.outstanding || r.readyBy !== null || r.open === "requested")) waiting = true;
    });
    if (waiting) return;
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
      if (r.open === "requested") {
        if (r.openUntil > now) { next = Math.min(next, r.openUntil); continue; }
        this.unmaximizeRefused(r);
        continue;
      }
      const e = r.ledger;
      if (!e.outstanding || e.pendingSince === null) continue;
      const due = e.pendingSince + this.opts.deadlineMs;
      if (due > now) { next = Math.min(next, due); continue; }
      const hidden = this.ownsGeometry(r) && !this.shown(r);
      const x = L.expire(e, this.host.frame(r.id, r.gen), hidden);
      this.trace.record(now, "deadline", r.id, x.kind);
      if (x.kind === "deferred") {
        this.deferHidden(r, this.host.frame(r.id, r.gen) ?? r.frame);
      } else if (x.kind === "learn") {
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
    // Float restores past their deadline are written in the flush below; the others wait on.
    this.floatRestores.forEach((w) => { if (w.until > now) next = Math.min(next, w.until); });
    if (next < Infinity) this.armDeadline(next);
    this.ensureFlush();
  }

  // --------------------------------------------------- arriving maximized (ADR-021)

  /** Suspensions from KWin's states, without the maximize Plastile asked KWin to clear on open. */
  private suspensionsFor(r: Rec, st: WindowStates): Set<Suspension> {
    const next = suspensionsOf(st);
    if (r.open === "requested") {
      // KWin reports an xdg-toplevel's un-maximize only when the client acknowledges the configure.
      if (st.maximized) next.delete("maximized");
      else {
        r.open = null;
        this.trace.record(this.svc.now(), "unmaximized", r.id);
      }
    }
    return next;
  }

  /**
   * The window became maximized. In its open phase (no tile settled yet) this still counts as
   * arriving maximized: decided in the next flush. After Plastile un-maximized it once, a maximize
   * (the application's or the user's) is honoured and noted.
   */
  private maximizedLater(r: Rec): void {
    if (r.open === "watch") {
      if (this.svc.now() <= r.openUntil) {
        r.open = "wait";
        this.openChecks.add(r.id);
        this.ensureFlush();
        return;
      }
      r.open = null;
    }
    if (r.unmaximized && r.open === null) {
      r.openNote = "maximized again after Plastile un-maximized it when it opened; honoured: Plastile un-maximizes a window " +
        "only once, when it opens";
      this.trace.record(this.svc.now(), "remaximized", r.id);
    }
  }

  /**
   * The window's first tile settled: its open phase ends within a millisecond (Date.now() has 1 ms
   * resolution, hence + 1), not at once. KWin applies a commit's geometry before its acknowledged
   * states, so a client that asked to be maximized right after mapping reports the maximize
   * microseconds after the tile, in the same commit; no person maximizes a window that fast.
   */
  private endWatch(r: Rec): void {
    if (r.open === "watch") r.openUntil = Math.min(r.openUntil, this.svc.now() + 1);
  }

  private runOpenChecks(): void {
    if (this.openChecks.size === 0) return;
    const ids = [...this.openChecks];
    this.openChecks.clear();
    for (const id of ids) {
      const r = this.recs.get(id);
      if (r && r.open === "wait") this.contained("open check", () => this.openCheck(r)); // queued once classified
    }
  }

  /**
   * Decide, once, whether a window opened while Plastile runs arrived maximized (the application
   * or KWin chose it, not the user). With maximizedOnOpen "tile", one that would otherwise tile
   * joins this flush's solve, which clears its maximize only if it gets a slot, before any write
   * (joinFromMaximize): KWin coalesces the un-maximize and the tile write into one configure, so
   * it is placed once. In a context not shown it is decided when shown. Full screen or minimized
   * on open, floating windows (rules, dialogs, the user's floats), a context that places nothing,
   * no room (overflow) and "keep" leave the maximize to KWin, as T17 does for any later maximize.
   */
  private openCheck(r: Rec): void {
    r.open = null;
    const c = r.mode === "tiled" && r.ctx ? this.contexts.get(contextId(r.ctx)) : undefined;
    // Full screen or minimized on open (the application's choice too): left as it is, decided now,
    // never later (a deferred decision could un-maximize it after the user restored it).
    const tiles = !!c && !this.placesNothing(c, r.id) && !r.states.fullscreen && !r.states.minimized &&
      r.states.interactive === "none";
    if (!r.states.maximized) {
      if (tiles) { r.open = "watch"; r.openUntil = this.svc.now() + this.opts.deadlineMs; }
      return;
    }
    if (!tiles || !c) return;
    const now = this.svc.now();
    if (this.ctxSettings(c).maximizedOnOpen === "keep") {
      r.openNote = "it opened maximized and stays maximized (maximizedOnOpen: keep)";
      this.trace.record(now, "open-maximized", r.id, { action: "kept", why: "keep" });
      return;
    }
    if (!this.shown(r)) {
      // Never written while its context is hidden: un-maximizing it now would leave it at KWin's
      // restore geometry (or the client's own size) until shown, a second placement. Decided when shown.
      r.open = "hidden";
      this.openHidden.add(r.id);
      r.openNote = "it opened maximized on a desktop or activity not shown; Plastile un-maximizes and tiles it when that is " +
        "shown (maximizedOnOpen: tile)";
      this.trace.record(now, "open-maximized", r.id, { action: "deferred", why: "hidden" });
      return;
    }
    // It takes part in this flush's solve; the solve un-maximizes it if it gets a slot (joinFromMaximize).
    r.open = "joining";
    r.suspensions.delete("maximized");
    this.openJoining.add(r.id);
    this.markDirty(c.key);
  }

  /**
   * A solve's result for the windows joining it from a maximize: those given a slot are
   * un-maximized now, before the solve's writes (one configure: the un-maximize and the tile);
   * one that overflows stays maximized as it arrived (floating it would leave it at KWin's restore
   * geometry, not tiled). `again`: KWin refused one, which then stays maximized; the context is
   * solved again without it before anything is written.
   */
  private joinFromMaximize(res: SolveResult): { again: boolean; kept: Set<WindowId> | null } {
    let again = false;
    let kept: Set<WindowId> | null = null;
    for (const id of res.overflow) {
      const r = this.recs.get(id);
      if (!r || r.open !== "joining") continue;
      this.keepOnOpen(r, "it opened maximized and stays maximized: the layout has no room for it (it would overflow)",
        "no room");
      (kept ??= new Set()).add(id);
    }
    res.slots.forEach((_slot, id) => {
      const r = this.recs.get(id);
      if (r && r.open === "joining" && !this.unmaximizeOnOpen(r)) again = true;
    });
    return { again, kept };
  }

  /** The window stays maximized as it arrived: suspended as for any maximize (T17), and said why. */
  private keepOnOpen(r: Rec, note: string, why: string): void {
    this.openJoining.delete(r.id);
    r.open = null;
    if (r.states.maximized) r.suspensions.add("maximized");
    r.openNote = note;
    this.trace.record(this.svc.now(), "open-maximized", r.id, { action: "kept", why });
  }

  /** Clear the maximize of a joining window given a slot; false when KWin refused (it stays maximized). */
  private unmaximizeOnOpen(r: Rec): boolean {
    this.openJoining.delete(r.id);
    const now = this.svc.now();
    if (!r.states.maximized) { r.open = null; return true; } // already un-maximized meanwhile: tiled as it is
    r.open = "requested";
    r.openUntil = now + this.opts.deadlineMs;
    let ok = false;
    try {
      ok = this.host.unmaximize(r.id, r.gen);
    } catch (e) {
      this.counters.errors++;
      this.svc.log("warn", "unmaximize failed", { id: r.id, error: String(e) });
    }
    if (!ok) {
      this.keepOnOpen(r, "it opened maximized and stays maximized: KWin does not allow un-maximizing it (fixed size, or a " +
        "KWin window rule forces it maximized)", "not maximizable");
      return false;
    }
    // X11 cleared it inside the call (maximizedChanged arrived already, ending the wait).
    if (r.open === "requested" && !r.states.maximized) r.open = null;
    r.unmaximized = true;
    r.openNote = "unmaximized on open: it opened maximized (the application or KWin chose it) and maximizedOnOpen is tile; " +
      "a maximize after that is honoured";
    this.trace.record(now, "open-maximized", r.id, { action: "unmaximized" });
    // Placed from scratch: the tile is a plan write, not a correction of an older request, and it
    // is written even if the maximized frame already equals it (placeOnce).
    r.ledger = L.newEntry(r.frame, r.ledger.tol);
    r.placeOnce = true;
    this.corrections.delete(r.id);
    if (r.open === "requested") this.armDeadline(r.openUntil);
    return true;
  }

  /**
   * Joining windows whose context was not solved in this flush (an invalid work area, a failed
   * solve): left maximized, and decided again when visibility or outputs change.
   */
  private deferUnsolvedJoins(): void {
    for (const id of [...this.openJoining]) {
      const r = this.recs.get(id);
      this.openJoining.delete(id);
      if (!r || r.open !== "joining") continue;
      r.open = "hidden";
      this.openHidden.add(r.id);
      if (r.states.maximized) r.suspensions.add("maximized");
      this.trace.record(this.svc.now(), "open-maximized", r.id, { action: "deferred", why: "not solved" });
    }
  }

  /** Leave the "hidden" state: to be decided again ("wait"), or decided (null: left as it is). */
  private openShownLater(r: Rec, next: "wait" | null): void {
    this.openHidden.delete(r.id);
    r.open = next;
    r.openNote = null;
  }

  /** Visibility or outputs changed: a window that arrived maximized in a context now shown is decided. */
  private recheckHiddenOpens(): void {
    if (this.openHidden.size === 0) return;
    for (const id of [...this.openHidden]) {
      const r = this.recs.get(id);
      if (!r) { this.openHidden.delete(id); continue; }
      if (!this.shown(r)) continue;
      this.openShownLater(r, "wait");
      this.openChecks.add(r.id);
    }
  }

  /**
   * KWin still reports the window maximized when the wait for the un-maximize ends: the client
   * maximized itself again before acknowledging, or the request never reached it. Honoured, never
   * asked again: its tile request is cancelled and it is a maximized member like any other.
   */
  private unmaximizeRefused(r: Rec): void {
    r.open = null;
    if (!r.states.maximized) return;
    L.cancel(r.ledger);
    this.corrections.delete(r.id);
    r.suspensions.add("maximized");
    r.openNote = "Plastile un-maximized it when it opened, but it stayed maximized (the application maximized itself " +
      "again); honoured";
    this.trace.record(this.svc.now(), "remaximized", r.id, { before: "acknowledged" });
    if (r.ctx && r.mode === "tiled") this.markDirty(r.ctx);
  }

  // ------------------------------------------------------------- interaction

  private liveResizeOn(r: Rec): boolean {
    if (!this.participates(r)) return false;
    const c = this.contexts.get(contextId(r.ctx!));
    if (!c || !this.ctxSettings(c).liveResize) return false;
    const kind = this.layoutKind(c);
    return kind === "master-stack" || kind === "bsp";
  }

  /** The boundary commands a resized frame implies: one per edge that moved by at least 1 px from its slot. */
  private boundaryCommands(id: WindowId, f: Rect, slot: Rect): Array<LayoutCommand & { kind: "resize-boundary" }> {
    const out: Array<LayoutCommand & { kind: "resize-boundary" }> = [];
    const edges: Array<["left" | "right" | "top" | "bottom", number]> = [
      ["left", f.x - slot.x], ["right", (f.x + f.width) - (slot.x + slot.width)],
      ["top", f.y - slot.y], ["bottom", (f.y + f.height) - (slot.y + slot.height)],
    ];
    for (const [edge, delta] of edges) if (Math.abs(delta) >= 1) out.push({ kind: "resize-boundary", id, edge, delta });
    return out;
  }

  /**
   * Live peer update during an interactive resize (liveResize, BEHAVIOR §8): the committed
   * layout state with the dragged boundary applied, solved once and written to the peers whose
   * target changed (applyTarget skips the rest). The committed state, plan and revision are not
   * touched: the release still commits the final boundary once (interactionEnded), and a cancel
   * restores the committed slots. The resized window is never written (it is not writable while
   * interactive). Runs only from a flush, so frames in one event-loop turn give one solve.
   */
  /** The window is still in the slot its interaction started in (same context, layout and position). */
  private interactionSlotKept(r: Rec, c: Ctx): boolean {
    const s = this.interactionStart.get(r.id);
    return !!s && s.ctx === c.id && s.kind === this.layoutKind(c) && s.index === c.members.indexOf(r.id);
  }

  private liveSolve(r: Rec): void {
    if (!this.liveResizeOn(r)) return;
    const c = this.contexts.get(contextId(r.ctx!))!;
    if (!this.interactionSlotKept(r, c)) return; // the drag no longer refers to the window's slot
    const slot = c.plan.get(r.id);
    if (!slot || c.applied !== c.revision || !this.isVisible(c.key)) return;
    const f = r.frame;
    const last = this.liveLast.get(r.id);
    if (last && rectNear(last, f)) return;
    this.liveLast.set(r.id, f);
    const area = this.host.workArea(c.key.output, c.key.desktop);
    if (!isValidArea(area)) return;
    const kind = this.layoutKind(c);
    const lay = LAYOUTS[kind];
    const input = this.solveInput(c, area);
    let state = this.layoutState(c, kind);
    for (const cmd of this.boundaryCommands(r.id, f, slot)) {
      const o = lay.command(state, cmd, input);
      if (o.changed) state = o.state;
    }
    const res = lay.solve(state, input);
    this.counters.solves++;
    this.counters.liveSolves++;
    this.trace.record(this.svc.now(), "live-solve", c.id, { id: r.id, n: input.ids.length });
    const tol = frameTolerance(this.scales.get(c.key.output) ?? 1);
    this.applying++;
    try {
      res.slots.forEach((target, id) => {
        if (id === r.id) return;
        const p = this.recs.get(id);
        if (!p || !this.writable(p)) return;
        p.ledger.tol = tol;
        this.applyTarget(p, target);
      });
    } finally {
      this.applying--;
    }
  }

  private interactionEnded(r: Rec, kind: "move" | "resize"): void {
    try {
      this.interpretInteraction(r, kind);
    } finally {
      this.interactionStart.delete(r.id);
    }
  }

  private interpretInteraction(r: Rec, kind: "move" | "resize"): void {
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
      // The first other slot under the drop point, found before the swap changes the plan.
      let onto = null as WindowId | null;
      c.plan.forEach((rect, other) => {
        if (onto === null && other !== r.id && cx >= rect.x && cx < rect.x + rect.width && cy >= rect.y && cy < rect.y + rect.height) {
          onto = other;
        }
      });
      if (onto !== null) this.swapIn(c, r.id, onto);
    } else if (!this.interactionSlotKept(r, c)) {
      // A command moved the window to another slot during the resize: its edges describe the
      // old slot. The window takes its new slot; the layout's ratios stay as they are.
      this.trace.record(this.svc.now(), "interaction-superseded", r.id, { kind });
    } else {
      const input = this.solveInput(c, this.host.workArea(c.key.output, c.key.desktop));
      const kindL = this.layoutKind(c);
      const lay = LAYOUTS[kindL];
      let state = this.layoutState(c, kindL);
      for (const cmd of this.boundaryCommands(r.id, f, slot)) {
        const o = lay.command(state, cmd, input);
        if (o.changed) state = o.state;
      }
      c.states[kindL] = state;
      this.persistChanged({ context: c.key }); // a dragged divider is a ratio preference
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
      this.queued.push({ id, arg, target: { active: this.host.activeWindow(), output: this.host.activeOutput() } });
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
    const a = this.dispatchTarget ? this.dispatchTarget.active : this.host.activeWindow();
    return a === null ? null : this.recs.get(a) ?? null;
  }

  /** Context for a window-level command: the active window's, else the visible context of the active output. */
  private commandCtx(r: Rec | null): Ctx | null {
    if (r && r.ctx) return this.ctxFor(r.ctx);
    return this.visibleCtxOf(null);
  }

  /**
   * Context for a layout-level command (layout, resize, master count, reset): the one the user is
   * looking at. The active window's context when it is visible; otherwise the visible context of
   * the active window's output (a window on another desktop, a pinned window), or of the active
   * output when there is no active window. A command over D-Bus or a shortcut thus never changes
   * a desktop that is not on screen.
   */
  private layoutCtx(r: Rec | null): Ctx | null {
    if (r && r.ctx && this.isVisible(r.ctx)) return this.ctxFor(r.ctx);
    return this.visibleCtxOf(r ? r.membership.output ?? (r.ctx ? r.ctx.output : null) : null);
  }

  /** The visible context of an output (null: the active output at dispatch). */
  private visibleCtxOf(output: OutputId | null): Ctx | null {
    const out = output ?? (this.dispatchTarget ? this.dispatchTarget.output : this.host.activeOutput());
    if (out === null) return null;
    const desk = this.host.visibleDesktop(out);
    if (desk === null) return null;
    return this.ctxFor({ output: out, desktop: desk, activity: this.host.currentActivity() });
  }

  private solveNow(c: Ctx): void {
    c.revision++;
    if (this.suspended) return;
    if (this.holding) { this.dirty.add(c.id); return; } // solved when the start-up hold ends
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
        if (!this.suspended) {
          this.suspended = true;
          // A window still waiting for its open decision is adopted at resume, left as it is (ADR-021).
          this.recs.forEach((w) => { if (w.open === "wait" || w.open === "watch" || w.open === "hidden") w.open = null; });
          this.openChecks.clear();
          this.openHidden.clear();
          this.releaseOwnership();
          this.notify(() => this.onSuspendChange && this.onSuspendChange(true));
          return ok();
        }
        this.suspended = false;
        // Adopt the live state again: owned borders, the readiness waits the suspension
        // cancelled, and one solve per visible context.
        this.recs.forEach((w) => {
          this.applyBorderPolicy(w);
          if (w.readyBy !== null) this.armDeadline(w.readyBy);
        });
        this.contexts.forEach((c) => { c.revision++; this.markDirty(c.key); });
        this.ensureFlush();
        this.notify(() => this.onSuspendChange && this.onSuspendChange(false));
        return ok();
      }
      if (action === "reconcile" || action === "reload-config") return noop("handled by the host adapter");
    }
    if (family === "inspect" || id === "plastile.zone.show") return noop("handled by the host adapter");
    if (this.suspended) return { status: "rejected", reason: "tiling suspended", targets: [] };

    const layoutLevel = family === "layout" || family === "resize" || family === "master" || family === "context";
    const c = layoutLevel ? this.layoutCtx(r) : this.commandCtx(r);
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
        this.persistChanged({ context: c.key });
        this.layoutChanged(c, cur);
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
          const idx = this.participantIndex(c, r.id);
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
      const cur = this.layoutKind(c);
      this.releaseZones(c);
      c.layoutOverride = null;
      c.states = {};
      if (cur !== "floating" && this.layoutKind(c) === "floating") this.restoreFloatRects(c); // as a switch to floating
      this.solveNow(c);
      this.persistChanged({ context: c.key });
      this.layoutChanged(c, cur);
      return ok(c.members.slice());
    }
    if (family === "scroll") return this.scrollCommand(c, r, action);
    if (family === "zone") return this.zoneCommand(c, r, action);
    if (family === "focus") return this.focusCommand(c, r, action);
    if (family === "swap") return this.swapCommand(c, r, action);
    if (family === "move") return this.moveCommand(c, r, action);
    return { status: "rejected", reason: "unsupported command", targets: [] };
  }

  /** Tell the runtime a command changed this context's layout (nothing when it stayed the same). */
  private layoutChanged(c: Ctx, previous: LayoutKind): void {
    const now = this.layoutKind(c);
    if (now !== previous) this.notify(() => this.onLayoutChange && this.onLayoutChange(c.key, now, previous));
  }

  /** A listener's failure is a diagnostic, never the command's failure. */
  private notify(fn: () => void): void {
    if (!this.alive) return;
    try { fn(); } catch (e) { this.counters.errors++; this.svc.log("warn", "notice listener failed", String(e)); }
  }

  private layoutCommand(c: Ctx, cmd: LayoutCommand): { status: CommandStatus; reason?: string; targets: string[] } {
    const kind = this.layoutKind(c);
    const area = this.host.workArea(c.key.output, c.key.desktop);
    const o = LAYOUTS[kind].command(this.layoutState(c, kind), cmd, this.solveInput(c, area));
    if (!o.changed) return { status: "noop", reason: o.reason ?? "no change", targets: [] };
    c.states[kind] = o.state;
    this.solveNow(c);
    this.persistChanged({ context: c.key });
    return { status: "accepted", targets: c.members.slice() };
  }

  private toggleFloat(r: Rec): { status: CommandStatus; reason?: string; targets: string[] } {
    if (r.mode === "excluded") return { status: "noop", reason: "window is excluded: " + r.decision.reason, targets: [] };
    if (r.mode === "tiled") {
      const ctx = r.ctx;
      const inFlight = this.inFlight(r); // read before the transition cancels the ledger
      r.userMode = "floating";
      this.reclassify(r, "toggle-float");
      if (!r.suspensions.size) {
        const t = this.floatTarget(r);
        if (t) { this.restoreFloat(r, t, inFlight); this.captureFloat(r, t); }
      } else this.rememberFloat(r);
      if (ctx) this.solveNow(this.ctxFor(ctx));
      return { status: "accepted", targets: [r.id] };
    }
    if (r.mode === "floating" || r.mode === "native") {
      // Decide before touching anything: a refused tile request changes no state.
      const why = this.whyNotTileable(r, this.singleContextKey(r.membership));
      if (why !== null) return { status: "noop", reason: "cannot tile: " + why, targets: [] };
      // While a float restore waits, the frame may be the tile configure that just committed.
      if (r.suspensions.size === 0 && !this.floatRestores.has(r.id)) this.captureFloat(r, r.frame);
      this.floatRestores.delete(r.id);
      const prevUser = r.userMode;
      if (r.userMode === "floating") this.forgetFloat(r);
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
      if ((r.mode as PlacementMode) !== "tiled") {
        // The solve had no room for it (overflow): nothing was written, and it stays what it was,
        // an overflow float tried again when its inputs change, or the user's float.
        const reason = "cannot tile: " + (r.exception ?? "does not fit");
        r.userMode = prevUser;
        if (prevUser === "floating") { r.exception = null; this.rememberFloat(r); }
        return { status: "noop", reason, targets: [] };
      }
      return { status: "accepted", targets: [r.id] };
    }
    return { status: "noop", reason: "window not ready", targets: [] };
  }

  /** The window's tile request still in flight (its target and when it was issued), or null. */
  private inFlight(r: Rec): { rect: Rect; since: number } | null {
    const e = r.ledger;
    return e.outstanding && e.request && e.pendingSince !== null ? { rect: e.request.rect, since: e.pendingSince } : null;
  }

  /**
   * Restore a window leaving the tiling to its float target: written now, or, while its tile
   * configure is in flight, once that commits or its deadline passes (floatRestores, E04).
   */
  private restoreFloat(r: Rec, target: Rect, inFlight: { rect: Rect; since: number } | null): void {
    if (inFlight === null) { this.writeRestore(r, target); return; }
    const until = inFlight.since + this.opts.deadlineMs;
    this.floatRestores.set(r.id, { size: inFlight.rect, until });
    this.armDeadline(until);
  }

  /** Float restores whose tile configure committed or whose deadline passed (in the flush). */
  private runFloatRestores(): void {
    if (this.floatRestores.size === 0) return;
    const now = this.svc.now();
    const due: WindowId[] = [];
    this.floatRestores.forEach((w, id) => {
      const r = this.recs.get(id);
      if (!r || w.until <= now || sizeNear(r.frame, w.size, r.ledger.tol)) due.push(id);
    });
    for (let i = 0; i < due.length; ++i) {
      const r = this.recs.get(due[i]);
      this.floatRestores.delete(due[i]);
      if (!r || r.suspensions.size !== 0 || !(r.mode === "floating" || this.inFloatingLayout(r))) continue; // tiled again: the plan owns it
      const t = this.floatTarget(r);
      if (t) { L.cancel(r.ledger); this.parked.delete(r.id); this.writeRestore(r, t); }
    }
  }

  /** One restore write for a window leaving the tiling (not tracked for corrections). */
  private writeRestore(r: Rec, target: Rect): void {
    if (rectNear(r.frame, target)) return;
    let fw = null;
    this.applying++;
    try { fw = this.host.applyFrame(r.id, r.gen, target); }
    catch (e) { this.counters.errors++; this.svc.log("warn", "restore failed", String(e)); }
    finally { this.applying--; }
    if (fw) { this.counters.writes++; r.frame = fw.after; this.trace.record(this.svc.now(), "write", r.id, { reason: "restore" }); }
  }

  private restoreFloatRects(c: Ctx): void {
    for (const id of c.members) {
      const r = this.recs.get(id);
      if (!r || !r.floatRect || r.suspensions.size !== 0) continue;
      const t = this.floatTarget(r);
      if (!t) continue;
      const inFlight = this.inFlight(r);
      L.cancel(r.ledger);
      this.parked.delete(id);
      this.restoreFloat(r, t, inFlight);
    }
  }

  /** Contexts that became floating outside a command (floatLayouts), restored once shown. */
  private restoreFloatLayouts(): void {
    if (this.floatLayouts.size === 0) return;
    const list = [...this.floatLayouts];
    this.floatLayouts.clear();
    for (const c of list) {
      if (this.contexts.get(c.id) !== c || this.layoutKind(c) !== "floating") continue; // collected, or another layout since
      if (!this.isVisible(c.key)) { this.floatLayouts.add(c); continue; } // never written while hidden
      // As the layout command: zoned windows keep their frames (released first, ZONES §2).
      this.releaseZones(c);
      this.restoreFloatRects(c);
    }
  }

  /**
   * Remember a floating frame with its output and that output's work area (D6). The output is
   * the one under the frame's centre: KWin reports the frame of a window it moves to another
   * output (an unplug, a drag across outputs) before the output change.
   */
  private captureFloat(r: Rec, f: Rect): void {
    const fr = this.floatRectAt(r, f);
    if (fr === null) return;
    r.floatRect = fr;
    if (r.userMode === "floating") this.rememberFloat(r);
  }

  /** A frame as a float rectangle: with the output under its centre and that output's work area (null if unknown). */
  private floatRectAt(r: Rec, f: Rect): FloatRect | null {
    const cx = f.x + f.width / 2, cy = f.y + f.height / 2;
    const under = (g: Rect | undefined): boolean => !!g && cx >= g.x && cx < g.x + g.width && cy >= g.y && cy < g.y + g.height;
    let out = r.membership.output;
    if (out === null || !under(this.outputGeom.get(out))) {
      let first = null as OutputId | null;
      this.outputGeom.forEach((g, id) => { if (first === null && under(g)) first = id; });
      if (first !== null) out = first;
    }
    if (out === null) return null;
    const area = this.areaOf(out, r);
    return area === null ? null : { rect: f, output: out, area };
  }

  /** Record a user-floated window's rectangle as its application's float preference (T27). */
  private rememberFloat(r: Rec): void {
    const key = identityKey(r.meta);
    if (key === null || r.floatRect === null) return;
    const prev = this.floatPrefs.get(key);
    if (prev && prev.window === r.id && prev.float.output === r.floatRect.output && rectNear(prev.float.rect, r.floatRect.rect, 0)
        && rectNear(prev.float.area, r.floatRect.area, 0)) return;
    this.floatPrefs.delete(key);
    this.pendingFloats.delete(key); // the user's newer decision replaces the saved one
    this.floatPrefs.set(key, { app: { appId: r.meta.appId, resourceName: r.meta.resourceName, role: r.meta.role },
      float: r.floatRect, window: r.id });
    if (this.floatPrefs.size > FLOATS_MAX) this.floatPrefs.delete(this.floatPrefs.keys().next().value as string);
    this.persistChanged({ app: key });
  }

  /** The user tiled a window they had floated: its application no longer has a float preference. */
  private forgetFloat(r: Rec): void {
    const key = identityKey(r.meta);
    if (key === null) return;
    const a = this.floatPrefs.delete(key), b = this.pendingFloats.delete(key);
    if (a || b) this.persistChanged({ app: key });
  }

  private persistChanged(scope: PersistScope): void {
    if (this.alive && this.onPersistChange) this.onPersistChange(scope);
  }

  /**
   * Give windows a restored float preference (T27). A preference whose window hint is this
   * window's id was taken from this very window (ADR-020 addendum): restoreSameWindow. Otherwise
   * only when exactly one live window has the application identity (Q06), and never a preference
   * whose hinted window is live (it belongs to that one); else the window keeps its ordinary
   * insertion and the saved preference waits. Runs in the flush, after every window of a burst
   * (the adoption) is known.
   */
  private matchRestores(): void {
    if (this.restoreChecks.size === 0) return;
    const ids = [...this.restoreChecks];
    this.restoreChecks.clear();
    for (const id of ids) {
      if (this.pendingFloats.size === 0) return;
      const r = this.recs.get(id);
      if (!r || r.userMode !== null || (r.mode !== "tiled" && r.mode !== "floating")) continue;
      if (r.ledger.outstanding) {
        // Its tile request is still in flight (a saved state that arrived after the window was
        // tiled, ADR-020): KWin drops a write back to the committed frame while a configure is
        // outstanding, and the window would land on the tile. Checked again once the request
        // settles or its deadline passes.
        this.restoreChecks.add(id);
        continue;
      }
      const hinted = this.hintedFloat(r.id);
      if (hinted !== null) { this.restoreSameWindow(r, hinted.key, hinted.pref); continue; }
      const key = identityKey(r.meta);
      let live = 0;
      const p = key === null ? undefined : this.pendingFloats.get(key);
      if (p !== undefined && !(p.window !== "" && this.recs.has(p.window))) {
        this.recs.forEach((x) => { if (x.mode !== "excluded" && identityKey(x.meta) === key) live++; });
      }
      const m = matchFloat(this.pendingFloats, key, live);
      if (m.kind === "ambiguous") {
        this.counters.restoreAmbiguous++;
        this.trace.record(this.svc.now(), "restore-ambiguous", r.id, { windows: m.count });
        continue;
      }
      if (m.kind !== "restore") continue;
      this.pendingFloats.delete(key!);
      this.counters.restored++;
      this.trace.record(this.svc.now(), "restore-float", r.id, { by: "app" });
      r.userMode = "floating";
      r.floatRect = m.entry.float;
      this.reclassify(r, "restore");
      if (r.mode === "floating" && r.suspensions.size === 0) {
        const t = this.floatTarget(r);
        if (t) { L.cancel(r.ledger); this.writeRestore(r, t); this.captureFloat(r, t); }
      } else this.rememberFloat(r);
    }
  }

  /** The pending preference whose window hint is `id`, with its key (at most 64 entries are scanned). */
  private hintedFloat(id: WindowId): { key: string; pref: FloatPreference } | null {
    let hit = null as { key: string; pref: FloatPreference } | null;
    this.pendingFloats.forEach((pref, key) => { if (hit === null && pref.window === id) hit = { key, pref }; });
    return hit;
  }

  /**
   * A saved float taken from this very window (its hint is the window's id, so Plastile was
   * disabled and enabled again in the same KWin session). It floats again at the frame it had when
   * this runtime started, where the user left it, moved while Plastile was disabled or not, kept
   * visible by the usual float rules only if needed. The saved rectangle is not used: it was where
   * the window was at unload. One write only if the window is not there now (the first solve may
   * have tiled it before the saved state arrived), and that frame becomes the preference. No
   * ambiguity rule: other windows of the application do not make this one less certain.
   */
  private restoreSameWindow(r: Rec, key: string, p: FloatPreference): void {
    this.pendingFloats.delete(key);
    this.counters.restored++;
    r.userMode = "floating";
    r.floatRect = (r.startFrame ? this.floatRectAt(r, r.startFrame) : null) ?? p.float;
    this.trace.record(this.svc.now(), "restore-float", r.id, { by: "window", rect: r.floatRect.rect });
    this.reclassify(r, "restore");
    if (r.mode === "floating" && r.suspensions.size === 0) {
      const t = this.floatTarget(r);
      if (t) { L.cancel(r.ledger); this.writeRestore(r, t); this.captureFloat(r, t); }
    } else this.rememberFloat(r);
  }

  /** Usable area of an output for a window there (cached until the topology or a work area changes). */
  private areaOf(out: OutputId, r: Rec): Rect | null {
    const desk = r.ctx && r.ctx.output === out ? r.ctx.desktop
      : r.membership.desktops.length === 1 ? r.membership.desktops[0] : this.host.visibleDesktop(out);
    if (desk === null) return null;
    const k = out + "\u241f" + desk;
    const hit = this.areaCache.get(k);
    if (hit) return hit;
    const a = this.host.workArea(out, desk);
    if (!isValidArea(a)) return null;
    this.areaCache.set(k, a);
    return a;
  }

  /**
   * Where a window leaving the tiling goes (BEHAVIOR §3, D6): its float rectangle when that was
   * taken on its current output (moved inside the area only if it lies outside it), the
   * rectangle translated proportionally into the current work area when it was taken on another
   * output (also one since unplugged), or a bounded centred default without one. A work area of
   * the same size at another origin is the output itself moved (a neighbour's resolution or scale
   * changed, the outputs were rearranged): the rectangle moves with it. A work area of another
   * size (a panel, the output's own mode) leaves the rectangle where it is.
   */
  private floatTarget(r: Rec): Rect | null {
    const f = r.floatRect;
    const out = r.membership.output;
    const area = out === null ? null : this.areaOf(out, r);
    if (area === null) return f ? f.rect : null;
    if (!f) {
      const c = this.effectiveConstraints(r);
      return centredDefault(area, c.minFrame, c.maxFrame);
    }
    if (f.output !== out) return relocate(f.rect, f.area, area);
    const moved = sizeNear(f.area, area, 0.5) && !rectNear(f.area, area, 0.5);
    const at = moved ? rect(f.rect.x + area.x - f.area.x, f.rect.y + area.y - f.area.y, f.rect.width, f.rect.height) : f.rect;
    return intersects(at, area) ? at : clampInto(at, area);
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
    if (action === "output-next" || action === "output-previous") return this.focusOutput(r, action === "output-next" ? 1 : -1);
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
    else if (this.ctxSettings(c).focusWrap) target = wrapNeighbour(cur, action as Direction, this.planRects(c));
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

  /**
   * Cross-output focus (BEHAVIOR §7): the output after/before the current one in topology
   * order (navigation.outputOrder, not enumeration order), then the most recently activated
   * eligible window shown there: tiled or floating, not minimized or hidden, on the desktop
   * that output shows and the current activity. Without activation history there, the
   * output's visible context's first tile. Focus only: no solve, no write.
   */
  private focusOutput(r: Rec | null, step: 1 | -1): { status: CommandStatus; reason?: string; targets: string[] } {
    const from = r && r.membership.output !== null ? r.membership.output : this.host.activeOutput();
    const dest = adjacentOutput(this.host.outputs(), from, step);
    if (dest === null) return { status: "noop", reason: "no other output", targets: [] };
    const desk = this.host.visibleDesktop(dest.id);
    const act = this.host.currentActivity();
    let best = null as Rec | null; // assigned in the callback: no narrowing to null
    this.recs.forEach((w) => {
      if (w.mode !== "tiled" && w.mode !== "floating") return;
      if (w.membership.output !== dest.id || w.states.minimized || w.states.hidden) return;
      if (!w.membership.onAllDesktops && (desk === null || !w.membership.desktops.includes(desk))) return;
      if (w.membership.activities.length > 0 && !w.membership.activities.includes(act)) return;
      if (w.focusSeq > 0 && (!best || w.focusSeq > best.focusSeq)) best = w;
    });
    if (!best && desk !== null) {
      const c = this.contexts.get(contextId({ output: dest.id, desktop: desk, activity: act }));
      const first = c ? this.solveInput(c, null).ids[0] : undefined;
      if (first !== undefined) best = this.recs.get(first) ?? null;
    }
    if (!best) return { status: "noop", reason: `no window on output ${dest.name}`, targets: [] };
    this.activate(best);
    if (best.ctx && best.mode === "tiled") {
      const c = this.ctxFor(best.ctx);
      if (this.layoutKind(c) === "monocle" && this.host.raise(best.id, best.gen)) this.counters.raises++;
    }
    return { status: "accepted", targets: [best.id] };
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
      // Topology order, shared with focus.output-next/previous (navigation.outputOrder).
      const dest = r.membership.output === null ? null
        : adjacentOutput(this.host.outputs(), r.membership.output, action === "output-next" ? 1 : -1);
      if (dest === null) return { status: "noop", reason: "no other output", targets: [] };
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
    slots.forEach((target, id) => {
      if (set.has(id)) this.parked.set(id, { ctx: c.key, rect: target, virtual: virtual?.get(id) ?? target });
      else this.parked.delete(id);
    });
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
    if (r.suspensions.size === 0) this.captureFloat(r, r.frame);
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
    // forEach (PERFORMANCE §7.1): a released window's float rectangle reads the work area from the
    // host. A host that re-keyed outputs there (KwinAdapter no longer does, ADR-022) deletes and re-adds
    // contexts; QV4's for...of would skip one. A context visited again under its new id is already
    // released (releaseZones is a no-op then).
    this.contexts.forEach((c) => this.releaseZones(c));
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
    if (r.suspensions.size === 0) this.captureFloat(r, r.frame);
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
    else if (zoneOf(st, r.id) === null && r.suspensions.size === 0) this.captureFloat(r, r.frame); // Toggle floating returns here
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
      suspended: suspendedText(r), paused: this.suspended,
      // What happened to a maximize the window arrived with (ADR-021); absent when nothing did.
      ...(r.openNote !== null ? { onOpen: r.openNote } : {}),
    };
  }

  /** Model invariants for tests and debug builds. Returns violations. */
  check(): string[] {
    const errs: string[] = [];
    const seen = new Map<WindowId, ContextId>();
    this.contexts.forEach((c) => {
      for (const id of c.members) {
        const r = this.recs.get(id);
        if (!r) errs.push(`${c.id}: ghost member ${id}`);
        else if (r.mode !== "tiled") errs.push(`${c.id}: member ${id} is ${r.mode}`);
        else if (!r.ctx || contextId(r.ctx) !== c.id) errs.push(`${id}: member of ${c.id} but ctx differs`);
        if (seen.has(id)) errs.push(`${id}: in two contexts ${seen.get(id)} and ${c.id}`);
        seen.set(id, c.id);
      }
      if (new Set(c.members).size !== c.members.length) errs.push(`${c.id}: duplicate members`);
    });
    this.recs.forEach((r) => {
      if (r.mode === "tiled" && !seen.has(r.id)) errs.push(`${r.id}: tiled but in no context`);
    });
    return errs;
  }

  /** The layout a context uses now, without creating it: a live context's, a kept preference's, or the configured one. */
  layoutAt(key: ContextKey): LayoutKind {
    const id = contextId(key);
    const c = this.contexts.get(id);
    if (c) return this.layoutKind(c);
    const kept = this.retained.get(id);
    return (kept && kept.prefs.layout) || this.settingsFor(key).layout;
  }

  /** The layout the configuration gives a context (what context.reset returns to). */
  configuredLayout(key: ContextKey): LayoutKind {
    return this.settingsFor(key).layout;
  }

  /** Members of a context in order (tests/diagnostics). */
  membersOf(key: ContextKey): WindowId[] {
    return this.contexts.get(contextId(key))?.members.slice() ?? [];
  }

  modeOf(id: WindowId): PlacementMode | null {
    return this.recs.get(id)?.mode ?? null;
  }

  /**
   * Per context: all members, those the layout places now (`tiled`), and those KWin owns for the
   * moment (`suspended`: maximized, full screen, minimized or hidden; they keep their place and
   * return when restored). members = tiled + suspended.
   */
  contextSummary(): Array<{ id: ContextId; layout: LayoutKind; members: number; tiled: number; suspended: number; revision: number;
                            applied: number }> {
    return [...this.contexts.values()].map((c) => {
      let tiled = 0;
      for (const id of c.members) { const r = this.recs.get(id); if (r && this.participates(r)) tiled++; }
      return { id: c.id, layout: this.layoutKind(c), members: c.members.length, tiled, suspended: c.members.length - tiled,
        revision: c.revision, applied: c.applied };
    });
  }

  /**
   * Layout preferences per context key: live contexts that hold any, then those kept for
   * collected (empty) contexts, most recently collected first. The accessor for persistence (T27): contexts themselves may be
   * collected at any flush, so their preferences are read here rather than from the model.
   */
  contextPreferences(): Array<{ key: ContextKey; prefs: ContextPrefs }> {
    const out: Array<{ key: ContextKey; prefs: ContextPrefs }> = [];
    // Two passes over a copy (PERFORMANCE §7.1): prefsOf calls the host, and a host that re-keys outputs
    // synchronously (KwinAdapter no longer does, ADR-022) deletes and re-adds contexts under new keys.
    // Live iteration loses one in QV4 and visits one twice in ECMAScript; a copy visits each context
    // once, and reading the keys after every prefsOf gives the current ones.
    const live = Array.from(this.contexts.values());
    const prefs = live.map((c) => this.prefsOf(c));
    for (let i = 0; i < live.length; ++i) {
      const p = prefs[i];
      if (p) out.push({ key: live[i].key, prefs: p });
    }
    const kept: Array<{ key: ContextKey; prefs: ContextPrefs }> = [];
    this.retained.forEach((k) => { kept.push({ key: k.key, prefs: k.prefs }); });
    for (let i = kept.length - 1; i >= 0; --i) out.push(kept[i]);
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
    const was = this.layoutKind(c);
    this.applyPrefs(c, prefs);
    if (was !== "floating" && this.layoutKind(c) === "floating") this.floatLayouts.add(c);
    c.revision++;
    this.markDirty(c.key);
    this.ensureFlush();
  }

  /**
   * User float decisions per application, most important first: the accessor for persistence (T27).
   * Those of windows open now, newest first, then those waiting for a window (closed this session or
   * restored and not matched yet), newest first; the snapshot keeps the first 64.
   */
  floatPreferences(): FloatPreference[] {
    const live: FloatPreference[] = [], waiting: FloatPreference[] = [];
    this.floatPrefs.forEach((p) => { live.push(p); });
    this.pendingFloats.forEach((p, k) => { if (!this.floatPrefs.has(k)) waiting.push(p); });
    return live.reverse().concat(waiting.reverse());
  }

  /**
   * Float preferences restored from persistence (before start(), or later): each is given to a
   * window of its application when exactly one live window has that identity.
   */
  restoreFloats(prefs: readonly FloatPreference[]): void {
    if (!this.alive) return;
    for (const p of prefs) {
      const key = identityKey(p.app);
      if (key === null || this.floatPrefs.has(key)) continue;
      this.pendingFloats.delete(key);
      this.pendingFloats.set(key, p);
      if (this.pendingFloats.size > FLOATS_MAX) this.pendingFloats.delete(this.pendingFloats.keys().next().value as string);
    }
    // The saved state is matched against every window live now, once (Q06); windows still pending
    // are matched when they are first classified.
    this.recs.forEach((r) => { if (r.mode !== "pending") this.restoreChecks.add(r.id); });
    if (this.restoreChecks.size > 0) this.ensureFlush();
  }

  outstandingCount(): number {
    let n = 0;
    this.recs.forEach((r) => { if (r.ledger.outstanding) n++; });
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

const SUSPENSION_WORDS: Readonly<Record<Suspension, string>> = {
  maximized: "maximized", fullscreen: "full screen", minimized: "minimized", hidden: "hidden", interactive: "",
};

/**
 * Explain's statement for a tiled window that KWin owns for the moment (maximize, full screen,
 * minimize and hide suspend its placement; the policy itself is unchanged), or null. An
 * interactive move or resize is not a suspension: the window keeps its slot.
 */
function suspendedText(r: Rec): string | null {
  if (r.mode !== "tiled") return null;
  const words: string[] = [];
  for (const k of ["maximized", "fullscreen", "minimized", "hidden"] as const) if (r.suspensions.has(k)) words.push(SUSPENSION_WORDS[k]);
  if (words.length === 0) return null;
  return `tiling of this window is suspended while it is ${words.join(" and ")}; it resumes, in the same place, when the window is restored`;
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
  let same = true;
  a.forEach((v) => { if (same && !b.has(v)) same = false; });
  return same;
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
