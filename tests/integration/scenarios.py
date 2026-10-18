"""Integration scenarios (TEST_MATRIX IDs in names). Each runs in a fresh nested KWin."""
from __future__ import annotations

import json
import time
from pathlib import Path

import os
import re

from harness import Session, delta, explain, fixture_events, near, tiling_errors, trace, steady_connections

SCENARIOS = {}


def scenario(name):
    def deco(fn):
        SCENARIOS[name] = fn
        return fn
    return deco


class Skipped(Exception):
    """A capability the scenario needs is absent from this environment.

    run.py reports the scenario as SKIP with this reason, by ID. A skip is never
    counted as a pass, and `run.py --fail-on-skip` turns it into a failure.
    """


class Checks:
    def __init__(self):
        self.items: dict[str, dict] = {}

    def __call__(self, name: str, ok: bool, detail=None):
        self.items[name] = {"pass": bool(ok), "detail": detail}
        return ok


def three(s: Session, *extra_for_3: str):
    s.spawn(1); s.spawn(2); s.spawn(3, *extra_for_3)


@scenario("adopt-open-close")
def adopt_open_close(out: Path, c: Checks):
    with Session(out) as s:
        three(s)
        s.load()
        s.settle()
        a = s.area()
        f = s.frames_list()
        c("adopt: 3 tiled, no overlap, gaps>=8", not tiling_errors(f, a, 8), tiling_errors(f, a, 8))
        c0 = s.counters()
        c("adopt: one solve, writes<=3", c0["counters"]["solves"] == 1 and c0["counters"]["writes"] <= 3, c0["counters"])
        s.spawn(4)
        c1 = s.settle()
        f4 = s.frames_list()
        c("open: 4 tiled, no overlap", len(f4) == 4 and not tiling_errors(f4, a, 8), tiling_errors(f4, a, 8))
        c("open: one solve for one window", delta(c0, c1).get("solves", 0) == 1, delta(c0, c1))
        s.kill(2)
        c2 = s.settle()
        f3 = s.frames_list()
        c("close: 3 tiled after close", len(f3) == 3 and not tiling_errors(f3, a, 8), tiling_errors(f3, a, 8))
        c("close: one solve", delta(c1, c2).get("solves", 0) == 1, delta(c1, c2))
        c("model invariants: no errors", c2["counters"]["errors"] == 0, c2["counters"]["errors"])


@scenario("noop-and-focus-C11-C12")
def noop_focus(out: Path, c: Checks):
    with Session(out) as s:
        three(s)
        s.load(); s.settle()
        a = s.counters()
        s.cmd("layout.master-stack")
        s.cmd("context.reset")
        b = s.settle()
        d = delta(a, b)
        c("C11 positive control: both commands ran and the reset re-solved all three windows "
          "(commands +2, solves +1, skipNoop +3)", d.get("commands", 0) == 2 and d.get("solves", 0) == 1
          and d.get("skipNoop", 0) >= 3, d)
        c("C11: no-op layout + context reset write nothing", d.get("writes", 0) == 0, d)
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        a = s.counters()
        for cmd in ("focus.right", "focus.down", "focus.left", "focus.next", "focus.previous", "focus.master"):
            s.cmd(cmd); time.sleep(0.05)
        b = s.settle()
        d = delta(a, b)
        c("C12 positive control: all six focus commands were dispatched (commands +6)", d.get("commands", 0) == 6, d)
        c("C12: focus commands solve/write nothing", d.get("solves", 0) == 0 and d.get("writes", 0) == 0, d)
        c("C12: focus commands activate windows", d.get("activations", 0) >= 4, d)


@scenario("ratio-reversal-G05")
def ratio_reversal(out: Path, c: Checks):
    with Session(out) as s:
        three(s, "--configure-delay-ms", "300", "--delay-mode", "latest")
        s.load(); s.settle()
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        pre = s.frames()
        s.cmd("resize.grow")
        s.settle()
        grown = s.frames()
        c("grow: master widened", grown["plastile-fixture 1"]["frame"]["width"] > pre["plastile-fixture 1"]["frame"]["width"])
        s.cmd("resize.shrink")
        s.settle()
        ok = []
        a = s.counters()
        for _ in range(5):
            before = s.frames()
            s.cmd("resize.grow"); time.sleep(0.05); s.cmd("resize.shrink")
            time.sleep(1.2)
            s.settle()
            after = s.frames()
            ok.append(all(near(after[k]["frame"], before[k]["frame"], 1.0) for k in before))
        b = s.counters()
        d = delta(a, b)
        c("G05: A->B->A with 300 ms client ends at A (5/5)", all(ok), ok)
        c("G05: corrections bounded (<= 2 per reversal)", d.get("corrections", 0) <= 10, d)


@scenario("swap-move-layouts-L06")
def swap_layouts(out: Path, c: Checks):
    with Session(out) as s:
        three(s); s.spawn(4)
        s.load(); s.settle()
        a = s.area()
        s.act("plastile-fixture 3", "workspace.activeWindow = w")
        before = s.frames()
        s.cmd("swap.master"); s.settle()
        after = s.frames()
        c("swap.master: fixture 3 takes the master slot",
          near(after["plastile-fixture 3"]["frame"], before["plastile-fixture 1"]["frame"], 1.0))
        for layout in ("bsp", "monocle", "master-stack"):
            s.cmd(f"layout.{layout}")
            s.settle()
            f = s.frames_list()
            if layout == "monocle":
                full = [x for x in f if near(x["frame"], {"x": a["x"] + 8, "y": a["y"] + 8, "width": a["width"] - 16, "height": a["height"] - 16}, 1.0)]
                c("monocle: all members full-area", len(full) == 4, [x["frame"] for x in f])
            else:
                c(f"{layout}: tiled without overlap", not tiling_errors(f, a, 8), tiling_errors(f, a, 8))
        final = s.frames()
        c("L06: order preserved across layout round trip",
          near(final["plastile-fixture 3"]["frame"], after["plastile-fixture 3"]["frame"], 1.0))
        s.cmd("layout.bsp"); s.settle()
        s.act("plastile-fixture 3", "workspace.activeWindow = w")
        for cmd in ("layout.rotate-clockwise", "layout.mirror-horizontal", "move.right", "resize.equalize"):
            s.cmd(cmd); s.settle()
            f = s.frames_list()
            c(f"bsp {cmd}: tiled without overlap", not tiling_errors(f, a, 8), tiling_errors(f, a, 8))
        s.cmd("layout.floating"); s.settle()
        c0 = s.counters()
        s.act("plastile-fixture 2", "w.frameGeometry = {x: 100, y: 100, width: 300, height: 250}")
        time.sleep(0.5)
        c1 = s.settle()
        c("floating layout: user geometry is not fought", near(s.frames()["plastile-fixture 2"]["frame"],
          {"x": 100, "y": 100, "width": 300, "height": 250}, 1.0) and delta(c0, c1).get("writes", 0) == 0, delta(c0, c1))


