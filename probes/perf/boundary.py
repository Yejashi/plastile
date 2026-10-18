#!/usr/bin/env python3
"""P05 n = 32 feasibility boundary (the HANDOFF §6 P05 question), nested KWin only.

Is the n = 32 burst overlap an infeasible workload (overflow float-new, BEHAVIOR §11) or an
engine defect? The fixture's minimum frame height is measured from KWin (minSize plus the
frame/client margin), then the same 32-window burst runs on outputs exactly as tall as the
stack column needs (feasible: every window must tile) and 1 px shorter (infeasible: exactly
one window, the newest, must float, untouched at KWin's placement). Geometry is judged by the
harness oracle; the floated window's reason comes from Plastile's explain view.

Usage: python3 probes/perf/boundary.py [--n 32] [--out DIR]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tests/integration"))
sys.path.insert(0, str(HERE))
from harness import Session, explain, tiling_errors  # noqa: E402
from workloads import GAP, measure_env, stack_feasibility  # noqa: E402
import perfcommon  # noqa: E402


def burst(out: Path, n: int, height: int) -> dict:
    with Session(out, width=1920, height=height, extra_env=measure_env(), qml=HERE / "main.qml") as s:
        s.load()
        s.settle()
        area = s.area()
        for i in range(1, n + 1):
            s.spawn(i, wait=False)
        s.wait_for(lambda: len(s.frames_list()) == n, 60, f"{n} windows")
        c = s.settle(timeout=20)
        frames = s.frames_list()
        feas = stack_feasibility(s, n, area)
        floated = []
        if c["counters"]["overflow"]:
            for f in frames:
                ex = explain(s, f["caption"])
                if str(ex.get("exception") or "").startswith("overflow"):
                    floated.append({"caption": f["caption"], "mode": ex.get("mode"), "exception": ex["exception"].split(": ", 2)[-1],
                                    "frame": f["frame"]})
        mapped = {}
        for i, fx in s.fixtures.items():
            for ln in fx.log.read_text(errors="replace").splitlines():
                if '"ev":"mapped"' in ln:
                    mapped[f"plastile-fixture {i}"] = json.loads(ln)["t_ns"]
                    break
        newest = max(mapped, key=mapped.get) if len(mapped) == n else None
        # The floated window's own configures: Plastile must not have resized it.
        configured = {}
        for fl in floated:
            ident = int(fl["caption"].rsplit(" ", 1)[1])
            sizes = [json.loads(ln) for ln in s.fixtures[ident].log.read_text().splitlines() if '"ev":"configure"' in ln]
            configured[fl["caption"]] = [(e["width"], e["height"]) for e in sizes]
        errs = tiling_errors([f for f in frames if f["caption"] not in {x["caption"] for x in floated}], area, GAP)
        return {"height": height, "area": area, "feasibility": feas, "counters": {k: v for k, v in c["counters"].items() if v},
                "overflow": c["counters"]["overflow"], "floated": floated, "newestMapped": newest,
                "floatedConfigureSizes": configured, "tilingErrorsAmongTiled": errs,
                "tilingErrorsAll": tiling_errors(frames, area, GAP)[:5]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=32)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    out = args.out or ROOT / "artifacts/perf/boundary" / time.strftime("%Y%m%dT%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    unit = {"probe": "P05-boundary", **perfcommon.git_meta(), "versions": perfcommon.versions(),
            "machineStart": perfcommon.machine_state(), "n": args.n,
            "layer": "nested KWin virtual backend (not physical)"}
    with Session(out / "measure", width=1920, height=8000, extra_env=measure_env(), qml=HERE / "main.qml") as s:
        s.spawn(1)
        need = stack_feasibility(s, args.n, s.area())
    unit["measured"] = need
    feasible = burst(out / "feasible", args.n, need["requiredHeight"])
    infeasible = burst(out / "infeasible", args.n, need["requiredHeight"] - 1)
    unit["feasible"], unit["infeasible"] = feasible, infeasible
    checks = {
        "feasible: all tiled, no overflow, no overlap (oracle)": feasible["overflow"] == 0 and not feasible["tilingErrorsAll"],
        "infeasible by 1 px: exactly one window floated by overflow": infeasible["overflow"] == 1 and len(infeasible["floated"]) == 1,
        "infeasible: the floated window is the newest mapped (float-new)":
            len(infeasible["floated"]) == 1 and infeasible["floated"][0]["caption"] == infeasible["newestMapped"],
        "infeasible: the other windows tile without overlap (oracle)": not infeasible["tilingErrorsAmongTiled"],
    }
    unit["checks"] = checks
    unit["pass"] = all(checks.values())
    unit["machineEnd"] = perfcommon.machine_state()
    perfcommon.write_json(out / "unit.json", unit)
    for k, v in checks.items():
        print(("  ok   " if v else "  FAIL ") + k)
    print(json.dumps({"measured": need, "infeasibleFloated": infeasible["floated"]})[:800])
    return 0 if unit["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
