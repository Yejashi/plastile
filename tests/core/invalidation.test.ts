// Minimal invalidation on configuration activation (T26, BEHAVIOR §12, CONFIGURATION §5).
// Oracles: the mock compositor's write log and frames, plus solve/reclassification counters
// for the amount of work.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect, type Rect } from "../../src/core/geometry.ts";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import type { ContextKey, ContextSettings } from "../../src/core/types.ts";
import type { EngineOptions, WindowRules } from "../../src/core/engine.ts";
import { compileConfig, formatError, type ConfigSnapshot } from "../../src/config/index.ts";
import { diffConfig } from "../../src/config/diff.ts";
import { createRuntime } from "../../src/runtime/main.ts";
import { MockHost } from "./mockHost.ts";
import { assertTiling } from "./helpers.ts";
import { desktop, fakeEnv, FakeQt, FakeWorkspace, output } from "./fakeKwin.ts";

const O2 = rect(1280, 0, 1280, 800);
const on = (output: string) => ({ membership: { output, desktops: ["D1"], onAllDesktops: false, activities: [] } });

function gaps(inner: number, patch: Partial<ContextSettings> = {}): ContextSettings {
  return { ...DEFAULT_SETTINGS, gaps: { ...DEFAULT_SETTINGS.gaps, inner }, ...patch };
}

/** Two visible outputs, a+b on O1 and c+d on O2. */
function twoOutputs(opts: EngineOptions) {
  const h = new MockHost();
  h.outs.push({ id: "O2", name: "O2", geometry: O2, scale: 1 });
  h.visible.set("O2", "D1");
  const e = h.start(opts);
  h.open("a"); h.open("b"); h.open("c", on("O2")); h.open("d", on("O2"));
  h.drain();
  return { h, e };
}

function frames(h: MockHost, ids: string[]): Map<string, Rect> {
  return new Map(ids.map((id) => [id, h.windows.get(id)!.frame] as const));
}

function work(h: MockHost, e: ReturnType<MockHost["start"]>) {
  const c = e.counters, w = h.writes.length;
  const s = c.solves, r = c.reclassified;
  return () => ({ solves: c.solves - s, reclassified: c.reclassified - r, writes: h.writes.slice(w).map((x) => x.id) });
}

test("T26: a gap-only activation re-solves the contexts without reclassifying any window", () => {
  // Each activation resolves against its own immutable snapshot: the functions capture values.
  const { h, e } = twoOutputs({ settingsFor: () => gaps(8) });
  const since = work(h, e);
  e.configure({ settingsFor: () => gaps(20), changes: { rules: false, settings: true } });
  h.drain();
  const d = since();
  assert.equal(d.reclassified, 0, "no window reclassified");
  assert.equal(d.solves, 2, "both contexts re-solved once");
  const a = h.windows.get("a")!.frame, b = h.windows.get("b")!.frame;
  assert.equal(b.x - (a.x + a.width), 20, "the new inner gap applies");
  assertTiling(frames(h, ["c", "d"]), O2);
});

test("T26: an override for one output re-solves only that output's context", () => {
  const settingsFor = (inner2: number) => (k: ContextKey) => (k.output === "O2" ? gaps(inner2) : gaps(8));
  const { h, e } = twoOutputs({ settingsFor: settingsFor(8) });
  const o1 = frames(h, ["a", "b"]);
  const since = work(h, e);
  e.configure({ settingsFor: settingsFor(30), changes: { rules: false, settings: true } });
  h.drain();
  const d = since();
  assert.equal(d.solves, 1, "only O2's context");
  assert.equal(d.reclassified, 0);
  assert.deepEqual([...new Set(d.writes)].sort(), ["c", "d"], "no write to O1's windows");
  assert.deepEqual(frames(h, ["a", "b"]), o1);
  const c = h.windows.get("c")!.frame, dd = h.windows.get("d")!.frame;
  assert.equal(dd.x - (c.x + c.width), 30);
});

test("T26: an activation that changes nothing a window or context depends on does no work", () => {
  const rulesFor = (): WindowRules | null => null;
  const { h, e } = twoOutputs({ settingsFor: () => gaps(8), rulesFor });
  const since = work(h, e);
  // Diagnostics only: nothing to re-evaluate.
  e.configure({ settingsFor: () => gaps(8), rulesFor, traceCapacity: 512, changes: { rules: false, settings: false } });
  h.drain();
  // Settings reported as changed, but every context resolves to equal values.
  e.configure({ settingsFor: () => gaps(8), rulesFor, changes: { rules: false, settings: true } });
  h.drain();
  assert.deepEqual(since(), { solves: 0, reclassified: 0, writes: [] });
  assert.equal(e.trace.capacity, 512, "the diagnostics part still applies");
});

test("T26: a rule change reclassifies windows; only a context whose membership changed is re-solved", () => {
  const rules = (floatB: boolean) => (m: { appId: string }): WindowRules | null =>
    (floatB && m.appId === "b" ? { mode: "floating", ruleIds: ["float-b"] } : null);
  const { h, e } = twoOutputs({ rulesFor: rules(false) });
  const o2 = frames(h, ["c", "d"]);
  const since = work(h, e);
  e.configure({ rulesFor: rules(true), changes: { rules: true, settings: false } });
  h.drain();
  const d = since();
  assert.equal(e.modeOf("b"), "floating");
  assert.equal(d.reclassified, 4, "every window's rules re-evaluated");
  assert.equal(d.solves, 1, "only O1, which lost a member");
  assert.ok(d.writes.every((id) => id === "a"), `writes ${d.writes}`);
  assert.deepEqual(frames(h, ["c", "d"]), o2);
  assert.ok(Math.abs(h.windows.get("a")!.frame.width - 1264) < 1, "a fills O1");
});

