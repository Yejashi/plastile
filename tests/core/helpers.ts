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

/** Oracle: tiled area + gaps exactly cover the inner area when slots form a full tiling. */
export function coveredArea(slots: Map<WindowId, Rect>): number {
  let s = 0;
  for (const r of slots.values()) s += r.width * r.height;
  return s;
}
