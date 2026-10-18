"""Float rectangles across outputs (D6) and persisted session preferences (T27; ADR-013, write path ADR-020).

TEST_MATRIX IDs: L08 (float restore), O04/O05 (output changes), Q05 (helper absent, stopped, slow, killed),
Q06 (ambiguous restore), Q07 (partial/invalid state file), Q09 (reload cycles).

Persistence goes through the plastile-state helper (helper/, org.kde.plastile.State): the harness installs
its activation file on each session's private bus, which starts it on Plastile's first request. Geometry is
judged by the oracle (one-shot KWin scripts reading real window state). The state files are read from the
nested session's private XDG_STATE_HOME; Plastile's counters and log lines are used for amounts of work and
its own diagnostics only.
"""
from __future__ import annotations

import ctypes
import re
import json
import os
import select
import signal
import stat
import struct
import threading
import time
from pathlib import Path

from harness import ROOT, STATE_SERVICE, Session, delta, explain, near, tiling_errors, window_info, steady_connections
from scenarios import Checks, Skipped, script_objects, scenario

GAP = 8
ERRORS = r"plastile (error|warn)|TypeError|ReferenceError"
FIXTURES = ROOT / "tests/fixtures/persist"
# A fixed desktop id in the shared kwinrc: KWin generates a new one on every start unless kwinrc
# holds it (kwin v6.7.5 VirtualDesktopManager::load), as a real session's kwinrc does.
DESKTOP_ID = "5c5f0a2e-7a1b-4c3d-9e8f-000000000001"
SOLO = "plastile-solo"


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def area_of(s: Session, output: str) -> dict:
    out = s.js(f"const o = workspace.screens.find(x => x.name === {json.dumps(output)}); const a = workspace.clientArea("
               f"workspace.MaximizeArea, o, workspace.currentDesktopForScreen(o)); emit({{x: a.x, y: a.y, width: a.width,"
               f" height: a.height}});")
    return json.loads(out[0])


def inside(r: dict, a: dict, tol: float = 0.5) -> bool:
    return (r["x"] >= a["x"] - tol and r["y"] >= a["y"] - tol and r["x"] + r["width"] <= a["x"] + a["width"] + tol
            and r["y"] + r["height"] <= a["y"] + a["height"] + tol)


def relocate(r: dict, src: dict, dst: dict) -> dict:
    """Independent restatement of D6's documented rule: the centre keeps its relative position, the size is kept."""
    w, h = min(r["width"], dst["width"]), min(r["height"], dst["height"])
    fx_ = (r["x"] + r["width"] / 2 - src["x"]) / src["width"]
    fy_ = (r["y"] + r["height"] / 2 - src["y"]) / src["height"]
    x = min(max(dst["x"] + fx_ * dst["width"] - w / 2, dst["x"]), dst["x"] + dst["width"] - w)
    y = min(max(dst["y"] + fy_ * dst["height"] - h / 2, dst["y"]), dst["y"] + dst["height"] - h)
    return {"x": x, "y": y, "width": w, "height": h}


def centred(a: dict, frac: float = 0.6) -> dict:
    w, h = round(a["width"] * frac), round(a["height"] * frac)
    return {"x": a["x"] + (a["width"] - w) / 2, "y": a["y"] + (a["height"] - h) / 2, "width": w, "height": h}


def toggle(s: Session, i: int) -> None:
    s.act(fx(i), "workspace.activeWindow = w")
    s.cmd("window.toggle-float")
    time.sleep(0.2)
    s.settle()


# --------------------------------------------------------------------------- D6
@scenario("float-output-D6")
def float_output(out: Path, c: Checks):
    """Float on one output, tile, send to the other output, float again: the window comes back inside the output
    it is on now (proportionally placed), not at the old output's rectangle."""
    facts: dict = {}
    with Session(out, outputs=2) as s:
        s.spawn(1); s.spawn(2)
        s.load(); s.settle()
        a0, a1 = area_of(s, "Virtual-0"), area_of(s, "Virtual-1")
        toggle(s, 2)
        f = s.frames()[fx(2)]
        c("float without a float rectangle: bounded centred default inside Virtual-0 (oracle)",
          f["output"] == "Virtual-0" and near(f["frame"], centred(a0), 1.0), {"frame": f["frame"], "want": centred(a0)})
        s.act(fx(2), "w.frameGeometry = {x: 200, y: 150, width: 500, height: 400}")  # the user places it
        time.sleep(0.3); s.settle()
        placed = s.frames()[fx(2)]["frame"]
        toggle(s, 2)
        c("tile again: back in Virtual-0's tiling (oracle)", not tiling_errors(s.frames_list(), a0, GAP)
          and s.frames()[fx(2)]["output"] == "Virtual-0", tiling_errors(s.frames_list(), a0, GAP))
        s.act(fx(2), "workspace.activeWindow = w")
        s.cmd("move.output-next")
        time.sleep(0.3); s.settle()
        moved = s.frames()[fx(2)]
        c("send to the other output: tiled on Virtual-1 (oracle)", moved["output"] == "Virtual-1"
          and not tiling_errors([moved], a1, GAP), moved)
        toggle(s, 2)
        g = s.frames()[fx(2)]
        want = relocate(placed, a0, a1)
        facts.update({"placedOnVirtual0": placed, "restored": g["frame"], "expected": want, "areas": [a0, a1]})
        c("D6: float again restores inside Virtual-1's work area, still on Virtual-1 (oracle)",
          g["output"] == "Virtual-1" and inside(g["frame"], a1), g)
        c("D6: proportionally placed, same size (oracle vs the documented rule, 1 px)", near(g["frame"], want, 1.0),
          {"got": g["frame"], "want": want})
        c("D6: not the old output's rectangle", not near(g["frame"], placed, 1.0), g["frame"])
        warnings = s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError")
        c("no errors or JS exceptions logged", not warnings, warnings[:5])
    c("facts (recorded, always passes)", True, facts)


# ------------------------------------------------------------------ T27 helpers
IN_ACCESS, IN_MODIFY, IN_ATTRIB, IN_CLOSE_WRITE, IN_CLOSE_NOWRITE, IN_OPEN = 0x1, 0x2, 0x4, 0x8, 0x10, 0x20
IN_MOVED_FROM, IN_MOVED_TO, IN_CREATE, IN_DELETE = 0x40, 0x80, 0x100, 0x200
WRITE_EVENTS = IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_MOVED_FROM | IN_MOVED_TO | IN_CREATE | IN_DELETE
MASK_NAMES = {IN_ACCESS: "access", IN_MODIFY: "modify", IN_ATTRIB: "attrib", IN_CLOSE_WRITE: "close_write",
              IN_CLOSE_NOWRITE: "close_nowrite", IN_OPEN: "open", IN_MOVED_FROM: "moved_from", IN_MOVED_TO: "moved_to",
              IN_CREATE: "create", IN_DELETE: "delete"}


