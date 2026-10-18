"""Transient dialogs following their parent's visibility (T16 acceptance; BEHAVIOR §1) in nested KWin.

A Wayland fixture opens a transient child (xdg_toplevel.set_parent, fixture `--parent-after-ms`). The
oracle is KWin's own state read by one-shot scripts: frames, minimized, hidden, desktops, transientFor and
the stacking order. Where KWin itself moves or hides the dialog with its parent, the same steps run once
more in a nested KWin *without* Plastile, and the dialog's state must match that native run: Plastile
neither adds nor undoes visibility changes. Plastile's trace and counters are used for amounts of work
(writes, solves) only. Nested virtual backend: not a physical-session result.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from harness import Session, delta, explain, near, tiling_errors, trace, window_info
from scenarios import Checks, scenario
from scenarios_topology import until

ERRORS = r"plastile (error|warn)|TypeError|ReferenceError"
GAP = 8
TRACE = {"traceCapacity": 16384}
PARENT, OTHER, LAST = "plastile-fixture 2", "plastile-fixture 1", "plastile-fixture 3"
DIALOG = PARENT + " child"
# KWin's view of one window: what "visible with its parent" means here.
STATE = ("({minimized: w.minimized, hidden: w.hidden, stack: workspace.stackingOrder.indexOf(w), active: w.active,"
         " transient: w.transient, transientFor: w.transientFor ? w.transientFor.caption : null,"
         " desktops: w.desktops.map(d => d.x11DesktopNumber), onAllDesktops: w.onAllDesktops,"
         " frame: {x: w.frameGeometry.x, y: w.frameGeometry.y, width: w.frameGeometry.width, height: w.frameGeometry.height}})")


def full(a: dict) -> dict:
    return {"x": a["x"] + GAP, "y": a["y"] + GAP, "width": a["width"] - 2 * GAP, "height": a["height"] - 2 * GAP}


def state(s: Session, caption: str) -> dict | None:
    return window_info(s, caption, STATE)


def current_desktop(s: Session) -> int:
    return json.loads(s.js("emit(workspace.currentDesktop.x11DesktopNumber)")[0])


def quiet(s: Session, loaded: bool) -> None:
    """Let KWin (and Plastile, when loaded) finish reacting to the last action."""
    if loaded:
        s.settle()
    else:
        time.sleep(0.3)


def dialog_writes(s: Session) -> int:
    wid = {x["caption"]: x["id"] for x in s.frames_list()}
    return len([r for r in trace(s) if r.get("kind") == "write" and r.get("id") == wid.get(DIALOG)])


def setup(s: Session, loaded: bool, desktops: int = 1) -> None:
    if desktops > 1:
        s.js("workspace.createDesktop(1, 'Two'); emit(workspace.desktops.length);")
    s.spawn(1); s.spawn(2, "--parent-after-ms", "200"); s.spawn(3)
    s.wait_for(lambda: DIALOG in s.frames(), 5, "the transient child maps")
    if loaded:
        s.load()
    time.sleep(0.4)
    quiet(s, loaded)


def snapshot(s: Session) -> dict:
    return {**{k: state(s, k) for k in (OTHER, PARENT, LAST, DIALOG)}, "current": current_desktop(s)}


def visibility(snap: dict) -> dict:
    """The part of a snapshot that KWin's own transient handling decides (compared with the native run)."""
    return {k: (v if k == "current" else v and {"minimized": v["minimized"], "hidden": v["hidden"], "desktops": v["desktops"]})
            for k, v in snap.items()}


def coverage(frames: list[dict], area: dict) -> float:
    """Share of the gap-inset area covered by the tiles: an empty (ghost) slot shows as a large drop."""
    f = full(area)
    return sum(x["frame"]["width"] * x["frame"]["height"] for x in frames) / (f["width"] * f["height"])


# ---------------------------------------------------------------------- minimize
MINIMIZE_STEPS = (
    ("parent minimized", PARENT, "w.minimized = true"),
    ("parent restored", PARENT, "w.minimized = false"),
    ("dialog minimized alone", DIALOG, "w.minimized = true"),
    ("dialog restored", DIALOG, "w.minimized = false"),
)


def _minimize_run(s: Session, loaded: bool) -> dict:
    snaps = {"initial": snapshot(s)}
    for name, caption, statement in MINIMIZE_STEPS:
        s.act(caption, statement)
        quiet(s, loaded)
        snaps[name] = snapshot(s)
    return snaps


