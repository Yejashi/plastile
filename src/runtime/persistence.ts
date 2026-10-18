// Persisted session preferences (T27; ADR-013, write path superseded by ADR-020).
//
// The store is package/contents/ui/Persistence.qml: asynchronous calls to the plastile-state
// helper (org.kde.plastile.State, D-Bus activated) and one one-shot Timer. KWin's thread does
// no persistence file I/O: the helper owns the two slot files under $XDG_STATE_HOME/plastile/.
//
// Load: one Read request at start-up. Tiling starts at once with defaults; when the reply
// arrives the newest valid slot is applied, except for what the user already changed since
// start-up (that context, that application's float), and affected contexts re-solve through
// the engine's normal flush. Save: changes only mark the state dirty; a one-shot maintenance
// deadline DEBOUNCE_MS after the last change (re-armed, never periodic) or a clean unload issues
// one Write, and only when the content differs. Writes alternate between the slots and carry a
// generation, so a damaged file leaves the other slot's snapshot usable. Nothing is written
// before the load reply arrives, one write is in flight at a time, and no request is retried by
// itself: a missing helper means in-memory preferences and one diagnostic.

import type { ContextKey } from "../core/types.ts";
import type { ContextPrefs, FloatPreference, PersistScope } from "../core/engine.ts";
import { identityKey } from "../persist/match.ts";
import { buildSnapshot, contentOf, parse, serialize, type Snapshot } from "../persist/snapshot.ts";

/** Quiet time after the last change before the snapshot is written. */
export const DEBOUNCE_MS = 2000;
/** Re-arming for less than this would be noise: write now instead. */
const SLACK_MS = 50;
export const SLOTS = 2;
/** The helper's D-Bus name (diagnostics). */
export const HELPER = "org.kde.plastile.State";

/**
 * The QML side (Persistence.qml). Calls return at once; each reply arrives later on the event
 * loop, exactly one callback per request, and never after unload.
 */
export interface StateStore {
  /** Ask the helper for both slots: done(texts) with two strings ("" for an absent slot), or fail(). */
  read(done: (texts: unknown) => void, fail: () => void): void;
  /** Ask the helper to replace a slot: done(true) once stored, done(false) when it refused, failed or is absent. */
  write(slot: number, text: string, done: (ok: boolean) => void): void;
  /** Arm the one-shot maintenance timer (replacing an armed one). */
  schedule(ms: number, fn: () => void): void;
  cancel(): void;
}

/** The engine's persistence accessors. */
export interface PrefsModel {
  contextPreferences(): Array<{ key: ContextKey; prefs: ContextPrefs }>;
  setContextPreferences(key: ContextKey, prefs: ContextPrefs): void;
  floatPreferences(): FloatPreference[];
  restoreFloats(prefs: readonly FloatPreference[]): void;
}

export interface PersistServices {
  now(): number;
  log(level: "error" | "warn" | "info" | "debug", message: string, data?: unknown): void;
  /** Wall-clock timestamp for savedAt (informational only). */
  stamp(): string;
  /** Measurement builds: CLOCK_MONOTONIC ns around issuing a write and applying the load reply. */
  clockNs?: () => number;
}

/**
 * "loading": the Read reply has not arrived; "active": loads and saves; "memory": no helper
 * (or it failed to answer the load); "read-only": a newer schema is stored.
 */
export type PersistState = "off" | "loading" | "memory" | "read-only" | "active";

interface Pending { slot: number; generation: number; content: string; changedSince: boolean }

function ctxId(k: ContextKey): string {
  return `${k.output}␟${k.desktop}␟${k.activity}`;
}

export class Persister {
  state: PersistState = "off";
  /** Writes the helper confirmed. */
  writes = 0;
  /** Writes issued (confirmed, failed or still in flight). */
  issued = 0;
  failed = 0;
  skipped = 0;
  private dirty = false;
  private armed = false;
  private lastChange = 0;
  /** Committed (confirmed) slot state. */
  private generation = 0;
  private lastSlot = SLOTS - 1;
  private lastContent: string | null = null;
  /** The write in flight; at most one. */
  private inflight: Pending | null = null;
  private failing = false;
  /** User decisions made before the load reply: they win over the saved state. */
  private touchedContexts = new Set<string>();
  private touchedApps = new Set<string>();
  private alive = true;
  private readonly due = (): void => this.onDue();
  private readonly store: StateStore | undefined;
  private readonly model: PrefsModel;
  private readonly svc: PersistServices;

  constructor(store: StateStore | undefined, model: PrefsModel, svc: PersistServices) {
    this.store = store;
    this.model = model;
    this.svc = svc;
  }