class Inotify:
    """File events in one directory (Linux inotify through libc), stamped with CLOCK_MONOTONIC when read.

    An independent observer of the state directory: every open, read and write KWin makes there shows up,
    whatever Plastile reports about itself."""

    def __init__(self, directory: Path):
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        self.fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1")
        if libc.inotify_add_watch(self.fd, str(directory).encode(), 0xFFF) < 0:
            raise OSError(ctypes.get_errno(), f"inotify_add_watch {directory}")
        self.events: list[tuple[float, int, str]] = []
        self._stop = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop:
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if not ready:
                continue
            t = time.monotonic()
            try:
                buf = os.read(self.fd, 65536)
            except BlockingIOError:
                continue
            i = 0
            while i + 16 <= len(buf):
                _wd, mask, _cookie, ln = struct.unpack_from("iIII", buf, i)
                name = buf[i + 16:i + 16 + ln].split(b"\0", 1)[0].decode(errors="replace")
                self.events.append((t, mask, name))
                i += 16 + ln

    def close(self) -> None:
        self._stop = True
        self._thread.join(1)
        os.close(self.fd)

    def writes(self, since: float = 0) -> list[tuple[float, int, str]]:
        return [e for e in self.events if e[1] & WRITE_EVENTS and e[0] >= since]


def atomic(writes: list[tuple[float, int, str]], name: str) -> bool:
    """Atomic replacement as inotify shows it: the content goes to a temporary file (Qt uses O_TMPFILE, shown as
    `#<inode>`, or a named sibling), which is linked or renamed onto `name`; `name` itself is never modified in place."""
    appeared = any(m & (IN_CREATE | IN_MOVED_TO) and n == name for _, m, n in writes)
    temp = any(m & IN_CLOSE_WRITE and (n.startswith("#") or n.startswith(name + ".")) and not n.endswith(".lock")
               for _, m, n in writes)
    in_place = any(m & IN_MODIFY and n == name for _, m, n in writes)
    return appeared and temp and not in_place


def describe(events: list[tuple[float, int, str]], t0: float = 0) -> list[str]:
    return [f"{e[0] - t0:+.3f}s {'|'.join(n for m, n in MASK_NAMES.items() if e[1] & m)} {e[2]}" for e in events[:40]]


def xdg(base: Path) -> dict:
    """Private XDG state and config directories that outlive one nested session (a KWin restart keeps them)."""
    (base / "state/plastile").mkdir(parents=True, exist_ok=True)
    (base / "config").mkdir(parents=True, exist_ok=True)
    return {"XDG_STATE_HOME": str(base / "state"), "XDG_CONFIG_HOME": str(base / "config")}


def psession(out: Path, base: Path, extra_env: dict | None = None, **kw) -> Session:
    """A session on the private XDG state/config directories `base` (kept across sessions); the helper's
    activation file is installed unless helper=False; helper_env passes test knobs to the helper only."""
    s = Session(out, extra_env={**xdg(base), **(extra_env or {})}, **kw)
    rc = base / "config/kwinrc"
    if not rc.exists():
        rc.write_text(s.kwinrc() + f"\n[Desktops]\nNumber=1\nId_1={DESKTOP_ID}\n\n[org.kde.kdecoration2]\nlibrary=org.kde.breeze\n")
    return s


def slot_path(base: Path, slot: int) -> Path:
    return base / f"state/plastile/state-{slot}.json"


def slot_text(base: Path, slot: int) -> str | None:
    """A slot file's text exactly as the helper stores it (Plastile's snapshot JSON)."""
    p = slot_path(base, slot)
    return p.read_text(errors="replace") if p.exists() else None


def slot_json(base: Path, slot: int) -> dict | None:
    t = slot_text(base, slot)
    try:
        return json.loads(t) if t else None
    except ValueError:
        return None


def newest(base: Path) -> dict | None:
    snaps = [x for x in (slot_json(base, 0), slot_json(base, 1)) if x]
    return max(snaps, key=lambda x: x["generation"]) if snaps else None


def generation(base: Path) -> int | None:
    n = newest(base)
    return n["generation"] if n else None


def write_slot(base: Path, slot: int, text: str) -> None:
    slot_path(base, slot).write_text(text)


