"""Guards, read-only KConfig/shortcut parsing and key-sequence mapping (no desktop)."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import common  # noqa: E402


class FakeProc:
    """A fake /proc tree: {pid: (comm, ppid, cmdline list)}."""

    def __init__(self, procs: dict[int, tuple[str, int, list[str]]]):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        for pid, (comm, ppid, argv) in procs.items():
            d = root / str(pid)
            d.mkdir()
            (d / "comm").write_text(comm + "\n")
            (d / "stat").write_text(f"{pid} ({comm}) S {ppid} 0 0 0\n")
            (d / "cmdline").write_bytes(b"\0".join(a.encode() for a in argv) + b"\0")
        self.path = root


def support_info(backend: str | None, heading: str = "LogicalOutput backend") -> str:
    """A KWin supportInformation text with the output backend section (6.8.1 layout, measured)."""
    section = "" if backend is None else f"{heading}\n{'=' * len(heading)}\nName: {backend}\n"
    return ("KWin Support Information:\n\nVersion\n=======\nKWin version: 6.8.1\n\n" + section +
            "Atomic Mode Setting on GPU 0: true\n\nOutputs\n=======\nOutput 0:\nName: DP-1\n")


class FakeBus:
    def __init__(self, owner: int | None, backend: str | None = "DRM", effect: bool | None = False):
        self.owner = owner
        self.backend = backend
        self.effect = effect

    def owner_pid(self, name):
        return self.owner

    def support_information(self):
        return support_info(self.backend)

    def effect_loaded(self, name):
        return self.effect


ENV = {"XDG_SESSION_TYPE": "wayland", "WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": "/run/user/1000"}


def peer(pid, uid=None):
    return lambda path: (pid, os.getuid() if uid is None else uid, 0)


class GuardTests(unittest.TestCase):
    def test_wrapper_with_kwin_child_passes(self):
        p = FakeProc({100: ("kwin_wayland_wr", 1, ["/usr/bin/kwin_wayland_wrapper", "--xwayland"]),
                      101: ("kwin_wayland", 100, ["/usr/bin/kwin_wayland", "--wayland-fd", "7", "--socket",
                                                  "wayland-0", "--xwayland"])})
        info = common.guard_live_session(ENV, proc=p.path, peer=peer(100), bus=FakeBus(101))
        self.assertEqual(info["kwinPid"], 101)
        self.assertIn("--wayland-fd", info["kwinArgs"])

    def test_direct_kwin_passes(self):
        p = FakeProc({200: ("kwin_wayland", 1, ["kwin_wayland", "--xwayland"])})
        self.assertEqual(common.guard_live_session(ENV, proc=p.path, peer=peer(200), bus=FakeBus(200))["kwinPid"], 200)

    def test_refusals(self):
        nested = FakeProc({300: ("kwin_wayland", 1, ["kwin_wayland", "--virtual", "--socket", "wl-0"])})
        other = FakeProc({400: ("gnome-shell", 1, ["gnome-shell"])})
        lonely = FakeProc({500: ("kwin_wayland_wr", 1, ["kwin_wayland_wrapper"])})
        cases = [
            ({**ENV, "XDG_SESSION_TYPE": "x11"}, nested, peer(300), FakeBus(300), "not 'wayland'"),
            ({k: v for k, v in ENV.items() if k != "XDG_SESSION_TYPE"}, nested, peer(300), FakeBus(300), "not 'wayland'"),
            (ENV, nested, peer(300), FakeBus(300), "runs nested"),
            (ENV, other, peer(400), FakeBus(400), "not KWin"),
            (ENV, lonely, peer(500), FakeBus(500), "no kwin_wayland child"),
            (ENV, FakeProc({200: ("kwin_wayland", 1, ["kwin_wayland"])}), peer(200, uid=os.getuid() + 1),
             FakeBus(200), "do not use sudo"),
            (ENV, FakeProc({200: ("kwin_wayland", 1, ["kwin_wayland"])}), peer(200), FakeBus(999), "different sessions"),
            (ENV, FakeProc({200: ("kwin_wayland", 1, ["kwin_wayland"])}), peer(200), FakeBus(None), "not on the session bus"),
            ({"XDG_SESSION_TYPE": "wayland"}, nested, peer(300), FakeBus(300), "WAYLAND_DISPLAY"),
        ]
        for env, procs, pr, bus, needle in cases:
            with self.subTest(needle=needle):
                with self.assertRaises(common.GuardError) as cm:
                    common.guard_live_session(env, proc=procs.path, peer=pr, bus=bus)
                self.assertTrue(any(needle in r for r in cm.exception.reasons), cm.exception.reasons)

    def test_nested_kwin_without_a_backend_flag_is_refused(self):
        # A nested Plasma (dbus-run-session startplasma-wayland) or `kwin_wayland --socket X` run from a
        # terminal picks the Wayland backend itself: same command-line shape as the live session, and it
        # owns org.kde.KWin on its own bus. Only the output backend tells them apart.
        p = FakeProc({500: ("kwin_wayland_wr", 1, ["kwin_wayland_wrapper", "--xwayland"]),
                      501: ("kwin_wayland", 500, ["kwin_wayland", "--wayland-fd", "7", "--socket", "wayland-2",
                                                  "--xwayland"])})
        for backend, needle in (("KWin::Wayland::WaylandBackend", "not DRM"), ("KWin::VirtualBackend", "not DRM"),
                                (None, "cannot read the output backend")):
            with self.subTest(backend=backend):
                with self.assertRaises(common.GuardError) as cm:
                    common.guard_live_session(ENV, proc=p.path, peer=peer(500), bus=FakeBus(501, backend))
                self.assertTrue(any(needle in r for r in cm.exception.reasons), cm.exception.reasons)
        info = common.guard_live_session(ENV, proc=p.path, peer=peer(500), bus=FakeBus(501, "DRM"))
        self.assertEqual(info["outputBackend"], "DRM")

    def test_output_backend_parsing(self):
        self.assertEqual(common.output_backend(support_info("DRM")), "DRM")
        self.assertEqual(common.output_backend(support_info("DRM", heading="Output backend")), "DRM")  # KWin 6.7
        self.assertEqual(common.output_backend(support_info("KWin::VirtualBackend")), "KWin::VirtualBackend")
        self.assertIsNone(common.output_backend(support_info(None)))  # the outputs' "Name: DP-1" is not it
        self.assertIsNone(common.output_backend(None))

    def test_unreachable_socket(self):
        def boom(path):
            raise ConnectionRefusedError("refused")
        with self.assertRaises(common.GuardError) as cm:
            common.guard_live_session(ENV, peer=boom, bus=FakeBus(1))
        self.assertIn("cannot connect", cm.exception.reasons[0])

    def test_real_socket_peer_credentials(self):
        import socket
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "wl"
            srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            srv.bind(str(path))
            srv.listen(1)
            try:
                pid, uid, _gid = common.socket_peer(path)
            finally:
                srv.close()
        self.assertEqual((pid, uid), (os.getpid(), os.getuid()))


SHORTCUTS = r"""[$Version]
update_info=kded.upd:kde4