@scenario("transient-parent-minimize-T16")
def parent_minimize(out: Path, c: Checks):
    """Minimizing a dialog's parent hides the dialog with it and restoring brings both back; the tiled layout
    closes the parent's slot and returns it; minimizing only the dialog changes no tile."""
    with Session(out / "native") as n:
        setup(n, loaded=False)
        native = _minimize_run(n, loaded=False)
    with Session(out / "plastile", config=TRACE) as s:
        setup(s, loaded=True)
        area = s.area()
        snaps = {"initial": snapshot(s)}
        f0 = s.frames()
        mains = [f0[k] for k in (OTHER, PARENT, LAST)]
        dialog0 = snaps["initial"][DIALOG]
        c("setup: the dialog is a transient of fixture 2 and floats at its own size; three mains tiled (oracle)",
          dialog0 and dialog0["transientFor"] == PARENT and dialog0["frame"]["width"] == 300
          and not tiling_errors(mains, area, GAP), {"dialog": dialog0, "errors": tiling_errors(mains, area, GAP)})

        s.act(PARENT, "w.minimized = true")
        s.settle()
        snaps["parent minimized"] = snapshot(s)
        sm = snaps["parent minimized"]
        c("parent minimized: KWin minimizes the dialog with it, as without Plastile (oracle, native run)",
          sm[DIALOG]["minimized"] and visibility(sm) == visibility(native["parent minimized"]),
          {"plastile": visibility(sm), "native": visibility(native["parent minimized"])})
        left = [{"caption": k, "frame": sm[k]["frame"]} for k in (OTHER, LAST)]
        c("parent minimized: the two other windows tile the whole area, fixture 3 takes the full stack column "
          "(oracle, gaps>=8)", not tiling_errors(left, area, GAP) and abs(sm[LAST]["frame"]["height"] - full(area)["height"]) <= 1,
          {"frames": {k: sm[k]["frame"] for k in (OTHER, LAST)}, "errors": tiling_errors(left, area, GAP)})
        c("parent minimized: the dialog keeps its frame (oracle)", near(sm[DIALOG]["frame"], dialog0["frame"], 0.5),
          {"before": dialog0["frame"], "after": sm[DIALOG]["frame"]})

        s.act(PARENT, "w.minimized = false")
        s.settle()
        snaps["parent restored"] = sr = snapshot(s)
        c("parent restored: the dialog is restored with it, not hidden, above its parent, as without Plastile "
          "(oracle, stacking order, native run)",
          not sr[DIALOG]["minimized"] and not sr[DIALOG]["hidden"] and sr[DIALOG]["stack"] > sr[PARENT]["stack"]
          and visibility(sr) == visibility(native["parent restored"]),
          {"plastile": sr[DIALOG], "parentStack": sr[PARENT]["stack"], "native": visibility(native["parent restored"])})
        c("parent restored: every main is back in its slot and the dialog at its frame (oracle)",
          all(near(sr[k]["frame"], f0[k]["frame"], 1.0) for k in (OTHER, PARENT, LAST))
          and near(sr[DIALOG]["frame"], dialog0["frame"], 0.5),
          {k: {"before": f0[k]["frame"], "after": sr[k]["frame"]} for k in (OTHER, PARENT, LAST, DIALOG)})

        a = s.counters()
        s.act(DIALOG, "w.minimized = true")
        s.settle()
        snaps["dialog minimized alone"] = sd = snapshot(s)
        s.act(DIALOG, "w.minimized = false")
        b = s.settle()
        snaps["dialog restored"] = sdr = snapshot(s)
        d = delta(a, b)
        c("dialog minimized alone: only the dialog is minimized, as without Plastile (oracle, native run)",
          sd[DIALOG]["minimized"] and not sd[PARENT]["minimized"]
          and visibility(sd) == visibility(native["dialog minimized alone"]),
          {"plastile": visibility(sd), "native": visibility(native["dialog minimized alone"])})
        c("dialog minimized and restored: no tile moves (oracle) and Plastile solves and writes nothing (counters)",
          all(near(sd[k]["frame"], sr[k]["frame"], 0.5) and near(sdr[k]["frame"], sr[k]["frame"], 0.5)
              for k in (OTHER, PARENT, LAST, DIALOG)) and d.get("solves", 0) == 0 and d.get("writes", 0) == 0,
          {"delta": d, "frames": {k: sdr[k]["frame"] for k in (OTHER, PARENT, LAST, DIALOG)}})
        c("dialog restored: visible above its parent again (oracle, stacking order)",
          not sdr[DIALOG]["minimized"] and sdr[DIALOG]["stack"] > sdr[PARENT]["stack"], sdr[DIALOG])
        c("Plastile never wrote the dialog (trace)", dialog_writes(s) == 0, dialog_writes(s))
        c("no errors or warnings", not s.log_lines(ERRORS, 0), s.log_lines(ERRORS, 0)[:3])
        c("native run: same visibility at every step (oracle; recorded for KWin's own behaviour)",
          all(visibility(snaps[k]) == visibility(native[k]) for k in native),
          {k: {"plastile": visibility(snaps[k])[DIALOG], "native": visibility(native[k])[DIALOG]} for k in native})


