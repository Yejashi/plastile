"""X11 transient dialogs following their parent's visibility (T16 acceptance, XWayland; BEHAVIOR §1) in nested KWin.

The X11 counterpart of scenarios_transients.py. fixtures/xclient's `--dialog` maps a second window with
WM_TRANSIENT_FOR = its main window and _NET_WM_WINDOW_TYPE_DIALOG (as in xwayland-dialog-G10); its
`close-main` command destroys the main window and keeps the dialog. Two Wayland fixtures share the
context with the X parent. The oracle is KWin's own state read by one-shot scripts: frames, minimized,
hidden, desktops, transientFor and the stacking order. Every step also runs in a nested KWin *without*
Plastile, and the dialog's state must match that native run: Plastile neither adds nor undoes KWin's
transient handling. Plastile's trace and counters are used for amounts of work (writes, solves) and
`inspect.explain-window` for its decision only. Nested virtual backend + nested Xwayland: not a
physical-session result.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from harness import Session, delta, explain, near, tiling_errors, trace, window_info
from scenarios import Checks, scenario
from scenarios_topology import until
from scenarios_transients import STATE, current_desktop, full
from scenarios_xwayland import XClient

ERRORS = r"plastile (error|warn)|TypeError|ReferenceError"
GAP = 8
TRACE = {"traceCapacity": 16384}
OTHER, LAST = "plastile-fixture 1", "plastile-fixture 3"
PARENT = "xc parent"
DIALOG = PARENT + " dialog"
MAINS = (OTHER, PARENT, LAST)
ALL = (OTHER, PARENT, LAST, DIALOG)


def state(s: Session, caption: str) -> dict | None:
    return window_info(s, caption, "({id: String(w.internalId), " + STATE[2:])


def snapshot(s: Session, captions: tuple[str, ...] = ALL) -> dict:
    return {**{k: state(s, k) for k in captions}, "current": current_desktop(s)}


def visibility(snap: dict) -> dict:
    """The part of a snapshot that KWin's own transient handling decides (compared with the native run)."""
    return {k: (v if k == "current" else v and {"minimized": v["minimized"], "hidden": v["hidden"], "desktops": v["desktops"],
                                                "transient": v["transient"], "transientFor": v["transientFor"]})
            for k, v in snap.items()}


def quiet(s: Session, loaded: bool, captions: tuple[str, ...] = ALL, hold: float = 0.4, timeout: float = 6.0) -> None:
    """Let KWin (and Plastile, when loaded) finish reacting: no request outstanding, then the named windows'
    frames and visibility unchanged for `hold` seconds (an event wait, not a fixed sleep)."""
    if loaded:
        s.settle(timeout)
    deadline = time.monotonic() + timeout
    last, since = None, time.monotonic()
    while time.monotonic() < deadline:
        cur = {k: v and {"frame": v["frame"], **visibility({k: v})[k]} for k, v in ((k, state(s, k)) for k in captions)}
        if cur != last:
            last, since = cur, time.monotonic()
        elif time.monotonic() - since >= hold:
            return
        time.sleep(0.05)


def writes_to(s: Session, wid: str | None) -> int:
    return len([r for r in trace(s) if r.get("kind") == "write" and r.get("id") == wid])


def mains_of(snap: dict, captions: tuple[str, ...] = MAINS) -> list[dict]:
    return [{"caption": k, "frame": snap[k]["frame"]} for k in captions]


def coverage(frames: list[dict], area: dict) -> float:
    f = full(area)
    return sum(x["frame"]["width"] * x["frame"]["height"] for x in frames) / (f["width"] * f["height"])


def setup(s: Session, loaded: bool, desktops: int = 1) -> XClient:
    if desktops > 1:
        s.js("workspace.createDesktop(1, 'Two'); emit(workspace.desktops.length);")
    s.spawn(1)
    x = XClient(s, PARENT, "--dialog")
    s.wait_for(lambda: state(s, DIALOG) is not None, 10, "the X dialog maps")
    s.spawn(3)
    if loaded:
        s.load()
    quiet(s, loaded)
    return x


def explained_floating(s: Session, caption: str) -> dict:
    e = explain(s, caption)
    return {"mode": e.get("mode"), "kind": e.get("kind"), "reason": (e.get("decision") or {}).get("reason")}


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


