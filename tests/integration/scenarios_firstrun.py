"""First-run feedback (the first physical session's report, 2026-10-18): a new user must be able to tell that
Plastile is alive and what a command changed.

- FR1 `firstrun-notice-default`: at the default log level (warn) the `plastile notice` lines appear (started with
  the layout per visible context, a layout change, explain, stopped), nothing else does, and KWin's log has no
  `qt.qml.usedbeforedeclared` warning for the bundle.
- FR2 `firstrun-osd-fake`: a stand-in org.kde.osdService on the private bus (fake_osd.py) is the oracle for
  Plasma's OSD: the exact icon and text of each layout command and pause/resume, in order, and none for window
  events.
- FR3 `firstrun-osd-off-absent`: `osd=false` sends nothing; without the service the first command's call fails
  (one debug line), commands within 30 s send nothing, and a command 30 s later reaches a service that appeared.
- FR4 `firstrun-target-visible`: a window sent to a hidden desktop stays active (measured); layout commands then
  change the desktop on screen, not that window's.
- FR5 `firstrun-maximized-suspended`: a maximized tiled window: explain's `suspended` statement and the counters'
  `tiled`/`suspended`, and the other window fills the area (oracle).
- FR6 `firstrun-restored-notice`: a layout chosen by command is announced once at the next load after a KWin
  restart (`restored saved layout ...`), and not after a reset.

Geometry is judged by the oracle (one-shot KWin scripts); the OSD by the fake service's own record.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from harness import ROOT, Session, explain, near, tiling_errors
from scenarios import Checks, scenario
from scenarios_persist import DESKTOP_ID, generation, newest, psession, pload, wait_generation

sys.path.insert(0, str(ROOT / "tools"))
from nested import session_base  # noqa: E402

FAKE_OSD = Path(__file__).resolve().parent / "fake_osd.py"
GAP = 8
STARTED = r"plastile notice started "
UBD = r"usedbeforedeclared|is used before its declaration"


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def full(area: dict) -> dict:
    return {"x": area["x"] + GAP, "y": area["y"] + GAP, "width": area["width"] - 2 * GAP, "height": area["height"] - 2 * GAP}


def out_name(s: Session) -> str:
    """The first output's connector name (Virtual-0 on KWin 6.7.5's virtual backend)."""
    return json.loads(s.js("emit(workspace.screens[0].name)")[0])


def message(line: str) -> str:
    """The Plastile part of a KWin log line ("<time> <category> plastile ...")."""
    i = line.find("plastile ")
    return line[i:] if i >= 0 else line


def plastile_lines(s: Session, off: int) -> list[str]:
    """Plastile's own lines since `off`, without the counters dumps the harness itself asks for."""
    return [message(x) for x in s.log_lines(r"plastile (error|notice|warn|info|debug) ", off)]


def contexts(s: Session) -> dict[str, dict]:
    """Counters' contexts by "<output> / <desktop id>"."""
    return {"/".join(x["id"].split("␟")[:2]): x for x in s.counters()["contexts"]}


class FakeOsd:
    """fake_osd.py on the session's private bus; `calls()` is its record."""

    def __init__(self, s: Session, name: str = "osd"):
        self.record = s.out / f"{name}-calls.jsonl"
        self.record.write_text("")
        env = s.kw.env()
        assert env["DBUS_SESSION_BUS_ADDRESS"] == s.kw.bus_address, "private bus only"
        self.proc = subprocess.Popen([sys.executable, str(FAKE_OSD), str(self.record)], env=env,
                                     stdout=subprocess.PIPE, stderr=open(s.out / f"{name}.log", "w"))
        line = self.proc.stdout.readline().decode().strip()
        if line != "ready":
            self.close()
            raise RuntimeError(f"fake osd did not start: {line!r}")

    def calls(self) -> list[dict]:
        return [json.loads(x) for x in self.record.read_text().splitlines() if x.strip()]

    def wait(self, n: int, timeout: float = 3.0) -> list[dict]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            c = self.calls()
            if len(c) >= n:
                return c
            time.sleep(0.03)
        return self.calls()

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(3)


