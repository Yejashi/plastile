#!/usr/bin/env python3
"""G2 measurement campaign (PERFORMANCE §6): every unit of every probe, in one seeded random order.

A unit is one invocation of one probe that starts and stops its own disposable nested KWin
(virtual backend). The plan interleaves tilers (Plastile, no tiler, KWin's own quick tile,
Polonium) and workloads so that drift over the hours of a campaign spreads over all of them
instead of biasing whichever ran last (§6.4). Units run one at a time: two nested sessions at
once would measure each other.

Before each unit the machine state is recorded (load, governor, busiest processes by command
name, other nested KWin sessions). The campaign refuses to start from a tree with changes in
src/, package/, probes/, tests/integration/, fixtures/ or tools/ (implementationDirty), unless
--allow-dirty, which marks every unit as unpublishable.

Usage:
  python3 probes/perf/campaign.py --plan            # print the plan, run nothing
  python3 probes/perf/campaign.py [--seed 20261018] [--only qualify,baseline,...] [--out DIR]
  python3 probes/perf/campaign.py --resume DIR      # skip units already finished in DIR
Writes DIR/{plan.json,manifest.jsonl,units/<unit-id>/...} under artifacts/g2/ (never committed).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import perfcommon  # noqa: E402

PY = sys.executable
COUNTS = (2, 4, 8, 16, 32)
MODES = ("uninstrumented", "instrumented")
RUNS = 5


def plan(seed: int) -> list[dict]:
    units: list[dict] = []

    def add(uid: str, family: str, argv: list[str], timeout: int) -> None:
        units.append({"id": uid, "family": family, "argv": argv, "timeoutS": timeout})

    for n in COUNTS:
        for mode in MODES:
            for r in range(RUNS):
                add(f"qualify-n{n}-{mode}-r{r}", "qualify",
                    [PY, "probes/perf/qualify.py", "--n", str(n), "--mode", mode, "--run", str(r), "--seed", str(seed)], 1200)
    for diag in ("gc", "frames"):
        add(f"qualify-n32-diag-{diag}", "qualify-diag",
            [PY, "probes/perf/qualify.py", "--n", "32", "--mode", "instrumented", "--diag", diag, "--run", "0", "--seed", str(seed)], 1200)
    for r in range(RUNS):
        add(f"baseline-p01-p02-r{r}", "baseline",
            [PY, "probes/timing/baseline.py", "--runs", "1", "--samples", "1000", "--run-index", str(r), "--seed", str(seed % 1000)], 1500)
    for tiler in ("polonium", "plastile"):
        for r in range(RUNS):
            add(f"upstream-{tiler}-r{r}", "upstream",
                [PY, "probes/baseline-upstream/run.py", "--tilers", tiler, "--commands", "1000", "--commands-at", "250=100"], 1200)
    for n in (8, 32):
        for r in range(RUNS):
            add(f"p05-n{n}-r{r}", "p05", [PY, "probes/perf/workloads.py", "--only", "p05", "--counts", str(n)], 600)
    add("p05-boundary-n32", "boundary", [PY, "probes/perf/boundary.py", "--n", "32"], 900)
    add("workloads-p07-p12-p13-teardown", "workloads",
        [PY, "probes/perf/workloads.py", "--only", "p07,p12,p13,teardown", "--seed", str(seed % 1000)], 1200)
    add("churn-p14", "churn", [PY, "probes/perf/churn.py", "p14", "--cycles", "100"], 1800)
    add("churn-p14-control", "churn", [PY, "probes/perf/churn.py", "control", "--cycles", "100"], 1800)
    add("churn-p15", "churn", [PY, "probes/perf/churn.py", "p15", "--minutes", "20", "--seed", "7", "--idle-seconds", "60",
                               "--idle-pairs", "3"], 3600)
    add("churn-p15-control", "churn", [PY, "probes/perf/churn.py", "p15control", "--minutes", "20", "--seed", "7"], 3600)
    random.Random(seed).shuffle(units)
    # Added after the G2 campaign of 320cf72; shuffled on their own so the order above is unchanged.
    extra: list[dict] = []
    for r in range(2):
        for mode in MODES:
            extra.append({"id": f"gcrate-n32-{mode}-r{r}", "family": "gc-rate", "timeoutS": 1200,
                          "argv": [PY, "probes/perf/qualify.py", "--n", "32", "--mode", mode, "--diag", "gc", "--run", str(r + 1),
                                   "--seed", str(seed)]})
    random.Random(seed + 1).shuffle(extra)
    units += extra
    # The P14 RssAnon bisection (rss_bisect.py), in its own order after the rest.
    bis = [{"id": "rss-reload", "family": "rss-bisect", "timeoutS": 1200,
            "argv": [PY, "probes/perf/rss_bisect.py", "reload", "--cycles", "100"]},
           {"id": "rss-reload-oracles15", "family": "rss-bisect", "timeoutS": 1800,
            "argv": [PY, "probes/perf/rss_bisect.py", "reload", "--cycles", "100", "--oracles", "15"]},
           {"id": "rss-cycle", "family": "rss-bisect", "timeoutS": 2400,
            "argv": [PY, "probes/perf/rss_bisect.py", "cycle", "--cycles", "100"]},
           {"id": "rss-long", "family": "rss-bisect", "timeoutS": 1800,
            "argv": [PY, "probes/perf/rss_bisect.py", "long", "--commands", "8000"]}]
    random.Random(seed + 2).shuffle(bis)
    units += bis
    for i, u in enumerate(units):
        u["order"] = i
    return units


def out_flag(u: dict, d: Path) -> list[str]:
    return ["--out", str(d)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=20261018)
    ap.add_argument("--only", default="", help="comma list of families to keep (qualify,qualify-diag,baseline,upstream,p05,boundary,"
                                                "workloads,churn,gc-rate,rss-bisect)")
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--resume", type=Path, default=None)
    ap.add_argument("--allow-dirty", action="store_true")
    args = ap.parse_args()
    units = plan(args.seed)
    if args.only:
        keep = set(args.only.split(","))
        units = [u for u in units if u["family"] in keep]
    if args.plan:
        for u in units:
            print(u["order"], u["id"])
        print(f"{len(units)} units")
        return 0
    meta = perfcommon.git_meta()
    if meta["implementationDirty"] and not args.allow_dirty:
        sys.exit(f"tree has changes in tracked paths ({meta['dirtyPaths']}); commit first or pass --allow-dirty")
    out = args.resume or args.out or ROOT / "artifacts/g2" / time.strftime("%Y%m%dT%H%M%S")
    (out / "units").mkdir(parents=True, exist_ok=True)
    done = set()
    manifest = out / "manifest.jsonl"
    if args.resume and manifest.exists():
        for ln in manifest.read_text().splitlines():
            r = json.loads(ln)
            if r.get("event") == "end":
                done.add(r["id"])
    else:
        perfcommon.write_json(out / "plan.json", {"seed": args.seed, **meta, "environment": perfcommon.environment(),
                                                  "units": [{k: v for k, v in u.items()} for u in units]})
    with open(manifest, "a") as mf:
        for u in units:
            if u["id"] in done:
                continue
            d = out / "units" / u["id"]
            d.mkdir(parents=True, exist_ok=True)
            pre = perfcommon.machine_state()
            mf.write(json.dumps({"event": "start", "id": u["id"], "order": u["order"], "t": time.time(), "machine": pre,
                                 **perfcommon.git_meta()}) + "\n")
            mf.flush()
            print(f"[{time.strftime('%H:%M:%S')}] {u['order']:3d} {u['id']}  load {pre['loadavg']} nested={pre['nestedKwinRunning']}",
                  flush=True)
            t0 = time.monotonic()
            with open(d / "stdout.log", "w") as log:
                # Own process group: on a timeout the unit's nested KWin, bus and fixtures (all started
                # by this campaign) are signalled with it; nothing outside the group is touched.
                proc = subprocess.Popen(u["argv"] + out_flag(u, d), cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                        start_new_session=True)
                try:
                    rc = proc.wait(timeout=u["timeoutS"])
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGTERM)
                    try:
                        proc.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait()
                    rc = "timeout"
            secs = round(time.monotonic() - t0, 1)
            mf.write(json.dumps({"event": "end", "id": u["id"], "rc": rc, "seconds": secs, "t": time.time(),
                                 "machineAfter": perfcommon.machine_state(0.5)}) + "\n")
            mf.flush()
            print(f"           -> rc={rc} in {secs} s", flush=True)
    print(f"campaign finished: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
