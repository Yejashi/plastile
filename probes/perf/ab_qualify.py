#!/usr/bin/env python3
"""Before/after G2 P03 qualification of bundles from different commits (G2 report §16).

Runs probes/perf/qualify.py, the G2 protocol unchanged: n windows, 3 inactive desktops,
ratio/swap/master/focus/noop in seeded shuffled blocks of 100, 15-30 ms pauses, declared
warm-up, one fresh nested KWin per unit. Each unit uses a measurement root built by
probes/perf/ab_bundles.py.prepare for one variant: this tree's root, harness and fixture,
with that commit's bundle. Units run one at a time, in rounds; each round runs every variant once
in a seeded shuffled order. Run r of every variant uses qualify.py's seed for run r, so the
variants get the same command sequence.

Summary per variant and workload: the solve span (instrumented) or the outer span, pooled
p50/p95/p99 (p99 only from >= 5000 samples), the share of solves above 0.5 ms (the slow mode of
G2 §6), and run-bootstrap 95 % intervals. Every sample is kept; warm-up is never pooled.

Nested KWin virtual backend only; nothing here is physical.

Usage: python3 probes/perf/ab_qualify.py --variants A,B [--runs 5] [--mode instrumented] [--n 32]
           [--diag gcstats] [--seed 20261018] [--out DIR]
       python3 probes/perf/ab_qualify.py --summarize DIR
"""
from __future__ import annotations

import argparse
import json
import math
import random
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import ab_bundles  # noqa: E402
import perfcommon as common  # noqa: E402

SLOW_MS = 0.5
WORKLOADS = ("ratio", "swap", "master", "focus", "noop")


def q(xs: list[float], p: float) -> float | None:
    s = sorted(xs)
    return s[max(1, math.ceil(p * len(s))) - 1] if s else None


def boot(runs: list[list[float]], fn, b: int = 2000, seed: int = 1) -> list[float] | None:
    if len(runs) < 2:
        return None
    rng = random.Random(seed)
    vals = sorted(fn([x for r in (rng.choice(runs) for _ in runs) for x in r]) for _ in range(b))
    return [round(vals[int(0.025 * b)], 4), round(vals[int(0.975 * b) - 1], 4)]


def cell(runs: list[list[float]]) -> dict:
    pooled = [x for r in runs for x in r]
    if not pooled:
        return {}
    out = {"n": len(pooled), "runs": len(runs), "p50": q(pooled, 0.5), "p95": q(pooled, 0.95), "max": max(pooled),
           "slowShare": sum(1 for x in pooled if x > SLOW_MS) / len(pooled),
           "runP50": [round(q(r, 0.5), 4) for r in runs], "runSlowShare": [round(sum(1 for x in r if x > SLOW_MS) / len(r), 4) for r in runs],
           "p50CI95": boot(runs, lambda xs: q(xs, 0.5)), "p95CI95": boot(runs, lambda xs: q(xs, 0.95)),
           "slowShareCI95": boot(runs, lambda xs: sum(1 for x in xs if x > SLOW_MS) / len(xs))}
    if len(pooled) >= 5000:
        out["p99"] = q(pooled, 0.99)
        out["p99CI95"] = boot(runs, lambda xs: q(xs, 0.99))
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in out.items()}


def summarize(d: Path) -> dict:
    meta = json.loads((d / "campaign.json").read_text())
    out = {"variants": {}}
    for v in meta["variants"]:
        units = [json.loads((u / "unit.json").read_text()) | {"dir": u.name} for u in sorted(d.glob(f"u*-{v['name']}"))
                 if (u / "unit.json").exists()]
        rows = {u["dir"]: [json.loads(ln) for ln in (d / u["dir"] / "samples.jsonl").read_text().splitlines()] for u in units}
        c = {"units": len(units), "pass": [u["pass"] for u in units], "bundleSha256": list({u["root"]["bundleSha256"] for u in units}),
             "implementationDirty": [u["implementationDirty"] for u in units],
             "corrections": [u["corrections"]["corrections"] for u in units], "failures": [u["failures"] for u in units]}
        for wl in WORKLOADS:
            meas = {k: [r for r in rs if not r["warmup"] and r["workload"] == f"P03-{wl}"] for k, rs in rows.items()}
            solve = [[r["solveNs"] / 1e6 for r in rs if r["solveNs"] is not None] for rs in meas.values()]
            outer = [[r["outerNs"] / 1e6 for r in rs if r["outerNs"] is not None] for rs in meas.values()]
            c[wl] = {"solve": cell([r for r in solve if r]), "outer": cell([r for r in outer if r])}
        if meta.get("diag") == "gcstats":
            c["gc"] = [gc_summary(d / u["dir"]) for u in units]
        out["variants"][v["spec"]] = c
    return out


