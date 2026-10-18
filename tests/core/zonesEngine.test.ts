// Zones layout replay tests (experimental, docs/design/ZONES.md §5) with the mock compositor.
// Oracles: the mock's write log and committed frames, compared with the pure projection
// (projectZones) and with the overlay model the runtime draws (Engine.zoneOverlay).

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect } from "../../src/core/geometry.ts";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import type { ContextSettings } from "../../src/core/types.ts";
import type { WindowRules } from "../../src/core/engine.ts";
import { projectZones } from "../../src/core/layouts/zones.ts";
import { MockHost } from "./mockHost.ts";

const ZONES: ContextSettings = { ...DEFAULT_SETTINGS, layout: "zones" };
const AREA = rect(0, 0, 1280, 800);
const HALVES = projectZones(DEFAULT_SETTINGS.zones.layouts[0].zones, AREA, DEFAULT_SETTINGS.gaps);

function setup(ids: string[], settings: ContextSettings | (() => ContextSettings) = ZONES,
  rulesFor?: (appId: string) => WindowRules | null) {
  const h = new MockHost();
  const get = typeof settings === "function" ? settings : () => settings;
  const e = h.start({ settingsFor: () => get(), rulesFor: rulesFor ? (m) => rulesFor(m.appId) : undefined });
  ids.forEach((id, i) => {
    h.open(id, { frame: rect(60 + 40 * i, 50 + 30 * i, 400, 300) });
    h.activate(id);
    h.drain();
  });
  return { h, e };
}

function run(h: MockHost, cmd: string, active?: string) {
  if (active) h.activate(active);
  const r = h.engine.execute(cmd.startsWith("plastile.") ? cmd : "plastile." + cmd);
  h.drain();
  return r;
}

test("adoption into a zones context moves nothing: unassigned windows are ordinary floating windows", () => {
  const { h, e } = setup(["a", "b", "c"]);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(e.check(), []);
  assert.deepEqual(e.membersOf({ output: "O1", desktop: "D1", activity: "default" }).sort(), ["a", "b", "c"]);
  // A user moving an unassigned window is never corrected.
  h.userSetFrame("a", rect(500, 400, 300, 200));
  h.advance(1000);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.windows.get("a")!.frame, rect(500, 400, 300, 200));
});

test("assign is one solve and one write; repeating it is a no-op with zero writes", () => {
  const { h, e } = setup(["a", "b", "c"]);
  const solves = e.counters.solves;
  const r = run(h, "zone.assign-2", "b");
  assert.equal(r.status, "accepted");
  assert.deepEqual(h.writes.map((w) => w.id), ["b"]);
  assert.equal(e.counters.solves, solves + 1);
  assert.deepEqual(h.windows.get("b")!.frame, HALVES[1]);
  const again = run(h, "zone.assign-2", "b");
  assert.equal(again.status, "noop");
  assert.equal(again.reason, "already in zone 2");
  assert.equal(h.writes.length, 1, "no further writes");
  // A second window in the other zone: one write for it, none for b.
  run(h, "zone.assign-1", "c");
  assert.deepEqual(h.writes.map((w) => w.id), ["b", "c"]);
  assert.deepEqual(h.windows.get("c")!.frame, HALVES[0]);
  assert.equal(e.explain("c")!.zone && (e.explain("c")!.zone as { zone: number }).zone, 1);
  const missing = run(h, "zone.assign-3", "a");
  assert.equal(missing.status, "noop");
  assert.equal(missing.reason, 'zone 3 does not exist in zone layout "halves" (2 zones)');
  assert.equal(e.outstandingCount(), 0);
});

test("the overlay model is the engine's projection: its rectangles equal the frames assigned windows get", () => {
  const { h, e } = setup(["a", "b"]);
  h.areas.set("O1/D1", rect(0, 32, 1280, 768)); // a top panel
  e.workAreaChanged(["O1"]);
  h.drain();
  run(h, "zone.assign-1", "a");
  run(h, "zone.assign-2", "b");
  const m = e.zoneOverlay();
  assert.ok(!("reason" in m));
  if ("reason" in m) return;
  assert.equal(m.layout, "halves");
  assert.deepEqual(m.geometry, rect(0, 0, 1280, 800));
  assert.deepEqual(m.zones.map((z) => z.rect), [h.windows.get("a")!.frame, h.windows.get("b")!.frame]);
  assert.deepEqual(m.zones.map((z) => z.windows), [1, 1]);
  assert.equal(m.zones[0].rect.y, 40, "work area plus outer gap");
});

