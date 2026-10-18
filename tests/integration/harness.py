"""Integration harness: the real Plastile package in a disposable nested KWin.

Geometry is judged by the independent oracle (tools/nested.py fixtures(): one-shot
KWin scripts reading real window state). Plastile's own counters are used only
for work-amount gates (solves, writes, corrections), never for geometry claims.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from nested import NestedKwin, NestedError  # noqa: E402

FIXTURE = ROOT / "fixtures/client/build/plastile-fixture"
PACKAGE_QML = ROOT / "package/contents/ui/main.qml"
PLUGIN = "plastile"
COUNTERS = re.compile(r"plastile counters (\{.*\})$")
TOL = 0.5


def evidence_file(name: str) -> Path:
    """Where a scenario records its evidence summary.

    Committed summaries in docs/status/evidence/ change only when publishing is
    requested (PLASTILE_PUBLISH_EVIDENCE=1); ordinary runs write to the gitignored
    artifacts/evidence/, so running the suite never rewrites another environment's
    committed evidence or dirties the tree.
    """
    base = ROOT / ("docs/status/evidence" if os.environ.get("PLASTILE_PUBLISH_EVIDENCE") == "1"
                   else "artifacts/evidence")
    base.mkdir(parents=True, exist_ok=True)
    return base / name


def near(a, b, tol=TOL):
    return all(abs(a[k] - b[k]) <= tol for k in ("x", "y", "width", "height"))


def overlaps(a, b, tol=TOL):
    return (min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]) > tol and
            min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]) > tol)


def separation(a: dict, b: dict) -> tuple[float, float]:
    """(dx, dy): the gap between two rectangles on each axis; negative = their projections overlap by that much."""
    dx = max(a["x"], b["x"]) - min(a["x"] + a["width"], b["x"] + b["width"])
    dy = max(a["y"], b["y"]) - min(a["y"] + a["height"], b["y"] + b["height"])
    return dx, dy


def tiling_errors(frames: list[dict], area: dict, gap: int | None = None, tol: float = TOL) -> list[str]:
    """Independent tiling oracle over KWin's reported frames.

    Always: every frame lies inside `area` and no two frames overlap (by more than `tol`).
    With `gap`: all four outer margins (left, top, right, bottom) are >= gap, and two frames that
    face each other (their projections overlap on one axis) are >= gap apart on the other axis,
    as the core layout tests require (tests/core/bsp.test.ts assertGaps). Frames smaller than
    their slot (maximum size, increments) only make margins larger, so they still pass.

    `tol` absorbs KWin's rounding: 0.5 px at scale 1. At a fractional scale KWin snaps frame
    edges to the device-pixel grid, so callers pass 0.5 + 1/scale (the product's own
    frameTolerance in src/core/geometry.ts).
    """
    errs = []
    ax0, ay0 = area["x"], area["y"]
    ax1, ay1 = ax0 + area["width"], ay0 + area["height"]
    for f in frames:
        r = f["frame"]
        x1, y1 = r["x"] + r["width"], r["y"] + r["height"]
        if r["x"] < ax0 - tol or r["y"] < ay0 - tol or x1 > ax1 + tol or y1 > ay1 + tol:
            errs.append(f"{f['caption']} outside area {r}")
        if gap is not None:
            margins = {"left": r["x"] - ax0, "top": r["y"] - ay0, "right": ax1 - x1, "bottom": ay1 - y1}
            close = {k: round(v, 3) for k, v in margins.items() if v < gap - tol}
            if close:
                errs.append(f"{f['caption']} closer than {gap}px to the area edge {close}: {r}")
    for i, a in enumerate(frames):
        for b in frames[i + 1:]:
            dx, dy = separation(a["frame"], b["frame"])
            if dx < -tol and dy < -tol:
                errs.append(f"{a['caption']} overlaps {b['caption']}")
            elif gap is not None:
                if dy < -tol and dx < gap - tol:
                    errs.append(f"{a['caption']} and {b['caption']} are {round(dx, 3)}px apart horizontally (< {gap})")
                if dx < -tol and dy < gap - tol:
                    errs.append(f"{a['caption']} and {b['caption']} are {round(dy, 3)}px apart vertically (< {gap})")
    return errs


class Fixture:
    def __init__(self, proc: subprocess.Popen, ident: int, log: Path):
        self.proc, self.ident, self.log = proc, ident, log

    @property
    def caption(self) -> str:
        return f"plastile-fixture {self.ident}"

    def send(self, line: str) -> None:
        self.proc.stdin.write((line + "\n").encode())
        self.proc.stdin.flush()


class Session:
    """One nested KWin plus the Plastile package and fixture clients."""

    def __init__(self, out: Path, outputs: int = 1, config: dict | None = None, width=1280, height=800,
                 extra_env: dict | None = None, qml: Path = PACKAGE_QML, xwayland: bool = False, kwinrc_extra: str = "",
                 kwin_bin: str = "kwin_wayland"):
        self.out = out
        out.mkdir(parents=True, exist_ok=True)
        self.config = {"diagnostics": "info", **(config or {})}
        # Extra kwinrc groups (e.g. [MouseBindings]) for scenarios that pin KWin defaults across versions.
        self.kwinrc_extra = kwinrc_extra
        self.qml = qml
        self.kw = NestedKwin(out, outputs=outputs, width=width, height=height, kwinrc=self.kwinrc(), extra_env=extra_env,
                             xwayland=xwayland, kwin_bin=kwin_bin)
        self.fixtures: dict[int, Fixture] = {}
        self.loaded = False

    def kwinrc(self) -> str:
        lines = ["[Script-plastile]"] + [f"{k}={v}" for k, v in self.config.items()]
        extra = self.kwinrc_extra.strip()
        return "\n".join(lines) + "\n" + (("\n" + extra + "\n") if extra else "")

    def __enter__(self) -> "Session":
        self.kw.start()
        return self

    def __exit__(self, *exc) -> None:
        try:
            if self.loaded:
                self.unload()
        finally:
            for f in list(self.fixtures.values()):
                try:
                    f.send("quit")
                except Exception:
                    pass
            self.kw.stop()

    # ------------------------------------------------------------ fixtures
    def spawn(self, ident: int, *args: str, wait: bool = True) -> Fixture:
        log = self.out / f"fixture-{ident}.jsonl"
        proc = self.kw.spawn([str(FIXTURE), "--ssd", "--id", str(ident), *args], stdout=open(log, "w"),
                             stdin=subprocess.PIPE)
        fx = Fixture(proc, ident, log)
        self.fixtures[ident] = fx
        if wait:
            self.wait_for(lambda: any(f["caption"] == fx.caption for f in self.frames_list()), 5, f"map {fx.caption}")
        return fx

    def kill(self, ident: int, wait: bool = True) -> None:
        fx = self.fixtures.pop(ident)
        fx.send("quit")
        fx.proc.wait(timeout=5)
        if wait:
            self.wait_for(lambda: all(f["caption"] != fx.caption for f in self.frames_list()), 5, f"unmap {fx.caption}")

    # --------------------------------------------------------------- plastile
    def load(self) -> None:
        off = self.kw.mark()
        self.kw.load_declarative(self.qml, PLUGIN)
        self.kw.wait_log(r"plastile info started ", 10, off)
        self.loaded = True

    def unload(self) -> None:
        off = self.kw.mark()
        self.kw.unload(PLUGIN)
        self.kw.wait_log(r"plastile info stopped", 10, off)
        self.loaded = False

    def cmd(self, name: str) -> int:
        return self.kw.invoke_shortcut(name if name.startswith("plastile.") else f"plastile.{name}")

    def counters(self) -> dict:
        off = self.kw.mark()
        self.cmd("inspect.counters")
        line = self.kw.wait_log(r"plastile counters ", 5, off)[-1]
        return json.loads(COUNTERS.search(line).group(1))

    def settle(self, timeout: float = 4.0, quiet: float = 0.15) -> dict:
        """Wait until no request is outstanding and the oracle frames stopped changing."""
        deadline = time.monotonic() + timeout
        last = None
        stable_since = time.monotonic()
        while True:
            c = self.counters()
            frames = {f["caption"]: f["frame"] for f in self.frames_list()}
            if frames != last:
                last, stable_since = frames, time.monotonic()
            if c["outstanding"] == 0 and time.monotonic() - stable_since >= quiet:
                return c
            if time.monotonic() > deadline:
                return c
            time.sleep(0.03)

    # ----------------------------------------------------------------- oracle
    def frames_list(self) -> list[dict]:
        return self.kw.fixtures()

    def frames(self) -> dict[str, dict]:
        return {f["caption"]: f for f in self.frames_list()}

    def act(self, caption: str, statement: str) -> None:
        self.kw.act(caption, statement)
        if "workspace.activeWindow = w" in statement:
            self.wait_active(caption)

    def wait_active(self, caption: str, timeout: float = 3.0) -> None:
        """Wait until KWin reports `caption` active. Commands resolve their target from the
        active window at dispatch, and under load activation can land after the next
        command (seen as a flake of fractional-scale-G03 on a busy machine)."""
        deadline = time.monotonic() + timeout
        while True:
            out = self.js("emit(workspace.activeWindow ? workspace.activeWindow.caption : null)")
            if out and json.loads(out[0]) == caption:
                return
            if time.monotonic() > deadline:
                raise NestedError(f"{caption!r} did not become active within {timeout} s (active: {out})")
            time.sleep(0.02)

    def js(self, body: str) -> list[str]:
        return self.kw.run_js(body)

    def area(self, output_index: int = 0) -> dict:
        out = self.js(f"const o = workspace.screens[{output_index}]; const a = workspace.clientArea(workspace.MaximizeArea, o, "
                      f"workspace.currentDesktopForScreen(o)); emit({{x: a.x, y: a.y, width: a.width, height: a.height}});")
        return json.loads(out[0])

    def log_lines(self, pattern: str, offset: int = 0) -> list[str]:
        return self.kw.lines_since(offset, pattern)

    @staticmethod
    def wait_for(pred, timeout: float, what: str) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if pred():
                return
            time.sleep(0.03)
        raise NestedError(f"timed out: {what}")


INPUT = ROOT / "build/input/plastile-input"
KEY_LEFTMETA = 125
KEY_ESC = 1


class Input:
    """Real compositor input through KWin's EIS RemoteDesktop endpoint on the nested bus."""

    def __init__(self, s: "Session"):
        import dbus
        conn = s.kw._bus_connection()
        obj = conn.get_object("org.kde.KWin", "/org/kde/KWin/EIS/RemoteDesktop")
        fd, self.cookie = obj.connectToEIS(1 | 2, dbus_interface="org.kde.KWin.EIS.RemoteDesktop")
        raw = fd.take() if isinstance(fd, dbus.types.UnixFd) else int(fd)
        self.proc = subprocess.Popen([str(INPUT), str(raw)], env=s.kw.client_env(), stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, text=True, pass_fds=(raw,))
        import os
        os.close(raw)
        line = self.proc.stdout.readline().strip()
        if line != "ready":
            raise NestedError(f"input injector not ready: {line!r}")

    def do(self, *lines: str) -> None:
        for line in lines:
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()
            reply = self.proc.stdout.readline().strip()
            if not reply.startswith("ok "):
                raise NestedError(f"input {line!r}: {reply!r}")

    def drag(self, x0, y0, x1, y1, steps=12, button="left", modifier: int | None = KEY_LEFTMETA, pause=0.012,
             release=True) -> None:
        if modifier is not None:
            self.do(f"key {modifier} down")
        self.do(f"move {x0} {y0}")
        time.sleep(pause)
        self.do(f"press {button}")
        for i in range(1, steps + 1):
            time.sleep(pause)
            self.do(f"move {x0 + (x1 - x0) * i / steps} {y0 + (y1 - y0) * i / steps}")
        time.sleep(pause)
        if release:
            self.do(f"release {button}")
            if modifier is not None:
                self.do(f"key {modifier} up")

    def close(self) -> None:
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=3)
        except Exception:
            self.proc.kill()