@scenario("burst-C09")
def burst(out: Path, c: Checks):
    # KWin reports a 150x150 client minimum by default (178 px frame height with the
    # titlebar), so nine windows need a tall output to all fit without overflow.
    with Session(out, height=1600) as s:
        three(s)
        s.load(); s.settle()
        a = s.counters()
        for i in range(4, 10):
            s.spawn(i, wait=False)
        s.wait_for(lambda: len(s.frames_list()) == 9, 8, "9 windows")
        b = s.settle()
        d = delta(a, b)
        f = s.frames_list()
        area = s.area()
        c("burst: 9 tiled without overlap", not tiling_errors(f, area, 8), tiling_errors(f, area, 8))
        c("burst: solves bounded (< windows added)", d.get("solves", 0) <= 6, d)
        for i in range(4, 10):
            s.kill(i, wait=False)
        s.wait_for(lambda: len(s.frames_list()) == 3, 8, "3 windows")
        e = s.settle()
        f = s.frames_list()
        c("burst remove: back to 3 tiled", not tiling_errors(f, area, 8) and len(f) == 3, tiling_errors(f, area, 8))
        c("burst remove: solves bounded", delta(b, e).get("solves", 0) <= 6, delta(b, e))


@scenario("constraints-G08-G12")
def constraints(out: Path, c: Checks):
    with Session(out, config={"traceCapacity": 8192}) as s:
        three(s)
        s.load(); s.settle()
        area = s.area()
        a = s.counters()
        f4 = s.spawn(4, "--min", "900x700", "--clamp")
        time.sleep(3.0)
        b = s.settle()
        d = delta(a, b)
        c("G08: min-size client bounded (writes <= 10)", d.get("writes", 0) <= 10, d)
        c("G08: converged (no outstanding)", b["outstanding"] == 0, b["outstanding"])
        time.sleep(2.0)
        b2 = s.counters()
        c("G08: no further work after convergence", delta(b, b2).get("writes", 0) == 0, delta(b, b2))
        # Positive controls: the overflow is explained and the windows that fit are still tiled.
        e4 = explain(s, "plastile-fixture 4")
        exc = str(e4.get("exception") or "")
        f = s.frames()
        k4 = f["plastile-fixture 4"]
        tiled = [f[f"plastile-fixture {i}"] for i in (1, 2, 3)]
        if e4.get("mode") == "floating":
            c("G08: overflow explained: the window floats with an 'overflow: ...' exception naming the failed constraint",
              exc.startswith("overflow:") and re.search(r"needs? \d+ px", exc) is not None and d.get("overflow", 0) >= 1,
              {"mode": e4.get("mode"), "exception": exc, "overflow": d.get("overflow", 0)})
        else:
            c("G08: tiled at or above its minimum (oracle client >= 900x700)",
              e4.get("mode") == "tiled" and k4["client"]["width"] >= 899.5 and k4["client"]["height"] >= 699.5, k4)
        c("G08: the client kept its own minimum (oracle client >= 900x700, never shrunk below it)",
          k4["client"]["width"] >= 899.5 and k4["client"]["height"] >= 699.5, k4["client"])
        c("G08: the windows that fit still tile the area (oracle, gaps>=8)",
          not tiling_errors(tiled, area, 8) and tiled[0]["frame"]["height"] >= area["height"] - 16.5, tiling_errors(tiled, area, 8))
        cfg4 = [e for e in fixture_events(f4.log, "configure") if 0 < e["width"] < 900 or 0 < e["height"] < 700]
        c("G08 (recorded): configures below the client minimum it received", True, len(cfg4))
        s.kill(4); s.settle()
        a = s.counters()
        f5 = s.spawn(5, "--ignore-size")
        cfg_spawn = len(fixture_events(f5.log, "configure"))
        time.sleep(4.0)
        b = s.settle()
        time.sleep(2.0)
        b2 = s.counters()
        d = delta(a, b)
        c("G12: ignoring client corrected within budget", d.get("corrections", 0) <= 3, d)
        c("G12: no endless retries", delta(b, b2).get("writes", 0) == 0, delta(b, b2))
        # Positive controls: Plastile did try to place the window, then recorded a visible fallback.
        e5 = explain(s, "plastile-fixture 5")
        wid5 = e5.get("id")
        w5 = [r for r in trace(s) if r.get("kind") == "write" and r.get("id") == wid5]
        sized = [e for e in fixture_events(f5.log, "configure") if e["width"] > 0]
        c("G12 positive control: classified tiled and sent requests (>= 1 write; the client received sized configures)",
          (e5.get("decision") or {}).get("mode") == "tiled" and len(w5) >= 1 and len(sized) >= 1,
          {"decision": e5.get("decision"), "writes": len(w5), "sizedConfigures": len(sized), "configuresAtSpawn": cfg_spawn})
        led = e5.get("ledger") or {}
        c("G12: visible fallback: the explanation records that Plastile stopped insisting (exception set; diverged or learned)",
          bool(e5.get("exception")) and (led.get("status") == "diverged" or e5.get("learnedMax") is not None
                                         or e5.get("learnedMin") is not None),
          {"exception": e5.get("exception"), "ledger": led, "learnedMax": e5.get("learnedMax"), "learnedMin": e5.get("learnedMin")})
        n = len(fixture_events(f5.log, "configure"))
        time.sleep(1.5)
        c("G12: client-side quiet: no further configures after the fallback (client log)",
          len(fixture_events(f5.log, "configure")) == n, {"before": n, "after": len(fixture_events(f5.log, "configure"))})


