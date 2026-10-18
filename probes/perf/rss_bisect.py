#!/usr/bin/env python3
"""Where does KWin's anonymous RSS growth in P14 come from? (T34, nested KWin only)

P14 (churn.py) shows KWin's RssAnon rising by about 25 KiB per reload cycle with Plastile and about
0 with the empty script. Each cycle there does several things; this probe separates them, every
variant in its own disposable nested KWin with four idle fixtures, RssAnon after every cycle:

  reload    bare load/unload cycles of root variants: empty, shortcuts (the 68 ShortcutHandlers),
            runtime (runtime + deadline Timer), runtime-persist (+ the persistence store), production
            (package/contents/ui/main.qml); `--oracles N` adds N one-shot oracle scripts per cycle
  cycle     P14-shaped cycles of the production root with one part switched on at a time:
            openclose (a 5th window opened and closed while loaded), cmd (a ratio command before
            unload), delayed (+ a client that answers configures 200 ms late), counters (inspect.counters
            and settle() as P14 does), noreload (the command without the reload), nohelper (no
            persistence helper)
  long      one session, `--commands` ratio commands at 20 ms, RssAnon every 250 commands, with and
            without the persistence helper: does the heap plateau?

Usage: python3 probes/perf/rss_bisect.py reload|cycle|long [--cycles 100] [--oracles 0] [--commands 8000] [--out DIR]
Writes DIR/result.json (local artifact; the aggregation copies it into the evidence).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tests/integration"))
sys.path.insert(0, str(HERE))
from harness import PLUGIN, Session  # noqa: E402
import perfcommon  # noqa: E402

VARIANTS = {
    "empty": (ROOT / "probes/lifecycle/empty-package/contents/ui/main.qml", False),
    "shortcuts": (HERE / "rss-variants/shortcuts.qml", True),
    "runtime": (HERE / "rss-variants/runtime.qml", True),
    "runtime-persist": (HERE / "rss-variants/runtime-persist.qml", True),
    "production": (ROOT / "package/contents/ui/main.qml", True),
}
CYCLES = {
    "full": {"openclose", "cmd", "delayed", "counters"},
    "openclose": {"openclose"},
    "cmd": {"cmd"},
    "cmd+delayed": {"cmd", "delayed"},
    "counters": {"counters"},
    "cmd+noreload": {"cmd", "noreload"},
    "cmd+nohelper": {"cmd", "nohelper"},
}


def anon(s: Session) -> int:
    return s.kw.kwin_rss_parts_kib()["RssAnon"]


def trend(series: list[int], cycles: int) -> dict:
    pts = list(enumerate(series))
    return {"cycles": cycles, "anonFirstKiB": series[0], "anonLastKiB": series[-1],
            "slopeKiBPerCycleFrom10": round(perfcommon.slope([p for p in pts if p[0] >= 10]), 2),
            "slopeKiBPerCycleSecondHalf": round(perfcommon.slope([p for p in pts if p[0] >= cycles // 2]), 2),
            "every10": series[::10]}


def reload_mode(out: Path, cycles: int, oracles: int) -> dict:
    res = {}
    for name, (qml, logs) in VARIANTS.items():
        with Session(out / name, qml=qml) as s:
            for i in (1, 2, 3, 4):
                s.spawn(i)
            series = []
            for _ in range(cycles):
                off = s.kw.mark()
                s.kw.load_declarative(qml, PLUGIN)
                if logs:
                    s.kw.wait_log(r"plastile (info|notice) started", 10, off)
                else:
                    Session.wait_for(lambda: s.kw.is_loaded(PLUGIN), 5, "loaded")
                time.sleep(0.05)
                off = s.kw.mark()
                s.kw.unload(PLUGIN)
                if logs:
                    s.kw.wait_log(r"plastile (info|notice) stopped", 10, off)
                Session.wait_for(lambda: not s.kw.is_loaded(PLUGIN), 5, "unloaded")
                for _ in range(oracles):
                    s.frames_list()
                series.append(anon(s))
            res[name] = trend(series, cycles)
            print(name, json.dumps(res[name]), flush=True)
    return res


def cycle_mode(out: Path, cycles: int) -> dict:
    res = {}
    for name, flags in CYCLES.items():
        with Session(out / name.replace("+", "-"), helper="nohelper" not in flags) as s:
            s.spawn(1); s.spawn(2)
            s.spawn(4, *(("--configure-delay-ms", "200") if "delayed" in flags else ()))
            s.spawn(3)
            s.load(); s.settle()
            series = []
            for i in range(cycles):
                if "cmd" in flags:
                    s.act("plastile-fixture 1", "workspace.activeWindow = w")
                    s.cmd("resize.grow" if i % 2 == 0 else "resize.shrink")
                if "counters" in flags:
                    s.counters()
                if "noreload" not in flags:
                    s.unload()
                    s.load()
                if "counters" in flags:
                    s.settle()
                else:
                    time.sleep(0.25)
                if "openclose" in flags:
                    s.spawn(5); s.kill(5)
                if "delayed" in flags:
                    time.sleep(0.25)
                series.append(anon(s))
            res[name] = {"flags": sorted(flags)} | trend(series, cycles)
            print(name, json.dumps(res[name]), flush=True)
    return res


def long_mode(out: Path, commands: int) -> dict:
    res = {}
    for name, helper in (("helper", True), ("nohelper", False)):
        with Session(out / name, helper=helper) as s:
            for i in (1, 2, 3, 4):
                s.spawn(i)
            s.load(); s.settle()
            s.act("plastile-fixture 1", "workspace.activeWindow = w")
            series = []
            for k in range(commands):
                s.cmd("resize.grow" if k % 2 == 0 else "resize.shrink")
                time.sleep(0.02)
                if k % 250 == 0:
                    series.append((k, anon(s)))
            s.settle()
            series.append((commands, anon(s)))
            q = len(series) // 4
            res[name] = {"seriesKiB": series,
                         "slopeKiBPer1000Commands": {f"quarter{i + 1}": round(1000 * perfcommon.slope(series[i * q:(i + 1) * q + 1]), 1)
                                                     for i in range(4)},
                         "after1000": {"min": min(a for k, a in series if k >= 1000), "max": max(a for k, a in series if k >= 1000)}}
            print(name, json.dumps(res[name]), flush=True)
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=("reload", "cycle", "long"))
    ap.add_argument("--cycles", type=int, default=100)
    ap.add_argument("--oracles", type=int, default=0)
    ap.add_argument("--commands", type=int, default=8000)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    out = args.out or ROOT / "artifacts/perf/rss-bisect" / f"{time.strftime('%Y%m%dT%H%M%S')}-{args.mode}"
    out.mkdir(parents=True, exist_ok=True)
    unit = {"probe": "P14-rss-bisect", "mode": args.mode, **perfcommon.git_meta(), "versions": perfcommon.versions(),
            "machineStart": perfcommon.machine_state(), "args": {k: str(v) for k, v in vars(args).items() if k != "out"},
            "layer": "nested KWin virtual backend (not physical)", "metric": "KWin RssAnon (KiB) from /proc/<pid>/status"}
    unit["result"] = (reload_mode(out, args.cycles, args.oracles) if args.mode == "reload" else
                      cycle_mode(out, args.cycles) if args.mode == "cycle" else long_mode(out, args.commands))
    unit["machineEnd"] = perfcommon.machine_state()
    perfcommon.write_json(out / "unit.json", unit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
