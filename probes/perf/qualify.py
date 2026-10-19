#!/usr/bin/env python3
"""G2 P03 qualification unit (PERFORMANCE §4-§6): one disposable nested KWin per invocation.

One unit = one window count n, one instrumentation mode, one run index. The campaign
(probes/perf/campaign.py) shuffles the units of every probe; this file runs one of them.

Session: master/stack with n tiled fixtures on the current desktop of one virtual output (tall
enough that n - 1 stacked minimum frames fit, workloads.stack_output_height) and `--inactive`
further desktops with two fixtures each (inactive contexts present, the §4 reference load).
The measurement-only root (probes/perf/main.qml) is the production root plus the test clock.

Workloads (commands through kglobalaccel invokeShortcut, the D-Bus command API, not input):
  ratio   resize.grow / resize.shrink alternating on the active window   expected writes: n
  swap    swap.next                                                      expected writes: 2
  master  master.increase / master.decrease alternating                  expected writes: n
  focus   focus.next                                  focus-only gate:   0 writes, 0 solves
  noop    context.reset / layout.master-stack alternating on an unchanged plan
                                                      no-op gate:        0 writes
Blocks of `--block` commands, seeded shuffle across workloads (interleaved), 15-30 ms
seeded pauses. Warm-up (declared here, before any data): one block of `--warmup` commands
per workload, first, in its own shuffled order; recorded with warmup=true, never pooled.

Modes:
  uninstrumented  kwinrc measureInstrumented=false: the bundle runs as in production (no
                  clockNs, no per-command log line); only the root's outer span is taken
                  (handler entry -> dispatch() returned, after every frame request: t1 -> t4).
  instrumented    the bundle's own spans as well (dispatchToReturnNs, solveNs, applyNs, writes)
                  and one `plastile perf` log line per command, printed inside the outer span.
  The outer span is identical in both, so outer(instrumented) - outer(uninstrumented) is the
  observer overhead.

Diagnostic modes (--diag, never pooled with the above):
  gc      the QV4 garbage collector's own log (qt.qml.gc.*: incremental GC state transitions and
          step timings): instrumented, it attributes tails to collections inside a handler;
          uninstrumented, it gives the collection rate of the production path (no perf lines)
  gcstats only qt.qml.gc.allocatorStats: one block of lines per collection (its duration, heap
          before/after), not one line per incremental step, so it perturbs each cycle less than `gc`
  frames instrumented + a passive KWin script counting frameGeometryChanged per window, to check
          one geometry request per changed window against KWin's own observation

Client-side stages come from the fixtures' own logs (same CLOCK_MONOTONIC): first/last xdg
configure received, last commit answering a configure, its wp_presentation time on the
virtual backend's software timeline (not physical scanout).

Usage: python3 probes/perf/qualify.py --n 32 --mode uninstrumented --run 0 [--seed 1]
           [--samples 1000] [--noop-samples 200] [--warmup 20] [--block 100] [--inactive 3]
           [--diag gc|gcstats|frames] [--qml ROOT] [--out DIR]
Writes DIR/{unit.json,samples.jsonl} (raw, local; artifacts/ is never committed).
"""
from __future__ import annotations

import argparse
import bisect
import json
import random
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tests/integration"))
sys.path.insert(0, str(HERE))
from harness import PLUGIN, Listener, Session, delta, tiling_errors, trace  # noqa: E402
from workloads import GAP, load_quiet, log_ts_ns, measure_env, stack_feasibility, stack_output_height  # noqa: E402
import perfcommon as common  # noqa: E402

PERF = re.compile(r"plastile perf (\{.*\})$")
OUTER = re.compile(r"plastile-measure outer (\[.*\])$")
CALIB = re.compile(r"plastile-measure calibrate (\{.*\})$")
BAD = r"plastile (error|warn)|TypeError|ReferenceError"
WORKLOADS = {
    "ratio": lambda k: "plastile.resize.grow" if k % 2 == 0 else "plastile.resize.shrink",
    "swap": lambda k: "plastile.swap.next",
    "master": lambda k: "plastile.master.increase" if k % 2 == 0 else "plastile.master.decrease",
    "focus": lambda k: "plastile.focus.next",
    "noop": lambda k: "plastile.context.reset" if k % 2 == 0 else "plastile.layout.master-stack",
}
PAUSE_S = (0.015, 0.030)
WINDOW_CAP_NS = 50_000_000  # client events later than 50 ms after a command are not attributed to it


def expected_writes(wl: str, n: int) -> int:
    return {"ratio": n, "swap": 2, "master": n, "focus": 0, "noop": 0}[wl]


