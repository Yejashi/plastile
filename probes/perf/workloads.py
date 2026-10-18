#!/usr/bin/env python3
"""Perf workloads P05/P07/P12/P13 and the instrumentation-effect comparison, nested KWin only.

Each workload runs the production bundle through the measurement-only root
(probes/perf/main.qml, QML_IMPORT_PATH=build/measure/qml), which prints one
`plastile perf {...}` line per command with CLOCK_MONOTONIC timings taken inside
KWin's QV4 (dispatchToReturnNs = handler entry -> last frame request issued).
Geometry is always judged by the harness oracle (one-shot KWin scripts), never by
Plastile's own claims; Plastile counters gate the amount of work only.

  P05  burst create then close, n = 4/8/16/32 (spawned within ~50 ms)
  P07  overload: 50 swap.next back-to-back, then 50 at 20 ms
  P12  isolation: 4 desktops, 8 windows, 20 ratio commands on the visible desktop
  P13  configuration activation with 10/100/256 rules; command latency with 256 rules vs none
  instr  n=16 ratio workload, diagnostics=off vs diagnostics=debug
  teardown  the measurement root's own marker connection does not survive unload

The nested virtual backend is not a physical measurement. Machine state (load, governor, busy
processes, other nested sessions) is recorded at the start and end of every run.

Usage: python3 probes/perf/workloads.py [--only p05,p07,p12,p13,instr,teardown] [--samples 200] [--seed 1]
                                       [--counts 4,8,16,32] [--instr-order off,debug] [--out DIR]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tests/integration"))
from harness import PLUGIN, Session, delta, near, overlaps, tiling_errors  # noqa: E402

PERF = re.compile(r"plastile perf (\{.*\})$")
LOG_TS = re.compile(r"^\s*(\d+\.\d+) ")
# The measurement module must be built against the Qt of the KWin under test (build/measure
# for the host or the Ubuntu sandbox). PLASTILE_MEASURE_QML selects another build, e.g. one made
# for another KWin's Qt; none is provided for the KWin 6.8 Nix environment yet.
MEASURE = Path(os.environ.get("PLASTILE_MEASURE_QML") or ROOT / "build/measure/qml")
GAP = 8  # default gaps; the oracle checks margins >= GAP


def measure_env() -> dict:
    """QML_IMPORT_PATH for the nested KWin: the measurement module first, then whatever the
    environment already provides (a Nix environment's QML modules live there)."""
    paths = [str(MEASURE)] + [p for p in os.environ.get("QML_IMPORT_PATH", "").split(":") if p]
    return {"QML_IMPORT_PATH": ":".join(paths)}


def q(xs):
    s = sorted(xs)
    if not s:
        return None
    p = lambda f: s[min(len(s) - 1, int(f * (len(s) - 1)))]  # noqa: E731
    return {"n": len(s), "p50": p(0.5), "p95": p(0.95), "p99": p(0.99), "max": s[-1], "min": s[0]}


def us(t):
    """Percentile dict in ns -> compact microsecond string for the console."""
    if not t:
        return "-"
    return f"p50/p95/p99 {t['p50']/1e3:.0f}/{t['p95']/1e3:.0f}/{t['p99']/1e3:.0f} us (n={t['n']})"


def log_ts_ns(line: str) -> int | None:
    """KWin log lines start with %{time boot} seconds; the measured offset to CLOCK_MONOTONIC is reported."""
    m = LOG_TS.match(line)
    return int(float(m.group(1)) * 1e9) if m else None


class Results:
    def __init__(self):
        self.checks: dict[str, dict] = {}
        self.data: dict[str, object] = {}

    def check(self, name: str, ok: bool, detail=None) -> bool:
        self.checks[name] = {"pass": bool(ok), "detail": detail}
        print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f": {json.dumps(detail, default=str)[:300]}"), flush=True)
        return bool(ok)


# KWin reports a 150x150 minimum size for the fixture (window.minSize, measured in nested
# KWin 6.7.5) and the server-side titlebar adds 36 px, so a fixture frame is at least 186 px
# tall. Master/stack with one master stacks n - 1 windows in one column.
MIN_FRAME_H = 186
SLACK = 64


def stack_output_height(n: int, min_h: int = MIN_FRAME_H, gap: int = GAP) -> int:
    """Virtual output height that fits n windows in master/stack (one master) above their minima.

    The stack column holds n - 1 rows, with n - 2 inner gaps between them and two outer
    gaps. The earlier formula n * 186 + 32 left the gaps out: from n = 28 on, the stack no
    longer fits (n = 32 needs 6022 px, that formula gave 5984), so the newest window was
    floated by the overflow policy, which is correct behaviour for an infeasible layout.
    """
    rows = max(1, n - 1)
    return max(1080, rows * min_h + (rows - 1) * gap + 2 * gap + SLACK)