def gc_summary(ud: Path) -> dict:
    """Cycle starts per command interval and the slow solves (gcstats units).

    The allocatorStats header is printed when a cycle starts, at the triggering allocation; a
    logged cycle outlasts QV4's 5 ms incremental limit, so its end line comes turns later and is
    not used. g2_followup.gc_attrib reports the same with the freed bytes per command.
    """
    import re
    log = (ud / "diag.log").read_text().splitlines() if (ud / "diag.log").exists() else []
    perf = re.compile(r"plastile perf (\{.*\})$")
    cmds, starts = [], 0
    for ln in log:
        if "========== GC ==========" in ln:
            starts += 1
            continue
        p = perf.search(ln)
        if p:
            t = json.loads(p.group(1)).get("timing")
            cmds.append({"solve": t["solveNs"] / 1e6 if t else None, "starts": starts})
            starts = 0
    solving = [c for c in cmds if c["solve"] is not None]
    slow = [c for c in solving if c["solve"] > SLOW_MS]
    return {"commands": len(cmds), "cycleStarts": sum(c["starts"] for c in cmds),
            "cycleStartsPer1000Commands": round(1000 * sum(c["starts"] for c in cmds) / max(1, len(cmds)), 1),
            "solvingCommands": len(solving), "solvingCommandsWithCycleStart": sum(1 for c in solving if c["starts"]),
            "slowSolves": len(slow), "slowSolvesWithCycleStart": sum(1 for c in slow if c["starts"])}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--variants")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--mode", default="instrumented", choices=("instrumented", "uninstrumented"))
    ap.add_argument("--n", type=int, default=32)
    ap.add_argument("--diag", choices=("gcstats",), default=None)
    ap.add_argument("--seed", type=int, default=20261018, help="qualify.py --seed (G2's campaign seed)")
    ap.add_argument("--order-seed", type=int, default=20261019)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--summarize", type=Path)
    args = ap.parse_args()
    if args.summarize:
        s = summarize(args.summarize)
        (args.summarize / "summary.json").write_text(json.dumps(s, indent=1))
        for v, c in s["variants"].items():
            line = [f"{v}: units {c['units']} pass {c['pass']}"]
            for wl in ("ratio", "swap", "master"):
                x = c[wl]["solve"] or c[wl]["outer"]
                line.append(f"{wl} p50 {x.get('p50')} p95 {x.get('p95')} p99 {x.get('p99')} {x.get('p99CI95')} slow {x.get('slowShare')}")
            print(" | ".join(line))
        return 0
    out = args.out or ROOT / "artifacts/perf/abq" / time.strftime("%Y%m%dT%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    variants = [ab_bundles.prepare(sp, out / "trees") for sp in args.variants.split(",")]
    rng = random.Random(args.order_seed)
    plan = []
    for r in range(args.runs):
        idx = list(range(len(variants)))
        rng.shuffle(idx)
        plan += [(r, i) for i in idx]
    meta = {"probe": "P03-qualify A/B", **common.git_meta(), "versions": common.versions(), "mode": args.mode, "n": args.n,
            "diag": args.diag, "seed": args.seed, "orderSeed": args.order_seed,
            "layer": "nested KWin virtual backend (not physical); kglobalaccel D-Bus command API, not input",
            "variants": [{k: v for k, v in x.items() if k != "tree"} for x in variants],
            "order": [f"r{r}:{variants[i]['spec']}" for r, i in plan]}
    common.write_json(out / "campaign.json", meta)
    for k, (r, i) in enumerate(plan):
        v = variants[i]
        ud = out / f"u{k:03d}-r{r}-{v['name']}"
        cmd = [sys.executable, str(HERE / "qualify.py"), "--n", str(args.n), "--mode", args.mode, "--run", str(r),
               "--seed", str(args.seed), "--qml", str(v["tree"] / "probes/perf/main.qml"), "--out", str(ud)]
        if args.diag:
            cmd += ["--diag", args.diag]
        t = time.monotonic()
        rc = subprocess.run(cmd, stdout=open(out / f"u{k:03d}.log", "w"), stderr=subprocess.STDOUT).returncode
        print(f"[{k + 1}/{len(plan)}] r{r} {v['spec']}: rc {rc} {time.monotonic() - t:.0f}s", flush=True)
    s = summarize(out)
    (out / "summary.json").write_text(json.dumps(s, indent=1))
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
