#!/usr/bin/env python3
"""Independent review of the G2 P03 evidence (docs/status/G2_REPORT.md §15).

Written separately from g2_aggregate.py (own CSV reader, own nearest-rank quantile, own
run bootstrap) so that the published numbers are checked by a second implementation:

  1. Recompute every pooled P03 cell (outer span; solve span where instrumented) from the
     committed raw samples g2-p03-samples.csv.xz and compare with g2-p03.json. Any
     difference larger than the 0.1 us rounding of the summary is a failure.
  2. Sample counts against PERFORMANCE §6.5 (p99 needs >= 5000 samples) and warm-up kept apart.
  3. The solve span's slow mode: share of solves > 0.5 ms per cell, separately for the measured
     units and the two diagnostic units (the GC-logged unit perturbs the collector).
  4. Send -> handler at n = 32 split by whether the previous command's virtual presentation had
     happened before the next send (fixture timeline, same CLOCK_MONOTONIC).
  5. Optional: review re-runs (qualify.py unit directories) against the campaign's cells, and
     an A/B of the b60e618 P03 workload on the b60e618 tree and on this tree (run.py summaries).

Nested KWin virtual backend only; nothing here is physical.

Usage: python3 probes/perf/g2_review.py [--rerun DIR ...] [--pack-reruns FILE.csv.xz] [--ab-old DIR ...] [--ab-new DIR ...]
           [--p04 pure.json --p04-provenance TEXT] [--out FILE]
"""
from __future__ import annotations

import argparse
import collections
import csv
import io
import json
import lzma
import math
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EV = ROOT / "docs/status/evidence"
sys.path.insert(0, str(HERE))
import perfcommon  # noqa: E402  (git provenance and machine state only; no statistics)

P99_MIN = 5000


def q(xs: list[float], p: float) -> float | None:
    """Nearest rank: the smallest value with at least p of the samples at or below it."""
    if not xs:
        return None
    s = sorted(xs)
    return s[max(1, math.ceil(p * len(s))) - 1]


def stats(xs: list[float]) -> dict:
    out = {"n": len(xs), "p50": r4(q(xs, 0.5)), "p95": r4(q(xs, 0.95)), "max": r4(max(xs)) if xs else None}
    if len(xs) >= P99_MIN:
        out["p99"] = r4(q(xs, 0.99))
    return out


def r4(x: float | None) -> float | None:
    return None if x is None else round(x, 4)


def run_bootstrap(by_run: dict[str, list[float]], p: float, reps: int = 2000, seed: int = 1) -> list[float]:
    rng = random.Random(seed)
    keys = sorted(by_run)
    vals = []
    for _ in range(reps):
        xs: list[float] = []
        for _ in keys:
            xs.extend(by_run[rng.choice(keys)])
        vals.append(q(xs, p))
    vals.sort()
    return [r4(vals[int(0.025 * reps)]), r4(vals[int(0.975 * reps) - 1])]


def load_rows() -> tuple[list[dict], dict]:
    meta = json.loads((EV / "g2-p03.json").read_text())
    text = lzma.decompress((EV / "g2-p03-samples.csv.xz").read_bytes()).decode()
    return list(csv.DictReader(io.StringIO(text))), meta


def ms(v: str) -> float:
    return int(v) / 1e6


def recompute(rows: list[dict], meta: dict) -> dict:
    runs = meta["samplesFile"]["runs"]
    cells: dict[tuple, dict[str, list]] = collections.defaultdict(lambda: collections.defaultdict(list))
    warm = collections.Counter()
    for r in rows:
        m = runs[r["runId"]]
        if m["diag"]:
            continue
        wl = r["workload"].removeprefix("P03-")
        key = (m["n"], wl, m["mode"])
        if r["warmup"] == "1":
            warm[key] += 1
            continue
        cells[key]["outer"].append(ms(r["outerNs"]))
        cells[key]["outerRun"].append((r["runId"], ms(r["outerNs"])))
        if r["solveNs"]:
            cells[key]["solve"].append(ms(r["solveNs"]))
        if r["success"] != "1":
            cells[key]["failures"].append(r["failureReason"])
    out, mismatches = {}, []
    for (n, wl, mode), c in sorted(cells.items()):
        name = f"n{n}/{wl}/{mode}"
        mine = {"samples": len(c["outer"]), "warmup": warm[(n, wl, mode)], "failures": len(c["failures"]),
                "outer": stats(c["outer"])}
        if c["solve"]:
            mine["solve"] = stats(c["solve"])
        pub = meta["cells"][name]
        po = pub["dispatchToLastRequestOuter"]["pooled"]
        checks = [("outer", k, mine["outer"].get(k), po.get(k)) for k in ("p50", "p95", "p99", "max")]
        if "solve" in mine:
            ps = pub["solve"]["pooled"]
            checks += [("solve", k, mine["solve"].get(k), ps.get(k)) for k in ("p50", "p95", "p99", "max")]
        for span, k, a, b in checks:
            if (a is None) != (b is None) or (a is not None and abs(a - b) > 0.0001):
                mismatches.append(f"{name} {span} {k}: recomputed {a} published {b}")
        if mine["samples"] != pub["samples"]:
            mismatches.append(f"{name}: {mine['samples']} samples recomputed, {pub['samples']} published")
        if n == 32 and mode == "uninstrumented" and wl in ("ratio", "swap", "master", "focus"):
            by_run = collections.defaultdict(list)
            for rid, v in c["outerRun"]:
                by_run[rid].append(v)
            mine["outerP95Ci95ByRun"] = run_bootstrap(by_run, 0.95)
            mine["outerP99Ci95ByRun"] = run_bootstrap(by_run, 0.99)
        out[name] = mine
    return {"cells": out, "mismatches": mismatches, "cellsChecked": len(out)}