def stack_feasibility(s: Session, n: int, area: dict, gap: int = GAP) -> dict:
    """Measured precondition: the column of n - 1 minimum-height frames fits the work area.

    Read from KWin (minSize plus the frame/client margin of one fixture), so a different
    decoration height (another KWin or theme) shows up as an infeasible workload instead
    of as an overflow that looks like a product failure.
    """
    out = s.js("let r = null; for (const w of workspace.stackingOrder) if (w.caption.indexOf('plastile-fixture') === 0) {"
               " r = {minH: w.minSize.height, marginH: w.frameGeometry.height - w.clientGeometry.height}; break; } emit(r);")
    m = json.loads(out[0])
    min_frame = m["minH"] + m["marginH"] if m else MIN_FRAME_H
    rows = max(1, n - 1)
    need = rows * min_frame + (rows - 1) * gap + 2 * gap
    return {"minFrameHeight": min_frame, "stackRows": rows, "requiredHeight": need, "areaHeight": area["height"],
            "feasible": need <= area["height"]}


def session(out: Path, n: int, config: dict | None = None, qml: Path | None = None) -> Session:
    return Session(out, width=1920, height=stack_output_height(n), extra_env=measure_env(),
                   qml=qml or HERE / "main.qml", config=config)


def load_quiet(s: Session) -> None:
    """Load without waiting for the `started` info line (diagnostics=off prints none)."""
    s.kw.load_declarative(s.qml, PLUGIN)
    s.loaded = True

    def ready() -> bool:
        try:
            s.counters()
            return True
        except Exception:
            return False
    s.wait_for(ready, 30, "runtime answering inspect.counters")


def unload_quiet(s: Session) -> None:
    s.kw.unload(PLUGIN)
    s.loaded = False


def perf_lines(s: Session, off: int) -> list[dict]:
    recs = []
    for ln in s.log_lines(r"plastile perf ", off):
        r = json.loads(PERF.search(ln).group(1))
        r["logNs"] = log_ts_ns(ln)
        recs.append(r)
    return recs


def summarize(recs: list[dict], sends: list[int] | None = None) -> dict:
    if sends is not None:
        for r, t in zip(recs, sends):
            r["sendToEntryNs"] = r["entryNs"] - t
    timed = [r for r in recs if r.get("timing")]
    return {
        "samples": len(recs),
        "accepted": sum(1 for r in recs if r["status"] == "accepted"),
        "dispatchToReturnNs": q([r["dispatchToReturnNs"] for r in recs]),
        "solveNs": q([r["timing"]["solveNs"] for r in timed]),
        "applyNs": q([r["timing"]["applyNs"] for r in timed]),
        "writesPerCommand": q([r["timing"]["writes"] for r in timed]),
        "dbusSendToEntryNs": q([r["sendToEntryNs"] for r in recs if "sendToEntryNs" in r]),
        # Calibration of the log clock against the measurement clock (ms resolution in the log).
        "logClockMinusMonotonicMs": q([(r["logNs"] - r["entryNs"]) / 1e6 for r in recs if r.get("logNs")]),
    }


def ratio_run(s: Session, samples: int, rng: random.Random, pause=(0.015, 0.03)) -> tuple[dict, list[dict]]:
    off = s.kw.mark()
    sends = []
    for k in range(samples):
        sends.append(s.cmd("resize.grow" if k % 2 == 0 else "resize.shrink"))
        time.sleep(rng.uniform(*pause))
    s.settle(timeout=10)
    recs = perf_lines(s, off)
    return summarize(recs, sends), recs


def fixture_events(s: Session) -> dict[int, list[dict]]:
    out = {}
    for ident, fx in s.fixtures.items():
        evs = []
        for ln in fx.log.read_text(errors="replace").splitlines():
            try:
                evs.append(json.loads(ln))
            except ValueError:
                pass
        out[ident] = evs
    return out


# ------------------------------------------------------------------------------------ P05