@scenario("app-resize-G11")
def app_resize(out: Path, c: Checks):
    with Session(out, config={"traceCapacity": 8192}) as s:
        s.spawn(1); fx = s.spawn(2)
        s.load(); s.settle()
        a = s.counters()
        for i in range(5):
            fx.send(f"resize {300 + 10 * i} {250 + 10 * i}")
            time.sleep(0.3)
        time.sleep(1.0)
        b = s.settle()
        d = delta(a, b)
        c("G11: self-resizing app corrected at most twice", d.get("corrections", 0) <= 2, d)
        time.sleep(1.5)
        c("G11: then left alone", delta(b, s.counters()).get("writes", 0) == 0)
        # Positive controls: the app really resized itself, Plastile saw it and reacted, and the outcome is explained.
        ev = fixture_events(fx.log)
        resizes = [e for e in ev if e.get("ev") == "commit" and e.get("reason") == "app-resize"]
        t_first = resizes[0]["t_ns"] if resizes else None
        reacted = [e for e in ev if e.get("ev") == "configure" and t_first is not None and e["t_ns"] > t_first and e["width"] > 0]
        c("G11 precondition: the client committed five self-initiated sizes (client log)", len(resizes) == 5, len(resizes))
        c("G11 positive control: Plastile observed the external changes and corrected at least once "
          "(external >= 1, corrections >= 1, the client received a sized configure afterwards)",
          d.get("external", 0) >= 1 and d.get("corrections", 0) >= 1 and len(reacted) >= 1,
          {"delta": d, "configuresAfterFirstResize": len(reacted)})
        e2 = explain(s, "plastile-fixture 2")
        f2 = s.frames()["plastile-fixture 2"]["frame"]
        c("G11: outcome defined: back in its slot (oracle frame == plan) or yielded with an explanation",
          near(f2, e2.get("slot") or {"x": -1, "y": -1, "width": -1, "height": -1}, 1.0) or "own size" in str(e2.get("exception")),
          {"frame": f2, "slot": e2.get("slot"), "exception": e2.get("exception"), "ledger": e2.get("ledger")})


@scenario("states-L09-L12")
def states(out: Path, c: Checks):
    with Session(out) as s:
        three(s)
        s.load(); s.settle()
        area = s.area()
        pre = s.frames()
        s.act("plastile-fixture 2", "w.fullScreen = true")
        time.sleep(0.6); s.settle()
        f = s.frames()
        c("L10: fullscreen respected (full output)", f["plastile-fixture 2"]["fullScreen"] and
          f["plastile-fixture 2"]["frame"]["width"] >= 1280 - 1, f["plastile-fixture 2"]["frame"])
        two = [x for k, x in f.items() if k != "plastile-fixture 2"]
        c("L10: peers reflowed without the fullscreen window", not tiling_errors(two, area, 8) and
          two[0]["frame"]["height"] > 700 and two[1]["frame"]["height"] > 700, [x["frame"] for x in two])
        s.act("plastile-fixture 2", "w.minimized = true")
        s.act("plastile-fixture 2", "w.fullScreen = false")
        time.sleep(0.5); s.settle()
        f = s.frames()
        c("L12: minimized window untouched when only fullscreen clears", f["plastile-fixture 2"]["minimized"])
        s.act("plastile-fixture 2", "w.minimized = false")
        time.sleep(0.5); s.settle()
        f = s.frames()
        c("L09: unminimize restores the old slot", near(f["plastile-fixture 2"]["frame"], pre["plastile-fixture 2"]["frame"], 1.0),
          (f["plastile-fixture 2"]["frame"], pre["plastile-fixture 2"]["frame"]))
        a = s.counters()
        s.act("plastile-fixture 1", "w.setMaximize(true, true)")
        time.sleep(1.5); s.settle()
        f = s.frames()
        b = s.counters()
        c("L11: maximize respected", f["plastile-fixture 1"]["maximizeMode"] == 3 and f["plastile-fixture 1"]["frame"]["width"] >= 1279,
          f["plastile-fixture 1"])
        c("L11: no write to the maximized window", delta(a, b).get("corrections", 0) == 0, delta(a, b))
        s.act("plastile-fixture 1", "w.setMaximize(false, false)")
        time.sleep(0.8); s.settle()
        f = s.frames()
        c("L11: restore returns to the tile", near(f["plastile-fixture 1"]["frame"], pre["plastile-fixture 1"]["frame"], 1.0),
          f["plastile-fixture 1"]["frame"])


@scenario("native-quicktile-L13")
def quicktile(out: Path, c: Checks):
    with Session(out) as s:
        three(s)
        s.load(); s.settle()
        s.act("plastile-fixture 2", "workspace.activeWindow = w; workspace.slotWindowQuickTileLeft()")
        time.sleep(1.0); s.settle()
        f = s.frames()
        q = f["plastile-fixture 2"]["frame"]
        c("L13: native quick tile kept (not snapped back)", q["x"] <= 1 and abs(q["width"] - 640) <= 9, q)
        others = [f["plastile-fixture 1"], f["plastile-fixture 3"]]
        c("L13: remaining windows retiled as two", others[0]["frame"]["height"] > 700 and others[1]["frame"]["height"] > 700,
          [o["frame"] for o in others])
        s.act("plastile-fixture 2", "workspace.activeWindow = w")
        s.cmd("window.adopt-native")
        time.sleep(0.6); s.settle()
        f = s.frames_list()
        c("L13: adopt-native retiles three", not tiling_errors(f, s.area(), 8) and not s.frames()["plastile-fixture 2"]["tile"],
          tiling_errors(f, s.area(), 8))


