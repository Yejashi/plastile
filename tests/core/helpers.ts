// Test helpers and independent geometry oracles (they check properties, not formulas).

import assert from "node:assert/strict";
import { rect, type Rect } from "../../src/core/geometry.ts";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.ts";
import type { Constraints, ContextSettings, WindowId } from "../../src/core/types.ts";
import type { SolveInput } from "../../src/core/layouts/layout.ts";

export function settings(patch: Partial<ContextSettings> = {}): ContextSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

export function input(ids: WindowId[], opts: {
  area?: Rect; settings?: ContextSettings; constraints?: Map<WindowId, Constraints>; focused?: WindowId | null;
  members?: WindowId[];
} = {}): SolveInput {
  const insertedAt = new Map<WindowId, number>();
  ids.forEach((id, i) => insertedAt.set(id, i));
  return {
    area: opts.area ?? rect(0, 0, 1920, 1080),
    ids,
    members: opts.members ?? ids,
    constraints: opts.constraints ?? new Map(),
    settings: opts.settings ?? settings(),
    focused: opts.focused ?? null,
    insertedAt,
  };
}

export function minC(width: number, height: number): Constraints {
  return { minFrame: { width, height }, maxFrame: { width: Infinity, height: Infinity }, fixed: false };
}

/** Seeded PRNG (mulberry32) for reproducible property tests. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Oracle: every slot inside the area, integral, positive, and no two slots overlap. */
export function assertTiling(slots: Map<WindowId, Rect>, area: Rect) {
  const list = [...slots.entries()];
  for (const [id, r] of list) {
    assert.ok(r.width > 0 && r.height > 0, `${id} non-positive ${JSON.stringify(r)}`);
    for (const v of [r.x, r.y, r.width, r.height]) assert.ok(Number.isInteger(v), `${id} non-integral ${JSON.stringify(r)}`);
    assert.ok(r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height,
      `${id} outside area ${JSON.stringify(r)} not in ${JSON.stringify(area)}`);
  }
  for (let i = 0; i < list.length; ++i)
    for (let j = i + 1; j < list.length; ++j) {
      const [ia, a] = list[i], [ib, b] = list[j];
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(ox <= 0 || oy <= 0, `${ia} overlaps ${ib}`);
    }
}

/**
 * Conservation oracle, independent of any layout's structure: grow every slot by half the
 * gap on each edge that is not on the boundary of `inner`. Tiles plus the gaps between them
 * account for the usable area exactly when the grown rectangles lie in `inner`, never
 * overlap, and their areas sum to the area of `inner` (no hole, no lost or doubled pixel).
 * Asserts the first two and returns the summed area for the caller to compare.
 */
export function coveredArea(slots: Map<WindowId, Rect>, inner: Rect, gap: number, eps = 1e-6): number {
  const near = (a: number, b: number) => Math.abs(a - b) <= eps;
  const right = inner.x + inner.width, bottom = inner.y + inner.height;
  const grown = [...slots.entries()].map(([id, r]) => {
    const x0 = near(r.x, inner.x) ? r.x : r.x - gap / 2;
    const y0 = near(r.y, inner.y) ? r.y : r.y - gap / 2;
    const x1 = near(r.x + r.width, right) ? r.x + r.width : r.x + r.width + gap / 2;
    const y1 = near(r.y + r.height, bottom) ? r.y + r.height : r.y + r.height + gap / 2;
    assert.ok(x0 >= inner.x - eps && y0 >= inner.y - eps && x1 <= right + eps && y1 <= bottom + eps,
      `${id} ${JSON.stringify(r)} with its gaps leaves ${JSON.stringify(inner)}`);
    return [id, x0, y0, x1, y1] as const;
  });
  let s = 0;
  for (let i = 0; i < grown.length; ++i) {
    const [ia, ax0, ay0, ax1, ay1] = grown[i];
    s += (ax1 - ax0) * (ay1 - ay0);
    for (let j = i + 1; j < grown.length; ++j) {
      const [ib, bx0, by0, bx1, by1] = grown[j];
      const ox = Math.min(ax1, bx1) - Math.max(ax0, bx0), oy = Math.min(ay1, by1) - Math.max(ay0, by0);
      assert.ok(ox <= eps || oy <= eps, `${ia} and ${ib} closer than ${gap} px (their gaps overlap)`);
    }
  }
  return s;
}