def p05(res: Results, out: Path, counts=(4, 8, 16, 32)) -> None:
    table = {}
    for n in counts:
        print(f"P05 n={n}", flush=True)
        with session(out / f"p05-n{n}", n) as s:
            s.load()
            s.settle()
            area = s.area()
            c0 = s.counters()
            t_spawn0 = time.monotonic_ns()
            for i in range(1, n + 1):
                s.spawn(i, wait=False)
            t_spawn1 = time.monotonic_ns()
            # The oracle is a one-shot KWin script (tens of ms per poll), so the moment the
            # tiled state became true is bracketed: after the start of the last failing
            # poll and before the end of the first passing one.
            polls, t_ok, t_ok_start, t_fail_start = 0, None, None, None
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                tp = time.monotonic_ns()
                f = s.frames_list()
                polls += 1
                if len(f) == n and not tiling_errors(f, area, GAP):
                    t_ok, t_ok_start = time.monotonic_ns(), tp
                    break
                t_fail_start = tp
                time.sleep(0.02)
            c1 = s.settle(timeout=10)
            d_create = delta(c0, c1)
            # Measured after the burst so the extra oracle query does not perturb its timing.
            feas = stack_feasibility(s, n, area)
            res.check(f"P05 n={n}: workload feasible: {n - 1} stacked minimum frames fit the work area (measured)",
                      feas["feasible"], feas)
            f = s.frames_list()
            errs = tiling_errors(f, area, GAP)
            evs = fixture_events(s)
            mapped = [e["t_ns"] for es in evs.values() for e in es if e["ev"] == "mapped"]
            commits = [e["t_ns"] for es in evs.values() for e in es if e["ev"] == "commit" and e["reason"] == "configure"]
            configures = [sum(1 for e in es if e["ev"] == "configure") for es in evs.values()]
            last_mapped = max(mapped) if len(mapped) == n else None
            row = {
                "n": n,
                "feasibility": feas,
                "spawnSpanMs": (t_spawn1 - t_spawn0) / 1e6,
                "mappedSpanMs": (max(mapped) - min(mapped)) / 1e6 if mapped else None,
                "mappedCount": len(mapped),
                "create": d_create,
                "solvesPerFlush": d_create.get("solves", 0) / max(1, d_create.get("flushes", 0)),
                "solvesPerWindow": d_create.get("solves", 0) / n,
                "lastMappedToLastClientCommitMs": (max(commits) - last_mapped) / 1e6 if commits and last_mapped else None,
                "lastMappedToOracleTiledMs": (t_ok - last_mapped) / 1e6 if t_ok and last_mapped else None,
                # [lower, upper] bound: start of the last failing poll (or the last mapping), end of the passing poll.
                "lastMappedToOracleTiledBoundsMs": [round((max(t_fail_start or 0, last_mapped) - last_mapped) / 1e6, 3),
                                                    round((t_ok - last_mapped) / 1e6, 3)] if t_ok and last_mapped else None,
                "passingPollMs": (t_ok - t_ok_start) / 1e6 if t_ok else None,
                "writesPerWindow": d_create.get("writes", 0) / n,
                "oraclePolls": polls,
                "configuresPerWindow": q(configures),
                "finalTilingErrors": errs,
                "overflow": c1["counters"]["overflow"], "errors": c1["counters"]["errors"],
            }
            res.check(f"P05 n={n}: all {n} tiled without overlap (oracle)", len(f) == n and not errs, errs[:5])
            res.check(f"P05 n={n}: create solves bounded (<= n)", 0 < d_create.get("solves", 0) <= n, d_create)
            res.check(f"P05 n={n}: create solves <= flushes (one context: at most one solve per flush)",
                      d_create.get("solves", 0) <= d_create.get("flushes", 0), d_create)
            res.check(f"P05 n={n}: no overflow, no errors", c1["counters"]["overflow"] == 0 and c1["counters"]["errors"] == 0, c1["counters"])
            # Close all.
            c2 = s.counters()
            t_close0 = time.monotonic_ns()
            for i in range(1, n + 1):
                s.kill(i, wait=False)
            s.wait_for(lambda: len(s.frames_list()) == 0, 30, "all windows closed")
            c3 = s.settle(timeout=10)
            d_close = delta(c2, c3)
            row["close"] = d_close
            row["closeSpanMs"] = (time.monotonic_ns() - t_close0) / 1e6
            row["closeSolvesPerFlush"] = d_close.get("solves", 0) / max(1, d_close.get("flushes", 0))
            res.check(f"P05 n={n}: close solves bounded (<= n)", d_close.get("solves", 0) <= n, d_close)
            res.check(f"P05 n={n}: close solves <= flushes", d_close.get("solves", 0) <= d_close.get("flushes", 0), d_close)
            res.check(f"P05 n={n}: windows gone, no errors", c3["windows"] == 0 and c3["counters"]["errors"] == 0,
                      {"windows": c3["windows"], "errors": c3["counters"]["errors"]})
            table[str(n)] = row
            print(f"  n={n}: spawn span {row['spawnSpanMs']:.0f} ms, create {d_create}, solves/flush {row['solvesPerFlush']:.2f}, "
                  f"last-mapped->client-commit {row['lastMappedToLastClientCommitMs']} ms, ->oracle {row['lastMappedToOracleTiledMs']} ms, "
                  f"close {d_close}", flush=True)
    res.data["p05"] = table


# ------------------------------------------------------------------------------------ P07

def swap_expected(order: list[str], active: str, k: int) -> list[str]:
    """Member order after k swap.next on `active` (focus stays on the moved window: engine.ts swapCommand)."""
    m = order[:]
    n = len(m)
    for _ in range(k):
        i = m.index(active)
        j = (i + 1) % n
        m[i], m[j] = m[j], m[i]
    return m