def slow_solves(rows: list[dict], meta: dict, threshold_ms: float = 0.5) -> dict:
    runs = meta["samplesFile"]["runs"]
    tot, slow = collections.Counter(), collections.Counter()
    slow_vals = collections.defaultdict(list)
    for r in rows:
        m = runs[r["runId"]]
        if r["warmup"] == "1" or not r["solveNs"]:
            continue
        kind = m["diag"] or "measured"
        key = (kind, m["n"], r["workload"].removeprefix("P03-"))
        tot[key] += 1
        v = ms(r["solveNs"])
        if v > threshold_ms:
            slow[key] += 1
            slow_vals[(kind, m["n"])].append(v)
    cells = {f"{k}/n{n}/{wl}": {"solves": tot[(k, n, wl)], "slow": slow[(k, n, wl)],
                                "slowShare": round(slow[(k, n, wl)] / tot[(k, n, wl)], 4)}
             for (k, n, wl) in sorted(tot)}
    modes = {f"{k}/n{n}": stats(v) for (k, n), v in sorted(slow_vals.items())}
    return {"thresholdMs": threshold_ms, "note": "solve spans above the threshold form a separate mode; in the GC-logged "
            "unit every one held a full QV4 collection (g2-p03.json gcAttribution)", "cells": cells, "slowModeByUnitKind": modes}


def send_vs_pending_present(rows: list[dict], meta: dict, n: int = 32) -> dict:
    runs = meta["samplesFile"]["runs"]
    by = collections.defaultdict(list)
    for r in rows:
        if not runs[r["runId"]]["diag"] and runs[r["runId"]]["n"] == n:
            by[r["runId"]].append(r)
    groups = collections.defaultdict(list)
    skipped = 0
    for rs in by.values():
        for prev, cur in zip(rs, rs[1:]):
            if cur["warmup"] == "1":
                continue
            if not prev["requestToVirtualPresentNs"]:
                skipped += 1
                continue
            present = int(prev["dispatchOffsetNs"]) + int(prev["outerNs"]) + int(prev["requestToVirtualPresentNs"])
            send = int(cur["dispatchOffsetNs"]) - int(cur["sendToDispatchNs"])
            state = "previousPresentPending" if present > send else "previousPresented"
            groups[(prev["workload"].removeprefix("P03-"), state)].append(ms(cur["sendToDispatchNs"]))
    out = {}
    for (wl, state), xs in sorted(groups.items()):
        out[f"after-{wl}/{state}"] = stats(xs) | {"over2ms": sum(1 for x in xs if x > 2)}
    return {"n": n, "metric": "send -> handler (ms) of a command, by whether the previous command's virtual presentation "
            "(fixture wp_presentation, same clock) came before this send", "groups": out,
            "skippedNoPresentation": skipped}


def instrumentation_range(meta: dict) -> dict:
    out = {}
    for k, v in meta["instrumentationEffect"].items():
        out[k] = {"p50DiffMs": v["outerP50Ms"]["diff"], "p50Ci": v["outerP50Ms"]["diffCi95ByRun"],
                  "p95DiffMs": v["outerP95Ms"]["diff"], "p95Ci": v["outerP95Ms"]["diffCi95ByRun"]}
    solving = {k: x for k, x in out.items() if k.split("/")[1] in ("ratio", "swap", "master")}
    return {"perCell": out,
            "solvingCommandsP50DiffRangeMs": [min(x["p50DiffMs"] for x in solving.values()), max(x["p50DiffMs"] for x in solving.values())],
            "solvingCommandsP95DiffRangeMs": [min(x["p95DiffMs"] for x in solving.values()), max(x["p95DiffMs"] for x in solving.values())]}


