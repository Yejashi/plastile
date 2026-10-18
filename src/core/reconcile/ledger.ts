// Requested/observed geometry ledger: one pure state machine per window.
//
// Measured basis (M0/M1, KWin 6.7.5): a frame write returns before the client
// commits; position-only writes apply synchronously; and while B is outstanding,
// a return to the committed size A is dropped by KWin (no configure), so the
// window later lands on B. The ledger therefore keeps desired, last-requested and
// observed geometry separate, never treats "observed equals target" as settled
// while another request is in flight, recognizes stale observations of older
// targets, and bounds corrective writes.

import { rectNear, type Rect, type Size } from "../geometry.ts";

export const HISTORY = 4;
export const CORRECTION_BUDGET = 2;

export type LedgerStatus = "idle" | "pending" | "settled" | "diverged";

export interface Request {
  readonly rect: Rect;
  readonly seq: number;
  readonly issuedAt: number;
  readonly reason: string;
}

export interface LedgerEntry {
  desired: Rect | null;
  request: Request | null;
  outstanding: boolean;
  history: Rect[];
  /** Corrective writes issued for the current desired target. */
  corrections: number;
  observed: Rect | null;
  status: LedgerStatus;
  /** When the outstanding request was issued (deadline base). */
  pendingSince: number | null;
}

export function newEntry(observed: Rect | null): LedgerEntry {
  return { desired: null, request: null, outstanding: false, history: [], corrections: 0, observed,
           status: "idle", pendingSince: null };
}

export type WriteDecision = "write" | "skip-outstanding" | "skip-noop" | "skip-diverged";

/** Decide whether a plan target needs a frame write. `observedNow` is the current frame. */
export function decideWrite(e: LedgerEntry, target: Rect, observedNow: Rect | null): WriteDecision {
  const sameDesired = rectNear(e.desired, target);
  if (e.status === "diverged" && sameDesired) return "skip-diverged";
  if (e.request && rectNear(e.request.rect, target)) {
    if (e.outstanding) return "skip-outstanding";
    if (rectNear(observedNow, target)) return "skip-noop";
    return "write"; // settled earlier but drifted: caller labels it a correction
  }
  if (!e.outstanding && rectNear(observedNow, target)) return "skip-noop";
  return "write";
}

/** Record that the policy wants `target` (whether or not a write happens). */
export function setDesired(e: LedgerEntry, target: Rect): void {
  if (!rectNear(e.desired, target)) {
    e.desired = target;
    e.corrections = 0;
    if (e.status === "diverged") e.status = e.outstanding ? "pending" : "idle";
  }
}

/** Mark a no-op target as settled without issuing a request. */
export function acceptNoop(e: LedgerEntry, target: Rect): void {
  setDesired(e, target);
  if (!e.outstanding) e.status = "settled";
}

/**
 * Record an issued write. `before`/`after` are frames read immediately before and after
 * the property write. Returns true when the write settled synchronously.
 */
export function recordWrite(e: LedgerEntry, target: Rect, seq: number, now: number, reason: string,
  before: Rect | null, after: Rect | null): boolean {
  setDesired(e, target);
  if (reason === "correction") e.corrections++;
  e.request = { rect: target, seq, issuedAt: now, reason };
  e.history.push(target);
  if (e.history.length > HISTORY) e.history.shift();
  e.outstanding = true;
  e.status = "pending";
  e.pendingSince = now;
  e.observed = after;
  // Settle on readback only if the frame actually changed to the target: when the
  // old committed frame already equals the target while another request is in
  // flight, KWin sends no configure and the late commit must still be caught.
  if (!rectNear(before, target) && rectNear(after, target)) {
    settle(e);
    return true;
  }
  return false;
}

function settle(e: LedgerEntry): void {
  e.outstanding = false;
  e.status = "settled";
  e.pendingSince = null;
}

export type Observation =
  | "untracked"   // no request yet
  | "settled"     // observed the outstanding target
  | "confirmed"   // observed the already-settled target again
  | "stale"       // observed an older target while a newer one is outstanding
  | "partial"     // in flight: neither the target nor an older one (e.g. move applied, size pending)
  | "external";   // the frame changed after settlement: user, application or KWin

export function observe(e: LedgerEntry, observed: Rect): Observation {
  e.observed = observed;
  if (!e.request) return "untracked";
  if (rectNear(observed, e.request.rect)) {
    if (e.outstanding) { settle(e); return "settled"; }
    return "confirmed";
  }
  if (!e.outstanding) return "external";
  for (let i = 0; i < e.history.length - 1; ++i) {
    if (rectNear(observed, e.history[i])) return "stale";
  }
  return "partial";
}

export function canCorrect(e: LedgerEntry): boolean {
  return e.corrections < CORRECTION_BUDGET;
}

export function cancel(e: LedgerEntry): void {
  e.outstanding = false;
  e.pendingSince = null;
  if (e.status === "pending") e.status = "idle";
}

export function diverge(e: LedgerEntry): void {
  e.outstanding = false;
  e.pendingSince = null;
  e.status = "diverged";
}

export type Expiry =
  | { readonly kind: "settled" }
  | { readonly kind: "learn"; readonly min: Size | null; readonly max: Size | null }
  | { readonly kind: "correct" }
  | { readonly kind: "diverged" };

/**
 * Classify a request whose deadline expired. If the client accepted a different
 * size, learn it as a constraint (bounded: one learning step per target) rather
 * than fighting; otherwise correct within budget, then diverge.
 */
export function expire(e: LedgerEntry, observedNow: Rect | null): Expiry {
  if (e.request && rectNear(observedNow, e.request.rect)) { settle(e); return { kind: "settled" }; }
  const target = e.request?.rect ?? null;
  if (target && observedNow) {
    const minW = observedNow.width > target.width + 0.5 ? observedNow.width : 0;
    const minH = observedNow.height > target.height + 0.5 ? observedNow.height : 0;
    const maxW = observedNow.width < target.width - 0.5 ? observedNow.width : Infinity;
    const maxH = observedNow.height < target.height - 0.5 ? observedNow.height : Infinity;
    const learnsMin = minW > 0 || minH > 0;
    const learnsMax = maxW < Infinity || maxH < Infinity;
    if (learnsMin || learnsMax) {
      diverge(e);
      return {
        kind: "learn",
        min: learnsMin ? { width: minW, height: minH } : null,
        max: learnsMax ? { width: maxW, height: maxH } : null,
      };
    }
  }
  if (canCorrect(e)) return { kind: "correct" };
  diverge(e);
  return { kind: "diverged" };
}
