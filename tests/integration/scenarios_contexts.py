"""Context scenarios: per-output virtual desktops (O08) and activities (E08).

Geometry is judged by the oracle (one-shot KWin scripts). Plastile's counters gate the
amount of work (solves); its trace (`inspect.dump-trace`) attributes frame writes to
windows. A passive plain-JS listener (probes/contexts/listen.js) records the argument
shapes of KWin's desktop/activity signals. Everything runs in disposable nested KWin
sessions; kactivitymanagerd, when used, runs on the nested private bus only.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from scenarios import scenario, Checks, Skipped
from harness import Session, near, tiling_errors, ROOT
import sysinfo  # tools/ is on sys.path via harness  # noqa: E402

LISTENER = ROOT / "probes/contexts/listen.js"
KAMD = sysinfo.find_helper("kactivitymanagerd")  # /usr/lib (Arch), /usr/lib/<triplet>/libexec (Debian)
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
NIL_UUID = "00000000-0000-0000-0000-000000000000"
ERRORS = r"plastile (error|warn)|TypeError|ReferenceError"
GAP = 8
FACTS: dict[str, dict] = {}  # scenario name -> observed API facts (written to report via checks)


class PerOutputSession(Session):
    """Session with KWin's per-output virtual desktops enabled ([Windows] PerOutputVirtualDesktops)."""

    def kwinrc(self) -> str:
        return super().kwinrc() + "\n[Windows]\nPerOutputVirtualDesktops=true\n"


# ------------------------------------------------------------------ helpers
def full(area: dict) -> dict:
    return {"x": area["x"] + GAP, "y": area["y"] + GAP, "width": area["width"] - 2 * GAP, "height": area["height"] - 2 * GAP}


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def listen(s: Session) -> int:
    off = s.kw.mark()
    s.kw.load_script(LISTENER, "plt-contexts-listen")
    s.kw.wait_log(r"PLT-LISTEN ready", 5, off)
    return off


def unlisten(s: Session) -> None:
    try:
        s.kw.unload("plt-contexts-listen")
    except Exception:
        pass


def events(s: Session, name: str, offset: int = 0) -> list[dict]:
    tag = f"PLT-LISTEN {name} "
    return [json.loads(ln.split(tag, 1)[1]) for ln in s.log_lines(re.escape(tag), offset)]


def trace(s: Session) -> list[dict]:
    off = s.kw.mark()
    s.cmd("inspect.dump-trace")
    line = s.kw.wait_log(r"plastile trace ", 5, off)[-1]
    return json.loads(line.split("plastile trace ", 1)[1])


def writes_since(before: list[dict], after: list[dict]) -> dict[str, int]:
    """Frame writes per window id recorded after the `before` snapshot (same ring, no wrap)."""
    t0 = max((r["t"] for r in before), default=float("-inf"))
    seen = {json.dumps(r, sort_keys=True) for r in before if r["t"] == t0}
    out: dict[str, int] = {}
    for r in after:
        if r.get("kind") != "write":
            continue
        if r["t"] < t0 or (r["t"] == t0 and json.dumps(r, sort_keys=True) in seen):
            continue
        out[r["id"]] = out.get(r["id"], 0) + 1
    return out


def solves(c: dict) -> int:
    return c["counters"]["solves"]


def ids(s: Session) -> dict[str, str]:
    return {f["caption"]: f["id"] for f in s.frames_list()}


def activate(s: Session, i: int) -> None:
    s.act(fx(i), "workspace.activeWindow = w")
    time.sleep(0.05)


def per_screen(s: Session) -> dict[str, str]:
    out = s.js("emit(workspace.screens.map(o => [o.name, workspace.currentDesktopForScreen(o).name]))")
    return dict(json.loads(out[0]))


def explain(s: Session, i: int) -> dict:
    activate(s, i)
    off = s.kw.mark()
    s.cmd("inspect.explain-window")
    line = s.kw.wait_log(r"plastile info explain ", 5, off)[-1]
    return json.loads(line.split("plastile info explain ", 1)[1])


