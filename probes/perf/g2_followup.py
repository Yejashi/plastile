#!/usr/bin/env python3
"""Redacted evidence for the G2 follow-up (G2 report §16) from the local campaign directories.

Reads the raw units of probes/perf/ab_bundles.py (bisect A/B), probes/perf/ab_qualify.py (G2
protocol before/after, instrumented, uninstrumented and gcstats) and probes/perf/qv4solve/run.py,
and writes:

  docs/status/evidence/g2-followup.json            summaries, intervals, unit order, machine state
  docs/status/evidence/g2-followup-samples.csv.xz  every measured sample (no titles, no paths)

Statistics: nearest-rank quantiles; p99 only from >= 5000 samples; 95 % intervals from a
bootstrap over whole runs (units), for a difference resampling the runs of both variants. Every
sample is kept. Units that started while another of this session's processes was busy are
listed and a sensitivity analysis without them is reported next to (never instead of) the result.

Nested KWin virtual backend only; nothing here is physical.

Usage: python3 probes/perf/g2_followup.py --coarse DIR --fine DIR --instr DIR [--uninstr DIR]
           [--gcstats DIR ...] [--qv4solve DIR ...] [--out docs/status/evidence]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import lzma
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import perfcommon as common  # noqa: E402

B = 4000
SLOW_MS = 0.5
RNG = np.random.default_rng(20261019)


def nr(xs, p: float) -> float | None:
    """Nearest rank (the smallest value with at least p of the samples at or below it)."""
    a = np.asarray(xs, dtype=float)
    return None if a.size == 0 else float(np.quantile(a, p, method="inverted_cdf"))


def r4(x):
    return None if x is None else round(float(x), 4)


def boot_runs(runs: list[np.ndarray], stat) -> np.ndarray:
    k = len(runs)
    out = np.empty(B)
    for i in range(B):
        out[i] = stat(np.concatenate([runs[j] for j in RNG.integers(0, k, k)]))
    return out


def ci(vals: np.ndarray) -> list[float]:
    return [r4(np.quantile(vals, 0.025)), r4(np.quantile(vals, 0.975))]


def med(a: np.ndarray) -> float:
    return float(np.quantile(a, 0.5, method="inverted_cdf"))


def slow(a: np.ndarray) -> float:
    return float(np.mean(a > SLOW_MS))


def p99(a: np.ndarray) -> float:
    return float(np.quantile(a, 0.99, method="inverted_cdf"))


def p95(a: np.ndarray) -> float:
    return float(np.quantile(a, 0.95, method="inverted_cdf"))


def cell(runs: list[np.ndarray], ref: list[np.ndarray] | None = None, tails: bool = False) -> dict:
    runs = [r for r in runs if r.size]
    if not runs:
        return {}
    pooled = np.concatenate(runs)
    c = {"n": int(pooled.size), "runs": len(runs), "p50": r4(med(pooled)), "p95": r4(p95(pooled)), "max": r4(pooled.max()),
         "runP50": [r4(med(r)) for r in runs]}
    if len(runs) > 1:
        c["p50CI95"] = ci(boot_runs(runs, med))
    if tails:
        c["slowShare"] = r4(slow(pooled))
        c["runSlowShare"] = [r4(slow(r)) for r in runs]
        if len(runs) > 1:
            c["slowShareCI95"] = ci(boot_runs(runs, slow))
            c["p95CI95"] = ci(boot_runs(runs, p95))
        if pooled.size >= 5000:
            c["p99"] = r4(p99(pooled))
            if len(runs) > 1:
                c["p99CI95"] = ci(boot_runs(runs, p99))
    if ref:
        ref = [r for r in ref if r.size]
        rp = np.concatenate(ref)
        c["p50DiffVsRef"] = r4(med(pooled) - med(rp))
        d = boot_runs(runs, med) - boot_runs(ref, med)
        c["p50DiffCI95"] = ci(d)
    return c


def busy_self(machine: dict) -> list[dict]:
    """This session's own analysis processes (python3/node) busy at a unit's start."""
    return [x for x in machine.get("busyProcessesPct", []) if x["comm"] in ("python3", "node") and x["cpuPct"] > 20]


# --------------------------------------------------------------------------- ab_bundles campaigns
def ab_campaign(d: Path, ref: str, rows: list[dict], label: str) -> dict:
    meta = json.loads((d / "campaign.json").read_text())
    units = [json.loads(p.read_text()) | {"dir": p.parent.name} for p in sorted(d.glob("u*/unit.json"))]
    contaminated = [u["dir"] for u in units if busy_self(u["machineStart"])]
    for u in units:
        for wl, rs in u["samples"].items():
            for k, r in enumerate(rs):
                rows.append({"campaign": label, "unit": u["dir"], "variant": u["variant"], "commit": u["commit"][:12],
                             "round": u["round"], "workload": wl, "k": k, "warmup": 0, "innerNs": r["inner"],
                             "outerNs": r["outer"], "solveNs": r["solve"], "applyNs": r["apply"], "writes": r["writes"],
                             "status": r["status"]})

    def summary(use) -> dict:
        by: dict[str, list[dict]] = {}
        for u in units:
            if use(u):
                by.setdefault(u["variant"], []).append(u)
        out = {}
        for v in meta["variants"]:
            us = by.get(v["spec"], [])
            c = {"units": len(us)}
            for wl in ("ratio", "swap", "focus"):
                for span in ("inner", "outer", "solve", "apply"):
                    runs = [np.array([r[span] / 1e6 for r in u["samples"][wl] if r[span] is not None]) for u in us]
                    refr = [np.array([r[span] / 1e6 for r in u["samples"][wl] if r[span] is not None]) for u in by.get(ref, [])]
                    if any(r.size for r in runs) and (span in ("inner", "outer") or wl != "focus"):
                        c[f"{wl}.{span}"] = cell(runs, refr if v["spec"] != ref and span in ("inner", "outer", "solve", "apply") else None)
            out[v["spec"]] = c
        return out

    return {"variants": [{k: x for k, x in v.items() if k not in ("qml",)} for v in meta["variants"]],
            "implementationCommit": meta["implementationCommit"], "implementationDirty": meta["implementationDirty"],
            "order": meta["order"], "reference": ref,
            "units": [{"dir": u["dir"], "variant": u["variant"], "round": u["round"], "seconds": u["seconds"],
                       "countsMatch": u["countsMatch"], "badLines": len(u["badLines"]), "unloaded": u["unloaded"],
                       "overflowAtStart": u["overflowAtStart"], "loadavg1": u["machineStart"]["loadavg"][0],
                       "busyAtStart": u["machineStart"]["busyProcessesPct"][:4]} for u in units],
            "unitsWithOwnBusyProcessAtStart": contaminated,
            "summary": summary(lambda u: True),
            "sensitivityWithoutThoseUnits": summary(lambda u: u["dir"] not in contaminated) if contaminated else None}


# --------------------------------------------------------------------------- ab_qualify campaigns
def qualify_campaign(d: Path, rows: list[dict], label: str, ref: str) -> dict:
    meta = json.loads((d / "campaign.json").read_text())
    out = {"mode": meta["mode"], "diag": meta["diag"], "n": meta["n"], "seed": meta["seed"], "order": meta["order"],
           "implementationCommit": meta["implementationCommit"], "implementationDirty": meta["implementationDirty"],
           "variants": [{k: x for k, x in v.items() if k != "qml"} for v in meta["variants"]], "units": [], "cells": {}}
    data: dict[str, dict[str, list[dict]]] = {}
    for v in meta["variants"]:
        for ud in sorted(d.glob(f"u*-{v['name']}")):
            if not (ud / "unit.json").exists():
                continue
            u = json.loads((ud / "unit.json").read_text())
            rs = [json.loads(ln) for ln in (ud / "samples.jsonl").read_text().splitlines()]
            data.setdefault(v["spec"], {})[ud.name] = rs
            out["units"].append({"dir": ud.name, "variant": v["spec"], "run": u["run"], "pass": u["pass"],
                                 "implementationDirty": u["implementationDirty"], "bundleSha256": u["root"]["bundleSha256"],
                                 "failures": u["failures"], "corrections": u["corrections"], "seconds": u["seconds"],
                                 "teardown": u["teardown"], "badLines": len(u["badLines"]),
                                 "loadavg1": u["machineStart"]["loadavg"][0], "busyAtStart": u["machineStart"]["busyProcessesPct"][:4],
                                 "calibrationP50Ns": u["calibration"].get("p50")})
            for r in rs:
                rows.append({"campaign": label, "unit": ud.name, "variant": v["spec"], "commit": v["commit"][:12], "round": u["run"],
                             "workload": r["workload"].removeprefix("P03-"), "k": r["k"], "warmup": int(r["warmup"]),
                             "innerNs": r["innerNs"], "outerNs": r["outerNs"], "solveNs": r["solveNs"], "applyNs": r["applyNs"],
                             "writes": r["geometryWrites"], "status": "ok" if r["success"] else r["failureReason"]})
    out["unitsWithOwnBusyProcessAtStart"] = [u["dir"] for u in out["units"] if busy_self({"busyProcessesPct": u["busyAtStart"]})]
    for v in meta["variants"]:
        c = {}
        for wl in ("ratio", "swap", "master", "focus", "noop"):
            def runs_of(spec: str, field: str) -> list[np.ndarray]:
                return [np.array([r[field] / 1e6 for r in rs if not r["warmup"] and r["workload"] == f"P03-{wl}" and r[field] is not None])
                        for rs in data.get(spec, {}).values()]
            refo = runs_of(ref, "outerNs") if v["spec"] != ref else None
            c[wl] = {"outer": cell(runs_of(v["spec"], "outerNs"), refo, tails=True)}
            if meta["mode"] == "instrumented" and wl not in ("focus",):
                refs = runs_of(ref, "solveNs") if v["spec"] != ref else None
                c[wl]["solve"] = cell(runs_of(v["spec"], "solveNs"), refs, tails=True)
        if meta["diag"] == "gcstats":
            c["gc"] = gc_attrib(d, v)
        out["cells"][v["spec"]] = c
    return out


def gc_attrib(d: Path, v: dict) -> list[dict]:
    """Per gcstats unit: where collections start relative to the commands, and the slow solves.

    qt.qml.gc.allocatorStats prints a header when a cycle starts: at the allocation that triggered
    it, inside the first step (qv4mm.cpp runGC -> CollectorStatistics::start). A header printed
    after perf line k-1 and before perf line k belongs to a cycle triggered after command k-1
    returned and before command k printed: in command k's handler or in event-loop work between
    the two. The logging itself makes each cycle longer than QV4's 5 ms incremental time limit,
    so logged cycles continue over later event-loop turns: their "took" figures are wall time
    under logging, not production cycle durations, and are not used for attribution.
    """
    import re
    header = re.compile(r"========== GC ==========")
    freed = re.compile(r"Freed up bytes\s*: (\d+)")
    after = re.compile(r"Regular item memory after GC: (\d+)")
    perf = re.compile(r"plastile perf (\{.*\})$")
    out = []
    for ud in sorted(d.glob(f"u*-{v['name']}")):
        log = (ud / "diag.log").read_text().splitlines() if (ud / "diag.log").exists() else []
        cmds, starts = [], 0
        freed_total, n_freed, live_after = 0, 0, []
        for ln in log:
            if header.search(ln):
                starts += 1
                continue
            f = freed.search(ln)
            if f:
                freed_total += int(f.group(1))
                n_freed += 1
                continue
            a = after.search(ln)
            if a:
                live_after.append(int(a.group(1)))
                continue
            p = perf.search(ln)
            if p:
                r = json.loads(p.group(1))
                t = r.get("timing") or {}
                cmds.append({"solve": (t.get("solveNs") or 0) / 1e6 if t else None, "starts": starts})
                starts = 0
        solving = [c for c in cmds if c["solve"] is not None]
        slow_ = [c for c in solving if c["solve"] > SLOW_MS]
        with_gc = [c for c in solving if c["starts"]]
        without = [c for c in solving if not c["starts"]]
        out.append({"unit": ud.name, "commands": len(cmds), "cycleStarts": sum(c["starts"] for c in cmds),
                    "cycleStartsPer1000Commands": r4(1000 * sum(c["starts"] for c in cmds) / max(1, len(cmds))),
                    # Managed-heap bytes freed by the cycles logged during the measured blocks, per command: the
                    # garbage per command of KWin's whole QV4 engine (Plastile and every other script).
                    "freedBytesPerCommand": round(freed_total / max(1, len(cmds))) if n_freed else None,
                    "liveAfterCollectionBytes": {"p50": nr(live_after, 0.5), "max": max(live_after) if live_after else None},
                    "solvingCommands": len(solving), "solvingCommandsWithCycleStart": len(with_gc),
                    "slowSolves": len(slow_), "slowSolvesWithCycleStart": sum(1 for c in slow_ if c["starts"]),
                    "slowShareWithCycleStart": r4(sum(1 for c in with_gc if c["solve"] > SLOW_MS) / max(1, len(with_gc))),
                    "slowShareWithoutCycleStart": r4(sum(1 for c in without if c["solve"] > SLOW_MS) / max(1, len(without))),
                    "solveMaxWithoutCycleStart": r4(max((c["solve"] for c in without), default=None))})
    return out


def qv4solve_campaign(d: Path) -> dict:
    meta = json.loads((d / "campaign.json").read_text())
    units = [json.loads(p.read_text()) | {"dir": p.parent.name} for p in sorted(d.glob("u*/unit.json"))]
    out = {"layer": meta["layer"], "args": {k: v for k, v in meta["args"].items() if k != "out"}, "order": meta["order"],
           "implementationCommit": meta["implementationCommit"], "implementationDirty": meta["implementationDirty"],
           "variants": [{k: x for k, x in v.items()} for v in meta["variants"]], "cells": {}, "units": []}
    for v in meta["variants"]:
        us = [u for u in units if u["variant"] == v["spec"]]
        c = {}
        for wl in meta["args"]["workloads"].split(","):
            c[wl] = cell([np.array(u["raw"].get(wl, [])) for u in us], tails=True)
        c["gcCyclesPerUnit"] = [u["gcCycles"] for u in us]
        c["gcMsPerUnit"] = [u["gcMs"] for u in us]
        out["cells"][v["spec"]] = c
    out["units"] = [{"dir": u["dir"], "variant": u["variant"], "round": u["round"], "seconds": u["seconds"], "errors": u["errors"],
                     "badLines": len(u["badLines"]), "loadavg1": u["machineStart"]["loadavg"][0],
                     "busyAtStart": u["machineStart"]["busyProcessesPct"][:4]} for u in units]
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--coarse", type=Path, required=True)
    ap.add_argument("--fine", type=Path, required=True)
    ap.add_argument("--instr", type=Path, required=True)
    ap.add_argument("--uninstr", type=Path)
    ap.add_argument("--gcstats", type=Path, action="append", default=[])
    ap.add_argument("--qv4solve", type=Path, action="append", default=[])
    ap.add_argument("--before", default="eca2df5")
    ap.add_argument("--out", type=Path, default=ROOT / "docs/status/evidence")
    args = ap.parse_args()
    rows: list[dict] = []
    ev = {
        "purpose": "G2 report §16: the two open G2 performance items (command-path median slowdown since b60e618; pure-solve p99 at 32 windows)",
        "layer": "nested KWin 6.7.5 virtual backend on the reference host; kglobalaccel D-Bus command API, not input; not physical",
        "generatedBy": "probes/perf/g2_followup.py", **{k: v for k, v in common.git_meta().items() if k != "dirtyPaths"},
        "versions": common.versions(),
        "statistics": "nearest-rank quantiles; p99 only from >= 5000 samples; 95 % intervals: bootstrap over whole units (runs), "
                      f"{B} resamples; differences resample the units of both variants; slow mode = solve > {SLOW_MS} ms",
        "bisect": {"workload": "b60e618's probes/perf/run.py P03: n = 32 fixtures, output 1920 x 5798, master/stack, no inactive desktops, "
                               "300 ratio (grow/shrink alternating), then 300 swap.next, then 300 focus.next, 15-30 ms pauses (seed 1), "
                               "instrumented (the bundle's dispatch -> return span 'inner', solve and apply spans; the root's outer span)",
                   "only the bundle varies": "every variant runs this tree's measurement root (probes/perf/main.qml with the persistence store), "
                                             "harness, fixture and KWin; the bundle is esbuild of that commit's src/ with this tree's options",
                   "coarse": ab_campaign(args.coarse, "b60e618", rows, "bisect-coarse"),
                   "fine": ab_campaign(args.fine, "b60e618", rows, "bisect-fine")},
    }
    ev["bisect"]["fineVsBefore"] = ab_campaign(args.fine, args.before, [], "x")["summary"]
    ev["qualifyInstrumented"] = qualify_campaign(args.instr, rows, "qualify-instrumented", args.before)
    if args.uninstr:
        ev["qualifyUninstrumented"] = qualify_campaign(args.uninstr, rows, "qualify-uninstrumented", args.before)
    ev["gcstats"] = [qualify_campaign(g, [], "gcstats", args.before) for g in args.gcstats]
    ev["qv4solve"] = [qv4solve_campaign(q) for q in args.qv4solve]
    ev["samplesFile"] = {"path": "g2-followup-samples.csv.xz", "rows": len(rows),
                         "fields": "campaign, unit, variant, commit, round, workload, k, warmup, innerNs, outerNs, solveNs, applyNs, writes, status"}
    args.out.mkdir(parents=True, exist_ok=True)
    common.write_json(args.out / "g2-followup.json", ev)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=["campaign", "unit", "variant", "commit", "round", "workload", "k", "warmup", "innerNs",
                                        "outerNs", "solveNs", "applyNs", "writes", "status"], lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    (args.out / "g2-followup-samples.csv.xz").write_bytes(lzma.compress(buf.getvalue().encode(), preset=9))
    print(args.out / "g2-followup.json", len(rows), "rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
