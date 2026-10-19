#!/usr/bin/env python3
"""Activation latency against the frame area that changes active state (probes/perf/focus runs).

For every tap of every block under the given run directories: the configure carrying the
activated state (the newly active fixture) and the configure without it sent in the same burst
(the previously active one), their sizes, and tap -> activation configure. Prints, per run and
condition, the median latency per window pair and a least-squares line latency = a + b * area,
area = sum of both windows' configured sizes in megapixels (client area; the decoration adds a
constant border). Nested measurement only.

    python3 probes/perf/focus/area.py artifacts/perf/focus/campaign/aurorae-tiled [...] [--json OUT]
    python3 probes/perf/focus/area.py artifacts/physical/<stamp>/latency-144hz/blocks --warmup 0
"""
from __future__ import annotations

import argparse
import bisect
import json
import statistics
import sys
from pathlib import Path


def events(block: Path) -> list[tuple[int, str, dict]]:
    out = []
    for f in sorted(block.glob("fixture-*.jsonl")):
        fid = f.stem.split("-", 1)[1]
        for line in f.read_text().splitlines():
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("ev") == "configure":
                out.append((e["t_ns"], fid, e))
    return sorted(out, key=lambda x: x[0])


def taps(block: Path) -> list[int]:
    out = []
    # keytap.jsonl: this probe's blocks; taps.jsonl: a physical-kit block (tools/physical).
    p = block / "keytap.jsonl"
    if not p.exists():
        p = block / "taps.jsonl"
    if not p.exists():
        return out
    for line in p.read_text().splitlines():
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("ev") == "tap" and r.get("phase", "measure") != "warmup":
            out.append(r["t_input_ns"])
    return out


def block_samples(block: Path, warmup: int) -> list[dict]:
    evs = events(block)
    ts = [e[0] for e in evs]
    out = []
    for t0 in taps(block)[warmup:]:
        i = bisect.bisect_right(ts, t0)
        burst = [e for e in evs[i:i + 6] if e[0] - t0 < 60_000_000]
        act = next((e for e in burst if "activated" in (e[2].get("states") or [])), None)
        if act is None:
            continue
        # The deactivation configure goes out on the same event-loop turn (within 1 ms).
        deact = next((e for e in burst if e[1] != act[1] and "activated" not in (e[2].get("states") or [])
                      and abs(e[0] - act[0]) < 1_000_000), None)
        area = act[2]["width"] * act[2]["height"] + (deact[2]["width"] * deact[2]["height"] if deact else 0)
        out.append({"ms": (act[0] - t0) / 1e6, "mpx": area / 1e6,
                    "pair": f"{act[1]}<-{deact[1] if deact else '?'}"})
    return out


def fit(xs: list[float], ys: list[float]) -> dict | None:
    if len(set(round(x, 4) for x in xs)) < 2:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    a = my - b * mx
    ss_res = sum((y - a - b * x) ** 2 for x, y in zip(xs, ys))
    ss_tot = sum((y - my) ** 2 for y in ys)
    return {"interceptMs": round(a, 3), "msPerMegapixel": round(b, 3), "r2": round(1 - ss_res / ss_tot, 3)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", nargs="+", type=Path)
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--json", type=Path, default=None)
    args = ap.parse_args(argv)
    result = {}
    pooled: list[dict] = []
    for run in args.runs:
        by_cond: dict[str, list[dict]] = {}
        for block in sorted(p for p in run.iterdir() if p.is_dir()):
            cond = block.name.split("-", 1)[1]
            by_cond.setdefault(cond, []).extend(block_samples(block, args.warmup))
        res = {}
        for cond, ss in sorted(by_cond.items()):
            # A tap whose deactivation configure was not found has an unknown area: kept in the
            # pair table, left out of the fits.
            known = [s for s in ss if not s["pair"].endswith("?")]
            pooled.extend(known)
            pairs = {}
            for s in ss:
                pairs.setdefault(s["pair"], []).append(s)
            res[cond] = {
                "n": len(ss),
                "fit": fit([s["mpx"] for s in known], [s["ms"] for s in known]),
                "pairs": {k: {"n": len(v), "mpx": round(statistics.median(x["mpx"] for x in v), 3),
                              "medianMs": round(statistics.median(x["ms"] for x in v), 3)}
                          for k, v in sorted(pairs.items())},
            }
            print(f"{run.name} {cond}: n={len(ss)} fit={res[cond]['fit']}")
            for k, v in res[cond]["pairs"].items():
                print(f"    {k:8s} n={v['n']:4d} area={v['mpx']:.3f} Mpx  median={v['medianMs']:.3f} ms")
        result[run.name] = res
    if len(args.runs) > 1:
        result["pooledFit"] = fit([s["mpx"] for s in pooled], [s["ms"] for s in pooled])
        result["pooledFit"]["n"] = len(pooled)
        print(f"pooled over every run and condition: {result['pooledFit']}")
    if args.json:
        args.json.write_text(json.dumps(result, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
