#!/usr/bin/env python3
"""Focus-command latency, stage by stage, in a disposable nested KWin (NOT a physical measurement).

Real key input through the nested KWin's EIS socket (plastile-keytap-ei), the same chords as the
physical P6 kit, and CLOCK_MONOTONIC everywhere:

  tap      keytap-ei: the key-down event written to libei (t_input)
  entry    the command handler's first statement in KWin's QV4 (Plastile: the measurement root's
           `plastile perf` entryNs; the minimal script: its own clock read)
  active   Workspace.windowActivated, logged by probes/perf/focus/observer.qml (synchronous with
           KWin's Workspace::setActiveWindow, for every condition)
  turn     a 0 ms timer the observer starts in that handler: the event-loop turn on which KWin's
           own 0 ms configure timer (XdgSurfaceWindow::scheduleConfigure) has just fired
  config   the fixture client receives the xdg_toplevel configure with the activated state

Conditions (randomized blocks; the window frames are the same in every condition):

  kwin-switch           Plastile not loaded; KWin's "Switch Window Right" (Meta+Alt+Right)
  plastile-focus        Plastile (measurement root probes/perf/main.qml); plastile.focus.next
  plastile-kwin-switch  Plastile loaded; KWin's "Switch Window Right"
  minimal               Plastile not loaded; probes/perf/focus/minimal.qml (assigns workspace.activeWindow)
  plastile-minimal      Plastile loaded and the minimal script

The frames: fixtures are tiled by Plastile once at start (master/stack); unloading Plastile leaves
them where they are, so the no-Plastile conditions activate the same rectangles. --small skips the
tiling (KWin's 400x300 placement, as the physical kit's P00-switch). Every block runs in a fresh
nested session. The decoration matters (docs/validation/PERFORMANCE.md section 5.1): --decoration
breeze|aurorae, and --aurorae-theme DIR for an Aurorae SVG theme, copied into the session's private
data directory. --qml runs another build's measurement root (bisecting; --diagnostics info for
builds that log their start at info). probes/perf/focus/area.py splits the result by window pair.

    python3 probes/perf/focus/run.py [--width 2560 --height 1440] [--windows 4] [--extra 0]
        [--desktops 1] [--samples 200] [--rounds 2] [--conditions ...] [--small]
        [--decoration breeze|aurorae] [--aurorae-theme DIR] [--qml PATH] [--diagnostics LEVEL] [--out DIR]

Prerequisites: npm run build; make -C fixtures/client; make -C tools/physical ei;
cmake -S tools/measure -B build/measure && cmake --build build/measure; build/helper.
"""
from __future__ import annotations

import argparse
import bisect
import json
import os
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
sys.path.insert(0, str(ROOT / "tools/physical"))
sys.path.insert(0, str(ROOT / "probes/perf"))
from harness import PLUGIN, Session  # noqa: E402
import common  # noqa: E402
import orchestrate  # noqa: E402
from nested_dryrun import eis_fd  # noqa: E402
from workloads import measure_env  # noqa: E402

PERF_QML = ROOT / "probes/perf/main.qml"
OBSERVER = HERE / "observer.qml"
MINIMAL = HERE / "minimal.qml"
CHORDS = {
    "kwin-switch": "Meta+Alt+Right",
    "plastile-focus": "Meta+Shift+N",
    "plastile-kwin-switch": "Meta+Alt+Right",
    "minimal": "Meta+Shift+U",
    "plastile-minimal": "Meta+Shift+U",
}
CONDITIONS = tuple(CHORDS)
# Server-side decoration plugins (system-installed; nothing is installed for the probe). Aurorae v2
# without --aurorae-theme finds no SVG ("Could not find decoration svg") and paints nothing.
DECORATIONS = {"breeze": "org.kde.breeze", "aurorae": "org.kde.kwin.aurorae.v2"}
RX_ACTIVE = re.compile(r"plastile-focus activated (\d+) ")
RX_TURN = re.compile(r"plastile-focus turn (\d+) (\d+)")
RX_MIN = re.compile(r"plastile-focus minimal (\d+) (\d+) (\d+)")
RX_PERF = re.compile(r"plastile perf (\{.*\})$")


def q(xs: list[float]) -> dict | None:
    s = sorted(x for x in xs if x is not None)
    if not s:
        return None
    p = lambda f: s[min(len(s) - 1, int(f * (len(s) - 1)))]  # noqa: E731
    return {"n": len(s), "p05": round(p(0.05), 3), "p50": round(p(0.5), 3), "p95": round(p(0.95), 3),
            "max": round(s[-1], 3)}


def first_after(xs: list[int], t: int, limit: int) -> int | None:
    i = bisect.bisect_right(xs, t)
    return xs[i] if i < len(xs) and xs[i] - t <= limit else None


