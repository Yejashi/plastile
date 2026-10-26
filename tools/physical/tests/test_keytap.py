"""plastile-keytap: strict build, dry-backend protocol and uinput session guard (no desktop).

The uinput backend's device path is NOT exercised here. Every `--backend uinput` run uses a
second build whose device node is a path that does not exist (-DKEYTAP_UINPUT_PATH), so no
virtual keyboard can ever be created by this suite, even if a guard check wrongly passed; that
build lets the test of the guard's accepting path run on a host with /dev/uinput too.
The guard's D-Bus queries go to a fake `busctl` placed first on PATH, never to a real bus.
"""
from __future__ import annotations

import json
import os
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "keytap.c"
CC = shutil.which(os.environ.get("CC", "cc")) or shutil.which("gcc") or shutil.which("clang")


FAKE_BUSCTL = r"""
import json, os, sys
argv = sys.argv[1:]
if "GetConnectionUnixProcessID" in argv:
    print(json.dumps({"type": "u", "data": [int(os.environ["FAKE_KWIN_PID"])]}))
elif "supportInformation" in argv:
    backend = os.environ["FAKE_BACKEND"]
    print(json.dumps({"type": "s", "data": ["KWin Support Information:\n\nLogicalOutput backend\n==============\n"
                                            f"Name: {backend}\nAtomic Mode Setting on GPU 0: true\n\nOutputs\n=======\n"
                                            "Name: DP-1\n"]}))
else:
    sys.exit(1)
"""


def fake_busctl(d: Path) -> Path:
    """A directory holding a `busctl` that answers the guard's two queries from FAKE_* variables."""
    bindir = d / "bin"
    bindir.mkdir()
    exe = bindir / "busctl"
    exe.write_text(f"#!{sys.executable}\n" + FAKE_BUSCTL)
    exe.chmod(0o755)
    return bindir


def run_dry(lines: list[str], *extra: str) -> tuple[int, list[dict]]:
    r = subprocess.run([KeytapTests.binary, "--backend", "dry", *extra], input="".join(l + "\n" for l in lines),
                       capture_output=True, text=True, timeout=20)
    return r.returncode, [json.loads(x) for x in r.stdout.splitlines()]


