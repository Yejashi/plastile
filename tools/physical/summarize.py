#!/usr/bin/env python3
"""Summarize physical latency samples (PERFORMANCE sections 4, 6 and 8).

    python3 tools/physical/summarize.py artifacts/physical/<stamp>/samples.jsonl [more.jsonl ...]
        [--warmup artifacts/physical/<stamp>/warmup.jsonl] [--json summary.json]
        [--publish summary-redacted.json] [--bootstrap 2000] [--seed 1]

Groups: (layer, workload, condition, output, declared refresh, window count). A "run" is one
block (runId). For inputToFirstPresentNs and inputToSettledNs it reports, per run and pooled:
n, median, p95, p99, max. Quantiles use the nearest-rank definition (the smallest sample with
at least p*n samples at or below it; the median is the lower median for even n).

Rules this script enforces rather than leaves to the reader:
- p99 is withheld (null, with the reason) whenever its sample count is below 5000
  (PERFORMANCE section 6.5); per-run p99 is withheld unless that run alone has 5000 samples.
- Warmup samples are never pooled with measured samples; they are summarized separately.
- Failed samples are excluded from latency statistics but counted, by reason, next to them
  (PERFORMANCE section 6.8). Nothing is dropped silently.
- Confidence intervals are percentile bootstraps that resample whole runs (blocks), so
  run-to-run drift is part of the interval. They need at least 2 runs.
- A comparison verdict against the matched baseline (PERFORMANCE section 4, "physical
  input-to-first-visible": no additional full frame interval at the median, p95 within one
  output interval) is "pass" only with >= 5 runs and >= 5000 pooled samples per side.
  Otherwise it is "fail" (marked indicative) or "inconclusive".
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read_jsonl  # noqa: E402

P99_MIN_SAMPLES = 5000
MIN_RUNS = 5
METRICS = ("inputToFirstPresentNs", "inputToSettledNs")
GROUP_KEYS = ("layer", "workload", "condition", "outputName", "refreshHzDeclared", "windowCount")


def quantile(sorted_xs: list[int], p: float) -> int | None:
    """Nearest-rank quantile of an ascending list (p in (0, 1])."""
    if not sorted_xs:
        return None
    k = max(1, math.ceil(p * len(sorted_xs)))
    return sorted_xs[min(k, len(sorted_xs)) - 1]


def stats(xs: list[int]) -> dict:
    s = sorted(xs)
    n = len(s)
    out = {"n": n, "median": quantile(s, 0.5), "p95": quantile(s, 0.95), "p99": None,
           "max": s[-1] if s else None, "min": s[0] if s else None}
    if n >= P99_MIN_SAMPLES:
        out["p99"] = quantile(s, 0.99)
    else:
        out["p99WithheldReason"] = f"n={n} < {P99_MIN_SAMPLES} (PERFORMANCE section 6.5)"
    return out


def _stat_fn(name: str):
    p = {"median": 0.5, "p95": 0.95, "p99": 0.99}[name]
    return lambda s: quantile(s, p)


def bootstrap_ci(runs: list[list[int]], stat: str, *, b: int, rng: random.Random, level: float = 0.95):
    """Percentile bootstrap over runs: resample whole runs with replacement, pool, take the stat."""
    runs = [r for r in runs if r]
    if len(runs) < 2 or b <= 0:
        return None
    fn = _stat_fn(stat)
    vals = []
    for _ in range(b):
        pooled = sorted(x for _i in range(len(runs)) for x in runs[rng.randrange(len(runs))])
        vals.append(fn(pooled))
    vals.sort()
    lo = vals[int(((1 - level) / 2) * (b - 1))]
    hi = vals[int((1 - (1 - level) / 2) * (b - 1))]
    return [lo, hi]


def bootstrap_diff_ci(a_runs, b_runs, stat: str, *, b: int, rng: random.Random, level: float = 0.95):
    a_runs, b_runs = [r for r in a_runs if r], [r for r in b_runs if r]
    if len(a_runs) < 2 or len(b_runs) < 2 or b <= 0:
        return None
    fn = _stat_fn(stat)
    vals = []
    for _ in range(b):
        pa = sorted(x for _i in range(len(a_runs)) for x in a_runs[rng.randrange(len(a_runs))])
        pb = sorted(x for _i in range(len(b_runs)) for x in b_runs[rng.randrange(len(b_runs))])
        vals.append(fn(pa) - fn(pb))
    vals.sort()
    return [vals[int(((1 - level) / 2) * (b - 1))], vals[int((1 - (1 - level) / 2) * (b - 1))]]


def group_key(rec: dict) -> tuple:
    return tuple(rec.get(k) for k in GROUP_KEYS)


def summarize_group(recs: list[dict], *, b: int, rng: random.Random) -> dict:
    by_run: dict[str, list[dict]] = defaultdict(list)
    for r in recs:
        by_run[str(r.get("runId"))].append(r)
    ok = [r for r in recs if r.get("success")]
    failures = Counter(r.get("failureReason") or "unknown" for r in recs if not r.get("success"))
    refresh = sorted(r["refreshNsObserved"] for r in ok if r.get("refreshNsObserved"))
    out = {
        "samples": len(recs), "successes": len(ok), "successRate": (len(ok) / len(recs)) if recs else None,
        "runs": len(by_run), "failures": dict(failures.most_common()),
        "refreshNsObservedMedian": refresh[(len(refresh) - 1) // 2] if refresh else None,
        "metrics": {},
    }
    for m in METRICS:
        per_run = {run: sorted(r[m] for r in rs if r.get("success") and r.get(m) is not None)
                   for run, rs in sorted(by_run.items())}
        pooled = stats([x for xs in per_run.values() for x in xs])
        runs = list(per_run.values())
        ci = {"median": bootstrap_ci(runs, "median", b=b, rng=rng), "p95": bootstrap_ci(runs, "p95", b=b, rng=rng)}
        if pooled["p99"] is not None:
            ci["p99"] = bootstrap_ci(runs, "p99", b=b, rng=rng)
        out["metrics"][m] = {
            "pooled": pooled, "ci95ByRun": ci,
            "perRun": {run: stats(xs) for run, xs in per_run.items()},
        }
    out["protocol"] = {
        "runs": len(by_run), "minRuns": MIN_RUNS, "pooledSuccesses": len(ok), "minSamplesForP99": P99_MIN_SAMPLES,
        "met": len(by_run) >= MIN_RUNS and len(ok) >= P99_MIN_SAMPLES,
    }
    return out


def _runs_of(recs: list[dict], metric: str) -> list[list[int]]:
    by_run: dict[str, list[int]] = defaultdict(list)
    for r in recs:
        if r.get("success") and r.get(metric) is not None:
            by_run[str(r.get("runId"))].append(r[metric])
    return list(by_run.values())


def compare(cand: list[dict], base: list[dict], cand_sum: dict, base_sum: dict, *, b: int, rng: random.Random,
            matched: bool) -> dict:
    """Candidate minus baseline for the first-present metric, against one output interval."""
    metric = "inputToFirstPresentNs"
    interval = cand_sum.get("refreshNsObservedMedian") or base_sum.get("refreshNsObservedMedian")
    out = {"metric": metric, "thresholdNs": interval, "matchedBaseline": matched}
    ca, cb = _runs_of(cand, metric), _runs_of(base, metric)
    pa = cand_sum["metrics"][metric]["pooled"]
    pb = base_sum["metrics"][metric]["pooled"]
    if not pa["n"] or not pb["n"]:
        out["verdict"] = "inconclusive"
        out["reason"] = "no successful samples on one side"
        return out
    d_med = pa["median"] - pb["median"]
    d_p95 = pa["p95"] - pb["p95"]
    ci_med = bootstrap_diff_ci(ca, cb, "median", b=b, rng=rng)
    ci_p95 = bootstrap_diff_ci(ca, cb, "p95", b=b, rng=rng)
    out.update({"medianDiffNs": d_med, "medianDiffCi95": ci_med, "p95DiffNs": d_p95, "p95DiffCi95": ci_p95})
    met = cand_sum["protocol"]["met"] and base_sum["protocol"]["met"]
    out["protocolMet"] = met
    if interval is None:
        out["verdict"] = "inconclusive"
        out["reason"] = "no observed refresh interval"
        return out

    def rule(point, ci, strict: bool):
        upper = ci[1] if ci else None
        over = point >= interval if strict else point > interval
        if over:
            return "fail"
        if upper is not None and (upper < interval if strict else upper <= interval):
            return "pass"
        return "inconclusive"
    med_rule = rule(d_med, ci_med, strict=True)    # "no additional full frame interval at median"
    p95_rule = rule(d_p95, ci_p95, strict=False)   # "p95 within one output interval"
    out["medianRule"], out["p95Rule"] = med_rule, p95_rule
    if "fail" in (med_rule, p95_rule):
        out["verdict"] = "fail"
        if not met:
            out["indicative"] = True
    elif med_rule == p95_rule == "pass" and met:
        out["verdict"] = "pass"
    else:
        out["verdict"] = "inconclusive"
        if not met:
            out["reason"] = f"protocol not met (needs >= {MIN_RUNS} runs and >= {P99_MIN_SAMPLES} samples per side)"
    return out


def summarize(records: list[dict], *, warmup: list[dict] | None = None, matched: dict[str, str] | None = None,
              b: int = 2000, seed: int = 1) -> dict:
    rng = random.Random(seed)
    measured = [r for r in records if not r.get("warmup")]
    stray_warmup = [r for r in records if r.get("warmup")]
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in measured:
        groups[group_key(r)].append(r)
    out = {"definitions": {
        "quantile": "nearest-rank", "ci": "percentile bootstrap over runs (blocks)", "bootstrapResamples": b,
        "seed": seed, "p99MinSamples": P99_MIN_SAMPLES, "minRuns": MIN_RUNS,
        "verdictRule": "PERFORMANCE section 4: median diff < 1 interval and p95 diff <= 1 interval vs matched baseline",
    }, "groups": [], "comparisons": [], "warmup": []}
    sums = {}
    for key in sorted(groups, key=lambda k: tuple("" if v is None else str(v) for v in k)):
        s = summarize_group(groups[key], b=b, rng=rng)
        sums[key] = s
        out["groups"].append({**dict(zip(GROUP_KEYS, key)), **s})
    for wkey, wrecs in _group(list(warmup or []) + stray_warmup).items():
        ok = [r for r in wrecs if r.get("success")]
        out["warmup"].append({**dict(zip(GROUP_KEYS, wkey)), "samples": len(wrecs), "successes": len(ok),
                              "inputToFirstPresentNs": stats([r["inputToFirstPresentNs"] for r in ok
                                                              if r.get("inputToFirstPresentNs") is not None])})
    matched = matched or {}
    for key in groups:
        layer, workload, condition, output, hz, n = key
        if condition == "none":
            continue
        for bkey in groups:
            if bkey[2] != "none" or bkey[0] != layer or bkey[3] != output or bkey[4] != hz or bkey[5] != n:
                continue
            is_matched = matched.get(workload) == bkey[1]
            c = compare(groups[key], groups[bkey], sums[key], sums[bkey], b=b, rng=rng, matched=is_matched)
            out["comparisons"].append({"candidate": workload, "baseline": bkey[1], "layer": layer, "outputName": output,
                                       "refreshHzDeclared": hz, "windowCount": n, **c})
    return out


def _group(recs: list[dict]) -> dict[tuple, list[dict]]:
    g: dict[tuple, list[dict]] = defaultdict(list)
    for r in recs:
        g[group_key(r)].append(r)
    return g


def redact(summary: dict) -> dict:
    """Publishable copy: statistics only (no per-sample data, paths, ids or window metadata)."""
    def clean_group(g):
        g = copy.deepcopy(g)
        for m in g.get("metrics", {}).values():
            m["perRun"] = {f"run{i + 1}": v for i, v in enumerate(m["perRun"].values())}
        return g
    return {"definitions": summary["definitions"], "groups": [clean_group(g) for g in summary["groups"]],
            "comparisons": summary["comparisons"], "warmup": summary["warmup"]}


def fmt_ms(ns) -> str:
    return "-" if ns is None else f"{ns / 1e6:.2f}"


def render(summary: dict) -> str:
    lines = []
    for g in summary["groups"]:
        lines.append(f"{g['workload']} [{g['condition']}] layer={g['layer']} output={g['outputName']} "
                     f"{g['refreshHzDeclared']} Hz, {g['windowCount']} windows: {g['successes']}/{g['samples']} ok "
                     f"in {g['runs']} runs" + ("" if g["protocol"]["met"] else "  (protocol NOT met)"))
        for m, v in g["metrics"].items():
            p = v["pooled"]
            p99 = fmt_ms(p["p99"]) if p["p99"] is not None else f"withheld (n={p['n']}<{P99_MIN_SAMPLES})"
            ci = v["ci95ByRun"].get("median")
            ci_s = f" median CI95 [{fmt_ms(ci[0])}, {fmt_ms(ci[1])}]" if ci else ""
            lines.append(f"    {m}: median {fmt_ms(p['median'])} ms, p95 {fmt_ms(p['p95'])} ms, p99 {p99}, "
                         f"max {fmt_ms(p['max'])} ms{ci_s}")
        if g["failures"]:
            lines.append("    failures: " + "; ".join(f"{k} x{v}" for k, v in g["failures"].items()))
    for c in summary["comparisons"]:
        tag = "matched baseline" if c["matchedBaseline"] else "control"
        lines.append(f"{c['candidate']} vs {c['baseline']} ({tag}, {c['refreshHzDeclared']} Hz, "
                     f"{c['windowCount']} windows): median diff {fmt_ms(c.get('medianDiffNs'))} ms, "
                     f"p95 diff {fmt_ms(c.get('p95DiffNs'))} ms, interval {fmt_ms(c.get('thresholdNs'))} ms -> "
                     f"{c['verdict']}{' (indicative)' if c.get('indicative') else ''}"
                     f"{' - ' + c['reason'] if c.get('reason') else ''}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("samples", nargs="+", type=Path)
    ap.add_argument("--warmup", nargs="*", type=Path, default=[])
    ap.add_argument("--workloads", type=Path, default=Path(__file__).resolve().parent / "workloads.json",
                    help="workload file naming each candidate's matched baseline")
    ap.add_argument("--bootstrap", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--json", type=Path, default=None)
    ap.add_argument("--publish", type=Path, default=None, help="write a redacted, publishable summary here")
    args = ap.parse_args(argv)
    records = [r for p in args.samples for r in read_jsonl(p)]
    warm = [r for p in args.warmup for r in read_jsonl(p)]
    matched = {}
    if args.workloads and args.workloads.exists():
        for name, w in json.loads(args.workloads.read_text()).get("workloads", {}).items():
            if w.get("matchedBaseline"):
                matched[name] = w["matchedBaseline"]
    s = summarize(records, warmup=warm, matched=matched, b=args.bootstrap, seed=args.seed)
    print(render(s))
    if args.json:
        args.json.write_text(json.dumps(s, indent=1) + "\n")
    if args.publish:
        args.publish.parent.mkdir(parents=True, exist_ok=True)
        args.publish.write_text(json.dumps(redact(s), indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