def frames_of(s: Session, nums) -> dict[int, dict]:
    f = s.frames()
    return {i: f[fx(i)] for i in nums}


def unchanged(a: dict[int, dict], b: dict[int, dict]) -> bool:
    return all(near(a[i]["frame"], b[i]["frame"], 0.5) for i in a)


# ---------------------------------------------------------------- O08
@scenario("per-output-desktops-O08")
def per_output_desktops(out: Path, c: Checks):
    facts: dict = {}
    with PerOutputSession(out, outputs=2, config={"traceCapacity": 8192}) as s:
        facts["optionPerOutputVirtualDesktops"] = json.loads(s.js("emit(options.perOutputVirtualDesktops)")[0])
        off = listen(s)
        s.js("workspace.createDesktop(1, 'Two'); emit(1)")
        names = json.loads(s.js("emit(workspace.desktops.map(d => d.name))")[0])
        c("setup: per-output desktops enabled and two desktops", facts["optionPerOutputVirtualDesktops"] is True
          and names == ["Desktop 1", "Two"], (dict(facts), names))
        for i in range(1, 6):
            s.spawn(i)
        s.load(); s.settle()
        for i in (3, 4, 5):
            activate(s, i)
            s.cmd("move.output-next"); s.settle()
        place = {f["caption"]: f["output"] for f in s.frames_list()}
        c("setup: fixtures 1,2 on Virtual-0 and 3,4,5 on Virtual-1",
          [place[fx(i)] for i in range(1, 6)] == ["Virtual-0"] * 2 + ["Virtual-1"] * 3, place)
        wid = ids(s)
        # Send one window per output to desktop Two while both outputs show Desktop 1.
        t_send = trace(s)
        activate(s, 2); s.cmd("move.desktop-next"); s.settle()
        activate(s, 5); s.cmd("move.desktop-next"); s.settle()
        sent = frames_of(s, (2, 5))
        two = json.loads(s.js("emit(workspace.desktops[1].id)")[0])
        c("setup: fixtures 2 and 5 are on desktop Two", all(sent[i]["desktops"] == [two] for i in (2, 5)),
          {i: sent[i]["desktops"] for i in (2, 5)})
        facts["currentDesktopForScreenInitial"] = per_screen(s)
        a0, a1 = s.area(0), s.area(1)
        f = s.frames()
        v0 = [f[fx(1)]]
        v1 = [f[fx(3)], f[fx(4)]]
        c("O08: Virtual-0 visible context (Desktop 1) tiled inside Virtual-0",
          near(v0[0]["frame"], full(a0), 1.0) and not tiling_errors(v0, a0, GAP), (a0, v0[0]["frame"]))
        c("O08: Virtual-1 visible context (Desktop 1) tiled inside Virtual-1",
          not tiling_errors(v1, a1, GAP) and all(x["frame"]["height"] > a1["height"] - 2 * GAP - 1 for x in v1),
          (a1, [x["frame"] for x in v1], tiling_errors(v1, a1, GAP)))
        # Give the hidden contexts time to (wrongly) be solved, then attribute writes.
        time.sleep(1.0)
        t_hidden = trace(s)
        w = writes_since(t_send, t_hidden)
        later = frames_of(s, (2, 5))
        c("O08: windows on non-visible contexts receive no writes after leaving",
          w.get(wid[fx(2)], 0) == 0 and w.get(wid[fx(5)], 0) == 0 and unchanged(sent, later),
          {"writes": {k: w.get(wid[k], 0) for k in (fx(2), fx(5))}, "frames": {i: later[i]["frame"] for i in later}})

        # Switch only Virtual-1 to desktop Two.
        keep0 = frames_of(s, (1, 2))
        b = s.counters()
        mark = s.kw.mark()
        s.js("workspace.setCurrentDesktopForScreen(workspace.desktops[1], workspace.screens[1]); emit(1)")
        time.sleep(0.6)
        a = s.settle()
        t_sw = trace(s)
        facts["currentDesktopForScreenAfterV1Switch"] = per_screen(s)
        facts["workspaceCurrentDesktopAfterV1Switch"] = json.loads(s.js("emit([workspace.currentDesktop.name, workspace.activeScreen.name])")[0])
        ev = events(s, "currentDesktopChanged", mark)
        facts["currentDesktopChangedOnV1Switch"] = [e["args"] for e in ev]
        w = writes_since(t_hidden, t_sw)
        f = s.frames()
        a1 = s.area(1)
        c("O08: per-output switch changes only Virtual-1",
          facts["currentDesktopForScreenAfterV1Switch"] == {"Virtual-0": "Desktop 1", "Virtual-1": "Two"},
          facts["currentDesktopForScreenAfterV1Switch"])
        c("O08: switching Virtual-1 re-solves exactly one context", solves(a) - solves(b) == 1,
          {"solves": solves(a) - solves(b), "contexts": a["contexts"]})
        c("O08: shown context tiled inside Virtual-1", near(f[fx(5)]["frame"], full(a1), 1.0), (a1, f[fx(5)]["frame"]))
        c("O08: Virtual-0 windows untouched by the Virtual-1 switch",
          unchanged(keep0, frames_of(s, (1, 2))) and w.get(wid[fx(1)], 0) == 0 and w.get(wid[fx(2)], 0) == 0,
          {k: w.get(wid[k], 0) for k in (fx(1), fx(2))})
        c("O08: only the shown window was written", set(w) <= {wid[fx(5)]}, {k: v for k, v in w.items()})

        # Switch Virtual-1 back: its Desktop 1 context is already applied.
        keep1 = frames_of(s, (1, 3, 4))
        b = s.counters()
        s.js("workspace.setCurrentDesktopForScreen(workspace.desktops[0], workspace.screens[1]); emit(1)")
        time.sleep(0.6)
        a = s.settle()
        facts["solvesSwitchingBackToAppliedContext"] = solves(a) - solves(b)
        c("O08: switching back to an applied context leaves its windows in place",
          unchanged(keep1, frames_of(s, (1, 3, 4))), {i: v["frame"] for i, v in frames_of(s, (1, 3, 4)).items()})

        # Switch only Virtual-0 to Two: the other hidden context is placed, Virtual-1 is untouched.
        keep1 = frames_of(s, (3, 4, 5))
        b = s.counters()
        t_b = trace(s)
        mark = s.kw.mark()
        s.js("workspace.setCurrentDesktopForScreen(workspace.desktops[1], workspace.screens[0]); emit(1)")
        time.sleep(0.6)
        a = s.settle()
        w = writes_since(t_b, trace(s))
        facts["currentDesktopChangedOnV0Switch"] = [e["args"] for e in events(s, "currentDesktopChanged", mark)]
        facts["workspaceCurrentDesktopAfterV0Switch"] = json.loads(s.js("emit([workspace.currentDesktop.name, workspace.activeScreen.name])")[0])
        a0 = s.area(0)
        f = s.frames()
        c("O08: switching Virtual-0 re-solves exactly one context", solves(a) - solves(b) == 1, solves(a) - solves(b))
        c("O08: Virtual-0 desktop Two tiled inside Virtual-0", near(f[fx(2)]["frame"], full(a0), 1.0), (a0, f[fx(2)]["frame"]))
        c("O08: Virtual-1 untouched by the Virtual-0 switch",
          unchanged(keep1, frames_of(s, (3, 4, 5))) and not any(w.get(wid[fx(i)], 0) for i in (3, 4, 5)),
          {fx(i): w.get(wid[fx(i)], 0) for i in (3, 4, 5)})
        errs = s.log_lines(ERRORS, off)
        c("O08: no Plastile errors or JS exceptions", not errs, errs[:3])
        unlisten(s)
    FACTS["per-output-desktops-O08"] = facts
    c("facts (recorded, always passes)", True, facts)


