// Window rules end to end in the engine (T25): compiled configuration -> runtime engine
// options -> engine -> mock compositor. Oracles are the mock's committed frames, the write
// log and the engine's recorded mode, never the rule resolver's own claims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compileConfig, formatError, type ConfigSnapshot } from "../../src/config/index.ts";
import { engineOptions } from "../../src/runtime/main.ts";
import { MockHost, meta } from "./mockHost.ts";
import { assertTiling } from "./helpers.ts";
import { rect } from "../../src/core/geometry.ts";

const AREA = rect(0, 0, 1280, 800);
const NAMES: Record<string, string> = { D1: "Main", D2: "Writing" };
const names = { desktopNameOf: (id: string) => NAMES[id] ?? "" };

function snap(doc: unknown, revision = 1): ConfigSnapshot {
  const r = compileConfig({ configJson: JSON.stringify({ schemaVersion: 1, ...(doc as object) }) }, revision);
  if (!r.ok) assert.fail(r.errors.map(formatError).join("; "));
  return r.snapshot;
}

function frames(h: MockHost, ids: string[]) {
  return new Map(ids.map((id) => [id, h.windows.get(id)!.frame] as const));
}

test("minSize: a tile is never smaller than the rule's minimum usable size", () => {
  const h = new MockHost();
  const e = h.start(engineOptions(snap({ rules: [{ id: "wide-b", match: { appId: "b" }, actions: { minSize: { width: 700 } } }] }), names));
  for (const id of ["a", "b", "c"]) h.open(id);
  h.drain();
  assert.deepEqual(["a", "b", "c"].map((id) => e.modeOf(id)), ["tiled", "tiled", "tiled"]);
  assert.ok(h.windows.get("b")!.frame.width >= 700, `b got ${JSON.stringify(h.windows.get("b")!.frame)}`);
  assertTiling(frames(h, ["a", "b", "c"]), AREA);
  const x = e.explain("b")!;
  assert.deepEqual((x.rules as { actions: unknown }).actions, { minSize: "700x0" });
  assert.equal((x.constraints as { minFrame: { width: number } }).minFrame.width, 700);
});

test("minSize: an unusably small slot overflows (float-new); removing the rule re-tiles the window", () => {
  const h = new MockHost();
  const e = h.start(engineOptions(snap({ rules: [{ id: "huge", match: { appId: "c" }, actions: { minSize: { width: 1300 } } }] }), names));
  for (const id of ["a", "b", "c"]) h.open(id);
  h.drain();
  assert.equal(e.modeOf("c"), "floating");
  assert.match(String(e.explain("c")!.exception), /^overflow/);
  assertTiling(frames(h, ["a", "b"]), AREA);
  const before = h.writes.filter((w) => w.id === "c").length;
  assert.equal(before, 0, "the overflowed window was never written");
  e.configure(engineOptions(snap({ rules: [] }, 2), names));
  h.drain();
  assert.equal(e.modeOf("c"), "tiled");
  assertTiling(frames(h, ["a", "b", "c"]), AREA);
});

test("minSize from a title rule: a caption change that starts matching re-solves the context once", () => {
  const h = new MockHost();
  const opts = engineOptions(snap({ rules: [{ id: "busy", match: { title: { glob: "busy*" } }, actions: { minSize: { width: 900 } } }] }), names);
  const e = h.start(opts);
  for (const id of ["a", "b"]) h.open(id);
  h.drain();
  const w0 = h.windows.get("b")!.frame.width;
  assert.ok(w0 < 900, `b starts narrower (${w0})`);
  const solves = e.counters.solves;
  const b = h.windows.get("b")!;
  b.meta = meta("b", { title: "busy: compiling" });
  e.metadataChanged("b", b.gen, b.meta);
  h.drain();
  assert.equal(e.counters.solves, solves + 1, "one solve for the changed constraint");
  assert.ok(h.windows.get("b")!.frame.width >= 900, `b grew to ${h.windows.get("b")!.frame.width}`);
  assertTiling(frames(h, ["a", "b"]), AREA);
});

test("context rules: a membership change re-evaluates rules that match the desktop (T25)", () => {
  const h = new MockHost();
  h.visible.set("O1", "D1");
  const doc = { rules: [{ id: "writing-floats", match: { desktopName: "Writing" }, actions: { mode: "floating" } },
                        { id: "main-borderless", match: { desktopId: "D1", appId: "a" }, actions: { border: "none" } }] };
  const e = h.start(engineOptions(snap(doc), names));
  h.open("a");
  h.open("b");
  h.drain();
  assert.equal(e.modeOf("a"), "tiled");
  assert.equal(h.windows.get("a")!.noBorder, true, "border rule matched on desktop D1");
  assert.deepEqual((e.explain("a")!.rules as { ids: string[] }).ids, ["main-borderless"]);
  const a = h.windows.get("a")!;
  h.sendToDesktop("a", a.gen, "D2");
  h.drain();
  assert.equal(e.modeOf("a"), "floating", "on Writing the window floats by rule");
  assert.deepEqual((e.explain("a")!.decision as { ruleIds: string[] }).ruleIds, ["writing-floats"]);
  assert.equal(h.windows.get("a")!.noBorder, false, "the D1-only border rule no longer applies; its change is restored");
  h.sendToDesktop("a", a.gen, "D1");
  h.drain();
  assert.equal(e.modeOf("a"), "tiled");
  assertTiling(frames(h, ["a", "b"]), AREA);
  assert.deepEqual(e.check(), []);
});

test("context rules do not apply to a window on all desktops (no single context)", () => {
  const h = new MockHost();
  const e = h.start(engineOptions(snap({ rules: [{ id: "main", match: { desktopName: "Main" }, actions: { border: "none" } }] }), names));
  h.open("a", { membership: { output: "O1", desktops: [], onAllDesktops: true, activities: [] } });
  h.drain();
  assert.equal(e.modeOf("a"), "floating");
  assert.equal(e.explain("a")!.rules, null);
  assert.equal(h.windows.get("a")!.noBorder, false);
});
