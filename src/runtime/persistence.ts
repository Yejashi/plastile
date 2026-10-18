// Persisted session preferences (T27, ADR-013): load once at start-up, save as maintenance work.
//
// The store is package/contents/ui/Persistence.qml: two QtCore Settings files (slots) under
// $XDG_STATE_HOME/plastile/ and one one-shot Timer. Writes alternate between the slots and
// carry a generation, so a torn or damaged file leaves the other slot's snapshot usable; the
// newest valid slot wins at load. A save is synchronous file I/O on the compositor thread, so
// it never runs in a command: changes only mark the state dirty, and a one-shot maintenance
// deadline DEBOUNCE_MS after the last change (re-armed, never periodic) or a clean unload
// writes it, and only when the content differs from what the slots already hold.

import type { ContextKey } from "../core/types.ts";
import type { ContextPrefs, FloatPreference } from "../core/engine.ts";
import { buildSnapshot, contentKey, parse, serialize, type Snapshot } from "../persist/snapshot.ts";

/** Quiet time after the last change before the snapshot is written. */
export const DEBOUNCE_MS = 2000;
/** Re-arming for less than this would be noise: write now instead. */
const SLACK_MS = 50;
export const SLOTS = 2;

/** The QML side (Persistence.qml). Every call is synchronous; open/read/write do file I/O. */
export interface StateStore {
  /** Create the slots; "" when ready, otherwise why persistence is unavailable (QtCore missing). */
  open(): string;
  /** Stored text of a slot, "" when absent. */
  read(slot: number): string;
  /** Store a slot and sync it to disk. */
  write(slot: number, text: string): void;
  /** Where the slots live (diagnostics only). */
  location(): string;
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
  /** Measurement builds: CLOCK_MONOTONIC ns around each write. */
  clockNs?: () => number;
}

export type PersistState = "off" | "memory" | "read-only" | "active";

export class Persister {
  /** "active": loads and saves; "memory": QtCore unavailable; "read-only": a newer schema is on disk. */
  state: PersistState = "off";
  writes = 0;
  skipped = 0;
  private dirty = false;
  private armed = false;
  private lastChange = 0;
  private generation = 0;
  private lastSlot = SLOTS - 1;
  private lastContent: string | null = null;
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

  /** Open the slots, apply the newest valid snapshot to the model (before its first solve). One diagnostic at most. */
  load(): Snapshot | null {
    if (!this.store) { this.state = "off"; return null; }
    let why = "";
    try { why = this.store.open(); } catch (e) { why = String(e); }
    if (why !== "") {
      this.state = "memory";
      this.svc.log("warn", "persistence unavailable (QtCore Settings could not be created); preferences are kept in memory only",
        { reason: why.slice(0, 300) });
      return null;
    }
    this.state = "active";
    const problems: string[] = [];
    let best: { snap: Snapshot; slot: number } | null = null;
    let future = false;
    for (let slot = 0; slot < SLOTS; ++slot) {
      let text = "";
      try { text = this.store.read(slot); } catch (e) { problems.push(`slot ${slot}: ${String(e)}`); continue; }
      if (text === "") continue;
      const p = parse(text);
      if (!p.ok) {
        if (p.future) future = true;
        problems.push(`slot ${slot}: ${p.reason}`);
        continue;
      }
      if (!best || p.snapshot.generation > best.snap.generation) best = { snap: p.snapshot, slot };
    }
    if (future) {
      // Keep a newer Plastile's state intact: read what this version understands, write nothing.
      this.state = "read-only";
    }
    if (best) {
      this.generation = best.snap.generation;
      this.lastSlot = best.slot;
      this.lastContent = contentKey(best.snap);
      this.apply(best.snap);
    }
    if (problems.length > 0) {
      const use = best ? `using slot ${best.slot} (generation ${best.snap.generation})` : "using defaults";
      const ro = future ? "; written by a newer Plastile: nothing is saved this session" : "";
      this.svc.log("warn", `saved state rejected: ${problems.join("; ")}; ${use}${ro}`, { location: this.location() });
    } else {
      this.svc.log("info", best ? "saved state loaded" : "no saved state", best
        ? { generation: best.snap.generation, contexts: best.snap.contexts.length, floats: best.snap.floats.length }
        : { location: this.location() });
    }
    return best ? best.snap : null;
  }

  private apply(s: Snapshot): void {
    for (const c of s.contexts) {
      this.model.setContextPreferences({ output: c.outputKey, desktop: c.desktopId, activity: c.activity },
        { layout: c.layout, masterStack: c.masterStack });
    }
    if (s.floats.length > 0) {
      // Oldest first, so the model's bounded map keeps the newest.
      const list: FloatPreference[] = [];
      for (let i = s.floats.length - 1; i >= 0; --i) {
        const f = s.floats[i];
        list.push({ app: { appId: f.appId, resourceName: f.resourceName, role: f.role },
                    float: { rect: f.rect, output: f.outputKey, area: f.area } });
      }
      this.model.restoreFloats(list);
    }
  }

  /** Something persisted changed. Cheap: called from commands; arms the maintenance deadline once. */
  markDirty(): void {
    if (!this.alive || this.state !== "active") return;
    this.dirty = true;
    this.lastChange = this.svc.now();
    if (this.armed || !this.store) return;
    this.armed = true;
    this.store.schedule(DEBOUNCE_MS, this.due);
  }

  private onDue(): void {
    this.armed = false;
    if (!this.alive || !this.dirty || !this.store) return;
    const wait = this.lastChange + DEBOUNCE_MS - this.svc.now();
    if (wait > SLACK_MS) {
      this.armed = true;
      this.store.schedule(wait, this.due);
      return;
    }
    this.flush("deadline");
  }

  /** Write the snapshot now if it changed (maintenance deadline or clean unload; never a command). */
  flush(reason: string): boolean {
    if (this.state !== "active" || !this.store || !this.dirty) return false;
    this.dirty = false;
    const snap = buildSnapshot(this.model.contextPreferences(), this.model.floatPreferences(), this.generation + 1, this.svc.stamp());
    const content = contentKey(snap);
    if (content === this.lastContent) { this.skipped++; return false; }
    const slot = (this.lastSlot + 1) % SLOTS;
    const text = serialize(snap);
    const clock = this.svc.clockNs;
    const t0 = clock ? clock() : 0;
    try {
      this.store.write(slot, text);
    } catch (e) {
      this.svc.log("warn", "saving state failed; preferences stay in memory", { error: String(e) });
      return false;
    }
    const ns = clock ? clock() - t0 : null;
    this.generation = snap.generation;
    this.lastSlot = slot;
    this.lastContent = content;
    this.writes++;
    this.svc.log("debug", "state saved", { reason, slot, generation: snap.generation, bytes: text.length, writeNs: ns });
    return true;
  }

  /** Clean unload: one final write if dirty, then no timer and no further work. */
  shutdown(): void {
    if (!this.alive) return;
    if (this.armed && this.store) { try { this.store.cancel(); } catch (_e) { /* gone */ } }
    this.armed = false;
    try { this.flush("unload"); } catch (e) { this.svc.log("warn", "saving state at unload failed", { error: String(e) }); }
    this.alive = false;
  }

  /** Diagnostics (counters command). */
  summary(): { state: PersistState; generation: number; writes: number; skipped: number; dirty: boolean; armed: boolean } {
    return { state: this.state, generation: this.generation, writes: this.writes, skipped: this.skipped, dirty: this.dirty,
             armed: this.armed };
  }

  private location(): string {
    try { return this.store ? this.store.location() : ""; } catch (_e) { return ""; }
  }
}