# ---------------------------------------------------------------- E08
def kamd_available() -> bool:
    return KAMD is not None


def activity_state(s: Session) -> dict:
    return json.loads(s.js("emit({activities: Array.from(workspace.activities).map(String), "
                           "current: String(workspace.currentActivity)})")[0])


def start_kamd(s: Session, timeout: float = 15.0) -> dict:
    s.kw.spawn([KAMD])
    deadline = time.monotonic() + timeout
    st = activity_state(s)
    while time.monotonic() < deadline:
        st = activity_state(s)
        if st["activities"] and UUID.match(st["current"]) and NIL_UUID not in st["activities"]:
            return st
        time.sleep(0.2)
    raise RuntimeError(f"kactivitymanagerd did not publish activities: {st}")


def add_activity(s: Session, name: str) -> str:
    new = s.kw.call("/ActivityManager/Activities", "org.kde.ActivityManager.Activities", "AddActivity", "s", name,
                    service="org.kde.ActivityManager")[0]
    s.wait_for(lambda: new in activity_state(s)["activities"], 10, f"activity {name} visible to KWin")
    return new


def set_activity(s: Session, act: str) -> None:
    s.js(f"workspace.currentActivity = {json.dumps(act)}; emit(1)")
    s.wait_for(lambda: activity_state(s)["current"] == act, 10, f"current activity {act}")


