"""Zones layout scenarios (experimental, docs/design/ZONES.md §5) in nested KWin.

Geometry is judged by the oracle (one-shot KWin scripts reading real frames and work areas):
zone rectangles are checked against properties computed from the work area alone (outer gaps on
the area edges, exactly one inner gap between neighbouring zones, equal shares), and assigned
frames are compared with the rectangles the overlay was given (Plastile logs them at info level)
to show that placement and overlay share one model. Counters only gate amounts of work. Pointer
transparency of the overlay and how it looks on real monitors stay physical-session checks.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from harness import Input, Session, delta, near, trace
from scenarios import Checks, Skipped, scenario
from scenarios_config import trace_modes
from scenarios_workarea import quit_panel, spawn_panel, until

GAP = 8
ZONES_UI = "Plastile zones"  # adapter.ts ZONES_UI_TITLE
ERRORS = r"plastile (error|warn)|TypeError|ReferenceError|ZoneOverlay\.qml"
KEY_ESC = 1
# Single-line JSON without backslashes: written verbatim into kwinrc.
CONFIG = json.dumps({"schemaVersion": 1, "defaults": {"layout": "zones", "zones": {"layout": "halves"}},
                     "overrides": [{"id": "right-thirds", "match": {"outputName": "Virtual-1"},
                                    "set": {"zones": {"layout": "thirds"}}}]}, separators=(",", ":"))


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def area_of(s: Session, name: str) -> dict:
    out = s.js(f"const o = workspace.screens.find(x => x.name === {json.dumps(name)}); const a = workspace.clientArea("
               f"workspace.MaximizeArea, o, workspace.currentDesktopForScreen(o)); emit({{x: a.x, y: a.y, width: a.width,"
               f" height: a.height}});")
    return json.loads(out[0])


def frames(s: Session) -> dict[str, dict]:
    return {f["caption"]: f for f in s.frames_list() if f["caption"]}


def own_windows(s: Session) -> list[dict]:
    out = s.js(f"emit(workspace.windowList().filter(w => w.caption === {json.dumps(ZONES_UI)}).map(w => ("
               "{id: String(w.internalId), popup: w.popupWindow, appId: w.resourceClass, pid: w.pid,"
               " output: w.output ? w.output.name : null, frame: {x: w.frameGeometry.x, y: w.frameGeometry.y,"
               " width: w.frameGeometry.width, height: w.frameGeometry.height}})));")
    return json.loads(out[0])


def overlay_log(s: Session, off: int) -> dict | None:
    lines = s.log_lines(r"plastile info zones overlay \{", off)
    return json.loads(lines[-1].split("plastile info zones overlay ", 1)[1]) if lines else None


def expected_columns(area: dict, n: int, col: int) -> dict:
    """Oracle for column `col` of `n` equal full-height zones: outer gaps at the area edges, one inner
    gap between columns, and n equal widths that fill the inner width exactly (whole-pixel cuts)."""
    x0, y0 = area["x"] + GAP, area["y"] + GAP
    w, h = area["width"] - 2 * GAP, area["height"] - 2 * GAP
    share = (w - (n - 1) * GAP) / n
    left = x0 if col == 0 else round(x0 + col * (share + GAP) - GAP) + GAP
    right = x0 + w if col == n - 1 else round(x0 + (col + 1) * (share + GAP) - GAP)
    return {"x": left, "y": y0, "width": right - left, "height": h}


def assign(s: Session, i: int, n: int) -> dict:
    s.act(fx(i), "workspace.activeWindow = w")
    a = s.counters()
    s.cmd(f"zone.assign-{n}")
    return delta(a, s.settle())


@scenario("zones-assign-M9")
def zones_assign(out: Path, c: Checks):
    """Keyboard assignment on two outputs with different work areas (a panel on Virtual-1) and different
    zone layouts (halves, thirds by override): oracle frames equal the zone rectangles, one write each."""
    with Session(out, outputs=2, config={"configJson": CONFIG}) as s:
        panel = spawn_panel(s, "top", "top", 48, "Virtual-1")
        try:
            c("precondition: the panel shrinks Virtual-1's work area only",
              until(lambda: area_of(s, "Virtual-1")["height"] < 800) and area_of(s, "Virtual-0")["height"] == 800,
              {"v0": area_of(s, "Virtual-0"), "v1": area_of(s, "Virtual-1")})
            for i in (1, 2, 3):
                s.spawn(i)
            before = frames(s)
            s.load()
            s.settle()
            after = frames(s)
            c("adoption moves nothing: unassigned windows are ordinary floating windows (oracle)",
              all(near(before[k]["frame"], after[k]["frame"], 0.5) for k in before), {k: after[k]["frame"] for k in after})
            # Fixture 3 goes to Virtual-1 (a KWin send; a zones context does not place it).
            s.act(fx(3), "workspace.activeWindow = w")
            s.cmd("move.output-next")
            s.settle()
            c("precondition: fixture 3 on Virtual-1", frames(s)[fx(3)]["output"] == "Virtual-1", frames(s)[fx(3)])

            a0, a1 = area_of(s, "Virtual-0"), area_of(s, "Virtual-1")
            d1 = assign(s, 1, 1)
            d2 = assign(s, 2, 2)
            d3 = assign(s, 3, 3)
            f = frames(s)
            want = {fx(1): expected_columns(a0, 2, 0), fx(2): expected_columns(a0, 2, 1), fx(3): expected_columns(a1, 3, 2)}
            got = {k: f[k]["frame"] for k in want}
            c("Virtual-0 halves: zone 1 and 2 frames equal the oracle rectangles (outer gaps, one inner gap)",
              near(got[fx(1)], want[fx(1)], 0.5) and near(got[fx(2)], want[fx(2)], 0.5), {"got": got, "want": want, "area": a0})
            c("Virtual-0: the two zones are exactly one inner gap apart",
              abs(got[fx(2)]["x"] - (got[fx(1)]["x"] + got[fx(1)]["width"]) - GAP) <= 0.5, got)
            c("Virtual-1 thirds below the panel: zone 3 frame equals the oracle rectangle",
              near(got[fx(3)], want[fx(3)], 0.5) and f[fx(3)]["output"] == "Virtual-1", {"got": got[fx(3)], "want": want[fx(3)], "area": a1})
            c("each assignment issued exactly one write (counters)",
              [d.get("writes", 0) for d in (d1, d2, d3)] == [1, 1, 1], {"d1": d1, "d2": d2, "d3": d3})
            d = assign(s, 2, 2)
            c("repeating an assignment writes nothing (counters)", d.get("writes", 0) == 0, d)
            d = assign(s, 1, 3)
            c("a zone the layout does not have is a no-op (halves has no zone 3)",
              d.get("writes", 0) == 0 and near(frames(s)[fx(1)]["frame"], want[fx(1)], 0.5), d)

            # The overlay is given the same rectangles: shown on the active output (fixture 3's, then 1's).
            model = {}
            for i, name in ((3, "Virtual-1"), (1, "Virtual-0")):
                s.act(fx(i), "workspace.activeWindow = w")
                off = s.kw.mark()
                s.cmd("zone.show")
                s.wait_for(lambda: overlay_log(s, off) is not None, 5, "overlay log")
                model[name] = overlay_log(s, off)
                s.cmd("zone.show")  # hide
                time.sleep(0.3)
            f = frames(s)
            z1 = {z["n"]: z["rect"] for z in model["Virtual-1"]["zones"]}
            z0 = {z["n"]: z["rect"] for z in model["Virtual-0"]["zones"]}
            c("overlay rectangles equal the assigned frames on both outputs (one model)",
              model["Virtual-1"]["layout"] == "thirds" and model["Virtual-0"]["layout"] == "halves" and
              near(f[fx(3)]["frame"], z1[3], 0.5) and near(f[fx(1)]["frame"], z0[1], 0.5) and near(f[fx(2)]["frame"], z0[2], 0.5),
              {"model": model, "frames": {k: v["frame"] for k, v in f.items()}})

            # Toggle floating on a zoned window: back to where it floated before it was assigned.
            s.act(fx(2), "workspace.activeWindow = w")
            s.cmd("window.toggle-float")
            s.settle()
            c("toggle-float restores fixture 2's float rectangle (oracle)",
              near(frames(s)[fx(2)]["frame"], before[fx(2)]["frame"], 0.5), {"now": frames(s)[fx(2)]["frame"],
                                                                            "before": before[fx(2)]["frame"]})
            # Layout switch and unload: nothing moves.
            f0 = frames(s)
            a = s.counters()
            s.act(fx(1), "workspace.activeWindow = w")
            s.cmd("layout.floating")
            b = s.settle()
            c("switching to floating releases the zones without moving any window (oracle, counters)",
              all(near(f0[k]["frame"], frames(s)[k]["frame"], 0.5) for k in f0) and delta(a, b).get("writes", 0) == 0,
              delta(a, b))
            s.unload()
            time.sleep(0.4)
            c("unload moves nothing (oracle)", all(near(f0[k]["frame"], frames(s)[k]["frame"], 0.5) for k in f0),
              {k: v["frame"] for k, v in frames(s).items()})
            c("no errors or warnings logged", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])
        finally:
            quit_panel(panel)


@scenario("zones-overlay-M9")
def zones_overlay(out: Path, c: Checks):
    """The overlay exists only after zone.show, is Plastile's own UI (excluded), covers the active output,
    hides on Escape or the command (nothing runs while hidden) and is destroyed on unload."""
    qml = (Path(__file__).resolve().parents[2] / "package/contents/ui/ZoneOverlay.qml").read_text()
    with Session(out, config={"layout": "zones"}) as s:
        s.spawn(1); s.spawn(2)
        s.load()
        s.settle()
        s.act(fx(1), "workspace.activeWindow = w")
        s.cmd("zone.assign-1")
        s.act(fx(2), "workspace.activeWindow = w")
        s.cmd("zone.assign-2")
        s.cmd("zone.next")
        s.cmd("zone.previous")
        s.settle()
        c("keyboard placement creates no overlay", own_windows(s) == [] and s.counters().get("zoneOverlay") == "absent",
          {"own": own_windows(s), "state": s.counters().get("zoneOverlay")})

        f0 = frames(s)
        c0 = s.counters()
        off = s.kw.mark()
        s.cmd("zone.show")
        try:
            s.wait_for(lambda: len(own_windows(s)) == 2, 5, "overlay windows")
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.3)
        wins = own_windows(s)
        c1 = s.settle()
        c("zone.show creates the overlay and its legend (oracle: KWin's window list)",
          len(wins) == 2 and c1.get("zoneOverlay") == "shown", wins)
        cover = [w for w in wins if not w["popup"]]
        c("the drawing covers the active output exactly (oracle)",
          len(cover) == 1 and near(cover[0]["frame"], {"x": 0, "y": 0, "width": 1280, "height": 800}, 0.5), cover)
        modes = [m for w in wins for m in trace_modes(s, w["id"])]
        c("both windows are classified as Plastile's own UI and excluded",
          len(wins) == 2 and bool(modes) and all(m.get("mode") == "excluded" and m.get("source") == "builtin" for m in modes), modes)
        d = delta(c0, c1)
        c("showing the overlay solved nothing and wrote no geometry (counters)", d.get("solves", 0) == 0 and d.get("writes", 0) == 0, d)
        c("tiles unchanged while the overlay is shown (oracle)",
          all(near(f0[k]["frame"], frames(s)[k]["frame"], 0.5) for k in f0), {k: v["frame"] for k, v in frames(s).items()})
        shown = overlay_log(s, off)
        off = s.kw.mark()
        s.cmd("zone.unassign")  # fixture 2 is active: released, the shown overlay is refreshed
        until(lambda: overlay_log(s, off) is not None, 3)
        refreshed = overlay_log(s, off)
        counts = lambda m: {z["n"]: z["windows"] for z in m["zones"]} if m else None  # noqa: E731
        c("a zone command while shown refreshes the overlay: zone 2 is drawn empty after the unassign (log), "
          "and no new windows", counts(shown) == {1: 1, 2: 1} and counts(refreshed) == {1: 1, 2: 0}
          and len(own_windows(s)) == 2, {"shown": counts(shown), "refreshed": counts(refreshed), "own": own_windows(s)})

        escape_note = ""
        try:
            inp = Input(s)
        except Exception as exc:  # noqa: BLE001
            inp = None
            escape_note = f"libei unavailable: {exc}"
        if inp is not None:
            try:
                inp.do(f"key {KEY_ESC} down", f"key {KEY_ESC} up")
                time.sleep(0.5)
                c("Escape hides the overlay (oracle: both windows gone; state hidden, not destroyed)",
                  own_windows(s) == [] and s.counters().get("zoneOverlay") == "hidden", own_windows(s))
            finally:
                inp.close()
        else:
            s.cmd("zone.show")
            time.sleep(0.4)

        # Hidden: no work at all. Flushes and timers are engine work; inspect.counters is not.
        h0 = s.counters()
        time.sleep(1.0)
        h1 = s.counters()
        c("nothing runs while hidden (no flushes or deadlines over 1 s; the QML has no Timer)",
          delta(h0, h1) == {} and "Timer" not in qml, delta(h0, h1))
        s.cmd("zone.show")
        s.wait_for(lambda: len(own_windows(s)) == 2, 5, "overlay windows again")
        c("shown again from the hidden overlay", s.counters().get("zoneOverlay") == "shown", own_windows(s))
        s.cmd("zone.show")
        time.sleep(0.4)
        c("the command hides it", own_windows(s) == [] and s.counters().get("zoneOverlay") == "hidden", own_windows(s))
        s.cmd("zone.show")
        s.wait_for(lambda: len(own_windows(s)) == 2, 5, "overlay windows before unload")
        s.unload()
        time.sleep(0.4)
        c("unload destroys a shown overlay (oracle)", own_windows(s) == [], own_windows(s))
        warn = s.log_lines(ERRORS)
        c("no errors, warnings, JS exceptions or QML warnings", not warn, warn[:5])
        if inp is None:
            raise Skipped(f"Escape check not run: {escape_note}")


@scenario("zones-overlay-activation-M9")
def zones_overlay_activation(out: Path, c: Checks):
    """While the overlay is shown, any accepted command refreshes it (a float updates the counts), but a
    command that activates a window lets it close: KWin closes the legend popup on the activation, and
    the refresh after that command does not map it again."""
    with Session(out, config={"layout": "zones", "diagnostics": "info"}) as s:
        s.spawn(1); s.spawn(2)
        s.load()
        s.settle()
        s.act(fx(1), "workspace.activeWindow = w")
        s.cmd("zone.assign-1")
        s.act(fx(2), "workspace.activeWindow = w")
        s.cmd("zone.assign-2")
        s.settle()
        s.cmd("zone.show")
        s.wait_for(lambda: len(own_windows(s)) == 2, 5, "overlay windows")
        time.sleep(0.3)
        counts = lambda m: {z["n"]: z["windows"] for z in m["zones"]} if m else None  # noqa: E731

        # Fixture 2 is active: floating it is neither a zone nor a layout command, and refreshes the overlay.
        off = s.kw.mark()
        s.cmd("window.toggle-float")
        until(lambda: overlay_log(s, off) is not None, 3)
        time.sleep(0.3)
        c("toggle-float while shown refreshes the overlay: zone 2 is drawn empty (log), the overlay stays",
          counts(overlay_log(s, off)) == {1: 1, 2: 0} and len(own_windows(s)) == 2
          and s.counters().get("zoneOverlay") == "shown",
          {"log": overlay_log(s, off), "own": own_windows(s)})

        seen = {r.get("id") for r in trace(s) if r.get("kind") == "mode"}
        off = s.kw.mark()
        s.cmd("focus.left")  # activates fixture 1: KWin closes the legend popup
        time.sleep(0.8)
        active = json.loads(s.js("emit(workspace.activeWindow ? workspace.activeWindow.caption : null)")[0])
        added = [r for r in trace(s) if r.get("kind") == "mode" and r.get("id") not in seen]
        c("an activating command hides the shown overlay and does not map it again (oracle: active window, no "
          "overlay window left; trace: no window added since; log: no refresh)",
          active == fx(1) and own_windows(s) == [] and added == [] and s.counters().get("zoneOverlay") == "hidden"
          and not s.log_lines(r"plastile info zones overlay \{", off),
          {"active": active, "added": added, "own": own_windows(s), "log": s.log_lines(r"zones overlay", off)})
        s.cmd("zone.show")
        s.wait_for(lambda: len(own_windows(s)) == 2, 5, "overlay windows again")
        c("shown again afterwards", s.counters().get("zoneOverlay") == "shown", own_windows(s))
        warn = s.log_lines(ERRORS)
        c("no errors, warnings, JS exceptions or QML warnings", not warn, warn[:5])
