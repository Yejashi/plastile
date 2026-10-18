import { test } from "node:test";
import assert from "node:assert/strict";
import { frameTolerance, rect } from "../../src/core/geometry.ts";
import * as L from "../../src/core/reconcile/ledger.ts";

const A = rect(0, 0, 512, 400);
const B = rect(0, 0, 768, 560);

test("position-only move settles synchronously", () => {
  const e = L.newEntry(A);
  const moved = rect(100, 0, 512, 400);
  assert.equal(L.decideWrite(e, moved, A), "write");
  assert.equal(L.recordWrite(e, moved, 1, 0, "plan", A, moved), true);
  assert.equal(e.status, "settled");
});

test("resize stays outstanding and is not repeated while outstanding (invariant 6)", () => {
  const e = L.newEntry(A);
  L.recordWrite(e, B, 1, 0, "plan", A, A);
  assert.equal(e.outstanding, true);
  assert.equal(L.decideWrite(e, B, A), "skip-outstanding");
  assert.equal(L.observe(e, B), "settled");
  assert.equal(L.decideWrite(e, B, B), "skip-noop");
});

test("E04 replay: A->B->A with B committed late is caught as stale (G05/G06)", () => {
  const e = L.newEntry(A);
  // Settled at A.
  L.recordWrite(e, A, 1, 0, "plan", rect(0, 0, 400, 300), A);
  L.observe(e, A);
  // Request B (configure sent), then A while B is in flight: KWin drops the A configure.
  L.recordWrite(e, B, 2, 10, "plan", A, A);
  assert.equal(L.decideWrite(e, A, A), "write", "return-to-A must not be skipped because observed is A");
  const settledNow = L.recordWrite(e, A, 3, 60, "plan", A, A);
  assert.equal(settledNow, false, "unchanged readback must not settle A");
  assert.equal(e.outstanding, true);
  // Late commit of B arrives.
  assert.equal(L.observe(e, B), "stale");
  assert.equal(L.canCorrect(e), true);
  L.recordWrite(e, A, 4, 320, "correction", B, B);
  assert.equal(e.corrections, 1);
  assert.equal(L.observe(e, A), "settled");
});

test("D8: an intermediate size committed after a newer request is superseded, not corrected", () => {
  const C = rect(0, 0, 640, 480);
  const e = L.newEntry(A);
  L.recordWrite(e, B, 1, 0, "plan", A, A);   // configure B (size differs from the committed A)
  L.recordWrite(e, C, 2, 10, "plan", A, A);  // configure C, sent too: A is still the committed size
  assert.equal(L.observe(e, B), "superseded", "C's configure is still on its way");
  assert.equal(e.outstanding, true);
  assert.equal(L.observe(e, C), "settled");
  // Its configure lost: at the deadline the intermediate size is no answer and never a constraint.
  const f = L.newEntry(A);
  L.recordWrite(f, B, 1, 0, "plan", A, A);
  L.recordWrite(f, C, 2, 10, "plan", A, A);
  L.observe(f, B);
  assert.equal(L.expire(f, B).kind, "correct");
  // A settled request whose older configure commits after it: nothing else is coming, correct.
  const g = L.newEntry(A);
  const moved = rect(100, 0, 512, 400);
  L.recordWrite(g, B, 1, 0, "plan", A, A);
  assert.equal(L.recordWrite(g, moved, 2, 10, "plan", A, moved), true, "committed size: position applied synchronously");
  assert.equal(L.observe(g, rect(0, 0, 768, 560)), "stale");
});

test("corrections are bounded per desired target and reset for a new target", () => {
  const e = L.newEntry(A);
  L.recordWrite(e, B, 1, 0, "plan", A, A);
  L.recordWrite(e, B, 2, 1, "correction", A, A);
  L.recordWrite(e, B, 3, 2, "correction", A, A);
  assert.equal(L.canCorrect(e), false);
  L.setDesired(e, rect(0, 0, 600, 600));
  assert.equal(L.canCorrect(e), true);
});

test("deadline learns a minimum when the client commits larger than requested (E07)", () => {
  const e = L.newEntry(A);
  const small = rect(64, 40, 300, 200);
  L.recordWrite(e, small, 1, 0, "plan", A, A);
  assert.equal(L.observe(e, rect(64, 40, 600, 428)), "partial");
  const x = L.expire(e, rect(64, 40, 600, 428));
  assert.equal(x.kind, "learn");
  if (x.kind === "learn") assert.deepEqual(x.min, { width: 600, height: 428 });
  assert.equal(e.status, "diverged");
  assert.equal(L.decideWrite(e, small, rect(64, 40, 600, 428)), "skip-diverged", "no fighting the same target");
  assert.equal(L.decideWrite(e, rect(0, 0, 700, 500), null), "write", "a new target is allowed");
});

test("deadline corrects within budget for a position mismatch, then diverges (G12)", () => {
  const e = L.newEntry(A);
  const t = rect(100, 100, 512, 400);
  L.recordWrite(e, t, 1, 0, "plan", A, A);
  assert.equal(L.expire(e, A).kind, "correct");
  L.recordWrite(e, t, 2, 1, "correction", A, A);
  assert.equal(L.expire(e, A).kind, "correct");
  L.recordWrite(e, t, 3, 2, "correction", A, A);
  assert.equal(L.expire(e, A).kind, "diverged");
});