# ----------------------------------------------------------------------------- FR1
@scenario("firstrun-notice-default-FR1")
def notice_default(out: Path, c: Checks):
    # diagnostics= (empty) is "not set": the default level, warn.
    with Session(out, config={"diagnostics": ""}) as s:
        s.spawn(1); s.spawn(2)
        off0 = s.kw.mark()
        s.load(); s.settle()
        OUT = out_name(s)
        started = [message(x) for x in s.log_lines(STARTED, off0)]
        want = f"plastile notice started 0.1.0: 2 windows, configuration revision 1; layout master-stack on {OUT} / Desktop 1"
        c("FR1: the start line at the default level names windows, revision and the visible layout", started == [want], started)
        ubd = s.log_lines(UBD, 0)
        c("FR1: no qt.qml.usedbeforedeclared warning in KWin's log (the five of the first physical session are gone)",
          not ubd, ubd[:5])
        early = plastile_lines(s, off0)
        c("FR1: at load nothing but the start line (no info or debug lines)", early == [want], early)
        area = s.area()
        pre = s.frames()
        off = s.kw.mark()
        s.cmd("layout.next")
        s.kw.wait_log(r"plastile notice layout ", 5, off)
        time.sleep(0.3)
        cmd_lines = plastile_lines(s, off)
        c("FR1: a layout command logs exactly one line, the notice",
          cmd_lines == [f"plastile notice layout bsp on {OUT} / Desktop 1 (was master-stack)"], cmd_lines)
        s.settle()
        f = s.frames()
        # Master-stack's unequal pair also tiles the area: the BSP pair is told apart by its equal halves.
        a, b = f[fx(1)]["frame"], f[fx(2)]["frame"]
        c("FR1: the command took effect (oracle: the tiles changed into a BSP pair, two equal side-by-side halves)",
          not tiling_errors([f[fx(1)], f[fx(2)]], area, GAP) and abs(a["width"] - b["width"]) <= 1
          and abs(a["y"] - b["y"]) <= 0.5 and abs(a["height"] - b["height"]) <= 0.5 and not all(near(f[k]["frame"], pre[k]["frame"], 1.0) for k in pre),
          {"before": [pre[fx(1)]["frame"], pre[fx(2)]["frame"]], "after": [a, b]})
        off = s.kw.mark()
        s.spawn(3); s.settle(); s.kill(3); s.settle()
        quiet = plastile_lines(s, off)
        c("FR1: window events log nothing at the default level", quiet == [], quiet)
        x = explain(s, fx(1))
        c("FR1: explain is a notice shown at the default level", x.get("mode") == "tiled", {"mode": x.get("mode")})
        off = s.kw.mark()
        s.unload()
        c("FR1: unload logs the stop notice", [message(x) for x in s.log_lines(r"plastile notice stopped", off)]
          == ["plastile notice stopped"], s.log_lines(r"plastile ", off))
    with Session(out / "error-level", config={"diagnostics": "error"}) as s:
        s.spawn(1)
        off = s.kw.mark()
        s.kw.load_declarative(s.qml, "plastile")
        time.sleep(1.5)
        s.cmd("layout.next")
        time.sleep(0.5)
        quiet = plastile_lines(s, off)
        c("FR1: diagnostics=error hides the notices (positive control: the script is loaded)",
          quiet == [] and s.kw.is_loaded("plastile"), quiet)
        s.kw.unload("plastile")


