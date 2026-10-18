"""Commands, navigation and interaction scenarios (T22, T23, T29; TEST_MATRIX I04, I05) in nested KWin.

Geometry, stacking, activation and output membership are judged by the oracle (one-shot KWin
scripts reading real window state). Plastile's counters and trace are used for amounts of work
and command dispatch only. Pointer and keyboard input are real compositor input through KWin's
EIS endpoint (libei, tools/input). Nested virtual backend: not a physical-session result.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from harness import (KEY_LEFTMETA, Input, Listener, Session, delta, evidence_file, last_trace_t, near, tiling_errors, trace,
                     window_info)
from scenarios import STACK_INFO, Checks, Skipped, kscreen, scenario

ERRORS = r"plastile (error|warn)|TypeError|ReferenceError"
KEY_SHIFT, KEY_CTRL, KEY_N, KEY_L, KEY_EQUAL, KEY_MINUS = 42, 29, 49, 38, 13, 12


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def active(s: Session) -> str | None:
    out = s.js("emit(workspace.activeWindow ? workspace.activeWindow.caption : null)")
    return json.loads(out[0])


def wait_active(s: Session, caption: str, timeout: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if active(s) == caption:
            return True
        time.sleep(0.02)
    return False


def send_to(s: Session, caption: str, output: str) -> None:
    s.act(caption, f"workspace.sendClientToScreen(w, workspace.screens.find(o => o.name === {json.dumps(output)}))")


def area_of(s: Session, name: str) -> dict:
    out = s.js(f"const o = workspace.screens.find(x => x.name === {json.dumps(name)}); const a = workspace.clientArea("
               f"workspace.MaximizeArea, o, workspace.currentDesktopForScreen(o)); emit({{x: a.x, y: a.y, width: a.width,"
               f" height: a.height}});")
    return json.loads(out[0])


def screens(s: Session) -> list[dict]:
    return json.loads(s.js("emit(workspace.screens.map(o => ({name: o.name, x: o.geometry.x, y: o.geometry.y})))")[0])


# ------------------------------------------------------------------------- T23
@scenario("focus-output-wrap-T23")
def focus_output_wrap(out: Path, c: Checks):
    """Cross-output focus resolves by topology (outputs re-positioned against enumeration order) and
    activates the most recently focused window there; focusWrap wraps within one output only."""
    cfg = {"schemaVersion": 1, "overrides": [{"id": "wrap-left", "match": {"outputName": "Virtual-2"},
                                              "set": {"focusWrap": True}}]}
    with Session(out, outputs=3, config={"configJson": json.dumps(cfg), "traceCapacity": 8192}) as s:
        # Enumeration order is Virtual-0, -1, -2; place them right to left, so topology is 2, 1, 0.
        kscreen(s, "output.Virtual-0.position.2560,0", "output.Virtual-1.position.1280,0", "output.Virtual-2.position.0,0")
        time.sleep(0.8)
        geo = {o["name"]: o["x"] for o in screens(s)}
        c("setup: outputs placed against enumeration order (Virtual-2 left, Virtual-0 right)",
          geo.get("Virtual-2") == 0 and geo.get("Virtual-1") == 1280 and geo.get("Virtual-0") == 2560,
          {"enumeration": [o["name"] for o in screens(s)], "x": geo})
        for i in range(1, 6):
            s.spawn(i)
        for cap, o in ((fx(1), "Virtual-2"), (fx(2), "Virtual-2"), (fx(3), "Virtual-1"), (fx(4), "Virtual-1"),
                       (fx(5), "Virtual-0")):
            send_to(s, cap, o)
        time.sleep(0.3)
        s.load(); s.settle()
        where = {f["caption"]: f["output"] for f in s.frames_list()}
        c("setup: two windows left, two in the middle, one right",
          where == {fx(1): "Virtual-2", fx(2): "Virtual-2", fx(3): "Virtual-1", fx(4): "Virtual-1", fx(5): "Virtual-0"}, where)
        # Activation history: fixture 3 is the most recent in the middle, fixture 2 on the left.
        for cap in (fx(4), fx(3), fx(5), fx(1), fx(2)):
            s.act(cap, "workspace.activeWindow = w")
        a = s.counters()
        steps = [("focus.output-next", fx(3)), ("focus.output-next", fx(5)), ("focus.output-next", fx(2)),
                 ("focus.output-previous", fx(5)), ("focus.output-previous", fx(3)), ("focus.output-previous", fx(2))]
        got = []
        for cmd, want in steps:
            s.cmd(cmd)
            ok = wait_active(s, want)
            got.append((cmd, want, active(s), ok))
        c("T23: output-next/previous walk outputs in topology order (left, middle, right, cyclic) and pick the "
          "most recently focused window there (oracle: active window)", all(g[3] for g in got), got)
        b = s.settle()
        d = delta(a, b)
        c("T23: cross-output focus is focus only: no solve, no write", d.get("solves", 0) == 0 and d.get("writes", 0) == 0
          and d.get("commands", 0) == 6, d)
        # focusWrap on the left output (override): right from the stack wraps to the master; on the
        # middle output (default, no wrap) right from the stack is a no-op and never leaves the output.
        s.act(fx(2), "workspace.activeWindow = w")
        s.cmd("focus.right")
        c("T23: focusWrap (Virtual-2 override): right from the rightmost tile wraps to the left end of the same output",
          wait_active(s, fx(1)), active(s))
        s.cmd("focus.left")
        c("T23: focusWrap: left from the leftmost tile wraps to the right end", wait_active(s, fx(2)), active(s))
        s.act(fx(4), "workspace.activeWindow = w")
        off = s.kw.mark()
        a = s.counters()
        s.cmd("focus.right")
        time.sleep(0.4)
        b = s.counters()
        c("T23: default (no wrap): right from the rightmost tile of the middle output stays there (no cross-output jump)",
          active(s) == fx(4) and delta(a, b).get("commands", 0) == 1, {"active": active(s), "delta": delta(a, b)})
        c("T23: no errors", not s.log_lines(ERRORS, 0), s.log_lines(ERRORS, 0)[:3])
        del off


# ------------------------------------------------------------------------- T22
@scenario("monocle-focus-cycle-T22")
def monocle_focus_cycle(out: Path, c: Checks):
    """Monocle with a transient dialog: cycling focus by command raises each member, minimizes no peer,
    keeps the dialog above its parent and never writes the dialog (BEHAVIOR §6)."""
    with Session(out, config={"traceCapacity": 8192}) as s:
        s.spawn(1); s.spawn(2, "--parent-after-ms", "200"); s.spawn(3)
        s.load()
        time.sleep(1.0); s.settle()
        child = fx(2) + " child"
        caps = [fx(1), fx(2), fx(3)]
        c("setup: the dialog exists and floats", child in s.frames(), list(s.frames()))
        dialog0 = window_info(s, child, STACK_INFO)
        s.act(fx(1), "workspace.activeWindow = w")
        s.cmd("layout.monocle")
        time.sleep(0.4); s.settle()
        area = s.area()
        full = {"x": area["x"] + 8, "y": area["y"] + 8, "width": area["width"] - 16, "height": area["height"] - 16}
        fr = s.frames()
        c("setup: monocle: every member fills the area (oracle)", all(near(fr[k]["frame"], full, 1.0) for k in caps),
          {k: fr[k]["frame"] for k in caps})
        a = s.counters()
        rows = []
        bad = []
        for cmd, want in (("focus.next", fx(2)), ("focus.next", fx(3)), ("focus.next", fx(1)), ("focus.previous", fx(3)),
                          ("focus.previous", fx(2)), ("focus.previous", fx(1)), ("focus.next", fx(2))):
            s.cmd(cmd)
            reached = wait_active(s, want)
            time.sleep(0.15)
            info = {k: window_info(s, k, STACK_INFO) for k in caps + [child]}
            sel = info[want]
            others = [info[k] for k in caps if k != want]
            row = {"cmd": cmd, "want": want, "active": active(s), "stack": {k: v["stack"] for k, v in info.items()}}
            rows.append(row)
            if not reached:
                bad.append(("not activated", row))
            if not all(sel["stack"] > o["stack"] for o in others):
                bad.append(("selected member not above its peers", row))
            if any(info[k]["minimized"] or info[k]["hidden"] for k in caps + [child]):
                bad.append(("a window was minimized or hidden", row))
            if not info[child]["stack"] > info[fx(2)]["stack"]:
                bad.append(("dialog below its parent", row))
            if want == fx(2) and not info[child]["stack"] > max(v["stack"] for k, v in info.items() if k != child):
                bad.append(("parent selected but its dialog is not on top", row))
        c("T22: each focus command activates and raises the next member; no peer is minimized or hidden; the dialog "
          "stays above its parent (stacking order, oracle)", not bad, bad or rows)
        b = s.settle()
        d = delta(a, b)
        c("T22: focus cycling in monocle solves and writes nothing (raises only)", d.get("solves", 0) == 0 and
          d.get("writes", 0) == 0 and d.get("raises", 0) >= 7, d)
        fr = s.frames()
        c("T22: members still fill the area; the dialog keeps its floating frame (oracle)",
          all(near(fr[k]["frame"], full, 1.0) for k in caps) and near(fr[child]["frame"], dialog0["frame"], 0.5),
          {k: fr[k]["frame"] for k in caps + [child]})
        wid = {x["caption"]: x["id"] for x in s.frames_list()}
        w = [r for r in trace(s) if r.get("kind") == "write" and r.get("id") == wid.get(child)]
        c("T22: Plastile never wrote the dialog (trace)", not w, len(w))
        c("T22: no errors", not s.log_lines(ERRORS, 0), s.log_lines(ERRORS, 0)[:3])


# ------------------------------------------------------------------------- T29
def _live_resize_run(out: Path, live: bool) -> dict:
    cfg = {"schemaVersion": 1, "defaults": {"liveResize": live}}
    with Session(out, config={"configJson": json.dumps(cfg), "traceCapacity": 16384}) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        s.load(); s.settle()
        lst = Listener(s, frames=(fx(1), fx(2)))
        inp = Input(s)
        try:
            f = s.frames()
            m = f[fx(1)]["frame"]
            wid = {x["caption"]: x["id"] for x in s.frames_list()}
            x0, y0 = m["x"] + m["width"] - 20, m["y"] + m["height"] - 20
            t_start = last_trace_t(s)
            off = s.kw.mark()
            a = s.counters()
            # 2 s of real pointer motion: Meta+right-drag from the master's bottom-right corner,
            # 120 steps of 2 px right (and back half way), one step per ~16.7 ms.
            inp.do(f"key {KEY_LEFTMETA} down", f"move {x0} {y0}")
            time.sleep(0.02)
            inp.do("press right")
            t0 = time.monotonic()
            n = 120
            for i in range(1, n + 1):
                dx = 2 * i if i <= 80 else 2 * 80 - 2 * (i - 80)
                inp.do(f"move {x0 + dx} {y0}")
                target = t0 + i * (2.0 / n)
                time.sleep(max(0.0, target - time.monotonic()))
            seconds = time.monotonic() - t0
            b = s.counters()
            time.sleep(0.4)  # let the last configures land, still holding the button
            mid = s.frames()
            frames_master = len([ln for ln in lst.lines("frame", off) if fx(1) + "|" in ln])
            peer_frames = len([ln for ln in lst.lines("frame", off) if fx(2) + "|" in ln])
            t_release = last_trace_t(s)
            b2 = s.counters()
            inp.do("release right", f"key {KEY_LEFTMETA} up")
            time.sleep(0.6); c_end = s.settle()
            g = s.frames()
            tr = trace(s)
            d = delta(a, b)
            d_end = delta(b2, c_end)
            master_writes = [r for r in tr if r.get("kind") == "write" and r.get("id") == wid[fx(1)]]
            m_mid, s_mid = mid[fx(1)]["frame"], mid[fx(2)]["frame"]
            m_end, s_end = g[fx(1)]["frame"], g[fx(2)]["frame"]
            return {
                "live": live, "seconds": round(seconds, 3), "steps": n,
                "duringDrag": {"solves": d.get("solves", 0), "liveSolves": d.get("liveSolves", 0), "writes": d.get("writes", 0),
                               "flushes": d.get("flushes", 0), "observations": d.get("observations", 0)},
                "perSecond": {"solves": round(d.get("solves", 0) / seconds, 1), "liveSolves": round(d.get("liveSolves", 0) / seconds, 1),
                              "writes": round(d.get("writes", 0) / seconds, 1)},
                "masterFrameChanges": frames_master, "peerFrameChanges": peer_frames,
                "release": {"solves": d_end.get("solves", 0), "writes": d_end.get("writes", 0)},
                "masterWritesDuringDrag": len([r for r in master_writes if t_start < r["t"] <= t_release]),
                "masterWritesTotal": len(master_writes),
                "mid": {"master": m_mid, "peer": s_mid}, "end": {"master": m_end, "peer": s_end},
                "area": s.area(), "tilingErrors": tiling_errors(s.frames_list(), s.area(), 8),
                "errors": s.log_lines(ERRORS, off)[:3], "start": m,
            }
        finally:
            inp.close()
            lst.close()


@scenario("live-resize-T29")
def live_resize(out: Path, c: Checks):
    """liveResize off vs on during a 2 s libei resize: work per second, peers follow only when on, the resized
    window is never written during the drag, and the release commits the final ratio once."""
    off = _live_resize_run(out / "off", False)
    on = _live_resize_run(out / "on", True)
    evidence_file("live-resize-T29.json").write_text(json.dumps({"off": off, "on": on}, indent=1))
    (out / "live-resize.json").write_text(json.dumps({"off": off, "on": on}, indent=1))
    c("T29 off: no solve and no write during the drag", off["duringDrag"]["solves"] == 0 and off["duringDrag"]["writes"] == 0,
      off["duringDrag"])
    c("T29 off: peer did not move during the drag (oracle)", off["peerFrameChanges"] == 0, off["peerFrameChanges"])
    c("T29 on: peers followed during the drag (oracle: peer x = master right edge + gap at a quiet moment)",
      on["peerFrameChanges"] > 0 and abs(on["mid"]["peer"]["x"] - (on["mid"]["master"]["x"] + on["mid"]["master"]["width"] + 8)) <= 1,
      on["mid"])
    c("T29 on: live solves bounded by the resized window's frame changes (one solve per frame at most)",
      0 < on["duringDrag"]["liveSolves"] <= max(1, on["masterFrameChanges"]),
      {"liveSolves": on["duringDrag"]["liveSolves"], "masterFrameChanges": on["masterFrameChanges"]})
    for r in (off, on):
        tag = "on" if r["live"] else "off"
        c(f"T29 {tag}: the resized window is never written during the drag (trace)", r["masterWritesDuringDrag"] == 0, r["masterWritesTotal"])
        c(f"T29 {tag}: release commits once: master keeps the dragged width, peer follows, tiled (oracle)",
          r["release"]["solves"] <= 1 and abs(r["end"]["master"]["width"] - r["mid"]["master"]["width"]) <= 2 and
          abs(r["end"]["peer"]["x"] - (r["end"]["master"]["x"] + r["end"]["master"]["width"] + 8)) <= 1 and not r["tilingErrors"],
          {"release": r["release"], "end": r["end"], "mid": r["mid"]["master"], "errors": r["tilingErrors"]})
        c(f"T29 {tag}: no errors", not r["errors"], r["errors"])
    c("T29: numbers recorded", True, {"off": off["perSecond"], "on": on["perSecond"], "onFrames": on["masterFrameChanges"],
                                      "seconds": [off["seconds"], on["seconds"]]})


# ------------------------------------------------------------------------- I04
@scenario("drag-output-removal-I04")
def drag_output_removal(out: Path, c: Checks):
    """The output under an active libei drag is disabled: no stale callbacks, the window ends visible on the
    surviving output, the layout is valid and nothing logs an error."""
    with Session(out, outputs=2) as s:
        for i in range(1, 5):
            s.spawn(i)
        s.load(); s.settle()
        for cap in (fx(3), fx(4)):
            s.act(cap, "workspace.activeWindow = w")
            s.cmd("move.output-next"); s.settle()
        on1 = [f["caption"] for f in s.frames_list() if f["output"] == "Virtual-1"]
        c("setup: two windows on Virtual-1", sorted(on1) == [fx(3), fx(4)], on1)
        inp = Input(s)
        try:
            f = s.frames()
            r3 = f[fx(3)]["frame"]
            x0, y0 = r3["x"] + r3["width"] / 2, r3["y"] + r3["height"] / 2
            off = s.kw.mark()
            a = s.counters()
            inp.drag(x0, y0, x0 + 150, y0 + 60, release=False)
            moving = window_info(s, fx(3), "({move: w.move, output: w.output.name})")
            c("I04 precondition: the window is in an interactive move on Virtual-1", bool(moving and moving["move"]), moving)
            kscreen(s, "output.Virtual-1.disable")
            time.sleep(0.6)
            # The pointer keeps moving (now over the surviving output), then the button is released.
            for i in range(1, 6):
                inp.do(f"move {300 + 40 * i} {300 + 20 * i}")
                time.sleep(0.03)
            inp.do("release left", f"key {KEY_LEFTMETA} up")
            time.sleep(0.8); b = s.settle()
            area = area_of(s, "Virtual-0")
            fl = s.frames_list()
            c("I04: every window on the surviving output (oracle)", len(fl) == 4 and all(x["output"] == "Virtual-0" for x in fl),
              [(x["caption"], x["output"], x["frame"]) for x in fl])
            info = window_info(s, fx(3), "({move: w.move, minimized: w.minimized, hidden: w.hidden})")
            c("I04: the dragged window is visible: not minimized/hidden, interaction over (oracle)",
              info and not info["move"] and not info["minimized"] and not info["hidden"], info)
            c("I04: layout valid inside the surviving area (oracle, gaps>=8)", not tiling_errors(fl, area, 8), tiling_errors(fl, area, 8))
            errs = s.log_lines(ERRORS, off)
            c("I04: no errors from stale callbacks", not errs and b["counters"]["errors"] == 0, {"log": errs[:3], "errors": b["counters"]["errors"]})
            c("I04: converged: nothing outstanding", b["outstanding"] == 0, {"outstanding": b["outstanding"], "delta": delta(a, b)})
            kscreen(s, "output.Virtual-1.enable")
            time.sleep(1.0); s.settle()
            c("I04: re-enabling the output afterwards leaves no errors", not s.log_lines(ERRORS, off), s.log_lines(ERRORS, off)[:3])
        finally:
            inp.close()


# ------------------------------------------------------------------------- I05
def _keys(inp: Input, *combo: int) -> None:
    for k in combo:
        inp.do(f"key {k} down")
    for k in reversed(combo):
        inp.do(f"key {k} up")


def _rapid_keys(out: Path, c: Checks, live: bool) -> dict:
    tag = "liveResize on" if live else "liveResize off"
    cfg = {"diagnostics": "debug", "traceCapacity": 16384}
    if live:
        cfg["configJson"] = json.dumps({"schemaVersion": 1, "defaults": {"liveResize": True}})
    with Session(out, config=cfg) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        s.load(); s.settle()
        try:
            inp = Input(s)
        except Exception as exc:
            raise Skipped(f"libei input injector unavailable: {exc}")
        try:
            m = s.frames()[fx(1)]["frame"]
            x0, y0 = m["x"] + m["width"] - 20, m["y"] + m["height"] - 20
            s.act(fx(2), "workspace.activeWindow = w")
            wid = {x["caption"]: x["id"] for x in s.frames_list()}
            t_start = last_trace_t(s)
            off = s.kw.mark()
            a = s.counters()
            inp.do(f"key {KEY_LEFTMETA} down", f"move {x0} {y0}")
            time.sleep(0.02)
            inp.do("press right")
            for i in range(1, 11):
                inp.do(f"move {x0 + 8 * i} {y0}")
                time.sleep(0.016)
            resizing = window_info(s, fx(1), "({resize: w.resize})")
            c(f"I05 [{tag}] precondition: the master is in an interactive resize", bool(resizing and resizing["resize"]), resizing)
            # Real keys, Meta still held: Meta+Shift+N (focus.next) x3, Meta+Ctrl+= (grow), Meta+Ctrl+- (shrink).
            for combo in ((KEY_SHIFT, KEY_N), (KEY_SHIFT, KEY_N), (KEY_CTRL, KEY_EQUAL), (KEY_SHIFT, KEY_N), (KEY_CTRL, KEY_MINUS)):
                _keys(inp, *combo)
            time.sleep(0.3)
            key_cmds = [re.search(r'"command":"([^"]+)"', ln).group(1) for ln in s.log_lines(r"plastile debug command \{", off)]
            # The same commands through KWin's shortcut service (D-Bus invokeShortcut), as fast as possible.
            off2 = s.kw.mark()
            burst = ["focus.next", "resize.grow", "swap.next", "focus.previous", "resize.shrink", "layout.next", "layout.previous"]
            for cmd in burst:
                s.cmd(cmd)
            time.sleep(0.4)
            dbus_cmds = [re.search(r'"command":"([^"]+)"', ln).group(1) for ln in s.log_lines(r"plastile debug command \{", off2)]
            still = window_info(s, fx(1), "({resize: w.resize})")
            b = s.counters()
            for i in range(11, 21):
                inp.do(f"move {x0 + 8 * i} {y0}")
                time.sleep(0.016)
            time.sleep(0.3)
            before_release = s.frames()[fx(1)]["frame"]
            t_release = last_trace_t(s)
            inp.do("release right", f"key {KEY_LEFTMETA} up")
            time.sleep(0.6); e = s.settle()
            g = s.frames()
            tr = trace(s)
            cmd_trace = [r["data"]["id"] for r in tr if r.get("kind") == "command" and isinstance(r.get("data"), dict)
                         and not str(r["data"].get("id", "")).startswith("plastile.inspect")]
            # KWin 6.7.5 routes global shortcuts while an interactive resize runs (measured here): every
            # press reaches Plastile, in the order pressed.
            c(f"I05 [{tag}]: real key presses during the resize reach Plastile in the order pressed (dispatch log)",
              key_cmds == ["plastile.focus.next", "plastile.focus.next", "plastile.resize.grow", "plastile.focus.next",
                           "plastile.resize.shrink"], {"dispatchedFromKeys": key_cmds, "pressed": 5})
            c(f"I05 [{tag}]: every burst command was dispatched in arrival order while the resize was still active",
              dbus_cmds == ["plastile." + x for x in burst] and bool(still and still["resize"]),
              {"dispatched": dbus_cmds, "stillResizing": still})
            d = delta(a, b)
            c(f"I05 [{tag}]: no queue barrier: no command waited behind the interaction (commandsQueued +0)", d.get("commandsQueued", 0) == 0, d)
            c(f"I05 [{tag}]: trace order matches dispatch order", cmd_trace[-len(burst):] == ["plastile." + x for x in burst] if len(cmd_trace) >= len(burst) else False,
              cmd_trace[-12:])
            w1 = [r for r in tr if r.get("kind") == "write" and r.get("id") == wid[fx(1)] and t_start < r["t"] <= t_release]
            c(f"I05 [{tag}]: the window being resized is never written while the commands run (trace)", not w1, len(w1))
            m1 = g[fx(1)]["frame"]
            c(f"I05 [{tag}]: release commits the boundary where the user let go (master right edge, oracle)",
              abs((m1["x"] + m1["width"]) - (before_release["x"] + before_release["width"])) <= 2,
              {"atRelease": before_release, "after": m1})
            fl = s.frames_list()
            c(f"I05 [{tag}]: layout valid after the release (oracle)", not tiling_errors(fl, s.area(), 8), tiling_errors(fl, s.area(), 8))
            c(f"I05 [{tag}]: no errors", not s.log_lines(ERRORS, off) and e["counters"]["errors"] == 0, s.log_lines(ERRORS, off)[:3])
            return {"dispatchedFromKeys": key_cmds, "dispatchedFromDbus": dbus_cmds, "delta": d}
        finally:
            inp.close()


@scenario("resize-rapid-keys-I05")
def resize_rapid_keys(out: Path, c: Checks):
    """Rapid commands during an interactive resize: real key presses (and a faster D-Bus burst) reach Plastile while
    KWin runs the resize, run at once in arrival order (no queue behind the interaction), never write the window
    being resized, and the release commits the boundary where the user let go. Once with liveResize off, once on."""
    res = {"off": _rapid_keys(out / "off", c, False), "on": _rapid_keys(out / "on", c, True)}
    evidence_file("resize-rapid-keys-I05.json").write_text(json.dumps(res, indent=1))