test("zone.next and zone.previous move the focused window and wrap; unassigned goes to zone 1", () => {
  const { h } = setup(["a"]);
  run(h, "zone.next", "a");
  assert.deepEqual(h.windows.get("a")!.frame, HALVES[0]);
  run(h, "zone.next");
  assert.deepEqual(h.windows.get("a")!.frame, HALVES[1]);
  run(h, "zone.next");
  assert.deepEqual(h.windows.get("a")!.frame, HALVES[0]);
  run(h, "zone.previous");
  assert.deepEqual(h.windows.get("a")!.frame, HALVES[1]);
  assert.equal(h.writes.length, 4, "one write per move");
});

test("zone.unassign releases the window where it is (no write); it then floats freely", () => {
  const { h, e } = setup(["a"]);
  run(h, "zone.assign-1", "a");
  const writes = h.writes.length;
  assert.equal(run(h, "zone.unassign").status, "accepted");
  assert.equal(h.writes.length, writes);
  assert.deepEqual(h.windows.get("a")!.frame, HALVES[0]);
  h.userSetFrame("a", rect(300, 300, 500, 300));
  h.advance(1000);
  assert.equal(h.writes.length, writes, "no correction once released");
  assert.equal(run(h, "zone.unassign").status, "noop");
  assert.equal((e.explain("a")!.zone as { zone: number | null }).zone, null);
});

test("toggle-float on a zoned window unassigns it and restores its float rectangle (one write)", () => {
  const { h, e } = setup(["a", "b"]);
  const before = { ...h.windows.get("a")!.frame };
  run(h, "zone.assign-1", "a");
  run(h, "zone.assign-2", "b");
  const writes = h.writes.length;
  assert.equal(run(h, "window.toggle-float", "a").status, "accepted");
  assert.deepEqual(h.windows.get("a")!.frame, before);
  assert.deepEqual(h.writes.slice(writes).map((w) => w.id), ["a"], "only the restore write; b untouched");
  assert.equal(e.modeOf("a"), "floating");
  // Toggling back makes it an unassigned member: no write.
  run(h, "window.toggle-float", "a");
  assert.equal(e.modeOf("a"), "tiled");
  assert.equal(h.writes.length, writes + 1);
  assert.deepEqual(h.windows.get("a")!.frame, before);
  assert.deepEqual(e.check(), []);
});

test("a user-floated window gets an actionable reason from zone.assign", () => {
  const { h } = setup(["a"]);
  run(h, "window.toggle-float", "a");
  const r = run(h, "zone.assign-1");
  assert.equal(r.status, "noop");
  assert.match(r.reason!, /toggle it back/);
});

test("layout switch releases zone ownership without moving windows", () => {
  const { h, e } = setup(["a", "b", "c"]);
  run(h, "zone.assign-1", "a");
  run(h, "zone.assign-2", "b");
  const frames = h.framesOf(["a", "b", "c"]);
  const writes = h.writes.length;
  assert.equal(run(h, "layout.floating").status, "accepted");
  h.advance(1000);
  assert.equal(h.writes.length, writes, "switching to floating moves nothing back");
  assert.deepEqual(h.framesOf(["a", "b", "c"]), frames);
  assert.equal(run(h, "layout.zones").status, "accepted");
  h.advance(1000);
  assert.equal(h.writes.length, writes, "back to zones: the assignments were released, nothing moves");
  assert.equal((e.explain("a")!.zone as { zone: number | null }).zone, null);
  // To master/stack: the release itself writes nothing; master/stack then places every member.
  run(h, "zone.assign-1", "a");
  const w2 = h.writes.length;
  run(h, "layout.master-stack");
  assert.equal(h.writes.length - w2, 3, "one write per member, by master/stack");
  assert.deepEqual(e.check(), []);
});

