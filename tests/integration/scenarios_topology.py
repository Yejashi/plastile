"""Topology scenarios at the KWin layer: output origins and order, desktop identity, all-desktop windows.

TEST_MATRIX IDs: G02 (negative/offset output origin), O03 (output enumeration/priority reorder),
O10 (desktop rename/reorder/remove), L16 (all-desktop and multi-desktop windows).

Outputs are changed with kscreen-doctor against the nested KWin only (its private bus and
Wayland socket); desktops with the plain-JS workspace API in one-shot scripts. Geometry is
judged by the oracle (one-shot KWin scripts reading real window and output state). Plastile's
counters and trace give amounts of work and attribute writes to window ids;
`inspect.explain-window` is read for the recorded decision, context and layout.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

from harness import (Session, delta, explain, last_trace_t, near, tiling_errors, trace, trace_since)
from scenarios import Checks, Skipped, on_output, scenario

GAP = 8
ERRORS = r"plastile (error|warn)|TypeError|ReferenceError"
SCREENS = ("emit({screens: workspace.screens.map(o => ({name: o.name, x: o.geometry.x, y: o.geometry.y,"
           " width: o.geometry.width, height: o.geometry.height})), order: workspace.screenOrder.map(o => o.name)})")


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def full(area: dict) -> dict:
    return {"x": area["x"] + GAP, "y": area["y"] + GAP, "width": area["width"] - 2 * GAP, "height": area["height"] - 2 * GAP}


def kscreen_try(s: Session, *args: str) -> dict:
    """kscreen-doctor against the nested session; returns its exit code and (colour-stripped) output."""
    r = subprocess.run(["kscreen-doctor", *args], env=s.kw.client_env(), capture_output=True, text=True, timeout=15)
    return {"code": r.returncode, "output": re.sub(r"\x1b\[[0-9;]*m", "", (r.stdout + r.stderr)).strip()[-400:]}


def screens(s: Session) -> dict:
    return json.loads(s.js(SCREENS)[0])


def geometry_of(s: Session) -> dict[str, dict]:
    return {o["name"]: {k: o[k] for k in ("x", "y", "width", "height")} for o in screens(s)["screens"]}


def area_of(s: Session, output: str) -> dict:
    out = s.js(f"const o = workspace.screens.find(x => x.name === {json.dumps(output)}); const a = workspace.clientArea("
               f"workspace.MaximizeArea, o, workspace.currentDesktopForScreen(o)); emit({{x: a.x, y: a.y, width: a.width,"
               f" height: a.height}});")
    return json.loads(out[0])


def until(pred, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if pred():
                return True
        except Exception:
            pass
        time.sleep(0.05)
    return False


def send_to_next_output(s: Session, i: int, times: int = 1) -> None:
    for _ in range(times):
        s.act(fx(i), "workspace.activeWindow = w")
        s.cmd("move.output-next")
        s.settle()


def outputs_of(s: Session) -> dict[str, str]:
    return {f["caption"]: f["output"] for f in s.frames_list()}


def per_output_errors(s: Session) -> dict[str, list[str]]:
    """Oracle: each output's windows tile inside that output's own work area (gaps>=8)."""
    out: dict[str, list[str]] = {}
    for name in geometry_of(s):
        ws = on_output(s, name)
        if ws:
            errs = tiling_errors(ws, area_of(s, name), GAP)
            if errs:
                out[name] = errs
    return out


def writes_in(records: list[dict]) -> dict[str, int]:
    n: dict[str, int] = {}
    for r in records:
        if r.get("kind") == "write":
            n[r["id"]] = n.get(r["id"], 0) + 1
    return n


# --------------------------------------------------------------------------- G02
@scenario("output-offset-origin-G02")
def offset_origin(out: Path, c: Checks):
    """Outputs whose origins are not (0, 0): the left output offset downwards, then a vertical arrangement.

    G02's negative-origin case cannot be produced in KWin 6.7.5 (see output-negative-origin-G02);
    offset origins exercise the same global-coordinate handling with non-zero bases on both axes.
    Observed in KWin 6.7.5: moving an output does not carry its windows along; KWin re-assigns a
    window's output from its position (and moves windows left outside every output). The checks
    therefore accept whatever membership KWin decides and judge the tiling of each output.
    """
    facts: dict = {}
    with Session(out, outputs=2) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        s.load(); s.settle()
        send_to_next_output(s, 3)
        c("setup: fixture 3 on Virtual-1", outputs_of(s).get(fx(3)) == "Virtual-1", outputs_of(s))

        def phase(tag: str, args: tuple[str, ...], want: dict[str, tuple[int, int]]) -> None:
            r = kscreen_try(s, *args)
            moved = until(lambda: all((geometry_of(s)[n]["x"], geometry_of(s)[n]["y"]) == xy for n, xy in want.items()))
            time.sleep(0.8)
            s.settle(); time.sleep(0.3); s.settle()
            g = geometry_of(s)
            c(f"{tag} precondition: outputs at {want} (oracle)", moved and r["code"] == 0, {"kscreen": r, "geometry": g})
            facts[f"{tag}.membershipAfterMove"] = outputs_of(s)
            errs = per_output_errors(s)
            c(f"{tag}: every window on a live output; each output's windows tile inside its own area, gaps>=8 (oracle)",
              not errs and all(o in g for o in outputs_of(s).values()), {"errors": errs, "outputs": outputs_of(s)})
            # Make the offset output receive a window through Plastile's send-to-output.
            src = next((i for i in (1, 2, 3) if outputs_of(s)[fx(i)] != "Virtual-1"), None)
            if src is None:
                src = 1
                send_to_next_output(s, src)  # away to Virtual-0 first
            a0 = s.counters()
            send_to_next_output(s, src)
            time.sleep(0.4)
            a1 = s.settle()
            area = area_of(s, "Virtual-1")
            on1 = on_output(s, "Virtual-1")
            c(f"{tag}: send-to-output lands on the offset output and its windows tile in its offset area (oracle)",
              outputs_of(s).get(fx(src)) == "Virtual-1" and (area["x"] != 0 or area["y"] != 0) and on1
              and not tiling_errors(on1, area, GAP),
              {"sent": fx(src), "outputs": outputs_of(s), "area": area, "frames": [x["frame"] for x in on1],
               "errors": tiling_errors(on1, area, GAP)})
            if len(on1) == 1:
                c(f"{tag}: a lone window fills the offset area exactly (global coordinates)", near(on1[0]["frame"], full(area), 1.0),
                  {"area": area, "frame": on1[0]["frame"]})
            errs = per_output_errors(s)
            c(f"{tag}: the other output's windows still tile inside its area (oracle)", not errs, errs)
            c(f"{tag}: bounded work for the transfer (writes <= 4)", delta(a0, a1).get("writes", 0) <= 4, delta(a0, a1))

        # Phase 1: Virtual-1 becomes the left output with origin (0, 300); Virtual-0 moves to (1280, 0).
        phase("G02 phase 1", ("output.Virtual-1.position.0,300", "output.Virtual-0.position.1280,0"),
              {"Virtual-1": (0, 300), "Virtual-0": (1280, 0)})
        # Phase 2: vertical arrangement, Virtual-1 below and offset right: origin (300, 800).
        phase("G02 phase 2", ("output.Virtual-0.position.0,0", "output.Virtual-1.position.300,800"),
              {"Virtual-0": (0, 0), "Virtual-1": (300, 800)})
        time.sleep(1.0)
        b = s.counters()
        time.sleep(1.0)
        b2 = s.counters()
        c("G02: converged (no writes for 1 s, nothing outstanding)", delta(b, b2).get("writes", 0) == 0 and b2["outstanding"] == 0,
          {"delta": delta(b, b2), "outstanding": b2["outstanding"]})
        errs = s.log_lines(ERRORS)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])
    c("facts (recorded, always passes)", True, facts)


@scenario("output-negative-origin-G02")
def negative_origin(out: Path, c: Checks):
    """Request a negative origin for the left output; tile checks run only if KWin accepts it.

    KWin 6.7.5 refuses an enabled output at a negative position (src/wayland/outputmanagement_v2.cpp:
    "Position of enabled output %1 is negative") and normalizes logical output positions so the
    top-left output starts at (0, 0) (src/workspace.cpp, "we need to normalize output positions").
    A script-visible negative origin therefore cannot occur here; the scenario records the refusal
    and reports SKIP for the missing capability instead of passing vacuously.
    """
    with Session(out, outputs=2) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        s.load(); s.settle()
        send_to_next_output(s, 3)
        before = geometry_of(s)
        r = kscreen_try(s, "output.Virtual-0.position.-1280,0")
        time.sleep(0.8)
        s.settle()
        after = geometry_of(s)
        negative = {n: g for n, g in after.items() if g["x"] < 0 or g["y"] < 0}
        if not negative:
            c("KWin keeps every logical output origin non-negative after the request (oracle)",
              min(g["x"] for g in after.values()) >= 0 and min(g["y"] for g in after.values()) >= 0,
              {"kscreen": r, "before": before, "after": after})
            errs = per_output_errors(s)
            c("the refused request left the layout valid (oracle)", not errs, errs)
            raise Skipped("KWin rejects a negative position for an enabled output and normalizes logical output "
                          f"origins to (0, 0) (kscreen-doctor: {r['output'][-120:]!r}); a negative origin cannot occur")
        c("negative origin accepted by this KWin (oracle)", True, after)
        for name in after:
            ws = on_output(s, name)
            a = area_of(s, name)
            c(f"G02: {name} windows tile inside its area at its (negative) origin (oracle)",
              bool(ws) and not tiling_errors(ws, a, GAP), {"area": a, "errors": tiling_errors(ws, a, GAP)})
        errs = s.log_lines(ERRORS)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])


# --------------------------------------------------------------------------- O03
V2_RATIO = json.dumps({"schemaVersion": 1, "overrides": [
    {"id": "v2-ratio", "match": {"outputName": "Virtual-2"}, "set": {"masterStack": {"ratio": 0.7}}}]}, separators=(",", ":"))


def master_share(s: Session, output: str) -> float | None:
    """Oracle: width share of the widest of an output's two windows within the usable width."""
    ws = on_output(s, output)
    if len(ws) != 2:
        return None
    a = area_of(s, output)
    return max(x["frame"]["width"] for x in ws) / (a["width"] - 2 * GAP - GAP)


