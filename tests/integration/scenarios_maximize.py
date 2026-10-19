"""Windows that arrive maximized (ADR-021, BEHAVIOR §3; the physical runbook's kitty finding).

The fixture client maps maximized itself (`--start-maximized`: `xdg_toplevel.set_maximized`
before its initial commit; the X11 fixture sets `_NET_WM_STATE` maximized before mapping), as an
application or a KWin rule would choose it. With the default `maximizedOnOpen=tile` Plastile
un-maximizes it once through the script API and tiles it in the same flush; with `keep` it stays
maximized; a maximize made after the window was tiled (KWin's maximize action, a double click on
the title bar with real input) stays honoured; windows already maximized when Plastile starts (and
at a reload) are left alone; a client that maximizes itself again after the un-maximize is
honoured, not fought.

Oracles: KWin's own window state (`maximizeMode`, frames) through one-shot scripts; the client's
protocol log (configures it received, with their states and sizes); a passive listener script
counting KWin's `frameGeometryChanged` for the window. Plastile's explain and counters are read
only for what it says and for work amounts.

Layer: nested KWin (virtual backend). Not a physical session: whether a real application
(kitty) behaves the same is the physical runbook's check.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from harness import Input, Listener, Session, delta, explain, fixture_events, near, tiling_errors, trace
from scenarios import Checks, scenario

GAP = 8


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def maximized(e: dict) -> bool:
    return "maximized" in e.get("states", [])


def frames_of(lis: Listener, caption: str, offset: int = 0) -> list[dict]:
    out = []
    for ln in lis.lines("frame", offset):
        cap, rest = ln.split("PLT-L frame ", 1)[1].split("|", 1)
        if cap == caption:
            x, y, w, h = json.loads(rest.split(" ", 1)[1])
            out.append({"x": x, "y": y, "width": w, "height": h})
    return out


def margin(s: Session, caption: str) -> float:
    """Frame height minus client height (the server-side title bar)."""
    out = s.js(f"const w = workspace.windowList().find(x => x.caption === {json.dumps(caption)});"
               " emit(w.frameGeometry.height - w.clientGeometry.height);")
    return json.loads(out[0])


def wait_state(s: Session, caption: str, mode: int, timeout: float = 4.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        f = s.frames().get(caption)
        if f and f["maximizeMode"] == mode:
            return f
        if time.monotonic() > deadline:
            return f or {}
        time.sleep(0.03)


def open_records(s: Session, wid: str) -> list[dict]:
    """Plastile's trace records about a window's maximize on open (work attribution only)."""
    return [r for r in trace(s) if r.get("id") == wid and r["kind"] in ("open-maximized", "unmaximized", "remaximized")]


# ----------------------------------------------------------------------------- Wayland, default
@scenario("maximized-open-tile-T17")
def open_tile(out: Path, c: Checks):
    with Session(out) as s:
        s.spawn(1)
        s.load(); s.settle()
        area = s.area()
        lis = Listener(s, frames=(fx(2),))
        try:
            a = s.counters()
            f2 = s.spawn(2, "--start-maximized")
            s.settle()
            f = wait_state(s, fx(2), 0)
            time.sleep(0.5); s.settle()
            f = s.frames()
            b = s.counters()
            cfg = fixture_events(f2.log, "configure")
            m = margin(s, fx(2))
            c("precondition: the client mapped maximized (its first configure carries maximized, at the maximize area "
              "less the title bar)", len(cfg) >= 1 and maximized(cfg[0]) and cfg[0]["width"] == area["width"]
              and cfg[0]["height"] == area["height"] - m, {"first": cfg[:1], "titleBar": m})
            c("the window is no longer maximized (KWin's maximizeMode)", f[fx(2)]["maximizeMode"] == 0, f[fx(2)]["maximizeMode"])
            frames = [f[fx(1)], f[fx(2)]]
            c("both windows tile the area (oracle frames)", not tiling_errors(frames, area, GAP)
              and f[fx(2)]["frame"]["width"] < area["width"] / 2 + 1, [x["frame"] for x in frames])
            later = cfg[1:]
            unmax = [e for e in later if not maximized(e)]
            c("one configure un-maximizes it, carrying the tile size (the un-maximize and the tile write together)",
              len(unmax) == 1 and abs(unmax[0]["width"] - f[fx(2)]["frame"]["width"]) <= 1
              and abs(unmax[0]["height"] + m - f[fx(2)]["frame"]["height"]) <= 1,
              [{"states": e["states"], "w": e["width"], "h": e["height"]} for e in later])
            c("no configure asks for the client's own size (0x0: KWin's restore without a tile) and none re-maximizes",
              all(e["width"] > 0 and e["height"] > 0 for e in later) and not any(maximized(e) for e in later[later.index(unmax[0]):]
                                                                               if unmax),
              [{"states": e["states"], "w": e["width"], "h": e["height"]} for e in later])
            seen = frames_of(lis, fx(2))
            final = f[fx(2)]["frame"]
            full = {"x": area["x"], "y": area["y"], "width": area["width"], "height": area["height"]}
            c("KWin's frames for it: only the maximize area and then its tile, no intermediate size (listener)",
              len(seen) >= 1 and near(seen[-1], final, 1.0) and all(near(x, final, 1.0) or near(x, full, 1.0) for x in seen),
              seen)
            d = delta(a, b)
            c("no correction, the new window placed once: at most one write to it (work amounts)",
              d.get("corrections", 0) == 0, d)
            x = explain(s, fx(2))
            c("explain says why (onOpen)", str(x.get("onOpen", "")).startswith("unmaximized on open:")
              and x.get("suspended") is None, {"onOpen": x.get("onOpen"), "suspended": x.get("suspended")})
            rec = open_records(s, x["id"])
            c("the trace records the un-maximize on open and KWin's report",
              [r["kind"] for r in rec][:2] == ["open-maximized", "unmaximized"]
              and rec[0].get("data") == {"action": "unmaximized"}, rec)

            # A maximize the user makes afterwards is honoured (KWin's maximize action), and restored.
            s.act(fx(2), "w.setMaximize(true, true)")
            f = wait_state(s, fx(2), 3)
            time.sleep(1.5); s.settle()
            f = s.frames()
            c("a later maximize (KWin's maximize action) stays maximized: not un-maximized again",
              f[fx(2)]["maximizeMode"] == 3 and near(f[fx(2)]["frame"], full, 1.0), f[fx(2)])
            c("the other window tiles alone meanwhile", not tiling_errors([f[fx(1)]], area, GAP)
              and f[fx(1)]["frame"]["width"] > area["width"] - 2 * GAP - 1, f[fx(1)]["frame"])
            s.act(fx(2), "w.setMaximize(false, false)")
            wait_state(s, fx(2), 0)
            time.sleep(0.5); s.settle()
            f = s.frames()
            c("restored: back to its tile", f[fx(2)]["maximizeMode"] == 0 and near(f[fx(2)]["frame"], final, 1.0),
              f[fx(2)]["frame"])

            # Real input: a double click on the title bar (KWin's default title bar action: maximize).
            inp = Input(s)
            try:
                fr, cl = f[fx(2)]["frame"], None
                info = s.js(f"const w = workspace.windowList().find(x => x.caption === {json.dumps(fx(2))});"
                            " emit({y: w.clientGeometry.y});")
                cl = json.loads(info[0])["y"]
                ty = fr["y"] + max(2, (cl - fr["y"]) / 2)
                tx = fr["x"] + fr["width"] / 2
                inp.do(f"move {tx} {ty}")
                time.sleep(0.25)
                # explain's inspector popup is open: KWin closes it on the first click elsewhere, which
                # the popup consumes. One click, then a pause longer than the double-click interval.
                inp.do("press left"); time.sleep(0.03); inp.do("release left"); time.sleep(0.8)
                for _ in range(2):
                    inp.do("press left"); time.sleep(0.03); inp.do("release left"); time.sleep(0.06)
            finally:
                inp.close()
            f = wait_state(s, fx(2), 3)
            time.sleep(1.5); s.settle()
            f = s.frames()
            c("a double click on the title bar (real input) maximizes it, and it stays maximized",
              f[fx(2)]["maximizeMode"] == 3 and near(f[fx(2)]["frame"], full, 1.0),
              {"title bar at": [tx, ty], "frame": f[fx(2)]["frame"], "maximizeMode": f[fx(2)]["maximizeMode"]})
            x = explain(s, fx(2))
            c("explain: honoured, Plastile un-maximizes only once", str(x.get("onOpen", "")).startswith("maximized again")
              and "maximized" in str(x.get("suspended")), {"onOpen": x.get("onOpen"), "suspended": x.get("suspended")})
        finally:
            lis.close()


# ----------------------------------------------------------------------------- keep
@scenario("maximized-open-keep-T17")
def open_keep(out: Path, c: Checks):
    with Session(out, config={"maximizedOnOpen": "keep"}) as s:
        s.spawn(1)
        s.load(); s.settle()
        area = s.area()
        a = s.counters()
        f2 = s.spawn(2, "--start-maximized")
        time.sleep(1.0); s.settle()
        f = s.frames()
        b = s.counters()
        full = {"x": area["x"], "y": area["y"], "width": area["width"], "height": area["height"]}
        c("keep: it stays maximized at the maximize area", f[fx(2)]["maximizeMode"] == 3 and near(f[fx(2)]["frame"], full, 1.0),
          f[fx(2)])
        cfg = fixture_events(f2.log, "configure")
        c("keep: no configure un-maximizes it (client log)", all(maximized(e) for e in cfg), [e["states"] for e in cfg])
        c("keep: the other window tiles alone", f[fx(1)]["frame"]["width"] > area["width"] - 2 * GAP - 1, f[fx(1)]["frame"])
        d = delta(a, b)
        c("keep: no write to the maximized window (writes: only the peer's reflow)", d.get("writes", 0) <= 1, d)
        x = explain(s, fx(2))
        c("keep: explain says why", x.get("onOpen") == "it opened maximized and stays maximized (maximizedOnOpen: keep)"
          and "maximized" in str(x.get("suspended")), {"onOpen": x.get("onOpen"), "suspended": x.get("suspended")})


# ----------------------------------------------------------------------------- start and reload
@scenario("maximized-open-startup-T17")
def open_startup(out: Path, c: Checks):
    with Session(out) as s:
        s.spawn(1, "--start-maximized")
        s.spawn(2)
        wait_state(s, fx(1), 3)
        area = s.area()
        full = {"x": area["x"], "y": area["y"], "width": area["width"], "height": area["height"]}
        s.load(); s.settle()
        time.sleep(1.0); s.settle()
        f = s.frames()
        c("start: a window already maximized when Plastile starts stays maximized", f[fx(1)]["maximizeMode"] == 3
          and near(f[fx(1)]["frame"], full, 1.0), f[fx(1)])
        c("start: the other window tiles alone", f[fx(2)]["frame"]["width"] > area["width"] - 2 * GAP - 1, f[fx(2)]["frame"])
        x = explain(s, fx(1))
        c("start: explain has no open decision for it", "onOpen" not in x and "maximized" in str(x.get("suspended")),
          {"onOpen": x.get("onOpen"), "suspended": x.get("suspended")})
        s.unload()
        s.load(); s.settle()
        time.sleep(1.0); s.settle()
        f = s.frames()
        c("reload: still maximized (windows adopted at a re-enable are left as they are)", f[fx(1)]["maximizeMode"] == 3
          and near(f[fx(1)]["frame"], full, 1.0), f[fx(1)])
        s.cmd("runtime.toggle-suspend")
        time.sleep(0.3)
        s.spawn(3, "--start-maximized")
        wait_state(s, fx(3), 3)
        s.cmd("runtime.toggle-suspend")
        time.sleep(1.0); s.settle()
        f = s.frames()
        c("resume: a window opened maximized while suspended is adopted as it is", f[fx(3)]["maximizeMode"] == 3, f[fx(3)])


# ----------------------------------------------------------------------------- the client insists
@scenario("maximized-open-remaximize-T17")
def open_remaximize(out: Path, c: Checks):
    with Session(out) as s:
        s.spawn(1)
        s.load(); s.settle()
        area = s.area()
        full = {"x": area["x"], "y": area["y"], "width": area["width"], "height": area["height"]}
        f2 = s.spawn(2, "--start-maximized", "--remaximize-once")
        time.sleep(1.0); s.settle()
        a = s.counters()
        time.sleep(2.0); s.settle()
        b = s.counters()
        f = s.frames()
        rem = fixture_events(f2.log, "remaximize")
        cfg = fixture_events(f2.log, "configure")
        c("precondition: the client asked to be maximized again after the un-maximize (client log)", len(rem) == 1, rem)
        unmax = [e for e in cfg if not maximized(e)]
        c("Plastile un-maximized it once: one un-maximized configure, then no other (client log)", len(unmax) == 1,
          [{"states": e["states"], "w": e["width"], "h": e["height"]} for e in cfg])
        c("the client's maximize is honoured: maximized at the maximize area (KWin)", f[fx(2)]["maximizeMode"] == 3
          and near(f[fx(2)]["frame"], full, 1.0), f[fx(2)])
        d = delta(a, b)
        c("no fight afterwards: no write, no correction for 2 s", d.get("writes", 0) == 0 and d.get("corrections", 0) == 0, d)
        c("the other window tiles alone", f[fx(1)]["frame"]["width"] > area["width"] - 2 * GAP - 1, f[fx(1)]["frame"])
        x = explain(s, fx(2))
        c("explain records that the re-maximize was honoured", "honoured" in str(x.get("onOpen", ""))
          and "maximized" in str(x.get("suspended")), {"onOpen": x.get("onOpen"), "suspended": x.get("suspended")})
        rec = open_records(s, x["id"])
        c("trace: un-maximized on open, then remaximized", [r["kind"] for r in rec][:1] == ["open-maximized"]
          and "remaximized" in [r["kind"] for r in rec], rec)


# ----------------------------------------------------------------------------- XWayland
@scenario("maximized-open-xwayland-T17")
def open_xwayland(out: Path, c: Checks):
    from scenarios_xwayland import XClient, settle_all, xwin
    with Session(out, xwayland=True) as s:
        s.spawn(1)
        s.load(); s.settle()
        area = s.area()
        a = s.counters()
        xc = XClient(s, "plastile-x maxed", "--start-maximized")
        settle_all(s)
        time.sleep(0.5)
        b = s.counters()
        w = xwin(s, "plastile-x maxed")
        f = s.frames()
        frames = [f[fx(1)], {"caption": w["caption"], "frame": w["frame"]}]
        cfgs = [e for e in xc.events("configure") if not e.get("synthetic")]
        props = [e for e in xc.events("property")]
        c("precondition: KWin mapped it maximized (_NET_WM_STATE property written by KWin, a maximize-area configure)",
          any(e["w"] >= area["width"] - 1 for e in cfgs), {"configures": [(e["w"], e["h"]) for e in cfgs][:6],
                                                           "properties": [e.get("atom") for e in props][:8]})
        c("the X11 window is no longer maximized (KWin's maximizeMode)", w["maximizeMode"] == 0, w["maximizeMode"])
        c("it tiles beside the Wayland window (oracle frames)", not tiling_errors(frames, area, GAP)
          and w["frame"]["width"] < area["width"] / 2 + 1, [x["frame"] for x in frames])
        d = delta(a, b)
        c("no correction", d.get("corrections", 0) == 0, d)
        x = explain(s, "plastile-x maxed")
        c("explain says why", str(x.get("onOpen", "")).startswith("unmaximized on open:"), x.get("onOpen"))
        sizes = [(e["w"], e["h"]) for e in cfgs]
        tile = (w["client"]["width"], w["client"]["height"])
        # Observed on KWin 6.7.5: X11Window::maximize(MaximizeRestore) configures the restore geometry
        # synchronously inside setMaximize, then Plastile's one write configures the tile, in one turn.
        i = next((k for k, sz in enumerate(sizes) if sz[0] >= area["width"] - 1), None)
        c("after the maximized configure: at most KWin's restore geometry, then the tile, and nothing after it",
          i is not None and sizes[-1] == tile and len(sizes) - 1 - i <= 2, {"sizes": sizes, "tile": tile})


# ----------------------------------------------------------------------------- a client that maximizes late
@scenario("maximized-open-late-T17")
def open_late(out: Path, c: Checks):
    with Session(out) as s:
        s.spawn(1)
        s.load(); s.settle()
        area = s.area()
        f2 = s.spawn(2, "--maximize-after-map")
        time.sleep(1.0); s.settle()
        f = s.frames()
        req = fixture_events(f2.log, "maximize_requested")
        cfg = fixture_events(f2.log, "configure")
        c("precondition: the client asked to be maximized right after its mapping commit (client log)",
          len(req) == 1 and any(maximized(e) for e in cfg), {"requests": req, "states": [e["states"] for e in cfg]})
        c("it ends tiled and not maximized (KWin)", f[fx(2)]["maximizeMode"] == 0
          and not tiling_errors([f[fx(1)], f[fx(2)]], area, GAP) and f[fx(2)]["frame"]["width"] < area["width"] / 2 + 1,
          [f[fx(1)]["frame"], f[fx(2)]["frame"], f[fx(2)]["maximizeMode"]])
        last_max = max(i for i, e in enumerate(cfg) if maximized(e))
        c("Plastile un-maximized it once: the last configure with maximized is followed by one without, and nothing re-maximizes",
          len([e for e in cfg[last_max + 1:] if not maximized(e)]) >= 1 and not maximized(cfg[-1]),
          [{"states": e["states"], "w": e["width"], "h": e["height"]} for e in cfg])
        x = explain(s, fx(2))
        c("explain says why", str(x.get("onOpen", "")).startswith("unmaximized on open:"), x.get("onOpen"))
        time.sleep(1.0)
        g = s.frames()
        c("stable: still tiled a second later", g[fx(2)]["maximizeMode"] == 0 and near(g[fx(2)]["frame"], f[fx(2)]["frame"], 1.0),
          g[fx(2)]["frame"])

        # A slower client (40 ms per configure, answering only the newest): it acknowledges Plastile's tile
        # configure, which already carries the maximized state it asked for, so KWin reports the tile
        # frame and then the maximize in one commit. That maximize still counts as arriving maximized.
        f3 = s.spawn(3, "--maximize-after-map", "--configure-delay-ms", "40")
        time.sleep(1.5); s.settle()
        f = s.frames()
        cfg = fixture_events(f3.log, "configure")
        acks = fixture_events(f3.log, "commit")
        c("slow client: it acknowledged a configure with the tile size and the maximized state (client log)",
          any(maximized(e) and e["width"] < area["width"] / 2 for e in cfg),
          [{"states": e["states"], "w": e["width"], "h": e["height"]} for e in cfg])
        frames = [f[fx(1)], f[fx(2)], f[fx(3)]]
        c("slow client: it ends tiled and not maximized (KWin)", f[fx(3)]["maximizeMode"] == 0 and not tiling_errors(frames, area, GAP),
          {"frames": [x["frame"] for x in frames], "maximizeMode": f[fx(3)]["maximizeMode"],
           "commits": [(e["width"], e["height"]) for e in acks]})
