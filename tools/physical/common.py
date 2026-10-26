"""Shared helpers for Plastile's physical-session validation kit (tools/physical/).

Safety contract (docs/validation/PHYSICAL_RUNBOOK.md):

- Every live-session entry point calls guard_live_session() first. It refuses unless
  XDG_SESSION_TYPE=wayland, the WAYLAND_DISPLAY socket is served by a kwin_wayland
  (directly or through kwin_wayland_wrapper) of the same user, the session bus's
  org.kde.KWin belongs to that same process, and that KWin reports the DRM output backend
  (a nested KWin started without a backend flag looks like the physical one on its
  command line, and owns org.kde.KWin on a nested session's own bus).
- Nothing here writes kwinrc, kglobalshortcutsrc or any other user configuration.
  Configuration files are only read. The compositor is never restarted or replaced.
- Python standard library only (plus the system's busctl, kscreen-doctor, qdbus6 and
  journalctl binaries, all used read-only).
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import socket
import struct
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARTIFACTS = REPO / "artifacts" / "physical"
FIXTURE = REPO / "fixtures/client/build/plastile-fixture"
KEYTAP = REPO / "build/physical/plastile-keytap"
KEYTAP_EI = REPO / "build/physical/plastile-keytap-ei"
REPO_BUNDLE = REPO / "package/contents/code/plastile.mjs"
PLUGIN = "plastile"
MOTION_EFFECT = "plastile_motion"
MOTION_DEFAULT_MS = 180  # effect/contents/code/main.js MOTION_DEFAULT_MS (Duration 0 = default)
MOTION_EASINGS = ("OutCubic", "OutQuart", "OutQuad", "InOutCubic", "Linear")  # main.js MOTION_EASINGS
NESTED_FLAGS = ("--virtual", "--wayland-display", "--x11-display")
KWIN_COMMS = ("kwin_wayland", "kwin_wayland_wr")  # comm is truncated to 15 characters


class GuardError(RuntimeError):
    """The environment is not a live, non-nested KWin Wayland session of this user."""

    def __init__(self, reasons: list[str]):
        super().__init__("; ".join(reasons))
        self.reasons = reasons


def monotonic_ns() -> int:
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


def stamp() -> str:
    return time.strftime("%Y%m%dT%H%M%S")


# ----------------------------------------------------------------------------- /proc


def read_comm(pid: int, proc: Path = Path("/proc")) -> str | None:
    try:
        return (proc / str(pid) / "comm").read_text().strip()
    except OSError:
        return None


def read_cmdline(pid: int, proc: Path = Path("/proc")) -> list[str] | None:
    try:
        raw = (proc / str(pid) / "cmdline").read_bytes()
    except OSError:
        return None
    return [a.decode(errors="replace") for a in raw.split(b"\0") if a] or None


def read_ppid(pid: int, proc: Path = Path("/proc")) -> int | None:
    try:
        text = (proc / str(pid) / "stat").read_text()
    except OSError:
        return None
    rest = text[text.rfind(")") + 1:].split()
    return int(rest[1]) if len(rest) > 1 else None


def child_named(parent: int, name: str, proc: Path = Path("/proc")) -> int | None:
    for entry in proc.iterdir():
        if entry.name.isdigit() and read_ppid(int(entry.name), proc) == parent and read_comm(int(entry.name), proc) == name:
            return int(entry.name)
    return None


def nested_flags(cmdline: list[str]) -> list[str]:
    return [a for a in cmdline if a.split("=", 1)[0] in NESTED_FLAGS]


def rss_kib(pid: int, proc: Path = Path("/proc")) -> int | None:
    try:
        for line in (proc / str(pid) / "status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except OSError:
        return None
    return None


def cpu_ticks(pid: int, proc: Path = Path("/proc")) -> int | None:
    """utime + stime of the whole process in clock ticks."""
    try:
        rest = (proc / str(pid) / "stat").read_text()
    except OSError:
        return None
    fields = rest[rest.rfind(")") + 1:].split()
    try:
        return int(fields[11]) + int(fields[12])
    except (IndexError, ValueError):
        return None


def context_switches(pid: int, proc: Path = Path("/proc")) -> int | None:
    """Sum of voluntary + involuntary context switches over every thread (a wakeup proxy)."""
    total, seen = 0, False
    try:
        tasks = list((proc / str(pid) / "task").iterdir())
    except OSError:
        return None
    for task in tasks:
        try:
            for line in (task / "status").read_text().splitlines():
                if line.startswith(("voluntary_ctxt_switches:", "nonvoluntary_ctxt_switches:")):
                    total += int(line.split()[1])
                    seen = True
        except OSError:
            continue
    return total if seen else None


# ------------------------------------------------------------------------- compositor


def wayland_socket_path(env: dict[str, str]) -> Path | None:
    display = env.get("WAYLAND_DISPLAY")
    if not display:
        return None
    if display.startswith("/"):
        return Path(display)
    runtime = env.get("XDG_RUNTIME_DIR")
    return Path(runtime) / display if runtime else None


def socket_peer(path: Path) -> tuple[int, int, int]:
    """(pid, uid, gid) of the process that listens on a Unix socket (SO_PEERCRED)."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(2.0)
        s.connect(str(path))
        raw = s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    finally:
        s.close()
    return struct.unpack("3i", raw)


