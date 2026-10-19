#!/usr/bin/env python3
"""QV4 pure-core solve probe: the engine + mock host inside a nested KWin's QV4 (G2 report §16).

Layer: KWin's own JavaScript engine (QV4, Qt 6.12) in a disposable nested KWin, but a *mock*
host (tests/core/mockHost.ts): no KWin window objects, no frame writes into KWin. It measures
the engine's solve span (the same clock points as production) and the garbage collector's
share of it, for one bundle per variant. It is not the §4 P03 measurement and not physical.

Each variant is a commit (or `worktree`): its src/ and tests/core/mockHost.ts are bundled with
this tree's tools/bundle-options.ts together with probes/perf/qv4solve/entry.ts. Units run one
at a time in rounds, each round every variant once in a seeded shuffled order.

  --gcstats   QT_LOGGING_RULES qt.qml.gc.allocatorStats=true: one block of lines per collection
              (duration, memory before/after). Diagnostic: it adds the logging to each cycle.

Usage: python3 probes/perf/qv4solve/run.py --variants REV[,REV...] [--rounds 3] [--samples 5000]
           [--workloads ratio,swap,master] [--gcstats] [--out DIR]
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "tests/integration"))
sys.path.insert(0, str(ROOT / "probes/perf"))
from harness import PLUGIN, Session  # noqa: E402
from workloads import measure_env  # noqa: E402
import perfcommon as common  # noqa: E402

BUILD = r"""
import { build } from "esbuild";
import { BUNDLE_OPTIONS } from "./tools/bundle-options.ts";
const [tree, entry, out] = process.argv.slice(1);
await build({ ...BUNDLE_OPTIONS, absWorkingDir: tree, entryPoints: [entry], outfile: out });
"""
SAMPLES = re.compile(r"qv4solve samples (\w+) (\[.*\])$")
GC_TOOK = re.compile(r"Garbage collection took (\d+) us")
SLOW_MS = 0.5


def git(*a: str) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *a], capture_output=True, text=True, check=True).stdout.strip()


def prepare(spec: str, trees: Path) -> dict:
    if spec == "worktree":
        sha, name = git("rev-parse", "HEAD"), "worktree"
    else:
        sha = git("rev-parse", spec + "^{commit}")
        name = sha[:12]
    tree = (trees / name).resolve()
    if tree.exists():
        shutil.rmtree(tree)
    tree.mkdir(parents=True)
    if spec == "worktree":
        shutil.copytree(ROOT / "src", tree / "src")
        (tree / "tests/core").mkdir(parents=True)
        shutil.copy(ROOT / "tests/core/mockHost.ts", tree / "tests/core/mockHost.ts")
    else:
        arc = subprocess.run(["git", "-C", str(ROOT), "archive", sha, "src", "tests/core/mockHost.ts"],
                             capture_output=True, check=True).stdout
        subprocess.run(["tar", "-x", "-C", str(tree)], input=arc, check=True)
    (tree / "probes/perf/qv4solve").mkdir(parents=True)
    shutil.copy(HERE / "entry.ts", tree / "probes/perf/qv4solve/entry.ts")
    shutil.copy(HERE / "main.qml", tree / "probes/perf/qv4solve/main.qml")
    (tree / "node_modules").symlink_to(ROOT / "node_modules")
    out = tree / "probes/perf/qv4solve/bench.mjs"
    subprocess.run(["node", "--input-type=module", "-e", BUILD, str(tree), "probes/perf/qv4solve/entry.ts", str(out)],
                   cwd=ROOT, check=True)
    dirty = bool(git("status", "--porcelain", "--", "src", "tests/core/mockHost.ts")) if spec == "worktree" else False
    return {"spec": spec, "name": name, "commit": sha, "srcDirty": dirty, "bundleBytes": out.stat().st_size, "tree": tree}


def q(xs: list[float], p: float) -> float | None:
    s = sorted(xs)
    return s[max(1, math.ceil(p * len(s))) - 1] if s else None


def stats(xs: list[float]) -> dict:
    out = {"n": len(xs), "p50": q(xs, 0.5), "p95": q(xs, 0.95), "max": max(xs) if xs else None,
           "slowShare": sum(1 for x in xs if x > SLOW_MS) / len(xs) if xs else None}
    if len(xs) >= 5000:
        out["p99"] = q(xs, 0.99)
    return {k: (round(v, 5) if isinstance(v, float) else v) for k, v in out.items()}


def unit(var: dict, args, seed: int, out: Path) -> dict:
    env = measure_env()
    if args.gcstats:
        env["QT_LOGGING_RULES"] = "js=true;qml=true;kwin_scripting=true;qt.qml.gc.allocatorStats=true"
    cfg = {"n": args.n, "height": (args.n - 1) * 186 + 32, "samples": args.samples, "warmup": args.warmup,
           "block": 100, "workloads": args.workloads, "seed": seed}
    rec = {"variant": var["spec"], "commit": var["commit"], "seed": seed, "config": cfg, "machineStart": common.machine_state()}
    t = time.monotonic()
    with Session(out / "session", width=1920, height=1080, extra_env=env, qml=var["tree"] / "probes/perf/qv4solve/main.qml",
                 config=cfg) as s:
        off = s.kw.mark()
        s.kw.load_declarative(s.qml, PLUGIN)
        s.loaded = True
        done = s.kw.wait_log(r"qv4solve done", 900, off)[-1]
        lines = s.log_lines(r"qv4solve samples |Garbage collection took|qt\.qml|qv4solve", off)
        s.kw.unload(PLUGIN)
        s.loaded = False
        rec["badLines"] = s.log_lines(r"TypeError|ReferenceError|Error:")[:10]
    rec["seconds"] = round(time.monotonic() - t, 1)
    rec["errors"] = int(done.rsplit("=", 1)[1])
    samples: dict[str, list[float]] = {}
    for ln in lines:
        m = SAMPLES.search(ln)
        if m:
            samples.setdefault(m.group(1), []).extend(x / 1e6 for x in json.loads(m.group(2)) if x >= 0)
    rec["solveMs"] = {wl: stats(xs) for wl, xs in samples.items()}
    rec["raw"] = {wl: [round(x, 5) for x in xs] for wl, xs in samples.items()}
    gcs = [int(m.group(1)) / 1e3 for ln in lines if (m := GC_TOOK.search(ln))]
    rec["gcCycles"] = len(gcs) if args.gcstats else None
    rec["gcMs"] = stats(gcs) if gcs else None
    if args.gcstats:
        (out / "gc.log").write_text("\n".join(ln for ln in lines if "qt.qml" in ln) + "\n")
    return rec


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--variants", required=True)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--n", type=int, default=32)
    ap.add_argument("--samples", type=int, default=5000)
    ap.add_argument("--warmup", type=int, default=200)
    ap.add_argument("--workloads", default="ratio,swap,master")
    ap.add_argument("--seed", type=int, default=20261019)
    ap.add_argument("--gcstats", action="store_true")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    out = args.out or ROOT / "artifacts/perf/qv4solve" / time.strftime("%Y%m%dT%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    variants = [prepare(v, out / "trees") for v in args.variants.split(",")]
    rng = random.Random(args.seed)
    plan = []
    for r in range(args.rounds):
        idx = list(range(len(variants)))
        rng.shuffle(idx)
        plan += [(r, i) for i in idx]
    meta = {"probe": "qv4solve", **common.git_meta(), "versions": common.versions(), "args": vars(args) | {"out": str(out)},
            "layer": "QV4 in nested KWin (virtual backend), mock host: not KWin's adapter, not physical",
            "variants": [{k: v for k, v in x.items() if k != "tree"} for x in variants],
            "order": [f"r{r}:{variants[i]['spec']}" for r, i in plan]}
    common.write_json(out / "campaign.json", meta)
    for k, (r, i) in enumerate(plan):
        v = variants[i]
        ud = out / f"u{k:03d}-r{r}-{v['name']}"
        ud.mkdir()
        rec = unit(v, args, args.seed + 7919 * r, ud)
        rec["round"] = r
        common.write_json(ud / "unit.json", rec)
        summ = ", ".join(f"{wl} p50 {s['p50']:.3f} p99 {s.get('p99', float('nan')):.3f} slow {100 * s['slowShare']:.2f}%"
                         for wl, s in rec["solveMs"].items())
        print(f"[{k + 1}/{len(plan)}] r{r} {v['spec']}: {summ}; gc {rec['gcCycles']} errors {rec['errors']} {rec['seconds']}s",
              flush=True)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
