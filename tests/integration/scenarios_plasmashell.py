"""Panels from a real plasmashell (O07, the nested half of runbook P3 / PHY-03a-e).

plasmashell runs inside the nested session only (its private bus, XDG tree and Wayland socket) with a
fresh configuration, so it creates its default layout. Each phase changes the panels through
plasmashell's own scripting interface (org.kde.PlasmaShell.evaluateScript on the private bus), the
same API a desktop layout script uses: height, screen edge, auto-hide, dodge windows, floating, and adding and removing
a second panel. The oracle is KWin: the work area it reports for the output, the dock windows' frames,
and the fixture frames. Plastile's counters only bound the work (no correction loop).

A phase whose change plasmashell did not apply (its panel record is unchanged) is reported as such
and is not counted against Plastile.
"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

from harness import Session, delta, tiling_errors
from scenarios import Checks, Skipped, scenario
from scenarios_contexts import KAMD, start_kamd
from scenarios_realapps import descendants_of, sweep
from scenarios_workarea import panel_record, tiles, until

GAP = 8
PLASMASHELL = shutil.which("plasmashell")
EVIDENCE: dict = {}


def shell(s: Session, script: str) -> None:
    s.kw.call("/PlasmaShell", "org.kde.PlasmaShell", "evaluateScript", "s", script, service="org.kde.plasmashell")


def overlaps(a: dict, b: dict) -> bool:
    return a["x"] < b["x"] + b["width"] and b["x"] < a["x"] + a["width"] and a["y"] < b["y"] + b["height"] and b["y"] < a["y"] + a["height"]


def layout_ok(s: Session, n: int) -> tuple[bool, dict]:
    """Tiles fill KWin's work area (outer gap from every area edge) without overlap or any overlap with a
    panel that reserves space (one that KWin's area excludes)."""
    area = s.area()
    f = tiles(s)
    errs = tiling_errors(f, area, GAP)
    docks = panel_record(s)
    under = [d["frame"] for d in docks for t in f if overlaps(t["frame"], d["frame"])
             and not overlaps(d["frame"], area)]  # a panel outside the area reserves space: no tile may cover it
    fr = [t["frame"] for t in f]
    edges = {
        "left": min((x["x"] for x in fr), default=None), "top": min((x["y"] for x in fr), default=None),
        "right": max((x["x"] + x["width"] for x in fr), default=None),
        "bottom": max((x["y"] + x["height"] for x in fr), default=None),
    }
    want = {"left": area["x"] + GAP, "top": area["y"] + GAP, "right": area["x"] + area["width"] - GAP,
            "bottom": area["y"] + area["height"] - GAP}
    edge_ok = all(edges[k] is not None and abs(edges[k] - want[k]) <= 0.5 for k in want)
    ok = len(f) == n and not errs and not under and edge_ok
    return ok, {"area": area, "panels": [d["frame"] for d in docks], "edges": edges, "expected": want,
                "errors": errs, "underPanel": under}


@scenario("plasmashell-panels-O07")
def plasmashell_panels(out: Path, c: Checks):
    """Real plasmashell panels: default panel, height, edge, auto-hide, dodge windows, floating, add/remove a panel."""
    if PLASMASHELL is None:
        raise Skipped("plasmashell is not installed")
    n = 3
    with Session(out) as s:
        infra = {p for p in (getattr(s.kw._kwin, "pid", None), getattr(s.kw._dbus, "pid", None)) if p}
        run_dir = str(s.kw.run_dir)
        try:
            if KAMD is not None:
                start_kamd(s)
            for i in range(1, n + 1):
                s.spawn(i)
            s.load(); s.settle()
            s.kw.spawn([PLASMASHELL, "--no-respawn"], stdout=open(out / "plasmashell.log", "wb"))
            got = until(lambda: len(panel_record(s)) >= 1, 45)
            c("plasmashell created its default panel (a dock window KWin reports)", got, panel_record(s))
            if not got:
                return
            base = s.counters()
            ok, info = (False, {})
            converged = until(lambda: layout_ok(s, n)[0], 10)
            ok, info = layout_ok(s, n)
            c("default panel: tiles fill KWin's work area, none under the panel", converged and ok, info)
            phases = [
                ("height 64", "panels()[0].height = 64"),
                ("edge top", "panels()[0].location = 'top'"),
                ("edge left", "panels()[0].location = 'left'"),
                ("edge bottom", "panels()[0].location = 'bottom'"),
                ("auto-hide on", "panels()[0].hiding = 'autohide'"),
                ("auto-hide off", "panels()[0].hiding = 'none'"),
                ("dodge windows on", "panels()[0].hiding = 'dodgewindows'"),
                ("dodge windows off", "panels()[0].hiding = 'none'"),
                ("floating on", "panels()[0].floating = true"),
                ("floating off", "panels()[0].floating = false"),
                ("add right panel", "var p = new Panel; p.location = 'right'; p.height = 48"),
                ("remove right panel", "panels().forEach(function (p) { if (p.location == 'right') p.remove(); })"),
            ]
            facts = []
            prev = s.counters()
            for name, script in phases:
                before_panels = [d["frame"] for d in panel_record(s)]
                before_area = s.area()
                shell(s, script)
                changed = until(lambda: [d["frame"] for d in panel_record(s)] != before_panels or s.area() != before_area, 8)
                time.sleep(0.3)
                conv = until(lambda: layout_ok(s, n)[0], 10)
                ok, info = layout_ok(s, n)
                now = s.counters()
                d = delta(prev, now)
                prev = now
                facts.append({"phase": name, "applied": changed, "converged": conv, **info,
                              "counters": {k: d.get(k, 0) for k in ("solves", "writes", "corrections", "diverged", "errors")}})
                if not changed:
                    c(f"{name}: not applied by plasmashell (recorded, not judged)", True, info)
                    continue
                c(f"{name}: tiles fill the new work area, none under a reserving panel", conv and ok, info)
                c(f"{name}: bounded work (corrections <= {2 * n}, no divergence, no errors)",
                  d.get("corrections", 0) <= 2 * n and d.get("diverged", 0) == 0 and d.get("errors", 0) == 0, d)
            end = s.counters()
            c("no model errors over all phases", delta(base, end).get("errors", 0) == 0, delta(base, end))
            EVIDENCE["plasmashell-panels-O07"] = {"phases": facts}
            (out / "evidence.json").write_text(json.dumps(facts, indent=1))
        finally:
            # plasmashell and whatever it activated on the private bus; KWin, the bus and their own
            # children (Xwayland, activated services) go with the session and are swept after it.
            sweep(run_dir, descendants_of(infra))
    sweep(run_dir, set())
