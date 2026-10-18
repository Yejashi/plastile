// Deterministic directional candidate scoring (BEHAVIOR §7).
// Candidates are filtered to the direction's half-plane by facing edges, then
// ranked by orthogonal overlap (more is better), distance between facing edges
// (less is better), then stable order. A center-based half-plane is the fallback
// for irregular arrangements where no candidate is fully beyond the facing edge.

import { bottom, center, right, type Rect } from "./geometry.ts";
import type { WindowId } from "./types.ts";

export type Direction = "left" | "right" | "up" | "down";

const SLOP = 1; // px: tiles separated by gaps still count as "beyond"

interface Scored { id: WindowId; overlap: number; distance: number; order: number }

function overlapLen(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function score(dir: Direction, cur: Rect, c: Rect): { beyond: boolean; centreBeyond: boolean; overlap: number; distance: number } {
  const cc = center(c), mc = center(cur);
  switch (dir) {
    case "left": return { beyond: right(c) <= cur.x + SLOP, centreBeyond: cc.x < mc.x,
      overlap: overlapLen(cur.y, bottom(cur), c.y, bottom(c)), distance: Math.abs(cur.x - right(c)) };
    case "right": return { beyond: c.x >= right(cur) - SLOP, centreBeyond: cc.x > mc.x,
      overlap: overlapLen(cur.y, bottom(cur), c.y, bottom(c)), distance: Math.abs(c.x - right(cur)) };
    case "up": return { beyond: bottom(c) <= cur.y + SLOP, centreBeyond: cc.y < mc.y,
      overlap: overlapLen(cur.x, right(cur), c.x, right(c)), distance: Math.abs(cur.y - bottom(c)) };
    case "down": return { beyond: c.y >= bottom(cur) - SLOP, centreBeyond: cc.y > mc.y,
      overlap: overlapLen(cur.x, right(cur), c.x, right(c)), distance: Math.abs(c.y - bottom(cur)) };
  }
}

/**
 * Pick the neighbour of `from` in direction `dir` among `rects` (iteration order is
 * the stable order). Returns null when nothing lies in that direction.
 */
export function neighbour(from: WindowId, dir: Direction, rects: ReadonlyMap<WindowId, Rect>): WindowId | null {
  const cur = rects.get(from);
  if (!cur) return null;
  const strict: Scored[] = [];
  const loose: Scored[] = [];
  let order = 0;
  for (const [id, r] of rects) {
    const o = order++;
    if (id === from) continue;
    const s = score(dir, cur, r);
    if (s.beyond) strict.push({ id, overlap: s.overlap, distance: s.distance, order: o });
    else if (s.centreBeyond) loose.push({ id, overlap: s.overlap, distance: s.distance, order: o });
  }
  const pool = strict.length ? strict : loose;
  if (!pool.length) return null;
  pool.sort((a, b) => (b.overlap > 0 ? 1 : 0) - (a.overlap > 0 ? 1 : 0) || a.distance - b.distance
    || b.overlap - a.overlap || a.order - b.order);
  return pool[0].id;
}
