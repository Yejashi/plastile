"""Integration harness: the real Plastile package in a disposable nested KWin.

Geometry is judged by the independent oracle (tools/nested.py fixtures(): one-shot
KWin scripts reading real window state). Plastile's own counters are used only
for work-amount gates (solves, writes, corrections), never for geometry claims.
"""
from __future__ import annotations

import json
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


def near(a, b, tol=TOL):
    return all(abs(a[k] - b[k]) <= tol for k in ("x", "y", "width", "height"))


def overlaps(a, b):
    return (min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]) > TOL and
            min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]) > TOL)


def tiling_errors(frames: list[dict], area: dict, gap: int | None = None) -> list[str]:
    """Oracle: inside area, no overlap; with `gap`, outer margins and spacing are >= gap."""
    errs = []
    for f in frames:
        r = f["frame"]
        if r["x"] < area["x"] - TOL or r["y"] < area["y"] - TOL or r["x"] + r["width"] > area["x"] + area["width"] + TOL \
                or r["y"] + r["height"] > area["y"] + area["height"] + TOL:
            errs.append(f"{f['caption']} outside area {r}")
        if gap is not None:
            if r["x"] - area["x"] < gap - TOL or r["y"] - area["y"] < gap - TOL:
                errs.append(f"{f['caption']} closer than {gap}px to the area edge: {r}")
    for i, a in enumerate(frames):
        for b in frames[i + 1:]:
            if overlaps(a["frame"], b["frame"]):
                errs.append(f"{a['caption']} overlaps {b['caption']}")
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

    def __init__(self, out: Path, outputs: int = 1, config: dict | None = None, width=1280, height=800):
        self.out = out
        out.mkdir(parents=True, exist_ok=True)
        self.config = {"diagnostics": "info", **(config or {})}
        self.kw = NestedKwin(out, outputs=outputs, width=width, height=height, kwinrc=self.kwinrc())
        self.fixtures: dict[int, Fixture] = {}
        self.loaded = False

    def kwinrc(self) -> str:
        lines = ["[Script-plastile]"] + [f"{k}={v}" for k, v in self.config.items()]
        return "\n".join(lines) + "\n"

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
        self.kw.load_declarative(PACKAGE_QML, PLUGIN)
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


def delta(a: dict, b: dict) -> dict:
    ca, cb = a["counters"], b["counters"]
    return {k: cb[k] - ca[k] for k in cb if cb[k] != ca[k]}