@dataclass
class Compositor:
    socket_path: str
    socket_pid: int
    socket_comm: str | None
    kwin_pid: int | None
    kwin_cmdline: list[str] | None
    nested: list[str] = field(default_factory=list)


def output_backend(support_information: str | None) -> str | None:
    """The 'Name:' of KWin's output backend section in supportInformation ('DRM' on a physical seat).

    The section heading is "Output backend" (KWin 6.7) or "LogicalOutput backend" (6.8), underlined
    with '='. Nested backends report their class name, e.g. 'KWin::VirtualBackend'.
    """
    lines = (support_information or "").splitlines()
    for i in range(len(lines) - 2):
        if lines[i].strip().lower().endswith("backend") and lines[i + 1].startswith("="):
            for line in lines[i + 2:]:
                if not line.strip():
                    break
                if line.startswith("Name: "):
                    return line[len("Name: "):].strip()
            return None
    return None


def find_compositor(env: dict[str, str], proc: Path = Path("/proc"), peer=socket_peer) -> tuple[Compositor | None, list[str]]:
    """Identify the process serving WAYLAND_DISPLAY. Returns (compositor, problems)."""
    path = wayland_socket_path(env)
    if path is None:
        return None, ["WAYLAND_DISPLAY (and XDG_RUNTIME_DIR for a relative name) must be set"]
    try:
        pid, uid, _gid = peer(path)
    except OSError as exc:
        return None, [f"cannot connect to the Wayland socket {path}: {exc}"]
    problems = []
    if uid != os.getuid():
        problems.append(f"the compositor runs as uid {uid}, this process as uid {os.getuid()} (do not use sudo)")
    comm = read_comm(pid, proc)
    kwin = None
    if comm == "kwin_wayland":
        kwin = pid
    elif comm == "kwin_wayland_wr":
        kwin = child_named(pid, "kwin_wayland", proc)
        if kwin is None:
            problems.append(f"kwin_wayland_wrapper (pid {pid}) has no kwin_wayland child")
    else:
        problems.append(f"the Wayland compositor is {comm!r} (pid {pid}), not KWin")
    cmdline = read_cmdline(kwin, proc) if kwin is not None else None
    comp = Compositor(str(path), pid, comm, kwin, cmdline)
    if kwin is not None:
        if cmdline is None:
            problems.append(f"cannot read the command line of kwin_wayland (pid {kwin})")
        else:
            comp.nested = nested_flags(cmdline)
            if comp.nested:
                problems.append(f"kwin_wayland (pid {kwin}) runs nested ({' '.join(comp.nested)}); "
                                "this kit is for the physical session only")
    return comp, problems


# ------------------------------------------------------------------------------ D-Bus


