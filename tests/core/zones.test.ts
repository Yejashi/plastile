// Zones layout, pure parts (experimental, docs/design/ZONES.md §5): projection against
// independent oracles, validation limits and messages, assignment and layout cycling,
// minimum-size placement. Oracles check properties (containment, exact area edges, exactly one
// inner gap between shared edges, nearest-pixel edges) or compare with another consumer of the
// same arithmetic (master/stack at ratio 0.5), never the projection formula itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rect, type Rect } from "../../src/core/geometry.ts";
import { BUILTIN_ZONE_LAYOUTS, DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import type { ContextSettings, GapSettings, ZoneLayout, ZoneRect } from "../../src/core/types.ts";
import { masterStack } from "../../src/core/layouts/masterStack.ts";
import { allocate } from "../../src/core/layouts/allocate.ts";
import {
  activeZoneLayout, assignZone, bumpZone, nextZoneLayout, projectZones, pruneZones, stepZone, unassignZone, zoneOf, zones,
  type ZoneState,
} from "../../src/core/layouts/zones.ts";
import { compileConfig, formatError, resolveContext, resolveWindow, type ConfigSnapshot } from "../../src/config/index.ts";
import { input, minC, prng } from "./helpers.ts";

const GAPS: GapSettings = DEFAULT_SETTINGS.gaps;
const EMPTY: ZoneState = { layout: null, assigned: {}, order: [] };
const layoutOf = (id: string): ZoneLayout => BUILTIN_ZONE_LAYOUTS.find((l) => l.id === id)!;
const zs = (patch: Partial<ContextSettings["zones"]> = {}): ContextSettings =>
  ({ ...DEFAULT_SETTINGS, layout: "zones", zones: { ...DEFAULT_SETTINGS.zones, ...patch } });

/**
 * Independent oracle for one projection: every rectangle inside the gap-inset area with positive
 * size; a zone side on the area edge lies exactly on it; an interior edge at normalized u lies
 * within one pixel plus a gap of the ideal position and is a whole pixel; and two zones
 * whose normalized edges coincide (and overlap along that edge) are exactly one inner gap apart.
 */
function projectionErrors(zl: readonly ZoneRect[], area: Rect, gaps: GapSettings, out: Rect[]): string[] {
  const errs: string[] = [];
  const a = { x: area.x + gaps.outer.left, y: area.y + gaps.outer.top,
              width: area.width - gaps.outer.left - gaps.outer.right, height: area.height - gaps.outer.top - gaps.outer.bottom };
  const eps = 1e-6, g = gaps.inner;
  const near = (p: number, q: number, tol: number) => Math.abs(p - q) <= tol;
  zl.forEach((z, i) => {
    const r = out[i];
    if (!(r.width > 0 && r.height > 0)) errs.push(`${i}: non-positive ${JSON.stringify(r)}`);
    if (r.x < a.x - eps || r.y < a.y - eps || r.x + r.width > a.x + a.width + eps || r.y + r.height > a.y + a.height + eps) {
      errs.push(`${i}: ${JSON.stringify(r)} outside ${JSON.stringify(a)}`);
    }
    const sides: Array<[number, number, number, number, number]> = [
      // [normalized position, pixel position, area start, area length, sign of the gap share]
      [z.x, r.x, a.x, a.width, +1], [z.x + z.width, r.x + r.width, a.x, a.width, -1],
      [z.y, r.y, a.y, a.height, +1], [z.y + z.height, r.y + r.height, a.y, a.height, -1],
    ];
    for (const [u, p, s, len] of sides) {
      if (u <= eps) { if (!near(p, s, eps)) errs.push(`${i}: side at 0 is ${p}, area edge ${s}`); continue; }
      if (u >= 1 - eps) { if (!near(p, s + len, eps)) errs.push(`${i}: side at 1 is ${p}, area edge ${s + len}`); continue; }
      if (!Number.isInteger(p)) errs.push(`${i}: interior edge ${p} is not a whole pixel`);
      if (!near(p, s + u * len, 1 + g + eps)) errs.push(`${i}: interior edge ${p} far from ideal ${s + u * len}`);
    }
  });
  for (let i = 0; i < zl.length; ++i) {
    for (let j = 0; j < zl.length; ++j) {
      if (i === j) continue;
      const A = zl[i], B = zl[j], ra = out[i], rb = out[j];
      const yOverlap = Math.min(A.y + A.height, B.y + B.height) - Math.max(A.y, B.y) > eps;
      const xOverlap = Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x) > eps;
      if (yOverlap && Math.abs(A.x + A.width - B.x) < eps && A.x + A.width < 1 - eps && !near(rb.x - (ra.x + ra.width), g, eps)) {
        errs.push(`${i}|${j}: shared vertical edge gap ${rb.x - (ra.x + ra.width)}, want ${g}`);
      }
      if (xOverlap && Math.abs(A.y + A.height - B.y) < eps && A.y + A.height < 1 - eps && !near(rb.y - (ra.y + ra.height), g, eps)) {
        errs.push(`${i}|${j}: shared horizontal edge gap ${rb.y - (ra.y + ra.height)}, want ${g}`);
      }
    }
  }
  return errs;
}

