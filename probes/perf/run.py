#!/usr/bin/env python3
"""M2/G2 performance workloads (P03) for the production bundle inside nested KWin.

For n in 2/4/8/16/32 windows in one master/stack context: alternating grow/shrink
(ratio), swap-next and focus-next commands, with the measurement-only root
(probes/perf/main.qml) recording CLOCK_MONOTONIC timings inside KWin's QV4:
  dispatchToReturnNs = handler entry -> every frame request issued (t4 - t1)
  solveNs / applyNs  = pure solve / adapter apply for the context
Harness D-Bus send -> handler entry is reported separately (command API, not input).
KWin reports a 150x150 fixture minimum (186 px frame), so tall virtual outputs
(workloads.stack_output_height, gaps included) are used to fit n windows without overflow. Nested virtual backend only: not a physical measurement.

Usage: python3 probes/perf/run.py [--samples 300] [--counts 2,4,8,16,32] [--seed 1]
"""
from __future__ import annotations

import argparse
import json
import random
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tests/integration"))
from harness import Session  # noqa: E402
from workloads import measure_env, stack_output_height  # noqa: E402

PERF = re.compile(r"plastile perf (\{.*\})$")
WORKLOADS = ("ratio", "swap", "focus")


def q(xs):
    s = sorted(xs)
    if not s:
        return None
    p = lambda f: s[min(len(s) - 1, int(f * (len(s) - 1)))]  # noqa: E731
    return {"n": len(s), "p50": p(0.5), "p95": p(0.95), "p99": p(0.99), "max": s[-1], "min": s[0]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=300)
    ap.add_argument("--counts", default="2,4,8,16,32")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = ROOT / "artifacts/perf" / stamp
    rev = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "src", "package", "probes"],
                                capture_output=True, text=True).stdout.strip())
    result = {"implementationCommit": rev, "implementationDirty": dirty, "layer": "nested KWin 6.7.5 virtual backend",
              "clock": "CLOCK_MONOTONIC via measurement module", "samplesPerWorkload": args.samples, "counts": {}}
    rng = random.Random(args.seed)
    for n in [int(x) for x in args.counts.split(",")]:
        height = stack_output_height(n)
        with Session(out / f"n{n}", width=1920, height=height, extra_env=measure_env(),
                     qml=HERE / "main.qml", config={"diagnostics": "info"}) as s:
            for i in range(1, n + 1):
                s.spawn(i, wait=False)
            s.wait_for(lambda: len(s.frames_list()) == n, 15, f"{n} windows")
            s.load()
            s.settle()
            c = s.counters()
            assert c["counters"]["overflow"] == 0, c["counters"]
            s.act("plastile-fixture 1", "workspace.activeWindow = w")
            recs = {w: [] for w in WORKLOADS}
            off = s.kw.mark()
            sends = []
            for wl in WORKLOADS:
                for k in range(args.samples):
                    cmd = {"ratio": "resize.grow" if k % 2 == 0 else "resize.shrink", "swap": "swap.next",
                           "focus": "focus.next"}[wl]
                    sends.append((wl, s.cmd(cmd)))
                    time.sleep(rng.uniform(0.015, 0.03))
                s.settle()
            lines = [json.loads(PERF.search(l).group(1)) for l in s.log_lines(r"plastile perf ", off)]
            for (wl, t_send), rec in zip(sends, lines):
                rec["sendToEntryNs"] = rec["entryNs"] - t_send
                recs[wl].append(rec)
            end = s.counters()
            summary = {}
            for wl, rs in recs.items():
                summary[wl] = {
                    "samples": len(rs),
                    "accepted": sum(1 for r in rs if r["status"] == "accepted"),
                    "dispatchToReturnNs": q([r["dispatchToReturnNs"] for r in rs]),
                    "solveNs": q([r["timing"]["solveNs"] for r in rs if r["timing"]]),
                    "applyNs": q([r["timing"]["applyNs"] for r in rs if r["timing"]]),
                    "writesPerCommand": q([r["timing"]["writes"] for r in rs if r["timing"]]),
                    "solvesPerCommand": sum(1 for r in rs if r["timing"]) / max(1, len(rs)),
                    "dbusSendToEntryNs": q([r["sendToEntryNs"] for r in rs]),
                    "kwinActivateNs": q([r["activateNs"] for r in rs if r.get("activateNs") is not None]),
                }
            result["counts"][str(n)] = {"workloads": summary, "corrections": end["counters"]["corrections"],
                                        "errors": end["counters"]["errors"], "outstandingAtEnd": end["outstanding"]}
            (out / f"n{n}" / "samples.json").write_text(json.dumps(recs))
            print(f"n={n}: " + ", ".join(f"{wl} p50/p99 {v['dispatchToReturnNs']['p50']/1e3:.0f}/{v['dispatchToReturnNs']['p99']/1e3:.0f} us"
                                         f" solve p99 {v['solveNs']['p99']/1e3 if v['solveNs'] else 0:.0f} us"
                                         for wl, v in summary.items()), flush=True)
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text(json.dumps(result, indent=1))
    print(out / "summary.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
