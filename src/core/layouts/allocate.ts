// Minimum-aware one-dimensional allocation with shared cuts.

/**
 * Split [start, start+length) into intervals proportional to `weights`, separated
 * by `gap`, such that interval i is at least `mins[i]` long. Items that would fall
 * below their minimum are pinned at the minimum and the remainder is redistributed
 * (at most n passes). Every interval is at least 1 px. The span's own ends are kept
 * exact and inner cuts are shared, so the intervals cover the span exactly. Returns
 * null when sum(mins) + gaps exceeds the span; any other span yields a layout, also
 * when the span or the minima are fractional (fractional scaling: 2560 px at 150 %
 * is a 1706.667 px logical work area).
 */
export function allocate(start: number, length: number, weights: readonly number[], minsIn: readonly number[],
  gap: number): Array<[number, number]> | null {
  const n = weights.length;
  // Every slot is at least 1 px: a zero-sized frame is never a valid placement.
  const mins = minsIn.map((m) => Math.max(1, m));
  if (n === 0) return [];
  const usable = length - gap * (n - 1);
  let minSum = 0;
  for (const m of mins) minSum += Math.max(0, m);
  if (usable < minSum - 1e-9 || usable <= 0) return null;

  const size = new Array<number>(n).fill(0);
  const pinned = new Array<boolean>(n).fill(false);
  for (let pass = 0; pass <= n; ++pass) {
    let free = usable;
    let wsum = 0;
    for (let i = 0; i < n; ++i) {
      if (pinned[i]) free -= size[i];
      else wsum += safeWeight(weights[i]);
    }
    let violated = false;
    for (let i = 0; i < n; ++i) {
      if (pinned[i]) continue;
      size[i] = wsum > 0 ? free * safeWeight(weights[i]) / wsum : 0;
    }
    for (let i = 0; i < n; ++i) {
      if (!pinned[i] && size[i] < mins[i] - 1e-9) {
        pinned[i] = true;
        size[i] = Math.max(0, mins[i]);
        violated = true;
      }
    }
    if (!violated) break;
  }

  // Cumulative rounding: each inner cut is rounded once to a whole pixel, then clamped
  // between the minimum of its own interval and the room every later interval needs
  // (`tail`), so rounding can never starve the last interval on a fractional span.
  // When no whole pixel lies in that range (under a pixel of slack), the cut stays at
  // its clamped fractional position: feasibility is the same as the check above.
  const end = start + length;
  const tail = new Array<number>(n).fill(0);
  for (let i = n - 2; i >= 0; --i) tail[i] = tail[i + 1] + gap + mins[i + 1];
  const out: Array<[number, number]> = [];
  let acc = 0;
  let begin = start;
  for (let i = 0; i < n; ++i) {
    acc += size[i];
    let cut = end;
    if (i < n - 1) {
      const want = start + acc + gap * i;
      const lo = begin + mins[i];
      const hi = end - tail[i];
      const ilo = Math.ceil(lo), ihi = Math.floor(hi);
      cut = ilo <= ihi ? Math.min(ihi, Math.max(ilo, Math.round(want))) : Math.min(hi, Math.max(lo, want));
    }
    out.push([begin, cut]);
    begin = cut + gap;
  }
  return out;
}

function safeWeight(w: number): number {
  return Number.isFinite(w) && w > 0 ? w : 1;
}