@unittest.skipIf(CC is None, "no C compiler")
class KeytapTests(unittest.TestCase):
    binary: str = ""
    guard_binary: str = ""  # the uinput backend with a device node that does not exist
    no_uinput: str = ""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.binary = str(Path(cls.tmp.name) / "plastile-keytap")
        cls.guard_binary = str(Path(cls.tmp.name) / "plastile-keytap-no-uinput")
        cls.no_uinput = str(Path(cls.tmp.name) / "no-such-dir" / "uinput")
        for exe, defs in ((cls.binary, []), (cls.guard_binary, [f'-DKEYTAP_UINPUT_PATH="{cls.no_uinput}"'])):
            r = subprocess.run([CC, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", *defs, str(SRC), "-o", exe],
                               capture_output=True, text=True)
            if r.returncode != 0:
                raise AssertionError(f"keytap.c does not build with -Wall -Wextra -Werror {defs}:\n{r.stderr}")
        if os.path.exists(cls.no_uinput):
            raise AssertionError(f"{cls.no_uinput} exists")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_usage_needs_explicit_backend(self):
        r = subprocess.run([self.binary], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("--backend uinput|dry", r.stderr)
        r = subprocess.run([self.binary, "--backend", "libei"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)  # libei only exists in the -ei build

    def test_dry_protocol_and_timestamps(self):
        rc, out = run_dry(["ping", "tap s1 125,42 49", "tap s2 125 104", "quit", "tap s3 125 49"],
                          "--min-interval-ms", "0", "--hold-ms", "3", "--gap-ms", "1")
        self.assertEqual(rc, 0)
        self.assertEqual([o["ev"] for o in out], ["ready", "pong", "tap", "tap", "exit"])
        ready, _pong, t1, t2, ex = out
        self.assertEqual(ready["clock"], "CLOCK_MONOTONIC")
        self.assertGreaterEqual(ready["clock_res_ns"], 1)
        self.assertEqual((t1["id"], t1["mods"], t1["key"]), ("s1", [125, 42], 49))
        self.assertLessEqual(t1["t_input_ns"], t1["t_write_end_ns"])
        self.assertGreaterEqual(t1["t_release_ns"] - t1["t_write_end_ns"], 3_000_000)  # hold time
        self.assertLess(t1["t_input_ns"], t2["t_input_ns"])
        self.assertEqual(ex, {"ev": "exit", "reason": "quit", "code": 0, "taps": 2})
        # the clock is CLOCK_MONOTONIC: comparable with this process's monotonic clock
        now = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
        self.assertLess(abs(now - t2["t_input_ns"]), 60_000_000_000)

    def test_refusals(self):
        rc, out = run_dry(["tap a 42 49", "tap b 125 249", "tap c 125,125 3", "tap bad! 125 3", "tap d 125 125",
                           "tap e 125,42,29,56,97 3", "tap f", "frobnicate"], "--min-interval-ms", "0")
        self.assertEqual(rc, 0)
        errors = [o["msg"] for o in out if o["ev"] == "error"]
        self.assertEqual(len(errors), 8, errors)
        self.assertIn("needs a Meta modifier", errors[0])
        self.assertIn("bad key code", errors[1])
        self.assertIn("duplicate modifier", errors[2])
        self.assertIn("invalid id", errors[3])
        self.assertIn("also listed as a modifier", errors[4])
        self.assertIn("bad modifier list", errors[5])
        self.assertIn("usage", errors[6])
        self.assertIn("unknown command", errors[7])
        self.assertEqual(out[-1]["taps"], 0)

    def test_rate_limit_and_max_taps(self):
        rc, out = run_dry(["tap a 125 49", "tap b 125 49"], "--min-interval-ms", "60000")
        self.assertIn("min-interval", [o for o in out if o["ev"] == "error"][0]["msg"])
        rc, out = run_dry(["tap a 125 49", "tap b 125 49"], "--min-interval-ms", "0", "--max-taps", "1")
        self.assertIn("max-taps", [o for o in out if o["ev"] == "error"][0]["msg"])
        self.assertEqual(out[-1]["taps"], 1)

    def test_signal_exits_cleanly(self):
        p = subprocess.Popen([self.binary, "--backend", "dry"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.assertEqual(json.loads(p.stdout.readline())["ev"], "ready")
        p.send_signal(signal.SIGTERM)
        out, _ = p.communicate(timeout=10)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(json.loads(out.splitlines()[-1])["reason"], "signal")

    def test_a_job_control_stop_waits_for_the_key_releases(self):
        # Ctrl-Z on the orchestrator's terminal sends SIGTSTP to keytap too. Mid-tap it must not freeze the
        # process with Meta held: the tap completes (record printed, releases sent), then it stops. The
        # child gets its own process group, so the stop is not discarded as in an orphaned group.
        p = subprocess.Popen([self.binary, "--backend", "dry", "--hold-ms", "400", "--gap-ms", "100",
                              "--min-interval-ms", "0"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                             process_group=0)
        try:
            self.assertEqual(json.loads(p.stdout.readline())["ev"], "ready")
            p.stdin.write("tap a 125 30\n")
            p.stdin.flush()
            time.sleep(0.25)  # inside the hold: Meta and the key are down
            os.kill(p.pid, signal.SIGTSTP)
            ready, _, _ = select.select([p.stdout], [], [], 3.0)
            self.assertTrue(ready, "the tap did not complete after SIGTSTP (stopped with keys held)")
            rec = json.loads(p.stdout.readline())
            self.assertEqual(rec["ev"], "tap")
            self.assertLess(rec["t_release_ns"] - rec["t_input_ns"], 1_000_000_000)
            deadline = time.monotonic() + 3
            while (Path(f"/proc/{p.pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "T"
                   and time.monotonic() < deadline):
                time.sleep(0.02)
            self.assertEqual(Path(f"/proc/{p.pid}/stat").read_text().rsplit(")", 1)[1].split()[0], "T",
                             "the deferred stop was lost")
        finally:
            os.kill(p.pid, signal.SIGCONT)
            p.stdin.close()
            p.wait(timeout=10)
            p.stdout.close()

    def _uinput(self, env: dict[str, str]) -> tuple[int, list[dict]]:
        r = subprocess.run([self.guard_binary, "--backend", "uinput", "--settle-ms", "0"], input="", env=env,
                           capture_output=True, text=True, timeout=20)
        return r.returncode, [json.loads(x) for x in r.stdout.splitlines()]

    def test_uinput_guard_refuses_outside_wayland(self):
        env = {k: v for k, v in os.environ.items() if k not in ("XDG_SESSION_TYPE", "WAYLAND_DISPLAY")}
        rc, out = self._uinput(env)
        self.assertEqual(rc, 3)
        self.assertIn("not 'wayland'", out[0]["msg"])
        rc, out = self._uinput({**env, "XDG_SESSION_TYPE": "wayland"})
        self.assertEqual(rc, 3)
        self.assertIn("WAYLAND_DISPLAY is not set", out[0]["msg"])
        rc, out = self._uinput({**env, "XDG_SESSION_TYPE": "wayland", "WAYLAND_DISPLAY": "/nonexistent/wl-0"})
        self.assertEqual(rc, 3)
        self.assertIn("cannot connect", out[0]["msg"])

    def _fake_compositor(self, d: Path, name: str, *args: str) -> tuple[subprocess.Popen, Path]:
        """A process whose comm is `name`, listening on a Unix socket like a compositor."""
        exe = d / name
        exe.symlink_to(sys.executable)
        sock = d / "wl-test"
        code = ("import socket,sys,time\ns=socket.socket(socket.AF_UNIX)\ns.bind(sys.argv[1])\ns.listen(4)\n"
                "print('up',flush=True)\ntime.sleep(60)")
        p = subprocess.Popen([str(exe), "-c", code, str(sock), *args], stdout=subprocess.PIPE, text=True)
        self.assertEqual(p.stdout.readline().strip(), "up")
        return p, sock

    def test_uinput_guard_checks_the_socket_owner(self):
        env = {**os.environ, "XDG_SESSION_TYPE": "wayland"}
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            cases = [("not-a-compositor", (), "not KWin"), ("kwin_wayland", ("--virtual",), "runs nested"),
                     ("kwin_wayland", ("--wayland-display", "wayland-1"), "runs nested")]
            for i, (name, args, needle) in enumerate(cases):
                sub = d / str(i)
                sub.mkdir()
                p, sock = self._fake_compositor(sub, name, *args)
                try:
                    rc, out = self._uinput({**env, "WAYLAND_DISPLAY": str(sock)})
                finally:
                    p.kill()
                    p.wait()
                with self.subTest(name=name, args=args):
                    self.assertEqual(rc, 3, out)
                    self.assertIn(needle, out[0]["msg"])

    def test_uinput_guard_refuses_a_nested_kwin_without_a_backend_flag(self):
        # `kwin_wayland --socket wayland-2 --xwayland` (a nested Plasma's, or one run from a terminal) has the
        # live session's command-line shape; it chose the Wayland backend because WAYLAND_DISPLAY was set.
        env = {**os.environ, "XDG_SESSION_TYPE": "wayland"}
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            bindir = fake_busctl(d)
            p, sock = self._fake_compositor(d, "kwin_wayland", "--socket", "wayland-2", "--xwayland")
            cases = [({"FAKE_KWIN_PID": str(p.pid), "FAKE_BACKEND": "KWin::Wayland::WaylandBackend"}, "not DRM"),
                     ({"FAKE_KWIN_PID": str(p.pid), "FAKE_BACKEND": "KWin::VirtualBackend"}, "not DRM"),
                     ({"FAKE_KWIN_PID": "1", "FAKE_BACKEND": "DRM"}, "different sessions"),
                     ({"FAKE_BACKEND": "DRM"}, "not on the session bus")]
            try:
                for extra, needle in cases:
                    run_env = {**env, "WAYLAND_DISPLAY": str(sock), "PATH": f"{bindir}:{env.get('PATH', '')}", **extra}
                    rc, out = self._uinput(run_env)
                    with self.subTest(extra=extra):
                        self.assertEqual(rc, 3, out)
                        self.assertIn(needle, out[0]["msg"])
            finally:
                p.kill()
                p.wait()

    def test_the_test_build_never_names_the_real_device(self):
        # What makes the guard tests safe on a desktop with /dev/uinput: the build they run cannot open it.
        self.assertNotIn(b"/dev/uinput\0", Path(self.guard_binary).read_bytes())
        self.assertIn(b"/dev/uinput\0", Path(self.binary).read_bytes())

    def test_uinput_guard_passes_for_a_physical_looking_kwin(self):
        # The accepting path: a KWin-named socket owner without nested flags, owning org.kde.KWin, on DRM.
        env = {**os.environ, "XDG_SESSION_TYPE": "wayland"}
        with tempfile.TemporaryDirectory() as td:
            bindir = fake_busctl(Path(td))
            p, sock = self._fake_compositor(Path(td), "kwin_wayland", "--socket", "wayland-0", "--xwayland")
            try:
                rc, out = self._uinput({**env, "WAYLAND_DISPLAY": str(sock), "PATH": f"{bindir}:{env.get('PATH', '')}",
                                        "FAKE_KWIN_PID": str(p.pid), "FAKE_BACKEND": "DRM"})
            finally:
                p.kill()
                p.wait()
        self.assertEqual(rc, 4, out)  # past the guard; then the (test build's) device node is missing
        self.assertIn(f"cannot open {self.no_uinput}", out[0]["msg"])


if __name__ == "__main__":
    unittest.main()