def centre(r: dict) -> tuple[float, float]:
    return r["x"] + r["width"] / 2, r["y"] + r["height"] / 2


def steady_connections(c: dict) -> int:
    """Owned connections minus one-shot watchers still armed (at most one per window).

    The adapter arms a clientGeometryChanged watcher on decorationChanged until the margin
    settles; on a real GPU KWin emits decorationChanged ~100 ms after the first tile write and
    then nothing, so the watcher can stay armed while idle (measured, KWin 6.7.5). A count that
    includes it is not a steady baseline. A transient count above the window count is a leak.
    """
    transient = c.get("transientConnections", 0)
    if transient > c.get("windows", 0):
        raise AssertionError(f"transientConnections {transient} exceeds windows {c.get('windows')}")
    return c["connections"] - transient


def delta(a: dict, b: dict) -> dict:
    ca, cb = a["counters"], b["counters"]
    return {k: cb[k] - ca[k] for k in cb if cb[k] != ca[k]}


# ------------------------------------------------------------------ shared helpers
def trace(s: Session) -> list[dict]:
    """Plastile's own event trace (inspect.dump-trace). Work attribution only, never a geometry oracle."""
    off = s.kw.mark()
    s.cmd("inspect.dump-trace")
    line = s.kw.wait_log(r"plastile trace ", 5, off)[-1]
    return json.loads(line.split("plastile trace ", 1)[1])