class Bus:
    """Thin busctl wrapper. address=None means the user's session bus."""

    def __init__(self, address: str | None = None):
        self.address = address

    def _base(self) -> list[str]:
        return ["busctl", f"--address={self.address}"] if self.address else ["busctl", "--user"]

    def call(self, service: str, path: str, iface: str, method: str, signature: str = "", *args,
             timeout: float = 5.0):
        if shutil.which("busctl") is None:
            raise RuntimeError("busctl not found (systemd); it is used for read-only D-Bus queries")
        cmd = self._base() + ["--json=short", f"--timeout={timeout}", "call", service, path, iface, method]
        if signature:
            cmd += [signature, *[str(a) for a in args]]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5)
        if r.returncode != 0:
            raise RuntimeError(f"D-Bus {iface}.{method} on {service}{path}: {r.stderr.strip() or r.returncode}")
        out = r.stdout.strip()
        return json.loads(out)["data"] if out else None

    def owner_pid(self, name: str) -> int | None:
        try:
            return int(self.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                                 "GetConnectionUnixProcessID", "s", name)[0])
        except (RuntimeError, ValueError, TypeError, IndexError, subprocess.TimeoutExpired):
            return None

    def script_loaded(self, plugin: str = PLUGIN) -> bool | None:
        """Read-only: org.kde.kwin.Scripting.isScriptLoaded."""
        try:
            return bool(self.call("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", "isScriptLoaded",
                                  "s", plugin)[0])
        except (RuntimeError, subprocess.TimeoutExpired):
            return None

    def effect_loaded(self, effect: str) -> bool | None:
        """Read-only: org.kde.kwin.Effects.isEffectLoaded."""
        try:
            return bool(self.call("org.kde.KWin", "/Effects", "org.kde.kwin.Effects", "isEffectLoaded", "s", effect)[0])
        except (RuntimeError, subprocess.TimeoutExpired, TypeError, IndexError):
            return None

    def support_information(self) -> str | None:
        try:
            data = self.call("org.kde.KWin", "/KWin", "org.kde.KWin", "supportInformation", timeout=10)
        except (RuntimeError, subprocess.TimeoutExpired):
            return None
        return data[0] if isinstance(data, list) and data else None


def guard_live_session(env: dict[str, str] | None = None, *, proc: Path = Path("/proc"), peer=socket_peer,
                       bus: Bus | None = None) -> dict:
    """Refuse (GuardError) unless this is a live, non-nested KWin Wayland session of this user.

    Returns facts about the compositor. Performs only reads: a connect/close on the Wayland
    socket (SO_PEERCRED), /proc reads, and one D-Bus name-owner query.
    """
    env = dict(os.environ if env is None else env)
    reasons = []
    if env.get("XDG_SESSION_TYPE") != "wayland":
        reasons.append(f"XDG_SESSION_TYPE is {env.get('XDG_SESSION_TYPE')!r}, not 'wayland'")
        raise GuardError(reasons)
    comp, problems = find_compositor(env, proc, peer)
    reasons += problems
    if comp is None or comp.kwin_pid is None:
        raise GuardError(reasons)
    bus = bus or Bus()
    owner = bus.owner_pid("org.kde.KWin")
    if owner is None:
        reasons.append("org.kde.KWin is not on the session bus (or busctl failed)")
    elif owner != comp.kwin_pid:
        reasons.append(f"org.kde.KWin on the session bus is pid {owner}, but WAYLAND_DISPLAY is served by "
                       f"kwin_wayland pid {comp.kwin_pid}: the bus and the display belong to different sessions")
    backend = None
    if owner is not None and owner == comp.kwin_pid:
        # Positive identification: only the physical seat's KWin drives outputs through DRM. A nested
        # KWin started without --virtual/--wayland-display (e.g. a nested Plasma) chooses the Wayland
        # backend itself and has a command line like the live one.
        backend = output_backend(bus.support_information())
        if backend is None:
            reasons.append(f"cannot read the output backend of kwin_wayland (pid {comp.kwin_pid}) from "
                           "org.kde.KWin supportInformation")
        elif backend != "DRM":
            reasons.append(f"kwin_wayland (pid {comp.kwin_pid}) uses the {backend!r} output backend, not DRM: it runs "
                           "nested (or headless), and uinput input would reach the physical seat's compositor instead")
    if reasons:
        raise GuardError(reasons)
    return {"socketPath": comp.socket_path, "socketPid": comp.socket_pid, "socketComm": comp.socket_comm,
            "kwinPid": comp.kwin_pid, "kwinArgs": [a for a in (comp.kwin_cmdline or [])[1:] if a.startswith("--")],
            "outputBackend": backend, "nested": False}


# --------------------------------------------------------------------- KConfig (read)