def rerun_units(dirs: list[Path], meta: dict) -> dict:
    out = {}
    for d in dirs:
        u = json.loads((d / "unit.json").read_text())
        recs = [json.loads(ln) for ln in (d / "samples.jsonl").read_text().splitlines() if ln.strip()]
        by = collections.defaultdict(lambda: collections.defaultdict(list))
        for r in recs:
            if r["warmup"] or r["outerNs"] is None:
                continue
            wl = r["workload"].removeprefix("P03-")
            by[wl]["outer"].append(r["outerNs"] / 1e6)
            if r.get("solveNs") is not None:
                by[wl]["solve"].append(r["solveNs"] / 1e6)
            if r.get("innerNs") is not None:
                by[wl]["inner"].append(r["innerNs"] / 1e6)
        res = {}
        for wl, c in sorted(by.items()):
            res[wl] = {span: stats(xs) for span, xs in c.items()}
            if c.get("solve"):
                res[wl]["solveSlowShare"] = round(sum(1 for x in c["solve"] if x > 0.5) / len(c["solve"]), 4)
            camp = meta["cells"].get(f"n{u['n']}/{wl}/{u['mode']}")
            if camp and u.get("params", {}).get("inactiveDesktops") == 3:
                res[wl]["campaignPerRunOuterP50"] = [v["p50"] for v in camp["dispatchToLastRequestOuter"]["perRun"].values()]
                res[wl]["campaignPerRunOuterP95"] = [v["p95"] for v in camp["dispatchToLastRequestOuter"]["perRun"].values()]
        out[d.name] = {"implementationCommit": u["implementationCommit"], "implementationDirty": u["implementationDirty"],
                       "n": u["n"], "mode": u["mode"], "run": u["run"], "unitSeed": u["unitSeed"],
                       "inactiveDesktops": u.get("params", {}).get("inactiveDesktops"), "pass": u["pass"],
                       "load1mAtStart": u["machineStart"]["loadavg"][0],
                       "busyAtStart": [f"{p['comm']}:{p['cpuPct']}" for p in u["machineStart"]["busyProcessesPct"]],
                       "workloads": res}
    return out


def ab_runs(old: list[Path], new: list[Path]) -> dict:
    def one(d: Path) -> dict:
        s = json.loads((d / "summary.json").read_text())
        out = {"implementationCommit": s.get("implementationCommit") or None, "counts": {}}
        for n, c in s["counts"].items():
            out["counts"][n] = {wl: {"dispatchToReturnP50Ms": r4(v["dispatchToReturnNs"]["p50"] / 1e6),
                                     "dispatchToReturnP95Ms": r4(v["dispatchToReturnNs"]["p95"] / 1e6),
                                     "solveP50Ms": r4(v["solveNs"]["p50"] / 1e6) if v["solveNs"] else None,
                                     "solveP95Ms": r4(v["solveNs"]["p95"] / 1e6) if v["solveNs"] else None,
                                     "samples": v["samples"]}
                                for wl, v in c["workloads"].items()}
        return out
    return {"old": {d.name: one(d) for d in old}, "new": {d.name: one(d) for d in new}}


def p04_compare(path: Path) -> dict:
    """Re-run of node probes/perf/pure.ts against the committed g2-p04-node.json (which records no commit)."""
    new = json.loads(path.read_text())
    old = json.loads((EV / "g2-p04-node.json").read_text())
    out = {}
    for n, c in new["counts"].items():
        for wl, v in c.items():
            if not isinstance(v, dict) or "executeNs" not in v:
                continue
            o = old["counts"].get(n, {}).get(wl, {}).get("executeNs", {})
            out[f"n{n}/{wl}"] = {"executeP50Ms": {"committed": r4(o.get("p50", 0) / 1e6) if o else None,
                                                  "rerun": r4(v["executeNs"]["p50"] / 1e6)},
                                 "executeP95Ms": {"committed": r4(o.get("p95", 0) / 1e6) if o else None,
                                                  "rerun": r4(v["executeNs"]["p95"] / 1e6)}}
    return {"label": "Node V8 with a mock host; not QV4, not KWin", "node": new.get("node"), "samples": new.get("samples"),
            "cells": out}


RERUN_COLUMNS = ["unit", "runId", "implementationCommit", "workload", "cmd", "block", "k", "warmup", "outerNs", "innerNs", "solveNs",
        "applyNs", "activateNs", "solves", "geometryWrites", "expectedWrites", "configureCount", "sendToDispatchNs",
        "requestToFirstConfigureNs", "requestToLastCommitNs", "requestToVirtualPresentNs", "success", "failureReason"]


