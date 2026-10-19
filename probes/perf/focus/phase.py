#!/usr/bin/env python3
"""Input -> configure against the tap's phase in the refresh cycle (a physical P6 latency run).

For every measured sample of tools/physical's latency kit (samples.jsonl), the phase of the
key-down within the output's refresh cycle: the vblank grid is the latest wp_presentation
timestamp any fixture of the run received before the tap (within 1 s), extended by its
refresh_ns. Prints, per workload, the median inputToConfigure (configureNs) in eight equal phase
bins. A step between bins means the configure sometimes waits for work aligned to the frame (for
example a compositor repaint running before KWin's 0 ms configure timer); flat bins mean it does
not depend on the phase. Reads the raw run directory only; nothing is written unless --json.

    python3 probes/perf/focus/phase.py artifacts/physical/<stamp>/latency-144hz [--bins 8] [--json OUT]
"""
from __future__ import annotations

import argparse
import bisect
import json
import statistics
import sys
from pathlib import Path


def presentations(run: Path) -> list[tuple[int, int]]:
    out = []
    for f in sorted(run.glob("blocks/*/fixture-*.jsonl")):
        for line in f.read_text().splitlines():
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("ev") == "presented" and e.get("refresh_ns"):
                out.append((e["present_ns"], e["refresh_ns"]))
    return sorted(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run", type=Path)
    ap.add_argument("--bins", type=int, default=8)
    ap.add_argument("--json", type=Path, default=None)
    args = ap.parse_args(argv)
    pres = presentations(args.run)
    times = [p[0] for p in pres]
    by: dict[str, list[list[float]]] = {}
    for line in (args.run / "samples.jsonl").read_text().splitlines():
        s = json.loads(line)
        if s.get("warmup") or not s.get("success") or s.get("configureNs") is None:
            continue
        t = s["inputNs"]
        i = bisect.bisect_right(times, t) - 1
        if i < 0 or t - pres[i][0] > 1_000_000_000:
            continue
        p0, refresh = pres[i]
        k = min(args.bins - 1, int(((t - p0) % refresh) / refresh * args.bins))
        by.setdefault(s["workload"], [[] for _ in range(args.bins)])[k].append(s["configureNs"] / 1e6)
    result = {}
    for w, bins in sorted(by.items()):
        result[w] = [{"n": len(b), "medianMs": round(statistics.median(b), 3) if b else None} for b in bins]
        print(f"{w:14s} " + " ".join(f"{x['medianMs']:6.2f}" if x["medianMs"] is not None else "     -" for x in result[w]))
    if args.json:
        args.json.write_text(json.dumps(result, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