# ----------------------------------------------------------------------------- FR2
@scenario("firstrun-osd-fake-FR2")
def osd_fake(out: Path, c: Checks):
    with Session(out) as s:
        osd = FakeOsd(s)
        try:
            s.spawn(1); s.spawn(2)
            s.load(); s.settle()
            s.spawn(3); s.settle(); s.kill(3); s.settle()
            s.act(fx(1), "workspace.activeWindow = w"); s.settle()
            c("FR2: window events (open, close, activation) show nothing", osd.calls() == [], osd.calls())
            steps = [("layout.next", "view-grid", "BSP layout"),
                     ("layout.next", "window-maximize", "Monocle layout"),
                     ("layout.next", "window-duplicate", "Floating layout (tiling off)"),
                     ("runtime.toggle-suspend", "media-playback-pause", "Tiling paused"),
                     ("runtime.toggle-suspend", "media-playback-start", "Tiling resumed")]
            for i, (cmd, _icon, _text) in enumerate(steps):
                s.cmd(cmd)
                osd.wait(i + 1)
            s.cmd("layout.monocle"); osd.wait(6)
            s.cmd("layout.monocle")  # already monocle: no change, no message
            time.sleep(0.5)
            got = [(x["icon"], x["text"]) for x in osd.calls()]
            want = [(i, t) for _, i, t in steps] + [("window-maximize", "Monocle layout")]
            c("FR2: exact OSD icon and text per command, in order; a no-op command shows nothing", got == want,
              {"got": got, "want": want})
            # A second desktop: the message names the desktop.
            s.js("workspace.createDesktop(1, 'Two'); emit(1)"); time.sleep(0.3)
            s.cmd("layout.next"); osd.wait(7)
            last = osd.calls()[-1] if osd.calls() else {}
            c("FR2: with two desktops the desktop is named", (last.get("icon"), last.get("text"))
              == ("window-duplicate", "Floating layout (tiling off) — Desktop 1"), last)
            cnt = s.counters()
            c("FR2: counters: the OSD is idle, 7 sent, no failure", cnt.get("osd") == {"state": "idle", "sent": 7, "failures": 0},
              cnt.get("osd"))
        finally:
            osd.close()


# ----------------------------------------------------------------------------- FR3
@scenario("firstrun-osd-off-absent-FR3")
def osd_off_absent(out: Path, c: Checks):
    with Session(out / "off", config={"osd": "false"}) as s:
        osd = FakeOsd(s)
        try:
            s.spawn(1); s.spawn(2)
            s.load(); s.settle()
            off = s.kw.mark()
            s.cmd("layout.next"); s.cmd("runtime.toggle-suspend"); s.cmd("runtime.toggle-suspend")
            time.sleep(1.0)
            notes = [message(x) for x in s.log_lines(r"plastile notice (layout|tiling)", off)]
            c("FR3: osd=false: no OSD call, the notices still log", osd.calls() == [] and len(notes) == 3,
              {"calls": osd.calls(), "notices": notes})
            c("FR3: osd=false: counters say off", s.counters().get("osd", {}).get("state") == "off", s.counters().get("osd"))
        finally:
            osd.close()
    with Session(out / "absent", config={"diagnostics": "debug"}) as s:
        s.spawn(1); s.spawn(2)
        s.load(); s.settle()
        area = s.area()
        off = s.kw.mark()
        s.cmd("layout.next")
        s.kw.wait_log(r"on-screen display unavailable", 5, off)
        t_fail = time.monotonic()
        s.cmd("layout.next"); s.cmd("layout.next")  # monocle, floating: inside the 30 s window
        time.sleep(0.8)
        dbg = s.log_lines(r"on-screen display unavailable", off)
        cnt = s.counters()
        c("FR3: no service: one debug line, one request; commands right after send nothing",
          len(dbg) == 1 and cnt.get("osd") == {"state": "failed", "sent": 1, "failures": 0 + 1}, {"debug": dbg, "osd": cnt.get("osd")})
        s.cmd("layout.next")  # back to master-stack
        s.settle()
        f = s.frames()
        c("FR3: tiling is unaffected by the missing service (oracle)", not tiling_errors([f[fx(1)], f[fx(2)]], area, GAP),
          [f[fx(1)]["frame"], f[fx(2)]["frame"]])
        osd = FakeOsd(s, "late")  # plasmashell appears (as after login, or after a restart)
        try:
            s.cmd("layout.next")  # still within 30 s of the failure: dropped
            time.sleep(0.8)
            early = osd.calls()
            wait = 30.5 - (time.monotonic() - t_fail)
            if wait > 0:
                time.sleep(wait)
            s.cmd("layout.next")  # bsp -> monocle, 30 s after the failure: one try, and it arrives
            got = osd.wait(1)
            c("FR3: a command within 30 s of the failure sends nothing; the first one after reaches the service",
              early == [] and [(x["icon"], x["text"]) for x in got] == [("window-maximize", "Monocle layout")],
              {"early": early, "later": got})
            cnt = s.counters()
            c("FR3: the failure streak ended: idle, one failure, two sent", cnt.get("osd") == {"state": "idle", "sent": 2, "failures": 1},
              cnt.get("osd"))
            c("FR3: still one debug line", len(s.log_lines(r"on-screen display unavailable", off)) == 1)
        finally:
            osd.close()


