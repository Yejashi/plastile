"""Float rectangles across outputs (D6) and persisted session preferences (T27, ADR-013).

TEST_MATRIX IDs: L08 (float restore), O04/O05 (output changes), Q05 (persistence unavailable),
Q06 (ambiguous restore), Q07 (partial/invalid state file), Q09 (reload cycles).

Geometry is judged by the oracle (one-shot KWin scripts reading real window state). The state
files are read from the nested session's private XDG_STATE_HOME; Plastile's counters and log
lines are used for amounts of work and its own diagnostics only.
"""
from __future__ import annotations

import ctypes
import re
import json
import os
import select
import shutil
import struct
import threading
import time
from pathlib import Path

from harness import ROOT, Session, delta, explain, near, tiling_errors, window_info, steady_connections
from scenarios import Checks, script_objects, scenario

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


def nix_unwrapped_kwin() -> tuple[str, str | None]:
    """(executable, wrapper): the binary behind a nixpkgs wrapQtAppsHook wrapper of kwin_wayland, or
    ("kwin_wayland", None) when kwin_wayland is not such a wrapper (distribution packages)."""
    found = shutil.which("kwin_wayland")
    if found is None:
        return "kwin_wayland", None
    cur = Path(found).resolve()
    wrapper = None
    for _ in range(4):  # makeWrapper may wrap a wrapper
        nxt = cur.parent / f".{cur.name}-wrapped"
        try:
            marked = b"NIXPKGS_QT6_QML_IMPORT_PATH" in cur.read_bytes()
        except OSError:
            break
        if not (marked and nxt.exists()):
            break
        wrapper = wrapper or str(cur)
        cur = nxt
    return (str(cur), wrapper) if wrapper else ("kwin_wayland", None)


def psession(out: Path, base: Path, extra_env: dict | None = None, **kw) -> Session:
    s = Session(out, extra_env={**xdg(base), **(extra_env or {})}, **kw)
    rc = base / "config/kwinrc"
    if not rc.exists():
        rc.write_text(s.kwinrc() + f"\n[Desktops]\nNumber=1\nId_1={DESKTOP_ID}\n\n[org.kde.kdecoration2]\nlibrary=org.kde.breeze\n")
    return s


def slot_path(base: Path, slot: int) -> Path:
    return base / f"state/plastile/state-{slot}.ini"