def window_acts(s: Session) -> dict[str, list]:
    out = s.js("emit(workspace.windowList().filter(w => w.resourceClass === 'plastile-fixture')"
               ".map(w => [w.caption, Array.from(w.activities).map(String), w.onAllActivities === undefined ? 'undefined' : w.onAllActivities]))")
    return {k: {"activities": v, "onAllActivities": o} for k, v, o in json.loads(out[0])}


@scenario("activities-E08")
def activities(out: Path, c: Checks):
    facts: dict = {}
    if not kamd_available():
        raise Skipped("kactivitymanagerd not found (PATH, /usr/lib, libexec): E08 needs the activity service")
    with Session(out, config={"traceCapacity": 8192}) as s:
        facts["withoutService"] = activity_state(s)
        off = listen(s)
        facts["withService"] = start_kamd(s)
        A = facts["withService"]["current"]
        mark = s.kw.mark()
        B = add_activity(s, "Two")
        time.sleep(0.3)
        facts["signalsOnAddActivity"] = {n: [e["args"] for e in events(s, n, mark)]
                                         for n in ("activityAdded", "activitiesChanged", "currentActivityChanged")}
        c("setup: two activities, current is a UUID", UUID.match(A) is not None and UUID.match(B) is not None
          and len(activity_state(s)["activities"]) == 2, activity_state(s))
        for i in (1, 2, 3):
            s.spawn(i)
        facts["newWindowActivities"] = window_acts(s)[fx(1)]
        s.load(); s.settle()
        area = s.area()
        f = s.frames_list()
        c("E08: windows on the current activity tile", len(f) == 3 and not tiling_errors(f, area, GAP), tiling_errors(f, area, GAP))
        wid = ids(s)

        # All activities: activities = [] (ADR-009: floats).
        mark = s.kw.mark()
        s.act(fx(3), "w.activities = []")
        time.sleep(0.5); s.settle()
        facts["allActivitiesRepresentation"] = window_acts(s)[fx(3)]
        facts["windowActivitiesChangedOnAll"] = events(s, "windowActivitiesChanged", mark)
        e3 = explain(s, 3)
        facts["allActivitiesDecision"] = e3.get("decision")
        f = s.frames()
        pair = [f[fx(1)], f[fx(2)]]
        c("E08: all-activities window reads back as an empty activities list",
          facts["allActivitiesRepresentation"]["activities"] == [], facts["allActivitiesRepresentation"])
        c("E08: all-activities window floats (ADR-009)", e3.get("mode") == "floating", e3.get("decision"))
        c("E08: remaining two re-tile", not tiling_errors(pair, area, GAP) and all(x["frame"]["height"] > area["height"] - 2 * GAP - 1
          for x in pair), [x["frame"] for x in pair])
        float3 = frames_of(s, (3,))

        # Two windows that belong to activity B only (hidden while A is current).
        s.spawn(4); s.spawn(5); s.settle()
        wid = ids(s)
        t_b = trace(s)
        # Both leave in one one-shot script: moving them separately would legitimately re-tile 5 on A in between.
        s.js(f"workspace.windowList().filter(w => w.caption === {json.dumps(fx(4))} || w.caption === {json.dumps(fx(5))})"
             f".forEach(w => {{ w.activities = [{json.dumps(B)}]; }}); emit(1)")
        time.sleep(0.5); s.settle()
        onB = frames_of(s, (4, 5))
        time.sleep(0.8)
        t_h = trace(s)
        w = writes_since(t_b, t_h)
        c("E08: windows moved to a hidden activity receive no writes",
          w.get(wid[fx(4)], 0) == 0 and w.get(wid[fx(5)], 0) == 0 and unchanged(onB, frames_of(s, (4, 5))),
          {fx(i): w.get(wid[fx(i)], 0) for i in (4, 5)})
        f = s.frames()
        pair = [f[fx(1)], f[fx(2)]]
        c("E08: activity A re-tiled as two after 4 and 5 left", not tiling_errors(pair, area, GAP) and
          all(x["frame"]["height"] > area["height"] - 2 * GAP - 1 for x in pair), [x["frame"] for x in pair])
        keepA = frames_of(s, (1, 2, 3))

        # Switch to B.
        b = s.counters()
        mark = s.kw.mark()
        set_activity(s, B)
        time.sleep(0.6)
        a = s.settle()
        w = writes_since(t_h, trace(s))
        facts["currentActivityChangedArgs"] = [e["args"] for e in events(s, "currentActivityChanged", mark)]
        facts["currentDesktopChangedOnActivitySwitch"] = len(events(s, "currentDesktopChanged", mark))
        facts["solvesSwitchToB"] = solves(a) - solves(b)
        f = s.frames()
        onB = [f[fx(4)], f[fx(5)]]
        c("E08: switching activity re-solves once", solves(a) - solves(b) == 1, {"solves": solves(a) - solves(b),
          "contexts": a["contexts"]})
        c("E08: the other activity's windows are placed", not tiling_errors(onB, area, GAP) and
          all(x["frame"]["height"] > area["height"] - 2 * GAP - 1 for x in onB), [x["frame"] for x in onB])
        c("E08: activity A windows and the all-activities window untouched",
          unchanged(keepA, frames_of(s, (1, 2, 3))) and not any(w.get(wid[fx(i)], 0) for i in (1, 2, 3)),
          {fx(i): w.get(wid[fx(i)], 0) for i in (1, 2, 3)})

        # Switch back to A.
        keepB = frames_of(s, (4, 5))
        b = s.counters()
        t_b = trace(s)
        set_activity(s, A)
        time.sleep(0.6)
        a = s.settle()
        w = writes_since(t_b, trace(s))
        facts["solvesSwitchBackToA"] = solves(a) - solves(b)
        c("E08: switching back restores activity A layout", unchanged(keepA, frames_of(s, (1, 2, 3))),
          {i: v["frame"] for i, v in frames_of(s, (1, 2, 3)).items()})
        c("E08: switching back writes nothing (A was applied)", sum(w.values()) == 0 and solves(a) - solves(b) == 0,
          {"writes": sum(w.values()), "solves": solves(a) - solves(b)})
        c("E08: activity B windows untouched while hidden", unchanged(keepB, frames_of(s, (4, 5))))
        c("E08: all-activities window never written", unchanged(float3, frames_of(s, (3,))))
        errs = s.log_lines(ERRORS, off)
        c("E08: no Plastile errors or JS exceptions", not errs, errs[:3])
        unlisten(s)
    FACTS["activities-E08"] = facts
    c("facts (recorded, always passes)", True, facts)


