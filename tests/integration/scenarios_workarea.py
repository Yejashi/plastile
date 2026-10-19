"""Work-area scenarios (O07): wlr-layer-shell panels with exclusive zones.

Panels are the fixture client in `--panel EDGE:SIZE` mode (a zwlr_layer_surface_v1 on
the top layer). KWin reports such a window with the fixture's resourceClass and an
empty caption, so every oracle query here keeps only captioned (toplevel) windows.
Geometry is judged by the KWin oracle; Plastile counters/trace only gate work amount.
"""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from harness import FIXTURE, Session, delta, explain, near, tiling_errors
from scenarios import Checks, scenario, three

GAP = 8
PANEL_INFO = (
    "emit(workspace.windowList().filter(w => w.dock).map(w => ({dock: w.dock, windowType: w.windowType,"
    " normalWindow: w.normalWindow, managed: w.managed, resourceClass: String(w.resourceClass),"
    " resourceName: String(w.resourceName), caption: w.caption, output: w.output ? w.output.name : null,"
    " frame: {x: w.frameGeometry.x, y: w.frameGeometry.y, width: w.frameGeometry.width, height: w.frameGeometry.height}})));")


# ------------------------------------------------------------------- helpers
def tiles(s: Session, output: str | None = None) -> list[dict]:
    """Oracle frames of the toplevel fixtures (panels have an empty caption)."""
    return [f for f in s.frames_list() if f["caption"] and (output is None or f["output"] == output)]


def spawn_panel(s: Session, name: str, edge: str, size: int, output: str | None = None) -> subprocess.Popen:
    args = [str(FIXTURE), "--panel", f"{edge}:{size}"] + (["--output", output] if output else [])
    return s.kw.spawn(args, stdout=open(s.out / f"panel-{name}.jsonl", "w"), stdin=subprocess.PIPE)


def quit_panel(p: subprocess.Popen) -> None:
    if p.poll() is None:
        p.stdin.write(b"quit\n")
        p.stdin.flush()
        p.wait(timeout=5)


