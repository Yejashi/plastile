"""Scrolling layout scenarios (experimental, docs/design/SCROLLING.md §6) in nested KWin.

Geometry and output membership are judged by the oracle (one-shot KWin scripts reading real
frames and `window.output`); Plastile's counters give amounts of work and its context summary
says which context a window belongs to. The nested virtual backend cannot show where pixels
land on real monitors or whether a parked window takes pointer input: those stay physical-session
checks (SCROLLING §6).
"""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from harness import Listener, Session, fixture_events, overlaps
from scenarios import Checks, scenario

SCROLL = {"layout": "scrolling"}
ERRORS = r"plastile (error|warn)|TypeError|ReferenceError"
SCREENS = ("emit(workspace.screens.map(o => ({name: o.name, x: o.geometry.x, y: o.geometry.y,"
           " width: o.geometry.width, height: o.geometry.height})))")


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def outputs(s: Session) -> dict[str, dict]:
    return {o["name"]: {k: o[k] for k in ("x", "y", "width", "height")} for o in json.loads(s.js(SCREENS)[0])}


def area_of(s: Session, name: str) -> dict:
    out = s.js(f"const o = workspace.screens.find(x => x.name === {json.dumps(name)}); const a = workspace.clientArea("
               f"workspace.MaximizeArea, o, workspace.currentDesktopForScreen(o)); emit({{x: a.x, y: a.y, width: a.width,"
               f" height: a.height}});")
    return json.loads(out[0])


def inside(outer: dict, r: dict, tol: float = 0.5) -> bool:
    return (r["x"] >= outer["x"] - tol and r["y"] >= outer["y"] - tol and
            r["x"] + r["width"] <= outer["x"] + outer["width"] + tol and
            r["y"] + r["height"] <= outer["y"] + outer["height"] + tol)


def classify(s: Session) -> dict:
    """Oracle: which fixtures are visible on an output and which are off every output."""
    outs = outputs(s)
    frames = s.frames_list()
    parked = [f["caption"] for f in frames if not any(overlaps(f["frame"], o) for o in outs.values())]
    visible = [f["caption"] for f in frames if f["caption"] not in parked]
    return {"parked": sorted(parked), "visible": sorted(visible), "frames": {f["caption"]: f["frame"] for f in frames},
            "output": {f["caption"]: f["output"] for f in frames}, "active": [f["caption"] for f in frames if f["active"]],
            "outputs": outs}


def strip_errors(s: Session, output: str = "Virtual-0") -> list[str]:
    """Visible windows inside their output's work area without overlap; parked ones off every output on `output`."""
    k = classify(s)
    area = area_of(s, output)
    errs = []
    vis = [c for c in k["visible"]]
    for c in vis:
        if not inside(area, k["frames"][c]):
            errs.append(f"{c} visible but not inside the work area: {k['frames'][c]}")
    for i, a in enumerate(vis):
        for b in vis[i + 1:]:
            if overlaps(k["frames"][a], k["frames"][b]):
                errs.append(f"{a} overlaps {b}")
    for c in k["parked"]:
        if k["output"][c] != output:
            errs.append(f"{c} parked but KWin assigns it to {k['output'][c]}")
    for c in k["active"]:
        if c in k["parked"]:
            errs.append(f"active {c} is parked")
    return errs


def contexts(s: Session) -> list[dict]:
    return [x for x in s.counters()["contexts"] if x["members"] > 0]


def start(s: Session, n: int = 4) -> None:
    for i in range(1, n + 1):
        s.spawn(i)
    s.load()
    s.settle()
    # Activate in order, as a user opening and using windows would: the last one ends focused.
    for i in range(1, n + 1):
        s.act(fx(i), "workspace.activeWindow = w")
        s.settle()