class Bench:
    def __init__(self, args, out: Path):
        self.args, self.out = args, out
        kwinrc = ""
        if args.desktops > 1:
            kwinrc += f"[Desktops]\nNumber={args.desktops}\nRows=1\n"
        if args.decoration:
            kwinrc += f"[org.kde.kdecoration2]\nlibrary={DECORATIONS[args.decoration]}\n"
            if args.aurorae_theme:
                kwinrc += f"theme=__aurorae__svg__{args.aurorae_theme.name}\n"
        self.s = Session(out, outputs=args.outputs, width=args.width, height=args.height,
                         extra_env=measure_env(), qml=args.qml, kwinrc_extra=kwinrc,
                         config={"diagnostics": args.diagnostics})
        self.monitor = orchestrate.Monitor()
        self.keytap = None
        if args.aurorae_theme:
            # A copy in the nested session's private XDG_DATA_HOME (a temp directory), never the user's.
            def prepare(kw, src=args.aurorae_theme) -> None:
                shutil.copytree(src, Path(kw.root) / "data/aurorae/themes" / src.name)
            self.s.kw.prepare = prepare

    # ---------------------------------------------------------------- conditions
    def set_condition(self, cond: str) -> None:
        """Once per session: Plastile was loaded by setup(); unload it, load the minimal script.
        Each block runs in a fresh session: loading Plastile again after an unload in the same
        nested KWin sometimes never completes in this probe (the declarative component stays
        loading, no error logged); one session per block also keeps conditions independent."""
        if cond.endswith("minimal"):
            self.s.kw.load_declarative(MINIMAL, "plastile-focus-minimal")
        if not cond.startswith("plastile"):
            self.unload_plastile()
        time.sleep(0.5)

    def unload_plastile(self) -> None:
        """Session.unload, but older builds log their stop at `info`."""
        if not self.s.loaded:
            return
        off = self.s.kw.mark()
        self.s.kw.unload(PLUGIN)
        self.s.kw.wait_log(r"plastile (notice|info) stopped", 10, off)
        self.s.loaded = False

    def setup(self) -> None:
        s = self.s
        s.kw.load_declarative(OBSERVER, "plastile-focus-observer")
        for i in range(1, self.args.windows + 1):
            s.spawn(i)
        # Extra windows (other desktops) stand in for a populated session: Plastile tiles them in
        # their own contexts; they never take part in the cycle.
        for k in range(self.args.extra):
            ident = 100 + k
            s.spawn(ident)
            if self.args.desktops > 1:
                d = 1 + k % (self.args.desktops - 1)
                s.act(f"plastile-fixture {ident}", f"w.desktops = [workspace.desktops[{d}]]")
        if not self.args.small:
            # Session.load, but older builds log their start at `info` ("plastile info started").
            off = s.kw.mark()
            s.kw.load_declarative(s.qml, PLUGIN)
            s.kw.wait_log(r"plastile (notice|info) started ", 10, off)
            s.loaded = True
            s.settle(timeout=6)
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        time.sleep(0.3)
        self.frames = {f["caption"]: f["frame"] for f in s.frames_list()}
        fd = eis_fd(s)
        self.keytap = orchestrate.KeyTap([str(common.KEYTAP_EI), "--backend", "libei", "--ei-fd", str(fd)],
                                         self.monitor, self.out / "keytap.jsonl", pass_fds=(fd,), env=s.kw.client_env())
        os.close(fd)
        self.keytap.wait_ready()

    def block(self, idx: int, cond: str, rng: random.Random) -> dict:
        self.set_condition(cond)
        mods, key = common.parse_sequence(CHORDS[cond])
        start = self.s.kw.mark()
        taps = []
        for i in range(self.args.warmup + self.args.samples):
            rec = self.keytap.tap(f"b{idx:03d}t{i:05d}", mods, key)
            if i >= self.args.warmup:
                taps.append(rec)
            # Pacing: the tap holds the key for its own hold time; wait for quiet before the next.
            self.monitor.wait_until(lambda: False, rng.uniform(0.06, 0.10))
        time.sleep(0.3)
        lines = self.s.kw.lines_since(start)
        return {"cond": cond, "taps": taps, "lines": lines}

    def configures(self) -> list[int]:
        out = []
        for f in sorted(self.out.glob("fixture-*.jsonl")):
            for line in f.read_text().splitlines():
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("ev") == "configure" and "activated" in (e.get("states") or []):
                    out.append(e["t_ns"])
        return sorted(out)

    def close(self) -> None:
        if self.keytap is not None:
            self.keytap.close()