def frames_match(frames: dict, init: dict, order: list[str], members: list[str]) -> list[str]:
    bad = []
    for slot, cap in enumerate(members):
        want = init[order[slot]]["frame"]
        if not near(frames[cap]["frame"], want, 1.0):
            bad.append(f"{cap} at {frames[cap]['frame']} expected slot {slot} {want}")
    return bad


def p07(res: Results, out: Path) -> None:
    table = {}
    for n in (2, 4):
        print(f"P07 n={n}", flush=True)
        with session(out / f"p07-n{n}", n) as s:
            for i in range(1, n + 1):
                s.spawn(i)
            s.load()
            s.settle()
            area = s.area()
            active = "plastile-fixture 1"
            s.act(active, "workspace.activeWindow = w")
            init = s.frames()
            order = sorted(init, key=lambda k: (init[k]["frame"]["x"], init[k]["frame"]["y"]))
            res.check(f"P07 n={n}: initial {n} tiled", len(init) == n and not tiling_errors(list(init.values()), area, GAP))
            c0 = s.counters()
            off = s.kw.mark()
            t0 = time.monotonic_ns()
            burst_sends = [s.cmd("swap.next") for _ in range(50)]
            burst_span = time.monotonic_ns() - t0
            c_mid = s.settle(timeout=15)
            f1 = s.frames()
            bad1 = frames_match(f1, init, order, swap_expected(order, active, 50))
            burst = summarize(perf_lines(s, off), burst_sends)
            res.check(f"P07 n={n}: 50 back-to-back swaps -> expected permutation (oracle)", not bad1 and len(f1) == n, bad1[:3])
            res.check(f"P07 n={n}: 50 perf records for the burst", burst["samples"] == 50 and burst["accepted"] == 50,
                      {"samples": burst["samples"], "accepted": burst["accepted"]})
            off = s.kw.mark()
            paced_sends = []
            for _ in range(50):
                paced_sends.append(s.cmd("swap.next"))
                time.sleep(0.02)
            c_end = s.settle(timeout=15)
            f2 = s.frames()
            bad2 = frames_match(f2, init, order, swap_expected(order, active, 100))
            paced = summarize(perf_lines(s, off), paced_sends)
            res.check(f"P07 n={n}: +50 paced swaps -> expected permutation (oracle)", not bad2, bad2[:3])
            if n == 2:
                res.check("P07 n=2: even count (50, 100) returns to the initial frames",
                          not bad1 and not bad2 and all(near(f2[k]["frame"], init[k]["frame"], 1.0) for k in init))
            period = n * (n - 1)
            topup = (-100) % period
            if topup:
                for _ in range(topup):
                    s.cmd("swap.next")
                    time.sleep(0.02)
                s.settle(timeout=15)
                f3 = s.frames()
                res.check(f"P07 n={n}: after {100 + topup} swaps (multiple of the period {period}) back to the initial frames",
                          all(near(f3[k]["frame"], init[k]["frame"], 1.0) for k in init), {k: f3[k]["frame"] for k in f3})
            d = delta(c0, c_end)
            res.check(f"P07 n={n}: 100 commands counted, errors == 0", d.get("commands", 0) == 100 and c_end["counters"]["errors"] == 0, d)
            res.check(f"P07 n={n}: no outstanding requests at the end", c_end["outstanding"] == 0, c_end["outstanding"])
            table[str(n)] = {"n": n, "burstSendSpanMs": burst_span / 1e6, "burst": burst, "paced": paced,
                             "counters": d, "commandsQueued": c_end["counters"]["commandsQueued"] - c0["counters"]["commandsQueued"],
                             "errors": c_end["counters"]["errors"], "swapPeriod": period, "topupSwaps": topup}
            print(f"  burst 50 sent in {burst_span/1e6:.0f} ms; dispatchToReturn burst {us(burst['dispatchToReturnNs'])}, "
                  f"paced {us(paced['dispatchToReturnNs'])}; queued {table[str(n)]['commandsQueued']}; {d}", flush=True)
    res.data["p07"] = table


# ------------------------------------------------------------------------------------ P12