@scenario("scrolling-park-M8")
def scrolling_park(out: Path, c: Checks):
    """Two outputs: columns that do not fit are parked off every output, nearest their own output by
    KWin's own assignment; focus commands scroll with position-only writes."""
    with Session(out, outputs=2, config=SCROLL) as s:
        start(s)
        k = classify(s)
        c("setup: four fixtures on Virtual-0", all(o == "Virtual-0" for o in k["output"].values()), k["output"])
        c("half-width columns: two visible, two parked off every output (oracle)",
          len(k["visible"]) == 2 and len(k["parked"]) == 2 and fx(4) in k["visible"], k)
        errs = strip_errors(s)
        c("visible tiles inside the work area without overlap; parked windows keep output Virtual-0 (oracle)", not errs,
          {"errors": errs, "state": k})
        c("one context holds all four windows", [x["members"] for x in contexts(s)] == [4], contexts(s))
        # Focus left three times, then right three times: every step keeps the focus visible.
        sizes = {cap: (f["width"], f["height"]) for cap, f in k["frames"].items()}
        marks = {i: len(fixture_events(s.fixtures[i].log, "configure")) for i in range(1, 5)}
        a = s.counters()
        steps = []
        for cmd in ("left", "left", "left", "right", "right", "right"):
            s.cmd(f"focus.{cmd}")
            s.settle()
            kk = classify(s)
            steps.append({"cmd": cmd, "active": kk["active"], "visible": kk["visible"], "errors": strip_errors(s)})
        b = s.counters()
        c("focus left/right: the active window is always visible and the strip oracle holds at every step",
          all(st["active"] and st["active"][0] in st["visible"] and not st["errors"] for st in steps), steps)
        k2 = classify(s)
        same_size = all((f["width"], f["height"]) == sizes[cap] for cap, f in k2["frames"].items())
        # Client-side view: configures after the mark carry only the size the client already had
        # (KWin also sends configures for activation-state changes, with the current size).
        resized = {}
        for i in range(1, 5):
            evs = fixture_events(s.fixtures[i].log, "configure")
            before = [(e["width"], e["height"]) for e in evs[:marks[i]] if e.get("width", 0) > 0]
            resized[i] = [e for e in evs[marks[i]:] if e.get("width", 0) > 0 and (not before or
                          (e["width"], e["height"]) != before[-1])]
        writes = b["counters"]["writes"] - a["counters"]["writes"]
        c("scrolling is position-only: no frame changed size (oracle) and Plastile wrote positions",
          same_size and writes > 0, {"writes": writes, "frames": k2["frames"], "sizes": sizes})
        c("no client received a configure for a new size during scrolling (fixture logs)",
          all(not v for v in resized.values()), {"configures": {i: v[:3] for i, v in resized.items()}})
        c("no errors or warnings logged", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])


@scenario("scrolling-activate-parked-M8")
def scrolling_activate(out: Path, c: Checks):
    """Activating a parked window the way Alt+Tab or an application does scrolls it into view."""
    with Session(out, outputs=2, config=SCROLL) as s:
        start(s)
        k = classify(s)
        target = k["parked"][0] if k["parked"] else fx(1)
        c("precondition: a parked window exists", bool(k["parked"]), k)
        s.act(target, "workspace.activeWindow = w")
        s.settle()
        k2 = classify(s)
        c("the activated window is visible inside the work area (oracle)",
          target in k2["visible"] and inside(area_of(s, "Virtual-0"), k2["frames"][target]), k2)
        errs = strip_errors(s)
        c("strip oracle after activation", not errs, errs)
        c("no errors or warnings logged", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])


@scenario("scrolling-topology-M8")
def scrolling_topology(out: Path, c: Checks):
    """An output topology change (scale of the neighbour) may pull parked windows back (E15); the
    topology flush re-solves and parks them again, and their context does not change."""
    with Session(out, outputs=2, config=SCROLL) as s:
        start(s)
        k = classify(s)
        c("precondition: two parked", len(k["parked"]) == 2, k)
        lis = Listener(s, frames=tuple(k["parked"]))
        off = s.kw.mark()
        r = subprocess.run(["kscreen-doctor", "output.Virtual-1.scale.1.5"], env=s.kw.client_env(), capture_output=True,
                           text=True, timeout=15)
        time.sleep(1.0)
        s.settle(); time.sleep(0.3); s.settle()
        k2 = classify(s)
        # KWin's checkWorkspacePosition pulls an off-screen window partly back on a topology change
        # (E15); measured here for windows parked above their output too (y -848 -> -584).
        signals = lis.lines("frame", off)
        pulled = []
        for ln in signals:
            g = json.loads(ln.rsplit(" ", 1)[1])
            if g[1] + g[3] > 0:
                pulled.append(ln)
        c("precondition: KWin pulled parked windows partly back on screen during the change (independent listener)",
          bool(pulled), signals)
        lis.close()
        c("topology changed (kscreen-doctor exit 0; Virtual-1 is narrower in logical px)",
          r.returncode == 0 and k2["outputs"]["Virtual-1"]["width"] < 1280, {"code": r.returncode, "outputs": k2["outputs"]})
        errs = strip_errors(s)
        c("after the change: the same two windows are parked off every output again, oracle holds",
          k2["parked"] == k["parked"] and not errs, {"errors": errs, "before": k["parked"], "after": k2})
        c("one context still holds all four windows", [x["members"] for x in contexts(s)] == [4], contexts(s))

        # A parked window dragged partly onto the neighbour by someone else (as KWin's pull-back does):
        # KWin reassigns its output, Plastile keeps it in its strip and parks it again.
        victim = k2["parked"][0]
        o1 = k2["outputs"]["Virtual-1"]
        # The output is read in the same one-shot script, right after the move: Plastile's response
        # comes on a later event-loop turn.
        moved = s.js(f"const w = workspace.windowList().find(x => x.caption === {json.dumps(victim)});\n"
                     f"w.frameGeometry = {{x: {o1['x'] - 100}, y: 100, width: w.frameGeometry.width, "
                     f"height: w.frameGeometry.height}};\nemit(w.output ? w.output.name : null);")
        reassigned = json.loads(moved[0]) if moved else None
        time.sleep(0.3)
        s.settle(); time.sleep(0.3); s.settle()
        k3 = classify(s)
        c("KWin reassigned the moved window's output (precondition, oracle)", reassigned == "Virtual-1",
          {"output": reassigned})
        c("the window stays in its strip's context and is parked again (oracle + context summary)",
          victim in k3["parked"] and [x["members"] for x in contexts(s)] == [4] and not strip_errors(s),
          {"state": k3, "contexts": contexts(s), "errors": strip_errors(s)})
        c("no errors logged", not s.log_lines(r"plastile error|TypeError|ReferenceError"),
          s.log_lines(r"plastile error|TypeError|ReferenceError")[:5])