test("external change after settlement is reported, not treated as stale", () => {
  const e = L.newEntry(A);
  L.recordWrite(e, B, 1, 0, "plan", A, A);
  L.observe(e, B);
  assert.equal(L.observe(e, rect(5, 5, 300, 300)), "external");
});

test("G03: device-pixel snapping at a fractional scale settles instead of being learned as a constraint", () => {
  // Measured in nested KWin 6.7.5 at scale 1.75: target height 441.14 (457.14 area - 16 gap),
  // accepted frame 441.71 (integer client height + decoration snapped to 1/1.75 px).
  const target = rect(1685, 8, 318.2857, 441.1429);
  const accepted = rect(1685, 8, 318.2857, 441.7143);
  const strict = L.newEntry(A);
  L.recordWrite(strict, target, 1, 0, "plan", A, A);
  assert.equal(L.expire(strict, accepted).kind, "learn", "the scale-1 tolerance misreads a device pixel as a minimum");
  const scaled = L.newEntry(A, frameTolerance(1.75));
  L.recordWrite(scaled, target, 1, 0, "plan", A, A);
  assert.equal(L.observe(scaled, accepted), "settled");
  assert.equal(L.decideWrite(scaled, target, accepted), "skip-noop", "no repeated fractional correction");
});

test("deadline: a size unchanged since the request is no answer; corrected, then diverged, never learned", () => {
  const e = L.newEntry(A);
  const t = rect(100, 0, 768, 560);
  const moved = rect(100, 0, 512, 400); // position applies synchronously; the size has not been committed
  L.recordWrite(e, t, 1, 0, "plan", A, moved);
  assert.equal(L.expire(e, moved).kind, "correct");
  L.recordWrite(e, t, 2, 750, "correction", moved, moved);
  assert.equal(L.expire(e, moved).kind, "correct");
  L.recordWrite(e, t, 3, 1500, "correction", moved, moved);
  assert.equal(L.expire(e, moved).kind, "diverged");
  assert.equal(L.observe(e, t), "settled", "the late commit of the target still settles it");
  assert.equal(e.status, "settled");
});

test("deadline: a commit a few pixels short of the target (cell rounding) is accepted, not learned", () => {
  const e = L.newEntry(A);
  const t = rect(707, 8, 565, 784);
  const rounded = rect(707, 8, 558, 774);
  L.recordWrite(e, t, 1, 0, "plan", A, rect(707, 8, 512, 400));
  assert.equal(L.observe(e, rounded), "partial");
  assert.equal(L.expire(e, rounded).kind, "accepted");
  assert.equal(e.outstanding, false);
  assert.equal(L.decideWrite(e, t, rounded), "skip-noop", "the same plan is not re-requested");
  assert.equal(L.observe(e, rounded), "confirmed");
  assert.equal(L.observe(e, rect(707, 8, 300, 300)), "external", "a real change is still noticed");
  assert.equal(L.decideWrite(e, rect(8, 8, 1264, 784), rounded), "write", "a larger slot is requested in full");
  // A clear shortfall is still a maximum; an excess is always a minimum.
  const m = L.newEntry(A);
  L.recordWrite(m, t, 1, 0, "plan", A, rect(707, 8, 512, 400));
  const x = L.expire(m, rect(707, 8, 400, 784));
  assert.ok(x.kind === "learn" && x.max?.width === 400 && x.min === null, JSON.stringify(x));
  const n = L.newEntry(A);
  L.recordWrite(n, t, 1, 0, "plan", A, rect(707, 8, 512, 400));
  const y = L.expire(n, rect(707, 8, 570, 784));
  assert.ok(y.kind === "learn" && y.min?.width === 570, JSON.stringify(y));
});

test("learned bounds only tighten and never become contradictory (min above max)", () => {
  const a = L.mergeLearned(null, null, null, { width: 400, height: Infinity });
  assert.deepEqual(a, { min: null, max: { width: 400, height: Infinity } });
  const b = L.mergeLearned(a.min, a.max, { width: 565, height: 0 }, null);
  assert.deepEqual(b, { min: { width: 565, height: 0 }, max: { width: Infinity, height: Infinity } }, "newest wins");
  const c = L.mergeLearned(b.min, b.max, { width: 500, height: 300 }, null);
  assert.deepEqual(c.min, { width: 565, height: 300 }, "a minimum only grows");
  const d = L.mergeLearned(c.min, c.max, null, { width: 520, height: Infinity });
  assert.deepEqual(d, { min: { width: 0, height: 300 }, max: { width: 520, height: Infinity } });
});

test("frameTolerance: half a pixel at scale 1, plus one device pixel otherwise", () => {
  assert.equal(frameTolerance(1), 0.5);
  assert.equal(frameTolerance(2), 1);
  assert.ok(Math.abs(frameTolerance(1.75) - (0.5 + 1 / 1.75)) < 1e-12);
  assert.equal(frameTolerance(Number.NaN), 0.5);
  assert.equal(frameTolerance(0), 0.5);
});
