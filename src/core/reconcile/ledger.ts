// Requested/observed geometry ledger: one pure state machine per window.
//
// Measured basis (M0/M1, KWin 6.7.5): a frame write returns before the client
// commits; position-only writes apply synchronously; and while B is outstanding,
// a return to the committed size A is dropped by KWin (no configure), so the
// window later lands on B. The ledger therefore keeps desired, last-requested and
// observed geometry separate, never treats "observed equals target" as settled
// while another request is in flight, recognizes stale observations of older
// targets, and bounds corrective writes.

import { rectNear, sizeNear, type Rect, type Size } from "../geometry.ts";

export const HISTORY = 4;
export const CORRECTION_BUDGET = 2;

export type LedgerStatus = "idle" | "pending" | "settled" | "diverged";

export interface Request {
  readonly rect: Rect;
  readonly seq: number;
  readonly issuedAt: number;
  readonly reason: string;
}

/** An issued target and whether its size was ever observed (committed). */
export interface Issued {
  readonly rect: Rect;
  seen: boolean;
}

export interface LedgerEntry {
  desired: Rect | null;
  request: Request | null;
  outstanding: boolean;
  history: Issued[];
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
 * Register an outgoing request BEFORE the property write: KWin emits position
 * observations synchronously inside the setter, and they must see this request
 * as outstanding (ROADMAP M2: record outgoing intent before external writes).
 */
export function beginWrite(e: LedgerEntry, target: Rect, seq: number, now: number, reason: string): void {
  setDesired(e, target);
  if (reason === "correction") e.corrections++;
  e.request = { rect: target, seq, issuedAt: now, reason };
  e.history.push({ rect: target, seen: false });
  if (e.history.length > HISTORY) e.history.shift();
  e.outstanding = true;
  e.status = "pending";
  e.pendingSince = now;
}

/**
 * Complete a write with the frames read immediately before and after the property
 * write. Returns true when the request is settled (possibly already by an
 * observation delivered inside the write).
 */
export function finishWrite(e: LedgerEntry, before: Rect | null, after: Rect | null): boolean {
  e.observed = after;
  if (!e.outstanding) return e.status === "settled";
  // Settle on readback only if the frame actually changed to the target: when the
  // old committed frame already equals the target while another request is in
  // flight, KWin sends no configure and the late commit must still be caught.
  if (e.request && !rectNear(before, e.request.rect) && rectNear(after, e.request.rect)) {
    settle(e);
    return true;
  }
  return false;
}

/** beginWrite + finishWrite for callers without re-entrant observations (tests). */
export function recordWrite(e: LedgerEntry, target: Rect, seq: number, now: number, reason: string,
  before: Rect | null, after: Rect | null): boolean {
  beginWrite(e, target, seq, now, reason);
  return finishWrite(e, before, after);
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
  | "stale"       // observed an older issued target (late commit), newer target still wanted
  | "partial"     // in flight: neither the target nor an older one (e.g. move applied, size pending)
  | "external";   // the frame changed after settlement: user, application or KWin

export function observe(e: LedgerEntry, observed: Rect): Observation {
  e.observed = observed;
  if (!e.request) return "untracked";
  // A superseded target whose size had never been observed arriving now is a late
  // commit (E04: B committed after the return to A). Its size lands at the window's
  // current position, hence size matching. Sizes already seen before (e.g. the old
  // committed size shown while a move applies first) are partial, not stale.
  const current = e.request.rect;
  const last = e.history.length - 1;
  let late = false;
  for (let i = 0; i <= last; ++i) {
    const h = e.history[i];
    if (!sizeNear(observed, h.rect)) continue;
    if (!h.seen && i < last && !sizeNear(h.rect, current)) late = true;
    h.seen = true;
  }
  if (rectNear(observed, current)) {
    if (e.outstanding) { settle(e); return "settled"; }
    return "confirmed";
  }
  if (late) return "stale";
  return e.outstanding ? "partial" : "external";
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