def trace_since(records: list[dict], t0: float) -> list[dict]:
    return [r for r in records if r["t"] > t0]


def last_trace_t(s: Session) -> float:
    tr = trace(s)
    return tr[-1]["t"] if tr else 0


def explain(s: Session, caption: str) -> dict:
    """Plastile's recorded decision for a window (activates it first: explain-window reads the active window)."""
    s.act(caption, "workspace.activeWindow = w")
    time.sleep(0.1)
    off = s.kw.mark()
    s.cmd("inspect.explain-window")
    line = s.kw.wait_log(r"plastile info explain ", 5, off)[-1]
    return json.loads(line.split("plastile info explain ", 1)[1])


def fixture_events(log: Path, ev: str | None = None, win: str = "main") -> list[dict]:
    """Records from a fixture client's own JSONL log (the client-side protocol view)."""
    out = []
    for line in log.read_text().splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if (ev is None or e.get("ev") == ev) and e.get("win", win) == win:
            out.append(e)
    return out


def window_info(s: Session, caption: str, fields: str) -> dict | None:
    """One-shot oracle: `fields` is a JS object literal evaluated with `w` bound to the window."""
    out = s.js(f"const w = workspace.windowList().find(x => x.caption === {json.dumps(caption)});\n"
               f"emit(w ? ({fields}) : null);")
    return json.loads(out[0])


