"""Constraint refresh points (G08 family): size hints that change after a window mapped.

KWin 6.7.5 has no NOTIFY signal for minSize/maxSize. The fixture changes its xdg-toplevel
minimum at runtime (`min W H` on stdin, a bufferless commit), as Kate does right after
mapping. Geometry is judged by the oracle (one-shot KWin scripts: frames, minSize and
client geometry). Plastile's explanation is compared with KWin's report only to check
that Plastile's constraint model agrees with it; counters only gate the amount of work.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from harness import Session, delta, tiling_errors
from scenarios import Checks, scenario, three

GAP = 8
SIZES = ("const w = workspace.windowList().find(x => x.caption === {cap});"
         "emit(w ? {{min: {{width: w.minSize.width, height: w.minSize.height}},"
         " frame: {{width: w.frameGeometry.width, height: w.frameGeometry.height}},"
         " client: {{width: w.clientGeometry.width, height: w.clientGeometry.height}}, noBorder: w.noBorder}} : null);")


def kwin_sizes(s: Session, caption: str) -> dict:
    return json.loads(s.js(SIZES.format(cap=json.dumps(caption)))[0])


def explain(s: Session, caption: str) -> dict:
    s.act(caption, "workspace.activeWindow = w")
    time.sleep(0.1)
    off = s.kw.mark()
    s.cmd("inspect.explain-window")
    line = s.kw.wait_log(r"plastile info explain ", 5, off)[-1]
    return json.loads(line.split("plastile info explain ", 1)[1])


def expected_min_frame(k: dict) -> dict:
    """KWin's client-space minimum converted to frame space with the current decoration margin."""
    return {d: (k["min"][d] + k["frame"][d] - k["client"][d]) if k["min"][d] > 0 else 0 for d in ("width", "height")}


def agrees(e: dict, k: dict) -> bool:
    got = (e.get("constraints") or {}).get("minFrame") or {}
    want = expected_min_frame(k)
    return all(abs(got.get(d, -1) - want[d]) <= 1 for d in ("width", "height"))


@scenario("constraints-runtime-min-G08")
def runtime_min(out: Path, c: Checks):
    """A minimum set after mapping is honoured from the next solve; a decoration change updates the frame minimum."""
    with Session(out) as s:
        three(s)
        s.load(); s.settle()
        cap1, cap2 = "plastile-fixture 1", "plastile-fixture 2"
        c0 = s.counters()
        s.fixtures[1].send("min 760 300")  # fixture 1 holds the 691 px master column
        s.wait_for(lambda: kwin_sizes(s, cap1)["min"]["width"] == 760, 5, "KWin reports the new minimum")
        time.sleep(0.3)
        c1 = s.settle()
        fr = s.frames()
        f1 = fr[cap1]["frame"]
        c("min after mapping: fixture 1 frame width >= 760 (oracle)", f1["width"] >= 760 - 0.5, f1)
        errs = tiling_errors(list(fr.values()), s.area(), GAP)
        c("min after mapping: 3 tiles inside the area without overlap (oracle)", not errs, errs)
        d = delta(c0, c1)
        c("min after mapping: read from KWin, not learned or corrected", d.get("learned", 0) == 0 and d.get("corrections", 0) == 0
          and d.get("writes", 0) <= 3, d)
        c("min after mapping: converged", c1["outstanding"] == 0, c1["outstanding"])
        e1, k1 = explain(s, cap1), kwin_sizes(s, cap1)
        c("min after mapping: Plastile's frame minimum agrees with KWin's minSize + decoration", agrees(e1, k1),
          {"plastile": e1.get("constraints"), "kwin": k1, "expected": expected_min_frame(k1)})

        k2 = kwin_sizes(s, cap2)
        e2 = explain(s, cap2)
        c("decoration: before, the frame minimum includes the title bar", agrees(e2, k2) and k2["frame"]["height"] > k2["client"]["height"],
          {"plastile": e2.get("constraints"), "kwin": k2})
        s.act(cap2, "w.noBorder = true")
        s.wait_for(lambda: kwin_sizes(s, cap2)["client"]["height"] == kwin_sizes(s, cap2)["frame"]["height"], 5, "border removed")
        time.sleep(0.3)
        s.settle()
        k2b, e2b = kwin_sizes(s, cap2), explain(s, cap2)
        c("decoration: after removing the border, the frame minimum drops the title bar", agrees(e2b, k2b),
          {"plastile": e2b.get("constraints"), "kwin": k2b, "expected": expected_min_frame(k2b)})
        cz = s.counters()
        warn = s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError")
        c("no model errors or JS exceptions", cz["counters"]["errors"] == 0 and not warn, warn[:3])
        (out / "constraints.json").write_text(json.dumps({"fixture1": {"kwin": k1, "plastile": e1.get("constraints")},
                                                          "fixture2Before": {"kwin": k2, "plastile": e2.get("constraints")},
                                                          "fixture2After": {"kwin": k2b, "plastile": e2b.get("constraints")},
                                                          "countersMinChange": d}, indent=1))
