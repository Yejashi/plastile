#!/usr/bin/env python3
"""Soak sampling and idle-CPU comparison for the live session (PERFORMANCE P15, C14).

    python3 tools/physical/soak.py sample [--interval-min 10] [--duration-h 4] [--no-counters]
    python3 tools/physical/soak.py idle [--seconds 300] [--repeats 3] [--toggle manual|dbus] [--seed N]

sample: while you use the desktop normally, records every interval kwin_wayland's RSS,
CPU time and context switches (/proc, read-only), whether Plastile is loaded, and
Plastile's live counts (connections, tracked windows, outstanding requests, errors) from its
"Log counters" command via the user journal. The summary reports first/last/max and a
least-squares slope per hour for each series; a steadily rising connection or window count
at a stable number of open windows is the leak signal (PERFORMANCE section 4: no monotonic
unbounded growth; use live counts and trends, not one RSS snapshot).

idle: alternates "Plastile loaded" and "Plastile not loaded" in a seeded random order,
--repeats times each. For each period it waits 10 s, then measures kwin_wayland's CPU time and
context switches over --seconds while you do not touch the machine. With Plastile loaded it
also takes counter snapshots before and after, so any flush, deadline, solve or write during
idle is visible directly. Report the difference against the run-to-run spread; never claim
"0 % CPU" (PERFORMANCE section 4).

Both refuse to run outside a live, non-nested KWin Wayland session. Neither writes kwinrc;
--toggle dbus (explicit consent) loads/unloads Plastile through org.kde.kwin.Scripting and
restores the initial state on exit. Results: artifacts/physical/soak-<stamp>/ or idle-<stamp>/.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import common  # noqa: E402
import orchestrate  # noqa: E402

CLK_TCK = os.sysconf("SC_CLK_TCK")


def slope_per_hour(points: list[tuple[float, float]]) -> float | None:
    """Least-squares slope of (t_seconds, value) in value units per hour."""
    if len(points) < 3:
        return None
    ts = [p[0] for p in points]
    vs = [p[1] for p in points]
    mt, mv = statistics.fmean(ts), statistics.fmean(vs)
    den = sum((t - mt) ** 2 for t in ts)
    if den == 0:
        return None
    return sum((t - mt) * (v - mv) for t, v in zip(ts, vs)) / den * 3600


def series_summary(samples: list[dict], key: str) -> dict | None:
    pts = [(s["elapsedS"], s[key]) for s in samples if s.get(key) is not None]
    if not pts:
        return None
    vals = [v for _, v in pts]
    return {"n": len(vals), "first": vals[0], "last": vals[-1], "max": max(vals), "min": min(vals),
            "slopePerHour": slope_per_hour(pts)}


def take_sample(kwin_pid: int, bus: common.Bus, driver, counters: bool, t_start: float) -> dict:
    loaded = bus.script_loaded()
    rec = {"elapsedS": round(time.monotonic() - t_start, 1), "wallTime": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "kwinRssKiB": common.rss_kib(kwin_pid), "kwinCpuTicks": common.cpu_ticks(kwin_pid),
           "kwinContextSwitches": common.context_switches(kwin_pid), "plastileLoaded": loaded}
    if counters and loaded:
        c = driver.counters()
        if c and "counters" in c:
            rec.update({"connections": c.get("connections"), "windows": c.get("windows"),
                        "outstanding": c.get("outstanding"), "contexts": len(c.get("contexts") or []),
                        "errors": c["counters"].get("errors"), "writes": c["counters"].get("writes"),
                        "solves": c["counters"].get("solves")})
        else:
            rec["countersUnavailable"] = (c or {}).get("unavailableReason")
    return rec


def cmd_sample(args, guard, bus) -> int:
    outdir = args.out or common.ARTIFACTS / f"soak-{common.stamp()}"
    outdir.mkdir(parents=True, exist_ok=True)
    driver = orchestrate.LiveDriver(bus, "manual", "", True)
    t_start = time.monotonic()
    end = t_start + args.duration_h * 3600
    samples = []
    print(f"sampling every {args.interval_min} min for {args.duration_h} h (Ctrl-C ends early); results: {outdir}")
    try:
        while True:
            rec = take_sample(guard["kwinPid"], bus, driver, not args.no_counters, t_start)
            samples.append(rec)
            with open(outdir / "soak.jsonl", "a") as fh:
                fh.write(json.dumps(rec) + "\n")
            print(f"{rec['wallTime']} rss {rec['kwinRssKiB']} KiB, plastile loaded {rec['plastileLoaded']}, "
                  f"connections {rec.get('connections')}, windows {rec.get('windows')}, errors {rec.get('errors')}",
                  flush=True)
            if time.monotonic() + args.interval_min * 60 > end:
                break
            time.sleep(args.interval_min * 60)
    except KeyboardInterrupt:
        print("stopped")
    summary = {k: series_summary(samples, k) for k in
               ("kwinRssKiB", "connections", "windows", "outstanding", "errors", "contexts")}
    summary["samples"] = len(samples)
    summary["durationH"] = round((time.monotonic() - t_start) / 3600, 2)
    (outdir / "soak-summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps(summary, indent=1))
    return 0


def cmd_idle(args, guard, bus) -> int:
    outdir = args.out or common.ARTIFACTS / f"idle-{common.stamp()}"
    outdir.mkdir(parents=True, exist_ok=True)
    driver = orchestrate.LiveDriver(bus, args.toggle, "", args.yes)
    seed = args.seed if args.seed is not None else int(time.time())
    rng = random.Random(seed)
    order = []
    for _ in range(args.repeats):
        pair = ["plastile", "none"]
        rng.shuffle(pair)
        order += pair
    print(f"idle comparison, seed {seed}: {' '.join(order)}; {args.seconds} s each. Do not touch the machine.")
    if not common.confirm("Start?", args.yes):
        return 1
    periods = []
    try:
        for i, cond in enumerate(order):
            driver.ensure_condition(cond)
            time.sleep(10)
            c0 = driver.counters() if cond == "plastile" else None
            t0, cpu0, cs0 = time.monotonic(), common.cpu_ticks(guard["kwinPid"]), common.context_switches(guard["kwinPid"])
            time.sleep(args.seconds)
            t1, cpu1, cs1 = time.monotonic(), common.cpu_ticks(guard["kwinPid"]), common.context_switches(guard["kwinPid"])
            c1 = driver.counters() if cond == "plastile" else None
            dt = t1 - t0
            rec = {"period": i, "condition": cond, "seconds": round(dt, 2),
                   "kwinCpuPercent": None if cpu0 is None or cpu1 is None else 100.0 * (cpu1 - cpu0) / CLK_TCK / dt,
                   "kwinContextSwitchesPerS": None if cs0 is None or cs1 is None else (cs1 - cs0) / dt}
            if c0 and c1 and "counters" in c0 and "counters" in c1:
                rec["plastileCounterDelta"] = {k: c1["counters"][k] - c0["counters"].get(k, 0)
                                               for k in ("flushes", "deadlines", "solves", "writes", "corrections")}
            periods.append(rec)
            with open(outdir / "idle.jsonl", "a") as fh:
                fh.write(json.dumps(rec) + "\n")
            print(json.dumps(rec), flush=True)
    except (orchestrate.Abort, KeyboardInterrupt) as exc:
        print(f"stopped: {exc}", file=sys.stderr)
    finally:
        driver.restore()
    summary = {"seed": seed, "order": order, "seconds": args.seconds}
    for cond in ("plastile", "none"):
        cpu = [p["kwinCpuPercent"] for p in periods if p["condition"] == cond and p["kwinCpuPercent"] is not None]
        cs = [p["kwinContextSwitchesPerS"] for p in periods if p["condition"] == cond
              and p["kwinContextSwitchesPerS"] is not None]
        summary[cond] = {"periods": len(cpu), "cpuPercent": cpu, "contextSwitchesPerS": cs,
                         "cpuMedian": statistics.median(cpu) if cpu else None,
                         "csMedian": statistics.median(cs) if cs else None}
    deltas = [p.get("plastileCounterDelta") for p in periods if p.get("plastileCounterDelta")]
    summary["plastileWorkDuringIdle"] = deltas
    summary["plastileIdleWorkSeen"] = any(any(v for v in d.values()) for d in deltas) if deltas else None
    (outdir / "idle-summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps(summary, indent=1))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample")
    s.add_argument("--interval-min", type=float, default=10.0)
    s.add_argument("--duration-h", type=float, default=4.0)
    s.add_argument("--no-counters", action="store_true")
    s.add_argument("--out", type=Path, default=None)
    i = sub.add_parser("idle")
    i.add_argument("--seconds", type=float, default=300.0)
    i.add_argument("--repeats", type=int, default=3)
    i.add_argument("--toggle", choices=("manual", "dbus"), default="manual")
    i.add_argument("--seed", type=int, default=None)
    i.add_argument("--yes", action="store_true")
    i.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)
    try:
        guard = common.guard_live_session()
    except common.GuardError as exc:
        print("REFUSING TO RUN: " + "; ".join(exc.reasons), file=sys.stderr)
        return 3
    bus = common.Bus()
    return cmd_sample(args, guard, bus) if args.cmd == "sample" else cmd_idle(args, guard, bus)


if __name__ == "__main__":
    sys.exit(main())