class Listener:
    """A passive plain-JS KWin script (not Plastile) that logs workspace/window signals it observes.

    Every line is `PLT-L <event> <caption>|<internalId> [extra]` (`added` carries `{"cls": resourceClass}`,
    `frame` the new frame). It is loaded and unloaded by the
    harness, owns nothing, and gives scenarios an observation independent of Plastile's counters.
    `frames` lists captions whose frameGeometryChanged emissions are counted.
    """

    def __init__(self, s: Session, name: str = "plt-listen", frames: tuple[str, ...] = ()):
        self.s, self.name = s, name
        body = (
            "function tag(w) { return w ? String(w.caption) + '|' + String(w.internalId) : 'null'; }\n"
            "var watched = " + json.dumps(list(frames)) + ";\n"
            "function hook(w) {\n"
            "  if (!w || watched.indexOf(String(w.caption)) < 0) return;\n"
            "  w.frameGeometryChanged.connect(function () { var g = w.frameGeometry;\n"
            "    print('PLT-L frame ' + tag(w) + ' ' + JSON.stringify([g.x, g.y, g.width, g.height])); });\n"
            "}\n"
            "workspace.windowAdded.connect(function (w) {\n"
            "  print('PLT-L added ' + tag(w) + ' ' + JSON.stringify({cls: String(w.resourceClass)})); hook(w); });\n"
            "workspace.windowRemoved.connect(function (w) { print('PLT-L removed ' + tag(w)); });\n"
            "workspace.windowList().forEach(hook);\n"
            "print('PLT-L ready');\n")
        self.path = s.kw.root / f"{name}.js"
        self.path.write_text(body)
        off = s.kw.mark()
        s.kw.load_script(self.path, name)
        s.kw.wait_log(r"PLT-L ready", 5, off)

    def lines(self, kind: str, offset: int = 0) -> list[str]:
        return self.s.log_lines(rf"PLT-L {kind} ", offset)

    def captions(self, kind: str, offset: int = 0) -> list[str]:
        return [ln.split(f"PLT-L {kind} ", 1)[1].split("|", 1)[0] for ln in self.lines(kind, offset)]

    def close(self) -> None:
        try:
            self.s.kw.unload(self.name)
        except Exception:
            pass