def pack_reruns(dirs: list[Path], out: Path) -> int:
    """Raw samples of the review re-runs, redacted (no titles, no paths), times relative to the last request."""
    cols = RERUN_COLUMNS
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    n = 0
    for d in dirs:
        unit = d.name
        for ln in (d / "samples.jsonl").read_text().splitlines():
            r = json.loads(ln)
            req = r["lastRequestNs"]

            def rel(k):
                return r[k] - req if r.get(k) is not None and req is not None else None
            row = {"unit": unit, "runId": r["runId"], "implementationCommit": r["implementationCommit"], "workload": r["workload"],
                   "cmd": r["cmd"], "block": r["block"], "k": r["k"], "warmup": int(r["warmup"]), "outerNs": r["outerNs"],
                   "innerNs": r.get("innerNs"), "solveNs": r.get("solveNs"), "applyNs": r.get("applyNs"),
                   "activateNs": r.get("activateNs"), "solves": r.get("solves"), "geometryWrites": r.get("geometryWrites"),
                   "expectedWrites": r.get("expectedWrites"), "configureCount": r.get("configureCount"),
                   "sendToDispatchNs": r["dispatchNs"] - r["sendNs"] if r.get("sendNs") else None,
                   "requestToFirstConfigureNs": rel("firstConfigureNs"), "requestToLastCommitNs": rel("lastCommitNs"),
                   "requestToVirtualPresentNs": rel("virtualPresentedNs"), "success": int(bool(r["success"])),
                   "failureReason": r.get("failureReason")}
            w.writerow(["" if row[c] is None else row[c] for c in cols])
            n += 1
    text = buf.getvalue()
    assert "/home" not in text and "/tmp" not in text
    out.write_bytes(lzma.compress(text.encode(), preset=9 | lzma.PRESET_EXTREME))
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rerun", type=Path, action="append", default=[], help="a qualify.py unit directory")
    ap.add_argument("--ab-old", type=Path, action="append", default=[], help="run.py output dir of the b60e618 tree")
    ap.add_argument("--ab-new", type=Path, action="append", default=[], help="run.py (b60e618 workload) output dir of this tree")
    ap.add_argument("--ab-note", default="")
    ap.add_argument("--p04", type=Path, default=None, help="a fresh pure.ts JSON output, run from this tree")
    ap.add_argument("--p04-provenance", default="", help="commit and tree state when the P04 re-run was taken")
    ap.add_argument("--pack-reruns", type=Path, default=None, help="also write the re-runs' raw samples (xz CSV) here")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    rows, meta = load_rows()
    rec = recompute(rows, meta)
    result = {
        "purpose": "Independent review of the G2 P03 evidence (G2_REPORT §15); nested KWin virtual backend, not physical",
        "reviewTree": perfcommon.git_meta(),
        "recompute": {"cellsChecked": rec["cellsChecked"], "mismatches": rec["mismatches"],
                      "p99Rule": f"p99 only from >= {P99_MIN} samples (PERFORMANCE §6.5)", "n32": {
                          k: v for k, v in rec["cells"].items() if k.startswith("n32/")}},
        "slowSolves": slow_solves(rows, meta),
        "sendToHandlerVsPendingPresent": send_vs_pending_present(rows, meta),
        "instrumentationEffect": instrumentation_range(meta),
    }
    if args.rerun:
        result["reruns"] = {"machine": perfcommon.machine_state(), "units": rerun_units(args.rerun, meta)}
    if args.ab_old or args.ab_new:
        result["abB60e618Workload"] = {"note": args.ab_note, **ab_runs(args.ab_old, args.ab_new)}
    if args.pack_reruns:
        result.setdefault("reruns", {})["rawSamples"] = {"path": args.pack_reruns.name, "rows": pack_reruns(args.rerun, args.pack_reruns),
                                                         "columns": RERUN_COLUMNS, "times": "ns; request* relative to the last request"}
    if args.p04:
        result["p04Rerun"] = {"provenance": args.p04_provenance, **p04_compare(args.p04)}
    text = json.dumps(result, indent=1) + "\n"
    text = text.replace(str(ROOT), "<repo>").replace(str(Path.home()), "~")
    if args.out:
        args.out.write_text(text)
    else:
        sys.stdout.write(text)
    print(f"cells checked {rec['cellsChecked']}, mismatches {len(rec['mismatches'])}", file=sys.stderr)
    for m in rec["mismatches"][:20]:
        print("  " + m, file=sys.stderr)
    return 1 if rec["mismatches"] else 0


if __name__ == "__main__":
    sys.exit(main())
