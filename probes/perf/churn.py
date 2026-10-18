#!/usr/bin/env python3
"""T34 lifetime qualification: reload cycles, random churn and idle cost (P14/P15/C14).

Everything runs against the production package (package/contents/ui/main.qml) in a
disposable nested KWin (tools/nested.py through tests/integration/harness.Session).
Geometry and window facts come from the harness oracle (one-shot KWin scripts);
Plastile's counters are used only for work-amount and consistency checks.

Modes:
  p14      100 reload cycles with 4 fixtures (one delaying configures by 200 ms), a
           pending resize.grow before each unload and one open/close per cycle.
           Per cycle: counters.connections, windows, KWin RSS, kglobalaccel names.
  control  the same cycles with the empty declarative script
           (probes/lifecycle/empty-package) and the same open/close churn; it
           attributes RSS growth to KWin's script loading and window churn.
  p15      seeded random churn for N minutes (open/close/minimize/unminimize/
           toggle-float/swap/ratio/layout.next, 2..8 windows, 100..400 ms apart),
           sampled every 30 s; then the C14 idle pairs (60 s loaded, 60 s unloaded,
           twice) with KWin CPU time from /proc/<pid>/stat.
  all      p14, control, p15 in sequence.

Raw results: artifacts/perf/<stamp>-churn/. With --evidence, redacted summaries go to
docs/status/evidence/churn-p14.json (p14 + control) and churn-p15.json (p15 + idle).

Nested virtual backend only. CPU-time figures are taken on a shared machine and are
indicative, not a performance claim.

Usage:
  python3 probes/perf/churn.py p14 [--cycles 100]
  python3 probes/perf/churn.py control [--cycles 100]
  python3 probes/perf/churn.py p15 [--minutes 10] [--seed 7] [--idle-seconds 60] [--idle-pairs 2]
  python3 probes/perf/churn.py all --evidence
"""
from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tests/integration"))
from harness import FIXTURE, Session, delta, tiling_errors  # noqa: E402

EMPTY_QML = ROOT / "probes/lifecycle/empty-package/contents/ui/main.qml"
EMPTY_PLUGIN = "plt-empty"
BAD = r"plastile (error|warn)|TypeError|ReferenceError"
# Any Plastile line between one instance's "stopped" and the next instance's "started"
# would come from a dead instance (the registry/teardown contract, T02/Q09).
PLT_LINE = r"\bplastile "
CLK_TCK = 100  # Linux USER_HZ; /proc/<pid>/stat utime/stime are in these ticks


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def git_meta() -> dict:
    rev = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "src", "package"],
                                capture_output=True, text=True).stdout.strip())
    kwin = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
    return {"implementationCommit": rev, "implementationDirty": dirty, "kwin": kwin,
            "layer": "nested KWin virtual backend (not physical)"}


def cpu_ticks(pid: int) -> int:
    """utime+stime of a process in clock ticks (readable even for the non-dumpable kwin_wayland)."""
    stat = Path(f"/proc/{pid}/stat").read_text()
    fields = stat[stat.rindex(")") + 2:].split()
    return int(fields[11]) + int(fields[12])  # fields 14 and 15 of the full line


def gap_lines(s: Session, offset: int) -> list[str]:
    """Plastile lines logged after a 'stopped' and before the next 'started' (dead-instance activity)."""
    lines = s.log_lines(PLT_LINE, offset)
    out, in_gap = [], False
    for ln in lines:
        if "plastile info stopped" in ln:
            in_gap = True
            continue
        if "plastile info started" in ln:
            in_gap = False
            continue
        if in_gap:
            out.append(ln)
    return out


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=1) + "\n"
    if "docs/status/evidence" in str(path):
        # Committed summaries: no absolute home or repository paths.
        text = text.replace(str(ROOT), "<repo>").replace(str(Path.home()), "~")
    path.write_text(text)