def read_kconfig(path: Path) -> dict[str, dict[str, str]]:
    """Minimal read-only KConfig INI reader: {group: {key: raw value}}.

    Nested groups ([a][b]) are joined as 'a][b'. Keys keep locale/flag suffixes such as [$i].
    """
    groups: dict[str, dict[str, str]] = {}
    current: dict[str, str] | None = None
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return groups
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith("[") and line.rstrip().endswith("]"):
            current = groups.setdefault(line.strip()[1:-1], {})
            continue
        if current is not None and "=" in line:
            key, value = line.split("=", 1)
            current[key.strip()] = value
    return groups


def _kconfig_unescape(s: str) -> str:
    out, i = [], 0
    table = {"\\": "\\", "n": "\n", "t": "\t", "r": "\r", "s": " ", ",": ",", ";": ";"}
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s) and s[i + 1] in table:
            out.append(table[s[i + 1]])
            i += 2
        else:
            out.append(s[i])
            i += 1
    return "".join(out)


def kconfig_list(value: str) -> list[str]:
    """Split a KConfig list value on unescaped commas, then unescape each element."""
    items, cur, i = [], [], 0
    while i < len(value):
        if value[i] == "\\" and i + 1 < len(value):
            cur.append(value[i:i + 2])
            i += 2
            continue
        if value[i] == ",":
            items.append("".join(cur))
            cur = []
        else:
            cur.append(value[i])
        i += 1
    items.append("".join(cur))
    return [_kconfig_unescape(x) for x in items]