test("T26: enabling tiling in one context reclassifies the windows there, and only there", () => {
  const settings = (enabled2: boolean) => (k: ContextKey) => gaps(8, { enabled: k.output !== "O2" || enabled2 });
  const { h, e } = twoOutputs({ settingsFor: settings(false) });
  assert.equal(e.modeOf("c"), "floating", "tiling disabled on O2");
  const o1 = frames(h, ["a", "b"]);
  const since = work(h, e);
  e.configure({ settingsFor: settings(true), changes: { rules: false, settings: true } });
  h.drain();
  const d = since();
  assert.equal(d.reclassified, 2, "c and d only");
  assert.equal(d.solves, 1, "O2 only");
  assert.deepEqual(frames(h, ["a", "b"]), o1);
  assert.equal(e.modeOf("c"), "tiled");
  assertTiling(frames(h, ["c", "d"]), O2);
});

test("T26: without a change description an activation re-evaluates everything", () => {
  const { h, e } = twoOutputs({});
  const since = work(h, e);
  e.configure({});
  h.drain();
  const d = since();
  assert.equal(d.reclassified, 4);
  assert.deepEqual(d.writes, [], "unchanged values: re-solved plans write nothing");
});

test("T26: through the runtime, a gap-only reconfigure re-solves without reclassifying; a rule change reclassifies", () => {
  const ws = new FakeWorkspace([output("O1", { x: 0, y: 0, width: 1280, height: 800 })], [desktop("D1")]);
  const qt = new FakeQt();
  const wins = [1, 2, 3].map((i) => ws.window({ caption: `w${i}`, resourceClass: `app${i}` }));
  for (const w of wins) ws.windows.push(w);
  const f = fakeEnv(ws, qt, { gapInner: "8" });
  const rt = createRuntime(f.env);
  qt.drain();
  const counters = (): Record<string, number> => {
    rt.dispatch("plastile.inspect.counters");
    return JSON.parse(f.lines[f.lines.length - 1].replace(/^plastile counters /, "")).counters;
  };
  const c0 = counters();
  f.cfg.gapInner = "16";
  f.configChanged.emit();
  qt.drain();
  const c1 = counters();
  assert.equal(c1.reclassified - c0.reclassified, 0, "gap only: nothing reclassified");
  assert.equal(c1.solves - c0.solves, 1, "one context re-solved");
  const [a, b] = wins.map((w) => w.frameGeometry as Rect);
  assert.equal(b.x - (a.x + a.width), 16);
  f.cfg.configJson = JSON.stringify({ schemaVersion: 1, rules: [{ id: "f", match: { appId: "app3" }, actions: { mode: "floating" } }] });
  f.configChanged.emit();
  qt.drain();
  const c2 = counters();
  assert.equal(c2.reclassified - c1.reclassified, 3, "a rule change re-evaluates every window");
  assert.equal(c2.solves - c1.solves, 1, "the context that lost w3");
  rt.shutdown();
});

// ---------------------------------------------------------------- config diff

function snap(flat: Record<string, unknown>, revision = 1): ConfigSnapshot {
  const r = compileConfig(flat, revision);
  if (!r.ok) assert.fail(r.errors.map(formatError).join("; "));
  return r.snapshot;
}

function doc(d: Record<string, unknown>, flat: Record<string, unknown> = {}): ConfigSnapshot {
  return snap({ ...flat, configJson: JSON.stringify({ schemaVersion: 1, ...d }) });
}

test("diffConfig: what an activation changed (rules, settings, diagnostics)", () => {
  const rule = { id: "r", match: { appId: { regex: "^kon", flags: "i" }, windowType: ["dialog", "normal"] }, actions: { mode: "floating" } };
  const ov = { id: "o", match: { outputName: "DP-1" }, set: { gaps: { inner: 4 } } };
  const base = doc({ rules: [rule], overrides: [ov] }, { gapInner: "8" });
  const none = { rules: false, settings: false, diagnostics: false };
  assert.deepEqual(diffConfig(base, doc({ rules: [rule], overrides: [ov] }, { gapInner: "8" })), none, "recompiled, identical");
  assert.deepEqual(diffConfig(base, doc({ rules: [rule], overrides: [ov] }, { gapInner: "12" })), { ...none, settings: true });
  assert.deepEqual(diffConfig(base, doc({ rules: [rule], overrides: [{ ...ov, set: { gaps: { inner: 6 } } }] }, { gapInner: "8" })),
    { ...none, settings: true }, "an override's patch");
  assert.deepEqual(diffConfig(base, doc({ rules: [rule], overrides: [{ ...ov, match: { outputName: "DP-2" } }] }, { gapInner: "8" })),
    { ...none, settings: true }, "an override's matcher");
  assert.deepEqual(diffConfig(base, doc({ rules: [{ ...rule, match: { ...rule.match, appId: { regex: "^kon" } } }], overrides: [ov] }, { gapInner: "8" })),
    { ...none, rules: true }, "a regex flag");
  assert.deepEqual(diffConfig(base, doc({ rules: [{ ...rule, match: { ...rule.match, windowType: ["normal", "dialog"] } }], overrides: [ov] }, { gapInner: "8" })),
    none, "the same window-type set in another order");
  assert.deepEqual(diffConfig(base, doc({ rules: [rule, { ...rule, id: "r2" }], overrides: [ov] }, { gapInner: "8" })), { ...none, rules: true });
  assert.deepEqual(diffConfig(base, doc({ rules: [rule], overrides: [ov] }, { gapInner: "8", diagnostics: "debug" })), { ...none, diagnostics: true });
  assert.deepEqual(diffConfig(null, base), { rules: true, settings: true, diagnostics: true }, "first activation");
});