  /** Request the saved state. Returns at once; the reply is applied when it arrives (onLoaded). */
  load(): void {
    if (!this.store) { this.state = "off"; return; }
    this.state = "loading";
    try {
      this.store.read((texts) => this.onLoaded(texts), () => this.onLoadFailed("no reply"));
    } catch (e) {
      this.onLoadFailed(String(e));
    }
  }

  private onLoadFailed(why: string): void {
    if (!this.alive || this.state !== "loading") return;
    this.state = "memory";
    this.dirty = false;
    this.touchedContexts.clear();
    this.touchedApps.clear();
    this.svc.log("warn", `persistence unavailable (the ${HELPER} helper did not answer: not installed or failed); `
      + "preferences are kept in memory only", { reason: why.slice(0, 300) });
  }

  private onLoaded(texts: unknown): void {
    if (!this.alive || this.state !== "loading") return;
    const t = texts as ArrayLike<unknown> | null;
    if (!t || typeof t !== "object" || typeof t.length !== "number" || t.length < SLOTS) {
      this.onLoadFailed("malformed Read reply");
      return;
    }
    const clock = this.svc.clockNs;
    const t0 = clock ? clock() : 0;
    this.state = "active";
    const problems: string[] = [];
    let best: { snap: Snapshot; slot: number; text: string } | null = null;
    let future = false;
    for (let slot = 0; slot < SLOTS; ++slot) {
      const text = t[slot];
      if (typeof text !== "string") { problems.push(`slot ${slot}: not text`); continue; }
      if (text === "") continue;
      const p = parse(text);
      if (!p.ok) {
        if (p.future) future = true;
        problems.push(`slot ${slot}: ${p.reason}`);
        continue;
      }
      if (!best || p.snapshot.generation > best.snap.generation) best = { snap: p.snapshot, slot, text };
    }
    const parseNs = clock ? clock() - t0 : null;
    // Keep a newer Plastile's state intact: read what this version understands, write nothing.
    if (future) this.state = "read-only";
    let kept = 0;
    if (best) {
      this.generation = best.snap.generation;
      this.lastSlot = best.slot;
      this.lastContent = contentOf(best.text);
      kept = this.apply(best.snap);
    }
    this.touchedContexts.clear();
    this.touchedApps.clear();
    const applyNs = clock ? clock() - t0 : null;
    if (problems.length > 0) {
      const use = best ? `using slot ${best.slot} (generation ${best.snap.generation})` : "using defaults";
      const ro = future ? "; written by a newer Plastile: nothing is saved this session" : "";
      this.svc.log("warn", `saved state rejected: ${problems.join("; ")}; ${use}${ro}`);
    } else {
      this.svc.log("info", best ? "saved state loaded" : "no saved state", best
        ? { generation: best.snap.generation, contexts: best.snap.contexts.length, floats: best.snap.floats.length,
            keptUserChanges: kept, applyNs, parseNs }
        : { applyNs, parseNs });
    }
    if (this.state !== "active") { this.dirty = false; return; }
    // Changes made while the load was pending are saved now, a quiet period after the last one.
    if (this.dirty) this.arm();
  }

  /** Apply a snapshot, skipping what the user changed since start-up; returns how many entries were kept from the user. */
  private apply(s: Snapshot): number {
    let kept = 0;
    for (const c of s.contexts) {
      const key = { output: c.outputKey, desktop: c.desktopId, activity: c.activity };
      if (this.touchedContexts.has(ctxId(key))) { kept++; continue; }
      this.model.setContextPreferences(key, { layout: c.layout, masterStack: c.masterStack });
    }
    if (s.floats.length > 0) {
      // Oldest first, so the model's bounded map keeps the newest.
      const list: FloatPreference[] = [];
      for (let i = s.floats.length - 1; i >= 0; --i) {
        const f = s.floats[i];
        const app = { appId: f.appId, resourceName: f.resourceName, role: f.role };
        const k = identityKey(app);
        if (k !== null && this.touchedApps.has(k)) { kept++; continue; }
        list.push({ app, float: { rect: f.rect, output: f.outputKey, area: f.area }, window: f.windowHint });
      }
      if (list.length > 0) this.model.restoreFloats(list);
    }
    return kept;
  }

  /** Something persisted changed. Cheap: called from commands; arms the maintenance deadline once. */
  markDirty(scope?: PersistScope): void {
    if (!this.alive) return;
    if (this.state === "loading") {
      // Saved after the load reply; meanwhile the user's decision is remembered so the reply cannot undo it.
      if (scope) {
        if ("context" in scope) this.touchedContexts.add(ctxId(scope.context));
        else this.touchedApps.add(scope.app);
      }
      this.dirty = true;
      this.lastChange = this.svc.now();
      return;
    }
    if (this.state !== "active") return;
    this.dirty = true;
    this.lastChange = this.svc.now();
    if (this.inflight) this.inflight.changedSince = true;
    this.arm();
  }