def p12(res: Results, out: Path, rng: random.Random) -> None:
    print("P12", flush=True)
    with session(out / "p12", 2) as s:
        nd = json.loads(s.js("for (let i = 0; i < 3; ++i) workspace.createDesktop(workspace.desktops.length, 'D' + (i + 2));"
                             " emit(workspace.desktops.length);")[0])
        res.check("P12: 4 desktops", nd == 4, nd)
        for i in range(1, 9):
            s.spawn(i)
        for i in range(1, 9):
            k = (i - 1) // 2
            if k:
                s.act(f"plastile-fixture {i}", f"w.desktops = [workspace.desktops[{k}]]")
        s.load()
        c0 = s.settle()
        area = s.area()
        cur = json.loads(s.js("emit(String(workspace.currentDesktop.id))")[0])
        f0 = s.frames()
        visible = sorted(k for k, v in f0.items() if cur in v["desktops"])
        hidden = sorted(k for k in f0 if k not in visible)
        res.check("P12: 2 visible + 6 hidden windows", len(visible) == 2 and len(hidden) == 6, {"visible": visible})
        res.check("P12: adoption solved only the visible context (1 solve)", c0["counters"]["solves"] == 1, c0["counters"]["solves"])
        res.check("P12: visible pair tiled", not tiling_errors([f0[k] for k in visible], area, GAP))
        s.act(visible[0], "workspace.activeWindow = w")
        c1 = s.counters()
        lat, _ = ratio_run(s, 20, rng, pause=(0.02, 0.03))
        c2 = s.settle()
        d = delta(c1, c2)
        f1 = s.frames()
        changed = [k for k in hidden if f1[k]["frame"] != f0[k]["frame"]]
        res.check("P12: 20 ratio commands -> exactly 20 solves", d.get("solves", 0) == 20, d)
        res.check("P12: writes only to the visible pair (2 per command)", d.get("writes", 0) == 40, d)
        res.check("P12: zero geometry change on the 6 hidden windows (oracle)", not changed, changed)
        res.check("P12: visible pair still tiled", not tiling_errors([f1[k] for k in visible], area, GAP))
        c3 = s.counters()
        s.js("workspace.currentDesktop = workspace.desktops[1]; emit(1)")
        c4 = s.settle()
        d2 = delta(c3, c4)
        f2 = s.frames()
        d2id = json.loads(s.js("emit(String(workspace.desktops[1].id))")[0])
        shown = sorted(k for k, v in f2.items() if d2id in v["desktops"])
        others = [k for k in f2 if k not in shown]
        res.check("P12: desktop switch -> exactly one solve (newly visible context)", d2.get("solves", 0) == 1, d2)
        res.check("P12: newly visible pair tiled without overlap (oracle)", len(shown) == 2 and not tiling_errors([f2[k] for k in shown], area, GAP),
                  [f2[k]["frame"] for k in shown])
        res.check("P12: the other 6 windows unchanged by the switch (oracle)", all(f2[k]["frame"] == f1[k]["frame"] for k in others),
                  [k for k in others if f2[k]["frame"] != f1[k]["frame"]])
        res.check("P12: errors == 0", c4["counters"]["errors"] == 0, c4["counters"]["errors"])
        res.data["p12"] = {"ratio20": lat, "commandDelta": d, "switchDelta": d2, "desktops": nd}
        print(f"  ratio x20 {us(lat['dispatchToReturnNs'])}; command delta {d}; switch delta {d2}", flush=True)


# ------------------------------------------------------------------------------------ P13

def rules_doc(n: int) -> str:
    rules = []
    for i in range(n):
        match = {"appId": {"glob": f"org.example.app{i}-*"}} if i % 2 else {"appId": {"exact": f"org.example.app{i}"}}
        rules.append({"id": f"r{i}", "match": match, "actions": {"mode": "tiled" if i % 3 else "floating"}})
    return json.dumps({"schemaVersion": 1, "rules": rules}, separators=(",", ":"))


def set_config_json(s: Session, doc: str | None) -> None:
    rc = s.kw.root / "config/kwinrc"
    lines = [ln for ln in rc.read_text().splitlines() if not ln.startswith("configJson=")]
    if doc is not None:
        i = lines.index("[Script-plastile]") + 1
        lines.insert(i, "configJson=" + doc)
    rc.write_text("\n".join(lines) + "\n")


MARK = re.compile(r"plastile-measure (configChanged|configuration) (\d+)")


