// Who takes part in a solve, who is written, and which slot resize.grow/shrink measures from:
// the three engine paths rewritten without iterators in G2 report §16 (participates(), the
// apply loop's writable() check, participantIndex()). Each test fails against a plausible
// broken rewrite of those paths (review of wf/g2-perf, mutation check); oracles are the mock
// compositor's frames and write log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect } from "../../src/core/geometry.ts";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import type { ContextSettings } from "../../src/core/types.ts";
import { MockHost } from "./mockHost.ts";
import { assertTiling } from "./helpers.ts";

const AREA = rect(0, 0, 1280, 800);

function setup(ids: string[], s: Partial<ContextSettings> = {}) {
  const h = new MockHost();
  const settings: ContextSettings = { ...DEFAULT_SETTINGS, ...s };
  const e = h.start({ settingsFor: () => settings });
  for (const id of ids) h.open(id);
  h.drain();
  return { h, e };
}

test("an interactive window keeps its slot but is never written, even when a command moves its slot", () => {
  for (const live of [false, true]) {
    const { h, e } = setup(["a", "b", "c"], { liveResize: live });
    h.activate("b");
    const a0 = h.windows.get("a")!.frame, b0 = h.windows.get("b")!.frame;
    // The drag has started but the window has not moved yet: its ledger is not diverged, so
    // only the writable() check keeps the solve's new slot from being written to it.
    h.setStates("a", { interactive: "move" });
    h.drain();
    const toA = h.writesTo("a");
    assert.equal(e.execute("plastile.resize.grow").status, "accepted");
    h.drain();
    assert.equal(h.writesTo("a"), toA, `live=${live}: the dragged window is not written`);
    assert.ok(h.windows.get("b")!.frame.x !== b0.x, `live=${live}: its peers took the new layout (it still has its slot)`);
    assert.deepEqual(h.windows.get("a")!.frame, a0);
    h.setStates("a", { interactive: "none" });
    h.drain();
    assertTiling(new Map(["a", "b", "c"].map((id) => [id, h.windows.get(id)!.frame] as const)), AREA);
    assert.equal(e.counters.errors, 0);
  }
});

test("interactive plus a KWin-owned state (maximized, fullscreen) leaves the solve; interactive alone does not", () => {
  for (const state of ["maximized", "fullscreen"] as const) {
    const { h } = setup(["a", "b", "c"]);
    h.setStates("a", { interactive: "move" });
    h.drain();
    const withInteractive = { b: h.windows.get("b")!.frame, c: h.windows.get("c")!.frame };
    assert.ok(withInteractive.b.x > 0, "interactive alone: a keeps the master slot");
    h.setStates("a", { [state]: true });
    h.drain();
    // Without a, b is the master and c the stack: b moves to the left edge.
    const b1 = h.windows.get("b")!.frame, c1 = h.windows.get("c")!.frame;
    assert.ok(b1.x < withInteractive.b.x, `${state} + interactive: a leaves the solve, b takes the master column`);
    assertTiling(new Map([["b", b1], ["c", c1]]), AREA);
  }
});

test("resize.grow on a master counts only participating windows before it (participantIndex)", () => {
  // Members a, b, c, d; two masters. b goes fullscreen: it is still a member, but not a
  // participant, so the masters are a and c. Growing c must widen the master column. Counting
  // b (or using c's member index, 2) would make c a stack window and shrink the masters.
  const { h, e } = setup(["a", "b", "c", "d"]);
  h.activate("a");
  assert.equal(e.execute("plastile.master.increase").status, "accepted");
  h.drain();
  h.setStates("b", { fullscreen: true });
  h.drain();
  const a0 = h.windows.get("a")!.frame, c0 = h.windows.get("c")!.frame, d0 = h.windows.get("d")!.frame;
  assert.equal(c0.x, a0.x, "a and c share the master column");
  assert.ok(d0.x > a0.x, "d is the stack");
  h.activate("c");
  assert.equal(e.execute("plastile.resize.grow").status, "accepted");
  h.drain();
  assert.ok(h.windows.get("a")!.frame.width > a0.width, "grow on master c widens the master column");
  h.activate("d");
  assert.equal(e.execute("plastile.resize.grow").status, "accepted");
  h.drain();
  assert.ok(Math.abs(h.windows.get("a")!.frame.width - a0.width) <= 1, "grow on stack d shrinks it back");
  assert.equal(e.counters.errors, 0);
});