@scenario("xtransient-parent-minimize-T16")
def x_parent_minimize(out: Path, c: Checks):
    """An X11 dialog (WM_TRANSIENT_FOR) whose parent is minimized and restored: KWin hides and shows it with
    its parent exactly as without Plastile; the parent's slot closes and comes back; minimizing only the
    dialog changes no tile. Plastile never tiles or writes the dialog."""
    with Session(out / "native", xwayland=True) as n:
        setup(n, loaded=False)
        native = _minimize_run(n, loaded=False)
    with Session(out / "plastile", config=TRACE, xwayland=True) as s:
        setup(s, loaded=True)
        area = s.area()
        snaps = {"initial": snapshot(s)}
        i0 = snaps["initial"]
        d0 = i0[DIALOG]
        e0 = explained_floating(s, DIALOG)
        c("setup: the X dialog is a transient of its X parent and floats (explain); the parent and two Wayland "
          "fixtures tile (oracle, gaps>=8)",
          d0 and d0["transient"] and d0["transientFor"] == PARENT and e0["mode"] == "floating"
          and not tiling_errors(mains_of(i0), area, GAP),
          {"dialog": d0, "explain": e0, "errors": tiling_errors(mains_of(i0), area, GAP)})
        s.act(PARENT, "workspace.activeWindow = w")  # explain activated the dialog; start from the parent as natively
        quiet(s, True)
        i0 = snapshot(s)

        s.act(PARENT, "w.minimized = true")
        quiet(s, True)
        snaps["parent minimized"] = sm = snapshot(s)
        c("parent minimized: KWin hides the X dialog with it, as without Plastile (oracle, native run)",
          (sm[DIALOG]["minimized"] or sm[DIALOG]["hidden"]) and visibility(sm) == visibility(native["parent minimized"]),
          {"plastile": visibility(sm), "native": visibility(native["parent minimized"])})
        left = mains_of(sm, (OTHER, LAST))
        c("parent minimized: the two Wayland windows tile the whole area (oracle, gaps>=8, coverage)",
          not tiling_errors(left, area, GAP) and coverage(left, area) >= 0.97,
          {"frames": {k: sm[k]["frame"] for k in (OTHER, LAST)}, "errors": tiling_errors(left, area, GAP),
           "coverage": round(coverage(left, area), 4)})
        c("parent minimized: the dialog keeps its frame (oracle)", near(sm[DIALOG]["frame"], d0["frame"], 0.5),
          {"before": d0["frame"], "after": sm[DIALOG]["frame"]})

        s.act(PARENT, "w.minimized = false")
        quiet(s, True)
        snaps["parent restored"] = sr = snapshot(s)
        c("parent restored: the X dialog is shown again above its parent, as without Plastile "
          "(oracle, stacking order, native run)",
          not sr[DIALOG]["minimized"] and not sr[DIALOG]["hidden"] and sr[DIALOG]["stack"] > sr[PARENT]["stack"]
          and visibility(sr) == visibility(native["parent restored"]),
          {"plastile": sr[DIALOG], "parentStack": sr[PARENT]["stack"], "native": visibility(native["parent restored"])})
        c("parent restored: every main is back in its slot and the dialog at its frame (oracle)",
          all(near(sr[k]["frame"], i0[k]["frame"], 1.0) for k in MAINS) and near(sr[DIALOG]["frame"], d0["frame"], 0.5),
          {k: {"before": i0[k]["frame"], "after": sr[k]["frame"]} for k in ALL})

        a = s.counters()
        s.act(DIALOG, "w.minimized = true")
        quiet(s, True)
        snaps["dialog minimized alone"] = sd = snapshot(s)
        s.act(DIALOG, "w.minimized = false")
        quiet(s, True)
        b = s.counters()
        snaps["dialog restored"] = sdr = snapshot(s)
        d = delta(a, b)
        c("dialog minimized alone: only the dialog is minimized, as without Plastile (oracle, native run)",
          sd[DIALOG]["minimized"] and not sd[PARENT]["minimized"]
          and visibility(sd) == visibility(native["dialog minimized alone"]),
          {"plastile": visibility(sd), "native": visibility(native["dialog minimized alone"])})
        c("dialog minimized and restored: no tile moves (oracle) and Plastile solves and writes nothing (counters)",
          all(near(sd[k]["frame"], sr[k]["frame"], 0.5) and near(sdr[k]["frame"], sr[k]["frame"], 0.5) for k in ALL)
          and d.get("solves", 0) == 0 and d.get("writes", 0) == 0,
          {"delta": d, "frames": {k: sdr[k]["frame"] for k in ALL}})
        c("dialog restored: visible above its parent again (oracle, stacking order)",
          not sdr[DIALOG]["minimized"] and not sdr[DIALOG]["hidden"] and sdr[DIALOG]["stack"] > sdr[PARENT]["stack"],
          sdr[DIALOG])
        e1 = explained_floating(s, DIALOG)
        c("the X dialog still floats (explain) and Plastile never wrote it (trace)",
          e1["mode"] == "floating" and writes_to(s, d0["id"]) == 0, {"explain": e1, "writes": writes_to(s, d0["id"])})
        c("no errors or warnings", not s.log_lines(ERRORS, 0), s.log_lines(ERRORS, 0)[:3])
        c("native run: same visibility at every step (oracle; recorded for KWin's own behaviour)",
          all(visibility(snaps[k]) == visibility(native[k]) for k in native if k != "initial"),
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
    # 1. The user moves the X parent (window menu / pager): KWin's property, never Plastile's command.
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


@scenario("xtransient-parent-desktop-T16")
def x_parent_desktop(out: Path, c: Checks):
    """The X parent moves to another virtual desktop (by the user, then back by Plastile's send command): its
    WM_TRANSIENT_FOR dialog goes with it as KWin does natively, is never tiled or written, and is shown above
    its parent on the destination; a dialog sent alone stays reachable and goes back to its parent."""
    with Session(out / "native", xwayland=True) as n:
        setup(n, loaded=False, desktops=2)
        native = _desktop_run(n, loaded=False)
    with Session(out / "plastile", config=TRACE, xwayland=True) as s:
        setup(s, loaded=True, desktops=2)
        area = s.area()
        snaps = _desktop_run(s, loaded=True)
        init = snaps["initial"]
        dialog0 = init[DIALOG]["frame"]
        same = {k: visibility(snaps[k]) == visibility(native[k]) for k in native}
        c("every step: the windows' desktops, minimized/hidden and transient state match KWin without Plastile "
          "(oracle, native run)", all(same.values()),
          {k: {"plastile": visibility(snaps[k]), "native": visibility(native[k])} for k, ok in same.items() if not ok} or same)

        m = snaps["parent moved by the user"]
        c("parent moved by the user: the X dialog follows it to desktop 2 (KWin) and keeps its frame (oracle)",
          m[PARENT]["desktops"] == [2] and m[DIALOG]["desktops"] == [2] and near(m[DIALOG]["frame"], dialog0, 0.5),
          {k: m[k] for k in (PARENT, DIALOG)})
        left = mains_of(m, (OTHER, LAST))
        c("parent moved: desktop 1 reflows to two tiles over the whole area (oracle, gaps>=8, coverage)",
          not tiling_errors(left, area, GAP) and coverage(left, area) >= 0.97,
          {"frames": {k: m[k]["frame"] for k in (OTHER, LAST)}, "errors": tiling_errors(left, area, GAP)})
        d2 = snaps["desktop 2 shown"]
        c("desktop 2 shown: the X parent tiles alone over the area; the dialog is visible above it at its own "
          "frame (oracle, stacking order)", near(d2[PARENT]["frame"], full(area), 1.0) and not d2[DIALOG]["minimized"]
          and not d2[DIALOG]["hidden"] and d2[DIALOG]["stack"] > d2[PARENT]["stack"] and near(d2[DIALOG]["frame"], dialog0, 0.5),
          {"parent": d2[PARENT], "dialog": d2[DIALOG]})

        b = snaps["parent sent back"]
        c("parent sent back by Plastile's command: the X dialog comes along; the current desktop stays 2 (no follow)",
          b[PARENT]["desktops"] == [1] and b[DIALOG]["desktops"] == [1] and b["current"] == 2,
          {"parent": b[PARENT]["desktops"], "dialog": b[DIALOG]["desktops"], "current": b["current"]})
        d1 = snaps["desktop 1 shown"]
        c("desktop 1 shown: three mains tiled without overlap; the dialog above its parent at its frame "
          "(oracle, gaps>=8, stacking order)", not tiling_errors(mains_of(d1), area, GAP)
          and d1[DIALOG]["stack"] > d1[PARENT]["stack"] and not d1[DIALOG]["minimized"] and near(d1[DIALOG]["frame"], dialog0, 0.5),
          {"errors": tiling_errors(mains_of(d1), area, GAP), "dialog": d1[DIALOG], "parentStack": d1[PARENT]["stack"]})

        a = snaps["dialog sent alone"]
        c("dialog sent alone: only the X dialog moves (as KWin does natively); no tile on desktop 1 moves (oracle)",
          a[DIALOG]["desktops"] == [2] and a[PARENT]["desktops"] == [1]
          and all(near(a[k]["frame"], d1[k]["frame"], 0.5) for k in MAINS), {k: a[k]["frame"] for k in MAINS})
        sh = snaps["dialog's desktop shown"]
        c("the dialog's desktop shown: it is not stranded: visible, not minimized, at its own frame inside the area "
          "(oracle)", not sh[DIALOG]["minimized"] and not sh[DIALOG]["hidden"] and near(sh[DIALOG]["frame"], dialog0, 0.5)
          and not tiling_errors([{"caption": DIALOG, "frame": sh[DIALOG]["frame"]}], area), sh[DIALOG])
        back = snaps["dialog sent back"]
        c("dialog sent back: with its parent again, above it, at its frame; the layout is unchanged (oracle)",
          back[DIALOG]["desktops"] == [1] and back[DIALOG]["stack"] > back[PARENT]["stack"]
          and near(back[DIALOG]["frame"], dialog0, 0.5) and all(near(back[k]["frame"], d1[k]["frame"], 0.5) for k in MAINS),
          {k: back[k]["frame"] for k in ALL})
        e = explained_floating(s, DIALOG)
        c("explain: the X dialog floats as a dialog/transient window", e["mode"] == "floating", e)
        c("Plastile never wrote the X dialog (trace)", writes_to(s, init[DIALOG]["id"]) == 0, writes_to(s, init[DIALOG]["id"]))
        c("no errors or warnings", not s.log_lines(ERRORS, 0), s.log_lines(ERRORS, 0)[:3])


# -------------------------------------------------------------------------- close
ORPHAN_PARENT = "xc orphan"
ORPHAN = ORPHAN_PARENT + " dialog"


def _close_run(s: Session, loaded: bool) -> dict:
    """(a) the user closes the X parent; (b) a second X client destroys only its main window. Returns snapshots."""
    snaps: dict = {"initial": snapshot(s)}
    x = s.xclients[PARENT]
    s.act(PARENT, "w.closeWindow()")  # title-bar close: WM_DELETE_WINDOW to the main window, the client exits
    snaps["closedGone"] = until(lambda: state(s, PARENT) is None and state(s, DIALOG) is None, 5.0)
    snaps["exitCode"] = x.proc.wait(timeout=5)
    quiet(s, loaded, (OTHER, LAST))
    snaps["parent closed"] = snapshot(s, (OTHER, LAST))
    snaps["windows"] = {"parent closed": s.counters()["windows"] if loaded else None}
    o = XClient(s, ORPHAN_PARENT, "--dialog")
    s.xclients[ORPHAN_PARENT] = o
    s.wait_for(lambda: state(s, ORPHAN) is not None, 10, "the second X dialog maps")
    quiet(s, loaded, (OTHER, LAST, ORPHAN_PARENT, ORPHAN))
    snaps["orphan open"] = snapshot(s, (OTHER, LAST, ORPHAN_PARENT, ORPHAN))
    snaps["windows"]["orphan open"] = s.counters()["windows"] if loaded else None
    o.send("close-main")
    snaps["mainGone"] = until(lambda: state(s, ORPHAN_PARENT) is None, 5.0)
    quiet(s, loaded, (OTHER, LAST, ORPHAN))
    snaps["main destroyed"] = snapshot(s, (OTHER, LAST, ORPHAN))
    snaps["windows"]["main destroyed"] = s.counters()["windows"] if loaded else None
    return snaps


@scenario("xtransient-parent-close-T16")
def x_parent_close(out: Path, c: Checks):
    """The X parent closes while its dialog is open. (a) The user closes the parent: the client exits and both
    go, leaving no ghost slot; (b) the client destroys only its main window (xclient `close-main`): the orphaned
    X dialog stays open, visible and floating as without Plastile, and the layout closes the parent's slot.
    Plastile never tiles or writes either dialog."""
    with Session(out / "native", xwayland=True) as n:
        n.xclients = {PARENT: setup(n, loaded=False)}
        native = _close_run(n, loaded=False)
        n.xclients[ORPHAN_PARENT].send("quit")
    with Session(out / "plastile", config=TRACE, xwayland=True) as s:
        s.xclients = {PARENT: setup(s, loaded=True)}
        area = s.area()
        c0 = s.counters()
        init = snapshot(s)
        dialog_id = init[DIALOG]["id"]
        snaps = _close_run(s, loaded=True)
        pc = snaps["parent closed"]
        left = mains_of(pc, (OTHER, LAST))
        c("(a) user closes the X parent: the client exits cleanly; parent and dialog are both removed (oracle), "
          "as without Plastile", snaps["closedGone"] and snaps["exitCode"] == 0 and native["closedGone"]
          and native["exitCode"] == 0, {"plastile": [snaps["closedGone"], snaps["exitCode"]],
                                        "native": [native["closedGone"], native["exitCode"]]})
        n = snaps["windows"]
        c("(a) Plastile dropped both X windows; (b) it tracks the second client's two, then drops only the destroyed "
          "main (counters: windows)", [n["parent closed"], n["orphan open"], n["main destroyed"]]
          == [c0["windows"] - 2, c0["windows"], c0["windows"] - 1], {"start": c0["windows"], **n})
        c("(a) the two Wayland windows tile the whole area: no ghost slot (oracle, gaps>=8, coverage)",
          not tiling_errors(left, area, GAP) and coverage(left, area) >= 0.97,
          {"frames": {k: pc[k]["frame"] for k in (OTHER, LAST)}, "errors": tiling_errors(left, area, GAP),
           "coverage": round(coverage(left, area), 4)})

        op = snaps["orphan open"]
        orphan_id = op[ORPHAN]["id"]
        md = snaps["main destroyed"]
        o, no = md[ORPHAN], native["main destroyed"][ORPHAN]
        c("(b) close-main: the X main window is removed, its dialog stays open (oracle), as without Plastile",
          snaps["mainGone"] and o is not None and native["mainGone"] and no is not None,
          {"plastile": [snaps["mainGone"], o], "native": [native["mainGone"], no]})
        c("(b) the orphan's transient state is KWin's own: identical to the native run (recorded: KWin's X11 "
          "behaviour, Plastile's policy input)", o and no and visibility({ORPHAN: o}) == visibility({ORPHAN: no}),
          {"plastile": o and visibility({ORPHAN: o}), "native": no and visibility({ORPHAN: no})})
        c("(b) the orphaned X dialog is visible, not minimized, at its own frame: not tiled (oracle)",
          o and not o["minimized"] and not o["hidden"] and near(o["frame"], op[ORPHAN]["frame"], 0.5),
          {"before": op[ORPHAN], "after": o})
        mains = mains_of(md, (OTHER, LAST))
        c("(b) the two Wayland windows tile the whole area again: the destroyed parent's slot is closed "
          "(oracle, gaps>=8, coverage)", not tiling_errors(mains, area, GAP) and coverage(mains, area) >= 0.97
          and all(near(md[k]["frame"], pc[k]["frame"], 1.0) for k in (OTHER, LAST)),
          {"frames": {k: md[k]["frame"] for k in (OTHER, LAST)}, "errors": tiling_errors(mains, area, GAP)})
        e = explained_floating(s, ORPHAN)
        c("(b) the orphan still floats (explain)", e["mode"] == "floating", e)
        # Usable: the user moves it, and the move sticks.
        moved = {**o["frame"], "x": o["frame"]["x"] + 60, "y": o["frame"]["y"] + 40}
        s.act(ORPHAN, f"w.frameGeometry = {json.dumps(moved)}")
        placed = until(lambda: near(state(s, ORPHAN)["frame"], moved, 0.5), 3.0)
        quiet(s, True, (OTHER, LAST, ORPHAN))
        c("(b) a user move of the orphan sticks (oracle)", placed and near(state(s, ORPHAN)["frame"], moved, 0.5),
          {"moved": moved, "frame": state(s, ORPHAN)["frame"]})
        c("Plastile never wrote either X dialog (trace)", writes_to(s, dialog_id) == 0 and writes_to(s, orphan_id) == 0,
          {"dialog": writes_to(s, dialog_id), "orphan": writes_to(s, orphan_id)})
        # Activating another window closes the inspector that explain opened (Plastile's own UI, counted as an
        # excluded window), so the counts below are the application windows only.
        s.act(OTHER, "workspace.activeWindow = w")
        until(lambda: state(s, "Plastile inspector") is None, 3.0)
        before = s.settle()
        s.xclients[ORPHAN_PARENT].send("quit")
        removed = until(lambda: state(s, ORPHAN) is None, 5.0)
        quiet(s, True, (OTHER, LAST))
        after = s.counters()
        f = snapshot(s, (OTHER, LAST))
        c("(b) closing the orphan leaves the layout untouched (oracle) and no record behind (counters)",
          removed and after["windows"] == before["windows"] - 1 and after["windows"] == c0["windows"] - 2
          and all(near(f[k]["frame"], md[k]["frame"], 1.0) for k in (OTHER, LAST)),
          {"windows": [c0["windows"], before["windows"], after["windows"]], "delta": delta(before, after)})
        c("no errors or warnings; model invariants hold", not s.log_lines(ERRORS, 0) and after["counters"]["errors"] == 0,
          s.log_lines(ERRORS, 0)[:3])
        c("facts (recorded, always passes)", True,
          {"orphanPlastile": o, "orphanNative": no, "explainOrphan": e})