def activate(s: Session, doc: str | None) -> dict:
    """Write configJson, call org.kde.KWin /KWin reconfigure, wait for the activation.

    Coarse: KWin log timestamp of the `configuration activated` line minus the Python
    CLOCK_MONOTONIC before the D-Bus call (includes KWin's own 200 ms reconfigure timer,
    kwin v6.7.5 src/workspace.cpp:998-1001, a coarse QTimer).
    Fine: CLOCK_MONOTONIC markers from the measurement root around Plastile's handler
    (Options.configChanged emitted -> activation logged: readConfig, validate, compile,
    engine.configure).
    """
    set_config_json(s, doc)
    c0 = s.counters()
    off = s.kw.mark()
    t0 = time.monotonic_ns()
    s.kw.call("/KWin", "org.kde.KWin", "reconfigure")
    t1 = time.monotonic_ns()
    lines = s.kw.wait_log(r"plastile info configuration activated", 20, off)
    s.kw.wait_log(r"plastile-measure configuration ", 5, off)
    ts = log_ts_ns(lines[0])
    marks = [MARK.search(ln).groups() for ln in s.log_lines(r"plastile-measure ", off)]
    t_act = next(int(v) for k, v in marks if k == "configuration")
    changed = [int(v) for k, v in marks if k == "configChanged" and int(v) <= t_act]
    c1 = s.settle()
    return {"jsonChars": len(doc) if doc else 0, "reconfigureToActivatedMs": (ts - t0) / 1e6 if ts else None,
            "reconfigureCallMs": (t1 - t0) / 1e6,
            "reconfigureToConfigChangedMs": (changed[-1] - t0) / 1e6 if changed else None,
            "configChangedToActivatedMs": (t_act - changed[-1]) / 1e6 if changed else None,
            "configChangedSignals": len(changed),
            "rejected": bool(s.log_lines(r"configuration rejected", off)),
            "warnings": len(s.log_lines(r"plastile warn", off)), "activationDelta": delta(c0, c1), "line": lines[0].split("plastile ", 1)[1]}


def reject_over_cap(res: Results, s: Session, n: int = 1000) -> dict:
    """PERFORMANCE P13 names 1000 rules; the schema caps rules at 256 (src/config/validate.ts
    MAX_RULES). Over the cap the document must be rejected and the previous revision kept."""
    doc = rules_doc(n)
    set_config_json(s, doc)
    c0 = s.counters()
    off = s.kw.mark()
    t0 = time.monotonic_ns()
    s.kw.call("/KWin", "org.kde.KWin", "reconfigure")
    s.kw.wait_log(r"plastile-measure configuration ", 20, off)
    marks = [MARK.search(ln).groups() for ln in s.log_lines(r"plastile-measure ", off)]
    t_end = next(int(v) for k, v in marks if k == "configuration")
    changed = [int(v) for k, v in marks if k == "configChanged" and int(v) <= t_end]
    c1 = s.settle()
    rejected = s.log_lines(r"plastile error configuration rejected", off)
    activated = s.log_lines(r"plastile info configuration activated", off)
    res.check(f"P13: {n} rules rejected (cap 256), previous revision kept, nothing written",
              bool(rejected) and not activated and delta(c0, c1).get("writes", 0) == 0,
              {"rejected": [ln.split("rejected", 1)[1][:200] for ln in rejected], "activated": len(activated), "delta": delta(c0, c1)})
    return {"rules": n, "jsonChars": len(doc), "rejected": bool(rejected),
            "configChangedToRejectedMs": (t_end - changed[-1]) / 1e6 if changed else None,
            "reconfigureToConfigChangedMs": (changed[-1] - t0) / 1e6 if changed else None, "delta": delta(c0, c1)}


def rule_control(res: Results, s: Session, area: dict, n_tiled: int) -> dict:
    """Positive control with 256 rules active: the last rule (glob -> floating) and a tiled
    glob rule must both match real windows, judged by the oracle."""
    before = s.frames()
    c0 = s.counters()
    s.spawn(901, "--app-id", "org.example.app255-control", wait=False)
    s.spawn(902, "--app-id", "org.example.app1-control", wait=False)
    s.wait_for(lambda: len(s.kw.fixtures("org.example.app255-control")) == 1 and
               len(s.kw.fixtures("org.example.app1-control")) == 1, 10, "control windows")
    c1 = s.settle()
    fl = s.kw.fixtures("org.example.app255-control")[0]
    ti = s.kw.fixtures("org.example.app1-control")[0]
    tiled = s.frames_list() + [ti]
    errs = tiling_errors(tiled, area, GAP)
    fl_overlaps = [f["caption"] for f in tiled if overlaps(f["frame"], fl["frame"])]
    explain_off = s.kw.mark()
    s.act(fl["caption"], "workspace.activeWindow = w")
    s.cmd("inspect.explain-window")
    expl = s.kw.wait_log(r"plastile info explain", 5, explain_off)[-1].split("explain", 1)[1]
    res.check("P13 control: rule 255 (glob, floating) matched (explain: r255, mode floating)",
              '"r255"' in expl and '"mode":"floating"' in expl, expl[:300])
    res.check("P13 control: floating window kept its own 400x300 client size (oracle)",
              abs(fl["client"]["width"] - 400) <= 0.5 and abs(fl["client"]["height"] - 300) <= 0.5, fl["client"])
    res.check(f"P13 control: rule 1 (glob, tiled) window tiled with the other {n_tiled} (oracle, no overlap)", not errs, errs[:5])
    res.check("P13 control: floating window overlaps tiles (not placed in the layout)", bool(fl_overlaps), fl["frame"])
    s.kill(901, wait=False)
    s.kill(902, wait=False)
    s.wait_for(lambda: not s.kw.fixtures("org.example.app255-control") and not s.kw.fixtures("org.example.app1-control"), 10,
               "control windows closed")
    c2 = s.settle()
    after = s.frames()
    res.check("P13 control: the original windows return to their frames after the controls close (oracle)",
              all(near(after[k]["frame"], before[k]["frame"], 1.0) for k in before), {k: after[k]["frame"] for k in after})
    return {"openDelta": delta(c0, c1), "closeDelta": delta(c1, c2), "floatingFrame": fl["frame"], "explain": expl.strip()[:400]}