def wait_generation(s: Session, base: Path, want: int, timeout: float = 5.0) -> int | None:
    """Wait until the newest slot has generation >= want (the helper writes after Plastile's request)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        g = generation(base)
        if g is not None and g >= want:
            return g
        time.sleep(0.03)
    return generation(base)


LOADED = r"plastile (info|warn) (saved state|no saved state|persistence unavailable)"


def pload(s: Session, timeout: float = 10.0) -> str:
    """Load Plastile and wait for the persistence outcome (the helper's reply or its absence); returns that line."""
    off = s.kw.mark()
    s.load()
    return s.kw.wait_log(LOADED, timeout, off)[-1]


def helper_pid(s: Session) -> int | None:
    return s.kw.bus_pid(STATE_SERVICE)


def kwin_round_trips(s: Session, n: int = 30, seconds: float | None = None) -> list[float]:
    """KWin main-thread responsiveness: round trips (ms) of org.kde.kwin.Scripting.isScriptLoaded, a method that
    KWin's main thread executes, over a persistent connection to the private bus. n samples 10 ms apart, or, with
    `seconds`, samples 10 ms apart for that long (a stall anywhere in the window shows as one long round trip)."""
    conn = s.kw._bus_connection()
    m = conn.get_object("org.kde.KWin", "/Scripting").get_dbus_method("isScriptLoaded", "org.kde.kwin.Scripting")
    out: list[float] = []
    end = time.monotonic() + seconds if seconds is not None else None
    while (len(out) < n) if end is None else (time.monotonic() < end):
        t = time.monotonic()
        m("plastile")
        out.append(round((time.monotonic() - t) * 1000, 3))
        time.sleep(0.01)
    return out


def stall_control(s: Session, ms: int = 400) -> dict:
    """Positive control for kwin_round_trips: a one-shot KWin script busy-loops `ms` on KWin's main thread while a
    second bus connection, in a thread, samples the same round trip. The probe must see that stall, or a quiet
    result while the helper is stopped would prove nothing."""
    import dbus
    conn = dbus.bus.BusConnection(s.kw.bus_address)
    m = conn.get_object("org.kde.KWin", "/Scripting").get_dbus_method("isScriptLoaded", "org.kde.kwin.Scripting")
    samples: list[float] = []
    stop = threading.Event()

    def sample() -> None:
        while not stop.is_set():
            t = time.monotonic()
            m("plastile")
            samples.append(round((time.monotonic() - t) * 1000, 3))
            time.sleep(0.01)
    th = threading.Thread(target=sample, daemon=True)
    th.start()
    time.sleep(0.2)
    s.js(f"const t0 = Date.now(); while (Date.now() - t0 < {ms}) {{}}")
    time.sleep(0.2)
    stop.set()
    th.join(3)
    conn.close()
    return q(samples)


def q(xs: list[float]) -> dict:
    v = sorted(xs)
    return {"n": len(v), "p50": v[len(v) // 2], "p95": v[min(len(v) - 1, int(len(v) * 0.95))], "max": v[-1]} if v else {}


def perms(base: Path) -> dict:
    d = base / "state/plastile"
    return {p.name: oct(stat.S_IMODE(p.stat().st_mode)) for p in [d, *sorted(d.iterdir())]}


def spawn_app(s: Session, ident: int, app: str = SOLO) -> None:
    s.spawn(ident, "--app-id", app, wait=False)
    s.wait_for(lambda: window_info(s, fx(ident), "w.frameGeometry.width") is not None, 5, f"map {fx(ident)}")


def frame_of(s: Session, ident: int) -> dict | None:
    return window_info(s, fx(ident), "({x: w.frameGeometry.x, y: w.frameGeometry.y, width: w.frameGeometry.width,"
                                     " height: w.frameGeometry.height})")


def default_master_width(area: dict, ratio: float) -> float:
    return round((area["width"] - 3 * GAP) * ratio)


def unexpected(s: Session, allowed: str | None = None) -> list[str]:
    return [ln for ln in s.log_lines(ERRORS) if not (allowed and re.search(allowed, ln))]


# --------------------------------------------------------------------- T27
@scenario("persist-reload-restart-T27")
def persist_reload_restart(out: Path, c: Checks):
    """Layout preferences and a float survive an unload/reload and a nested KWin restart with the same private XDG
    state and config directories. The state directory is watched with inotify: no file access happens while commands
    run, and one save follows about 2 s after the last change, written by the helper. After a restart tiling starts
    with defaults and the saved state applies once the helper's reply arrives (ADR-020)."""
    base = out / "xdg"
    facts: dict = {}
    with psession(out / "first", base) as s:
        s.spawn(1); s.spawn(2); s.spawn(3); spawn_app(s, 9)
        pload(s); s.settle()
        area = s.area()
        w0 = s.frames()[fx(1)]["frame"]["width"]
        watch = Inotify(base / "state/plastile")
        try:
            t_first = time.monotonic()
            s.act(fx(1), "workspace.activeWindow = w")
            s.cmd("resize.grow"); s.cmd("resize.grow")
            s.act(fx(9), "workspace.activeWindow = w")
            s.cmd("window.toggle-float")
            time.sleep(0.2); s.settle()
            s.act(fx(9), "w.frameGeometry = {x: 300, y: 200, width: 500, height: 400}")  # the user places the float
            t_last = time.monotonic()
            deadline = t_last + 6
            while time.monotonic() < deadline and not watch.writes():
                time.sleep(0.05)
            time.sleep(0.5)
        finally:
            watch.close()
        early = [e for e in watch.events if e[0] < t_last + 1.5]
        writes = watch.writes()
        first = (writes[0][0] - t_last) if writes else None
        facts["saveEvents"] = describe(watch.events, t_last)
        c("no state-file access while the commands ran or within 1.5 s of the last change (inotify, independent)",
          not early, describe(early, t_first))
        c("one save after the quiet period: first write event 1.5-4 s after the last change (inotify)",
          first is not None and 1.5 <= first <= 4.0, {"secondsAfterLastChange": first})
        c("the save is atomic: written to an unnamed temporary file, which then appears as state-0.json; never written in "
          "place (the helper's QSaveFile; inotify)", atomic(writes, "state-0.json"), describe(writes, t_last))
        # The directory's own entry ("") changes mode once: the helper makes the directory this test created 0700.
        c("only the slot being saved and unnamed temporary files are touched (no lock file)",
          all(n == "state-0.json" or n.startswith("#") or (n == "" and m & IN_ATTRIB and not m & ~(IN_ATTRIB | 0x40000000))
              for _, m, n in writes), sorted({n for _, _, n in writes}))
        facts["permissions"] = perms(base)
        c("the state directory is 0700 and the slot 0600 (helper)",
          facts["permissions"] == {"plastile": "0o700", "state-0.json": "0o600"}, facts["permissions"])
        snap = newest(base)
        ctx = [x for x in (snap or {}).get("contexts", []) if x["outputKey"] == "Virtual-0"]
        fl = [x for x in (snap or {}).get("floats", []) if x["appId"] == SOLO]
        facts["snapshot"] = snap
        c("the snapshot holds the context's ratio 0.65 and the solo window's float (file)",
          snap is not None and snap["generation"] == 1 and len(ctx) == 1 and ctx[0]["desktopId"] == DESKTOP_ID
          and abs(ctx[0]["masterStack"]["ratio"] - 0.65) < 1e-9 and len(fl) == 1
          and near(fl[0]["rect"], {"x": 300, "y": 200, "width": 500, "height": 400}, 1), snap)
        master = s.frames()[fx(1)]["frame"]
        solo = frame_of(s, 9)
        c("precondition: the master column grew by two steps (oracle)",
          abs(master["width"] - default_master_width(area, 0.65)) <= 1 and master["width"] > w0, {"before": w0, "after": master})

        watch = Inotify(base / "state/plastile")
        try:
            s.unload()
            t_reload = time.monotonic()
            pload(s)
            cc = s.settle()
            time.sleep(2.8)  # past the debounce: an unchanged snapshot must not be rewritten
        finally:
            watch.close()
        c("reload: the master column has the saved ratio (oracle)", near(s.frames()[fx(1)]["frame"], master, 1),
          {"want": master, "got": s.frames()[fx(1)]["frame"]})
        c("reload: the solo window floats at its saved rectangle (oracle)", near(frame_of(s, 9) or {}, solo, 1)
          and explain(s, fx(9))["mode"] == "floating", {"want": solo, "got": frame_of(s, 9)})
        c("reload: one float restored, none ambiguous (counters)", cc["counters"]["restored"] == 1
          and cc["counters"]["restoreAmbiguous"] == 0, cc["counters"])
        c("reload without changes writes nothing: unload had nothing dirty, the restored content is unchanged (inotify)",
          not watch.writes(), describe(watch.writes(), t_reload))
        c("no errors or JS exceptions logged (first session)", not unexpected(s), unexpected(s)[:5])
        facts["persistence"] = s.counters()["persistence"]
        facts["hold"] = {"firstLoad (activates the helper)": holds(s)[0:1], "reload (helper running)": holds(s)[1:]}
        c("start-up hold (first session): released by the helper's reply at the first load and at the reload (log)",
          [h.get("by") for h in holds(s)] == ["reply", "reply"], holds(s))
    # A KWin restart: a new compositor process, the same XDG state and config directories.
    with psession(out / "second", base) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        pload(s); s.settle()
        loaded = s.log_lines(r"plastile info saved state loaded")
        c("restart: saved state loaded once (log)", len(loaded) == 1, s.log_lines(r"plastile info saved state"))
        started = s.log_lines(r"plastile notice started ")
        stamp = lambda ln: float(ln.split()[0])  # noqa: E731  QT_MESSAGE_PATTERN %{time boot}, seconds
        if loaded and started:
            facts["restartReplyAfterStartMs"] = round((stamp(loaded[0]) - stamp(started[0])) * 1000, 1)
        c("restart: the master column has the saved ratio once the helper replied (oracle)",
          near(s.frames()[fx(1)]["frame"], master, 1), {"want": master, "got": s.frames()[fx(1)]["frame"],
                                                        "replyAfterStartMs": facts.get("restartReplyAfterStartMs")})
        spawn_app(s, 9)  # the application starts after Plastile: restored when it maps
        time.sleep(0.3)
        s.settle()
        got = frame_of(s, 9)
        c("restart: the solo window, opened after the script started, floats at its saved rectangle (oracle)",
          near(got or {}, solo, 1) and explain(s, fx(9))["mode"] == "floating", {"want": solo, "got": got})
        c("restart: the other windows tile beside it (oracle)", not tiling_errors(s.frames_list(), s.area(), GAP),
          tiling_errors(s.frames_list(), s.area(), GAP))
        c("no errors or JS exceptions logged (restart)", not unexpected(s), unexpected(s)[:5])
        facts["hold"]["restart (a new bus: activates the helper)"] = holds(s)
        c("start-up hold (restart): released by the helper's reply (log)", [h.get("by") for h in holds(s)] == ["reply"],
          holds(s))
    c("facts (recorded, always passes)", True, facts)


def holds(s: Session) -> list[dict]:
    """Each start-up hold's release this session, from Plastile's log: by what, after how long (ADR-020 addendum)."""
    return [json.loads(ln.split("released ", 1)[1]) for ln in s.log_lines(r"plastile info start-up hold released")]


# ------------------------------------------------------------- T27: KWin exits
def master_ratio(snap: dict | None) -> float | None:
    return next((x["masterStack"]["ratio"] for x in (snap or {}).get("contexts", []) if x["outputKey"] == "Virtual-0"
                 and x.get("masterStack")), None)


@scenario("persist-kwin-exit-T27")
def persist_kwin_exit(out: Path, c: Checks):
    """KWin itself exits (SIGTERM, the signal a session manager sends at logout) while a change is still inside the
    2 s debounce: Plastile's teardown sends the final Write and the helper stores it after KWin is gone. Three times
    with the default idle period, three times with a short one (test knob PLASTILE_STATE_TEST_IDLE_MS, 300 ms) that
    elapses long before the exit: the helper must still be running then, because it never exits while KWin is on the
    bus (a final Write that had to activate a new helper as KWin disconnects was lost in 2 of 3 CI runs). A nested
    approximation of a logout: the private bus stays up, which a real session's bus and service manager need not do."""
    trials = []
    for mode in ("running", "short-idle"):
        for i in range(3):
            base = out / f"{mode}-{i}/xdg"
            env = {"PLASTILE_STATE_TEST_IDLE_MS": "300"} if mode == "short-idle" else None
            s = psession(out / f"{mode}-{i}/s", base, helper_env=env)
            with s:
                s.spawn(1); s.spawn(2)
                pload(s); s.settle()
                s.act(fx(1), "workspace.activeWindow = w")
                s.cmd("resize.grow")  # 0.55 -> 0.6, saved by the deadline
                g1 = wait_generation(s, base, 1, 6)
                if mode == "short-idle":
                    time.sleep(1.0)  # more than three idle periods with KWin, its caller, still connected
                had_helper = helper_pid(s) is not None
                t_cmd = time.monotonic()
                s.cmd("resize.grow")  # 0.6 -> 0.65, still inside the debounce at exit
                time.sleep(0.15)
                t_term = time.monotonic()
                rc = s.kw.terminate_kwin()
                s.loaded = False  # KWin is gone: nothing to unload
                for f in s.fixtures.values():  # the clients lost their compositor; drop their pipes quietly
                    try:
                        f.proc.stdin.close()
                    except OSError:
                        pass
                s.fixtures.clear()
                g2 = wait_generation(s, base, 2, 5)
                stops = [float(ln.split()[0]) for ln in s.log_lines(r"plastile notice stopped")]
                trials.append({"mode": mode, "helperRunningAtExit": had_helper, "firstSave": g1, "kwinExit": rc,
                               "termAfterCommandS": round(t_term - t_cmd, 3),
                               # QT_MESSAGE_PATTERN %{time boot} is CLOCK_MONOTONIC, as time.monotonic()
                               "teardownAfterCommandS": [round(t - t_cmd, 3) for t in stops],
                               "generationAfterExit": g2, "ratio": master_ratio(newest(base)),
                               "errors": unexpected(s)[:3]})
    for mode in ("running", "short-idle"):
        ts = [t for t in trials if t["mode"] == mode]
        c(f"({mode}): the first save landed and the helper was still running at exit (it stays while KWin is on the bus)",
          all(t["firstSave"] == 1 and t["helperRunningAtExit"] for t in ts), ts)
        c(f"KWin exit ({mode}): Plastile's teardown ran before the 2 s deadline could fire (log, under 1.5 s after the "
          "change)", all(len(t["teardownAfterCommandS"]) == 1 and t["teardownAfterCommandS"][0] < 1.5 for t in ts),
          [t["teardownAfterCommandS"] for t in ts])
        c(f"KWin exit ({mode}): 3 of 3 final Writes reached the helper after KWin exited (generation 2, ratio 0.65; "
          "file)", all(t["generationAfterExit"] == 2 and t["ratio"] is not None and abs(t["ratio"] - 0.65) < 1e-9
                       for t in ts), [(t["generationAfterExit"], t["ratio"]) for t in ts])
    c("no errors or JS exceptions logged", not any(t["errors"] for t in trials), [t["errors"] for t in trials])
    c("facts (recorded, always passes)", True, trials)


# --------------------------------------------------------------------- Q06
@scenario("persist-ambiguous-Q06")
def persist_ambiguous(out: Path, c: Checks):
    """A saved float for an application with two live windows, neither of them the window it was taken from, is not
    given to either: both get ordinary insertion. With one window again it is restored (positive control).

    Each saved float also names the window it was taken from, a same-session hint (ADR-020 addendum): while that
    window is still open it is the one the user floated, so the first reload (a second instance opened while
    Plastile was disabled) restores the float to it alone. The ambiguity rule is checked after that window closed,
    when the hint names no live window."""
    base = out / "xdg"
    with psession(out / "s", base) as s:
        s.spawn(1); spawn_app(s, 9)
        pload(s); s.settle()
        s.act(fx(9), "workspace.activeWindow = w")
        s.cmd("window.toggle-float")
        time.sleep(0.2); s.settle()
        s.act(fx(9), "w.frameGeometry = {x: 260, y: 180, width: 480, height: 360}")
        time.sleep(2.8)
        saved = frame_of(s, 9)
        snap = newest(base)
        id9 = window_info(s, fx(9), "String(w.internalId)")
        c("precondition: the float is saved with the window it was taken from (file)",
          bool(snap) and any(f["appId"] == SOLO and f["windowHint"] == id9 for f in snap["floats"]),
          {"snapshot": snap, "id9": id9})
        s.unload()
        spawn_app(s, 10)  # a second instance of the same application
        pload(s); cc = s.settle()
        modes = {i: explain(s, fx(i))["mode"] for i in (9, 10)}
        frames = [{"caption": fx(i), "frame": frame_of(s, i)} for i in (1, 10)]
        c("same window: the float goes to the window it was taken from (9), at its rectangle; the second instance tiles "
          "(explain + oracle)", modes == {9: "floating", 10: "tiled"} and near(frame_of(s, 9) or {}, saved, 1)
          and not tiling_errors(frames, s.area(), GAP),
          {"modes": modes, "frame9": frame_of(s, 9), "want": saved, "errors": tiling_errors(frames, s.area(), GAP)})
        c("same window: one float restored, none ambiguous (counters)", cc["counters"]["restored"] == 1
          and cc["counters"]["restoreAmbiguous"] == 0, cc["counters"])
        s.unload()
        s.kill(9, wait=False)  # the window the float was taken from closes while Plastile is disabled
        s.wait_for(lambda: frame_of(s, 9) is None, 5, "unmap fixture 9")
        spawn_app(s, 11)  # two instances again, neither the hinted window
        pload(s); cc = s.settle()
        modes = {i: explain(s, fx(i))["mode"] for i in (10, 11)}
        frames = [{"caption": fx(i), "frame": frame_of(s, i)} for i in (1, 10, 11)]
        c("Q06: two live windows of the application, neither the hinted one: neither gets the saved float, both tile "
          "(explain + oracle)", modes == {10: "tiled", 11: "tiled"} and not tiling_errors(frames, s.area(), GAP),
          {"modes": modes, "errors": tiling_errors(frames, s.area(), GAP)})
        c("Q06: counted as ambiguous, nothing restored (counters)", cc["counters"]["restored"] == 0
          and cc["counters"]["restoreAmbiguous"] >= 1, cc["counters"])
        s.unload()
        c("Q06: the saved float is kept for later, not dropped (file)",
          any(f["appId"] == SOLO for f in (newest(base) or {}).get("floats", [])), newest(base))
        s.kill(11, wait=False)
        s.wait_for(lambda: frame_of(s, 11) is None, 5, "unmap fixture 11")
        pload(s); cc = s.settle()
        c("positive control: with one window again the float is restored by application identity (oracle)",
          near(frame_of(s, 10) or {}, saved, 1) and explain(s, fx(10))["mode"] == "floating" and cc["counters"]["restored"] == 1,
          {"want": saved, "got": frame_of(s, 10), "counters": cc["counters"]})
        s.kill(10, wait=False)
        s.wait_for(lambda: frame_of(s, 10) is None, 5, "unmap fixture 10")
        spawn_app(s, 12)  # the application opened again in the same session
        time.sleep(0.3)
        s.settle()
        c("same session: the application's next window floats at the saved rectangle (oracle)",
          near(frame_of(s, 12) or {}, saved, 1) and explain(s, fx(12))["mode"] == "floating",
          {"want": saved, "got": frame_of(s, 12)})
        c("no errors or JS exceptions logged", not unexpected(s), unexpected(s)[:5])


# --------------------------------------------------------------------- Q07
@scenario("persist-damaged-Q07")
def persist_damaged(out: Path, c: Checks):
    """Damaged, torn and newer-schema state files: defaults (or the other valid slot) and exactly one diagnostic."""
    partial = (FIXTURES / "partial.json").read_text()
    facts: dict = {}
    # (a) binary garbage in slot 0 (the helper hands it over with U+FFFD for the bytes that are not UTF-8) and an
    # invalid snapshot in slot 1: defaults; the next save goes into slot 0.
    base = out / "a"
    xdg(base)
    slot_path(base, 0).write_bytes(b"\x00\xff\xfe garbage {\"schemaVersion\": 1, oops\n")
    write_slot(base, 1, (FIXTURES / "invalid.json").read_text().strip())
    with psession(out / "a/s", base) as s:
        s.spawn(1); s.spawn(2)
        pload(s); s.settle()
        area = s.area()
        diag = s.log_lines(r"plastile warn saved state rejected")
        w = s.frames()[fx(1)]["frame"]["width"]
        facts["a.diagnostic"] = diag
        c("Q07 garbage + invalid: defaults (master column at the default ratio, oracle)",
          abs(w - default_master_width(area, 0.55)) <= 1 and not tiling_errors(s.frames_list(), area, GAP), w)
        c("Q07 garbage + invalid: exactly one diagnostic, naming the damaged slot, the invalid field, and no other warning",
          len(diag) == 1 and "slot 0: not valid JSON" in diag[0] and "slot 1: contexts[0].masterStack.ratio" in diag[0]
          and "using defaults" in diag[0]
          and not unexpected(s, r"saved state rejected"), {"diag": diag, "other": unexpected(s, r"saved state rejected")})
        s.act(fx(1), "workspace.activeWindow = w")
        s.cmd("resize.grow")
        time.sleep(2.8)
        snap0 = slot_json(base, 0)
        c("Q07: the next save writes a valid snapshot into slot 0 (file)", bool(snap0) and snap0["generation"] == 1, snap0)
        s.unload(); pload(s); s.settle()
        c("Q07: after that save the next load uses it (ratio 0.6, oracle) and reports slot 1 only",
          abs(s.frames()[fx(1)]["frame"]["width"] - default_master_width(area, 0.6)) <= 1
          and "using slot 0 (generation 1)" in (s.log_lines(r"plastile warn saved state rejected") or [""])[-1],
          s.log_lines(r"plastile warn saved state rejected"))
    # (b) a valid slot 0 (fixture v1: ratio 0.65, generation 7) and a torn slot 1: slot 0 is used.
    base = out / "b"
    xdg(base)
    write_slot(base, 0, (FIXTURES / "v1.json").read_text().strip())
    write_slot(base, 1, partial)
    with psession(out / "b/s", base) as s:
        s.spawn(1); s.spawn(2)
        pload(s); s.settle()
        area = s.area()
        diag = s.log_lines(r"plastile warn saved state rejected")
        w = s.frames()[fx(1)]["frame"]["width"]
        facts["b.diagnostic"] = diag
        c("Q07 torn newest slot: the previous valid snapshot applies (ratio 0.65, oracle)",
          abs(w - default_master_width(area, 0.65)) <= 1, {"width": w, "want": default_master_width(area, 0.65)})
        c("Q07 torn newest slot: one diagnostic naming slot 1 and the slot used",
          len(diag) == 1 and "slot 1: not valid JSON" in diag[0] and "using slot 0 (generation 7)" in diag[0], diag)
    # (c) a newer schema: defaults, one diagnostic, and the file is left exactly as it was.
    base = out / "c"
    xdg(base)
    write_slot(base, 0, (FIXTURES / "future.json").read_text().strip())
    before = slot_path(base, 0).read_bytes()
    with psession(out / "c/s", base) as s:
        s.spawn(1); s.spawn(2)
        pload(s); s.settle()
        area = s.area()
        diag = s.log_lines(r"plastile warn saved state rejected")
        w = s.frames()[fx(1)]["frame"]["width"]
        facts["c.diagnostic"] = diag
        c("Q07 newer schema: defaults (oracle)", abs(w - default_master_width(area, 0.55)) <= 1, w)
        c("Q07 newer schema: one diagnostic saying nothing is saved", len(diag) == 1 and "newer" in diag[0]
          and "nothing is saved this session" in diag[0], diag)
        s.act(fx(1), "workspace.activeWindow = w")
        s.cmd("resize.grow")
        time.sleep(2.8)
        s.unload()
        c("Q07 newer schema: its file is untouched and no other slot is written, also at unload (file)",
          slot_path(base, 0).read_bytes() == before and not slot_path(base, 1).exists(),
          sorted(p.name for p in (base / "state/plastile").iterdir()))
    c("facts (recorded, always passes)", True, facts)


# --------------------------------------------------------------------- Q05
def master_width(s: Session, output: str) -> float | None:
    """Width of the leftmost tiled fixture on `output` (the master column in master/stack; oracle)."""
    fs = [f for f in s.frames_list() if f["output"] == output]
    return min(fs, key=lambda f: f["frame"]["x"])["frame"]["width"] if fs else None


@scenario("persist-no-helper-Q05")
def persist_no_helper(out: Path, c: Checks):
    """Script-only install: no helper activation file on the bus. Plastile tiles at once, reports once, keeps its
    preferences in memory and writes nothing; the bus answers ServiceUnknown and nothing is asked again."""
    # The private bus also reads the system's service directories: a helper installed system-wide would answer.
    dirs = {*os.environ.get("XDG_DATA_DIRS", "").split(":"), "/usr/local/share", "/usr/share"} - {""}
    system = [str(p) for d in sorted(dirs) if (p := Path(d) / "dbus-1/services" / f"{STATE_SERVICE}.service").exists()]
    if system:
        raise Skipped(f"Q05: the helper is installed system-wide here ({system[0]}), so no bus lacks it")
    base = out / "xdg"
    with psession(out / "s", base, helper=False) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        pload(s); s.settle()
        area = s.area()
        diag = s.log_lines(r"plastile warn persistence unavailable")
        c("Q05: tiles without persistence (oracle)", not tiling_errors(s.frames_list(), area, GAP),
          tiling_errors(s.frames_list(), area, GAP))
        c("Q05: one diagnostic naming the missing helper", len(diag) == 1 and STATE_SERVICE in diag[0], diag)
        w0 = s.frames()[fx(1)]["frame"]["width"]
        s.act(fx(1), "workspace.activeWindow = w")
        a = s.counters()
        s.cmd("resize.grow")
        time.sleep(0.3)
        b = s.settle()
        c("Q05: commands work (one grow step moves the master edge, oracle)", s.frames()[fx(1)]["frame"]["width"] > w0
          and delta(a, b).get("commands", 0) == 1, {"before": w0, "after": s.frames()[fx(1)]["frame"]["width"]})
        c("Q05: persistence reports in-memory operation, no write issued (counters)",
          b["persistence"]["state"] == "memory" and b["persistence"]["issued"] == 0, b["persistence"])
        time.sleep(2.6)
        s.unload()
        files = sorted(p.name for p in (base / "state/plastile").iterdir())
        c("Q05: nothing written to the state directory, also at unload (file)", files == [], files)
        c("Q05: no other warning or JS exception", not unexpected(s, r"persistence unavailable"),
          unexpected(s, r"persistence unavailable")[:5])


@scenario("persist-helper-stopped-Q05")
def persist_helper_stopped(out: Path, c: Checks):
    """The helper is stopped (SIGSTOP) while saves come due: KWin's main thread keeps answering at its normal
    latency, commands complete, one Write waits in flight and nothing else is sent, and the saves land after
    SIGCONT. Then the helper is killed: the next save starts a new one through D-Bus activation (Q05: helper dies,
    runtime continues). Before ADR-020 a save blocked the compositor thread for 30 s on a held lock."""
    base = out / "xdg"
    facts: dict = {}
    with psession(out / "s", base) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        pload(s); s.settle()
        area = s.area()
        s.act(fx(1), "workspace.activeWindow = w")
        s.cmd("resize.grow")  # 0.55 -> 0.6
        g1 = wait_generation(s, base, 1, 6)
        pid = helper_pid(s)
        c("precondition: a first save landed and the helper owns its bus name", g1 == 1 and pid is not None,
          {"generation": g1, "pid": pid})
        facts["baselineRoundTripMs"] = q(kwin_round_trips(s))
        facts["controlStallRoundTripMs"] = stall_control(s, 400)
        c("control: the round-trip probe sees a 400 ms stall of KWin's main thread (a busy one-shot script; max >= 300 ms)",
          facts["controlStallRoundTripMs"].get("max", 0) >= 300, facts["controlStallRoundTripMs"])
        watch = Inotify(base / "state/plastile")
        os.kill(pid, signal.SIGSTOP)
        t_stop = time.monotonic()
        try:
            s.cmd("resize.grow")  # 0.6 -> 0.65: its save comes due 2 s later and waits for the stopped helper
            # Sampled continuously across the moment the save is issued (2 s after the change): a save that
            # blocked KWin's thread, even briefly, would show here as one long round trip.
            due_rt = kwin_round_trips(s, seconds=2.6)
            inflight = s.counters()["persistence"]
            stopped_rt = kwin_round_trips(s)
            widths = []
            prev = master_width(s, "Virtual-0")
            for cmd in ("resize.shrink", "resize.grow", "resize.grow"):  # 0.6, 0.65, 0.7
                t = time.monotonic()
                s.cmd(cmd)
                s.wait_for(lambda: master_width(s, "Virtual-0") != prev, 3, f"{cmd} visible while the helper is stopped")
                prev = master_width(s, "Virtual-0")
                widths.append(prev)
                facts.setdefault("commandToOracleMs", []).append(round((time.monotonic() - t) * 1000, 1))
            time.sleep(2.6)  # the later changes' quiet period passes too
            still = s.counters()["persistence"]
            stopped_for = time.monotonic() - t_stop
            early = watch.writes()
        finally:
            os.kill(pid, signal.SIGCONT)
        t_cont = time.monotonic()
        g3 = wait_generation(s, base, 3, 6)
        time.sleep(0.3)
        watch.close()
        facts.update({"dueRoundTripMs": q(due_rt), "stoppedRoundTripMs": q(stopped_rt), "stoppedSeconds": round(stopped_for, 1), "inflight": inflight,
                      "afterLaterChanges": still, "widths": widths, "events": describe(watch.events, t_cont)})
        bq, sq, dq = facts["baselineRoundTripMs"], facts["stoppedRoundTripMs"], facts["dueRoundTripMs"]
        c("Q05: KWin's main thread keeps answering while the save to the stopped helper comes due and is issued "
          "(round trips every 10 ms for 2.6 s: p50 within baseline + 5 ms, max < 250 ms)",
          dq.get("n", 0) >= 50 and dq["p50"] <= bq["p50"] + 5 and dq["max"] < 250, {"baseline": bq, "acrossDue": dq})
        c("Q05: KWin's main thread answers at its normal latency while the helper is stopped (D-Bus round trip p50 within "
          "baseline + 5 ms, max < 250 ms)", sq["p50"] <= bq["p50"] + 5 and sq["max"] < 250, {"baseline": bq, "stopped": sq})
        c("Q05: commands complete while the helper is stopped (each grow/shrink visible in the oracle within 3 s)",
          len(widths) == 3 and all(abs(w - default_master_width(area, r)) <= 1 for w, r in zip(widths, (0.6, 0.65, 0.7))),
          {"widths": widths, "ms": facts.get("commandToOracleMs")})
        c("Q05: the due save is one Write in flight; later changes send nothing more while it waits (counters)",
          inflight["inflight"] and inflight["issued"] == 2 and still["inflight"] and still["issued"] == 2
          and still["writes"] == 1, {"first": inflight, "later": still})
        c("Q05: nothing reaches the state directory while the helper is stopped (inotify)", not early,
          describe(early, t_stop))
        snap = newest(base)
        ratio = next((x["masterStack"]["ratio"] for x in (snap or {}).get("contexts", []) if x["outputKey"] == "Virtual-0"),
                     None)
        c("Q05: after SIGCONT the waiting save lands, then one more with the later changes (generation 3, ratio 0.7)",
          g3 == 3 and ratio is not None and abs(ratio - 0.7) < 1e-9, {"generation": g3, "ratio": ratio})
        # The helper dies: the next save starts a new one.
        os.kill(pid, signal.SIGKILL)
        s.wait_for(lambda: helper_pid(s) is None, 5, "the killed helper's bus name released")
        s.cmd("resize.shrink")  # 0.7 -> 0.65
        g4 = wait_generation(s, base, 4, 6)
        pid2 = helper_pid(s)
        snap = newest(base)
        ratio = next((x["masterStack"]["ratio"] for x in (snap or {}).get("contexts", []) if x["outputKey"] == "Virtual-0"),
                     None)
        c("Q05: after the helper was killed the next save activates a new helper and lands (generation 4, ratio 0.65)",
          g4 == 4 and pid2 is not None and pid2 != pid and ratio is not None and abs(ratio - 0.65) < 1e-9,
          {"generation": g4, "pid": [pid, pid2], "ratio": ratio})
        c("no errors or JS exceptions logged", not unexpected(s), unexpected(s)[:5])
        facts["persistence"] = s.counters()["persistence"]
    c("facts (recorded, always passes)", True, facts)


def seed(base: Path, generation: int, ratios: dict[str, float]) -> None:
    xdg(base)
    write_slot(base, 0, json.dumps({
        "schemaVersion": 1, "generation": generation, "savedAt": "2026-10-18T00:00:00.000Z",
        "contexts": [{"outputKey": o, "desktopId": DESKTOP_ID, "activity": "default", "layout": None,
                      "masterStack": {"ratio": r, "masterCount": 1}} for o, r in ratios.items()],
        "floats": []}, separators=(",", ":")))


@scenario("persist-helper-delayed-Q05")
def persist_helper_delayed(out: Path, c: Checks):
    """A slow helper (test knob PLASTILE_STATE_TEST_DELAY_MS=4000: every request waits 4 s). Load: tiling starts with
    defaults once the start-up hold's 250 ms deadline passes (ADR-020 addendum), the saved preferences apply once
    when the reply arrives, and a change the user made before it wins. The seeded slot is schema version 1, so it
    is also loaded through the 1 -> 2 migration. Saves: the delayed Write replies do not slow KWin's main thread or commands, and the files end up with the
    latest preferences."""
    base = out / "xdg"
    seed(base, 4, {"Virtual-0": 0.65, "Virtual-1": 0.7})
    facts: dict = {}
    with psession(out / "s", base, outputs=2, helper_env={"PLASTILE_STATE_TEST_DELAY_MS": "4000"}) as s:
        for i in (1, 2, 3, 4):
            s.spawn(i)
        for i in (3, 4):
            s.act(fx(i), "workspace.sendClientToScreen(w, workspace.screens[1])")
        a0, a1 = s.area(0), s.area(1)
        off = s.kw.mark()
        s.load()
        t_start = time.monotonic()
        s.settle()
        early = {"Virtual-0": master_width(s, "Virtual-0"), "Virtual-1": master_width(s, "Virtual-1")}
        before_reply = not s.log_lines(LOADED, off)
        c("load: tiling starts with defaults before the slow reply (ratio 0.55 on both outputs, oracle)",
          before_reply and abs(early["Virtual-0"] - default_master_width(a0, 0.55)) <= 1
          and abs(early["Virtual-1"] - default_master_width(a1, 0.55)) <= 1,
          {"widths": early, "replyAlreadyIn": not before_reply, "secondsSinceStart": round(time.monotonic() - t_start, 2)})
        held = s.log_lines(r"plastile info start-up hold released", off)
        hold = json.loads(held[0].split("released ", 1)[1]) if held else {}
        facts["hold"] = hold
        c("load: the first solve waited for the reply only up to the start-up hold's 250 ms deadline (log: released "
          "once, by the deadline, 150-600 ms after the load request: a QML Timer, observed firing at 214 ms)",
          len(held) == 1 and hold.get("by") == "deadline" and 150 <= hold.get("heldMs", 0) <= 600, held)
        s.act(fx(3), "workspace.activeWindow = w")
        s.cmd("resize.grow")  # the user's change on Virtual-1 before the reply: 0.55 -> 0.6
        s.wait_for(lambda: abs(master_width(s, "Virtual-1") - default_master_width(a1, 0.6)) <= 1, 3, "grow on Virtual-1")
        c("precondition: the user's change was made before the reply arrived",
          not s.log_lines(LOADED, off), {"secondsSinceStart": round(time.monotonic() - t_start, 2)})
        pending_rt = kwin_round_trips(s, 20)
        line = s.kw.wait_log(LOADED, 10, off)
        t_reply = time.monotonic()
        s.settle()
        facts.update({"replyAfterStartS": round(t_reply - t_start, 2), "loadPendingRoundTripMs": q(pending_rt),
                      "reply": line})
        c("load: the saved state arrives once, about 4 s after the start (log)",
          len(line) == 1 and "saved state loaded" in line[0] and t_reply - t_start >= 3.0,
          {"lines": line, "seconds": facts["replyAfterStartS"]})
        late = {"Virtual-0": master_width(s, "Virtual-0"), "Virtual-1": master_width(s, "Virtual-1")}
        c("load: the saved ratio applies to the untouched output (Virtual-0 0.65, oracle)",
          abs(late["Virtual-0"] - default_master_width(a0, 0.65)) <= 1, late)
        c("load: the user's change made before the reply wins (Virtual-1 stays 0.6, not the saved 0.7, oracle)",
          abs(late["Virtual-1"] - default_master_width(a1, 0.6)) <= 1, late)
        c("load: both outputs still tile correctly (oracle)",
          not tiling_errors([f for f in s.frames_list() if f["output"] == "Virtual-0"], a0, GAP)
          and not tiling_errors([f for f in s.frames_list() if f["output"] == "Virtual-1"], a1, GAP),
          [tiling_errors([f for f in s.frames_list() if f["output"] == o], a, GAP) for o, a in (("Virtual-0", a0), ("Virtual-1", a1))])
        # The user's earlier change is saved after the reply (a quiet period after it); its reply takes 4 s more.
        s.wait_for(lambda: s.counters()["persistence"]["inflight"], 5, "the first save in flight")
        t_issue = time.monotonic()
        saving_rt = kwin_round_trips(s, 20)
        s.act(fx(3), "workspace.activeWindow = w")
        t = time.monotonic()
        s.cmd("resize.grow")  # 0.6 -> 0.65 while the first save waits
        s.wait_for(lambda: abs(master_width(s, "Virtual-1") - default_master_width(a1, 0.65)) <= 1, 3, "grow while saving")
        cmd_ms = round((time.monotonic() - t) * 1000, 1)
        g = wait_generation(s, base, 6, 16)
        facts.update({"savingRoundTripMs": q(saving_rt), "commandToOracleMsWhileSaving": cmd_ms,
                      "secondsIssueToGeneration6": round(time.monotonic() - t_issue, 1)})
        snap = newest(base)
        ratios = {x["outputKey"]: x["masterStack"]["ratio"] for x in (snap or {}).get("contexts", []) if x["masterStack"]}
        c("saves: the delayed writes land in order, the last one with the latest preferences (generation 6: Virtual-0 "
          "0.65, Virtual-1 0.65; file)", g == 6 and abs(ratios.get("Virtual-0", 0) - 0.65) < 1e-9
          and abs(ratios.get("Virtual-1", 0) - 0.65) < 1e-9, {"generation": g, "ratios": ratios})
        lq, sq = facts["loadPendingRoundTripMs"], facts["savingRoundTripMs"]
        c("KWin's main thread answers normally while a load or a save waits for the slow helper (D-Bus round trip max "
          "< 250 ms)", lq["max"] < 250 and sq["max"] < 250, {"loadPending": lq, "saving": sq})
        c("no errors or JS exceptions logged", not unexpected(s), unexpected(s)[:5])
    c("facts (recorded, always passes)", True, facts)


# --------------------------------------------------------------------- Q09
def fd_count(s: Session) -> int | None:
    # A kwin_wayland with file capabilities (Arch: cap_sys_nice=ep) is non-dumpable, so its
    # /proc/<pid>/fd is unreadable even to the same user; report "not measurable", not zero.
    try:
        return len(os.listdir(f"/proc/{s.kw.kwin_pid}/fd"))
    except PermissionError:
        return None


@scenario("persist-reload-cycles-Q09")
def persist_reload_cycles(out: Path, c: Checks):
    """20 unload/reload cycles with unsaved changes: each unload saves exactly once (no timer of an unloaded runtime
    fires later), and connection, window, file-descriptor and script-object counts stay flat."""
    cycles = 20
    base = out / "xdg"
    facts: dict = {}
    with psession(out / "s", base) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        pload(s); first = s.settle()
        fds, rss, gens, errors = [], [], [], []
        parts = [s.kw.kwin_rss_parts_kib()]
        g0 = generation(base) or 0
        watch = Inotify(base / "state/plastile")
        for i in range(cycles):
            s.act(fx(1), "workspace.activeWindow = w")
            s.cmd("resize.grow" if i % 2 == 0 else "resize.shrink")  # unsaved at unload (the debounce is 2 s)
            time.sleep(0.15)
            s.unload()
            # The final Write is sent while the script unloads; the helper stores it a moment later.
            gens.append(wait_generation(s, base, g0 + i + 1, 5.0))
            pload(s)
            cc = s.settle()
            if steady_connections(cc) != steady_connections(first) or cc["windows"] != first["windows"]:
                errors.append((i, cc["connections"], cc.get("transientConnections"), cc["windows"],
                               first["connections"], first.get("transientConnections")))
            fds.append(fd_count(s))
            rss.append(s.kw.kwin_rss_kib())
        parts.append(s.kw.kwin_rss_parts_kib())
        time.sleep(2.8)
        watch.close()
        g_end = generation(base)
        objects = script_objects(s)
        writes = watch.writes()
        facts.update({"generations": gens, "fds": fds, "rssKiB": rss, "scriptObjects": objects,
                      "firstSaveEvents": describe(writes[:12])})
        c("Q09: every save replaces its slot atomically, also when overwriting (no in-place write; inotify)",
          atomic(writes, "state-0.json") and atomic(writes, "state-1.json")
          and sum(1 for _, m, n in writes if m & IN_MOVED_TO and n.startswith("state-")) >= cycles - 2,
          describe(writes)[:20])
        c(f"Q09: each of {cycles} unloads saved exactly once: the Write sent during unload is delivered (generation +1 "
          "per cycle, file)",
          gens == list(range(g0 + 1, g0 + cycles + 1)), gens)
        c("Q09: no late save from an unloaded runtime's timer (generation unchanged 2.8 s after the last reload)",
          g_end == gens[-1], {"last": gens[-1], "after": g_end})
        c(f"Q09: {cycles} reloads: connection/window counts stable (runtime's own counters)", not errors, errors)
        if None in fds:
            c("Q09: KWin file descriptors flat across the reloads: NOT MEASURABLE here (/proc/<pid>/fd unreadable, "
              "non-dumpable kwin_wayland); covered by the counter, object and RSS checks", True, {"fds": "unreadable"})
        else:
            c("Q09: KWin file descriptors flat across the reloads (/proc, independent; +-2)", max(fds) - min(fds) <= 2, fds)
        c("Q09: exactly one Plastile script object after the reloads (independent)", len(objects) == 1, objects)
        grow = rss[-1] - rss[0] if None not in (rss[0], rss[-1]) else None
        c("Q09: KWin RSS bounded across the reloads (< 8 MiB growth; gross-leak bound, independent)",
          grow is not None and grow < 8 * 1024, {"growthKiB": grow, "samples": rss, "partsFirstLast": parts})
        c("no errors or JS exceptions logged", not unexpected(s), unexpected(s)[:5])
    c("facts (recorded, always passes)", True, facts)
