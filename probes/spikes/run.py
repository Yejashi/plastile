#!/usr/bin/env python3
"""M1 spike workload (T05/T06/T07): identical experiments for both backends.

Usage: python3 probes/spikes/run.py --backend direct|native [--reps N]
Writes artifacts/spikes/<stamp>-<backend>/{result.json,kwin.log,fixture-*.jsonl}.

Correctness uses the harness oracle (one-shot KWin scripts reading real window
state), never the spike's own claims. Workloads mirror ROADMAP M1's table.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from nested import NestedKwin, NestedError  # noqa: E402

FIXTURE = ROOT / "fixtures/client/build/plastile-fixture"
MEASURE = ROOT / "build/measure/qml"
SP = re.compile(r"PLT-SPIKE (\S+) (\{.*\})$")
TOL = 0.5


def near(a, b, tol=TOL):
    return all(abs(a[k] - b[k]) <= tol for k in ("x", "y", "width", "height"))


def overlap(a, b):
    return (min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]) > TOL and
            min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]) > TOL)


class Spike:
    def __init__(self, kw: NestedKwin, backend: str, out: Path):
        self.kw, self.backend, self.out = kw, backend, out
        self.qml = HERE / backend / "package/contents/ui/main.qml"
        self.plugin = f"plt-spike-{backend}"
        self.fixtures: dict[int, subprocess.Popen] = {}

    def spawn(self, ident: int, *extra: str):
        log = open(self.out / f"fixture-{ident}.jsonl", "w")
        self.fixtures[ident] = self.kw.spawn([str(FIXTURE), "--ssd", "--id", str(ident), *extra],
                                             stdout=log, stdin=subprocess.PIPE)

    def kill(self, ident: int):
        p = self.fixtures.pop(ident)
        p.stdin.write(b"quit\n"); p.stdin.flush()
        p.wait(timeout=5)

    def load(self):
        off = self.kw.mark()
        self.kw.load_declarative(self.qml, self.plugin)
        self.kw.wait_log(r"PLT-SPIKE start ", 5, off)

    def unload(self):
        off = self.kw.mark()
        self.kw.unload(self.plugin)
        self.kw.wait_log(r"PLT-SPIKE teardown ", 5, off)

    def cmd(self, name: str):
        return self.kw.invoke_shortcut(f"plastile-spike-{name}")

    def counters(self) -> dict:
        off = self.kw.mark()
        self.kw.invoke_shortcut("plastile-spike-dump")
        line = self.kw.wait_log(r"PLT-SPIKE counters ", 5, off)[-1]
        return json.loads(SP.search(line).group(2))

    def settle(self, timeout=3.0) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            c = self.counters()
            if c.get("outstanding", 0) == 0 or time.monotonic() > deadline:
                return c
            time.sleep(0.02)

    def events(self, off: int, name: str):
        return [json.loads(SP.search(l).group(2)) for l in self.kw.lines_since(off, rf"PLT-SPIKE {name} ")]

    def frames(self) -> dict[str, dict]:
        return {w["caption"]: w for w in self.kw.fixtures()}


def delta(a: dict, b: dict) -> dict:
    return {k: b[k] - a[k] for k in b if isinstance(b.get(k), (int, float)) and isinstance(a.get(k), (int, float))
            and b[k] != a[k] and k not in ("t", "ratio")}


def tiled_ok(frames: dict, captions: list[str], area) -> list[str]:
    errs = []
    rects = [frames[c]["frame"] for c in captions if c in frames]
    for i, a in enumerate(rects):
        if a["x"] < area["x"] - TOL or a["y"] < area["y"] - TOL or a["x"] + a["width"] > area["x"] + area["width"] + TOL \
                or a["y"] + a["height"] > area["y"] + area["height"] + TOL:
            errs.append(f"{captions[i]} outside area: {a}")
        for j in range(i + 1, len(rects)):
            if overlap(a, rects[j]):
                errs.append(f"{captions[i]} overlaps {captions[j]}")
    return errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=("direct", "native"), required=True)
    ap.add_argument("--reps", type=int, default=20)
    args = ap.parse_args()
    out = ROOT / "artifacts/spikes" / f"{time.strftime('%Y%m%dT%H%M%S')}-{args.backend}"
    out.mkdir(parents=True, exist_ok=True)
    R: dict = {"backend": args.backend, "reps": args.reps, "checks": {}, "workloads": {}}
    fails: list[str] = []
    area = {"x": 0, "y": 0, "width": 1280, "height": 800}
    base3 = ["plastile-fixture 1", "plastile-fixture 2", "plastile-fixture 3"]

    def check(name, ok, detail=None):
        R["checks"][name] = {"pass": bool(ok), "detail": detail}
        if not ok:
            fails.append(name)

    with NestedKwin(out, kwinrc="[Script-plt-spike-%s]\nfixtureClass=plastile-fixture\n" % args.backend,
                    extra_env={"QML_IMPORT_PATH": str(MEASURE)}) as kw:
        s = Spike(kw, args.backend, out)
        s.spawn(1); s.spawn(2)
        s.spawn(3, "--configure-delay-ms", "300", "--delay-mode", "latest")
        time.sleep(1.2)
        s.load()
        c0 = s.settle()
        f0 = s.frames()
        check("adopt-3-tiled-no-overlap", not tiled_ok(f0, base3, area) and c0["tiled"] == 3, tiled_ok(f0, base3, area))
        R["initialFrames"] = {k: v["frame"] for k, v in f0.items()}

        # No-op: identical plan must cause zero writes / native mutations.
        a = s.counters()
        for _ in range(args.reps):
            s.cmd("noop"); time.sleep(0.03)
        b = s.settle()
        d = delta(a, b)
        R["workloads"]["noop"] = d
        mut = sum(v for k, v in d.items() if k in ("writes",) or k.startswith("native"))
        check("noop-zero-mutations", mut == 0, d)

        # Focus-only: zero solves and zero writes.
        a = s.counters()
        for _ in range(args.reps):
            s.cmd("focus-next"); time.sleep(0.03)
        b = s.settle()
        d = delta(a, b)
        R["workloads"]["focus"] = d
        check("focus-zero-solves-writes", d.get("solves", 0) == 0 and d.get("writes", 0) == 0
              and not any(k.startswith("native") and k != "nativeTileWindowSignals" for k in d), d)

        # Ratio steps with settle; measure command->all settled.
        a = s.counters()
        off = kw.mark()
        lat = []
        for i in range(args.reps):
            t_send = s.cmd("ratio-up" if i % 2 == 0 else "ratio-down")
            c = s.settle()
            settles = [e for e in s.events(off, "settle")]
            if settles:
                lat.append(max(e["t"] for e in settles) - t_send)
            off = kw.mark()
        b = s.counters()
        d = delta(a, b)
        R["workloads"]["ratio"] = {"counters": d, "sendToAllSettledNs": sorted(lat)}
        fr = s.frames()
        check("ratio-converges", b["outstanding"] == 0 and not tiled_ok(fr, base3, area), tiled_ok(fr, base3, area))

        # Swap (even count returns to the pre-swap order).
        f_pre = s.frames()
        a = s.counters()
        for _ in range(2 * (args.reps // 4)):
            s.cmd("swap"); s.settle()
        b = s.counters()
        R["workloads"]["swap"] = delta(a, b)
        fr = s.frames()
        check("swap-even-returns-to-initial", all(near(fr[c]["frame"], f_pre[c]["frame"], 1.0) for c in base3),
              {c: (fr[c]["frame"], f_pre[c]["frame"]) for c in base3})

        # Reversal: ratio-up then ratio-down 50 ms later; fixture 3 delays commits by 300 ms.
        rev_ok, rev_detail = [], []
        a = s.counters()
        for _ in range(5):
            pre = s.frames()
            s.cmd("ratio-up"); time.sleep(0.05); s.cmd("ratio-down")
            time.sleep(1.6)
            s.settle()
            post = s.frames()
            rev_ok.append(all(near(post[c]["frame"], pre[c]["frame"], 1.0) for c in base3))
            if not rev_ok[-1]:
                rev_detail.append({c: {"A": pre[c]["frame"], "final": post[c]["frame"]} for c in base3
                                   if not near(post[c]["frame"], pre[c]["frame"], 1.0)})
        b = s.counters()
        R["workloads"]["reversal"] = {"counters": delta(a, b), "finalEqualsA": rev_ok, "mismatches": rev_detail[:2]}
        check("reversal-final-A", all(rev_ok), rev_ok)

        # Burst create/remove.
        f_pre = s.frames()
        a = s.counters()
        for i in (4, 5, 6):
            s.spawn(i)
        time.sleep(1.5)
        s.settle()
        mid = s.counters()
        fr6 = s.frames()
        six = base3 + [f"plastile-fixture {i}" for i in (4, 5, 6)]
        for i in (4, 5, 6):
            s.kill(i)
        time.sleep(1.0)
        b = s.settle()
        fr = s.frames()
        R["workloads"]["burst"] = {"create": delta(a, mid), "remove": delta(mid, b)}
        check("burst-6-no-overlap", not tiled_ok(fr6, six, area), tiled_ok(fr6, six, area))
        check("burst-returns-to-3", all(near(fr[c]["frame"], f_pre[c]["frame"], 1.0) for c in base3) and b["tiled"] == 3,
              {c: fr[c]["frame"] for c in base3})

        # Minimum-size client that honours its own minimum: bounded work, no oscillation.
        a = s.counters()
        s.spawn(7, "--min", "700x500", "--clamp")
        time.sleep(2.5)
        b = s.counters()
        d = delta(a, b)
        R["workloads"]["minsize"] = d
        check("minsize-bounded", d.get("writes", 0) <= 12 and d.get("corrections", 0) <= 2 * 4, d)
        s.kill(7)
        time.sleep(1.0); s.settle()

        # Fullscreen / restore by the "user".
        f_pre = s.frames()
        a = s.counters()
        kw.act("plastile-fixture 2", "w.fullScreen = true")
        time.sleep(1.0); s.settle()
        fs = s.frames()
        kw.act("plastile-fixture 2", "w.fullScreen = false")
        time.sleep(1.0); s.settle()
        fr = s.frames()
        b = s.counters()
        R["workloads"]["fullscreen"] = delta(a, b)
        check("fullscreen-respected", fs["plastile-fixture 2"]["fullScreen"] and
              near(fs["plastile-fixture 2"]["frame"], area, 1.0), fs["plastile-fixture 2"]["frame"])
        check("fullscreen-restore-layout", all(near(fr[c]["frame"], f_pre[c]["frame"], 1.0) for c in base3),
              {c: fr[c]["frame"] for c in base3})

        # Native quick tile by the "user": must not be snapped back.
        a = s.counters()
        kw.act("plastile-fixture 2", "workspace.activeWindow = w; workspace.slotWindowQuickTileLeft()")
        time.sleep(1.0); s.settle()
        fr = s.frames()
        b = s.counters()
        R["workloads"]["quicktile"] = delta(a, b)
        q = fr["plastile-fixture 2"]["frame"]
        check("quicktile-not-fought", q["x"] <= 1 and abs(q["width"] - 640) <= 9 and q["height"] >= 780, q)

        # Reload with pending work.
        cycles_ok = 0
        for _ in range(10):
            s.cmd("ratio-up")
            s.unload()
            s.load()
            s.settle()
            cycles_ok += 1
        stale = kw.lines_since(0, r"PLT-SPIKE error ")
        check("reload-10-no-errors", cycles_ok == 10 and not stale, stale[:3])
        R["final"] = s.counters()
        s.unload()

    settle_lines = [json.loads(SP.search(l).group(2)) for l in (out / "kwin.log").read_text().splitlines()
                    if SP.search(l) and SP.search(l).group(1) == "settle"]
    R["settleReasons"] = {r: sum(1 for e in settle_lines if e.get("reason") == r) for r in {e.get("reason") for e in settle_lines}}
    R["failures"] = fails
    R["pass"] = not fails
    (out / "result.json").write_text(json.dumps(R, indent=1))
    print(json.dumps({"backend": args.backend, "pass": R["pass"], "failures": fails,
                      "checks": {k: v["pass"] for k, v in R["checks"].items()}}, indent=1))
    print(out)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