def p13(res: Results, out: Path, rng: random.Random, samples=100) -> None:
    print("P13", flush=True)
    with session(out / "p13", 9) as s:
        for i in range(1, 9):
            s.spawn(i, wait=False)
        s.wait_for(lambda: len(s.frames_list()) == 8, 20, "8 windows")
        s.load()
        s.settle()
        area = s.area()
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        lat = {}
        lat["none"], _ = ratio_run(s, samples, rng)
        acts = {}
        for n in (10, 100, 256):
            acts[str(n)] = a = activate(s, rules_doc(n))
            res.check(f"P13: {n} rules activated without rejection", not a["rejected"] and a["reconfigureToActivatedMs"] is not None, a)
            res.check(f"P13: {n} rules: activation writes nothing (no window matches)", a["activationDelta"].get("writes", 0) == 0, a["activationDelta"])
            print(f"  {n} rules ({a['jsonChars']} chars): reconfigure -> activated {a['reconfigureToActivatedMs']:.1f} ms "
                  f"(coarse, log clock; busctl call {a['reconfigureCallMs']:.1f} ms); reconfigure -> configChanged "
                  f"{a['reconfigureToConfigChangedMs']:.1f} ms; configChanged -> activated {a['configChangedToActivatedMs']:.3f} ms "
                  f"{a['activationDelta']}", flush=True)
        lat["rules256"], _ = ratio_run(s, samples, rng)
        control = rule_control(res, s, area, 8)
        acts["1000-over-cap"] = reject_over_cap(res, s)
        print(f"  1000 rules: rejected={acts['1000-over-cap']['rejected']}, configChanged -> rejected "
              f"{acts['1000-over-cap']['configChangedToRejectedMs']} ms", flush=True)
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        acts["none-again"] = activate(s, None)
        lat["none-after"], _ = ratio_run(s, samples, rng)
        c = s.settle()
        res.check("P13: tiled without overlap after all activations", not tiling_errors(s.frames_list(), area, GAP))
        res.check("P13: errors == 0", c["counters"]["errors"] == 0, c["counters"]["errors"])
        base = min(lat["none"]["dispatchToReturnNs"]["p50"], lat["none-after"]["dispatchToReturnNs"]["p50"])
        ratio = lat["rules256"]["dispatchToReturnNs"]["p50"] / base
        res.check("P13: ratio-command p50 with 256 rules within 1.5x of no rules (coarse, shared machine)", ratio <= 1.5,
                  {k: v["dispatchToReturnNs"] for k, v in lat.items()})
        res.data["p13"] = {"activation": acts, "latency": lat, "ruleControl": control, "p50RatioRules256OverNone": ratio, "windows": 8, "samplesPerRun": samples}
        for k, v in lat.items():
            print(f"  ratio x{samples} {k}: {us(v['dispatchToReturnNs'])}", flush=True)


# -------------------------------------------------------------------------- instrumentation

def instrumentation(res: Results, out: Path, rng: random.Random, samples=200, n=16, order=("off", "debug")) -> None:
    table = {"order": list(order)}
    for level in order:
        print(f"instrumentation diagnostics={level}", flush=True)
        with session(out / f"instr-{level}", n, config={"diagnostics": level}) as s:
            for i in range(1, n + 1):
                s.spawn(i, wait=False)
            s.wait_for(lambda: len(s.frames_list()) == n, 30, f"{n} windows")
            if level == "off":
                load_quiet(s)
            else:
                s.load()
            s.settle(timeout=10)
            s.act("plastile-fixture 1", "workspace.activeWindow = w")
            off = s.kw.mark()
            lat, _ = ratio_run(s, samples, rng)
            c = s.settle()
            lines = len(s.log_lines(r"plastile ", off))
            res.check(f"instr {level}: {samples} accepted commands, errors == 0",
                      lat["accepted"] == samples and c["counters"]["errors"] == 0, {"accepted": lat["accepted"], "errors": c["counters"]["errors"]})
            res.check(f"instr {level}: tiled without overlap", not tiling_errors(s.frames_list(), s.area(), GAP))
            table[level] = {"windows": n, "ratio": lat, "plastileLogLinesDuringRun": lines, "counters": c["counters"]}
            print(f"  {level}: {us(lat['dispatchToReturnNs'])}; solve {us(lat['solveNs'])}; apply {us(lat['applyNs'])}; log lines {lines}", flush=True)
            if level == "off":
                unload_quiet(s)
    off_, dbg = table["off"]["ratio"]["dispatchToReturnNs"], table["debug"]["ratio"]["dispatchToReturnNs"]
    table["debugOverOff"] = {k: dbg[k] / off_[k] for k in ("p50", "p95", "p99")}
    res.data["instrumentation"] = table


