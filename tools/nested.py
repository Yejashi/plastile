#!/usr/bin/env python3
"""Disposable nested KWin sessions for Plastile probes and fixtures.

Every session is isolated from the user's desktop: a private D-Bus daemon, a
private XDG runtime/config/data/cache/state tree, and KWin's virtual backend.
Nothing here connects to, replaces, or restarts the user's active compositor.

Library use:

    with NestedKwin(Path("artifacts/x/session")) as kw:
        kw.load_declarative(Path("probes/hello/contents/ui/main.qml"), "plt-hello")
        kw.wait_log(r"PLT hello", timeout=5)

CLI use (manual experiments):

    python3 tools/nested.py shell [--outputs N]   # prints env exports, waits for Ctrl-C
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Wayland socket paths must stay under 108 bytes, so sessions live in a short
# directory and artifacts are copied out on exit.
SHORT_BASE = Path(os.environ.get("PLASTILE_NESTED_BASE", f"/tmp/plastile-{os.getuid()}"))


class NestedError(RuntimeError):
    pass


def _monotonic_ns() -> int:
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


class NestedKwin:
    def __init__(
        self,
        artifact_dir: Path | None = None,
        *,
        width: int = 1280,
        height: int = 800,
        outputs: int = 1,
        xwayland: bool = False,
        extra_env: dict[str, str] | None = None,
        kwinrc: str | None = None,
        name: str | None = None,
        prepare=None,
    ) -> None:
        self.name = name or f"s{os.getpid()}-{_monotonic_ns() % 10**8}"
        self.root = SHORT_BASE / self.name
        self.artifact_dir = artifact_dir
        self.width, self.height, self.outputs = width, height, outputs
        self.xwayland = xwayland
        self.extra_env = extra_env or {}
        self.kwinrc = kwinrc
        # Optional callable(session) run after the private tree exists and before
        # KWin starts, e.g. to install packages into the nested data home.
        self.prepare = prepare
        self.socket = "wl-0"
        self._dbus: subprocess.Popen | None = None
        self._kwin: subprocess.Popen | None = None
        self._clients: list[subprocess.Popen] = []
        self._log_offset = 0

    # ----------------------------------------------------------------- paths
    @property
    def run_dir(self) -> Path:
        return self.root / "run"

    @property
    def bus_address(self) -> str:
        return f"unix:path={self.run_dir / 'bus'}"

    @property
    def kwin_log(self) -> Path:
        return self.root / "kwin.log"

    def env(self) -> dict[str, str]:
        """Environment for processes that belong inside the nested session."""
        env = {k: v for k, v in os.environ.items()
               if k not in ("WAYLAND_DISPLAY", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS",
                            "WAYLAND_SOCKET", "XAUTHORITY", "SESSION_MANAGER")}
        env.update({
            "DBUS_SESSION_BUS_ADDRESS": self.bus_address,
            "XDG_RUNTIME_DIR": str(self.run_dir),
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_DATA_HOME": str(self.root / "data"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "XDG_STATE_HOME": str(self.root / "state"),
            # Keep script output out of the user's journal and in our log.
            "QT_FORCE_STDERR_LOGGING": "1",
            "QT_LOGGING_RULES": "js=true;qml=true;kwin_scripting=true",
            "QT_MESSAGE_PATTERN": "%{time boot} %{category} %{message}",
        })
        env.update(self.extra_env)
        return env

    def client_env(self) -> dict[str, str]:
        env = self.env()
        env["WAYLAND_DISPLAY"] = self.socket
        env["QT_QPA_PLATFORM"] = "wayland"
        return env

    # ------------------------------------------------------------- lifecycle
    def start(self, timeout: float = 15.0) -> "NestedKwin":
        # A failed start must not leak the private dbus-daemon or KWin: `with` does not
        # call __exit__ when __enter__ raises. stop() also copies the logs out.
        try:
            return self._start(timeout)
        except BaseException:
            self.stop()
            raise

    def _start(self, timeout: float) -> "NestedKwin":
        if self.root.exists():
            shutil.rmtree(self.root)
        for sub in ("run", "config", "data", "cache", "state"):
            (self.root / sub).mkdir(parents=True)
        self.run_dir.chmod(0o700)
        # Without an explicit decoration library the isolated config draws no
        # server-side decoration (frame == client); use Breeze so frame/client
        # geometry differ as they do on real desktops. Callers may override.
        kwinrc = self.kwinrc or ""
        if "[org.kde.kdecoration2]" not in kwinrc:
            kwinrc += "\n[org.kde.kdecoration2]\nlibrary=org.kde.breeze\n"
        (self.root / "config" / "kwinrc").write_text(kwinrc)
        env = self.env()
        self._dbus = subprocess.Popen(
            ["dbus-daemon", "--session", f"--address={self.bus_address}", "--nofork", "--nopidfile"],
            env=env, stdout=subprocess.DEVNULL, stderr=open(self.root / "dbus.log", "wb"))
        self._wait(lambda: (self.run_dir / "bus").exists(), 5.0, "private D-Bus socket")
        if self.prepare is not None:
            self.prepare(self)
        cmd =["kwin_wayland", "--virtual", "--socket", self.socket,
               "--width", str(self.width), "--height", str(self.height),
               "--output-count", str(self.outputs), "--no-lockscreen"]
        if self.xwayland:
            cmd.append("--xwayland")
        self._kwin = subprocess.Popen(cmd, env=env, stdout=open(self.kwin_log, "wb"),
                                      stderr=subprocess.STDOUT)
        self._wait(lambda: self._kwin_ready(), timeout, "nested KWin on private bus")
        return self

    def _kwin_ready(self) -> bool:
        if self._kwin is not None and self._kwin.poll() is not None:
            raise NestedError(f"kwin exited early ({self._kwin.returncode}); see {self.kwin_log}")
        if not (self.run_dir / self.socket).exists():
            return False
        r = subprocess.run(["busctl", f"--address={self.bus_address}", "call", "org.kde.KWin",
                            "/Scripting", "org.freedesktop.DBus.Peer", "Ping"],
                           capture_output=True)
        return r.returncode == 0

    @staticmethod
    def _wait(pred, timeout: float, what: str) -> None:
        deadline = time.monotonic() + timeout
        delay = 0.01
        while time.monotonic() < deadline:
            if pred():
                return
            time.sleep(delay)
            delay = min(delay * 2, 0.2)
        raise NestedError(f"timed out waiting for {what}")

    def stop(self) -> None:
        conn = getattr(self, "_conn", None)
        if conn:
            conn.close()
        self._conn = None
        for proc in self._clients:
            _terminate(proc)
        self._clients.clear()
        if self._kwin is not None:
            _terminate(self._kwin)
            self._kwin = None
        if self._dbus is not None:
            _terminate(self._dbus)
            self._dbus = None
        if self.artifact_dir is not None:
            self.artifact_dir.mkdir(parents=True, exist_ok=True)
            for name in ("kwin.log", "dbus.log"):
                src = self.root / name
                if src.exists():
                    shutil.copy2(src, self.artifact_dir / name)
        shutil.rmtree(self.root, ignore_errors=True)

    def __enter__(self) -> "NestedKwin":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()

    @property
    def kwin_pid(self) -> int | None:
        return self._kwin.pid if self._kwin else None

    def x_display(self, timeout: float = 10.0) -> str:
        """The nested KWin's public X display (XWayland sessions only), never the user's.

        Once Xwayland runs, its argv names the display. Before that (KWin starts Xwayland
        on the first X connection) the lock files owned by this KWin decide. KWin 6.8 owns
        two: the public display and an init display reserved for its Xwayland startup
        scripts, created second (KWin v6.8.0 src/xwayland/xwaylandlauncher.cpp,
        XwaylandLauncher::enable; displays are taken lowest-free-first), so the lowest
        number is the public one. A client on the init display is never served.
        """
        pid = self.kwin_pid
        deadline = time.monotonic() + timeout
        while True:
            for proc in Path("/proc").iterdir():
                if not proc.name.isdigit():
                    continue
                try:
                    if int((proc / "stat").read_text().rsplit(")", 1)[1].split()[1]) != pid:
                        continue
                    argv = (proc / "cmdline").read_bytes().split(b"\0")
                    if argv[0].endswith(b"Xwayland") and len(argv) > 1 and re.fullmatch(rb":\d+", argv[1]):
                        return argv[1].decode()
                except (OSError, ValueError, IndexError):
                    continue
            owned = []
            for lock in glob.glob("/tmp/.X*-lock"):
                try:
                    if int(Path(lock).read_text().strip()) == pid:
                        owned.append(int(re.search(r"\.X(\d+)-lock$", lock).group(1)))
                except (OSError, ValueError, AttributeError):
                    continue
            if owned:
                return f":{min(owned)}"
            if time.monotonic() > deadline:
                raise NestedError("no X display owned by the nested KWin")
            time.sleep(0.05)

    # ----------------------------------------------------------------- D-Bus
    def compositing_type(self) -> str | None:
        """'OpenGL' or 'QPainter' from KWin's support information (None if unreadable).

        Without a DRM render node KWin's virtual backend composites with QPainter,
        and GL-only effects such as the tile editor never load.
        """
        try:
            data = self.call("/KWin", "org.kde.KWin", "supportInformation")
        except NestedError:
            return None
        info = data[0] if isinstance(data, list) and data else data  # busctl --json: [value]
        m = re.search(r"^Compositing Type: (\S+)", info if isinstance(info, str) else "", re.M)
        return m.group(1) if m else None

    def call(self, path: str, interface: str, method: str, signature: str = "", *args,
             service: str = "org.kde.KWin", timeout: float = 10.0):
        cmd = ["busctl", f"--address={self.bus_address}", "--json=short",
               f"--timeout={timeout}", "call", service, path, interface, method]
        if signature:
            cmd.append(signature)
            cmd.extend(str(a) for a in args)
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise NestedError(f"D-Bus {interface}.{method} failed: {r.stderr.strip()}")
        out = r.stdout.strip()
        return json.loads(out)["data"] if out else None

    def load_declarative(self, qml: Path, plugin: str, run: bool = True) -> int:
        script_id = self.call("/Scripting", "org.kde.kwin.Scripting", "loadDeclarativeScript",
                              "ss", str(qml.resolve()), plugin)[0]
        if script_id < 0:
            raise NestedError(f"loadDeclarativeScript returned {script_id} for {plugin}")
        if run:
            self.call(f"/Scripting/Script{script_id}", "org.kde.kwin.Script", "run")
        return script_id

    def load_script(self, js: Path, plugin: str, run: bool = True) -> int:
        script_id = self.call("/Scripting", "org.kde.kwin.Scripting", "loadScript",
                              "ss", str(js.resolve()), plugin)[0]
        if script_id < 0:
            raise NestedError(f"loadScript returned {script_id} for {plugin}")
        if run:
            self.call(f"/Scripting/Script{script_id}", "org.kde.kwin.Script", "run")
        return script_id

    def unload(self, plugin: str) -> bool:
        return bool(self.call("/Scripting", "org.kde.kwin.Scripting", "unloadScript", "s", plugin)[0])

    def is_loaded(self, plugin: str) -> bool:
        return bool(self.call("/Scripting", "org.kde.kwin.Scripting", "isScriptLoaded", "s", plugin)[0])

    def invoke_shortcut(self, action: str, component: str = "kwin") -> int:
        """Trigger a global shortcut by action name through kglobalaccel.

        Returns the monotonic send timestamp. This is a command-API invocation,
        not physical input: report it as such in measurements.
        """
        conn = self._bus_connection()
        if conn is not None:
            # Persistent connection: avoids a busctl process spawn per sample.
            obj = conn.get_object("org.kde.kglobalaccel", f"/component/{component}")
            method = obj.get_dbus_method("invokeShortcut", "org.kde.kglobalaccel.Component")
            t = _monotonic_ns()
            method(action)
            return t
        t = _monotonic_ns()
        self.call(f"/component/{component}", "org.kde.kglobalaccel.Component",
                  "invokeShortcut", "s", action, service="org.kde.kglobalaccel")
        return t

    def _bus_connection(self):
        if getattr(self, "_conn", None) is None:
            try:
                import dbus  # python-dbus; optional
                self._conn = dbus.bus.BusConnection(self.bus_address)
            except ImportError:
                self._conn = False
        return self._conn or None

    def shortcut_names(self, component: str = "kwin") -> list[str]:
        return self.call(f"/component/{component}", "org.kde.kglobalaccel.Component",
                         "shortcutNames", service="org.kde.kglobalaccel")[0]

    # ------------------------------------------------------- one-shot oracles
    ORACLE_FIELDS = (
        "({id: String(w.internalId), caption: w.caption, appId: w.resourceClass,"
        " frame: {x: w.frameGeometry.x, y: w.frameGeometry.y, width: w.frameGeometry.width, height: w.frameGeometry.height},"
        " client: {x: w.clientGeometry.x, y: w.clientGeometry.y, width: w.clientGeometry.width, height: w.clientGeometry.height},"
        " minimized: w.minimized, fullScreen: w.fullScreen, maximizeMode: w.maximizeMode, active: w.active,"
        " tile: w.tile !== null, output: w.output ? w.output.name : null,"
        " desktops: w.desktops.map(d => d.id), onAllDesktops: w.onAllDesktops, keepAbove: w.keepAbove,"
        " noBorder: w.noBorder, transient: w.transient, normal: w.normalWindow})"
    )

    def run_js(self, body: str, timeout: float = 5.0) -> list[str]:
        """Run a one-shot *plain JS* KWin script (global `workspace`) and unload it.

        This is the harness's independent oracle/actor: it is not Plastile code.
        `body` may call emit(obj) to return JSON values; returns the emitted JSON strings.
        """
        self._oneshot = getattr(self, "_oneshot", 0) + 1
        name = f"plt-oneshot-{self._oneshot}"
        tag = f"PLT-ONESHOT-{self._oneshot} "
        path = self.root / f"{name}.js"
        path.write_text(
            f"function emit(v) {{ print({json.dumps(tag)} + JSON.stringify(v)); }}\n"
            f"try {{\n{body}\n}} catch (e) {{ emit({{error: String(e)}}); }}\n"
            f"print({json.dumps(tag.strip() + '-END')});\n")
        off = self.mark()
        self.load_script(path, name)
        self.wait_log(re.escape(tag.strip() + "-END"), timeout, off)
        self.unload(name)
        return [ln.split(tag, 1)[1] for ln in self.lines_since(off, re.escape(tag))]

    def fixtures(self, app_id: str = "plastile-fixture") -> list[dict]:
        """Independent snapshot of every window with the given app id."""
        out = self.run_js(
            f"emit(workspace.windowList().filter(w => w.resourceClass === {json.dumps(app_id)})"
            f".map(w => {self.ORACLE_FIELDS}));")
        data = json.loads(out[0])
        if isinstance(data, dict) and "error" in data:
            raise NestedError(data["error"])
        return data

    def act(self, caption: str, statement: str) -> None:
        """Run `statement` with `w` bound to the window whose caption matches (user-style action)."""
        out = self.run_js(
            f"const w = workspace.windowList().find(x => x.caption === {json.dumps(caption)});\n"
            f"if (!w) emit({{error: 'no window ' + {json.dumps(caption)}}}); else {{ {statement}; emit({{ok: true}}); }}")
        res = json.loads(out[0])
        if "error" in res:
            raise NestedError(res["error"])

    # ------------------------------------------------------------------ logs
    def log_text(self) -> str:
        return self.kwin_log.read_text(errors="replace") if self.kwin_log.exists() else ""

    def mark(self) -> int:
        """Return a log offset; wait_log/lines_since search only after it."""
        self._log_offset = len(self.log_text())
        return self._log_offset

    def lines_since(self, offset: int, pattern: str | None = None) -> list[str]:
        text = self.log_text()[offset:]
        # KWin may be mid-write: never hand out an unterminated final line.
        text = text[: text.rfind("\n") + 1]
        lines = text.splitlines()
        if pattern is None:
            return lines
        rx = re.compile(pattern)
        return [ln for ln in lines if rx.search(ln)]

    def wait_log(self, pattern: str, timeout: float = 5.0, offset: int | None = None,
                 count: int = 1) -> list[str]:
        start = self._log_offset if offset is None else offset
        found: list[str] = []

        def pred() -> bool:
            nonlocal found
            found = self.lines_since(start, pattern)
            return len(found) >= count
        self._wait(pred, timeout, f"log pattern {pattern!r} x{count}")
        return found

    # --------------------------------------------------------------- clients
    def spawn(self, argv: list[str], stdout=None, stdin=None) -> subprocess.Popen:
        proc = subprocess.Popen(argv, env=self.client_env(), stdout=stdout or subprocess.DEVNULL,
                                stdin=stdin, stderr=subprocess.STDOUT if stdout else subprocess.DEVNULL)
        self._clients.append(proc)
        return proc

    def kwin_rss_kib(self) -> int | None:
        if not self._kwin:
            return None
        for line in Path(f"/proc/{self._kwin.pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
        return None


def _terminate(proc: subprocess.Popen, grace: float = 3.0) -> None:
    if proc.poll() is not None:
        return
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=grace)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sh = sub.add_parser("shell", help="start a session and print its environment")
    sh.add_argument("--outputs", type=int, default=1)
    sh.add_argument("--xwayland", action="store_true")
    args = ap.parse_args()
    if args.cmd == "shell":
        kw = NestedKwin(outputs=args.outputs, xwayland=args.xwayland, name="shell")
        kw.start()
        try:
            env = kw.client_env()
            for key in ("DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY"):
                print(f"export {key}={env[key]}")
            print(f"# kwin pid {kw.kwin_pid}; log {kw.kwin_log}; Ctrl-C to stop", flush=True)
            signal.pause()
        except KeyboardInterrupt:
            pass
        finally:
            kw.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
