// Requested/observed geometry ledger: one pure state machine per window.
//
// Measured basis (M0/M1, KWin 6.7.5): a frame write returns before the client
// commits; position-only writes apply synchronously; and while B is outstanding,
// a return to the committed size A is dropped by KWin (no configure), so the
// window later lands on B. The ledger therefore keeps desired, last-requested and
// observed geometry separate, never treats "observed equals target" as settled
// while another request is in flight, recognizes stale observations of older
// targets, and bounds corrective writes. At the convergence deadline it learns a
// constraint only from a size the client actually committed: an unchanged size is
// no answer (slow or stalled client), and a commit a few pixels short of the target
// (character-cell rounding) is accepted as the answer rather than learned as a maximum.

import { rectNear, sizeNear, TOLERANCE, type Rect, type Size } from "../geometry.ts";

export const HISTORY = 4;
export const CORRECTION_BUDGET = 2;
/**
 * Largest shortfall (logical px, per dimension) accepted as the client's own rounding,
 * e.g. a terminal that sizes itself in whole character cells. A larger shortfall is a
 * maximum; an excess beyond the frame tolerance is always a minimum (it would overlap).
 */
export const ROUNDING = 32;

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
  /** Frame read immediately before the current request was written. */
  before: Rect | null;
  /** Frame accepted for the current request within ROUNDING (cleared when the target changes). */
  accepted: Rect | null;
  /** Frame comparison tolerance for this window's output (geometry.frameTolerance). */
  tol: number;
}

export function newEntry(observed: Rect | null, tol = TOLERANCE): LedgerEntry {
  return { desired: null, request: null, outstanding: false, history: [], corrections: 0, observed,
           status: "idle", pendingSince: null, before: null, accepted: null, tol };
}

export type WriteDecision = "write" | "skip-outstanding" | "skip-noop" | "skip-diverged";

/** Decide whether a plan target needs a frame write. `observedNow` is the current frame. */
export function decideWrite(e: LedgerEntry, target: Rect, observedNow: Rect | null): WriteDecision {
  const sameDesired = rectNear(e.desired, target, e.tol);
  if (e.status === "diverged" && sameDesired) return "skip-diverged";
  if (e.request && rectNear(e.request.rect, target, e.tol)) {
    if (e.outstanding) return "skip-outstanding";
    if (rectNear(observedNow, target, e.tol) || rectNear(observedNow, e.accepted, e.tol)) return "skip-noop";
    return "write"; // settled earlier but drifted: caller labels it a correction
  }
  if (!e.outstanding && rectNear(observedNow, target, e.tol)) return "skip-noop";
  return "write";
}

/** Record that the policy wants `target` (whether or not a write happens). */
export function setDesired(e: LedgerEntry, target: Rect): void {
  if (!rectNear(e.desired, target, e.tol)) {
    e.desired = target;
    e.corrections = 0;
    e.accepted = null;
    if (e.status === "diverged") e.status = e.outstanding ? "pending" : "idle";
  }
}

/**
 * Mark a no-op target as settled without issuing a request. It is recorded as the
 * settled request (seq 0: nothing was written) so a later change by the application is
 * observed as external and corrected, as for a target Plastile wrote itself.
 */
export function acceptNoop(e: LedgerEntry, target: Rect, now: number): void {
  setDesired(e, target);
  if (e.outstanding) return;
  e.status = "settled";
  if (!e.request || !rectNear(e.request.rect, target, e.tol)) {
    e.request = { rect: target, seq: 0, issuedAt: now, reason: "noop" };
    e.history.push({ rect: target, seen: true });
    if (e.history.length > HISTORY) e.history.shift();
  }
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
  e.before = before;
  if (!e.outstanding) return e.status === "settled";
  // Settle on readback only if the frame actually changed to the target: when the
  // old committed frame already equals the target while another request is in
  // flight, KWin sends no configure and the late commit must still be caught.
  if (e.request && !rectNear(before, e.request.rect, e.tol) && rectNear(after, e.request.rect, e.tol)) {
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
    if (!sizeNear(observed, h.rect, e.tol)) continue;
    if (!h.seen && i < last && !sizeNear(h.rect, current, e.tol)) late = true;
    h.seen = true;
  }
  // A diverged request whose target finally arrives (e.g. a client slower than every
  // deadline) is settled after all.
  if (rectNear(observed, current, e.tol)) {
    if (e.outstanding || e.status === "diverged") { settle(e); return "settled"; }
    return "confirmed";
  }
  if (rectNear(observed, e.accepted, e.tol)) {
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
  | { readonly kind: "accepted" }
  | { readonly kind: "learn"; readonly min: Size | null; readonly max: Size | null }
  | { readonly kind: "correct" }
  | { readonly kind: "diverged" };

/** At the target position, no dimension larger than the target and none short by more than ROUNDING. */
function withinRounding(target: Rect, observed: Rect, tol: number): boolean {
  return Math.abs(observed.x - target.x) <= tol && Math.abs(observed.y - target.y) <= tol &&
    observed.width <= target.width + tol && observed.height <= target.height + tol &&
    observed.width >= target.width - ROUNDING && observed.height >= target.height - ROUNDING;
}

/**
 * Classify a request whose deadline expired. A commit within ROUNDING of the target is
 * accepted as the client's answer. If the client committed a clearly different size,
 * learn it as a constraint (bounded: one learning step per target) rather than
 * fighting. A size still equal to the one read before the request is no answer at all
 * (slow, stalled or ignoring client) and is never learned: correct within budget, then
 * diverge.
 */
export function expire(e: LedgerEntry, observedNow: Rect | null): Expiry {
  if (e.request && rectNear(observedNow, e.request.rect, e.tol)) { settle(e); return { kind: "settled" }; }
  const target = e.request?.rect ?? null;
  if (target && observedNow && withinRounding(target, observedNow, e.tol)) {
    e.accepted = observedNow;
    settle(e);
    return { kind: "accepted" };
  }
  const answered = !(e.before && observedNow && sizeNear(observedNow, e.before, e.tol));
  if (target && observedNow && answered) {
    const minW = observedNow.width > target.width + e.tol ? observedNow.width : 0;
    const minH = observedNow.height > target.height + e.tol ? observedNow.height : 0;
    const maxW = observedNow.width < target.width - ROUNDING ? observedNow.width : Infinity;
    const maxH = observedNow.height < target.height - ROUNDING ? observedNow.height : Infinity;
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

/**
 * Merge newly learned bounds into earlier ones. Learned values only tighten, except
 * that the newest observation wins where it contradicts an older one (a minimum above
 * a maximum), so the result is always satisfiable.
 */
export function mergeLearned(min: Size | null, max: Size | null, newMin: Size | null, newMax: Size | null):
  { min: Size | null; max: Size | null } {
  let lo = min, hi = max;
  if (newMin) {
    lo = { width: Math.max(lo?.width ?? 0, newMin.width), height: Math.max(lo?.height ?? 0, newMin.height) };
    if (hi) hi = { width: hi.width < lo.width ? Infinity : hi.width, height: hi.height < lo.height ? Infinity : hi.height };
  }
  if (newMax) {
    hi = { width: Math.min(hi?.width ?? Infinity, newMax.width), height: Math.min(hi?.height ?? Infinity, newMax.height) };
    if (lo) lo = { width: lo.width > hi.width ? 0 : lo.width, height: lo.height > hi.height ? 0 : lo.height };
  }
  return { min: lo, max: hi };
}