# ----------------------------------------------------------------------------- FR4
@scenario("firstrun-target-visible-FR4")
def target_visible(out: Path, c: Checks):
    with Session(out) as s:
        osd = FakeOsd(s)
        try:
            s.js("workspace.createDesktop(1, 'Two'); emit(1)")
            ds = json.loads(s.js("emit(workspace.desktops.map(d => d.id))")[0])
            D1, D2 = ds[0], ds[1]
            s.spawn(1); s.spawn(2); s.spawn(3)
            s.load(); s.settle()
            OUT = out_name(s)
            area = s.area()
            s.act(fx(3), "workspace.activeWindow = w")
            s.cmd("move.desktop-next")  # fixture 3 to Two; Desktop 1 stays shown
            time.sleep(0.5); s.settle()
            act = json.loads(s.js("emit(workspace.activeWindow ? [workspace.activeWindow.caption, workspace.currentDesktop.id]"
                                  " : null)")[0])
            f = s.frames()
            c("FR4 precondition: the sent window is on Two, still active, while Desktop 1 is shown (measured KWin behaviour)",
              act == [fx(3), D1] and f[fx(3)]["desktops"] == [D2], {"active": act, "desktops": f[fx(3)]["desktops"]})
            off = s.kw.mark()
            s.cmd("layout.monocle")
            time.sleep(0.5); s.settle()
            f = s.frames()
            ctx = contexts(s)
            c("FR4: the layout command changed the desktop on screen (oracle: both Desktop 1 windows fill the area)",
              all(near(f[fx(i)]["frame"], full(area), 1.0) for i in (1, 2)), [f[fx(1)]["frame"], f[fx(2)]["frame"]])
            c("FR4: ... and not the active window's hidden desktop (counters)",
              ctx.get(f"{OUT}/{D1}", {}).get("layout") == "monocle" and ctx.get(f"{OUT}/{D2}", {}).get("layout") == "master-stack",
              {k: v.get("layout") for k, v in ctx.items()})
            notes = [message(x) for x in s.log_lines(r"plastile notice layout ", off)]
            c("FR4: the notice names the desktop on screen", notes == [f"plastile notice layout monocle on {OUT} / Desktop 1 (was master-stack)"],
              notes)
            c("FR4: the OSD says the same", [x["text"] for x in osd.wait(1)] == ["Monocle layout — Desktop 1"], osd.calls())
            s.cmd("context.reset")
            time.sleep(0.5); s.settle()
            f = s.frames()
            ctx = contexts(s)
            c("FR4: reset also targets the desktop on screen (oracle: the pair tiles again)",
              not tiling_errors([f[fx(1)], f[fx(2)]], area, GAP) and ctx.get(f"{OUT}/{D1}", {}).get("layout") == "master-stack",
              {"frames": [f[fx(1)]["frame"], f[fx(2)]["frame"]], "layouts": {k: v.get("layout") for k, v in ctx.items()}})
            # Window commands keep the active window: toggle-float floats fixture 3 on Two.
            s.cmd("window.toggle-float")
            time.sleep(0.4)
            x = explain(s, fx(3))  # activates fixture 3, which switches to Two
            c("FR4: a window command still acts on the active (hidden-desktop) window", x.get("userMode") == "floating",
              {"mode": x.get("mode"), "userMode": x.get("userMode")})
        finally:
            osd.close()


