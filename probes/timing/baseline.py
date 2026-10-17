#!/usr/bin/env python3
"""T04 nested baselines: P01 direct one-window placement and P02 native quick tile.

No tiler is loaded; the timing probe performs one placement per activation on the
controlled fixture client. Each run is a fresh disposable nested KWin (virtual
backend, 60 Hz software timeline) -- NOT a physical-session measurement.

Stages (all CLOCK_MONOTONIC ns):
  dispatch : harness invokeShortcut send -> handler entry   (D-Bus command API, not physical input)
  write    : frameGeometry setter duration in the script     (includes synchronous signal emission)
  configure: request -> client receives matching xdg configure
  commit   : request -> client commits the matching buffer
  observed : request -> script sees frameGeometryChanged with the target frame
  presented: request -> wp_presentation 'presented' time of that commit (virtual backend timeline)
Missing stages are null with a reason (e.g. a position-only move sends no configure).

Usage: python3 probes/timing/baseline.py [--runs 3] [--samples 300] [--seed 1]
Writes artifacts/baseline/<stamp>/{samples.jsonl,summary.json,run-*/...}.
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
sys.path.insert(0, str(ROOT / "tools"))
from nested import NestedKwin  # noqa: E402

PLUGIN = "plt-timing"
MEASURE = ROOT / "build/measure/qml"
FIXTURE = ROOT / "fixtures/client/build/plastile-fixture"
TM = re.compile(r"PLT-TM (\S+) (\{.*\})$")
TOL = 0.5  # logical px; KWin geometry is floating point

WORKLOADS = {
    "P01-resize": "plastile-probe-timing-alt-resize",
    "P01-move": "plastile-probe-timing-alt-move",
    "P02-quicktile": "plastile-probe-timing-quicktile",
}


def now() -> int:
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


def same(a, b) -> bool:
    return all(abs(a[k] - b[k]) <= TOL for k in ("x", "y", "width", "height"))


def quantiles(xs):
    s = sorted(x for x in xs if x is not None)
    if not s:
        return None
    q = lambda p: s[min(len(s) - 1, int(p * (len(s) - 1)))]  # noqa: E731
    return {"n": len(s), "min": s[0], "p50": q(0.5), "p95": q(0.95), "p99": q(0.99), "max": s[-1]}


def run_once(run_dir: Path, samples: int, rng: random.Random, workloads: list[str]) -> list[dict]:
    kwinrc = f"[Script-{PLUGIN}]\nfixtureClass=plastile-fixture\n"
    run_dir.mkdir(parents=True, exist_ok=True)
    fixture_log_path = run_dir / "fixture.jsonl"
    sends: list[tuple[str, int, int]] = []  # (workload, harness send ns, request seq)
    with open(fixture_log_path, "w") as fixture_log, \
            NestedKwin(run_dir, kwinrc=kwinrc, extra_env={"QML_IMPORT_PATH": str(MEASURE)}) as kw:
        fixture = kw.spawn([str(FIXTURE), "--ssd"], stdout=fixture_log, stdin=subprocess.PIPE)
        time.sleep(1.0)
        off = kw.mark()
        kw.load_declarative(HERE / "package/contents/ui/main.qml", PLUGIN)
        kw.wait_log(r"PLT-TM adopt ", 10, off)
        kw.wait_log(r"PLT-TM calibrated ", 60, off)
        seq = 0
        for wl in workloads:
            # P02 alternates an unmeasured reset with a measured quick tile.
            for _ in range(samples * (2 if wl == "P02-quicktile" else 1)):
                seq += 1
                t_send = kw.invoke_shortcut(WORKLOADS[wl])
                sends.append((wl, t_send, seq))
                pat = rf'PLT-TM observed \{{"t":[0-9.e+]+,"seq":{seq},'
                try:
                    kw.wait_log(pat, 2.0, off)
                except Exception:
                    pass  # recorded as a missing observation below
                time.sleep(rng.uniform(0.020, 0.045))  # seeded jitter, avoids phase-locking to vsync
        kw.unload(PLUGIN)
        kw.wait_log(r"PLT-TM teardown ", 5, off)
        events = [(m.group(1), json.loads(m.group(2))) for ln in kw.lines_since(off) if (m := TM.search(ln))]
        fixture.stdin.write(b"quit\n")
        fixture.stdin.flush()
        fixture.wait(timeout=5)

    requests = {e["seq"]: e for n, e in events if n == "request"}
    observed: dict[int, list] = {}
    for n, e in events:
        if n == "observed":
            observed.setdefault(e["seq"], []).append(e)
    client = [json.loads(ln) for ln in fixture_log_path.read_text().splitlines()]
    client = [c for c in client if c.get("win", "main") == "main"]
    presented = {c["seq"]: c for c in client if c["ev"] == "presented"}
    calib = {n: e for n, e in events if n in ("clock", "callLater", "coalesce")}

    out = []
    for wl, t_send, s in sends:
        req = requests.get(s)
        rec = {"workload": wl, "seq": s, "success": False, "failureReason": None,
               "dispatchNs": None, "writeNs": None, "configureNs": None, "commitNs": None,
               "observedNs": None, "presentedNs": None, "observations": 0, "configures": 0,
               "presentationUnavailableReason": None}
        if req is None:
            rec["failureReason"] = "no request logged"
            out.append(rec)
            continue
        wl = req.get("mode", wl)  # attribute by what the probe actually did (P02 has reset steps)
        rec["workload"] = wl
        t_req = req["writeStartNs"]
        rec["dispatchNs"] = req["entryNs"] - t_send
        rec["writeNs"] = req["writeEndNs"] - req["writeStartNs"]
        nxt = requests.get(s + 1)
        t_end = nxt["writeStartNs"] if nxt else float("inf")
        obs = observed.get(s, [])
        rec["observations"] = len(obs)
        target = req["target"]
        if target is not None and same(target, req["before"]):
            rec.update(success=True, noop=True, presentationUnavailableReason="target equals current frame (no-op)")
            out.append(rec)
            continue
        final = None
        for o in obs:
            if target is None or same(o["frame"], target):
                final = o
                break
        if target is None and obs:
            final = obs[-1]  # quick tile: target chosen by KWin; take the last observation of this request
        window = [c for c in client if t_req <= c["t_ns"] < t_end]
        cfgs = [c for c in window if c["ev"] == "configure"]
        rec["configures"] = len(cfgs)
        commit = None
        resize_expected = target is None or abs(target["width"] - req["before"]["width"]) > TOL \
            or abs(target["height"] - req["before"]["height"]) > TOL
        if resize_expected:
            want = None if final is None else final["client"]
            for c in cfgs:
                if want is None or (abs(c["width"] - want["width"]) <= TOL and abs(c["height"] - want["height"]) <= TOL):
                    rec["configureNs"] = c["t_ns"] - t_req
                    break
            commits = [c for c in window if c["ev"] == "commit" and c.get("reason") == "configure"]
            for c in commits:
                if want is None or (abs(c["width"] - want["width"]) <= TOL and abs(c["height"] - want["height"]) <= TOL):
                    commit = c
                    rec["commitNs"] = c["t_ns"] - t_req
                    break
        else:
            rec["presentationUnavailableReason"] = "position-only move: no client commit to attach presentation feedback to"
        if final is not None:
            rec["observedNs"] = final["t"] - t_req
            rec["success"] = True
        else:
            rec["failureReason"] = "target frame not observed before next request"
        if commit is not None:
            p = presented.get(commit["seq"])
            if p is not None:
                rec["presentedNs"] = p["present_ns"] - t_req
            else:
                rec["presentationUnavailableReason"] = "commit discarded or no presentation feedback"
        out.append(rec)
    return out, calib


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--samples", type=int, default=300, help="per workload per run")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--workloads", default=",".join(WORKLOADS))
    args = ap.parse_args()
    workloads = args.workloads.split(",")
    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = ROOT / "artifacts/baseline" / stamp
    out.mkdir(parents=True, exist_ok=True)
    rev = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "probes", "tools", "fixtures"],
                                capture_output=True, text=True).stdout.strip())
    all_recs, calibs = [], []
    for r in range(args.runs):
        rng = random.Random(args.seed * 1000 + r)
        order = workloads[r % len(workloads):] + workloads[: r % len(workloads)]  # rotate workload order per run
        recs, calib = run_once(out / f"run-{r}", args.samples, rng, order)
        for rec in recs:
            rec["run"] = r
        all_recs += recs
        calibs.append(calib)
    with open(out / "samples.jsonl", "w") as f:
        for rec in all_recs:
            f.write(json.dumps({"implementationCommit": rev, "implementationDirty": dirty, "environmentId": "nested-virtual-kwin-6.7.5",
                                "clock": "CLOCK_MONOTONIC", **rec}) + "\n")
    summary = {"implementationCommit": rev, "implementationDirty": dirty, "runs": args.runs, "samplesPerWorkloadPerRun": args.samples,
               "seed": args.seed, "layer": "nested KWin virtual backend (not physical)", "workloads": {}}
    for wl in workloads + ["P02-reset"]:
        recs = [x for x in all_recs if x["workload"] == wl]
        if not recs:
            continue
        ok = [x for x in recs if x["success"] and not x.get("noop")]
        summary["workloads"][wl] = {
            "samples": len(recs), "successes": len(ok), "noops": sum(1 for x in recs if x.get("noop")),
            "failures": sorted({x["failureReason"] for x in recs if not x["success"]}),
            **{f"{k}Ns": quantiles([x[f"{k}Ns"] for x in ok]) for k in
               ("dispatch", "write", "configure", "commit", "observed", "presented")},
            "observationsPerRequest": quantiles([x["observations"] for x in ok]),
            "configuresPerRequest": quantiles([x["configures"] for x in ok]),
            "perRunObservedP50Ns": [quantiles([x["observedNs"] for x in ok if x["run"] == r])["p50"]
                                    if any(x["run"] == r for x in ok) else None for r in range(args.runs)],
        }
    summary["calibration"] = calibs
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary["workloads"], indent=1))
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