# ----------------------------------------------------------------------- desktops
def _send(s: Session, caption: str, desktop: int, loaded: bool) -> None:
    """Send `caption` to the desktop with x11 number `desktop`: with Plastile loaded, through its own command
    (move.desktop-next/previous on the active window); natively, the property the command sets."""
    if loaded:
        s.act(caption, "workspace.activeWindow = w")
        here = state(s, caption)["desktops"][0]
        s.cmd("move.desktop-next" if desktop > here else "move.desktop-previous")
        until(lambda: state(s, caption)["desktops"] == [desktop], 3.0)
    else:
        s.act(caption, f"w.desktops = [workspace.desktops[{desktop - 1}]]")


def _show(s: Session, desktop: int) -> None:
    s.js(f"workspace.currentDesktop = workspace.desktops[{desktop - 1}]; emit(1)")
    until(lambda: current_desktop(s) == desktop, 3.0)


def _desktop_run(s: Session, loaded: bool) -> dict:
    """The same user-visible sequence with and without Plastile. Returns a snapshot per step."""
    snaps = {"initial": snapshot(s)}
    # 1. The user moves the parent (window menu / pager): KWin's property, never Plastile's command.
    s.act(PARENT, "w.desktops = [workspace.desktops[1]]")
    quiet(s, loaded); snaps["parent moved by the user"] = snapshot(s)
    _show(s, 2); quiet(s, loaded); snaps["desktop 2 shown"] = snapshot(s)
    # 2. The parent is sent back (Plastile's send command when loaded); the current desktop does not follow.
    _send(s, PARENT, 1, loaded)
    quiet(s, loaded); snaps["parent sent back"] = snapshot(s)
    _show(s, 1); quiet(s, loaded); snaps["desktop 1 shown"] = snapshot(s)
    # 3. Only the dialog is sent away, then shown, then sent back to its parent.
    _send(s, DIALOG, 2, loaded)
    quiet(s, loaded); snaps["dialog sent alone"] = snapshot(s)
    _show(s, 2); quiet(s, loaded); snaps["dialog's desktop shown"] = snapshot(s)
    _send(s, DIALOG, 1, loaded)
    _show(s, 1); quiet(s, loaded); snaps["dialog sent back"] = snapshot(s)
    return snaps