  private arm(): void {
    if (this.armed || !this.store || this.inflight) return; // a write in flight re-arms on its reply
    const wait = Math.max(this.lastChange + DEBOUNCE_MS - this.svc.now(), SLACK_MS);
    this.armed = true;
    this.store.schedule(wait, this.due);
  }

  private onDue(): void {
    this.armed = false;
    if (!this.alive || !this.dirty || !this.store || this.inflight) return;
    const wait = this.lastChange + DEBOUNCE_MS - this.svc.now();
    if (wait > SLACK_MS) {
      this.armed = true;
      this.store.schedule(wait, this.due);
      return;
    }
    this.flush("deadline");
  }

  /**
   * Issue one Write of the snapshot if it changed (maintenance deadline or clean unload; never a
   * command). At unload a write may already be in flight; the final one then follows it (the bus
   * keeps their order) into the other slot, assuming the first succeeds.
   */
  flush(reason: string): boolean {
    if (this.state !== "active" || !this.store || !this.dirty) return false;
    if (this.inflight && reason !== "unload") return false;
    const clock = this.svc.clockNs;
    const t0 = clock ? clock() : 0;
    const base = this.inflight ?? { slot: this.lastSlot, generation: this.generation, content: this.lastContent };
    this.dirty = false;
    const snap = buildSnapshot(this.model.contextPreferences(), this.model.floatPreferences(), base.generation + 1, this.svc.stamp());
    const t1 = clock ? clock() : 0;
    const text = serialize(snap);
    const content = contentOf(text);
    if (content === base.content) { this.skipped++; return false; }
    const slot = (base.slot + 1) % SLOTS;
    const t2 = clock ? clock() : 0;
    const pending: Pending = { slot, generation: snap.generation, content, changedSince: false };
    this.inflight = pending;
    this.issued++;
    try {
      this.store.write(slot, text, (ok) => this.onWritten(pending, ok, text.length));
    } catch (e) {
      this.inflight = null;
      this.dirty = true;
      this.writeFailed(String(e));
      return false;
    }
    const t3 = clock ? clock() : 0;
    // Measurement builds: issueNs = buildNs (preferences to snapshot) + serializeNs (text and content) + callNs (the store).
    this.svc.log("debug", "state save issued", { reason, slot, generation: snap.generation, bytes: text.length,
      issueNs: clock ? t3 - t0 : null, buildNs: clock ? t1 - t0 : null, serializeNs: clock ? t2 - t1 : null,
      callNs: clock ? t3 - t2 : null });
    return true;
  }

  private onWritten(p: Pending, ok: boolean, bytes: number): void {
    if (!this.alive || this.inflight !== p) return;
    this.inflight = null;
    if (ok) {
      this.generation = p.generation;
      this.lastSlot = p.slot;
      this.lastContent = p.content;
      this.writes++;
      this.failing = false;
      this.svc.log("debug", "state saved", { slot: p.slot, generation: p.generation, bytes });
    } else {
      // Not retried by itself: the content is saved with the next change (or at unload).
      this.dirty = true;
      this.writeFailed(`${HELPER} did not store slot ${p.slot}`);
      if (!p.changedSince) return;
    }
    if (this.dirty) this.arm();
  }

  private writeFailed(why: string): void {
    this.failed++;
    // One diagnostic per run of failures; the next success ends the run.
    this.svc.log(this.failing ? "debug" : "warn", "saving state failed; preferences stay in memory until a later save succeeds",
      { error: why.slice(0, 300) });
    this.failing = true;
  }

  /** Clean unload: one final write if dirty, then no timer, no further work, and replies are ignored. */
  shutdown(): void {
    if (!this.alive) return;
    if (this.armed && this.store) { try { this.store.cancel(); } catch (_e) { /* gone */ } }
    this.armed = false;
    if (this.state === "loading" && this.dirty) {
      // The slots' generations are unknown until the reply: writing now could replace the newest slot.
      this.svc.log("info", "unloaded before the saved state arrived; this session's changes were not saved");
    }
    try { this.flush("unload"); } catch (e) { this.svc.log("warn", "saving state at unload failed", { error: String(e) }); }
    this.alive = false;
  }

  /** Diagnostics (counters command). */
  summary(): { state: PersistState; generation: number; writes: number; issued: number; failed: number; skipped: number;
               dirty: boolean; armed: boolean; inflight: boolean } {
    return { state: this.state, generation: this.generation, writes: this.writes, issued: this.issued, failed: this.failed,
             skipped: this.skipped, dirty: this.dirty, armed: this.armed, inflight: this.inflight !== null };
  }
}
