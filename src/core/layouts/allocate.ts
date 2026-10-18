// Minimum-aware one-dimensional allocation with shared cuts.

/**
 * Split [start, start+length) into intervals proportional to `weights`, separated
 * by `gap`, such that interval i is at least `mins[i]` long. Items that would fall
 * below their minimum are pinned at the minimum and the remainder is redistributed
 * (at most n passes). Every interval is at least 1 px. Cut positions are rounded cumulatively so the intervals cover
 * the span exactly. Returns null when sum(mins) + gaps exceeds the span.
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

  // Cumulative rounding: each cut is rounded once; minima stay satisfied because
  // pinned sizes are integers in practice (frame minima) and rounding moves a cut
  // by at most 0.5 px, so ceil the minima when rounding would violate them.
  const out: Array<[number, number]> = [];
  let acc = 0;
  let begin = start;
  for (let i = 0; i < n; ++i) {
    acc += size[i];
    let end = i === n - 1 ? start + length : Math.round(start + acc + gap * i);
    if (i < n - 1 && end - begin < mins[i]) end = begin + Math.ceil(mins[i]);
    out.push([begin, end]);
    begin = end + gap;
  }
  if (out[n - 1][1] - out[n - 1][0] < mins[n - 1] - 1e-9) return null;
  return out;
}

function safeWeight(w: number): number {
  return Number.isFinite(w) && w > 0 ? w : 1;
}