[kwin]
Edit Tiles=Meta+T,Meta+T,Toggle Tiles Editor
Window Maximize=Meta+PgUp,Meta+PgUp,Maximize Window
_k_friendly_name=KWin
plastile.focus.next=Meta+Shift+N,Meta+Shift+N,Plastile: Focus next
plastile.resize.grow=Meta+Ctrl+=,Meta+Shift+=,Plastile: Grow focused tile
plastile.layout.bsp=none,none,Plastile: BSP layout
plastile.swap.master=Meta+Shift+Return\tMeta+Ctrl+M,Meta+Shift+Return,Plastile: Swap with master
plastile.comma=Meta+\,,none,Plastile: comma test
plastile.runtime.toggle-suspend=Meta+Shift+S,Meta+Shift+S,Plastile: Suspend/resume tiling

[org.kde.spectacle.desktop]
RectangularRegionScreenShot=Meta+Shift+S,Meta+Shift+S,Capture Rectangular Region
_k_friendly_name=Spectacle
"""


class KConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "kglobalshortcutsrc"
        self.path.write_text(SHORTCUTS)

    def test_kconfig_list(self):
        self.assertEqual(common.kconfig_list(r"Meta+\,,none,x"), ["Meta+,", "none", "x"])
        self.assertEqual(common.kconfig_list(r"a\tb,c"), ["a\tb", "c"])
        self.assertEqual(common.kconfig_list(r"a\\,b"), ["a\\", "b"])

    def test_shortcut_bindings(self):
        b = common.shortcut_bindings(self.path)
        kwin = b["kwin"]
        self.assertEqual(kwin["plastile.focus.next"], ["Meta+Shift+N"])
        self.assertEqual(kwin["plastile.resize.grow"], ["Meta+Ctrl+="])  # active, not default
        self.assertEqual(kwin["plastile.layout.bsp"], [])
        self.assertEqual(kwin["plastile.swap.master"], ["Meta+Shift+Return", "Meta+Ctrl+M"])
        self.assertEqual(kwin["plastile.comma"], ["Meta+,"])
        self.assertNotIn("_k_friendly_name", kwin)
        self.assertEqual(list(common.shortcut_bindings(self.path, "kwin")), ["kwin"])

    def test_duplicates(self):
        d = common.duplicate_bindings(common.shortcut_bindings(self.path))
        self.assertEqual(sorted(d["Meta+Shift+S"]), ["kwin/plastile.runtime.toggle-suspend",
                                                     "org.kde.spectacle.desktop/RectangularRegionScreenShot"])

    def test_missing_file_reads_empty(self):
        self.assertEqual(common.shortcut_bindings(Path(self.tmp.name) / "nope"), {})


class KeySequenceTests(unittest.TestCase):
    def test_qt_sequences(self):
        self.assertEqual(common.parse_sequence("Meta+Shift+N"), ([125, 42], 49))
        self.assertEqual(common.parse_sequence("Meta+Shift+Return"), ([125, 42], 28))
        self.assertEqual(common.parse_sequence("Meta+PgUp"), ([125], 104))
        self.assertEqual(common.parse_sequence("Meta+Alt+Right"), ([125, 56], 106))
        self.assertEqual(common.parse_sequence("Meta+Ctrl+="), ([125, 29], 13))
        self.assertEqual(common.parse_sequence("Meta+Shift+="), ([125, 42], 13))
        self.assertEqual(common.parse_sequence("Meta++"), ([125, 42], 13))  # '+' is Shift+= on US
        self.assertEqual(common.parse_sequence("Meta+Shift+-"), ([125, 42], 12))
        self.assertEqual(common.parse_sequence("Meta+Shift+Space"), ([125, 42], 57))
        self.assertEqual(common.parse_sequence("Meta+T"), ([125], 20))
        self.assertEqual(common.parse_sequence("Meta+F12"), ([125], 88))

    def test_evdev_names(self):
        self.assertEqual(common.parse_sequence("KEY_LEFTMETA+KEY_LEFTCTRL+KEY_EQUAL"), ([125, 29], 13))
        self.assertEqual(common.parse_sequence("KEY_RIGHTMETA+KEY_N"), ([126], 49))

    def test_rejections(self):
        for seq in ("", "Meta+K, Meta+L", "Hyper+N", "Meta+Ü", "KEY_LEFTMETA+KEY_NOPE"):
            with self.subTest(seq=seq), self.assertRaises(common.KeySpecError):
                common.parse_sequence(seq)

    def test_has_meta(self):
        self.assertTrue(common.has_meta([125, 42]))
        self.assertFalse(common.has_meta([29, 56]))


class MotionStateTests(unittest.TestCase):
    def _state(self, kwinrc: str, kdeglobals: str = "", effect: bool | None = True) -> dict:
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "kwinrc").write_text(kwinrc)
            (Path(d) / "kdeglobals").write_text(kdeglobals)
            return common.motion_state(FakeBus(1, effect=effect), Path(d))

    def test_owner_setup_is_on_with_the_default_duration(self):
        m = self._state("[Effect-plastile_motion]\nDebug=false\n\n[Plugins]\nplastile_motionEnabled=true\n")
        self.assertTrue(m["on"])
        self.assertEqual((m["durationMs"], m["effectiveDurationMs"], m["easing"]), (0, 180, "OutCubic"))
        self.assertEqual(m["label"], "on, Duration=180 ms, speed factor 1")

    def test_duration_and_speed_factor(self):
        m = self._state("[Effect-plastile_motion]\nDuration=200\nEasing=4\n", "[KDE]\nAnimationDurationFactor=0.5\n")
        self.assertEqual((m["effectiveDurationMs"], m["easing"]), (100, "Linear"))
        self.assertEqual(m["label"], "on, Duration=200 ms, speed factor 0.5")

    def test_off_when_not_loaded_or_instant(self):
        self.assertEqual(self._state("", effect=False)["label"], "off")
        m = self._state("[Plugins]\nplastile_motionEnabled=true\n", "[KDE]\nAnimationDurationFactor=0\n")
        self.assertFalse(m["on"])
        self.assertEqual(m["label"], "off")
        self.assertTrue(self._state("", effect=None)["label"].startswith("unknown"))

    def test_effective_duration_rounds_like_the_effect(self):
        # main.js motionDuration uses Math.round, which rounds a half up (Python's round() goes to even).
        cases = {(5, 0.5): 3, (3, 0.5): 2, (1, 0.5): 1, (0, 1.0): 180, (0, 0.25): 45, (101, 0.5): 51, (200, 0.0): 0}
        self.assertEqual({k: common.motion_duration_ms(*k) for k in cases}, cases)


class GitRevisionTests(unittest.TestCase):
    def test_every_installed_or_built_path_counts(self):
        # The bundle's build configuration, Plastile Motion and the helper are installed into the session from
        # the checkout too, not only src, package, the fixtures and this kit.
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
            git = lambda *a: subprocess.run(["git", "-C", d, *a], check=True, capture_output=True, env=env)  # noqa: E731
            files = ("src/a.ts", "effect/contents/code/main.js", "helper/main.cpp", "tools/install.sh",
                     "tools/physical/common.py", "package.json", "docs/x.md")
            for rel in files:
                (repo / rel).parent.mkdir(parents=True, exist_ok=True)
                (repo / rel).write_text("1\n")
            git("init", "-q")
            git("add", "-A")
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
            self.assertFalse(common.git_revision(repo)[1])
            for rel in files:
                (repo / rel).write_text("2\n")
                with self.subTest(rel=rel):
                    self.assertEqual(common.git_revision(repo)[1], rel != "docs/x.md")
                git("checkout", "-q", "--", rel)


class KscreenTests(unittest.TestCase):
    def test_parse_kscreen(self):
        data = {"outputs": [
            {"name": "DP-1", "connected": True, "enabled": True, "priority": 3, "pos": {"x": 0, "y": 0}, "scale": 1,
             "rotation": 1, "currentModeId": "2", "vrrPolicy": 0, "serial": "SECRET",
             "modes": [{"id": "1", "size": {"width": 1280, "height": 720}, "refreshRate": 60},
                       {"id": "2", "size": {"width": 1920, "height": 1080}, "refreshRate": 60.0}]},
            {"name": "HDMI-A-2", "connected": False}]}
        [o] = common.parse_kscreen(data)
        self.assertEqual(o["name"], "DP-1")
        self.assertEqual(o["size"], {"width": 1920, "height": 1080})
        self.assertNotIn("serial", o)


if __name__ == "__main__":
    unittest.main()
