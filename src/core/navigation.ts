// Deterministic directional candidate scoring (BEHAVIOR §7).
// Candidates are filtered to the direction's half-plane by facing edges, then
// ranked by orthogonal overlap (more is better), distance between facing edges
// (less is better), then stable order. For irregular arrangements where no
// candidate is fully beyond the facing edge (overlapping or stale rectangles, a
// centred max-size frame), a candidate that reaches past the facing edge with its
// centre on that side is the fallback. A window beside the current one shares the
// facing edge and never qualifies, so at an area edge the result is null: no wrap.

import { bottom, center, right, type Rect } from "./geometry.ts";
import type { WindowId } from "./types.ts";

export type Direction = "left" | "right" | "up" | "down";

const SLOP = 1; // px: tiles separated by gaps still count as "beyond"

interface Scored { id: WindowId; overlap: number; distance: number; order: number }

function overlapLen(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function score(dir: Direction, cur: Rect, c: Rect): { beyond: boolean; partly: boolean; overlap: number; distance: number } {
  const cc = center(c), mc = center(cur);
  switch (dir) {
    case "left": return { beyond: right(c) <= cur.x + SLOP, partly: c.x < cur.x - SLOP && cc.x < mc.x,
      overlap: overlapLen(cur.y, bottom(cur), c.y, bottom(c)), distance: Math.abs(cur.x - right(c)) };
    case "right": return { beyond: c.x >= right(cur) - SLOP, partly: right(c) > right(cur) + SLOP && cc.x > mc.x,
      overlap: overlapLen(cur.y, bottom(cur), c.y, bottom(c)), distance: Math.abs(c.x - right(cur)) };
    case "up": return { beyond: bottom(c) <= cur.y + SLOP, partly: c.y < cur.y - SLOP && cc.y < mc.y,
      overlap: overlapLen(cur.x, right(cur), c.x, right(c)), distance: Math.abs(cur.y - bottom(c)) };
    case "down": return { beyond: c.y >= bottom(cur) - SLOP, partly: bottom(c) > bottom(cur) + SLOP && cc.y > mc.y,
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
  rects.forEach((r, id) => {
    const o = order++;
    if (id === from) return;
    const s = score(dir, cur, r);
    if (s.beyond) strict.push({ id, overlap: s.overlap, distance: s.distance, order: o });
    else if (s.partly) loose.push({ id, overlap: s.overlap, distance: s.distance, order: o });
  });
  const pool = strict.length ? strict : loose;
  if (!pool.length) return null;
  pool.sort((a, b) => (b.overlap > 0 ? 1 : 0) - (a.overlap > 0 ? 1 : 0) || a.distance - b.distance
    || b.overlap - a.overlap || a.order - b.order);
  return pool[0].id;
}

/**
 * Directional focus with wrap (focusWrap, BEHAVIOR §7): when nothing lies in `dir`, continue
 * from the opposite end of the same row or column. The current rectangle is placed just past
 * the far side of the context's bounding box and ranked with `neighbour`, so the result is
 * the member at the opposite end that overlaps it on the orthogonal axis. A member with no
 * orthogonal overlap is never a wrap target (no diagonal jump), so a full-height master has
 * nothing to wrap to upwards. Only the rectangles given (one context) take part: wrap never
 * leaves the output.
 */
export function wrapNeighbour(from: WindowId, dir: Direction, rects: ReadonlyMap<WindowId, Rect>): WindowId | null {
  const direct = neighbour(from, dir, rects);
  if (direct !== null) return direct;
  const cur = rects.get(from);
  if (!cur || rects.size < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  rects.forEach((r) => {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, right(r)); y1 = Math.max(y1, bottom(r));
  });
  const ghost: Rect =
    dir === "right" ? { ...cur, x: x0 - cur.width }
    : dir === "left" ? { ...cur, x: x1 }
    : dir === "down" ? { ...cur, y: y0 - cur.height }
    : { ...cur, y: y1 };
  const shifted = new Map(rects);
  shifted.set(from, ghost);
  const id = neighbour(from, dir, shifted);
  if (id === null) return null;
  const c = rects.get(id)!;
  const horizontal = dir === "left" || dir === "right";
  const overlap = horizontal ? overlapLen(cur.y, bottom(cur), c.y, bottom(c)) : overlapLen(cur.x, right(cur), c.x, right(c));
  return overlap > 0 ? id : null;
}

/** An output for cross-output navigation: identity and logical geometry. */
export interface OutputPlace {
  readonly id: string;
  readonly geometry: Rect;
}

/**
 * Outputs in topology order (cross-output commands, BEHAVIOR §7): left edge, then top edge,
 * then id. Enumeration order is not identity and can change on replug, so the order is
 * derived from geometry alone; a vertical stack orders top to bottom.
 */
export function outputOrder<T extends OutputPlace>(outs: readonly T[]): T[] {
  return outs.slice().sort((a, b) => a.geometry.x - b.geometry.x || a.geometry.y - b.geometry.y
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The output after (`step` 1) or before (-1) `from` in topology order, cyclic; null with fewer than two. */
export function adjacentOutput<T extends OutputPlace>(outs: readonly T[], from: string | null, step: 1 | -1): T | null {
  const order = outputOrder(outs);
  if (order.length < 2) return null;
  const i = order.findIndex((o) => o.id === from);
  if (i < 0) return step === 1 ? order[0] : order[order.length - 1];
  return order[(i + step + order.length) % order.length];
}