@scenario("transient-parent-desktop-T16")
def parent_desktop(out: Path, c: Checks):
    """The parent moves to another virtual desktop (by the user, then back by Plastile's send command): the
    dialog goes with it as KWin does natively, is never tiled, and is shown above its parent on the
    destination; a dialog sent alone stays reachable and goes back to its parent."""
    with Session(out / "native") as n:
        setup(n, loaded=False, desktops=2)
        native = _desktop_run(n, loaded=False)
    with Session(out / "plastile", config=TRACE) as s:
        setup(s, loaded=True, desktops=2)
        area = s.area()
        snaps = _desktop_run(s, loaded=True)
        init = snaps["initial"]
        dialog0 = init[DIALOG]["frame"]
        same = {k: visibility(snaps[k]) == visibility(native[k]) for k in native}
        c("every step: the windows' desktops and minimized/hidden state match KWin without Plastile (oracle, native run)",
          all(same.values()), {k: {"plastile": visibility(snaps[k]), "native": visibility(native[k])}
                                for k, ok in same.items() if not ok} or same)

        m = snaps["parent moved by the user"]
        c("parent moved by the user: the dialog follows it to desktop 2 (KWin) and keeps its frame (oracle)",
          m[PARENT]["desktops"] == [2] and m[DIALOG]["desktops"] == [2] and near(m[DIALOG]["frame"], dialog0, 0.5), m)
        left = [{"caption": k, "frame": m[k]["frame"]} for k in (OTHER, LAST)]
        c("parent moved: desktop 1 reflows to two tiles over the whole area (oracle, gaps>=8)",
          not tiling_errors(left, area, GAP) and abs(m[LAST]["frame"]["height"] - full(area)["height"]) <= 1,
          {"frames": {k: m[k]["frame"] for k in (OTHER, LAST)}, "errors": tiling_errors(left, area, GAP)})
        d2 = snaps["desktop 2 shown"]
        c("desktop 2 shown: the parent tiles alone over the area; the dialog is visible above it at its own frame "
          "(oracle, stacking order)", near(d2[PARENT]["frame"], full(area), 1.0) and not d2[DIALOG]["minimized"]
          and not d2[DIALOG]["hidden"] and d2[DIALOG]["stack"] > d2[PARENT]["stack"] and near(d2[DIALOG]["frame"], dialog0, 0.5),
          {"parent": d2[PARENT], "dialog": d2[DIALOG]})

        b = snaps["parent sent back"]
        c("parent sent back by Plastile's command: the dialog comes along; the current desktop stays 2 (no follow)",
          b[PARENT]["desktops"] == [1] and b[DIALOG]["desktops"] == [1] and b["current"] == 2,
          {"parent": b[PARENT]["desktops"], "dialog": b[DIALOG]["desktops"], "current": b["current"]})
        d1 = snaps["desktop 1 shown"]
        mains = [{"caption": k, "frame": d1[k]["frame"]} for k in (OTHER, PARENT, LAST)]
        c("desktop 1 shown: three mains tiled without overlap; the dialog above its parent at its frame "
          "(oracle, gaps>=8, stacking order)", not tiling_errors(mains, area, GAP)
          and d1[DIALOG]["stack"] > d1[PARENT]["stack"] and not d1[DIALOG]["minimized"] and near(d1[DIALOG]["frame"], dialog0, 0.5),
          {"errors": tiling_errors(mains, area, GAP), "dialog": d1[DIALOG], "parentStack": d1[PARENT]["stack"]})

        a = snaps["dialog sent alone"]
        c("dialog sent alone: only the dialog moves (as KWin does natively); no tile on desktop 1 moves (oracle)",
          a[DIALOG]["desktops"] == [2] and a[PARENT]["desktops"] == [1]
          and all(near(a[k]["frame"], d1[k]["frame"], 0.5) for k in (OTHER, PARENT, LAST)),
          {k: a[k]["frame"] for k in (OTHER, PARENT, LAST)})
        sh = snaps["dialog's desktop shown"]
        c("the dialog's desktop shown: it is not stranded: visible, not minimized, at its own frame inside the area "
          "(oracle)", not sh[DIALOG]["minimized"] and not sh[DIALOG]["hidden"] and near(sh[DIALOG]["frame"], dialog0, 0.5)
          and not tiling_errors([{"caption": DIALOG, "frame": sh[DIALOG]["frame"]}], area), sh[DIALOG])
        back = snaps["dialog sent back"]
        c("dialog sent back: with its parent again, above it, at its frame; the layout is unchanged (oracle)",
          back[DIALOG]["desktops"] == [1] and back[DIALOG]["stack"] > back[PARENT]["stack"]
          and near(back[DIALOG]["frame"], dialog0, 0.5)
          and all(near(back[k]["frame"], d1[k]["frame"], 0.5) for k in (OTHER, PARENT, LAST)),
          {k: back[k]["frame"] for k in (OTHER, PARENT, LAST, DIALOG)})
        e = explain(s, DIALOG)
        c("explain: the dialog floats as a transient window", e.get("mode") == "floating", e.get("mode"))
        c("Plastile never wrote the dialog (trace)", dialog_writes(s) == 0, dialog_writes(s))
        c("no errors or warnings", not s.log_lines(ERRORS, 0), s.log_lines(ERRORS, 0)[:3])


