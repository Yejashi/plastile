"""Float rectangles across outputs (D6) and persisted session preferences (T27, ADR-013).

TEST_MATRIX IDs: L08 (float restore), O04/O05 (output changes), Q05 (persistence unavailable),
Q06 (ambiguous restore), Q07 (partial/invalid state file), Q09 (reload cycles).

Geometry is judged by the oracle (one-shot KWin scripts reading real window state). The state
files are read from the nested session's private XDG_STATE_HOME; Plastile's counters and log
lines are used for amounts of work and its own diagnostics only.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from harness import Session, near, tiling_errors
from scenarios import Checks, scenario

GAP = 8


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def area_of(s: Session, output: str) -> dict:
    out = s.js(f"const o = workspace.screens.find(x => x.name === {json.dumps(output)}); const a = workspace.clientArea("
               f"workspace.MaximizeArea, o, workspace.currentDesktopForScreen(o)); emit({{x: a.x, y: a.y, width: a.width,"
               f" height: a.height}});")
    return json.loads(out[0])


def inside(r: dict, a: dict, tol: float = 0.5) -> bool:
    return (r["x"] >= a["x"] - tol and r["y"] >= a["y"] - tol and r["x"] + r["width"] <= a["x"] + a["width"] + tol
            and r["y"] + r["height"] <= a["y"] + a["height"] + tol)


def relocate(r: dict, src: dict, dst: dict) -> dict:
    """Independent restatement of D6's documented rule: the centre keeps its relative position, the size is kept."""
    w, h = min(r["width"], dst["width"]), min(r["height"], dst["height"])
    fx_ = (r["x"] + r["width"] / 2 - src["x"]) / src["width"]
    fy_ = (r["y"] + r["height"] / 2 - src["y"]) / src["height"]
    x = min(max(dst["x"] + fx_ * dst["width"] - w / 2, dst["x"]), dst["x"] + dst["width"] - w)
    y = min(max(dst["y"] + fy_ * dst["height"] - h / 2, dst["y"]), dst["y"] + dst["height"] - h)
    return {"x": x, "y": y, "width": w, "height": h}


def centred(a: dict, frac: float = 0.6) -> dict:
    w, h = round(a["width"] * frac), round(a["height"] * frac)
    return {"x": a["x"] + (a["width"] - w) / 2, "y": a["y"] + (a["height"] - h) / 2, "width": w, "height": h}


def toggle(s: Session, i: int) -> None:
    s.act(fx(i), "workspace.activeWindow = w")
    s.cmd("window.toggle-float")
    time.sleep(0.2)
    s.settle()


# --------------------------------------------------------------------------- D6
@scenario("float-output-D6")
def float_output(out: Path, c: Checks):
    """Float on one output, tile, send to the other output, float again: the window comes back inside the output
    it is on now (proportionally placed), not at the old output's rectangle."""
    facts: dict = {}
    with Session(out, outputs=2) as s:
        s.spawn(1); s.spawn(2)
        s.load(); s.settle()
        a0, a1 = area_of(s, "Virtual-0"), area_of(s, "Virtual-1")
        toggle(s, 2)
        f = s.frames()[fx(2)]
        c("float without a float rectangle: bounded centred default inside Virtual-0 (oracle)",
          f["output"] == "Virtual-0" and near(f["frame"], centred(a0), 1.0), {"frame": f["frame"], "want": centred(a0)})
        s.act(fx(2), "w.frameGeometry = {x: 200, y: 150, width: 500, height: 400}")  # the user places it
        time.sleep(0.3); s.settle()
        placed = s.frames()[fx(2)]["frame"]
        toggle(s, 2)
        c("tile again: back in Virtual-0's tiling (oracle)", not tiling_errors(s.frames_list(), a0, GAP)
          and s.frames()[fx(2)]["output"] == "Virtual-0", tiling_errors(s.frames_list(), a0, GAP))
        s.act(fx(2), "workspace.activeWindow = w")
        s.cmd("move.output-next")
        time.sleep(0.3); s.settle()
        moved = s.frames()[fx(2)]
        c("send to the other output: tiled on Virtual-1 (oracle)", moved["output"] == "Virtual-1"
          and not tiling_errors([moved], a1, GAP), moved)
        toggle(s, 2)
        g = s.frames()[fx(2)]
        want = relocate(placed, a0, a1)
        facts.update({"placedOnVirtual0": placed, "restored": g["frame"], "expected": want, "areas": [a0, a1]})
        c("D6: float again restores inside Virtual-1's work area, still on Virtual-1 (oracle)",
          g["output"] == "Virtual-1" and inside(g["frame"], a1), g)
        c("D6: proportionally placed, same size (oracle vs the documented rule, 1 px)", near(g["frame"], want, 1.0),
          {"got": g["frame"], "want": want})
        c("D6: not the old output's rectangle", not near(g["frame"], placed, 1.0), g["frame"])
        warnings = s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError")
        c("no errors or JS exceptions logged", not warnings, warnings[:5])
    c("facts (recorded, always passes)", True, facts)