// ------------------------------------------------------------------ projection

test("projection: halves equals master/stack at ratio 0.5 (another consumer of the same arithmetic)", () => {
  for (const area of [rect(0, 0, 1280, 800), rect(0, 0, 1281, 801), rect(1280, 0, 1706.6667, 1066.6667), rect(-1920, -40, 1919, 1080)]) {
    for (const inner of [0, 7, 8, 13]) {
      const settings: ContextSettings = { ...DEFAULT_SETTINGS, gaps: { inner, outer: GAPS.outer },
        masterStack: { ...DEFAULT_SETTINGS.masterStack, ratio: 0.5 } };
      const ms = masterStack.solve(masterStack.initial(settings), input(["a", "b"], { area, settings })).slots;
      const z = projectZones(layoutOf("halves").zones, area, settings.gaps);
      assert.deepEqual(z, [ms.get("a"), ms.get("b")], `${JSON.stringify(area)} gap ${inner}`);
    }
  }
});

test("projection: equal fractions give the pixels allocate() gives (columns and rows of a uniform grid)", () => {
  for (const area of [rect(0, 0, 1280, 800), rect(0, 0, 1281, 803), rect(-1919, 17, 1919, 1081), rect(5, 7, 997, 611)]) {
    for (const inner of [0, 7, 8]) {
      for (const n of [1, 2, 3, 4, 5]) {
        const zl = Array.from({ length: n * n }, (_v, k) => ({ x: (k % n) / n, y: Math.floor(k / n) / n, width: 1 / n, height: 1 / n }));
        const gaps = { inner, outer: GAPS.outer };
        const out = projectZones(zl, area, gaps);
        const a = { x: area.x + 8, y: area.y + 8, width: area.width - 16, height: area.height - 16 };
        const cols = allocate(a.x, a.width, Array(n).fill(1), Array(n).fill(0), inner)!;
        const rows = allocate(a.y, a.height, Array(n).fill(1), Array(n).fill(0), inner)!;
        const want = zl.map((_z, k) => {
          const [x0, x1] = cols[k % n], [y0, y1] = rows[Math.floor(k / n)];
          return rect(x0, y0, x1 - x0, y1 - y0);
        });
        assert.deepEqual(out, want, `${n}x${n} ${JSON.stringify(area)} gap ${inner}`);
      }
    }
  }
});