@scenario("output-reorder-O03")
def output_reorder(out: Path, c: Checks):
    """Output priority (enumeration order) and then geometric order change; identity and preferences hold.

    Preferences under test: a configuration override by output name (Virtual-2: master ratio 0.7) and
    a session layout override (bsp on Virtual-1's context). Plastile orders outputs left to right
    for send-to-output, never by KWin's priority order. Outputs are 1200 px tall so six windows
    adopted on one output do not overflow (a 150x150 client minimum, 186 px frame, per window).
    Observed in KWin 6.7.5: repositioning outputs does not carry windows along; KWin re-assigns
    each window's output from its position, so step 2 judges whatever membership KWin decides.
    """
    facts: dict = {}
    with Session(out, outputs=3, height=1200, config={"traceCapacity": 8192, "configJson": V2_RATIO}) as s:
        for i in range(1, 7):
            s.spawn(i)
        s.load(); s.settle()
        send_to_next_output(s, 3); send_to_next_output(s, 4)
        send_to_next_output(s, 5, 2); send_to_next_output(s, 6, 2)
        place = outputs_of(s)
        c("setup: 1,2 on Virtual-0; 3,4 on Virtual-1; 5,6 on Virtual-2",
          [place[fx(i)] for i in range(1, 7)] == ["Virtual-0"] * 2 + ["Virtual-1"] * 2 + ["Virtual-2"] * 2, place)
        s.act(fx(3), "workspace.activeWindow = w")
        s.cmd("layout.bsp")
        time.sleep(0.4)
        s.settle()
        share2 = master_share(s, "Virtual-2")
        e3 = explain(s, fx(3))
        errs = per_output_errors(s)
        c("setup: every output tiled (oracle); preferences in effect: Virtual-2 ratio 0.7 (oracle share), Virtual-1 bsp (explain)",
          not errs and share2 is not None and abs(share2 - 0.7) < 0.01 and e3.get("layout") == "bsp",
          {"errors": errs, "share2": share2, "layout1": e3.get("layout")})
        frames0 = {f["caption"]: f["frame"] for f in s.frames_list()}
        ctx0 = sorted(x["id"] for x in s.counters()["contexts"])
        sc0 = screens(s)

        # Step 1: priority / enumeration-order change (no geometry change): Virtual-1 first.
        a = s.counters()
        t0 = last_trace_t(s)
        r = kscreen_try(s, "output.Virtual-1.priority.1", "output.Virtual-0.priority.2", "output.Virtual-2.priority.3")
        changed = until(lambda: screens(s)["order"] == ["Virtual-1", "Virtual-0", "Virtual-2"])
        time.sleep(0.8)
        b = s.settle()
        sc1 = screens(s)
        c("O03 precondition: screenOrder is Virtual-1, Virtual-0, Virtual-2 and output geometry unchanged (oracle)",
          changed and sc1["screens"] == sc0["screens"], {"kscreen": r, "before": sc0["order"], "after": sc1["order"]})
        c("O03 priority: every window stays on its output (oracle)", outputs_of(s) == place, outputs_of(s))
        frames1 = {f["caption"]: f["frame"] for f in s.frames_list()}
        c("O03 priority: no window moved (oracle) and Plastile wrote nothing",
          all(near(frames1[k], frames0[k], 0.5) for k in frames0) and delta(a, b).get("writes", 0) == 0
          and not writes_in(trace_since(trace(s), t0)), {"delta": delta(a, b)})
        c("O03 priority: context identities unchanged (keyed by output name)",
          sorted(x["id"] for x in s.counters()["contexts"]) == ctx0, s.counters()["contexts"])
        c("O03 priority: preferences unchanged (Virtual-2 ratio share, Virtual-1 bsp)",
          abs((master_share(s, "Virtual-2") or 0) - 0.7) < 0.01 and explain(s, fx(3)).get("layout") == "bsp",
          {"share2": master_share(s, "Virtual-2")})
        # In screenOrder the successor of Virtual-0 is now Virtual-2; left to right it is Virtual-1.
        send_to_next_output(s, 1)
        c("O03 priority: send-to-output follows geometric order, not priority (Virtual-0 -> Virtual-1)",
          outputs_of(s).get(fx(1)) == "Virtual-1", outputs_of(s))
        s.act(fx(1), "workspace.activeWindow = w")
        s.cmd("move.output-previous")
        s.settle()
        c("setup: fixture 1 back on Virtual-0", outputs_of(s).get(fx(1)) == "Virtual-0", outputs_of(s))

        # Step 2: geometric reorder: Virtual-2 becomes the leftmost output, Virtual-1 the rightmost.
        r = kscreen_try(s, "output.Virtual-2.position.0,0", "output.Virtual-0.position.1280,0",
                        "output.Virtual-1.position.2560,0")
        moved = until(lambda: geometry_of(s)["Virtual-2"]["x"] == 0 and geometry_of(s)["Virtual-1"]["x"] == 2560)
        time.sleep(1.0)
        s.settle(); time.sleep(0.3); s.settle()
        c("O03 precondition: outputs repositioned (Virtual-2, Virtual-0, Virtual-1 left to right) (oracle)",
          moved, {"kscreen": r, "geometry": geometry_of(s)})
        place2 = outputs_of(s)
        facts["membershipAfterReposition"] = place2
        geo = geometry_of(s)
        errs = per_output_errors(s)
        c("O03 reorder: every window on a live output; each output's windows tile inside its moved area, gaps>=8 (oracle)",
          not errs and all(o in geo for o in place2.values()), {"errors": errs, "outputs": place2})
        c("O03 reorder: context identities still keyed by the same output names",
          {x["id"].split("\u241f")[0] for x in s.counters()["contexts"]} <= set(geo), s.counters()["contexts"])
        prefs: dict = {}
        if len(on_output(s, "Virtual-2")) == 2:
            prefs["Virtual-2 share"] = master_share(s, "Virtual-2")
        on1 = [x["caption"] for x in on_output(s, "Virtual-1")]
        if on1:
            prefs["Virtual-1 layout"] = explain(s, on1[0]).get("layout")
        facts["preferencesAfterReposition"] = prefs
        c("O03 reorder: preferences follow the output identity (Virtual-2 ratio 0.7, Virtual-1 bsp, for the windows now there)",
          "Virtual-2 share" in prefs and "Virtual-1 layout" in prefs and abs((prefs["Virtual-2 share"] or 0) - 0.7) < 0.01
          and prefs["Virtual-1 layout"] == "bsp",
          prefs)
        src = next((x["caption"] for x in on_output(s, "Virtual-0")), None)
        if src is not None:
            s.act(src, "workspace.activeWindow = w")
            s.cmd("move.output-next")
            s.settle()
        c("O03 reorder: send-to-output follows the new geometric order (Virtual-0 -> Virtual-1)",
          src is not None and outputs_of(s).get(src) == "Virtual-1", {"sent": src, "outputs": outputs_of(s)})
        errs = per_output_errors(s)
        c("O03 reorder: still tiled per output after the transfer (oracle)", not errs, errs)
        errs = s.log_lines(ERRORS)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])
    c("facts (recorded, always passes)", True, facts)