@scenario("float-toggle-L08")
def float_toggle(out: Path, c: Checks):
    with Session(out) as s:
        three(s)
        s.load(); s.settle()
        s.act("plastile-fixture 3", "workspace.activeWindow = w")
        s.cmd("window.toggle-float"); s.settle()
        s.act("plastile-fixture 3", "w.frameGeometry = {x: 300, y: 200, width: 500, height: 350}")
        time.sleep(0.5); s.settle()
        f = s.frames()
        c("float: user geometry kept", near(f["plastile-fixture 3"]["frame"], {"x": 300, "y": 200, "width": 500, "height": 350}, 1.0),
          f["plastile-fixture 3"]["frame"])
        c("float: two remaining tiles", f["plastile-fixture 1"]["frame"]["height"] > 700 and f["plastile-fixture 2"]["frame"]["height"] > 700)
        s.cmd("window.toggle-float"); s.settle()
        f = s.frames_list()
        c("tile again: three tiled", not tiling_errors(f, s.area(), 8), tiling_errors(f, s.area(), 8))
        s.cmd("window.toggle-float"); time.sleep(0.5); s.settle()
        f = s.frames()
        c("L08: float again restores the latest floating geometry",
          near(f["plastile-fixture 3"]["frame"], {"x": 300, "y": 200, "width": 500, "height": 350}, 1.0), f["plastile-fixture 3"]["frame"])


STACK_INFO = ("({stack: workspace.stackingOrder.indexOf(w), minimized: w.minimized, hidden: w.hidden, active: w.active,"
              " frame: {x: w.frameGeometry.x, y: w.frameGeometry.y, width: w.frameGeometry.width, height: w.frameGeometry.height}})")


@scenario("transient-dialog-L07")
def transient(out: Path, c: Checks):
    """A transient child floats; then, in monocle (TEST_MATRIX L07), selecting its parent keeps the dialog usable."""
    from harness import window_info
    with Session(out, config={"traceCapacity": 8192}) as s:
        s.spawn(1); s.spawn(2, "--parent-after-ms", "200")
        s.load()
        time.sleep(1.0); s.settle()
        f = s.frames_list()
        children = [x for x in f if x["caption"].endswith("child")]
        mains = [x for x in f if not x["caption"].endswith("child")]
        c("transient child exists", len(children) == 1, [x["caption"] for x in f])
        c("transient child floats (not tiled)", children and children[0]["frame"]["width"] == 300, children and children[0]["frame"])
        c("two mains tiled", len(mains) == 2 and not tiling_errors(mains, s.area(), 8), tiling_errors(mains, s.area(), 8))
        child = "plastile-fixture 2 child"
        child0 = window_info(s, child, STACK_INFO)
        # L07: monocle, with the transient's parent selected.
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        s.cmd("layout.monocle")
        time.sleep(0.4); s.settle()
        s.act("plastile-fixture 2", "workspace.activeWindow = w")
        time.sleep(0.4); s.settle()
        area = s.area()
        fr = s.frames()
        p2 = window_info(s, "plastile-fixture 2", STACK_INFO)
        p1 = window_info(s, "plastile-fixture 1", STACK_INFO)
        ch = window_info(s, child, STACK_INFO)
        full = {"x": area["x"] + 8, "y": area["y"] + 8, "width": area["width"] - 16, "height": area["height"] - 16}
        c("L07 precondition: monocle: both members fill the area (oracle)",
          all(near(fr[k]["frame"], full, 1.0) for k in ("plastile-fixture 1", "plastile-fixture 2")),
          {k: fr[k]["frame"] for k in ("plastile-fixture 1", "plastile-fixture 2")})
        c("L07: the selected member (the parent) is on top of the other member (stacking order)", p2["stack"] > p1["stack"],
          {"parent": p2["stack"], "other": p1["stack"]})
        c("L07: the dialog is not hidden: visible, not minimized, above its parent (stacking order)",
          not ch["minimized"] and not ch["hidden"] and ch["stack"] > p2["stack"], {"dialog": ch, "parent": p2["stack"]})
        c("L07: the dialog keeps its own floating geometry (oracle unchanged)", near(ch["frame"], child0["frame"], 0.5),
          {"before": child0["frame"], "after": ch["frame"]})
        # Focusing the dialog does not change the monocle selection or hide anything.
        s.act(child, "workspace.activeWindow = w")
        time.sleep(0.4); s.settle()
        p1b, p2b, chb = (window_info(s, k, STACK_INFO) for k in ("plastile-fixture 1", "plastile-fixture 2", child))
        c("L07: activating the dialog keeps it on top and the parent selected", chb["active"] and chb["stack"] > p2b["stack"] > p1b["stack"],
          {"dialog": chb, "parent": p2b["stack"], "other": p1b["stack"]})
        wid = {x["caption"]: x["id"] for x in s.frames_list()}
        w = [r for r in trace(s) if r.get("kind") == "write" and r.get("id") == wid.get(child)]
        c("L07: Plastile never wrote the dialog (trace)", not w, len(w))


@scenario("outputs-O01")
def outputs(out: Path, c: Checks):
    with Session(out, outputs=2) as s:
        three(s)
        s.load(); s.settle()
        a0, a1 = s.area(0), s.area(1)
        s.act("plastile-fixture 3", "workspace.activeWindow = w")
        s.cmd("move.output-next")
        time.sleep(0.8); s.settle()
        f = s.frames()
        on1 = [x for x in f.values() if x["output"] == "Virtual-1"]
        on0 = [x for x in f.values() if x["output"] == "Virtual-0"]
        c("O01: window sent to the other output", len(on1) == 1 and on1[0]["caption"] == "plastile-fixture 3", [(x["caption"], x["output"]) for x in f.values()])
        c("O01: destination tiled full area", on1 and near(on1[0]["frame"], {"x": a1["x"] + 8, "y": a1["y"] + 8, "width": a1["width"] - 16, "height": a1["height"] - 16}, 1.0),
          on1 and on1[0]["frame"])
        c("O01: source reflowed", len(on0) == 2 and not tiling_errors(on0, a0, 8), tiling_errors(on0, a0, 8))