# -------------------------------------------------------------------------- close
@scenario("transient-parent-close-T16")
def parent_close(out: Path, c: Checks):
    """The parent closes while its dialog is open. (a) The user closes the parent: the application exits and
    both go; (b) the application destroys only its main window (fixture `close-main`): the orphaned dialog
    stays open, visible and floating, and the layout closes the parent's slot without a ghost member."""
    with Session(out, config=TRACE) as s:
        setup(s, loaded=True)
        area = s.area()
        c0 = s.counters()
        # (a) KWin's close on the parent (title-bar close): the fixture's main window exits with its dialog.
        s.act(PARENT, "w.closeWindow()")
        gone = until(lambda: not ({PARENT, DIALOG} & set(s.frames())), 5.0)
        exited = s.fixtures.pop(2).proc.wait(timeout=5) == 0
        c1 = s.settle()
        f = s.frames()
        left = [f[k] for k in (OTHER, LAST)]
        c("(a) user closes the parent: the application exits; parent and dialog are both removed (oracle)",
          gone and exited, {"windows": list(f), "exitedCleanly": exited})
        c("(a) the two other windows tile the whole area (oracle, gaps>=8)",
          not tiling_errors(left, area, GAP) and coverage(left, area) >= 0.97,
          {"frames": {k: f[k]["frame"] for k in (OTHER, LAST)}, "errors": tiling_errors(left, area, GAP)})
        c("(a) Plastile dropped both windows (counters: windows -2, one solve)",
          c1["windows"] == c0["windows"] - 2 and delta(c0, c1).get("solves", 0) >= 1, {"before": c0["windows"],
                                                                                    "after": c1["windows"], "delta": delta(c0, c1)})
        s.spawn(4)
        s.settle()
        f = s.frames()
        three = [f[k] for k in (OTHER, LAST, "plastile-fixture 4")]
        c("(a) a new window tiles with the remaining two: three tiles, no ghost slot left by the parent (oracle)",
          not tiling_errors(three, area, GAP) and coverage(three, area) >= 0.97,
          {"frames": {x["caption"]: x["frame"] for x in three}, "coverage": round(coverage(three, area), 4),
           "errors": tiling_errors(three, area, GAP)})

        # (b) The application destroys its main window and keeps the dialog.
        p5 = s.spawn(5, "--parent-after-ms", "200")
        orphan = "plastile-fixture 5 child"
        s.wait_for(lambda: orphan in s.frames(), 5, "fixture 5's dialog maps")
        s.settle()
        before = state(s, orphan)
        w4 = s.counters()
        p5.send("close-main")
        gone = until(lambda: "plastile-fixture 5" not in s.frames(), 5.0)
        w5 = s.settle()
        f = s.frames()
        o = state(s, orphan)
        c("(b) close-main: the parent is removed, the dialog stays open (oracle)", gone and o is not None, list(f))
        c("(b) KWin keeps the orphan a transient without a parent (recorded: KWin 6.7.5 behaviour; Plastile's policy "
          "input)", o and o["transient"] and o["transientFor"] is None, o)
        c("(b) the orphaned dialog is visible, not minimized, at its own frame: not tiled (oracle)",
          o and not o["minimized"] and not o["hidden"] and near(o["frame"], before["frame"], 0.5),
          {"before": before, "after": o})
        mains = [f[k] for k in (OTHER, LAST, "plastile-fixture 4")]
        c("(b) the remaining three mains tile without overlap and fill the area as before (oracle)",
          not tiling_errors(mains, area, GAP) and coverage(mains, area) >= 0.97 and all(near(f[x["caption"]]["frame"], x["frame"], 1.0) for x in three),
          {"frames": {x["caption"]: x["frame"] for x in mains}, "errors": tiling_errors(mains, area, GAP)})
        c("(b) Plastile dropped the parent only (counters: windows -1)", w5["windows"] == w4["windows"] - 1,
          {"before": w4["windows"], "after": w5["windows"]})
        e = explain(s, orphan)
        c("(b) the orphan is usable: it activates (oracle) and still floats (explain)",
          state(s, orphan)["active"] and e.get("mode") == "floating", {"mode": e.get("mode"), "reason": e.get("reason")})
        wid = {x["caption"]: x["id"] for x in s.frames_list()}
        w = [r for r in trace(s) if r.get("kind") == "write" and r.get("id") == wid.get(orphan)]
        c("(b) Plastile never wrote the orphaned dialog (trace)", not w, len(w))
        s.kill(5, wait=False)
        removed = until(lambda: orphan not in s.frames(), 5.0)
        w6 = s.settle()
        f = s.frames()
        c("(b) closing the orphan leaves the layout untouched (oracle) and no record behind (counters)",
          removed and w6["windows"] == w5["windows"] - 1
          and all(near(f[x["caption"]]["frame"], x["frame"], 1.0) for x in three),
          {"windows": [w5["windows"], w6["windows"]], "frames": {k: f[k]["frame"] for k in f}})
        c("no errors or warnings; model invariants hold", not s.log_lines(ERRORS, 0) and w6["counters"]["errors"] == 0,
          s.log_lines(ERRORS, 0)[:3])