def analyse(blocks: list[dict]) -> dict:
    per: dict[str, dict[str, list]] = {}
    for b in blocks:
        confs = b["configures"]
        act, turn, minimal, perf = [], {}, [], []
        for ln in b["lines"]:
            m = RX_ACTIVE.search(ln)
            if m:
                act.append(int(m.group(1)))
            m = RX_TURN.search(ln)
            if m:
                turn[int(m.group(2))] = int(m.group(1))
            m = RX_MIN.search(ln)
            if m:
                minimal.append((int(m.group(1)), int(m.group(2)), int(m.group(3))))
            m = RX_PERF.search(ln)
            if m:
                p = json.loads(m.group(1))
                if p.get("id") == "plastile.focus.next":
                    perf.append(p)
        act.sort()
        entries = sorted([x[0] for x in minimal] + [int(p["entryNs"]) for p in perf])
        by_entry = {x[0]: {"assignNs": x[2], "pickNs": x[1]} for x in minimal}
        by_entry.update({int(p["entryNs"]): {"assignNs": p.get("activateNs"), "dispatchNs": p.get("dispatchToReturnNs")}
                         for p in perf})
        d = per.setdefault(b["cond"], {k: [] for k in ("tap_entry", "tap_active", "active_turn", "turn_config",
                                                       "tap_config", "assign", "dispatch")})
        for t in b["taps"]:
            t0 = t["t_input_ns"]
            c = first_after(confs, t0, 60_000_000)
            a = first_after(act, t0, 60_000_000)
            e = first_after(entries, t0, 60_000_000)
            tu = turn.get(a) if a is not None else None
            if c is None or a is None or a > c:
                continue
            d["tap_config"].append((c - t0) / 1e6)
            d["tap_active"].append((a - t0) / 1e6)
            if tu is not None:
                d["active_turn"].append((tu - a) / 1e6)
                d["turn_config"].append((c - tu) / 1e6)
            if e is not None and e <= a:
                d["tap_entry"].append((e - t0) / 1e6)
                x = by_entry.get(e, {})
                if x.get("assignNs") is not None:
                    d["assign"].append(x["assignNs"] / 1e6)
                if x.get("dispatchNs") is not None:
                    d["dispatch"].append(x["dispatchNs"] / 1e6)
    return {c: {k: q(v) for k, v in d.items()} for c, d in per.items()}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--width", type=int, default=2560)
    ap.add_argument("--height", type=int, default=1440)
    ap.add_argument("--outputs", type=int, default=1)
    ap.add_argument("--windows", type=int, default=4)
    ap.add_argument("--extra", type=int, default=0)
    ap.add_argument("--desktops", type=int, default=1)
    ap.add_argument("--samples", type=int, default=200)
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--conditions", default=",".join(CONDITIONS))
    ap.add_argument("--decoration", choices=sorted(DECORATIONS), default=None,
                    help="decoration plugin for the nested KWin (default: KWin's default)")
    ap.add_argument("--aurorae-theme", type=Path, default=None,
                    help="an Aurorae SVG theme directory, copied into the nested session's private data dir "
                         "(with --decoration aurorae)")
    ap.add_argument("--small", action="store_true",
                    help="never tile: the fixtures keep KWin's placement (400x300); conditions without Plastile only")
    ap.add_argument("--diagnostics", default="warn",
                    help="Plastile's diagnostics level (builds before the notice level need `info` to log their start)")
    ap.add_argument("--qml", type=Path, default=PERF_QML, help="the Plastile root to load (default: the measurement root)")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)
    conds = [c for c in args.conditions.split(",") if c]
    for c in conds:
        if c not in CHORDS:
            ap.error(f"unknown condition {c}")
        if args.small and c.startswith("plastile"):
            ap.error("--small: conditions without Plastile only")
    out = args.out or ROOT / "artifacts/perf/focus" / time.strftime("%Y%m%dT%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    rev = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    plan = []
    for _ in range(args.rounds):
        r = conds[:]
        rng.shuffle(r)
        plan += r
    blocks, frames, counters = [], None, {}
    for i, c in enumerate(plan):
        print(f"[{i + 1}/{len(plan)}] {c}", flush=True)
        bench = Bench(args, out / f"{i:03d}-{c}")
        with bench.s:
            try:
                bench.setup()
                frames = frames or bench.frames
                if bench.frames != frames:
                    print(f"  note: frames differ from the first block's: {bench.frames}", flush=True)
                b = bench.block(i, c, rng)
                if bench.s.loaded:
                    counters[f"{i:03d}-{c}"] = bench.s.counters().get("counters")
                    bench.unload_plastile()
            finally:
                bench.close()
        b["configures"] = bench.configures()
        blocks.append(b)
    result = {
        "layer": "nested KWin (virtual backend), not physical",
        "implementationCommit": rev,
        "qml": str(args.qml.relative_to(ROOT)) if args.qml.is_relative_to(ROOT) else str(args.qml),
        "output": {"count": args.outputs, "width": args.width, "height": args.height},
        "windows": args.windows, "extra": args.extra, "desktops": args.desktops,
        "diagnostics": args.diagnostics,
        "decoration": args.decoration and DECORATIONS[args.decoration], "small": args.small,
        "auroraeTheme": args.aurorae_theme and args.aurorae_theme.name,
        "samplesPerBlock": args.samples, "rounds": args.rounds, "plan": [b["cond"] for b in blocks],
        "frames": frames,
        "stagesMs": analyse(blocks),
        "plastileCountersPerBlock": counters,
    }
    (out / "result.json").write_text(json.dumps(result, indent=1) + "\n")
    for c, st in result["stagesMs"].items():
        print(c)
        for k, v in st.items():
            if v:
                print(f"   {k:12s} n={v['n']:4d} p50={v['p50']:7.3f} p95={v['p95']:7.3f} max={v['max']:7.3f}")
    print(f"results: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