def until(pred, timeout: float = 6.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if pred():
                return True
        except Exception:
            pass
        time.sleep(0.05)
    return False


def trace(s: Session) -> list[dict]:
    off = s.kw.mark()
    s.cmd("inspect.dump-trace")
    line = s.kw.wait_log(r"plastile trace ", 5, off)[-1]
    return json.loads(line.split("plastile trace ", 1)[1])


def trace_since(s: Session, last_t: float) -> list[dict]:
    return [r for r in trace(s) if r["t"] > last_t]


def last_t(s: Session) -> float:
    tr = trace(s)
    return tr[-1]["t"] if tr else 0


def bottom(r: dict) -> float:
    return r["y"] + r["height"]


def retile_checks(c: Checks, tag: str, s: Session, area: dict, before: dict, after: dict, recs: list[dict],
                  output: str | None = None, n: int = 3) -> None:
    f = tiles(s, output)
    errs = tiling_errors(f, area, GAP)
    c(f"{tag}: {n} tiles inside the new area, no overlap, gaps>={GAP}", len(f) == n and not errs, errs or [x["frame"] for x in f])
    low = max((bottom(x["frame"]) for x in f), default=None)
    want = area["y"] + area["height"] - GAP
    c(f"{tag}: lowest tile bottom == area.bottom - {GAP} (no double subtraction)", low is not None and abs(low - want) <= 0.5,
      {"lowestBottom": low, "expected": want})
    left = min((x["frame"]["x"] for x in f), default=None)
    c(f"{tag}: leftmost tile x == area.x + {GAP}", left is not None and abs(left - (area["x"] + GAP)) <= 0.5,
      {"leftmost": left, "expected": area["x"] + GAP})
    d = delta(before, after)
    if output is None:
        c(f"{tag}: retiled exactly once (solves +1)", d.get("solves", 0) == 1, d)
    else:
        mine = [r for r in recs if r["kind"] == "solve" and str(r.get("id", "")).startswith(output + "\u241f")]
        c(f"{tag}: {output}'s context retiled exactly once", len(mine) == 1, {"solves": len(mine), "counters": d})
    c(f"{tag}: each tile written at most once (writes <= {n})", d.get("writes", 0) <= n, d)
    kinds = [r["kind"] for r in recs]
    c(f"{tag}: adapter topology path triggered (trace has 'topology')", "topology" in kinds,
      {k: kinds.count(k) for k in sorted(set(kinds))})


def panel_record(s: Session) -> list[dict]:
    return json.loads(s.js(PANEL_INFO)[0])


# ----------------------------------------------------------------- scenarios
@scenario("workarea-panel-add-remove-O07")
def panel_add_remove(out: Path, c: Checks):
    """(a) a 40 px bottom panel appears under 3 tiles; (b) it disappears again."""
    with Session(out) as s:
        three(s)
        s.load()
        s.settle()
        a0 = s.area()
        c0 = s.counters()
        t0 = last_t(s)
        p = spawn_panel(s, "bottom", "bottom", 40)
        try:
            shrunk = until(lambda: s.area()["height"] == a0["height"] - 40)
            a1 = s.area()
            c("a: work area shrinks by exactly 40 px at the bottom", shrunk and a1["y"] == a0["y"] and a1["x"] == a0["x"]
              and a1["width"] == a0["width"] and a1["height"] == a0["height"] - 40, {"before": a0, "after": a1})
            until(lambda: abs(max(bottom(x["frame"]) for x in tiles(s)) - (a1["y"] + a1["height"] - GAP)) <= 0.5, 4.0)
            time.sleep(0.5)
            c1 = s.settle()
            info = panel_record(s)
            c("a: KWin reports the panel as a dock", len(info) == 1 and info[0]["dock"] and info[0]["windowType"] == 2, info)
            c("a: panel occupies the bottom 40 px", len(info) == 1 and near(info[0]["frame"], {
                "x": a0["x"], "y": a0["y"] + a0["height"] - 40, "width": a0["width"], "height": 40}), info)
            retile_checks(c, "a", s, a1, c0, c1, trace_since(s, t0))
            time.sleep(1.0)
            c1b = s.settle()
            c("a: converged (no further writes 1 s later)", delta(c1, c1b).get("writes", 0) == 0, delta(c1, c1b))
            t1 = last_t(s)
            quit_panel(p)
            restored = until(lambda: s.area() == a0)
            a2 = s.area()
            c("b: work area restored after the panel exits", restored, {"expected": a0, "got": a2})
            until(lambda: abs(max(bottom(x["frame"]) for x in tiles(s)) - (a2["y"] + a2["height"] - GAP)) <= 0.5, 4.0)
            time.sleep(0.5)
            c2 = s.settle()
            retile_checks(c, "b", s, a2, c1b, c2, trace_since(s, t1))
            c("model invariants: no errors", c2["counters"]["errors"] == 0, c2["counters"]["errors"])
            (out / "panel-info.json").write_text(json.dumps(info, indent=1))
        finally:
            quit_panel(p)


@scenario("workarea-panel-before-load-O07")
def panel_before_load(out: Path, c: Checks):
    """(c) the panel exists before Plastile loads: the initial tiling respects it."""
    with Session(out) as s:
        a0 = s.area()
        p = spawn_panel(s, "bottom", "bottom", 40)
        try:
            c("c: work area shrinks by 40 px before load", until(lambda: s.area()["height"] == a0["height"] - 40), s.area())
            a1 = s.area()
            three(s)
            s.load()
            s.settle()
            time.sleep(0.5)
            c1 = s.settle()
            f = tiles(s)
            errs = tiling_errors(f, a1, GAP)
            c("c: 3 tiles inside the panel-reduced area", len(f) == 3 and not errs, errs or [x["frame"] for x in f])
            low = max(bottom(x["frame"]) for x in f)
            c("c: lowest tile bottom == area.bottom - 8", abs(low - (a1["y"] + a1["height"] - GAP)) <= 0.5,
              {"lowestBottom": low, "area": a1})
            c("c: initial adoption is one solve", c1["counters"]["solves"] == 1, c1["counters"])
            c("c: panel itself is not adopted (adapter registers it as a dock)", c1["windows"] >= 4 and
              all(x["caption"] for x in f), {"adapterWindows": c1["windows"], "tiles": len(f)})
        finally:
            quit_panel(p)


@scenario("workarea-two-panels-O07")
def two_panels(out: Path, c: Checks):
    """(d) a 48 px left panel, then a 40 px bottom panel, with 3 tiles."""
    with Session(out) as s:
        three(s)
        s.load()
        s.settle()
        a0 = s.area()
        panels = []
        try:
            c0 = s.counters()
            t0 = last_t(s)
            panels.append(spawn_panel(s, "left", "left", 48))
            ok = until(lambda: s.area()["x"] == a0["x"] + 48)
            a1 = s.area()
            c("d: left panel reserves 48 px", ok and a1["width"] == a0["width"] - 48 and a1["height"] == a0["height"], a1)
            until(lambda: abs(min(x["frame"]["x"] for x in tiles(s)) - (a1["x"] + GAP)) <= 0.5, 4.0)
            time.sleep(0.5)
            c1 = s.settle()
            retile_checks(c, "d-left", s, a1, c0, c1, trace_since(s, t0))
            t1 = last_t(s)
            panels.append(spawn_panel(s, "bottom", "bottom", 40))
            ok = until(lambda: s.area()["height"] == a0["height"] - 40)
            a2 = s.area()
            c("d: left + bottom panel: area is the intersection", ok and a2 == {
                "x": a0["x"] + 48, "y": a0["y"], "width": a0["width"] - 48, "height": a0["height"] - 40}, a2)
            until(lambda: abs(max(bottom(x["frame"]) for x in tiles(s)) - (a2["y"] + a2["height"] - GAP)) <= 0.5, 4.0)
            time.sleep(0.5)
            c2 = s.settle()
            retile_checks(c, "d-both", s, a2, c1, c2, trace_since(s, t1))
            info = panel_record(s)
            (out / "panel-info.json").write_text(json.dumps(info, indent=1))
            c("d: both panels reported as docks", len(info) == 2 and all(x["dock"] for x in info), info)
        finally:
            for p in panels:
                quit_panel(p)


@scenario("workarea-panel-one-output-O07")
def panel_one_output(out: Path, c: Checks):
    """(e) two outputs; a panel on Virtual-1 changes only Virtual-1's context."""
    with Session(out, outputs=2) as s:
        three(s)
        s.load()
        s.settle()
        for cap in ("plastile-fixture 2", "plastile-fixture 3"):
            s.act(cap, "workspace.activeWindow = w")
            s.cmd("move.output-next")
            s.settle()
        time.sleep(0.5)
        s.settle()
        a0, a1 = s.area(0), s.area(1)
        on0 = tiles(s, "Virtual-0")
        on1 = tiles(s, "Virtual-1")
        c("e: setup: 1 tile on Virtual-0, 2 on Virtual-1", len(on0) == 1 and len(on1) == 2,
          [(x["caption"], x["output"]) for x in tiles(s)])
        before0 = {x["id"]: x["frame"] for x in on0}
        c0 = s.counters()
        t0 = last_t(s)
        p = spawn_panel(s, "bottom-v1", "bottom", 40, "Virtual-1")
        try:
            ok = until(lambda: s.area(1)["height"] == a1["height"] - 40)
            b0, b1 = s.area(0), s.area(1)
            c("e: Virtual-1 area shrinks by 40, Virtual-0 area unchanged", ok and b0 == a0 and b1["height"] == a1["height"] - 40,
              {"v0": [a0, b0], "v1": [a1, b1]})
            until(lambda: abs(max(bottom(x["frame"]) for x in tiles(s, "Virtual-1")) - (b1["y"] + b1["height"] - GAP)) <= 0.5, 4.0)
            time.sleep(0.5)
            c1 = s.settle()
            recs = trace_since(s, t0)
            retile_checks(c, "e-Virtual-1", s, b1, c0, c1, recs, output="Virtual-1", n=2)
            after0 = {x["id"]: x["frame"] for x in tiles(s, "Virtual-0")}
            c("e: Virtual-0 tiles untouched (oracle frames identical)", after0 == before0, {"before": before0, "after": after0})
            w0 = [r for r in recs if r["kind"] == "write" and r.get("id") in before0]
            c("e: zero writes to Virtual-0 windows", not w0, w0)
            solves = [r.get("id") for r in recs if r["kind"] == "solve"]
            c("e: no Virtual-0 context solve produced work (solves listed for the record)",
              not w0, {"solvedContexts": [str(x).split("\u241f")[0] for x in solves]})
            info = panel_record(s)
            c("e: panel is on Virtual-1", len(info) == 1 and info[0]["output"] == "Virtual-1", info)
        finally:
            quit_panel(p)


@scenario("workarea-hidden-desktop-O07")
def panel_hidden_desktop(out: Path, c: Checks):
    """(f) a panel appears while another desktop is shown (physical runbook, KWin 6.7.5).

    KWin's own work-area check (checkWorkspacePosition) confines the windows of the hidden
    desktop to the new area. Plastile must not correct or write to them while hidden, nothing
    may diverge, and they tile into the new area when their desktop is shown again. Two cases:
    "move": three tiles and a 48 px panel; KWin only moves the stack column left (a position
    change, applied synchronously inside KWin's rearrange, before the panel is announced).
    "resize": one full-width tile, as in the physical session; KWin must shrink it, which is a
    configure the client commits after Plastile's area-change flush (the physical order).
    "slow": the same with a client that answers configures after 1 s, slower than the 750 ms
    convergence deadline (as a client on a hidden desktop that gets no frame callbacks may be):
    without the fix this reproduces the physical divergence, a correction then "diverged".
    """
    hidden_case(out / "move", c, "f-move", 3)
    hidden_case(out / "resize", c, "f-resize", 1)
    hidden_case(out / "slow", c, "f-slow", 1, ("--configure-delay-ms", "1000"))


def hidden_case(out: Path, c: Checks, tag: str, n: int, args: tuple[str, ...] = ()):
    panel = 48
    slow = bool(args)
    with Session(out, config={"traceCapacity": 8192}) as s:
        s.js("workspace.createDesktop(1, 'Two'); emit(1)")
        for i in range(1, n + 1):
            s.spawn(i, *args)
        s.load()
        s.settle()
        a0 = s.area()
        ids = {x["id"]: x["caption"] for x in tiles(s)}
        f0 = {x["id"]: x["frame"] for x in tiles(s)}
        c(f"{tag}: setup: {n} tiles on desktop 1", len(ids) == n and not tiling_errors(tiles(s), a0, GAP), list(f0.values()))
        s.js("workspace.currentDesktop = workspace.desktops[1]; emit(1)")
        s.settle()
        c(f"{tag}: desktop 2 shown", json.loads(s.js("emit(workspace.currentDesktop.x11DesktopNumber)")[0]) == 2)
        c0 = s.counters()
        t0 = last_t(s)
        p = spawn_panel(s, "right", "right", panel)
        try:
            shrunk = until(lambda: s.area()["width"] == a0["width"] - panel)
            a1 = s.area()
            c(f"{tag}: work area shrinks by {panel} px on the right", shrunk and a1["x"] == a0["x"] and a1["width"] == a0["width"] - panel, a1)
            # KWin's confinement commits asynchronously; then wait past the convergence deadline
            # (750 ms) twice so a correction and its expiry would both have happened.
            until(lambda: all(x["frame"]["x"] + x["frame"]["width"] <= a1["x"] + a1["width"] + 0.5 for x in tiles(s)), 3.0)
            time.sleep(2.0)
            c1 = s.settle()
            hidden = {x["id"]: x["frame"] for x in tiles(s)}
            moved = sorted(ids[i] for i in hidden if hidden[i] != f0[i])
            # Precondition, not Plastile's work: KWin itself moved the hidden windows (the physical trigger).
            c(f"{tag}: KWin confined the hidden desktop-1 windows to the new area itself", bool(moved),
              {"moved": moved, "before": f0, "after": hidden})
            if n == 1:
                resized = [ids[i] for i in hidden if hidden[i]["width"] != f0[i]["width"]]
                c(f"{tag}: KWin resized the full-width hidden window (a configure, committed after the area flush)",
                  bool(resized), {"before": f0, "after": hidden})
            recs = trace_since(s, t0)
            w = [r for r in recs if r["kind"] == "write" and r.get("id") in ids]
            c(f"{tag}: zero writes to the desktop-1 windows while hidden (Plastile trace)", not w, w)
            d = delta(c0, c1)
            c(f"{tag}: no correction and no divergence while hidden", d.get("corrections", 0) == 0 and d.get("diverged", 0) == 0, d)
            c(f"{tag}: no deadline expiry while hidden (nothing was requested)", d.get("deadlines", 0) == 0, d)
            kinds = [r["kind"] for r in recs]
            c(f"{tag}: the hidden changes are recorded as deferred, not as external drift",
              "external" not in kinds and ("hidden-external" in kinds or not moved),
              {k: kinds.count(k) for k in sorted(set(kinds))})
            t1 = last_t(s)
            s.js("workspace.currentDesktop = workspace.desktops[0]; emit(1)")
            until(lambda: not tiling_errors(tiles(s), s.area(), GAP) and
                  abs(max(x["frame"]["x"] + x["frame"]["width"] for x in tiles(s)) - (a1["x"] + a1["width"] - GAP)) <= 0.5, 4.0)
            time.sleep(0.5)
            c2 = s.settle()
            a2 = s.area()
            f = tiles(s)
            errs = tiling_errors(f, a2, GAP)
            c(f"{tag}: shown again: {n} tiles inside the new area, no overlap, gaps>=8", len(f) == n and a2 == a1 and not errs,
              errs or [x["frame"] for x in f])
            right = max((x["frame"]["x"] + x["frame"]["width"] for x in f), default=None)
            c(f"{tag}: shown again: rightmost tile edge == area.right - 8 (fills the new area)",
              right is not None and abs(right - (a2["x"] + a2["width"] - GAP)) <= 0.5,
              {"rightmost": right, "expected": a2["x"] + a2["width"] - GAP})
            d2 = delta(c1, c2)
            mine = [r for r in trace_since(s, t1) if r["kind"] == "write" and r.get("id") in ids]
            per = {ids[i]: sum(1 for r in mine if r["id"] == i) for i in ids}
            if slow:
                # Visible now: a client slower than the deadline gets its ordinary bounded correction.
                c(f"{tag}: shown again: one solve, at most one plan write plus the correction budget, no divergence",
                  d2.get("solves", 0) == 1 and all(k <= 3 for k in per.values()) and d2.get("diverged", 0) == 0,
                  {"writes": per, "counters": d2})
            else:
                c(f"{tag}: shown again: one solve, each tile written at most once, no correction or divergence",
                  d2.get("solves", 0) == 1 and all(k <= 1 for k in per.values()) and d2.get("corrections", 0) == 0
                  and d2.get("diverged", 0) == 0, {"writes": per, "counters": d2})
            time.sleep(1.0)
            c3 = s.settle()
            c(f"{tag}: converged (no further writes 1 s later)", delta(c2, c3).get("writes", 0) == 0, delta(c2, c3))
            # Explain activates the window, which would switch desktops: only once desktop 1 is shown.
            ex = [explain(s, ids[i]) for i in ids]
            c(f"{tag}: no window explained as diverged", all(not e.get("exception") for e in ex),
              [(e.get("id"), e.get("exception"), e.get("ledger")) for e in ex])
            c(f"{tag}: model invariants: no errors", c3["counters"]["errors"] == 0, c3["counters"]["errors"])
        finally:
            quit_panel(p)