test("suspend and stop release zone ownership without moving windows", () => {
  const { h, e } = setup(["a", "b"]);
  run(h, "zone.assign-1", "a");
  run(h, "zone.assign-2", "b");
  const frames = h.framesOf(["a", "b"]);
  const writes = h.writes.length;
  run(h, "runtime.toggle-suspend");
  run(h, "runtime.toggle-suspend");
  h.advance(1000);
  assert.equal(h.writes.length, writes);
  assert.deepEqual(h.framesOf(["a", "b"]), frames);
  assert.equal((e.explain("a")!.zone as { zone: number | null }).zone, null, "resume does not re-take the windows");
  run(h, "zone.assign-1", "a");
  const w2 = h.writes.length;
  e.stop();
  h.advance(1000);
  assert.equal(h.writes.length, w2);
});

test("a configuration that changes the layout away from zones releases without moving windows", () => {
  let settings = ZONES;
  const { h, e } = setup(["a"], () => settings);
  run(h, "zone.assign-2", "a");
  const writes = h.writes.length;
  settings = { ...DEFAULT_SETTINGS, layout: "floating" };
  e.configure({ settingsFor: () => settings });
  h.advance(1000);
  assert.equal(h.writes.length, writes);
  settings = ZONES;
  e.configure({ settingsFor: () => settings });
  h.advance(1000);
  assert.equal(h.writes.length, writes, "assignments do not come back");
});

test("zone.layout-next keeps zone indices that exist (one write per changed window) and releases the rest", () => {
  const { h, e } = setup(["a", "b", "c"]);
  run(h, "zone.assign-1", "a");
  run(h, "zone.assign-2", "b");
  const writes = h.writes.length;
  assert.equal(run(h, "zone.layout-next").status, "accepted"); // halves -> thirds
  const thirds = projectZones(DEFAULT_SETTINGS.zones.layouts[1].zones, AREA, DEFAULT_SETTINGS.gaps);
  assert.deepEqual(h.framesOf(["a", "b"]), { a: thirds[0], b: thirds[1] });
  assert.deepEqual(h.writes.slice(writes).map((w) => w.id).sort(), ["a", "b"]);
  run(h, "zone.assign-3", "c");
  run(h, "zone.layout-next"); // -> grid-2x2: indices 0..2 exist
  run(h, "zone.layout-next"); // -> main-side: c (zone 3) is released where it is
  const cFrame = h.windows.get("c")!.frame;
  const grid = projectZones(DEFAULT_SETTINGS.zones.layouts[2].zones, AREA, DEFAULT_SETTINGS.gaps);
  assert.deepEqual(cFrame, grid[2], "c stays where grid-2x2 put it");
  assert.equal((e.explain("c")!.zone as { zone: number | null; layout: string }).zone, null);
  assert.equal((e.explain("a")!.zone as { layout: string }).layout, "main-side");
  h.userSetFrame("c", rect(10, 10, 300, 300));
  h.advance(1000);
  assert.deepEqual(h.windows.get("c")!.frame, rect(10, 10, 300, 300), "released: not corrected");
});

test("a configured zones.layout change releases assignments to zones the new layout lacks", () => {
  let settings: ContextSettings = { ...ZONES, zones: { ...DEFAULT_SETTINGS.zones, layout: "grid-2x2" } };
  const { h, e } = setup(["a", "b"], () => settings);
  run(h, "zone.assign-1", "a");
  run(h, "zone.assign-4", "b");
  const bFrame = { ...h.windows.get("b")!.frame };
  settings = { ...ZONES, zones: { ...DEFAULT_SETTINGS.zones, layout: "halves" } };
  e.configure({ settingsFor: () => settings });
  h.advance(1000);
  assert.deepEqual(h.windows.get("a")!.frame, HALVES[0]);
  assert.deepEqual(h.windows.get("b")!.frame, bFrame, "zone 4 is gone: released where it was");
  assert.equal((e.explain("b")!.zone as { zone: number | null }).zone, null);
});