# --------------------------------------------------------------------------- O10
TWO_GAPS = json.dumps({"schemaVersion": 1, "overrides": [
    {"id": "two-gaps", "match": {"desktopName": "Two"}, "set": {"gaps": {"inner": 20, "outer": 20}}}]}, separators=(",", ":"))


def desktops(s: Session) -> list[dict]:
    return json.loads(s.js("emit(workspace.desktops.map(d => ({id: d.id, name: d.name})))")[0])


def current_desktop(s: Session) -> str:
    return json.loads(s.js("emit(workspace.currentDesktop.id)")[0])


def show(s: Session, desktop_id: str) -> None:
    s.js(f"workspace.currentDesktop = workspace.desktops.find(d => d.id === {json.dumps(desktop_id)}); emit(1)")
    time.sleep(0.5)
    s.settle()


def fixture_desktops(s: Session) -> dict[int, list[str]]:
    f = s.frames()
    return {int(k.rsplit(" ", 1)[1]): v["desktops"] for k, v in f.items()}


def left_margin(s: Session, nums) -> float:
    f = s.frames()
    return min(f[fx(i)]["frame"]["x"] for i in nums)


@scenario("desktops-rename-reorder-remove-O10")
def desktops_o10(out: Path, c: Checks):
    """Desktop identity is the KWin desktop id: rename and reorder keep state; removal migrates safely.

    Preferences: a configuration override matched by desktop name ("Two": gaps 20) and a session
    layout override (bsp) on Desktop 1. CONFIGURATION.md (design) section 4 lists "membership/name/
    config change" as the cache invalidation for desktop name matchers.
    """
    facts: dict = {}
    with Session(out, config={"traceCapacity": 8192, "configJson": TWO_GAPS}) as s:
        s.js("workspace.createDesktop(1, 'Two'); workspace.createDesktop(2, 'Three'); emit(1)")
        ds = desktops(s)
        D1, D2, D3 = (d["id"] for d in ds)
        c("setup: desktops Desktop 1, Two, Three", [d["name"] for d in ds] == ["Desktop 1", "Two", "Three"], ds)
        for i in (1, 2, 3, 4):
            s.spawn(i)
        s.load(); s.settle()
        for i in (3, 4):
            s.act(fx(i), "workspace.activeWindow = w")
            s.cmd("move.desktop-next")
            s.settle()
        s.act(fx(1), "workspace.activeWindow = w")
        s.cmd("layout.bsp")
        s.settle()
        mem = fixture_desktops(s)
        c("setup: fixtures 1,2 on Desktop 1 and 3,4 on Two", mem[1] == mem[2] == [D1] and mem[3] == mem[4] == [D2], mem)
        show(s, D2)
        area = s.area()
        f = s.frames()
        two = [f[fx(3)], f[fx(4)]]
        c("setup: name-matched override in effect on Two (gaps 20; oracle)",
          abs(left_margin(s, (3, 4)) - (area["x"] + 20)) <= 0.5 and not tiling_errors(two, area, 20),
          {"frames": [x["frame"] for x in two]})
        show(s, D1)
        c("setup: Desktop 1 uses the session bsp layout (explain)", explain(s, fx(1)).get("layout") == "bsp")
        ctx_ids = sorted(x["id"] for x in s.counters()["contexts"])

        # Rename Two -> Renamed (identity unchanged; the name matcher no longer matches).
        a = s.counters()
        s.js(f"workspace.desktops.find(d => d.id === {json.dumps(D2)}).name = 'Renamed'; emit(1)")
        time.sleep(0.4)
        ds = desktops(s)
        c("O10 rename precondition: same ids, new name (oracle)", [d["id"] for d in ds] == [D1, D2, D3]
          and ds[1]["name"] == "Renamed", ds)
        c("O10 rename: window memberships unchanged (oracle)", fixture_desktops(s) == mem, fixture_desktops(s))
        c("O10 rename: context identities unchanged (keyed by desktop id)",
          sorted(x["id"] for x in s.counters()["contexts"]) == ctx_ids, s.counters()["contexts"])
        c("O10 rename: visible desktop untouched (no writes)", delta(a, s.settle()).get("writes", 0) == 0, delta(a, s.counters()))
        show(s, D2)
        f = s.frames()
        two = [f[fx(3)], f[fx(4)]]
        lm = left_margin(s, (3, 4))
        facts["renamedDesktopLeftMargin"] = lm - area["x"]
        c("O10 rename: windows on the renamed desktop still tiled without overlap (oracle)",
          not tiling_errors(two, area, GAP), tiling_errors(two, area, GAP))
        c("O10 rename: the name-matched override is re-resolved for the new name (gaps back to 8; "
          "CONFIGURATION section 4 'name change' invalidation)", abs(lm - (area["x"] + GAP)) <= 0.5,
          {"leftMargin": lm - area["x"], "expected": GAP})
        show(s, D1)

        # Reorder: Three moves between Desktop 1 and Renamed.
        a = s.counters()
        t0 = last_trace_t(s)
        s.js(f"workspace.moveDesktop(workspace.desktops.find(d => d.id === {json.dumps(D3)}), 1); emit(1)")
        time.sleep(0.5)
        b = s.settle()
        ds = desktops(s)
        c("O10 reorder precondition: order Desktop 1, Three, Renamed with the same ids (oracle)",
          [d["id"] for d in ds] == [D1, D3, D2], ds)
        c("O10 reorder: memberships unchanged (oracle)", fixture_desktops(s) == mem, fixture_desktops(s))
        w = writes_in(trace_since(trace(s), t0))
        c("O10 reorder: visible layout untouched (no writes) and the session bsp override kept",
          delta(a, b).get("writes", 0) == 0 and not w and explain(s, fx(1)).get("layout") == "bsp",
          {"delta": delta(a, b), "writes": w})
        s.act(fx(2), "workspace.activeWindow = w")
        s.cmd("move.desktop-next")
        s.settle()
        c("O10 reorder: send-to-desktop follows the new order (Desktop 1 -> Three)", fixture_desktops(s)[2] == [D3],
          fixture_desktops(s))
        show(s, D3)
        f2 = s.frames()[fx(2)]
        c("O10 reorder: the sent window tiles alone on Three (oracle)", near(f2["frame"], full(s.area()), 1.0), f2["frame"])
        s.act(fx(2), "workspace.activeWindow = w")
        s.cmd("move.desktop-previous")
        s.settle()
        show(s, D1)
        c("setup: fixture 2 back on Desktop 1", fixture_desktops(s)[2] == [D1], fixture_desktops(s))

        # Remove Desktop 1 while it is current: KWin evacuates its windows to the desktop now at its index.
        s.js(f"workspace.removeDesktop(workspace.desktops.find(d => d.id === {json.dumps(D1)})); emit(1)")
        time.sleep(0.8)
        s.settle()
        ds = desktops(s)
        mem2 = fixture_desktops(s)
        cur = current_desktop(s)
        facts["afterRemoval"] = {"desktops": ds, "current": cur, "memberships": mem2}
        c("O10 remove precondition: Desktop 1 gone, its windows evacuated to Three, Three current (oracle)",
          [d["id"] for d in ds] == [D3, D2] and mem2[1] == mem2[2] == [D3] and cur == D3, facts["afterRemoval"])
        f = s.frames()
        moved = [f[fx(1)], f[fx(2)]]
        area = s.area()
        c("O10 remove: evacuated windows tile on their new desktop, gaps>=8 (oracle)",
          not tiling_errors(moved, area, GAP) and all(x["frame"]["height"] >= area["height"] - 2 * GAP - 0.5 for x in moved),
          {"errors": tiling_errors(moved, area, GAP), "frames": [x["frame"] for x in moved]})
        stale = [x for x in s.counters()["contexts"] if D1 in x["id"] and x["members"] > 0]
        c("O10 remove: no context keyed to the removed desktop keeps members", not stale, stale)
        show(s, D2)
        f = s.frames()
        c("O10 remove: the other desktop's windows still tiled (oracle)", not tiling_errors([f[fx(3)], f[fx(4)]], s.area(), GAP),
          tiling_errors([f[fx(3)], f[fx(4)]], s.area(), GAP))
        errs = s.log_lines(ERRORS)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])
    c("facts (recorded, always passes)", True, facts)


