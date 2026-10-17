#!/usr/bin/env python3
"""E07 check: does KWin clamp a script frameGeometry request to the client's minimum?

Fixture declares --min 600x400 (optionally --clamp to obey its own minimum).
The timing probe requests half the minimum; we record what KWin sends in the
configure, what the client commits, and what the script observes.
Usage: python3 probes/timing/constraints.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from nested import NestedKwin  # noqa: E402

TM = re.compile(r"PLT-TM (\S+) (\{.*\})$")


def case(out: Path, clamp: bool) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    args = [str(ROOT / "fixtures/client/build/plastile-fixture"), "--ssd", "--min", "600x400"] + (["--clamp"] if clamp else [])
    with open(out / "fixture.jsonl", "w") as flog, NestedKwin(
            out, kwinrc="[Script-plt-timing]\nfixtureClass=plastile-fixture\n",
            extra_env={"QML_IMPORT_PATH": str(ROOT / "build/measure/qml")}) as kw:
        fx = kw.spawn(args, stdout=flog, stdin=subprocess.PIPE)
        time.sleep(1.0)
        off = kw.mark()
        kw.load_declarative(HERE / "package/contents/ui/main.qml", "plt-timing")
        kw.wait_log(r"PLT-TM calibrated ", 60, off)
        t0 = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
        kw.invoke_shortcut("plastile-probe-timing-undersize")
        time.sleep(1.5)
        ev = [(m.group(1), json.loads(m.group(2))) for ln in kw.lines_since(off) if (m := TM.search(ln))]
        kw.unload("plt-timing")
        fx.stdin.write(b"quit\n"); fx.stdin.flush(); fx.wait(timeout=5)
    client = [json.loads(l) for l in (out / "fixture.jsonl").read_text().splitlines()]
    after = [c for c in client if c["t_ns"] >= t0 and c.get("win", "main") == "main"]
    req = next(e for n, e in ev if n == "request" and e.get("mode") == "undersize")
    obs = [e["frame"] for n, e in ev if n == "observed" and e["seq"] == req["seq"]]
    return {
        "clientClamps": clamp,
        "scriptSeesMinSize": next(e for n, e in ev if n == "constraints")["minSize"],
        "requestedFrame": req["target"],
        "configures": [(c["width"], c["height"]) for c in after if c["ev"] == "configure"],
        "commits": [(c["width"], c["height"], c.get("reason")) for c in after if c["ev"] == "commit"],
        "observedFrames": obs,
        "configuresAfterFirstCommit": max(0, sum(1 for c in after if c["ev"] == "configure") - 1),
    }


def main() -> int:
    out = ROOT / "artifacts/constraints" / time.strftime("%Y%m%dT%H%M%S")
    res = {"noClamp": case(out / "no-clamp", False), "clamp": case(out / "clamp", True)}
    (out / "summary.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
