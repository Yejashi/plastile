// Layout-level command targeting and suspension diagnostics (the first physical session's
// report: a layout reset over D-Bus landed on another desktop's context; a maximized window
// looked like a dead tiler). Unit layer, mock compositor.
//  - layout-level commands (layout, resize, master count, reset) act on the context on screen:
//    an active window on another desktop, a pinned window, no active window; window-level
//    commands keep the active window's context;
//  - the engine reports a layout a command changed and pause/resume to its listeners;
//  - explain and the context summary say when tiling of a window is suspended.
// Oracles: the mock compositor's frames and the engine's context membership.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect } from "../../src/core/geometry.ts";
import type { ContextKey, LayoutKind } from "../../src/core/types.ts";
import { MockHost } from "./mockHost.ts";
import { describeWindow } from "../../src/runtime/inspect.ts";

const D1 = (o = "O1"): ContextKey => ({ output: o, desktop: "D1", activity: "default" });
const D2 = (o = "O1"): ContextKey => ({ output: o, desktop: "D2", activity: "default" });

function twoOutputs(): MockHost {
  const h = new MockHost();
  h.outs = [{ id: "O1", name: "O1", geometry: rect(0, 0, 1280, 800), scale: 1 },
            { id: "O2", name: "O2", geometry: rect(1280, 0, 1280, 800), scale: 1 }];
  h.visible.set("O2", "D1");
  return h;
}

function layouts(h: MockHost): Record<string, LayoutKind> {
  return Object.fromEntries(h.engine.contextSummary().map((c) => [c.id.split("␟").slice(0, 2).join("/"), c.layout]));
}

// ------------------------------------------------------------------ targeting

test("layout commands with the active window on another desktop change the desktop on screen, not the window's", () => {
  const h = new MockHost();
  const changes: string[] = [];
  h.start();
  h.engine.onLayoutChange = (k, l, p) => changes.push(`${k.desktop}:${p}->${l}`);
  h.open("a"); h.open("b");                                                    // on D1, shown
  h.open("x", { membership: { output: "O1", desktops: ["D2"], onAllDesktops: false, activities: [] } });
  h.open("y", { membership: { output: "O1", desktops: ["D2"], onAllDesktops: false, activities: [] } });
  h.drain();
  h.active = "x"; // KWin can leave a window of a hidden desktop active (or a D-Bus call arrives meanwhile)
  assert.equal(h.engine.execute("plastile.layout.monocle").status, "accepted");
  assert.deepEqual(layouts(h), { "O1/D1": "monocle", "O1/D2": "master-stack" }, "the desktop on screen changed");
  assert.deepEqual(changes, ["D1:master-stack->monocle"]);
  h.engine.execute("plastile.master.increase");                                 // master/stack only: D1 is monocle now
  h.engine.execute("plastile.context.reset");
  assert.deepEqual(layouts(h), { "O1/D1": "master-stack", "O1/D2": "master-stack" });
  assert.deepEqual(changes, ["D1:master-stack->monocle", "D1:monocle->master-stack"], "reset back to the configured layout");
  // Window-level commands keep the active window's context: the swap reorders D2.
  assert.deepEqual(h.engine.membersOf(D2()), ["x", "y"]);
  assert.equal(h.engine.execute("plastile.swap.next").status, "accepted");
  assert.deepEqual(h.engine.membersOf(D2()), ["y", "x"]);
  assert.deepEqual(h.engine.membersOf(D1()), ["a", "b"]);
  assert.deepEqual(h.engine.check(), []);
});

test("resize grow targets the visible context when the active window's desktop is hidden", () => {
  const h = new MockHost();
  h.start();
  h.open("a"); h.open("b");
  h.open("x", { membership: { output: "O1", desktops: ["D2"], onAllDesktops: false, activities: [] } });
  h.open("y", { membership: { output: "O1", desktops: ["D2"], onAllDesktops: false, activities: [] } });
  h.drain();
  const before = h.windows.get("a")!.frame.width;
  h.active = "x";
  assert.equal(h.engine.execute("plastile.resize.grow").status, "accepted");
  h.drain();
  assert.ok(h.windows.get("a")!.frame.width > before, "the master column on screen grew");
  h.engine.execute("plastile.resize.shrink");
  h.drain();
  assert.equal(h.windows.get("a")!.frame.width, before, "shrink took the visible context back");
  h.engine.execute("plastile.resize.grow");
  h.drain();
  assert.ok(h.windows.get("a")!.frame.width > before);
  // The hidden desktop kept its ratio: shown, its master is the default width.
  h.visible.set("O1", "D2");
  h.engine.visibilityChanged();
  h.drain();
  assert.equal(h.windows.get("x")!.frame.width, before, "D2's master column has the configured ratio");
});