test("rule action zone assigns a new window when it joins a zones context; a missing zone is explained", () => {
  const rules = (app: string): WindowRules | null =>
    app === "term" ? { zone: 2, ruleIds: ["r"], reasons: { zone: "rule r" } }
    : app === "far" ? { zone: 9, ruleIds: ["f"], reasons: { zone: "rule f" } } : null;
  const { h, e } = setup([], ZONES, rules);
  h.open("t", { meta: { ...h.make("tmp").meta, appId: "term" } });
  h.windows.delete("tmp");
  h.drain();
  assert.deepEqual(h.writes.map((w) => w.id), ["t"]);
  assert.deepEqual(h.windows.get("t")!.frame, HALVES[1]);
  h.open("f", { meta: { ...h.windows.get("t")!.meta, appId: "far" } });
  h.drain();
  assert.equal(h.writesTo("f"), 0);
  assert.match(String((e.explain("f")!.zone as { note: string }).note), /^rule f: zone 9 does not exist in zone layout "halves" \(2 zones\); the window floats$/);
  assert.equal((e.explain("f")!.rules as { actions: Record<string, string> }).actions.zone, "9");
});

test("a minimum that does not fit: zone origin and minimum size, explained; the client is not fought", () => {
  const { h, e } = setup([]);
  h.open("big", { constraints: { minFrame: { width: 900, height: 100 }, maxFrame: { width: Infinity, height: Infinity }, fixed: false },
    clampToMin: true });
  h.activate("big");
  h.drain();
  run(h, "zone.assign-2", "big");
  h.advance(2000);
  const z = HALVES[1];
  assert.deepEqual(h.windows.get("big")!.frame, rect(z.x, z.y, 900, z.height));
  assert.equal(h.writesTo("big"), 1, "one write, no corrections");
  assert.match(String((e.explain("big")!.zone as { note: string }).note), /minimum size 900x100 does not fit zone 2/);
});

test("windows sharing a zone stack; the most recently assigned is raised, activation changes the top", () => {
  const { h } = setup(["a", "b"]);
  run(h, "zone.assign-1", "a");
  run(h, "zone.assign-1", "b");
  assert.deepEqual(h.windows.get("a")!.frame, h.windows.get("b")!.frame);
  assert.equal(h.raises[h.raises.length - 1], "b");
  h.activate("a"); // the user clicks the lower one: no solve, but it is the zone's top now
  h.drain();
  run(h, "zone.assign-2", "a");
  run(h, "zone.assign-1", "a");
  assert.equal(h.raises[h.raises.length - 1], "a");
});

test("a user drag of a zoned window releases it where it was dropped (no snap back)", () => {
  const { h, e } = setup(["a"]);
  run(h, "zone.assign-1", "a");
  const writes = h.writes.length;
  h.setStates("a", { interactive: "move" });
  h.userSetFrame("a", rect(700, 300, HALVES[0].width, HALVES[0].height));
  h.setStates("a", { interactive: "none" });
  h.advance(1000);
  assert.equal(h.writes.length, writes, "no snap back");
  assert.deepEqual(h.windows.get("a")!.frame, rect(700, 300, HALVES[0].width, HALVES[0].height));
  assert.equal((e.explain("a")!.zone as { zone: number | null }).zone, null);
});

test("zone commands outside a zones context are no-ops with a reason; zone.show is the runtime's", () => {
  const { h } = setup(["a"], DEFAULT_SETTINGS);
  const writes = h.writes.length;
  for (const c of ["zone.assign-1", "zone.next", "zone.previous", "zone.unassign", "zone.layout-next"]) {
    const r = run(h, c, "a");
    assert.equal(r.status, "noop", c);
    assert.equal(r.reason, "the layout here is not zones", c);
  }
  assert.equal(run(h, "zone.show").reason, "handled by the host adapter");
  assert.equal(h.writes.length, writes);
  const m = h.engine.zoneOverlay();
  assert.ok("reason" in m && /master-stack, not zones/.test((m as { reason: string }).reason));
});

test("layout cycle never enters zones; plastile.layout.zones selects it", () => {
  const { h, e } = setup(["a"], DEFAULT_SETTINGS);
  const seen = new Set<string>();
  for (let i = 0; i < 6; ++i) { run(h, "layout.next", "a"); seen.add(e.contextSummary()[0].layout); }
  assert.ok(!seen.has("zones"));
  run(h, "layout.zones");
  assert.equal(e.contextSummary()[0].layout, "zones");
});

test("closing a zoned window leaves no assignment behind", () => {
  const { h, e } = setup(["a", "b"]);
  run(h, "zone.assign-1", "a");
  h.close("a");
  h.drain();
  assert.deepEqual(e.check(), []);
  const m = e.zoneOverlay();
  assert.ok(!("reason" in m) && m.zones.every((z) => z.windows === 0));
});