@scenario("desktops-L15")
def desktops(out: Path, c: Checks):
    with Session(out) as s:
        s.js("workspace.createDesktop(1, 'Two'); emit(workspace.desktops.length);")
        three(s)
        s.load(); s.settle()
        area = s.area()
        pre = s.frames()
        stack = pre["plastile-fixture 2"]["frame"]  # upper half of the stack column before the send
        s.act("plastile-fixture 3", "workspace.activeWindow = w")
        s.cmd("move.desktop-next")
        time.sleep(0.6); s.settle()
        f = s.frames()
        d1 = [x for x in f.values() if x["desktops"] == f["plastile-fixture 1"]["desktops"]]
        want2 = {"x": stack["x"], "y": area["y"] + 8, "width": stack["width"], "height": area["height"] - 16}
        c("send-to-desktop: source reflowed to two: fixture 2 now fills the whole stack column (oracle, gaps>=8)",
          len(d1) == 2 and near(f["plastile-fixture 2"]["frame"], want2, 1.0) and not tiling_errors(d1, area, 8)
          and all(x["frame"]["height"] >= area["height"] - 16.5 for x in d1),
          {"fixture2": f["plastile-fixture 2"]["frame"], "expected": want2, "errors": tiling_errors(d1, area, 8)})
        c("send-to-desktop: no follow (desktop unchanged)",
          json.loads(s.js("emit(workspace.currentDesktop.x11DesktopNumber)")[0]) == 1)
        s.js("workspace.currentDesktop = workspace.desktops[1]; emit(1)")
        time.sleep(0.6); s.settle()
        f = s.frames()
        c("L15: window on the other desktop tiled when shown",
          near(f["plastile-fixture 3"]["frame"], {"x": 8, "y": 8, "width": 1264, "height": 784}, 1.0), f["plastile-fixture 3"]["frame"])


def kwin_cpu_seconds(s: Session) -> float:
    """utime + stime of the nested kwin_wayland process (/proc/<pid>/stat)."""
    st = Path(f"/proc/{s.kw.kwin_pid}/stat").read_text().rsplit(")", 1)[1].split()
    return (int(st[11]) + int(st[12])) / os.sysconf("SC_CLK_TCK")


def idle_cpu(s: Session, seconds: float = 3.0) -> float:
    """KWin CPU use (cores) over an idle interval: independent of Plastile's own counters."""
    c0, t0 = kwin_cpu_seconds(s), time.monotonic()
    time.sleep(seconds)
    return (kwin_cpu_seconds(s) - c0) / (time.monotonic() - t0)


def script_objects(s: Session) -> list[str]:
    """Script objects KWin exports under /Scripting (one per loaded script; one-shot oracles unload themselves)."""
    xml = s.kw.call("/Scripting", "org.freedesktop.DBus.Introspectable", "Introspect")
    return re.findall(r'<node name="([^"]+)"', xml[0] if isinstance(xml, list) else xml)


