#!/usr/bin/env python3
"""Review re-measurement of G2 report §16 (branch wf/g2-perf-review): an independent summary of
the review's own nested units, written as redacted evidence.

A second implementation, on purpose: its own JSONL reader, nearest-rank quantile and unit
bootstrap; it shares no statistics code with ab_qualify.py, ab_bundles.py or g2_followup.py.
It reads the review's local unit directories (artifacts/, never committed):

  abq-instr    probes/perf/ab_qualify.py, instrumented, eca2df5 vs 212d86b, a new seed
  abq-uninstr  the same, uninstrumented (production mode)
  ab           probes/perf/ab_bundles.py, b60e618 vs eca2df5 vs 212d86b, a new seed

Every sample of every measured (non-warm-up) command is kept. p99 only from >= 5000 samples.
Nested KWin virtual backend only; nothing here is physical.

Usage: python3 probes/perf/g2_perf_review.py [--dir artifacts/perf/review] [--out docs/status/evidence/g2-perf-review.json]
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import perfcommon as common  # noqa: E402

SLOW_MS = 0.5


def nr(xs: list[float], p: float) -> float | None:
    """Nearest-rank quantile: the smallest x with at least p of the samples at or below it."""
    if not xs:
        return None
    s = sorted(xs)
    k = max(1, math.ceil(p * len(s)))
    return s[k - 1]


def units_boot(groups: list[list[float]], stat, reps: int = 2000, seed: int = 7) -> list[float] | None:
    """95 % interval of stat over resampled whole units."""
    if len(groups) < 2:
        return None
    rng = random.Random(seed)
    vals = []
    for _ in range(reps):
        pick = [groups[rng.randrange(len(groups))] for _ in groups]
        vals.append(stat([x for g in pick for x in g]))
    vals.sort()
    return [round(vals[int(0.025 * reps)], 4), round(vals[int(math.ceil(0.975 * reps)) - 1], 4)]


def diff_boot(a: list[list[float]], b: list[list[float]], stat, reps: int = 2000, seed: int = 11) -> list[float] | None:
    if len(a) < 2 or len(b) < 2:
        return None
    rng = random.Random(seed)
    vals = []
    for _ in range(reps):
        pa = [x for _ in a for x in a[rng.randrange(len(a))]]
        pb = [x for _ in b for x in b[rng.randrange(len(b))]]
        vals.append(stat(pb) - stat(pa))
    vals.sort()
    return [round(vals[int(0.025 * reps)], 4), round(vals[int(math.ceil(0.975 * reps)) - 1], 4)]


def describe(groups: list[list[float]]) -> dict:
    xs = [x for g in groups for x in g]
    if not xs:
        return {}
    out = {"samples": len(xs), "units": len(groups), "p50": nr(xs, 0.5), "p95": nr(xs, 0.95),
           "max": max(xs), "aboveHalfMs": sum(1 for x in xs if x > SLOW_MS),
           "unitP50": [round(nr(g, 0.5), 4) for g in groups],
           "p50CI95": units_boot(groups, lambda v: nr(v, 0.5)), "p95CI95": units_boot(groups, lambda v: nr(v, 0.95))}
    if len(xs) >= 5000:
        out["p99"] = nr(xs, 0.99)
        out["p99CI95"] = units_boot(groups, lambda v: nr(v, 0.99))
    return {k: round(v, 4) if isinstance(v, float) else v for k, v in out.items()}


def qualify_campaign(d: Path) -> dict:
    meta = json.loads((d / "campaign.json").read_text())
    res = {"mode": meta["mode"], "n": meta["n"], "seed": meta["seed"], "orderSeed": meta["orderSeed"],
           "order": meta["order"], "implementationCommit": meta.get("implementationCommit"),
           "implementationDirty": meta.get("implementationDirty"),
           "variants": {}}
    for v in meta["variants"]:
        uds = sorted(p for p in d.glob(f"u*-{v['name']}") if (p / "unit.json").exists())
        units, per = [], {}
        for ud in uds:
            u = json.loads((ud / "unit.json").read_text())
            units.append({"dir": ud.name, "run": u.get("run"), "pass": u.get("pass"), "failures": u.get("failures"),
                          "implementationDirty": u.get("implementationDirty"),
                          "bundleSha256": u.get("root", {}).get("bundleSha256"),
                          "corrections": u.get("corrections"), "loadavg1": u.get("loadavg1"),
                          "busyAtStart": u.get("busyAtStart")})
            for ln in (ud / "samples.jsonl").read_text().splitlines():
                r = json.loads(ln)
                if r.get("warmup"):
                    continue
                c = per.setdefault(r["workload"], {}).setdefault(ud.name, {"solve": [], "outer": [], "solves": 0, "writes": 0, "fail": 0})
                if r.get("solveNs") is not None:
                    c["solve"].append(r["solveNs"] / 1e6)
                if r.get("outerNs") is not None:
                    c["outer"].append(r["outerNs"] / 1e6)
                if r.get("success") is False:
                    c["fail"] += 1
                for k, f in (("solves", "solves"), ("writes", "geometryWrites")):
                    if isinstance(r.get(f), (int, float)):
                        c[k] += r[f]
        cells = {}
        for wl, byu in sorted(per.items()):
            cells[wl] = {"solve": describe([x["solve"] for x in byu.values() if x["solve"]]),
                         "outer": describe([x["outer"] for x in byu.values() if x["outer"]]),
                         "failedCommands": sum(x["fail"] for x in byu.values()),
                         "solvesCounted": sum(x["solves"] for x in byu.values()),
                         "writesCounted": sum(x["writes"] for x in byu.values())}
        res["variants"][v["spec"]] = {"commit": v["commit"], "units": units, "cells": cells, "_groups": per}
    specs = list(res["variants"])
    if len(specs) == 2:
        a, b = (res["variants"][s]["_groups"] for s in specs)
        dd = {}
        for wl in a:
            for span in ("solve", "outer"):
                ga = [x[span] for x in a[wl].values() if x[span]]
                gb = [x[span] for x in b.get(wl, {}).values() if x[span]]
                if ga and gb:
                    dd[f"{wl}.{span}.p50"] = {"delta": round(nr([x for g in gb for x in g], 0.5) - nr([x for g in ga for x in g], 0.5), 4),
                                              "CI95": diff_boot(ga, gb, lambda v: nr(v, 0.5))}
        res["difference"] = {"of": f"{specs[1]} - {specs[0]}", "cells": dd}
    for v in res["variants"].values():
        v.pop("_groups")
    return res


def bundles_campaign(d: Path) -> dict:
    meta = json.loads((d / "campaign.json").read_text())
    res = {"workload": "b60e618's run.py P03 (ab_bundles.py): n = 32, 300 ratio, 300 swap, 300 focus, instrumented; only the bundle varies",
           "order": meta.get("order"), "orderSeed": meta.get("seed"), "variants": {}}
    groups: dict[str, dict[str, list[list[float]]]] = {}
    for v in meta["variants"]:
        g = groups.setdefault(v["spec"], {})
        units = []
        for ud in sorted(p for p in d.glob(f"u*-{v['name']}") if (p / "unit.json").exists()):
            u = json.loads((ud / "unit.json").read_text())
            units.append({"dir": ud.name, "countsMatch": u.get("countsMatch"), "badLines": len(u.get("badLines") or []),
                          "unloaded": u.get("unloaded"), "otherNestedKwinAtStart": u.get("otherNestedKwinAtStart"),
                          "outstanding": (u.get("final") or {}).get("outstanding")})
            for wl, rows in (u.get("samples") or {}).items():
                for span in ("inner", "solve", "apply"):
                    xs = [r[span] / 1e6 for r in rows if r.get(span) is not None]
                    if xs:
                        g.setdefault(f"{wl}.{span}", []).append(xs)
        res["variants"][v["spec"]] = {"commit": v["commit"], "bundleBytes": v.get("bundleBytes"), "units": units,
                                      "cells": {k: describe(vs) for k, vs in sorted(g.items())}}
    ref = meta["variants"][0]["spec"]
    res["differenceTo"] = ref
    for spec, g in groups.items():
        if spec == ref:
            continue
        res["variants"][spec]["deltaP50"] = {
            k: {"delta": round(nr([x for u in g[k] for x in u], 0.5) - nr([x for u in groups[ref][k] for x in u], 0.5), 4),
                "CI95": diff_boot(groups[ref][k], g[k], lambda v: nr(v, 0.5))}
            for k in sorted(g) if k in groups[ref]}
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", type=Path, default=ROOT / "artifacts/perf/review")
    ap.add_argument("--out", type=Path, default=ROOT / "docs/status/evidence/g2-perf-review.json")
    a = ap.parse_args()
    out = {"purpose": "Adversarial review of G2 report §16 (wf/g2-perf): the before/after numbers re-measured with new seeds",
           "layer": "nested KWin virtual backend (not physical); kglobalaccel D-Bus command API, not input",
           "generatedBy": "probes/perf/g2_perf_review.py", **{k: v for k, v in common.git_meta().items() if k != "dirtyPaths"},
           "versions": common.versions(),
           "statistics": "nearest-rank quantiles; p99 only from >= 5000 samples; 95 % intervals by bootstrap over whole units (2000 resamples); every measured sample kept, warm-up never pooled"}
    for name, fn in (("qualifyInstrumented", qualify_campaign), ("qualifyUninstrumented", qualify_campaign), ("bundles", bundles_campaign)):
        sub = {"qualifyInstrumented": "abq-instr", "qualifyUninstrumented": "abq-uninstr", "bundles": "ab"}[name]
        if (a.dir / sub / "campaign.json").exists():
            out[name] = fn(a.dir / sub)
    common.write_json(a.out, out)
    print(a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