test("projection: every built-in layout satisfies the oracle on odd, fractional and negative-origin areas", () => {
  const areas = [rect(0, 0, 1280, 800), rect(0, 0, 1279, 799), rect(-1280, -800, 1280, 800), rect(0.5, 26.25, 1706.6667, 1033.3333),
    rect(-853.3333, 0, 853.3333, 480), rect(3, 5, 101, 77)];
  for (const l of BUILTIN_ZONE_LAYOUTS) {
    for (const area of areas) {
      for (const inner of [0, 1, 8, 9]) {
        const gaps = { inner, outer: { top: 8, right: 3, bottom: 5, left: 0 } };
        const out = projectZones(l.zones, area, gaps);
        assert.deepEqual(projectionErrors(l.zones, area, gaps, out), [], `${l.id} ${JSON.stringify(area)} gap ${inner}`);
      }
    }
  }
});

test("projection: a zone's rectangle is shared with exactly one inner gap (thirds, explicit numbers)", () => {
  const z = projectZones(layoutOf("thirds").zones, rect(0, 0, 1280, 800), GAPS);
  // Usable 8..1272 (1264 px) holds three 416 px zones and two 8 px gaps: cuts at 424 and 848.
  assert.deepEqual(z, [rect(8, 8, 416, 784), rect(432, 8, 416, 784), rect(856, 8, 416, 784)]);
  assert.equal(z[1].x - (z[0].x + z[0].width), 8);
  assert.equal(z[2].x - (z[1].x + z[1].width), 8);
  // Spec notation 0.3333/0.3334/0.6667 is the same layout on the 1e-6 grid.
  const spec = [{ x: 0, y: 0, width: 0.3333, height: 1 }, { x: 0.3333, y: 0, width: 0.3334, height: 1 },
    { x: 0.6667, y: 0, width: 0.3333, height: 1 }];
  const s = projectZones(spec, rect(0, 0, 1280, 800), GAPS);
  assert.equal(s[1].x - (s[0].x + s[0].width), 8);
  assert.equal(s[2].x - (s[1].x + s[1].width), 8);
  assert.equal(s[2].x + s[2].width, 1272, "ends exactly at the area edge");
});

