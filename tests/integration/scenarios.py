"""Integration scenarios (TEST_MATRIX IDs in names). Each runs in a fresh nested KWin."""
from __future__ import annotations

import json
import time
from pathlib import Path

from harness import Session, delta, near, tiling_errors

SCENARIOS = {}


def scenario(name):
    def deco(fn):
        SCENARIOS[name] = fn
        return fn
    return deco


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
        c("C11: no-op layout + context reset write nothing", delta(a, b).get("writes", 0) == 0, delta(a, b))
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        a = s.counters()
        for cmd in ("focus.right", "focus.down", "focus.left", "focus.next", "focus.previous", "focus.master"):
            s.cmd(cmd); time.sleep(0.05)
        b = s.settle()
        d = delta(a, b)
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
    with Session(out) as s:
        three(s)
        s.load(); s.settle()
        a = s.counters()
        s.spawn(4, "--min", "900x700", "--clamp")
        time.sleep(3.0)
        b = s.settle()
        d = delta(a, b)
        c("G08: min-size client bounded (writes <= 10)", d.get("writes", 0) <= 10, d)
        c("G08: converged (no outstanding)", b["outstanding"] == 0, b["outstanding"])
        time.sleep(2.0)
        b2 = s.counters()
        c("G08: no further work after convergence", delta(b, b2).get("writes", 0) == 0, delta(b, b2))
        s.kill(4); s.settle()
        a = s.counters()
        s.spawn(5, "--ignore-size")
        time.sleep(4.0)
        b = s.settle()
        time.sleep(2.0)
        b2 = s.counters()
        d = delta(a, b)
        c("G12: ignoring client corrected within budget", d.get("corrections", 0) <= 3, d)
        c("G12: no endless retries", delta(b, b2).get("writes", 0) == 0, delta(b, b2))


@scenario("app-resize-G11")
def app_resize(out: Path, c: Checks):
    with Session(out) as s:
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


@scenario("transient-dialog-L07")
def transient(out: Path, c: Checks):
    with Session(out) as s:
        s.spawn(1); s.spawn(2, "--parent-after-ms", "200")
        s.load()
        time.sleep(1.0); s.settle()
        f = s.frames_list()
        children = [x for x in f if x["caption"].endswith("child")]
        mains = [x for x in f if not x["caption"].endswith("child")]
        c("transient child exists", len(children) == 1, [x["caption"] for x in f])
        c("transient child floats (not tiled)", children and children[0]["frame"]["width"] == 300, children and children[0]["frame"])
        c("two mains tiled", len(mains) == 2 and not tiling_errors(mains, s.area(), 8), tiling_errors(mains, s.area(), 8))


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
        s.act("plastile-fixture 3", "workspace.activeWindow = w")
        s.cmd("move.desktop-next")
        time.sleep(0.6); s.settle()
        f = s.frames()
        d1 = [x for x in f.values() if x["desktops"] == f["plastile-fixture 1"]["desktops"]]
        c("send-to-desktop: source reflowed to two", len(d1) == 2 and d1[0]["frame"]["height"] > 700, [x["frame"] for x in d1])
        c("send-to-desktop: no follow (desktop unchanged)",
          json.loads(s.js("emit(workspace.currentDesktop.x11DesktopNumber)")[0]) == 1)
        s.js("workspace.currentDesktop = workspace.desktops[1]; emit(1)")
        time.sleep(0.6); s.settle()
        f = s.frames()
        c("L15: window on the other desktop tiled when shown",
          near(f["plastile-fixture 3"]["frame"], {"x": 8, "y": 8, "width": 1264, "height": 784}, 1.0), f["plastile-fixture 3"]["frame"])


@scenario("reload-Q09")
def reload(out: Path, c: Checks):
    with Session(out) as s:
        three(s, "--configure-delay-ms", "200")
        s.load(); s.settle()
        base = s.counters()
        names0 = len(s.kw.shortcut_names())
        errors = []
        for i in range(20):
            s.act("plastile-fixture 1", "workspace.activeWindow = w")
            s.cmd("resize.grow")  # pending work at unload (fixture 3 delays commits)
            s.unload()
            s.load()
            cc = s.settle()
            if cc["connections"] != base["connections"] or cc["windows"] != base["windows"]:
                errors.append((i, cc["connections"], cc["windows"]))
        names1 = len(s.kw.shortcut_names())
        f = s.frames_list()
        warnings = [l for l in s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError")]
        c("Q09: 20 reloads with pending work: connection/window counts stable", not errors, errors)
        c("Q09: one shortcut per command after reloads", names0 == names1, (names0, names1))
        c("Q09: no errors or JS exceptions logged", not warnings, warnings[:5])
        c("Q09: final layout valid", not tiling_errors(f, s.area(), 8), tiling_errors(f, s.area(), 8))


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
        s.cmd("runtime.toggle-suspend")
        s.act("plastile-fixture 1", "w.frameGeometry = {x: 50, y: 50, width: 400, height: 300}")
        time.sleep(0.6)
        f = s.frames()
        c("suspend: user geometry not fought", near(f["plastile-fixture 1"]["frame"], {"x": 50, "y": 50, "width": 400, "height": 300}, 1.0))
        s.cmd("runtime.toggle-suspend"); time.sleep(0.5); s.settle()
        f = s.frames_list()
        c("resume: retiled", not tiling_errors(f, s.area(), 8), tiling_errors(f, s.area(), 8))