def unit_seed(base: int, n: int, mode: str, run: int) -> int:
    return base * 1_000_000 + n * 1000 + run * 10 + {"uninstrumented": 0, "instrumented": 1}.get(mode, 2)


# ------------------------------------------------------------------ fixture logs
class ClientLog:
    """Configure/commit/presented records of every fixture main window, sorted by t_ns."""

    def __init__(self, logs: dict[int, Path]):
        cfg, com, self.presented = [], [], {}
        for ident, path in logs.items():
            prev = None
            pres = {}
            commits = []
            for ln in path.read_text(errors="replace").splitlines():
                try:
                    e = json.loads(ln)
                except ValueError:
                    continue
                if e.get("win", "main") != "main":
                    continue
                ev = e.get("ev")
                if ev == "configure":
                    size = (e.get("width"), e.get("height"))
                    sized = prev is not None and size != (0, 0) and size != prev
                    if size != (0, 0):
                        prev = size
                    cfg.append((e["t_ns"], ident, sized))
                elif ev == "commit" and e.get("reason") == "configure":
                    commits.append((e["t_ns"], ident, e["seq"]))
                elif ev == "presented":
                    pres[e["seq"]] = e["present_ns"]
            for t, i, seq in commits:
                com.append((t, i, pres.get(seq)))
        cfg.sort()
        com.sort()
        self.cfg, self.com = cfg, com
        self.cfg_t = [c[0] for c in cfg]
        self.com_t = [c[0] for c in com]

    def window(self, t0: int, t1: int) -> dict:
        a, b = bisect.bisect_left(self.cfg_t, t0), bisect.bisect_left(self.cfg_t, t1)
        cfgs = self.cfg[a:b]
        a, b = bisect.bisect_left(self.com_t, t0), bisect.bisect_left(self.com_t, t1)
        coms = self.com[a:b]
        pres = [p for _, _, p in coms if p is not None]
        return {"configureCount": len(cfgs), "sizeConfigureCount": sum(1 for c in cfgs if c[2]),
                "configuredWindows": len({c[1] for c in cfgs}),
                "firstConfigureNs": cfgs[0][0] if cfgs else None, "lastConfigureNs": cfgs[-1][0] if cfgs else None,
                "lastCommitNs": coms[-1][0] if coms else None, "commits": len(coms),
                "virtualPresentedNs": max(pres) if pres and len(pres) == len(coms) else None}


# ------------------------------------------------------------------- session
def setup(s: Session, n: int, inactive: int) -> dict:
    for i in range(1, n + 1):
        s.spawn(i, wait=False)
    extra = [100 + j for j in range(2 * inactive)]
    for i in extra:
        s.spawn(i, wait=False)
    s.wait_for(lambda: len(s.frames_list()) == n + len(extra), 60, f"{n + len(extra)} windows")
    if inactive:
        nd = json.loads(s.js(f"for (let i = 0; i < {inactive}; ++i) workspace.createDesktop(workspace.desktops.length, 'D' + (i + 2));"
                             " emit(workspace.desktops.length);")[0])
        assert nd == inactive + 1, nd
        for j, i in enumerate(extra):
            s.act(f"plastile-fixture {i}", f"w.desktops = [workspace.desktops[{1 + j // 2}]]")
    load_quiet(s)
    c = s.settle(timeout=20)
    area = s.area()
    cur = json.loads(s.js("emit(String(workspace.currentDesktop.id))")[0])
    frames = s.frames_list()
    visible = [f for f in frames if cur in f["desktops"]]
    feas = stack_feasibility(s, n, area)
    return {"counters": c, "area": area, "visible": len(visible), "hidden": len(frames) - len(visible),
            "feasibility": feas, "tilingErrors": tiling_errors(visible, area, GAP), "desktop": cur,
            "inactiveContexts": inactive, "windowsInModel": c["windows"]}


def visible_errors(s: Session, desktop: str, area: dict) -> tuple[list[str], int]:
    frames = [f for f in s.frames_list() if desktop in f["desktops"]]
    return tiling_errors(frames, area, GAP), len(frames)