def sparse(xs: list, n: int = 10) -> list:
    return xs[:: max(1, len(xs) // n)] if xs else []


# --------------------------------------------------------------------------- P14

def run_p14(out: Path, cycles: int) -> dict:
    """100 reload cycles with pending work and open/close churn (P14 / Q09 at scale)."""
    recs: list[dict] = []
    failures: list[str] = []
    jl = open(out / "p14-cycles.jsonl", "w")
    with Session(out) as s:
        s.spawn(1); s.spawn(2); s.spawn(4, "--configure-delay-ms", "200"); s.spawn(3)
        s.load(); s.settle()
        base = s.counters()
        names0 = len(s.kw.shortcut_names())
        rss0 = s.kw.kwin_rss_kib()
        t_start = time.monotonic()
        for i in range(cycles):
            off = s.kw.mark()
            s.act("plastile-fixture 1", "workspace.activeWindow = w")
            s.cmd("resize.grow")               # pending work: fixture 4 answers configures 200 ms late
            # Evidence that work is really pending at unload (one counters round trip, well under 200 ms
            # on an idle machine; recorded per cycle, not assumed).
            pend = s.counters()["outstanding"]
            s.unload()
            # Poke the destroyed actions: a dead instance would answer with a counters line.
            s.cmd("inspect.counters"); s.cmd("resize.shrink")
            s.load()
            cc = s.settle()
            # Open/close churn while loaded (adopt + remove of a fifth window).
            s.spawn(5); s.kill(5)
            cc = s.settle()
            dead = gap_lines(s, off)
            bad = s.log_lines(BAD, off)
            rec = {"cycle": i, "outstandingAtUnload": pend, "connections": cc["connections"], "windows": cc["windows"], "outstanding": cc["outstanding"],
                   "errors": cc["counters"]["errors"], "rssKiB": s.kw.kwin_rss_kib(),
                   "shortcutNames": len(s.kw.shortcut_names()), "deadLines": len(dead), "badLines": len(bad),
                   "tSeconds": round(time.monotonic() - t_start, 1)}
            recs.append(rec)
            jl.write(json.dumps(rec) + "\n"); jl.flush()
            if cc["connections"] != base["connections"] or cc["windows"] != base["windows"]:
                failures.append(f"cycle {i}: connections/windows {cc['connections']}/{cc['windows']} != "
                                f"{base['connections']}/{base['windows']}")
            if dead:
                failures.append(f"cycle {i}: dead-instance lines: {dead[:2]}")
            if bad:
                failures.append(f"cycle {i}: error/warn/exception lines: {bad[:2]}")
            if rec["shortcutNames"] != names0:
                failures.append(f"cycle {i}: kglobalaccel names {rec['shortcutNames']} != {names0}")
            if rec["outstanding"] != 0:
                failures.append(f"cycle {i}: outstanding {rec['outstanding']} after settle")
        frames = s.frames_list()
        layout_errs = tiling_errors(frames, s.area(), 8)
        final = s.counters()
        all_bad = s.log_lines(BAD)
        rss_end = s.kw.kwin_rss_kib()
    jl.close()
    rss = [r["rssKiB"] for r in recs]
    half = len(rss) // 2
    summary = {
        "probe": "P14", "cycles": cycles, "fixtures": 4, "delayedFixtureMs": 200, "openCloseEachCycle": True,
        "pendingAtUnload": "resize.grow with one 200 ms-delayed client",
        "cyclesWithOutstandingAtUnload": sum(1 for r in recs if r["outstandingAtUnload"] > 0),
        "maxOutstandingAtUnload": max((r["outstandingAtUnload"] for r in recs), default=0),
        "connections": {"baseline": base["connections"], "min": min(r["connections"] for r in recs),
                        "max": max(r["connections"] for r in recs), "constant": all(r["connections"] == base["connections"] for r in recs)},
        "windows": {"baseline": base["windows"], "constant": all(r["windows"] == base["windows"] for r in recs)},
        "shortcutNames": {"first": names0, "min": min(r["shortcutNames"] for r in recs), "max": max(r["shortcutNames"] for r in recs)},
        "rssKiB": {"beforeCycles": rss0, "afterCycles": rss_end, "delta": rss_end - rss0, "byCycle": sparse(rss),
                   "secondHalfDelta": (rss[-1] - rss[half]) if half else None},
        "deadInstanceLines": sum(r["deadLines"] for r in recs),
        "errorWarnExceptionLines": len(all_bad), "errorWarnSamples": all_bad[:5],
        "finalCounters": final["counters"], "finalLayoutErrors": layout_errs,
        "secondsTotal": recs[-1]["tSeconds"] if recs else 0,
        "failures": failures, "pass": not failures and not all_bad and not layout_errs,
    }
    write_json(out / "p14-summary.json", summary)
    return summary


def run_control(out: Path, cycles: int) -> dict:
    """Same cycles with the empty declarative script and the same open/close churn."""
    recs: list[dict] = []
    jl = open(out / "control-cycles.jsonl", "w")
    with Session(out / "control", qml=EMPTY_QML) as s:
        s.spawn(1); s.spawn(2); s.spawn(4, "--configure-delay-ms", "200"); s.spawn(3)
        s.kw.load_declarative(EMPTY_QML, EMPTY_PLUGIN)
        s.spawn(5); s.kill(5)
        rss0 = s.kw.kwin_rss_kib()
        t_start = time.monotonic()
        for i in range(cycles):
            # Same shape as a P14 cycle: unload, load, one open/close, oracle reads.
            s.kw.unload(EMPTY_PLUGIN)
            Session.wait_for(lambda: not s.kw.is_loaded(EMPTY_PLUGIN), 5, "empty script unloaded")
            s.kw.load_declarative(EMPTY_QML, EMPTY_PLUGIN)
            s.spawn(5); s.kill(5)
            # Stand in for the settle() oracle calls of the P14 run (one-shot scripts also allocate).
            s.frames_list(); s.frames_list()
            rec = {"cycle": i, "rssKiB": s.kw.kwin_rss_kib(), "shortcutNames": len(s.kw.shortcut_names()),
                   "tSeconds": round(time.monotonic() - t_start, 1)}
            recs.append(rec)
            jl.write(json.dumps(rec) + "\n"); jl.flush()
        s.kw.unload(EMPTY_PLUGIN)
        rss_end = s.kw.kwin_rss_kib()
    jl.close()
    rss = [r["rssKiB"] for r in recs]
    half = len(rss) // 2
    names = [r["shortcutNames"] for r in recs]
    summary = {"probe": "P14-control", "script": "probes/lifecycle/empty-package (empty Item)", "cycles": cycles,
               "fixtures": 4, "openCloseEachCycle": True,
               "shortcutNames": {"min": min(names), "max": max(names)} if names else None,
               "rssKiB": {"beforeCycles": rss0, "afterCycles": rss_end, "delta": rss_end - rss0, "byCycle": sparse(rss),
                          "secondHalfDelta": (rss[-1] - rss[half]) if half else None},
               "secondsTotal": recs[-1]["tSeconds"] if recs else 0}
    write_json(out / "control-summary.json", summary)
    return summary


# --------------------------------------------------------------------------- P15

OPS = ("open", "close", "minimize", "unminimize", "toggle-float", "swap", "ratio", "layout.next")


def run_p15(out: Path, minutes: float, seed: int, idle_seconds: float, idle_pairs: int) -> dict:
    rng = random.Random(seed)
    jl = open(out / "p15-samples.jsonl", "w")
    ops_log = open(out / "p15-ops.jsonl", "w")
    samples: list[dict] = []
    op_counts = {o: 0 for o in OPS}
    failures: list[str] = []
    next_id = 1
    # Eight stacked windows need a tall output (KWin's 150x150 client minimum, see burst-C09).
    with Session(out, width=1280, height=1600) as s:
        live: list[int] = []

        def spawn_one() -> None:
            nonlocal next_id
            ident = next_id; next_id += 1
            delay = rng.choice((0, 0, 0, 120, 300))
            args = ("--configure-delay-ms", str(delay)) if delay else ()
            s.spawn(ident, *args)
            live.append(ident)

        for _ in range(3):
            spawn_one()
        s.load(); s.settle()
        t0 = time.monotonic()
        rss0 = s.kw.kwin_rss_kib()
        off0 = s.kw.mark()

        def sample(label: str) -> dict:
            c = s.counters()
            rec = {"tSeconds": round(time.monotonic() - t0, 1), "label": label, "windowsLive": len(live),
                   "counters": c["counters"], "outstanding": c["outstanding"], "connections": c["connections"],
                   "windows": c["windows"], "rssKiB": s.kw.kwin_rss_kib(), "badLines": len(s.log_lines(BAD, off0))}
            samples.append(rec)
            jl.write(json.dumps(rec) + "\n"); jl.flush()
            return rec

        sample("start")
        next_sample = t0 + 30.0
        deadline = t0 + minutes * 60.0
        n_ops = 0
        while time.monotonic() < deadline:
            op = rng.choice(OPS)
            if op == "open" and len(live) >= 8:
                op = "close"
            if op == "close" and len(live) <= 2:
                op = "open"
            target = rng.choice(live)
            cap = f"plastile-fixture {target}"
            try:
                if op == "open":
                    spawn_one()
                elif op == "close":
                    live.remove(target); s.kill(target)
                elif op == "minimize":
                    s.act(cap, "w.minimized = true")
                elif op == "unminimize":
                    s.act(cap, "w.minimized = false")
                elif op == "toggle-float":
                    s.act(cap, "workspace.activeWindow = w"); s.cmd("window.toggle-float")
                elif op == "swap":
                    s.act(cap, "workspace.activeWindow = w"); s.cmd("swap.next")
                elif op == "ratio":
                    s.act(cap, "workspace.activeWindow = w"); s.cmd(rng.choice(("resize.grow", "resize.shrink")))
                elif op == "layout.next":
                    s.cmd("layout.next")
            except Exception as exc:  # the oracle/actor failed, not necessarily Plastile
                failures.append(f"op {n_ops} {op}: {type(exc).__name__}: {str(exc)[:200]}")
                if len(failures) > 20:
                    break
            op_counts[op] += 1
            n_ops += 1
            ops_log.write(json.dumps({"i": n_ops, "t": round(time.monotonic() - t0, 3), "op": op, "target": target}) + "\n"); ops_log.flush()
            time.sleep(rng.uniform(0.1, 0.4))
            if time.monotonic() >= next_sample:
                sample("churn")
                next_sample += 30.0
        ops_log.close()
        churn_seconds = time.monotonic() - t0
        # Let the clients answer and the ledger drain, then judge.
        time.sleep(1.0)
        end = s.settle(timeout=10.0)
        final = sample("end")
        bad = s.log_lines(BAD, off0)
        if end["counters"]["errors"] != 0:
            failures.append(f"errors counter {end['counters']['errors']} != 0")
        if end["outstanding"] != 0:
            failures.append(f"outstanding {end['outstanding']} != 0 after churn")
        if bad:
            failures.append(f"error/warn/exception lines: {bad[:3]}")
        # Model vs oracle consistency: every unminimized, managed fixture is tracked.
        frames = s.frames_list()
        if end["windows"] != len(frames):
            failures.append(f"model windows {end['windows']} != oracle windows {len(frames)}")
        # Idle pairs (C14): loaded 60 s vs unloaded 60 s, repeated.
        idle = run_idle(s, idle_seconds, idle_pairs, failures)
        rss_end = s.kw.kwin_rss_kib()
    jl.close()
    summary = {
        "probe": "P15", "seed": seed, "minutesRequested": minutes, "churnSeconds": round(churn_seconds, 1),
        "ops": n_ops, "opCounts": op_counts, "windowRange": [2, 8], "gapMsRange": [100, 400],
        "clientConfigureDelaysMs": "seeded choice of 0/0/0/120/300 per spawned window",
        "samplesEvery30s": [{k: v for k, v in r.items() if k != "counters"} | {
            "solves": r["counters"]["solves"], "writes": r["counters"]["writes"], "corrections": r["counters"]["corrections"],
            "errors": r["counters"]["errors"], "deadlines": r["counters"]["deadlines"], "staleEvents": r["counters"]["staleEvents"]}
            for r in samples],
        "finalCounters": final["counters"], "finalOutstanding": final["outstanding"],
        "rssKiB": {"afterLoad": rss0, "afterChurn": final["rssKiB"], "afterIdle": rss_end, "churnDelta": final["rssKiB"] - rss0},
        "errorWarnExceptionLines": len(bad), "errorWarnSamples": bad[:5],
        "idle": idle, "failures": failures, "pass": not failures,
    }
    write_json(out / "p15-summary.json", summary)
    return summary


def run_idle(s: Session, seconds: float, pairs: int, failures: list[str]) -> dict:
    """C14: counters must not move while idle; KWin CPU time loaded vs unloaded."""
    pid = s.kw.kwin_pid
    assert pid is not None
    results = []
    for p in range(pairs):
        if not s.loaded:
            s.load()
        s.settle()
        a = s.counters()
        off = s.kw.mark()
        t_a, c_a = time.monotonic(), cpu_ticks(pid)
        time.sleep(seconds)
        t_b, c_b = time.monotonic(), cpu_ticks(pid)
        b = s.counters()
        d = {k: v for k, v in delta(a, b).items() if k != "commands"}  # inspect.counters itself counts as a command
        plt_lines = s.log_lines(PLT_LINE, off)
        plt_lines = [ln for ln in plt_lines if "plastile counters" not in ln]
        loaded = {"state": "loaded", "seconds": round(t_b - t_a, 2), "cpuMs": (c_b - c_a) * 1000 // CLK_TCK,
                  "countersDelta": d, "plastileLogLines": len(plt_lines), "rssKiB": s.kw.kwin_rss_kib()}
        loaded["cpuMsPerMinute"] = round(loaded["cpuMs"] * 60 / loaded["seconds"], 1)
        if d:
            failures.append(f"idle pair {p}: counters moved while idle: {d}")
        if plt_lines:
            failures.append(f"idle pair {p}: Plastile logged while idle: {plt_lines[:2]}")
        s.unload()
        time.sleep(0.5)
        t_a, c_a = time.monotonic(), cpu_ticks(pid)
        time.sleep(seconds)
        t_b, c_b = time.monotonic(), cpu_ticks(pid)
        unloaded = {"state": "unloaded", "seconds": round(t_b - t_a, 2), "cpuMs": (c_b - c_a) * 1000 // CLK_TCK,
                    "rssKiB": s.kw.kwin_rss_kib()}
        unloaded["cpuMsPerMinute"] = round(unloaded["cpuMs"] * 60 / unloaded["seconds"], 1)
        # Sensitivity control: the same counter must move when KWin does work (30 one-shot
        # oracle scripts), so a 0 reading above means "< one 10 ms tick", not a dead counter.
        t_a, c_a = time.monotonic(), cpu_ticks(pid)
        for _ in range(30):
            s.frames_list()
        t_b, c_b = time.monotonic(), cpu_ticks(pid)
        burst = {"oneShotScripts": 30, "seconds": round(t_b - t_a, 2), "cpuMs": (c_b - c_a) * 1000 // CLK_TCK}
        if burst["cpuMs"] <= 0:
            failures.append(f"idle pair {p}: CPU counter did not move during the activity burst (measurement not live)")
        results.append({"pair": p, "loaded": loaded, "unloaded": unloaded, "sensitivityBurst": burst,
                        "differenceMsPerMinute": round(loaded["cpuMsPerMinute"] - unloaded["cpuMsPerMinute"], 1)})
    return {
        "method": "utime+stime of the nested kwin_wayland from /proc/<pid>/stat (USER_HZ=100, 10 ms resolution), "
                  "fixtures left mapped and idle; the harness touches KWin only at the window boundaries",
        "caveat": "shared machine with other concurrent agents and nested sessions; CPU figures are indicative only",
        "loadAverageAtEnd": open("/proc/loadavg").read().split()[:3],
        "resolutionMs": 1000 // CLK_TCK,
        "zeroMeans": "fewer than one clock tick (10 ms) of KWin CPU in the window, i.e. < 10 ms per 60 s",
        "pairs": results,
        "counterDeltasZeroWhileLoaded": all(not r["loaded"]["countersDelta"] for r in results),
        "meanLoadedMsPerMinute": round(sum(r["loaded"]["cpuMsPerMinute"] for r in results) / len(results), 1),
        "meanUnloadedMsPerMinute": round(sum(r["unloaded"]["cpuMsPerMinute"] for r in results) / len(results), 1),
    }


# -------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=("p14", "control", "p15", "all"))
    ap.add_argument("--cycles", type=int, default=100)
    ap.add_argument("--minutes", type=float, default=10.0)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--idle-seconds", type=float, default=60.0)
    ap.add_argument("--idle-pairs", type=int, default=2)
    ap.add_argument("--evidence", action="store_true", help="also write docs/status/evidence/churn-*.json")
    ap.add_argument("--out", default="", help="artifact directory (default artifacts/perf/<stamp>-churn)")
    args = ap.parse_args()
    for need in (FIXTURE, ROOT / "package/contents/code/plastile.mjs"):
        if not need.exists():
            sys.exit(f"missing {need}")
    out = Path(args.out) if args.out else ROOT / "artifacts/perf" / f"{time.strftime('%Y%m%dT%H%M%S')}-churn"
    out.mkdir(parents=True, exist_ok=True)
    meta = git_meta() | {"startedAt": now()}
    ok = True
    if args.mode in ("p14", "all"):
        p14 = run_p14(out, args.cycles)
        print("P14", "PASS" if p14["pass"] else "FAIL", json.dumps({k: p14[k] for k in ("connections", "rssKiB", "deadInstanceLines",
                                                                                     "errorWarnExceptionLines", "failures")}))
        ok &= p14["pass"]
        if args.mode == "all" or args.evidence:
            ev = ROOT / "docs/status/evidence/churn-p14.json"
            prev = json.loads(ev.read_text()) if ev.exists() else {}
            write_json(ev, meta | {"purpose": "T34/P14: 100 Plastile reload cycles with pending work and window churn, nested KWin",
                                   "p14": p14, "control": prev.get("control")})
    if args.mode in ("control", "all"):
        ctl = run_control(out, args.cycles)
        print("CONTROL", json.dumps(ctl["rssKiB"]))
        if args.mode == "all" or args.evidence:
            ev = ROOT / "docs/status/evidence/churn-p14.json"
            prev = json.loads(ev.read_text()) if ev.exists() else {}
            write_json(ev, prev | meta | {"purpose": "T34/P14: 100 Plastile reload cycles with pending work and window churn, nested KWin",
                                          "control": ctl})
    if args.mode in ("p15", "all"):
        p15 = run_p15(out, args.minutes, args.seed, args.idle_seconds, args.idle_pairs)
        print("P15", "PASS" if p15["pass"] else "FAIL", json.dumps({k: p15[k] for k in ("ops", "finalOutstanding", "rssKiB", "failures")}))
        print("IDLE", json.dumps({k: p15["idle"][k] for k in ("meanLoadedMsPerMinute", "meanUnloadedMsPerMinute", "counterDeltasZeroWhileLoaded")}))
        ok &= p15["pass"]
        if args.mode == "all" or args.evidence:
            write_json(ROOT / "docs/status/evidence/churn-p15.json",
                       meta | {"purpose": "T34/P15 + C14: seeded random churn then idle CPU pairs, nested KWin", "p15": p15})
    print(f"artifacts: {out}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
