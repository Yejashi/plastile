import { test } from "node:test";
import assert from "node:assert/strict";
import { rect } from "../../src/core/geometry.ts";
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