def run_block(s: Session, wl: str, count: int, pause: random.Random, instrumented: bool, desktop: str,
              area: dict) -> tuple[dict, list[dict]]:
    c0 = s.counters()
    off = s.kw.mark()
    sends = []
    for k in range(count):
        cmd = WORKLOADS[wl](k)
        sends.append((cmd, s.cmd(cmd)))
        time.sleep(pause.uniform(*PAUSE_S))
    c1 = s.settle(timeout=10)
    off2 = s.kw.mark()
    s.kw.invoke_shortcut("plastile-measure-dump")
    s.kw.wait_log(r"plastile-measure outer-end ", 10, off2)
    outer = []
    for ln in s.log_lines(r"plastile-measure outer \[", off2):
        outer += json.loads(OUTER.search(ln).group(1))
    outer = [o for o in outer if not o[0].startswith("plastile.inspect.")]
    perf = []
    if instrumented:
        for ln in s.log_lines(r"plastile perf ", off):
            r = json.loads(PERF.search(ln).group(1))
            r["logNs"] = log_ts_ns(ln)
            perf.append(r)
    errs, nvis = visible_errors(s, desktop, area)
    d = delta(c0, c1)
    recs = []
    for k, (cmd, t_send) in enumerate(sends):
        o = outer[k] if k < len(outer) else None
        p = perf[k] if k < len(perf) else None
        recs.append({"cmd": cmd, "sendNs": t_send, "outer": o, "perf": p})
    block = {"workload": wl, "commands": count, "outerRecords": len(outer), "perfRecords": len(perf),
             "countersDelta": d, "outstandingAfter": c1["outstanding"], "tilingErrorsAfter": errs, "visibleAfter": nvis,
             "outerIdsMatch": all(r["outer"] is not None and r["outer"][0] == r["cmd"] for r in recs)}
    if d.get("corrections"):
        # Unmeasured (after the block): Plastile's own trace around each correction, for attribution.
        tr = trace(s)
        hits = [i for i, t in enumerate(tr) if t["kind"] in ("stale", "partial", "diverged", "deadline") or
                (t["kind"] == "write" and (t.get("data") or {}).get("reason") == "correction")]
        block["correctionTrace"] = [tr[max(0, i - 12):i + 4] for i in hits[:6]]
    return block, recs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, required=True)
    ap.add_argument("--mode", choices=("uninstrumented", "instrumented"), required=True)
    ap.add_argument("--run", type=int, default=0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--samples", type=int, default=1000, help="measured commands per workload (ratio/swap/master/focus)")
    ap.add_argument("--noop-samples", type=int, default=200)
    ap.add_argument("--warmup", type=int, default=20, help="warm-up commands per workload (declared, never pooled)")
    ap.add_argument("--block", type=int, default=100)
    ap.add_argument("--inactive", type=int, default=3, help="inactive desktops with 2 fixtures each")
    ap.add_argument("--workloads", default="ratio,swap,master,focus,noop")
    ap.add_argument("--diag", choices=("gc", "gcstats", "frames"), default=None)
    ap.add_argument("--qml", type=Path, default=HERE / "main.qml",
                    help="measurement root (default this tree's; probes/perf/ab_bundles.py builds roots for other commits' bundles)")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    if args.diag == "frames" and args.mode != "instrumented":
        sys.exit("--diag frames needs --mode instrumented")
    n, instrumented = args.n, args.mode == "instrumented"
    seed = unit_seed(args.seed, n, args.mode + ("-" + args.diag if args.diag else ""), args.run)
    order_rng, pause_rng = random.Random(seed), random.Random(seed + 1)
    out = args.out or ROOT / "artifacts/perf/qualify" / f"{time.strftime('%Y%m%dT%H%M%S')}-n{n}-{args.mode}-r{args.run}"
    out.mkdir(parents=True, exist_ok=True)
    unit: dict = {"probe": "P03-qualify", **common.git_meta(), "versions": common.versions(), "machineStart": common.machine_state(),
                  "layer": "nested KWin virtual backend (not physical); kglobalaccel D-Bus command API, not input",
                  "n": n, "mode": args.mode, "diag": args.diag, "run": args.run, "baseSeed": args.seed, "unitSeed": seed,
                  "params": {"samples": args.samples, "noopSamples": args.noop_samples, "warmup": args.warmup, "block": args.block,
                             "inactiveDesktops": args.inactive, "pauseS": PAUSE_S, "fixture": "plastile-fixture --ssd (400x300, no delay)",
                             "outputWidth": 1920, "outputHeight": stack_output_height(n), "diagnostics": "warn",
                             "workloads": args.workloads}}
    wls = args.workloads.split(",")
    plan = [(wl, args.warmup, True) for wl in order_rng.sample(wls, len(wls))]
    measured = []
    for wl in wls:
        total = args.noop_samples if wl == "noop" else args.samples
        measured += [(wl, min(args.block, total - b), False) for b in range(0, total, args.block)]
    order_rng.shuffle(measured)
    plan += measured
    unit["blockOrder"] = [f"{wl}{'-warmup' if w else ''}" for wl, _, w in plan]
    config = {"diagnostics": "warn", "measureInstrumented": "true" if instrumented else "false"}
    env = measure_env()
    if args.diag == "gc":
        env["QT_LOGGING_RULES"] = "js=true;qml=true;kwin_scripting=true;qt.qml.gc.*=true"
    elif args.diag == "gcstats":
        env["QT_LOGGING_RULES"] = "js=true;qml=true;kwin_scripting=true;qt.qml.gc.allocatorStats=true"
    qml = args.qml.resolve()
    unit["root"] = {"qml": str(qml.relative_to(ROOT)) if qml.is_relative_to(ROOT) else "outside the tree",
                    "bundleSha256": common.sha256(qml.parent.parent.parent / "package/contents/code/plastile.mjs")}
    blocks, samples = [], []
    t_unit = time.monotonic()
    with Session(out / "session", width=1920, height=stack_output_height(n), extra_env=env, qml=qml,
                 config=config) as s:
        st = setup(s, n, args.inactive)
        unit["setup"] = {k: v for k, v in st.items() if k != "counters"} | {"counters": st["counters"]["counters"]}
        ok_setup = (st["visible"] == n and not st["tilingErrors"] and st["feasibility"]["feasible"]
                    and st["counters"]["counters"]["overflow"] == 0)
        unit["setupOk"] = ok_setup
        off = s.kw.mark()
        s.kw.invoke_shortcut("plastile-measure-calibrate")
        unit["calibration"] = json.loads(CALIB.search(s.kw.wait_log(r"plastile-measure calibrate ", 10, off)[-1]).group(1))
        instr_line = s.log_lines(r"plastile-measure instrumented ")
        unit["instrumentedReported"] = instr_line[-1].rsplit(" ", 1)[1] if instr_line else None
        listener = Listener(s, frames=tuple(f"plastile-fixture {i}" for i in range(1, n + 1))) if args.diag == "frames" else None
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        s.settle()
        log_off = s.kw.mark()
        for b, (wl, count, warm) in enumerate(plan):
            blk, recs = run_block(s, wl, count, pause_rng, instrumented, st["desktop"], st["area"])
            blk.update(block=b, warmup=warm)
            blocks.append(blk)
            for k, r in enumerate(recs):
                r.update(workload=wl, block=b, k=k, warmup=warm)
            samples += recs
            print(f"  block {b:2d} {wl:6s}{' (warm-up)' if warm else ''} x{count}: {blk['countersDelta']} "
                  f"errs={len(blk['tilingErrorsAfter'])} outer={blk['outerRecords']}", flush=True)
        unit["diagLog"] = None
        if args.diag:
            # Raw log lines kept for attribution (local artifact): GC statistics or frame changes, and the perf lines.
            pat = r"qt\.qml\.gc|plastile perf " if args.diag in ("gc", "gcstats") else r"PLT-L frame |plastile perf "
            lines = s.log_lines(pat, log_off)
            (out / "diag.log").write_text("\n".join(lines) + "\n")
            unit["diagLog"] = {"lines": len(lines)}
        if listener:
            listener.close()
        final = s.settle()
        unit["final"] = {"counters": final["counters"], "outstanding": final["outstanding"], "connections": final["connections"],
                         "windows": final["windows"]}
        unit["badLines"] = s.log_lines(BAD)[:10]
        # Teardown: unload, then the script must be gone and the runtime must have stopped its work.
        s.kw.unload(PLUGIN)
        s.loaded = False
        time.sleep(0.3)
        unit["teardown"] = {"isScriptLoadedAfter": s.kw.is_loaded(PLUGIN),
                            "shortcutNamesAfter": sum(1 for x in s.kw.shortcut_names() if x.startswith("plastile."))}
        logs = {i: f.log for i, f in s.fixtures.items()}
    client = ClientLog(logs)  # after the session: the fixtures have flushed and exited
    unit["seconds"] = round(time.monotonic() - t_unit, 1)
    # Per-sample records (PERFORMANCE §8 fields plus the stage durations).
    res = int(unit["calibration"].get("resolutionNs") or 1)
    env_id = "nested-virtual-kwin-" + (unit["versions"]["kwin"] or "?").split()[-1]
    run_id = f"P03-n{n}-{args.mode}{'-' + args.diag if args.diag else ''}-r{args.run}"
    by_block: dict[int, list[dict]] = {}
    for r in samples:
        by_block.setdefault(r["block"], []).append(r)
    rows = []
    for b, recs in by_block.items():
        for i, r in enumerate(recs):
            o, p = r["outer"], r["perf"]
            t0 = o[1] if o else None
            nxt = recs[i + 1]["outer"][1] if i + 1 < len(recs) and recs[i + 1]["outer"] else (t0 + WINDOW_CAP_NS if t0 else None)
            cw = client.window(int(t0), int(min(nxt, t0 + WINDOW_CAP_NS))) if t0 else {}
            exp = expected_writes(r["workload"], n)
            timing = (p or {}).get("timing") or {}
            # Frame requests issued by this command's solve (engine counter delta inside solveAndApply);
            # a command that did not solve issued none. Uninstrumented runs have block totals only.
            writes = (timing.get("writes", 0) if timing else 0) if p else None
            status = p["status"] if p else None
            fail = None
            if o is None or o[0] != r["cmd"]:
                fail = "no outer span for this command"
            elif p is not None and status not in ("accepted", "noop"):
                fail = f"status {status}"
            elif writes is not None and writes != exp:
                fail = f"writes {writes} != expected {exp}"
            rows.append({
                "runId": run_id, "implementationCommit": unit["implementationCommit"], "environmentId": env_id,
                "workload": f"P03-{r['workload']}", "sample": len(rows), "contextCount": 1 + args.inactive,
                "affectedWindowCount": n, "clock": "CLOCK_MONOTONIC (Plastile.Measure in QV4; fixture logs same clock)",
                "clockResolutionNs": res, "dispatchNs": t0, "solveEndNs": None,
                "lastRequestNs": (t0 + o[2]) if o else None, "observedNs": None, "presentedNs": None,
                "presentationUnavailableReason": "nested virtual backend: no physical output (virtualPresentedNs is the software timeline)",
                "solves": (1 if timing else 0) if p else None, "geometryWrites": writes, "nativeMutations": None,
                "configureCount": cw.get("configureCount"), "correctiveWrites": None,
                "success": fail is None, "failureReason": fail,
                # extras
                "mode": args.mode, "diag": args.diag, "n": n, "run": args.run, "block": b, "k": r["k"], "warmup": r["warmup"],
                "cmd": r["cmd"], "sendNs": r["sendNs"], "outerNs": o[2] if o else None,
                "innerNs": p["dispatchToReturnNs"] if p else None, "innerEntryNs": p["entryNs"] if p else None,
                "solveNs": timing.get("solveNs"), "applyNs": timing.get("applyNs"), "activateNs": (p or {}).get("activateNs"),
                "logNs": (p or {}).get("logNs"), "expectedWrites": exp,
                "sizeConfigureCount": cw.get("sizeConfigureCount"), "configuredWindows": cw.get("configuredWindows"),
                "firstConfigureNs": cw.get("firstConfigureNs"), "lastConfigureNs": cw.get("lastConfigureNs"),
                "lastCommitNs": cw.get("lastCommitNs"), "virtualPresentedNs": cw.get("virtualPresentedNs"),
            })
    with open(out / "samples.jsonl", "w") as f:
        for row in rows:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")
    unit["blocks"] = blocks
    unit["machineEnd"] = common.machine_state()
    unit["sampleCount"] = len(rows)
    unit["failures"] = sum(1 for r in rows if not r["success"])
    # Corrections are allowed only as the ledger's explained E04 case (a late commit of an older target
    # after KWin dropped the newer configure: counters.stale), and are reported (PERFORMANCE §4).
    block_ok = all(b["outerIdsMatch"] and not b["tilingErrorsAfter"] and b["outstandingAfter"] == 0
                   and b["countersDelta"].get("corrections", 0) <= b["countersDelta"].get("stale", 0)
                   and b["countersDelta"].get("errors", 0) == 0 for b in blocks)
    unit["corrections"] = {k: sum(b["countersDelta"].get(k, 0) for b in blocks if not b["warmup"])
                           for k in ("corrections", "stale", "superseded", "partial", "deadlines", "diverged")}
    unit["pass"] = bool(ok_setup and block_ok and unit["failures"] == 0 and not unit["badLines"]
                        and not unit["teardown"]["isScriptLoadedAfter"])
    common.write_json(out / "unit.json", unit)
    meas = [r for r in rows if not r["warmup"] and r["outerNs"] is not None]
    for wl in wls:
        xs = [r["outerNs"] for r in meas if r["workload"] == f"P03-{wl}"]
        st_ = common.stats(xs)
        if st_:
            print(f"n={n} {args.mode} {wl}: outer p50/p95/max {st_['p50']/1e3:.0f}/{st_['p95']/1e3:.0f}/{st_['max']/1e3:.0f} us (n={st_['n']})")
    print(f"unit pass={unit['pass']} failures={unit['failures']} seconds={unit['seconds']} -> {out}")
    return 0 if unit["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
