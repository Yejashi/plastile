"""Configuration scenarios (T25, T26, T28, D9; TEST_MATRIX Q02, Q04, Q08).

Geometry comes from the independent oracle (one-shot KWin scripts reading frameGeometry).
Plastile's log is read only for what it reports about itself (explanations, the shortcut
report, lifecycle markers) and its counters only for work amounts; neither is used as a
geometry claim.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from harness import Session, near, tiling_errors
from scenarios import Checks, scenario
from scenarios_classify import brief, explain, rejected

GAP = 8

# Single-line JSON without backslashes: written verbatim into kwinrc, so no KConfig escaping applies.
CONTEXT_RULES = json.dumps({"schemaVersion": 1, "rules": [
    {"id": "notes-floats", "match": {"desktopName": "Notes"}, "actions": {"mode": "floating"}},
    {"id": "second-output-floats", "match": {"outputName": "Virtual-1"}, "actions": {"mode": "floating"}},
    {"id": "wide-two", "match": {"title": "plastile-fixture 2"}, "actions": {"minSize": {"width": 760}}},
]}, separators=(",", ":"))


def full(a: dict) -> dict:
    return {"x": a["x"] + GAP, "y": a["y"] + GAP, "width": a["width"] - 2 * GAP, "height": a["height"] - 2 * GAP}


def no_errors(s: Session) -> tuple[bool, list[str]]:
    warn = s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError")
    return s.counters()["counters"]["errors"] == 0 and not warn, warn[:3]


@scenario("rules-context-T25")
def rules_context(out: Path, c: Checks):
    """Rules matching desktop name, output and title (minSize): applied, re-evaluated on membership and rename."""
    with Session(out, outputs=2, config={"configJson": CONTEXT_RULES}) as s:
        s.js("workspace.createDesktop(1, 'Notes'); emit(1);")
        for i in (1, 2, 3):
            s.spawn(i)
        s.load()
        s.settle()
        c("configuration accepted (no rejection/warnings)", not rejected(s), rejected(s))
        a0, a1 = s.area(0), s.area(1)
        f = s.frames()
        tiles = [f[f"plastile-fixture {i}"] for i in (1, 2, 3)]
        c("adopt: three tiles on Virtual-0, no overlap (oracle)", not tiling_errors(tiles, a0, GAP), tiling_errors(tiles, a0, GAP))
        w2 = f["plastile-fixture 2"]["frame"]["width"]
        c("minSize rule: fixture 2's tile is at least 760 px wide (oracle)", w2 >= 760, f["plastile-fixture 2"]["frame"])
        e2 = explain(s, "plastile-fixture 2")
        c("explain names the minSize action and its rule", (e2.get("rules") or {}).get("actions", {}).get("minSize") == "760x0"
          and (e2.get("rules") or {}).get("reasons", {}).get("minSize") == "rule wide-two", e2.get("rules"))

        # Membership change: fixture 3 moves to the desktop named Notes, where a rule floats it.
        s.act("plastile-fixture 3", "w.desktops = [workspace.desktops[1]]")
        time.sleep(0.3)
        s.settle()
        f = s.frames()
        left = [f["plastile-fixture 1"], f["plastile-fixture 2"]]
        c("desktop 1 reflows to two tiles after the move (oracle)", not tiling_errors(left, a0, GAP)
          and abs(sum(x["frame"]["width"] for x in left) - (a0["width"] - 3 * GAP)) <= 2, [x["frame"] for x in left])
        before = f["plastile-fixture 3"]["frame"]
        s.js("workspace.currentDesktop = workspace.desktops[1]; emit(1);")
        time.sleep(0.4)
        s.settle()
        f = s.frames()
        c("on Notes fixture 3 floats: Plastile did not tile it (frame unchanged, not the full area; oracle)",
          near(f["plastile-fixture 3"]["frame"], before, 1.0) and not near(f["plastile-fixture 3"]["frame"], full(a0), 2.0),
          {"before": before, "after": f["plastile-fixture 3"]["frame"]})
        e3 = explain(s, "plastile-fixture 3")
        c("explain: floating by rule notes-floats", e3.get("mode") == "floating"
          and (e3.get("decision") or {}).get("ruleIds") == ["notes-floats"], brief(e3))

        # Rename: the desktop no longer matches; the window tiles alone on it.
        s.js("workspace.desktops[1].name = 'Two'; emit(1);")
        time.sleep(0.4)
        s.settle()
        f = s.frames()
        c("after renaming Notes to Two, fixture 3 tiles the full area (oracle)",
          near(f["plastile-fixture 3"]["frame"], full(a0), 1.0), f["plastile-fixture 3"]["frame"])

        # Output rule: fixture 1 sent to Virtual-1 floats there; fixture 2 fills Virtual-0.
        s.js("workspace.currentDesktop = workspace.desktops[0]; emit(1);")
        time.sleep(0.3)
        s.act("plastile-fixture 1", "workspace.sendClientToScreen(w, workspace.screens[1])")
        time.sleep(0.5)
        s.settle()
        f = s.frames()
        on1 = f["plastile-fixture 1"]
        c("fixture 1 is on Virtual-1 and not tiled there (oracle)", on1["output"] == "Virtual-1"
          and not near(on1["frame"], full(a1), 2.0), on1)
        c("fixture 2 alone fills Virtual-0 (oracle)", near(f["plastile-fixture 2"]["frame"], full(a0), 1.0),
          f["plastile-fixture 2"]["frame"])
        e1 = explain(s, "plastile-fixture 1")
        c("explain: floating by rule second-output-floats", e1.get("mode") == "floating"
          and (e1.get("decision") or {}).get("ruleIds") == ["second-output-floats"], brief(e1))
        ok, warn = no_errors(s)
        c("no model errors or JS exceptions", ok, warn)