# ------------------------------------------------------------------------- root teardown

def teardown(res: Results, out: Path, cycles: int = 3) -> None:
    """The measurement root's own Options.configChanged marker must not outlive unload
    (plain connections to KWin objects survive script unload: API_PROFILE lifetime facts)."""
    print("teardown (measurement root)", flush=True)
    rows = []
    with session(out / "teardown", 1) as s:
        s.spawn(1)
        for _ in range(cycles):
            s.load()
            s.settle()
            off = s.kw.mark()
            s.kw.call("/KWin", "org.kde.KWin", "reconfigure")
            time.sleep(0.6)  # KWin's reconfigure timer is 200 ms
            loaded = len(s.log_lines(r"plastile-measure configChanged", off))
            s.unload()
            off = s.kw.mark()
            s.kw.call("/KWin", "org.kde.KWin", "reconfigure")
            time.sleep(0.6)
            rows.append({"markersLoaded": loaded, "markersAfterUnload": len(s.log_lines(r"plastile-measure configChanged", off)),
                         "scriptErrors": len(s.log_lines(r"TypeError|ReferenceError|plastile error", off))})
    res.check(f"teardown: {cycles} load/unload cycles, one marker per reconfigure while loaded, none after unload",
              all(r["markersLoaded"] == 1 and r["markersAfterUnload"] == 0 and r["scriptErrors"] == 0 for r in rows), rows)
    res.data["teardown"] = rows


# ------------------------------------------------------------------------------------ main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="p05,p07,p12,p13,instr,teardown")
    ap.add_argument("--samples", type=int, default=200)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--counts", default="4,8,16,32")
    ap.add_argument("--instr-order", default="off,debug", help="session order for the instrumentation comparison")
    ap.add_argument("--out", type=Path, default=None, help="artifact directory (default artifacts/perf/workloads/<stamp>)")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = args.out or ROOT / "artifacts/perf/workloads" / stamp
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(HERE))
    import perfcommon
    meta = perfcommon.git_meta()
    rev = meta["implementationCommit"]
    machine0 = perfcommon.machine_state()
    kwin = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
    load1 = Path("/proc/loadavg").read_text().split()[0]
    res = Results()
    rng = random.Random(args.seed)
    only = set(args.only.split(","))
    failures = []
    for name, fn in (("p05", lambda: p05(res, out, [int(x) for x in args.counts.split(",")])),
                     ("p07", lambda: p07(res, out)),
                     ("p12", lambda: p12(res, out, rng)),
                     ("p13", lambda: p13(res, out, rng)),
                     ("instr", lambda: instrumentation(res, out, rng, args.samples, order=tuple(args.instr_order.split(",")))),
                     ("teardown", lambda: teardown(res, out))):
        if name not in only:
            continue
        try:
            fn()
        except Exception as exc:  # a crash is a failure, recorded and reported
            import traceback
            failures.append({name: "".join(traceback.format_exception(exc))[-1500:]})
            res.check(f"{name}: completed without exception", False, str(exc)[-300:])
    load2 = Path("/proc/loadavg").read_text().split()[0]
    summary = {
        "implementationCommit": rev, "implementationDirty": meta["implementationDirty"], "kwin": kwin,
        "versions": perfcommon.versions(), "args": {k: str(v) for k, v in vars(args).items() if k != "out"},
        "layer": "nested KWin virtual backend (not physical)",
        "loadAvg1mStartEnd": [float(load1), float(load2)], "machineStart": machine0, "machineEnd": perfcommon.machine_state(),
        "clock": "CLOCK_MONOTONIC via the measurement module inside QV4; fixture t_ns and Python monotonic_ns are the same clock;"
                 " KWin log timestamps (%{time boot}) are ms-resolution and calibrated in logClockMinusMonotonicMs",
        "dispatchToReturnNs": "command handler entry -> return after the last frame request was issued (not presentation)",
        "seed": args.seed, "samples": args.samples,
        "checks": res.checks, "exceptions": failures, **res.data,
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    passed = sum(1 for v in res.checks.values() if v["pass"])
    print(f"{passed}/{len(res.checks)} checks passed -> {out / 'summary.json'}")
    return 0 if passed == len(res.checks) and not failures else 1


if __name__ == "__main__":
    sys.exit(main())
