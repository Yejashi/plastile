// Value rectangles in logical compositor coordinates, and shared-cut allocation.
//
// KWin geometry is floating point even at scale 1 (M0: 466.666…, 400.00000000000006),
// so comparisons use an explicit tolerance. Layout output is integral: cut positions
// are rounded once and adjacent slots are derived from shared cuts, which preserves
// total coverage for odd sizes.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Edges {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Default comparison tolerance in logical pixels. */
export const TOLERANCE = 0.5;

/**
 * Tolerance for comparing a requested frame with the frame KWin reports for it.
 * xdg client sizes are integers (up to ½ px of rounding), and at any scale other
 * than 1 KWin snaps frame and decoration edges to the device-pixel grid, adding up
 * to one device pixel (1/scale logical px). Measured in nested KWin 6.7.5: at scale
 * 1.75 an accepted frame was 0.571 px (one device pixel) taller than its target.
 */
export function frameTolerance(scale: number): number {
  return Number.isFinite(scale) && scale > 0 && scale !== 1 ? TOLERANCE + 1 / scale : TOLERANCE;
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function rectOf(r: { x: number; y: number; width: number; height: number }): Rect {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export function rectNear(a: Rect | null | undefined, b: Rect | null | undefined, tol = TOLERANCE): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}

export function sizeNear(a: Rect, b: Rect, tol = TOLERANCE): boolean {
  return Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}

export function isFiniteRect(r: Rect): boolean {
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.width) && Number.isFinite(r.height);
}

export function isValidArea(r: Rect | null | undefined): r is Rect {
  return !!r && isFiniteRect(r) && r.width >= 1 && r.height >= 1;
}

export function inset(r: Rect, e: Edges): Rect {
  return rect(r.x + e.left, r.y + e.top, Math.max(0, r.width - e.left - e.right), Math.max(0, r.height - e.top - e.bottom));
}

export function uniformEdges(n: number): Edges {
  return { top: n, right: n, bottom: n, left: n };
}

export function right(r: Rect): number { return r.x + r.width; }
export function bottom(r: Rect): number { return r.y + r.height; }
export function center(r: Rect): { x: number; y: number } { return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }

export function intersects(a: Rect, b: Rect, tol = TOLERANCE): boolean {
  return Math.min(right(a), right(b)) - Math.max(a.x, b.x) > tol &&
    Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) > tol;
}

export function contains(outer: Rect, inner: Rect, tol = TOLERANCE): boolean {
  return inner.x >= outer.x - tol && inner.y >= outer.y - tol &&
    right(inner) <= right(outer) + tol && bottom(inner) <= bottom(outer) + tol;
}

/**
 * Allocate `weights.length` intervals over [start, start + length) separated by `gap`.
 * Cut positions are rounded once; each interval ends exactly `gap` before the next
 * begins, and the last interval ends exactly at start + length. Returns [begin, end) pairs.
 * Weights must be positive and finite; the caller validates.
 */
export function shareCuts(start: number, length: number, weights: readonly number[], gap: number): Array<[number, number]> {
  const n = weights.length;
  const out: Array<[number, number]> = [];
  if (n === 0) return out;
  const usable = Math.max(0, length - gap * (n - 1));
  let total = 0;
  for (const w of weights) total += w;
  let acc = 0;
  let begin = start;
  for (let i = 0; i < n; ++i) {
    acc += weights[i];
    const end = i === n - 1 ? start + length : Math.round(start + usable * (acc / total) + gap * i);
    out.push([begin, Math.max(begin, end)]);
    begin = end + gap;
  }
  return out;
}

/** Position `size` within `slot`: centred, then clamped so it never starts before the slot. */
export function centreIn(slot: Rect, size: Size): Rect {
  const x = slot.x + Math.max(0, Math.round((slot.width - size.width) / 2));
  const y = slot.y + Math.max(0, Math.round((slot.height - size.height) / 2));
  return rect(x, y, size.width, size.height);
}

export function formatRect(r: Rect | null | undefined): string {
  return r ? `${r.x},${r.y} ${r.width}x${r.height}` : "null";
}
