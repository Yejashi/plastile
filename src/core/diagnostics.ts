// Bounded in-memory trace and counters. Formatting happens only on export.

export interface Counters {
  solves: number;
  flushes: number;
  commands: number;
  commandsQueued: number;
  writes: number;
  corrections: number;
  skipOutstanding: number;
  skipNoop: number;
  skipDiverged: number;
  observations: number;
  observationsDuringApply: number;
  settled: number;
  /** Late commits of an older target with nothing newer following (E04): corrected. */
  stale: number;
  /** Late commits of an older target while the newer request is still on its way (D8): not corrected. */
  superseded: number;
  partial: number;
  external: number;
  learned: number;
  /** Deadline expiries accepted as the client's own rounding (ledger ROUNDING). */
  accepted: number;
  diverged: number;
  deadlines: number;
  overflow: number;
  /** Window classifications (rule evaluation included): adoption, metadata, membership, activation. */
  reclassified: number;
  adopted: number;
  removed: number;
  staleEvents: number;
  errors: number;
  raises: number;
  activations: number;
  /** Float preferences restored from persistence to the one live window of their application (T27). */
  restored: number;
  /** Restores skipped because several live windows had the application identity (Q06). */
  restoreAmbiguous: number;
  /** Solves for live peer updates during an interactive resize (liveResize); also counted in solves. */
  liveSolves: number;
  /** Parked scrolling windows re-parked after KWin pulled them back (KWin 6.8 confinement). */
  reparks: number;
}

export function newCounters(): Counters {
  return {
    solves: 0, flushes: 0, commands: 0, commandsQueued: 0, writes: 0, corrections: 0, skipOutstanding: 0,
    skipNoop: 0, skipDiverged: 0, observations: 0, observationsDuringApply: 0, settled: 0, stale: 0,
    superseded: 0, partial: 0, external: 0, learned: 0, accepted: 0, diverged: 0, deadlines: 0, overflow: 0, reclassified: 0, adopted: 0, removed: 0,
    staleEvents: 0, errors: 0, raises: 0, activations: 0, liveSolves: 0, restored: 0, restoreAmbiguous: 0, reparks: 0,
  };
}

export interface TraceRecord {
  readonly t: number;
  readonly kind: string;
  readonly id?: string;
  readonly data?: unknown;
}

/** Fixed-capacity ring buffer. Recording is O(1) and allocation-light. */
export class Trace {
  private buf: Array<TraceRecord | undefined>;
  private next = 0;
  private count = 0;
  enabled: boolean;

  constructor(capacity: number, enabled = true) {
    this.buf = new Array(Math.max(1, capacity));
    this.enabled = enabled;
  }

  get capacity(): number { return this.buf.length; }

  record(t: number, kind: string, id?: string, data?: unknown): void {
    if (!this.enabled) return;
    this.buf[this.next] = { t, kind, id, data };
    this.next = (this.next + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
  }

  /** Oldest-first copy. Titles are never recorded, so export needs no redaction pass. */
  snapshot(): TraceRecord[] {
    const out: TraceRecord[] = [];
    const start = (this.next - this.count + this.buf.length) % this.buf.length;
    for (let i = 0; i < this.count; ++i) {
      const r = this.buf[(start + i) % this.buf.length];
      if (r) out.push(r);
    }
    return out;
  }

  resize(capacity: number): void {
    const keep = this.snapshot().slice(-capacity);
    this.buf = new Array(Math.max(1, capacity));
    this.next = 0;
    this.count = 0;
    for (const r of keep) this.record(r.t, r.kind, r.id, r.data);
  }
}