test("a pinned (all-desktops) active window: layout commands act on its output's visible context", () => {
  const h = twoOutputs();
  h.start();
  h.open("a"); h.open("b", { membership: { output: "O2", desktops: ["D1"], onAllDesktops: false, activities: [] } });
  h.open("pin", { membership: { output: "O2", desktops: [], onAllDesktops: true, activities: [] } });
  h.drain();
  assert.equal(h.engine.modeOf("pin"), "floating", "a pinned window floats");
  h.active = "pin"; // the active output (MockHost: O1) is not the pinned window's
  h.engine.execute("plastile.layout.bsp");
  assert.deepEqual(layouts(h), { "O1/D1": "master-stack", "O2/D1": "bsp" });
});

test("no active window: the active output's visible context; an active visible window: its own context", () => {
  const h = twoOutputs();
  h.start();
  h.open("a"); h.open("b", { membership: { output: "O2", desktops: ["D1"], onAllDesktops: false, activities: [] } });
  h.drain();
  h.active = null;
  h.engine.execute("plastile.layout.monocle");
  assert.deepEqual(layouts(h), { "O1/D1": "monocle", "O2/D1": "master-stack" });
  h.active = "b";
  h.engine.execute("plastile.layout.bsp");
  assert.deepEqual(layouts(h), { "O1/D1": "monocle", "O2/D1": "bsp" });
});

test("onSuspendChange reports pause and resume; a no-op layout command reports nothing", () => {
  const h = new MockHost();
  const seen: string[] = [];
  h.start();
  h.engine.onSuspendChange = (p) => seen.push(p ? "paused" : "resumed");
  h.engine.onLayoutChange = (_k, l) => seen.push(l);
  h.open("a");
  h.drain();
  h.engine.execute("plastile.layout.master-stack"); // already master-stack
  h.engine.execute("plastile.runtime.toggle-suspend");
  h.engine.execute("plastile.layout.monocle");       // rejected while suspended
  h.engine.execute("plastile.runtime.toggle-suspend");
  assert.deepEqual(seen, ["paused", "resumed"]);
  h.engine.onLayoutChange = () => { throw new Error("listener bug"); };
  assert.equal(h.engine.execute("plastile.layout.monocle").status, "accepted", "a listener failure is not the command's");
  assert.ok(h.logs.some((l) => l.message === "notice listener failed"));
});

// ------------------------------------------------------------ suspension, explain

test("explain says plainly that a maximized tiled window's tiling is suspended; counters split tiled and suspended", () => {
  const h = new MockHost();
  h.start();
  h.open("a"); h.open("b");
  h.drain();
  h.advance(5); // past the open phase (ADR-021)
  assert.equal(h.engine.explain("a")!.suspended, null);
  h.setStates("a", { maximized: true });
  h.drain();
  const x = h.engine.explain("a")!;
  assert.equal(x.mode, "tiled", "the policy is unchanged: still a member");
  assert.equal(x.suspended, "tiling of this window is suspended while it is maximized; it resumes, in the same place, when the window is restored");
  assert.deepEqual(h.engine.contextSummary().map((c) => [c.members, c.tiled, c.suspended]), [[2, 1, 1]]);
  const v = describeWindow(x, { desktopNameOf: () => "Desktop 1", outputNameOf: (k) => k, shortcuts: null, area: null });
  assert.match(v.rows[0].text, /^Tiling of this window is suspended while it is maximized; it resumes, in the same place, when the window is restored\. Until then KWin owns/);
  assert.ok(v.rows.some((r) => r.label === "Layout" && /master and stack/.test(r.text)));
  h.setStates("a", { maximized: false, fullscreen: true });
  assert.match(String(h.engine.explain("a")!.suspended), /while it is full screen;/);
  h.setStates("a", { fullscreen: false });
  h.drain();
  assert.equal(h.engine.explain("a")!.suspended, null);
  assert.deepEqual(h.engine.contextSummary().map((c) => [c.members, c.tiled, c.suspended]), [[2, 2, 0]]);
  h.engine.execute("plastile.runtime.toggle-suspend");
  assert.equal(h.engine.explain("a")!.paused, true);
  assert.ok(describeWindow(h.engine.explain("a"), { desktopNameOf: () => "", outputNameOf: (k) => k, shortcuts: null, area: null })
    .rows.some((r) => r.label === "Tiling paused"));
});