# ----------------------------------------------------------------------------- FR5
@scenario("firstrun-maximized-suspended-FR5")
def maximized_suspended(out: Path, c: Checks):
    with Session(out) as s:
        s.spawn(1); s.spawn(2)
        s.load(); s.settle()
        area = s.area()
        s.act(fx(1), "w.setMaximize(true, true)")
        time.sleep(0.5); s.settle()
        f = s.frames()
        c("FR5 precondition: fixture 1 is maximized (oracle)", f[fx(1)]["maximizeMode"] == 3, f[fx(1)]["maximizeMode"])
        x = explain(s, fx(1))
        want = ("tiling of this window is suspended while it is maximized; it resumes, in the same place, when the window "
                "is restored")
        c("FR5: explain states the suspension plainly; the window is still a member (policy unchanged)",
          x.get("mode") == "tiled" and x.get("suspended") == want, {"mode": x.get("mode"), "suspended": x.get("suspended")})
        cx = list(contexts(s).values())
        c("FR5: counters: members 2, tiled 1, suspended 1", [(k["members"], k["tiled"], k["suspended"]) for k in cx] == [(2, 1, 1)],
          cx)
        f = s.frames()
        c("FR5: the other window tiles alone (oracle)", near(f[fx(2)]["frame"], full(area), 1.0), f[fx(2)]["frame"])
        s.act(fx(1), "w.setMaximize(false, false)")
        time.sleep(0.5); s.settle()
        x = explain(s, fx(1))
        cx = list(contexts(s).values())
        f = s.frames()
        c("FR5: restored: no suspension, both tiled again (explain, counters, oracle)",
          x.get("suspended") is None and [(k["members"], k["tiled"], k["suspended"]) for k in cx] == [(2, 2, 0)]
          and not tiling_errors([f[fx(1)], f[fx(2)]], area, GAP),
          {"suspended": x.get("suspended"), "contexts": cx, "frames": [f[fx(1)]["frame"], f[fx(2)]["frame"]]})


# ----------------------------------------------------------------------------- FR6
@scenario("firstrun-restored-notice-FR6")
def restored_notice(out: Path, c: Checks):
    base = Path(tempfile.mkdtemp(prefix="fr6-", dir=session_base()))
    try:
        with psession(out / "first", base) as s:
            s.spawn(1); s.spawn(2)
            pload(s); s.settle()
            s.cmd("layout.monocle")
            time.sleep(0.3); s.settle()
            off = s.kw.mark()
            s.unload()  # the final save
            s.kw.wait_log(r"plastile (debug|info) state save|plastile notice stopped", 5, off)
            time.sleep(0.5)
        with psession(out / "second", base) as s:  # a KWin restart over the same state
            s.spawn(1); s.spawn(2)
            off = s.kw.mark()
            pload(s); s.settle()
            time.sleep(0.3)
            OUT = out_name(s)
            restored = [message(x) for x in s.log_lines(r"plastile notice restored", off)]
            started = [message(x) for x in s.log_lines(STARTED, off)]
            area = s.area()
            f = s.frames()
            c("FR6: after a KWin restart one notice names the restored layout",
              restored == [f"plastile notice restored saved layout monocle for {OUT} / Desktop 1"], {"restored": restored,
                                                                                                  "started": started})
            c("FR6: ... and it is in effect (oracle: monocle, both fill the area)",
              all(near(f[fx(i)]["frame"], full(area), 1.0) for i in (1, 2)), [f[fx(1)]["frame"], f[fx(2)]["frame"]])
            g1 = generation(base)
            s.cmd("context.reset")
            time.sleep(0.3); s.settle()
            s.unload()
            g2 = wait_generation(s, base, (g1 or 0) + 1)
        snap = newest(base) or {}
        mine = [x for x in snap.get("contexts", []) if x["outputKey"] == OUT and x["desktopId"] == DESKTOP_ID]
        c("FR6: the reset was saved (a newer generation; Desktop 1 has no saved layout)",
          g1 is not None and g2 is not None and g2 > g1 and all(x["layout"] is None for x in mine),
          {"before": g1, "after": g2, "contexts": mine})
        with psession(out / "third", base) as s:
            s.spawn(1); s.spawn(2)
            off = s.kw.mark()
            loaded = message(pload(s)); s.settle()
            time.sleep(0.3)
            restored = s.log_lines(r"plastile notice restored", off)
            # Without this, a session that could not read the state would announce nothing too.
            c("FR6: the third session loaded the state saved after the reset",
              loaded.startswith("plastile info saved state loaded ")
              and json.loads(loaded.split("saved state loaded ", 1)[1]).get("generation") == g2, loaded)
            c("FR6: after a reset nothing is announced (the saved layout is the configured one)", restored == [], restored)
    finally:
        shutil.rmtree(base, ignore_errors=True)
