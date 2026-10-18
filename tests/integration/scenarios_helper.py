"""The persistence helper's own contract (helper/, org.kde.plastile.State; ADR-020), without KWin.

TEST_MATRIX IDs: T27 (atomic, owner-only storage), Q05 (helper dies/restarts), Q07 (damaged state files).

Each case starts a private dbus-daemon (never the user's bus) whose activation file names the helper built for
this run (harness.STATE_HELPER), with private XDG directories, and talks to the helper with dbus-python. The state
files are checked directly on disk. Plastile's side of the protocol is exercised by scenarios_persist.py.
"""
from __future__ import annotations

import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from harness import ROOT, STATE_HELPER, STATE_SERVICE, state_service_file
from scenarios import Checks, Skipped, scenario

sys.path.insert(0, str(ROOT / "tools"))
from nested import session_base  # noqa: E402

MiB = 1024 * 1024
IFACE = STATE_SERVICE


class HelperBus:
    """A private session bus with the helper's activation file; `env` adds test knobs to the helper's environment."""

    def __init__(self, out: Path, env: dict | None = None):
        import dbus
        self.dbus = dbus
        self.root = Path(tempfile.mkdtemp(prefix="hb-", dir=session_base()))  # short: socket paths < 108 bytes
        for d in ("run", "data/dbus-1/services", "state", "config", "cache"):
            (self.root / d).mkdir(parents=True)
        (self.root / "run").chmod(0o700)
        for name, text in state_service_file(env=env).items():
            (self.root / "data/dbus-1/services" / name).write_text(text)
        self.address = f"unix:path={self.root}/run/bus"
        self.env = {k: v for k, v in os.environ.items()
                    if k not in ("DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY", "DISPLAY", "SESSION_MANAGER")}
        self.env.update({"DBUS_SESSION_BUS_ADDRESS": self.address, "XDG_RUNTIME_DIR": str(self.root / "run"),
                         "XDG_DATA_HOME": str(self.root / "data"), "XDG_STATE_HOME": str(self.root / "state"),
                         "XDG_CONFIG_HOME": str(self.root / "config"), "XDG_CACHE_HOME": str(self.root / "cache"),
                         "QT_LOGGING_RULES": "plastile.state.debug=true", "QT_FORCE_STDERR_LOGGING": "1"})
        self.out = out
        out.mkdir(parents=True, exist_ok=True)
        self._log = open(out / "dbus.log", "wb")
        self.proc = subprocess.Popen(["dbus-daemon", "--session", f"--address={self.address}", "--nofork", "--nopidfile"],
                                     env=self.env, stdout=subprocess.DEVNULL, stderr=self._log)
        deadline = time.monotonic() + 5
        while not (self.root / "run/bus").exists():
            if time.monotonic() > deadline or self.proc.poll() is not None:
                self.close()
                raise RuntimeError("private dbus-daemon did not start")
            time.sleep(0.02)
        self.conn = dbus.bus.BusConnection(self.address)

    @property
    def state(self) -> Path:
        return self.root / "state/plastile"

    def slot(self, n: int) -> Path:
        return self.state / f"state-{n}.json"

    def call(self, method: str, *args, sig: str | None = None, timeout: float = 10):
        m = self.conn.get_object(STATE_SERVICE, "/State").get_dbus_method(method, IFACE)
        return m(*args, signature=sig, timeout=timeout) if sig is not None else m(*args, timeout=timeout)

    def error(self, method: str, *args, sig: str | None = None) -> str | None:
        """The D-Bus error name a call returns (None when it succeeds)."""
        try:
            self.call(method, *args, sig=sig)
            return None
        except self.dbus.DBusException as e:
            return e.get_dbus_name()

    def owner(self) -> int | None:
        try:
            return int(self.conn.call_blocking("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                                               "GetConnectionUnixProcessID", "s", (STATE_SERVICE,)))
        except self.dbus.DBusException:
            return None

    def files(self) -> list[str]:
        return sorted(p.name for p in self.state.iterdir()) if self.state.exists() else []

    def stop_bus(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(5)

    def close(self) -> None:
        pid = None
        try:
            pid = self.owner()
        except Exception:
            pass
        self.stop_bus()
        if pid:  # a helper this case started; it exits with its bus, killed only if it did not
            gone_or_kill(pid, 3)
        self._log.close()
        shutil.rmtree(self.root, ignore_errors=True)


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return Path(f"/proc/{pid}").exists() and "zombie" not in Path(f"/proc/{pid}/status").read_text().lower()
    except (ProcessLookupError, FileNotFoundError):
        return False


def gone_or_kill(pid: int, timeout: float) -> bool:
    """Wait for `pid` (a helper this scenario's bus started) to exit; SIGKILL it after `timeout`. True if it exited."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not alive(pid):
            return True
        time.sleep(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return True
    return False


def mode(p: Path) -> str:
    return oct(stat.S_IMODE(p.stat().st_mode))


def pipelined(b: HelperBus, calls: list[tuple[str, tuple]]) -> list | None:
    """Send `calls` on one connection without waiting, collect replies in arrival order (None: no GLib here)."""
    try:
        import dbus.mainloop.glib
        from gi.repository import GLib
    except ImportError:
        return None
    conn = b.dbus.bus.BusConnection(b.address, mainloop=dbus.mainloop.glib.DBusGMainLoop())
    obj = conn.get_object(STATE_SERVICE, "/State")
    loop, got = GLib.MainLoop(), []

    def done(i, value):
        got.append((i, value))
        if len(got) == len(calls):
            loop.quit()
    for i, (method, args) in enumerate(calls):
        kw = {"signature": "is"} if method == "Write" else {}
        getattr(obj, method)(*args, dbus_interface=IFACE, timeout=30, **kw,
                             reply_handler=lambda *r, i=i: done(i, r[0] if r else None),
                             error_handler=lambda e, i=i: done(i, f"error {e.get_dbus_name()}"))
    GLib.timeout_add(20000, loop.quit)
    loop.run()
    conn.close()
    return got


@scenario("persist-helper-contract-T27")
def persist_helper_contract(out: Path, c: Checks):
    """The helper on a private bus: Read/Write round trip, slot and size validation (1 MiB counted in UTF-8 bytes),
    atomic replacement (a new inode; an open reader keeps the old text), owner-only modes repaired, damaged, oversized
    and unreadable slots, a read-only slot replaced, one instance per bus, replies in arrival order, idle exit and
    re-activation, and exit when the bus goes away."""
    if not STATE_HELPER.exists():
        raise Skipped(f"missing {STATE_HELPER}")
    if not shutil.which("dbus-daemon"):
        raise Skipped("no dbus-daemon here")
    facts: dict = {}
    b = HelperBus(out / "basic")
    try:
        r = b.call("Read")
        c("Read with no state: two empty strings, and nothing is created", list(r) == ["", ""] and not b.state.exists(),
          {"reply": list(r), "files": b.files()})
        text = "hello é☃ {\"x\": 1}"
        ok = b.call("Write", 0, text, sig="is")
        c("Write(0) stores the exact UTF-8 text and answers true", bool(ok) and b.slot(0).read_bytes() == text.encode(),
          {"ok": bool(ok)})
        c("the directory is 0700 and the slot 0600", mode(b.state) == "0o700" and mode(b.slot(0)) == "0o600",
          {"dir": mode(b.state), "slot": mode(b.slot(0))})
        c("Read returns slot 0's text and an empty slot 1", list(b.call("Read")) == [text, ""])
        errs = {slot: b.error("Write", slot, "x", sig="is") for slot in (2, -1, 1 << 30)}
        c("a slot other than 0 or 1 is refused with InvalidArgs and writes nothing",
          all(e == "org.freedesktop.DBus.Error.InvalidArgs" for e in errs.values()) and b.files() == ["state-0.json"],
          {"errors": errs, "files": b.files()})
        ok = b.call("Write", 1, "a" * MiB, sig="is")
        c("a text of exactly 1 MiB is stored", bool(ok) and b.slot(1).stat().st_size == MiB)
        big = {"ascii": b.error("Write", 1, "a" * (MiB + 1), sig="is"),
               "utf8": b.error("Write", 1, "é" * (MiB // 2 + 1), sig="is")}  # fewer characters, 1 MiB + 2 bytes
        c("a text over 1 MiB (counted in UTF-8 bytes) is refused with InvalidArgs; the slot keeps its text",
          all(e == "org.freedesktop.DBus.Error.InvalidArgs" for e in big.values()) and b.slot(1).stat().st_size == MiB,
          big)
        sigs = {sig: b.error("Write", *args, sig=sig) for args, sig in (((0,), "i"), (("0", "x"), "ss"))}
        c("calls with the wrong signature are refused and the helper keeps running",
          all(e is not None for e in sigs.values()) and b.owner() is not None, sigs)
        b.state.chmod(0o755)
        b.slot(0).chmod(0o644)
        b.call("Write", 0, "again", sig="is")
        c("a directory widened to 0755 is made 0700 again, and a 0644 slot is replaced by a 0600 one",
          mode(b.state) == "0o700" and mode(b.slot(0)) == "0o600", {"dir": mode(b.state), "slot": mode(b.slot(0))})
        ino = b.slot(0).stat().st_ino
        fd = os.open(b.slot(0), os.O_RDONLY)
        try:
            b.call("Write", 0, "third", sig="is")
            old = os.read(fd, 100)
        finally:
            os.close(fd)
        c("a Write replaces the slot atomically: a new inode, an open reader keeps the old text, no temporary file left",
          b.slot(0).stat().st_ino != ino and old == b"again" and b.slot(0).read_text() == "third"
          and b.files() == ["state-0.json", "state-1.json"], {"old": old.decode(errors="replace"), "files": b.files()})
        b.slot(0).write_bytes(b"\x00\xff\xfe{bad\x00}")
        r = b.call("Read")
        c("damaged bytes and NUL reach the caller as U+FFFD (a damaged slot, not an empty one)",
          r[0] != "" and "\x00" not in r[0] and "�" in r[0], r[0])
        b.slot(0).write_bytes(b"a" * (MiB + 5))
        c("a slot file over 1 MiB reads as empty; the other slot is still returned",
          list(map(len, b.call("Read"))) == [0, MiB])
        b.slot(0).write_text("x")
        b.slot(0).chmod(0)
        c("an unreadable (0000) slot reads as empty", b.call("Read")[0] == "")
        ok = b.call("Write", 0, "over a read-only slot", sig="is")
        c("a slot its owner cannot write (0000, e.g. restored from a backup) is replaced, as 0600",
          bool(ok) and b.slot(0).read_text() == "over a read-only slot" and mode(b.slot(0)) == "0o600",
          {"ok": bool(ok), "mode": mode(b.slot(0))})
        b.slot(1).unlink()
        b.slot(1).mkdir()
        ok = b.call("Write", 1, "y", sig="is")
        c("a slot that cannot be written (a directory in its place) answers false, and the helper keeps running",
          not ok and b.owner() is not None and b.call("Read")[1] == "", {"ok": bool(ok)})
        b.slot(1).rmdir()
        pid = b.owner()
        second = subprocess.run([str(STATE_HELPER)], env=b.env, capture_output=True, timeout=10)
        c("a second instance exits with status 1 while the name is owned; the first keeps it",
          second.returncode == 1 and b.owner() == pid, {"rc": second.returncode, "stderr": second.stderr.decode()[-200:]})
        n = 200
        got = pipelined(b, [("Write", (i % 2, f"text {i}")) for i in range(n)])
        if got is None:
            c("pipelined writes: NOT MEASURABLE here (no GLib main loop for dbus-python); order is covered by the delayed "
              "case only if GLib is present", True, None)
        else:
            c(f"{n} writes sent without waiting all succeed, answered in arrival order; the last one per slot wins",
              [g[0] for g in got] == list(range(n)) and all(not isinstance(g[1], str) and bool(g[1]) for g in got)
              and b.slot(0).read_text() == f"text {n - 2}" and b.slot(1).read_text() == f"text {n - 1}", got[:4])
        pid = b.owner()
        b.stop_bus()
        exited = gone_or_kill(pid, 5)
        c("the helper exits when its bus goes away", exited, {"pid": pid})
    finally:
        b.close()

    b = HelperBus(out / "idle", {"PLASTILE_STATE_TEST_IDLE_MS": "400"})
    try:
        b.call("Write", 0, "one", sig="is")
        pid = b.owner()
        time.sleep(1.2)
        c("the helper exits after its idle period and gives its name back", b.owner() is None and not alive(pid))
        r = b.call("Read")
        pid2 = b.owner()
        c("the next call activates a new helper, which reads the stored slot", r[0] == "one" and pid2 not in (None, pid),
          {"reply": list(r), "pids": [pid, pid2]})
        fails = []
        for i in range(40):  # calls about one idle period apart straddle the exit again and again
            try:
                if not b.call("Write", i % 2, f"edge {i}", sig="is", timeout=5):
                    fails.append((i, "false"))
            except b.dbus.DBusException as e:
                fails.append((i, e.get_dbus_name()))
            time.sleep(0.37 + (i % 7) * 0.01)
        c("40 writes around the idle exit all succeed (none reaches an exiting helper)", not fails, fails)
    finally:
        b.close()

    b = HelperBus(out / "delay", {"PLASTILE_STATE_TEST_DELAY_MS": "300", "PLASTILE_STATE_TEST_IDLE_MS": "200"})
    try:
        t = time.monotonic()
        got = pipelined(b, [("Write", (0, "a")), ("Write", (0, "b")), ("Read", ()), ("Write", (1, "c")), ("Read", ())])
        facts["delayedSeconds"] = round(time.monotonic() - t, 2)
        if got is None:
            c("delayed helper: NOT MEASURABLE here (no GLib main loop for dbus-python)", True, None)
        else:
            c("a delayed helper (test knob) answers queued requests in arrival order, each Read seeing the Writes before "
              "it, also with an idle period shorter than the delay",
              [g[0] for g in got] == [0, 1, 2, 3, 4] and list(got[2][1]) == ["b", ""] and list(got[4][1]) == ["b", "c"],
              [(g[0], str(g[1])[:60]) for g in got])
    finally:
        b.close()
    c("facts (recorded, always passes)", True, facts)