@scenario("scrolling-unload-M8")
def scrolling_unload(out: Path, c: Checks):
    """Unload, suspend and a layout switch with parked windows leave every window inside an output."""
    with Session(out, outputs=2, config=SCROLL) as s:
        start(s)
        c("precondition: two parked", len(classify(s)["parked"]) == 2, classify(s))
        s.cmd("runtime.toggle-suspend")
        time.sleep(0.4)
        k = classify(s)
        area = area_of(s, "Virtual-0")
        c("suspend: nothing parked, every window inside Virtual-0's work area (oracle)",
          not k["parked"] and all(inside(area, f) for f in k["frames"].values()), k)
        s.cmd("runtime.toggle-suspend")
        s.settle()
        c("resume: parked again", len(classify(s)["parked"]) == 2, classify(s))
        s.cmd("layout.master-stack")
        s.settle()
        k = classify(s)
        c("layout switch: nothing parked, every window inside the work area (oracle)",
          not k["parked"] and all(inside(area, f) for f in k["frames"].values()), k)
        s.cmd("layout.scrolling")
        s.settle()
        c("back to scrolling: parked again", len(classify(s)["parked"]) == 2, classify(s))
        s.unload()
        time.sleep(0.4)
        k = classify(s)
        c("unload: nothing parked, every window inside Virtual-0's work area (oracle)",
          not k["parked"] and all(inside(area, f) for f in k["frames"].values()), k)
        c("no errors logged", not s.log_lines(r"plastile error|TypeError|ReferenceError"),
          s.log_lines(r"plastile error|TypeError|ReferenceError")[:5])


@scenario("scrolling-pullback-M8")
def scrolling_pullback(out: Path, c: Checks):
    """KWin 6.8 confines a window to the work area on every configure-acknowledging commit, which pulls a
    parked column back on activation, scale or decoration changes (measured in the 6.8 CI run). Simulated
    here by a script moving a parked window back inside the output (position only), three times with an
    activation in between: each pull-back is re-parked, the correction budget is untouched, nothing
    diverges, and the strip oracle holds."""
    with Session(out, outputs=1, config=SCROLL) as s:
        start(s)
        k = classify(s)
        c("setup: at least one parked column", len(k["parked"]) >= 1, k)
        victim = k["parked"][0]
        a = s.counters()
        rounds = []
        for i in range(3):
            f = s.frames()[victim]["frame"]
            s.act(victim, f"w.frameGeometry = {{x: 40, y: 40, width: {f['width']}, height: {f['height']}}}")
            time.sleep(0.3); s.settle()
            kk = classify(s)
            rounds.append({"parked": victim in kk["parked"], "errors": strip_errors(s)})
            s.act(kk["active"][0] if kk["active"] else fx(4), "workspace.activeWindow = w")
            time.sleep(0.2); s.settle()
        b = s.counters()
        d = {k_: b["counters"][k_] - a["counters"][k_] for k_ in ("reparks", "corrections", "diverged")}
        c("each pull-back is re-parked and the strip oracle holds (oracle)",
          all(r["parked"] and not r["errors"] for r in rounds), rounds)
        c("re-parks counted, correction budget untouched, nothing diverged (counters)",
          d["reparks"] >= 3 and d["corrections"] == 0 and d["diverged"] == 0, d)