def ini_unescape(v: str) -> str:
    out, i = [], 0
    while i < len(v):
        ch = v[i]
        if ch == "\\" and i + 1 < len(v):
            nxt = v[i + 1]
            out.append({"n": "\n", "t": "\t", "r": "\r", "0": "\0"}.get(nxt, nxt))
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def slot_text(base: Path, slot: int) -> str | None:
    """The `snapshot` value of the [plastile] group (QSettings keeps unrelated groups, such as garbage, as they are)."""
    p = slot_path(base, slot)
    if not p.exists():
        return None
    group = None
    for line in p.read_text(errors="replace").splitlines():
        if line.startswith("[") and line.endswith("]"):
            group = line[1:-1]
        elif group == "plastile" and line.startswith("snapshot="):
            v = line[len("snapshot="):]
            if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
                v = v[1:-1]
            return ini_unescape(v)
    return None


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
    slot_path(base, slot).write_text('[plastile]\nsnapshot="' + text.replace("\\", "\\\\").replace('"', '\\"') + '"\n')


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
    run, and one save follows about 2 s after the last change."""
    base = out / "xdg"
    facts: dict = {}
    with psession(out / "first", base) as s:
        s.spawn(1); s.spawn(2); s.spawn(3); spawn_app(s, 9)
        s.load(); s.settle()
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
        c("the save is atomic: written to an unnamed temporary file, which then appears as state-0.ini; never written in "
          "place (QSaveFile; inotify)", atomic(writes, "state-0.ini"), describe(writes, t_last))
        c("only the slot being saved, its lock file and unnamed temporary files are touched",
          all(n.startswith("state-0.ini") or n.startswith("#") for _, _, n in writes), sorted({n for _, _, n in writes}))
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
            s.load()
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
        c("Settings never used its default location (no kde.org/kwin.conf in the private config directory)",
          not (base / "config/kde.org").exists(), sorted(p.name for p in (base / "config").iterdir()))
        c("no errors or JS exceptions logged (first session)", not unexpected(s), unexpected(s)[:5])
        facts["persistence"] = s.counters()["persistence"]
    # A KWin restart: a new compositor process, the same XDG state and config directories.
    with psession(out / "second", base) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        s.load(); s.settle()
        c("restart: saved state loaded once (log)", len(s.log_lines(r"plastile info saved state loaded")) == 1,
          s.log_lines(r"plastile info saved state"))
        c("restart: the master column has the saved ratio from the first solve (oracle)",
          near(s.frames()[fx(1)]["frame"], master, 1), {"want": master, "got": s.frames()[fx(1)]["frame"]})
        spawn_app(s, 9)  # the application starts after Plastile: restored when it maps
        time.sleep(0.3)
        s.settle()
        got = frame_of(s, 9)
        c("restart: the solo window, opened after the script started, floats at its saved rectangle (oracle)",
          near(got or {}, solo, 1) and explain(s, fx(9))["mode"] == "floating", {"want": solo, "got": got})
        c("restart: the other windows tile beside it (oracle)", not tiling_errors(s.frames_list(), s.area(), GAP),
          tiling_errors(s.frames_list(), s.area(), GAP))
        c("no errors or JS exceptions logged (restart)", not unexpected(s), unexpected(s)[:5])
    c("facts (recorded, always passes)", True, facts)


# --------------------------------------------------------------------- Q06
@scenario("persist-ambiguous-Q06")
def persist_ambiguous(out: Path, c: Checks):
    """A saved float for an application with two live windows is not given to either: both get ordinary insertion.
    With one window again it is restored (positive control)."""
    base = out / "xdg"
    with psession(out / "s", base) as s:
        s.spawn(1); spawn_app(s, 9)
        s.load(); s.settle()
        s.act(fx(9), "workspace.activeWindow = w")
        s.cmd("window.toggle-float")
        time.sleep(0.2); s.settle()
        s.act(fx(9), "w.frameGeometry = {x: 260, y: 180, width: 480, height: 360}")
        time.sleep(2.8)
        saved = frame_of(s, 9)
        snap = newest(base)
        c("precondition: the float is saved (file)", bool(snap) and any(f["appId"] == SOLO for f in snap["floats"]), snap)
        s.unload()
        spawn_app(s, 10)  # a second instance of the same application
        s.load(); cc = s.settle()
        modes = {i: explain(s, fx(i))["mode"] for i in (9, 10)}
        frames = [{"caption": fx(i), "frame": frame_of(s, i)} for i in (1, 9, 10)]
        c("Q06: two live windows of the application: neither gets the saved float, both tile (explain + oracle)",
          modes == {9: "tiled", 10: "tiled"} and not tiling_errors(frames, s.area(), GAP),
          {"modes": modes, "errors": tiling_errors(frames, s.area(), GAP)})
        c("Q06: counted as ambiguous, nothing restored (counters)", cc["counters"]["restored"] == 0
          and cc["counters"]["restoreAmbiguous"] >= 1, cc["counters"])
        s.unload()
        c("Q06: the saved float is kept for later, not dropped (file)",
          any(f["appId"] == SOLO for f in (newest(base) or {}).get("floats", [])), newest(base))
        s.kill(10, wait=False)
        s.wait_for(lambda: frame_of(s, 10) is None, 5, "unmap fixture 10")
        s.load(); cc = s.settle()
        c("positive control: with one window again the float is restored (oracle)",
          near(frame_of(s, 9) or {}, saved, 1) and explain(s, fx(9))["mode"] == "floating" and cc["counters"]["restored"] == 1,
          {"want": saved, "got": frame_of(s, 9), "counters": cc["counters"]})
        s.kill(9, wait=False)
        s.wait_for(lambda: frame_of(s, 9) is None, 5, "unmap fixture 9")
        spawn_app(s, 11)  # the application opened again in the same session
        time.sleep(0.3)
        s.settle()
        c("same session: the application's next window floats at the saved rectangle (oracle)",
          near(frame_of(s, 11) or {}, saved, 1) and explain(s, fx(11))["mode"] == "floating",
          {"want": saved, "got": frame_of(s, 11)})
        c("no errors or JS exceptions logged", not unexpected(s), unexpected(s)[:5])


# --------------------------------------------------------------------- Q07
@scenario("persist-damaged-Q07")
def persist_damaged(out: Path, c: Checks):
    """Damaged, torn and newer-schema state files: defaults (or the other valid slot) and exactly one diagnostic."""
    partial = (FIXTURES / "partial.json").read_text()
    facts: dict = {}
    # (a) garbage in slot 0 (QSettings finds no Plastile value in it: absent) and an invalid snapshot in slot 1:
    # defaults; the next save goes into slot 0.
    base = out / "a"
    xdg(base)
    slot_path(base, 0).write_bytes(b"\x00\xff\xfe garbage [plastile\nsnapshot=\"{oops\n")
    write_slot(base, 1, (FIXTURES / "invalid.json").read_text().strip())
    with psession(out / "a/s", base) as s:
        s.spawn(1); s.spawn(2)
        s.load(); s.settle()
        area = s.area()
        diag = s.log_lines(r"plastile warn saved state rejected")
        w = s.frames()[fx(1)]["frame"]["width"]
        facts["a.diagnostic"] = diag
        c("Q07 garbage + invalid: defaults (master column at the default ratio, oracle)",
          abs(w - default_master_width(area, 0.55)) <= 1 and not tiling_errors(s.frames_list(), area, GAP), w)
        c("Q07 garbage + invalid: exactly one diagnostic, naming the invalid field, and no other warning",
          len(diag) == 1 and "slot 1: contexts[0].masterStack.ratio" in diag[0] and "using defaults" in diag[0]
          and not unexpected(s, r"saved state rejected"), {"diag": diag, "other": unexpected(s, r"saved state rejected")})
        s.act(fx(1), "workspace.activeWindow = w")
        s.cmd("resize.grow")
        time.sleep(2.8)
        snap0 = slot_json(base, 0)
        c("Q07: the next save writes a valid snapshot into slot 0 (file)", bool(snap0) and snap0["generation"] == 1, snap0)
        s.unload(); s.load(); s.settle()
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
        s.load(); s.settle()
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
        s.load(); s.settle()
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
@scenario("persist-no-qtcore-Q05")
def persist_no_qtcore(out: Path, c: Checks):
    """QtCore Settings unavailable: Plastile tiles, reports once, and writes nothing.

    The failure is induced with a QtCore module first on QML2_IMPORT_PATH and QML_IMPORT_PATH (which take precedence) whose Settings type names
    a missing file, so creating Settings throws in KWin's engine. Hiding the real module does not work here: a qmldir
    whose plugin is missing still resolves Settings, because QtCore's types are already registered in the process
    (measured in nested KWin 6.7.5, Qt 6.11.2), so this is the closest reproducible stand-in for a missing module."""
    shadow = out / "qml-shadow/QtCore"
    shadow.mkdir(parents=True, exist_ok=True)
    (shadow / "qmldir").write_text("module QtCore\nSettings 6.0 Missing.qml\n")
    base = out / "xdg"
    # Qt searches QML2_IMPORT_PATH before QML_IMPORT_PATH (qqmltypeloader.cpp, "5. $QML2_IMPORT_PATH
    # 6. $QML_IMPORT_PATH"), and some environments (the Nix KWin 6.8 sandbox) set both, so the shadow
    # goes first on both or the real QtCore is still found.
    paths = {v: os.pathsep.join([str(shadow.parent)] + ([os.environ[v]] if os.environ.get(v) else []))
             for v in ("QML2_IMPORT_PATH", "QML_IMPORT_PATH")}
    kwin_bin, wrapper = nix_unwrapped_kwin()
    if wrapper is not None:
        # nixpkgs' qtdeclarative adds NIXPKGS_QT6_QML_IMPORT_PATH after both (highest priority), and
        # wrapQtAppsHook's wrapper prefixes it with qtdeclarative's own qml directory, so no
        # environment can put the shadow first through the wrapper: run the wrapped binary instead,
        # with the shadow first on that variable too (run.sh's environment carries everything else).
        paths["NIXPKGS_QT6_QML_IMPORT_PATH"] = os.pathsep.join(
            [str(shadow.parent)] + [p for p in (os.environ.get("QML2_IMPORT_PATH"),) if p])
    with psession(out / "s", base, extra_env=paths, kwin_bin=kwin_bin) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        s.load(); s.settle()
        area = s.area()
        diag = s.log_lines(r"plastile warn persistence unavailable")
        c("Q05: tiles without persistence (oracle)", not tiling_errors(s.frames_list(), area, GAP),
          tiling_errors(s.frames_list(), area, GAP))
        c("Q05: one diagnostic naming the QtCore failure", len(diag) == 1 and "QtCore" in diag[0],
          {"diagnostics": diag, "kwin": kwin_bin, "bypassedWrapper": wrapper})
        w0 = s.frames()[fx(1)]["frame"]["width"]
        s.act(fx(1), "workspace.activeWindow = w")
        a = s.counters()
        s.cmd("resize.grow")
        time.sleep(0.3)
        b = s.settle()
        c("Q05: commands work (one grow step moves the master edge, oracle)", s.frames()[fx(1)]["frame"]["width"] > w0
          and delta(a, b).get("commands", 0) == 1, {"before": w0, "after": s.frames()[fx(1)]["frame"]["width"]})
        c("Q05: persistence reports in-memory operation (counters)", b["persistence"]["state"] == "memory", b["persistence"])
        time.sleep(2.6)
        s.unload()
        files = sorted(p.name for p in (base / "state/plastile").iterdir())
        c("Q05: nothing written to the state directory, also at unload (file)", files == [], files)
        c("Q05: no other warning or JS exception", not unexpected(s, r"persistence unavailable"),
          unexpected(s, r"persistence unavailable")[:5])


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
        s.load(); first = s.settle()
        fds, rss, gens, errors = [], [], [], []
        g0 = generation(base) or 0
        watch = Inotify(base / "state/plastile")
        for i in range(cycles):
            s.act(fx(1), "workspace.activeWindow = w")
            s.cmd("resize.grow" if i % 2 == 0 else "resize.shrink")  # unsaved at unload (the debounce is 2 s)
            time.sleep(0.15)
            s.unload()
            gens.append(generation(base))
            s.load()
            cc = s.settle()
            if steady_connections(cc) != steady_connections(first) or cc["windows"] != first["windows"]:
                errors.append((i, cc["connections"], cc.get("transientConnections"), cc["windows"],
                               first["connections"], first.get("transientConnections")))
            fds.append(fd_count(s))
            rss.append(s.kw.kwin_rss_kib())
        time.sleep(2.8)
        watch.close()
        g_end = generation(base)
        objects = script_objects(s)
        writes = watch.writes()
        facts.update({"generations": gens, "fds": fds, "rssKiB": rss, "scriptObjects": objects,
                      "firstSaveEvents": describe(writes[:12])})
        c("Q09: every save replaces its slot atomically, also when overwriting (no in-place write; inotify)",
          atomic(writes, "state-0.ini") and atomic(writes, "state-1.ini")
          and sum(1 for _, m, n in writes if m & IN_MOVED_TO and n.startswith("state-")) >= cycles - 2,
          describe(writes)[:20])
        c(f"Q09: each of {cycles} unloads saved exactly once (generation +1 per cycle, file)",
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
          grow is not None and grow < 8 * 1024, {"growthKiB": grow, "samples": rss})
        c("no errors or JS exceptions logged", not unexpected(s), unexpected(s)[:5])
    c("facts (recorded, always passes)", True, facts)