# --------------------------------------------------------------------------- L16
@scenario("all-desktops-L16")
def all_desktops(out: Path, c: Checks):
    """A window on all desktops (and one on two desktops) floats and never receives geometry targets."""
    with Session(out, config={"traceCapacity": 8192}) as s:
        s.js("workspace.createDesktop(1, 'Two'); emit(1)")
        D1, D2 = (d["id"] for d in desktops(s))
        for i in (1, 2, 3, 4):
            s.spawn(i)
        s.load(); s.settle()
        s.act(fx(4), "workspace.activeWindow = w")
        s.cmd("move.desktop-next")
        s.settle()
        wid = {f["caption"]: f["id"] for f in s.frames_list()}
        area = s.area()
        c("setup: fixtures 1-3 on Desktop 1, fixture 4 on Two", fixture_desktops(s) == {1: [D1], 2: [D1], 3: [D1], 4: [D2]},
          fixture_desktops(s))
        t0 = last_trace_t(s)
        s.act(fx(3), "w.onAllDesktops = true")
        time.sleep(0.5)
        s.settle()
        f = s.frames()
        c("L16 precondition: fixture 3 is on all desktops (oracle)", f[fx(3)]["onAllDesktops"], f[fx(3)]["desktops"])
        e3 = explain(s, fx(3))
        c("L16: the all-desktop window floats by default (decision source membership, no context)",
          e3.get("mode") == "floating" and (e3.get("decision") or {}).get("source") == "membership"
          and e3.get("context") is None, {"mode": e3.get("mode"), "decision": e3.get("decision"), "context": e3.get("context")})
        f = s.frames()
        pair = [f[fx(1)], f[fx(2)]]
        c("L16: the remaining two re-tile as a pair (oracle, positive control)",
          not tiling_errors(pair, area, GAP) and all(x["frame"]["height"] >= area["height"] - 2 * GAP - 0.5 for x in pair),
          [x["frame"] for x in pair])
        float3 = f[fx(3)]["frame"]
        show(s, D2)
        f = s.frames()
        c("L16: Two's own window fills Two alone; the all-desktop window is not part of that layout (oracle)",
          near(f[fx(4)]["frame"], full(area), 1.0), f[fx(4)]["frame"])
        c("L16: the all-desktop window keeps its frame across the desktop switch (oracle)", near(f[fx(3)]["frame"], float3, 0.5),
          f[fx(3)]["frame"])
        # A window on two desktops is a multi-context window as well.
        s.act(fx(1), f"w.desktops = workspace.desktops.filter(d => d.id === {json.dumps(D1)} || d.id === {json.dumps(D2)})")
        time.sleep(0.5)
        s.settle()
        f = s.frames()
        e1 = explain(s, fx(1))
        c("L16: a window on two desktops floats (reason 'on several desktops')",
          sorted(f[fx(1)]["desktops"]) == sorted([D1, D2]) and e1.get("mode") == "floating"
          and (e1.get("decision") or {}).get("reason") == "on several desktops", {"desktops": f[fx(1)]["desktops"],
                                                                                    "decision": e1.get("decision")})
        f = s.frames()
        c("L16: Two's layout unchanged by the multi-desktop window (oracle)", near(f[fx(4)]["frame"], full(area), 1.0),
          f[fx(4)]["frame"])
        recs = trace_since(trace(s), t0)
        w = writes_in(recs)
        c("L16: no geometry target for the multi-context windows while they are multi-context (trace)",
          w.get(wid[fx(3)], 0) == 0 and w.get(wid[fx(1)], 0) == 0, {fx(3): w.get(wid[fx(3)], 0), fx(1): w.get(wid[fx(1)], 0)})
        # Leaving all desktops puts the window on the current desktop (Two): it tiles there again.
        s.act(fx(3), "w.onAllDesktops = false")
        time.sleep(0.5)
        s.settle()
        f = s.frames()
        e3 = explain(s, fx(3))
        tiled = [f[fx(3)], f[fx(4)]]
        c("L16: back on a single desktop the window tiles again (explain tiled; oracle pair on Two)",
          f[fx(3)]["desktops"] == [D2] and e3.get("mode") == "tiled" and not tiling_errors(tiled, area, GAP)
          and all(x["frame"]["height"] >= area["height"] - 2 * GAP - 0.5 for x in tiled),
          {"desktops": f[fx(3)]["desktops"], "mode": e3.get("mode"), "frames": [x["frame"] for x in tiled]})
        errs = s.log_lines(ERRORS)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])