test("projection: overlapping zones (a full-height zone and two half-height zones) are allowed", () => {
  const zl = [{ x: 0, y: 0, width: 0.5, height: 1 }, { x: 0.5, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    { x: 0, y: 0, width: 1, height: 1 }];
  const out = projectZones(zl, rect(0, 0, 1000, 600), GAPS);
  assert.deepEqual(projectionErrors(zl, rect(0, 0, 1000, 600), GAPS, out), []);
  assert.deepEqual(out[3], rect(8, 8, 984, 584));
});

test("projection property: random grids, areas and gaps satisfy the oracle (seeded)", () => {
  const rnd = prng(0x2e0e5);
  for (let iter = 0; iter < 400; ++iter) {
    const cols = 1 + Math.floor(rnd() * 5), rows = 1 + Math.floor(rnd() * 4);
    const xs = [0], ys = [0];
    for (let i = 1; i < cols; ++i) xs.push(Math.round((i / cols + (rnd() - 0.5) * 0.1) * 1e4) / 1e4);
    for (let i = 1; i < rows; ++i) ys.push(Math.round((i / rows + (rnd() - 0.5) * 0.1) * 1e4) / 1e4);
    xs.push(1); ys.push(1);
    const zl: ZoneRect[] = [];
    for (let r = 0; r < rows; ++r) for (let c = 0; c < cols; ++c) {
      zl.push({ x: xs[c], y: ys[r], width: Math.round((xs[c + 1] - xs[c]) * 1e4) / 1e4, height: Math.round((ys[r + 1] - ys[r]) * 1e4) / 1e4 });
    }
    const area = rect((rnd() - 0.5) * 6000, (rnd() - 0.5) * 3000, 600 + rnd() * 3000, 400 + rnd() * 1800);
    const g = Math.floor(rnd() * 21), o = Math.floor(rnd() * 21);
    const gaps = { inner: g, outer: { top: o, right: o, bottom: o, left: o } };
    const out = projectZones(zl, area, gaps);
    assert.deepEqual(projectionErrors(zl, area, gaps, out), [], `iter ${iter}: ${JSON.stringify({ area, gaps, zl })}`);
  }
});

// ------------------------------------------------------------------ solve

test("solve: only assigned participants get slots; unassigned members are left alone", () => {
  const settings = zs();
  const st = assignZone(EMPTY, "b", 1, 2).state;
  const r = zones.solve(st, input(["a", "b", "c"], { area: rect(0, 0, 1280, 800), settings }));
  assert.deepEqual([...r.slots.keys()], ["b"]);
  assert.deepEqual(r.slots.get("b"), projectZones(layoutOf("halves").zones, rect(0, 0, 1280, 800), GAPS)[1]);
  assert.deepEqual(r.overflow, []);
  assert.deepEqual(r.raise, [], "a zone with one window raises nothing");
});

test("solve: windows sharing a zone stack and the most recently assigned (or activated) one is raised", () => {
  const settings = zs();
  let st = assignZone(EMPTY, "a", 0, 2).state;
  st = assignZone(st, "b", 0, 2).state;
  const inp = input(["a", "b"], { area: rect(0, 0, 1280, 800), settings });
  const r = zones.solve(st, inp);
  assert.deepEqual(r.slots.get("a"), r.slots.get("b"));
  assert.deepEqual(r.raise, ["b"]);
  assert.deepEqual(zones.solve(bumpZone(st, "a"), inp).raise, ["a"], "activation makes a window the top of its zone");
});

test("solve: a minimum that does not fit gets the zone's origin and the minimum, with an explanation", () => {
  const settings = zs();
  const st = assignZone(EMPTY, "a", 1, 2).state;
  const z = projectZones(layoutOf("halves").zones, rect(0, 0, 1280, 800), GAPS)[1];
  const r = zones.solve(st, input(["a"], { area: rect(0, 0, 1280, 800), settings, constraints: new Map([["a", minC(900, 200)]]) }));
  assert.deepEqual(r.slots.get("a"), rect(z.x, z.y, 900, z.height), "origin kept; width grows to the minimum, height stays the zone's");
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /^a: minimum size 900x200 does not fit zone 2 \(628x784\); placed at the zone's origin at its minimum size$/);
  const fits = zones.solve(st, input(["a"], { area: rect(0, 0, 1280, 800), settings, constraints: new Map([["a", minC(300, 200)]]) }));
  assert.deepEqual(fits.slots.get("a"), z);
  assert.deepEqual(fits.notes, []);
});

test("solve: an assignment beyond the active layout's zones is not placed and is explained", () => {
  const st = assignZone(EMPTY, "a", 3, 4).state;
  const r = zones.solve(st, input(["a"], { area: rect(0, 0, 1280, 800), settings: zs() }));
  assert.equal(r.slots.size, 0);
  assert.match(r.notes[0], /zone 4 does not exist in zone layout "halves"/);
});

// ------------------------------------------------------------------ operations

test("assign, repeat, next, previous, unassign", () => {
  let o = assignZone(EMPTY, "a", 1, 3, "thirds");
  assert.ok(o.changed);
  assert.equal(zoneOf(o.state, "a"), 1);
  const again = assignZone(o.state, "a", 1, 3);
  assert.equal(again.changed, false);
  assert.equal(again.reason, "already in zone 2");
  assert.equal(again.state, o.state);
  const missing = assignZone(o.state, "a", 4, 3, "thirds");
  assert.equal(missing.changed, false);
  assert.equal(missing.reason, 'zone 5 does not exist in zone layout "thirds" (3 zones)');
  o = stepZone(o.state, "a", 1, 3);
  assert.equal(zoneOf(o.state, "a"), 2);
  o = stepZone(o.state, "a", 1, 3);
  assert.equal(zoneOf(o.state, "a"), 0, "next wraps");
  o = stepZone(o.state, "a", -1, 3);
  assert.equal(zoneOf(o.state, "a"), 2, "previous wraps");
  assert.equal(zoneOf(stepZone(EMPTY, "x", -1, 3).state, "x"), 0, "an unassigned window goes to zone 1, also for previous");
  assert.equal(stepZone(assignZone(EMPTY, "a", 0, 1).state, "a", 1, 1).changed, false, "one zone: nowhere to go");
  o = unassignZone(o.state, "a");
  assert.ok(o.changed);
  assert.equal(zoneOf(o.state, "a"), null);
  assert.deepEqual(o.state.order, []);
  assert.equal(unassignZone(o.state, "a").changed, false);
});

test("layout cycling keeps zone indices that exist and unassigns the rest", () => {
  const z = DEFAULT_SETTINGS.zones;
  let st = assignZone(EMPTY, "a", 0, 2).state;
  st = assignZone(st, "b", 1, 2).state;
  assert.equal(activeZoneLayout(st, z).id, "halves");
  let c = nextZoneLayout(st, z);
  assert.equal(activeZoneLayout(c.state, z).id, "thirds");
  assert.deepEqual(c.dropped, []);
  assert.deepEqual(c.state.assigned, { a: 0, b: 1 });
  c = nextZoneLayout(assignZone(c.state, "c", 2, 3).state, z);
  assert.equal(activeZoneLayout(c.state, z).id, "grid-2x2");
  assert.deepEqual(c.state.assigned, { a: 0, b: 1, c: 2 });
  c = nextZoneLayout(c.state, z);
  assert.equal(activeZoneLayout(c.state, z).id, "main-side");
  assert.deepEqual(c.dropped, ["c"], "zone 3 does not exist in main-side");
  assert.deepEqual(c.state.assigned, { a: 0, b: 1 });
  assert.deepEqual(c.state.order, ["a", "b"]);
  c = nextZoneLayout(c.state, z);
  assert.equal(activeZoneLayout(c.state, z).id, "halves", "wraps");
  const one = nextZoneLayout(EMPTY, { layout: "halves", layouts: [layoutOf("halves")] });
  assert.equal(one.changed, false);
  assert.equal(pruneZones(st, 1).dropped.join(), "b");
});

test("activeZoneLayout: the command's choice, else the configured id, else the first", () => {
  const z = DEFAULT_SETTINGS.zones;
  assert.equal(activeZoneLayout(null, z).id, "halves");
  assert.equal(activeZoneLayout({ ...EMPTY, layout: "thirds" }, z).id, "thirds");
  assert.equal(activeZoneLayout({ ...EMPTY, layout: "gone" }, { ...z, layout: "main-side" }).id, "main-side");
  assert.equal(activeZoneLayout(null, { ...z, layout: "gone" }).id, "halves");
});

test("layout hooks: remove and rebuild drop assignments of windows that left; swap exchanges zones", () => {
  let st = assignZone(EMPTY, "a", 0, 2).state;
  st = assignZone(st, "b", 1, 2).state;
  assert.deepEqual(zones.remove(st, "a").assigned, { b: 1 });
  assert.deepEqual(zones.rebuild(st, ["b", "c"], input(["b", "c"])).assigned, { b: 1 });
  assert.deepEqual(zones.swap!(st, "a", "b").assigned, { a: 1, b: 0 });
  assert.deepEqual(zones.swap!(st, "a", "c").assigned, { c: 0, b: 1 });
  assert.equal(zones.command(st, { kind: "ratio", delta: 0.1 }, input([])).changed, false);
});

// ------------------------------------------------------------------ configuration

function compile(doc: unknown) {
  return compileConfig({ configJson: JSON.stringify({ schemaVersion: 1, ...(doc as object) }) }, 1);
}
function ok(doc: unknown): ConfigSnapshot {
  const r = compile(doc);
  assert.ok(r.ok, r.ok ? "" : r.errors.map(formatError).join("\n"));
  return r.snapshot;
}
function errs(doc: unknown): string[] {
  const r = compile(doc);
  assert.ok(!r.ok, "expected the configuration to be rejected");
  return r.errors.map(formatError);
}

test("config: built-in zone layouts by default; zoneLayouts replace a built-in id and append others; zones.layout per context", () => {
  assert.deepEqual(DEFAULT_SETTINGS.zones.layouts.map((l) => l.id), ["halves", "thirds", "grid-2x2", "main-side"]);
  assert.deepEqual(layoutOf("main-side").zones.map((z) => z.width), [0.6, 0.4]);
  const s = ok({
    zoneLayouts: [
      { id: "thirds", zones: [{ x: 0, y: 0, width: 0.3333, height: 1 }, { x: 0.3333, y: 0, width: 0.3334, height: 1 },
        { x: 0.6667, y: 0, width: 0.3333, height: 1 }] },
      { id: "wide-centre", zones: [{ x: 0.2, y: 0, width: 0.6, height: 1 }] },
    ],
    defaults: { layout: "zones", zones: { layout: "thirds" } },
    overrides: [{ id: "o", match: { desktopId: "d2" }, set: { zones: { layout: "wide-centre" } } }],
  });
  assert.equal(s.defaults.layout, "zones");
  assert.deepEqual(s.defaults.zones.layouts.map((l) => l.id), ["halves", "thirds", "grid-2x2", "main-side", "wide-centre"]);
  assert.equal(s.defaults.zones.layouts[1].zones[1].width, 0.3334, "the configured thirds replaced the built-in");
  assert.equal(s.defaults.zones.layout, "thirds");
  const ctx = resolveContext(s, { outputName: "O", desktopId: "d2", desktopName: "", activityId: "a" }).settings;
  assert.equal(ctx.zones.layout, "wide-centre");
  assert.equal(ctx.zones.layouts.length, 5, "overrides select; the list is shared");
  assert.ok(Object.isFrozen(ctx.zones.layouts[4].zones[0]));
  assert.equal(compileConfig({ layout: "zones" }, 1).ok, true, "the flat layout key accepts zones");
});

test("config: zone layout validation limits and actionable messages; invalid input is rejected whole", () => {
  const zone = { x: 0, y: 0, width: 0.5, height: 1 };
  const many = (n: number) => Array.from({ length: n }, (_v, i) => ({ id: `l${i}`, zones: [zone] }));
  assert.ok(compile({ zoneLayouts: many(16) }).ok, "16 layouts are allowed");
  assert.deepEqual(errs({ zoneLayouts: many(17) }), ["zoneLayouts: at most 16 zone layouts allowed (got 17)"]);
  assert.ok(compile({ zoneLayouts: [{ id: "x", zones: Array(32).fill(zone) }] }).ok, "32 zones are allowed");
  assert.deepEqual(errs({ zoneLayouts: [{ id: "x", zones: Array(33).fill(zone) }] }), ["zoneLayouts[0].zones: must hold 1..32 zones (got 33)"]);
  assert.deepEqual(errs({ zoneLayouts: [{ id: "x", zones: [] }] }), ["zoneLayouts[0].zones: must hold 1..32 zones (got 0)"]);
  assert.deepEqual(errs({ zoneLayouts: [{ id: "x", zones: [zone] }, { id: "x", zones: [zone] }] }),
    ['zoneLayouts[1].id: duplicate id "x" (also at zoneLayouts[0])']);
  assert.deepEqual(errs({ zoneLayouts: [{ id: "", zones: [zone] }] }), ["zoneLayouts[0].id: must not be empty"]);
  assert.deepEqual(errs({ zoneLayouts: [{ zones: [zone] }] }), ["zoneLayouts[0].id: required"]);
  assert.deepEqual(errs({ zoneLayouts: [{ id: "x", zones: [{ x: 0.6, y: 0, width: 0.5, height: 1 }] }] }),
    ["zoneLayouts[0].zones[0]: x + width is 1.1; the zone must end at the right edge (1) or before it"]);
  assert.deepEqual(errs({ zoneLayouts: [{ id: "x", zones: [{ x: 0, y: 0.5, width: 1, height: 0.75 }] }] }),
    ["zoneLayouts[0].zones[0]: y + height is 1.25; the zone must end at the bottom edge (1) or before it"]);
  assert.deepEqual(errs({ zoneLayouts: [{ id: "x", zones: [{ x: 0, y: 0, width: 0.01, height: 1 }] }] }),
    ["zoneLayouts[0].zones[0].width: must be at least 0.02 and at most 1 (a fraction of the usable width)"]);
  assert.deepEqual(errs({ zoneLayouts: [{ id: "x", zones: [{ x: -0.1, y: 0, width: 0.5, height: 1 }] }] }),
    ["zoneLayouts[0].zones[0].x: must be between 0 and 1 (a fraction of the usable area)"]);
  const nonFinite = errs({ zoneLayouts: [{ id: "x", zones: [{ x: 0, y: 0, width: "0.5", height: 1 }] }] });
  assert.deepEqual(nonFinite, ["zoneLayouts[0].zones[0].width: must be a finite number"]);
  assert.deepEqual(errs({ zoneLayouts: [{ id: "x", zones: [{ x: 0, y: 0, width: 0.5 }] }] }),
    ["zoneLayouts[0].zones[0].height: required (a fraction of the usable area, 0..1)"]);
  assert.deepEqual(errs({ zoneLayouts: [{ id: "x", zones: [{ ...zone, colour: 1 }] }] }), ["zoneLayouts[0].zones[0].colour: unknown key"]);
  assert.deepEqual(errs({ defaults: { zones: { layout: "nope" } } }),
    ['defaults.zones.layout: unknown zone layout "nope" (known: halves, thirds, grid-2x2, main-side; add it to zoneLayouts)']);
  assert.deepEqual(errs({ overrides: [{ id: "o", match: { desktopId: "d" }, set: { zones: { layout: "nope" } } }] }),
    ['overrides[0].set.zones.layout: unknown zone layout "nope" (known: halves, thirds, grid-2x2, main-side; add it to zoneLayouts)']);
  // 1e-6 grid: a zone ending at 0.3333 + 0.6667 ends exactly at the edge.
  assert.ok(compile({ zoneLayouts: [{ id: "x", zones: [{ x: 0.3333, y: 0, width: 0.6667, height: 1 }] }] }).ok);
});

test("config: rule action zone validates 1..32 and resolves with its rule as the reason", () => {
  const s = ok({ rules: [{ id: "term-right", match: { appId: "org.kde.konsole" }, actions: { zone: 2 } }] });
  const meta = { appId: "org.kde.konsole", resourceName: "", title: "", role: "", kind: "normal" as const, transient: false,
    transientFor: null, modal: false, special: false, managed: true, resizeable: true, moveable: true, skipTaskbar: false, pid: 1, own: false };
  const r = resolveWindow(s, meta, null);
  assert.equal(r.actions.zone, 2);
  assert.equal(r.reasons.zone, "rule term-right");
  assert.deepEqual(errs({ rules: [{ id: "z", match: { appId: "a" }, actions: { zone: 0 } }] }), ["rules[0].actions.zone: must be an integer in 1..32"]);
  assert.deepEqual(errs({ rules: [{ id: "z", match: { appId: "a" }, actions: { zone: 1.5 } }] }), ["rules[0].actions.zone: must be an integer in 1..32"]);
  assert.deepEqual(errs({ rules: [{ id: "z", match: { appId: "a" }, actions: { zone: 33 } }] }), ["rules[0].actions.zone: must be an integer in 1..32"]);
});