def config_home(env: dict[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    return Path(env.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def motion_duration_ms(configured_ms: int, factor: float) -> int:
    """Plastile Motion's effective duration (main.js motionDuration): 0 when the global speed is instant."""
    if not factor > 0 or not math.isfinite(factor):
        return 0
    # Math.round rounds halves up; Python's round() would round them to even (2.5 -> 2).
    return max(1, math.floor((configured_ms if configured_ms > 0 else MOTION_DEFAULT_MS) * factor + 0.5))


def motion_state(bus: Bus | None, cfg_home: Path | None = None) -> dict:
    """Plastile Motion's state (PERFORMANCE section 6.1), read-only: kwinrc [Plugins] plastile_motionEnabled
    and [Effect-plastile_motion] Duration/Easing, kdeglobals [KDE] AnimationDurationFactor, and whether
    KWin has the effect loaded now (org.kde.kwin.Effects.isEffectLoaded).

    `on` is true when the effect is loaded and its effective duration is not 0; `label` names the
    state for every record and summary group ("off", or "on, Duration=... ms, speed factor ...").
    """
    cfg_home = cfg_home or config_home()
    kwinrc = read_kconfig(cfg_home / "kwinrc")
    eff = kwinrc.get(f"Effect-{MOTION_EFFECT}", {})

    def number(raw: str | None, default, kind):
        try:
            return kind(raw.strip()) if raw is not None and raw.strip() else default
        except ValueError:
            return default
    duration = number(eff.get("Duration"), 0, int)
    easing = number(eff.get("Easing"), 0, int)
    factor = number(read_kconfig(cfg_home / "kdeglobals").get("KDE", {}).get("AnimationDurationFactor"), 1.0, float)
    effective = motion_duration_ms(duration, factor)
    loaded = bus.effect_loaded(MOTION_EFFECT) if bus is not None else None
    on = bool(loaded) and effective > 0
    if loaded is None:
        label = "unknown (isEffectLoaded unavailable)"
    elif on:
        label = f"on, Duration={duration or MOTION_DEFAULT_MS} ms, speed factor {factor:g}"
    else:
        label = "off"
    return {"loaded": loaded, "enabledInKwinrc": kwinrc.get("Plugins", {}).get(f"{MOTION_EFFECT}Enabled", "unset").strip(),
            "durationMs": duration,
            "easing": MOTION_EASINGS[easing] if 0 <= easing < len(MOTION_EASINGS) else MOTION_EASINGS[0],
            "animationDurationFactor": factor, "effectiveDurationMs": effective, "on": on, "label": label}


def shortcut_bindings(path: Path, component: str | None = None) -> dict[str, dict[str, list[str]]]:
    """{component: {action: [active key sequences]}} from kglobalshortcutsrc (read-only).

    An entry is 'active,default,friendly name'; active and default are tab-separated lists;
    'none' (or empty) means unbound.
    """
    result: dict[str, dict[str, list[str]]] = {}
    for group, entries in read_kconfig(path).items():
        if component is not None and group != component:
            continue
        actions = {}
        for key, raw in entries.items():
            if key.startswith("_k_friendly_name"):
                continue
            parts = kconfig_list(raw)
            active = parts[0] if parts else ""
            seqs = [s for s in active.split("\t") if s and s.lower() != "none"]
            actions[key] = seqs
        result[group] = actions
    return result


def duplicate_bindings(bindings: dict[str, dict[str, list[str]]]) -> dict[str, list[str]]:
    """Key sequences bound to more than one action (across components), 'component/action' lists."""
    owners: dict[str, list[str]] = {}
    for comp, actions in bindings.items():
        for action, seqs in actions.items():
            for seq in seqs:
                owners.setdefault(seq, []).append(f"{comp}/{action}")
    return {seq: who for seq, who in owners.items() if len(who) > 1}


# ------------------------------------------------------------------ key sequences


MODIFIER_CODES = {"Meta": 125, "Shift": 42, "Ctrl": 29, "Alt": 56}
KEY_CODES = {
    **{chr(ord("A") + i): c for i, c in enumerate(
        [30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44])},
    **{str(d): c for d, c in zip(range(10), [11, 2, 3, 4, 5, 6, 7, 8, 9, 10])},
    **{f"F{i}": c for i, c in zip(range(1, 13), [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88])},
    "Esc": 1, "Escape": 1, "Tab": 15, "Backspace": 14, "Return": 28, "Enter": 28, "Space": 57,
    "Left": 105, "Right": 106, "Up": 103, "Down": 108, "PgUp": 104, "PgDown": 109, "Home": 102, "End": 107,
    "Ins": 110, "Del": 111, "Print": 99,
    "-": 12, "=": 13, "[": 26, "]": 27, ";": 39, "'": 40, "`": 41, "\\": 43, ",": 51, ".": 52, "/": 53,
}
# Characters that need Shift on a US layout: (unshifted key, needs Shift).
US_SHIFTED = {"+": "=", "_": "-", "{": "[", "}": "]", ":": ";", '"': "'", "~": "`", "|": "\\", "<": ",",
              ">": ".", "?": "/", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
              "*": "8", "(": "9", ")": "0"}


class KeySpecError(ValueError):
    pass


def parse_sequence(seq: str) -> tuple[list[int], int]:
    """Qt portable key sequence text ('Meta+Shift+N') -> (modifier evdev codes, key evdev code).

    Physical key positions assume a US layout; a non-US layout needs --binding with evdev
    names (KEY_...) instead. Multi-chord sequences ('Meta+K, Meta+L') are rejected.
    """
    seq = seq.strip()
    if not seq or ", " in seq:
        raise KeySpecError(f"unsupported key sequence {seq!r} (single chords only)")
    if seq.startswith("KEY_") or "+KEY_" in seq:
        return _parse_evdev_names(seq)
    if seq.endswith("++"):  # the '+' key itself: "Meta++"
        parts = seq[:-2].split("+") if seq[:-2] else []
        key = "+"
    else:
        parts = seq.split("+")
        key = parts.pop()
    mods = []
    for p in parts:
        if p not in MODIFIER_CODES:
            raise KeySpecError(f"unknown modifier {p!r} in {seq!r}")
        if MODIFIER_CODES[p] not in mods:
            mods.append(MODIFIER_CODES[p])
    if key in US_SHIFTED:
        key = US_SHIFTED[key]
        if MODIFIER_CODES["Shift"] not in mods:
            mods.append(MODIFIER_CODES["Shift"])
    code = KEY_CODES.get(key) or KEY_CODES.get(key.upper() if len(key) == 1 else key)
    if code is None:
        raise KeySpecError(f"no evdev mapping for key {key!r} in {seq!r}; pass --binding ACTION=KEY_...+KEY_...")
    return mods, code


EVDEV_NAMES = {
    "KEY_LEFTMETA": 125, "KEY_RIGHTMETA": 126, "KEY_LEFTSHIFT": 42, "KEY_RIGHTSHIFT": 54, "KEY_LEFTCTRL": 29,
    "KEY_RIGHTCTRL": 97, "KEY_LEFTALT": 56, "KEY_RIGHTALT": 100,
    **{f"KEY_{k}": v for k, v in KEY_CODES.items() if k.isalnum() and k.isupper() or k.isdigit()},
    "KEY_ESC": 1, "KEY_TAB": 15, "KEY_BACKSPACE": 14, "KEY_ENTER": 28, "KEY_SPACE": 57, "KEY_LEFT": 105,
    "KEY_RIGHT": 106, "KEY_UP": 103, "KEY_DOWN": 108, "KEY_PAGEUP": 104, "KEY_PAGEDOWN": 109, "KEY_HOME": 102,
    "KEY_END": 107, "KEY_INSERT": 110, "KEY_DELETE": 111, "KEY_MINUS": 12, "KEY_EQUAL": 13, "KEY_LEFTBRACE": 26,
    "KEY_RIGHTBRACE": 27, "KEY_SEMICOLON": 39, "KEY_APOSTROPHE": 40, "KEY_GRAVE": 41, "KEY_BACKSLASH": 43,
    "KEY_COMMA": 51, "KEY_DOT": 52, "KEY_SLASH": 53, "KEY_SYSRQ": 99,
}
MODIFIER_SET = {125, 126, 42, 54, 29, 97, 56, 100}


def _parse_evdev_names(seq: str) -> tuple[list[int], int]:
    names = seq.split("+")
    codes = []
    for n in names:
        if n not in EVDEV_NAMES:
            raise KeySpecError(f"unknown evdev key name {n!r}")
        codes.append(EVDEV_NAMES[n])
    key = codes.pop()
    return codes, key


def has_meta(mods: list[int]) -> bool:
    return 125 in mods or 126 in mods


# ------------------------------------------------------------------ outputs & files


def kscreen_outputs() -> list[dict] | None:
    """Read-only `kscreen-doctor -j`: connected outputs with mode, refresh, scale, priority."""
    if shutil.which("kscreen-doctor") is None:
        return None
    try:
        r = subprocess.run(["kscreen-doctor", "-j"], capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired:
        return None
    if r.returncode != 0:
        return None
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        return None
    return parse_kscreen(data)


def parse_kscreen(data: dict) -> list[dict]:
    result = []
    for o in data.get("outputs", []):
        if not o.get("connected"):
            continue
        mode = next((m for m in o.get("modes", []) if m.get("id") == o.get("currentModeId")), {})
        result.append({
            "name": o.get("name"), "enabled": o.get("enabled"), "priority": o.get("priority"), "pos": o.get("pos"),
            "scale": o.get("scale"), "rotation": o.get("rotation"), "size": mode.get("size"),
            "refreshRate": mode.get("refreshRate"), "vrrPolicy": o.get("vrrPolicy"),
        })
    return result


def sha256_file(path: Path) -> str | None:
    import hashlib
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


# What a physical run is built from or runs: the bundle's sources and build configuration (tools/build.mjs,
# package.json, tsconfig), the QML package, Plastile Motion and the persistence helper (both installed into the
# session from this checkout), the fixture client and this kit. The installed bundle is hashed separately.
IMPLEMENTATION_PATHS = ("src", "package", "effect", "helper", "fixtures", "tools", "package.json", "package-lock.json",
                        "tsconfig.json", "tsconfig.runtime.json")


def git_revision(repo: Path = REPO) -> tuple[str | None, bool | None]:
    try:
        rev = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10)
        dirty = subprocess.run(["git", "-C", str(repo), "status", "--porcelain", "--", *IMPLEMENTATION_PATHS],
                               capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None, None
    if rev.returncode != 0:
        return None, None
    return rev.stdout.strip(), bool(dirty.stdout.strip())


def write_jsonl(path: Path, records) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r, sort_keys=True) + "\n")
            n += 1
    return n


def read_jsonl(path: Path) -> list[dict]:
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # a line cut off by a crash; the raw file keeps it
    return out


def confirm(prompt: str, assume_yes: bool) -> bool:
    if assume_yes:
        print(prompt + " [--yes given]")
        return True
    try:
        return input(prompt + " Type 'yes' to continue: ").strip().lower() == "yes"
    except EOFError:
        return False


SAFE_TEXT = re.compile(r"[^A-Za-z0-9 ._:+/-]")


def redact_text(s: str | None, limit: int = 120) -> str | None:
    return None if s is None else SAFE_TEXT.sub("?", s)[:limit]