def tiled_view(s: Session, nums, area: dict) -> tuple[list[str], dict]:
    """Oracle geometry for the windows Plastile classifies as tiled (classification read from explain)."""
    modes = {i: explain(s, i).get("mode") for i in nums}
    f = s.frames()
    tiled = [f[fx(i)] for i in nums if modes[i] == "tiled"]
    return tiling_errors(tiled, area, GAP), modes


def orphaned(cnt: dict, activities: list[str]) -> list[dict]:
    """Contexts with members whose activity key is not a real activity (can never become visible)."""
    out = []
    for ctx in cnt["contexts"]:
        act = ctx["id"].split("\u241f")[-1]
        if ctx["members"] > 0 and act not in activities:
            out.append({"activity": act, "members": ctx["members"], "revision": ctx["revision"], "applied": ctx["applied"]})
    return out


@scenario("activities-late-service-E08")
def activities_late(out: Path, c: Checks):
    """The activity service appears after Plastile adopted windows (e.g. kactivitymanagerd started late).

    Observed: windows mapped before the service report activities == [] (all activities) and keep
    that after the service starts. Under ADR-009 they are multi-activity windows and must float once a
    second activity exists, or at least must not stay tiled in a context that can never be visible.
    """
    facts: dict = {}
    if not kamd_available():
        raise Skipped("kactivitymanagerd not found (PATH, /usr/lib, libexec): E08 needs the activity service")
    with Session(out, config={"traceCapacity": 8192}) as s:
        off = listen(s)
        for i in (1, 2, 3):
            s.spawn(i)
        facts["windowActivitiesWithoutService"] = window_acts(s)[fx(1)]
        s.load(); s.settle()
        area = s.area()
        mark = s.kw.mark()
        A = start_kamd(s)["current"]
        time.sleep(0.8); s.settle()
        facts["windowActivitiesAfterServiceStart"] = window_acts(s)[fx(1)]
        facts["signalsOnServiceStart"] = {n: [e["args"] for e in events(s, n, mark)] for n in
                                          ("activitiesChanged", "activityAdded", "currentActivityChanged")}
        facts["windowActivitiesChangedOnServiceStart"] = len(events(s, "windowActivitiesChanged", mark))
        f = s.frames_list()
        c("late: still tiled after the service starts (one activity)", not tiling_errors(f, area, GAP), tiling_errors(f, area, GAP))
        B = add_activity(s, "Two")
        time.sleep(0.5); s.settle()
        acts = activity_state(s)["activities"]
        e1 = explain(s, 1)
        facts["adoptedWindowAfterSecondActivity"] = {"context": e1.get("context"), "mode": e1.get("mode"), "decision": e1.get("decision")}
        orph = orphaned(s.counters(), acts)
        facts["orphanedContextsAfterSecondActivity"] = orph
        c("late: no tiled context keyed to a non-existent activity after a second activity appears", not orph, orph)
        s.spawn(4); s.settle()
        errs, modes = tiled_view(s, (1, 2, 3, 4), area)
        facts["modesOnA"] = modes
        c("late: windows Plastile tiles on A do not overlap (oracle)", not errs, {"errors": errs, "modes": modes})
        set_activity(s, B)
        time.sleep(0.5); s.settle()
        s.spawn(5); time.sleep(0.3); s.settle()
        errs, modes = tiled_view(s, (1, 2, 3, 5), area)
        facts["modesOnB"] = modes
        c("late: windows Plastile tiles on B do not overlap (oracle)", not errs, {"errors": errs, "modes": modes})
        set_activity(s, A)
        time.sleep(0.5); s.settle()
        errs, modes = tiled_view(s, (1, 2, 3, 4), area)
        c("late: back on A, tiled windows do not overlap (oracle)", not errs, {"errors": errs, "modes": modes})
        errs = s.log_lines(ERRORS, off)
        c("late: no Plastile errors or JS exceptions", not errs, errs[:3])
        unlisten(s)
    FACTS["activities-late-service-E08"] = facts
    c("facts (recorded, always passes)", True, facts)