@scenario("reload-Q09")
def reload(out: Path, c: Checks):
    """100 disable/enable cycles with pending work (TEST_MATRIX Q09).

    Plastile's own connection/window counters describe only the newest runtime, so they cannot see
    leftovers of an unloaded one. Independent evidence: KWin's exported script objects, kglobalaccel's
    shortcut list, the size of one command's effect (one grow step, not two), KWin's idle CPU and RSS.
    A guarded closure that a dead runtime left connected but that returns immediately stays
    invisible to all of these; detecting it would need a per-runtime instance id in the runtime.
    """
    cycles = 100
    facts: dict = {}
    with Session(out) as s:
        three(s, "--configure-delay-ms", "200")
        s.load(); s.settle()
        base = s.counters()
        names0 = s.kw.shortcut_names()
        time.sleep(0.5)
        cpu0 = idle_cpu(s)
        rss: list[int | None] = []
        parts = [s.kw.kwin_rss_parts_kib()]
        errors = []
        for i in range(cycles):
            s.act("plastile-fixture 1", "workspace.activeWindow = w")
            # Pending work at unload (fixture 3 delays commits). The ratio is saved across reloads (T27), so
            # alternate: 100 grows in a row would reach the ratio limit and make the final grow a no-op.
            s.cmd("resize.grow" if i % 2 == 0 else "resize.shrink")
            s.unload()
            s.load()
            cc = s.settle()
            if steady_connections(cc) != steady_connections(base) or cc["windows"] != base["windows"]:
                errors.append((i, cc["connections"], cc.get("transientConnections"), cc["windows"],
                               base["connections"], base.get("transientConnections")))
            if i % 10 == 9:
                rss.append(s.kw.kwin_rss_kib())
        parts.append(s.kw.kwin_rss_parts_kib())
        names1 = s.kw.shortcut_names()
        objects = script_objects(s)
        time.sleep(0.5)
        cpu1 = idle_cpu(s)
        f = s.frames_list()
        warnings = [l for l in s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError")]
        facts.update({"cycles": cycles, "kwinRssKiBEvery10": rss, "idleCpuBefore": round(cpu0, 4), "idleCpuAfter": round(cpu1, 4),
                      "scriptObjects": objects, "shortcutNames": [len(names0), len(names1)]})
        c(f"Q09: {cycles} reloads with pending work: connection/window counts stable (runtime's own counters)", not errors, errors)
        c("Q09: one shortcut per command after reloads (kglobalaccel: same names, no duplicates)",
          sorted(names0) == sorted(names1) and len(names1) == len(set(names1)), (len(names0), len(names1)))
        c("Q09: exactly one Plastile script object exported by KWin after the reloads (independent)", len(objects) == 1, objects)
        grow_rss = (rss[-1] - rss[0]) if len(rss) >= 2 and None not in (rss[0], rss[-1]) else None
        c(f"Q09: KWin RSS bounded from cycle 10 to {cycles} (< 16 MiB growth; gross-leak bound, independent)",
          grow_rss is not None and grow_rss < 16 * 1024, {"growthKiB": grow_rss, "samples": rss, "partsFirstLast": parts})
        c("Q09: no leaked work: KWin idle CPU after the reloads within 0.02 cores of before (independent)",
          cpu1 <= cpu0 + 0.02, {"before": cpu0, "after": cpu1})
        c("Q09: no errors or JS exceptions logged", not warnings, warnings[:5])
        c("Q09: final layout valid", not tiling_errors(f, s.area(), 8), tiling_errors(f, s.area(), 8))
        # Effect size: one shortcut press moves the divider by exactly one ratio step. A surviving handler
        # of an unloaded runtime acting on the same press would move it twice.
        area = s.area()
        m0 = s.frames()["plastile-fixture 1"]["frame"]
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        a = s.counters()
        s.cmd("resize.grow")
        time.sleep(0.6)
        b = s.settle()
        m1 = s.frames()["plastile-fixture 1"]["frame"]
        step = 0.05 * (area["width"] - 16 - 8)
        c("Q09: one grow press after the reloads moves the master edge by exactly one step (oracle) and one command ran",
          abs((m1["width"] - m0["width"]) - step) <= 1.5 and delta(a, b).get("commands", 0) == 1,
          {"before": m0["width"], "after": m1["width"], "step": step, "delta": delta(a, b)})
    c("facts (recorded, always passes)", True, facts)


@scenario("config-Q01")
def config(out: Path, c: Checks):
    with Session(out, config={"gapInner": 20, "gapOuter": 20}) as s:
        three(s)
        s.load(); s.settle()
        f = s.frames()
        c("config: gaps 20 applied", f["plastile-fixture 1"]["frame"]["x"] == 20, f["plastile-fixture 1"]["frame"])
        rc = s.kw.root / "config/kwinrc"
        txt = rc.read_text().replace("gapInner=20", "gapInner=4").replace("gapOuter=20", "gapOuter=4")
        rc.write_text(txt)
        s.kw.call("/KWin", "org.kde.KWin", "reconfigure")
        time.sleep(0.8); s.settle()
        f = s.frames()
        c("config: live reload applies gaps 4", f["plastile-fixture 1"]["frame"]["x"] == 4, f["plastile-fixture 1"]["frame"])
        rc.write_text(rc.read_text().replace("gapInner=4", "gapInner=-3"))
        off = s.kw.mark()
        s.kw.call("/KWin", "org.kde.KWin", "reconfigure")
        time.sleep(0.8); s.settle()
        f = s.frames()
        rejected = s.log_lines(r"configuration rejected", off)
        c("Q01: invalid config rejected with a message", bool(rejected), rejected[:1])
        c("Q01: previous revision retained", f["plastile-fixture 1"]["frame"]["x"] == 4, f["plastile-fixture 1"]["frame"])


@scenario("suspend-idle-C14")
def suspend_idle(out: Path, c: Checks):
    with Session(out) as s:
        three(s)
        s.load(); s.settle()
        a = s.counters()
        time.sleep(3.0)
        b = s.counters()
        d = {k: v for k, v in delta(a, b).items() if k not in ("commands",)}
        c("C14: idle 3 s does no work (no flushes/deadlines/writes)", not d, d)
        slot1 = s.frames()["plastile-fixture 1"]["frame"]
        s.cmd("runtime.toggle-suspend")
        s.act("plastile-fixture 1", "w.frameGeometry = {x: 50, y: 50, width: 400, height: 300}")
        time.sleep(0.6)
        f = s.frames()
        c("suspend: user geometry not fought", near(f["plastile-fixture 1"]["frame"], {"x": 50, "y": 50, "width": 400, "height": 300}, 1.0))
        a = s.counters()
        s.cmd("runtime.toggle-suspend"); time.sleep(0.5)
        b = s.settle()
        f = s.frames()
        c("resume: the moved window is back in its pre-suspend slot (oracle)", near(f["plastile-fixture 1"]["frame"], slot1, 1.0),
          {"frame": f["plastile-fixture 1"]["frame"], "slot": slot1})
        c("resume: re-solved and wrote the moved window (solves >= 1, writes >= 1)",
          delta(a, b).get("solves", 0) >= 1 and delta(a, b).get("writes", 0) >= 1, delta(a, b))
        f = s.frames_list()
        c("resume: retiled", not tiling_errors(f, s.area(), 8), tiling_errors(f, s.area(), 8))


def kscreen(s: Session, *args: str) -> None:
    import subprocess
    r = subprocess.run(["kscreen-doctor", *args], env=s.kw.client_env(), capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        raise RuntimeError(f"kscreen-doctor {args}: {r.stderr[-200:]}")


def output_name(s: Session, index: int) -> str:
    """KWin's name for output `index` (Virtual-N on the virtual backend, WL-N when windowed)."""
    return json.loads(s.js(f"emit(workspace.screens[{index}].name);")[0])


def on_output(s: Session, name: str) -> list[dict]:
    return [f for f in s.frames_list() if f["output"] == name]


@scenario("fractional-scale-G03")
def fractional_scale(out: Path, c: Checks):
    with Session(out, outputs=2) as s:
        three(s)
        s.load(); s.settle()
        for cap in ("plastile-fixture 2", "plastile-fixture 3"):
            s.act(cap, "workspace.activeWindow = w")
            s.cmd("move.output-next"); s.settle()
        second = output_name(s, 1)
        for scale in ("1.25", "1.5", "1.75", "2"):
            kscreen(s, f"output.{second}.scale.{scale}")
            time.sleep(0.8)
            a = s.settle()
            area = s.area(1)
            applied = abs(area["width"] - 1280 / float(scale)) <= 1
            if not applied and s.kw.host_display:
                # KWin's wayland (windowed) backend keeps the scale it was started with.
                raise Skipped("the windowed backend does not apply kscreen-doctor scale changes")
            c(f"G03 scale {scale}: applied (the output's logical width is 1280 / scale)", applied, area)
            f = on_output(s, second)
            tol = 0.5 + 1 / float(scale)  # KWin snaps frame edges to the device-pixel grid (geometry.frameTolerance)
            c(f"G03 scale {scale}: two tiles inside the new area without overlap, gaps>=8 within one device pixel",
              len(f) == 2 and not tiling_errors(f, area, 8, tol), (area, [x["frame"] for x in f], tiling_errors(f, area, 8, tol)))
            time.sleep(1.5)
            b = s.counters()
            c(f"G03 scale {scale}: converged, no repeated corrections", delta(a, b).get("writes", 0) == 0 and
              b["outstanding"] == 0, delta(a, b))


@scenario("rotation-portrait-O02")
def rotation(out: Path, c: Checks):
    with Session(out) as s:
        three(s)
        s.load(); s.settle()
        first = output_name(s, 0)
        kscreen(s, f"output.{first}.rotation.left")
        time.sleep(0.8); s.settle()
        area = s.area(0)
        f = s.frames_list()
        c("O02 portrait: area rotated", area["height"] > area["width"], area)
        c("O02 portrait: retiled inside the rotated area", not tiling_errors(f, area, 8), tiling_errors(f, area, 8))
        kscreen(s, f"output.{first}.rotation.normal")
        time.sleep(0.8); s.settle()
        area = s.area(0)
        c("O02 back to landscape: retiled", not tiling_errors(s.frames_list(), area, 8))


@scenario("unplug-O04")
def unplug(out: Path, c: Checks):
    with Session(out, outputs=2) as s:
        s.spawn(1); s.spawn(2)
        s.spawn(3, "--configure-delay-ms", "400"); s.spawn(4, "--configure-delay-ms", "400")
        s.load(); s.settle()
        for cap in ("plastile-fixture 3", "plastile-fixture 4"):
            s.act(cap, "workspace.activeWindow = w")
            s.cmd("move.output-next"); s.settle()
        c("setup: two windows on Virtual-1", len(on_output(s, "Virtual-1")) == 2, [(f["caption"], f["output"]) for f in s.frames_list()])
        s.act("plastile-fixture 3", "workspace.activeWindow = w")
        s.cmd("resize.grow")  # pending requests on the output about to disappear
        time.sleep(0.05)
        off = s.kw.mark()
        kscreen(s, "output.Virtual-1.disable")
        time.sleep(1.5); s.settle()
        area = s.area(0)
        f = s.frames_list()
        c("O04: all windows visible on the surviving output", all(x["output"] == "Virtual-0" for x in f) and len(f) == 4,
          [(x["caption"], x["output"], x["frame"]) for x in f])
        c("O04: retiled without overlap", not tiling_errors(f, area, 8), tiling_errors(f, area, 8))
        errs = s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError", off)
        c("O04: no errors from stale output callbacks", not errs, errs[:3])
        kscreen(s, "output.Virtual-1.enable")
        time.sleep(1.0); s.settle()
        f = s.frames_list()
        live = {"Virtual-0", "Virtual-1"}
        per = {name: on_output(s, name) for name in sorted(live)}
        errs = {name: tiling_errors(ws, s.area(0 if name == "Virtual-0" else 1), 8) for name, ws in per.items() if ws}
        # Placement validity only: which output a window returns to is KWin's decision; Plastile's own
        # preference recovery (O05 "deterministic preference recovery") is not asserted here.
        c("O05 replug (partial): all four windows on live outputs and each output's windows tiled (oracle, gaps>=8)",
          len(f) == 4 and all(x["output"] in live for x in f) and not any(errs.values()),
          {"placement": {x["caption"]: x["output"] for x in f}, "errors": errs})
        c("O05 replug: no errors", not s.log_lines(r"plastile (error|warn)|TypeError", off))


def area_of(s: Session, name: str) -> dict:
    """Usable area of the output with this connector name (enumeration order may change on replug)."""
    out = s.js(f"for (const o of workspace.screens) if (o.name === {json.dumps(name)}) {{ const a = workspace.clientArea("
               f"workspace.MaximizeArea, o, workspace.currentDesktopForScreen(o)); emit({{x: a.x, y: a.y, width: a.width, height: a.height}}); }}")
    return json.loads(out[0])


@scenario("replug-identity-O05")
def replug_identity(out: Path, c: Checks):
    """T30: an unplugged output's context is dropped (the model stays bounded) and its layout
    preference returns with the output. The virtual backend reports no EDID, so the identity key
    is the connector name here; EDID keys on another connector are covered by
    tests/core/outputs.test.ts."""
    with Session(out, outputs=2) as s:
        three(s); s.spawn(4)
        s.load(); s.settle()
        for cap in ("plastile-fixture 3", "plastile-fixture 4"):
            s.act(cap, "workspace.activeWindow = w")
            s.cmd("move.output-next"); s.settle()
        s.act("plastile-fixture 4", "workspace.activeWindow = w")
        s.cmd("layout.monocle"); s.settle()

        def monocle_on_1() -> tuple[bool, list]:
            a = area_of(s, "Virtual-1")
            full = {"x": a["x"] + 8, "y": a["y"] + 8, "width": a["width"] - 16, "height": a["height"] - 16}
            f = on_output(s, "Virtual-1")
            return len(f) == 2 and all(near(x["frame"], full, 1.0) for x in f), [(x["caption"], x["frame"]) for x in f]

        ok, detail = monocle_on_1()
        c("setup: monocle on Virtual-1 with two windows", ok, detail)
        off = s.kw.mark()
        kscreen(s, "output.Virtual-1.disable")
        time.sleep(1.5)
        cnt = s.settle()
        f = s.frames_list()
        c("O04: all windows on the surviving output, tiled", all(x["output"] == "Virtual-0" for x in f) and len(f) == 4
          and not tiling_errors(f, area_of(s, "Virtual-0"), 8), [(x["caption"], x["output"]) for x in f])
        ids = [x["id"] for x in cnt["contexts"]]
        c("T30: the unplugged output's emptied context is dropped", not any(i.startswith("Virtual-1␟") for i in ids), ids)
        kscreen(s, "output.Virtual-1.enable")
        time.sleep(1.0); s.settle()
        moved_back = sorted(x["caption"] for x in on_output(s, "Virtual-1"))
        for cap in ("plastile-fixture 3", "plastile-fixture 4"):
            if not any(x["caption"] == cap for x in on_output(s, "Virtual-1")):
                s.act(cap, "workspace.activeWindow = w")
                s.cmd("move.output-next"); s.settle()
        ok, detail = monocle_on_1()
        c("O05: the context's layout came back with the output (monocle)", ok, {"movedBackByKWin": moved_back, "frames": detail})
        rest = on_output(s, "Virtual-0")
        c("O05: the other output is tiled", len(rest) == 2 and not tiling_errors(rest, area_of(s, "Virtual-0"), 8),
          tiling_errors(rest, area_of(s, "Virtual-0"), 8))
        errs = s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError", off)
        c("O05: no errors", not errs, errs[:3])


@scenario("reconcile")
def reconcile(out: Path, c: Checks):
    with Session(out) as s:
        three(s)
        s.load(); s.settle()
        a = s.counters()
        s.cmd("runtime.reconcile")
        b = s.settle()
        c("reconcile: unchanged state writes nothing", delta(a, b).get("writes", 0) == 0, delta(a, b))
        c("reconcile: still three tiled", not tiling_errors(s.frames_list(), s.area(), 8))


@scenario("drag-I01-I02")
def drag(out: Path, c: Checks):
    from harness import Input, centre, KEY_ESC
    with Session(out) as s:
        three(s)
        s.load(); s.settle()
        inp = Input(s)
        try:
            f = s.frames()
            slot = {k: v["frame"] for k, v in f.items()}
            a = s.counters()
            x0, y0 = centre(slot["plastile-fixture 3"]); x1, y1 = centre(slot["plastile-fixture 1"])
            inp.drag(x0, y0, x1, y1, release=False)
            time.sleep(0.2)
            mid = s.frames()
            b = s.counters()
            c("I01: no solve or write while dragging", delta(a, b).get("solves", 0) == 0 and delta(a, b).get("writes", 0) == 0, delta(a, b))
            c("I01: peers untouched during the drag", near(mid["plastile-fixture 2"]["frame"], slot["plastile-fixture 2"], 1.0))
            c("I01: dragged window follows the pointer", not near(mid["plastile-fixture 3"]["frame"], slot["plastile-fixture 3"], 1.0))
            inp.do("release left", "key 125 up")
            time.sleep(0.5); s.settle()
            g = s.frames()
            d = delta(b, s.counters())
            c("I01: drop on a tile swaps", near(g["plastile-fixture 3"]["frame"], slot["plastile-fixture 1"], 1.0) and
              near(g["plastile-fixture 1"]["frame"], slot["plastile-fixture 3"], 1.0), {k: v["frame"] for k, v in g.items()})
            c("I01: one release commit", d.get("solves", 0) == 1, d)
            # Drop with the window centre in the inner gap between columns (no tile there, and
            # away from screen edges, where KWin's own drag-to-maximize/quick-tile would apply).
            slot = {k: v["frame"] for k, v in s.frames().items()}
            x0, y0 = centre(slot["plastile-fixture 2"])
            m = slot["plastile-fixture 3"]  # current master after the swap
            gap_x = m["x"] + m["width"] + 4
            inp.drag(x0, y0, gap_x, y0 + 200)
            time.sleep(0.5); s.settle()
            g = s.frames()
            c("I01: drop outside tiles snaps back", near(g["plastile-fixture 2"]["frame"], slot["plastile-fixture 2"], 1.0), g["plastile-fixture 2"]["frame"])
            # Escape cancels a KWin Move action (pointer Meta+drags are not cancellable by Escape
            # in KWin 6.7.5, measured): KWin restores the start geometry; the model is unchanged.
            slot = {k: v["frame"] for k, v in s.frames().items()}
            x0, y0 = centre(slot["plastile-fixture 2"]); x1, y1 = centre(slot["plastile-fixture 1"])
            inp.do(f"move {x0} {y0}")
            s.act("plastile-fixture 2", "workspace.activeWindow = w; workspace.slotWindowMove()")
            for i in range(1, 9):
                inp.do(f"move {x0 + (x1 - x0) * i / 8} {y0 + (y1 - y0) * i / 8}")
                time.sleep(0.015)
            inp.do(f"key {KEY_ESC} down", f"key {KEY_ESC} up")
            time.sleep(0.5); s.settle()
            g = s.frames()
            c("I02: escape cancels without a swap", all(near(g[k]["frame"], slot[k], 1.0) for k in slot), {k: v["frame"] for k, v in g.items()})
        finally:
            inp.close()


@scenario("resize-I03")
def resize(out: Path, c: Checks):
    from harness import Input
    with Session(out) as s:
        s.spawn(1); s.spawn(2)
        s.load(); s.settle()
        inp = Input(s)
        try:
            f = s.frames()
            m = f["plastile-fixture 1"]["frame"]
            # Meta+right-drag resizes from the nearest corner: grab near the master's bottom-right.
            x0, y0 = m["x"] + m["width"] - 20, m["y"] + m["height"] - 20
            a = s.counters()
            inp.drag(x0, y0, x0 + 120, y0, button="right")
            time.sleep(0.6); s.settle()
            g = s.frames()
            m1, s1 = g["plastile-fixture 1"]["frame"], g["plastile-fixture 2"]["frame"]
            c("I03: master widened by the drag", m1["width"] > m["width"] + 60, (m, m1))
            c("I03: peer follows the divider, no overlap", abs(s1["x"] - (m1["x"] + m1["width"] + 8)) <= 1 and
              not tiling_errors(s.frames_list(), s.area(), 8), (m1, s1))
            c("I03: master keeps full height", abs(m1["height"] - m["height"]) <= 1, m1)
            d = delta(a, s.counters())
            c("I03: bounded work", d.get("solves", 0) <= 2 and d.get("corrections", 0) == 0, d)
        finally:
            inp.close()


@scenario("drag-teardown-I04")
def drag_teardown(out: Path, c: Checks):
    from harness import Input, centre
    with Session(out) as s:
        three(s)
        s.load(); s.settle()
        inp = Input(s)
        try:
            f = s.frames()
            x0, y0 = centre(f["plastile-fixture 3"]["frame"])
            off = s.kw.mark()
            inp.drag(x0, y0, x0 - 300, y0 - 100, release=False)
            s.kill(3, wait=True)
            inp.do("release left", "key 125 up")
            time.sleep(0.5); s.settle()
            c("I04: window closed mid-drag: two tiled, no errors",
              not tiling_errors(s.frames_list(), s.area(), 8) and len(s.frames_list()) == 2 and
              not s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError", off), s.log_lines(r"plastile (error|warn)|TypeError", off)[:3])
            f = s.frames()
            x0, y0 = centre(f["plastile-fixture 2"]["frame"])
            inp.drag(x0, y0, x0 - 200, y0, release=False)
            s.unload()
            inp.do("release left", "key 125 up")
            time.sleep(0.4)
            c("I04/I06: unload mid-drag leaves no errors", not s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError", off))
            s.load(); s.settle()
            c("I04: reload after mid-drag unload tiles again", not tiling_errors(s.frames_list(), s.area(), 8))
        finally:
            inp.close()