@scenario("activities-add-second-E08")
def activities_add_second(out: Path, c: Checks):
    """The service runs with one activity; the user creates a second while windows are tiled.

    With one activity Plastile collapses the activity dimension (key "default"); windows here
    report activities == [A] (a real single activity), so after B appears they are single-context
    windows of A and must keep tiling with new windows on A.
    """
    facts: dict = {}
    if not kamd_available():
        raise Skipped("kactivitymanagerd not found (PATH, /usr/lib, libexec): E08 needs the activity service")
    with Session(out, config={"traceCapacity": 8192}) as s:
        off = listen(s)
        A = start_kamd(s)["current"]
        for i in (1, 2, 3):
            s.spawn(i)
        facts["windowActivitiesWithOneActivity"] = window_acts(s)[fx(1)]
        s.load(); s.settle()
        area = s.area()
        e1 = explain(s, 1)
        facts["contextWithOneActivity"] = e1.get("context")
        B = add_activity(s, "Two")
        time.sleep(0.5); s.settle()
        acts = activity_state(s)["activities"]
        e1 = explain(s, 1)
        facts["contextAfterSecondActivity"] = e1.get("context")
        orph = orphaned(s.counters(), acts)
        c("add-second: no tiled context keyed to a non-existent activity", not orph, orph)
        s.spawn(4); s.settle()
        f = s.frames_list()
        c("add-second: a new window on A tiles with the existing three (oracle)", len(f) == 4 and not tiling_errors(f, area, GAP),
          tiling_errors(f, area, GAP))
        keepA = frames_of(s, (1, 2, 3, 4))
        set_activity(s, B)
        time.sleep(0.5); s.settle()
        s.spawn(5); time.sleep(0.3); s.settle()
        f5 = s.frames()[fx(5)]
        c("add-second: a window opened on B tiles alone", near(f5["frame"], full(area), 1.0), f5["frame"])
        set_activity(s, A)
        time.sleep(0.5); s.settle()
        c("add-second: back on A, layout restored", unchanged(keepA, frames_of(s, (1, 2, 3, 4))),
          {i: v["frame"] for i, v in frames_of(s, (1, 2, 3, 4)).items()})
        # Remove B again (2 -> 1 activity): the activity dimension collapses back.
        s.kill(5); s.settle()
        mark = s.kw.mark()
        s.kw.call("/ActivityManager/Activities", "org.kde.ActivityManager.Activities", "RemoveActivity", "s", B,
                  service="org.kde.ActivityManager")
        s.wait_for(lambda: B not in activity_state(s)["activities"], 10, "activity Two removed")
        time.sleep(0.5); s.settle()
        facts["signalsOnRemoveActivity"] = {n: [e["args"] for e in events(s, n, mark)]
                                            for n in ("activityRemoved", "activitiesChanged", "currentActivityChanged")}
        s.spawn(6); s.settle()
        f = s.frames_list()
        c("add-second: after removing B, a new window tiles with the four on A (oracle)",
          len(f) == 5 and not tiling_errors(f, area, GAP), tiling_errors(f, area, GAP))
        errs = s.log_lines(ERRORS, off)
        c("add-second: no Plastile errors or JS exceptions", not errs, errs[:3])
        unlisten(s)
    FACTS["activities-add-second-E08"] = facts
    c("facts (recorded, always passes)", True, facts)
