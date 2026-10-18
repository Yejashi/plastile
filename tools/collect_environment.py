#!/usr/bin/env python3
"""T00 environment profile: read-only inventory of the machine and live session.

Only read-only queries are made (package database, /proc, kscreen-doctor -j,
KWin/kglobalaccel D-Bus getters, config file reads). Nothing is loaded into or
changed in the live compositor.

Writes:
  artifacts/environment/<stamp>/raw/*        raw command output (private; gitignored)
  artifacts/environment/<stamp>/profile.json redacted profile
  --publish PATH                             also copy the redacted profile to PATH

Redaction: no hostname, machine-id, user name, output serial numbers, EDID,
window titles, or full config dumps in profile.json.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from configparser import ConfigParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import sysinfo  # noqa: E402
PACKAGES = [
    "kwin", "plasma-workspace", "plasma-desktop", "breeze", "kdecoration", "kscreen", "libkscreen",
    "qt6-base", "qt6-declarative", "qt6-wayland", "kcoreaddons", "kconfig", "kglobalaccel", "kpackage",
    "kwindowsystem", "plasma-activities", "xorg-xwayland", "wayland", "wayland-protocols", "mesa",
    "libdrm", "linux", "nodejs", "npm", "typescript", "cmake", "gcc", "clang", "python", "python-dbus",
]
# Debian/Ubuntu names for the same components (Ubuntu 26.10 sandbox, tools/sandbox/).
DPKG_PACKAGES = [
    "kwin-wayland", "kwin-common", "plasma-workspace", "plasma-desktop", "kwin-style-breeze", "libkdecorations3-6",
    "kscreen", "libkscreen-bin", "libqt6core6t64", "libqt6qml6", "qt6-wayland", "libkf6coreaddons6",
    "libkf6config6", "libkf6globalaccel6", "libkf6package6", "libkf6windowsystem6", "kactivitymanagerd",
    "xwayland", "libwayland-client0", "wayland-protocols", "libgl1-mesa-dri", "libdrm2", "cmake", "gcc",
    "clang", "python3", "python3-dbus",
]
TOOLS = ["kwin_wayland", "kpackagetool6", "qdbus6", "busctl", "dbus-daemon", "kscreen-doctor", "qml6",
         "wayland-scanner", "cmake", "g++", "clang", "node", "npm", "tsc", "python3", "getcap",
         "weston", "cage", "gamescope", "wlr-randr", "perf", "valgrind"]


def run(cmd: list[str], timeout: float = 10.0) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + (r.stderr if r.returncode else "")
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return -1, str(exc)


def packages() -> dict[str, str | None]:
    names = DPKG_PACKAGES if sysinfo.packaging() == "dpkg" else PACKAGES
    return {name: sysinfo.package_version(name) for name in names}


def os_release() -> dict[str, str]:
    data = {}
    for line in Path("/etc/os-release").read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            data[k] = v.strip('"')
    return {k: data[k] for k in ("NAME", "ID", "BUILD_ID", "VERSION_ID") if k in data}


def hardware() -> dict:
    cpu = next((ln.split(":", 1)[1].strip() for ln in Path("/proc/cpuinfo").read_text().splitlines()
                if ln.startswith("model name")), None)
    mem_kib = int(next(ln.split()[1] for ln in Path("/proc/meminfo").read_text().splitlines()
                       if ln.startswith("MemTotal")))
    _, lspci = run(["lspci"])
    gpus = [ln.split(": ", 1)[1] for ln in lspci.splitlines() if re.search(r"VGA|3D|Display", ln)]
    gov = Path("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
    epp = Path("/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference")
    return {
        "cpu": cpu, "logicalCpus": os.cpu_count(), "memTotalGiB": round(mem_kib / 1048576, 1), "gpus": gpus,
        "cpuGovernor": gov.read_text().strip() if gov.exists() else None,
        "cpuEnergyPerformancePreference": epp.read_text().strip() if epp.exists() else None,
    }


def support_information(raw_dir: Path) -> dict:
    code, text = run(["qdbus6", "org.kde.KWin", "/KWin", "supportInformation"])
    (raw_dir / "kwin-supportInformation.txt").write_text(text)
    if code != 0:
        return {"error": text.strip()[:200]}
    info: dict = {}
    for key, rx in {
        "kwinVersion": r"^KWin version: (.+)$", "qtVersion": r"^Qt Version: (.+)$",
        "operationMode": r"^Operation Mode: (.+)$", "compositingType": r"^Compositing Type: (.+)$",
        "openglRenderer": r"^OpenGL renderer string: (.+)$", "openglVersion": r"^OpenGL version string: (.+)$",
        "openglPlatform": r"^OpenGL platform interface: (.+)$",
    }.items():
        m = re.search(rx, text, re.M)
        info[key] = m.group(1).strip() if m else None
    m = re.search(r"^Loaded Effects:\n-+\n(.*?)\n\n", text, re.M | re.S)
    info["loadedEffects"] = sorted(m.group(1).split()) if m else None
    # Options relevant to tiling behaviour.
    for opt in ("perOutputVirtualDesktops", "separateScreenFocus", "focusPolicy", "electricBorderTiling",
                "electricBorderMaximize", "borderlessMaximizedWindows", "placement", "windowSnapZone",
                "focusStealingPreventionLevel", "allowTearing", "animationSpeed"):
        m = re.search(rf"^{opt}: (.+)$", text, re.M)
        info.setdefault("options", {})[opt] = m.group(1).strip() if m else None
    return info


def outputs(raw_dir: Path) -> list[dict] | dict:
    code, text = run(["kscreen-doctor", "-j"])
    (raw_dir / "kscreen-doctor.json").write_text(text)
    if code != 0:
        return {"error": text.strip()[:200]}
    data = json.loads(text)
    result = []
    for o in data.get("outputs", []):
        if not o.get("connected"):
            continue
        mode = next((m for m in o.get("modes", []) if m.get("id") == o.get("currentModeId")), {})
        result.append({
            "connector": o.get("name"), "type": o.get("type"), "enabled": o.get("enabled"),
            "priority": o.get("priority"), "pos": o.get("pos"), "scale": o.get("scale"),
            "rotation": o.get("rotation"), "mode": {"size": mode.get("size"), "refreshRate": mode.get("refreshRate")},
            "vrrPolicy": o.get("vrrPolicy"), "hdr": o.get("hdr"), "sizeMM": o.get("sizeMM"),
        })
    return result


def dbus_get(service: str, path: str, iface: str, prop: str):
    code, text = run(["qdbus6", service, path, "org.freedesktop.DBus.Properties.Get", iface, prop])
    return text.strip() if code == 0 else None


def kwin_config() -> dict:
    cfg_dir = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    result: dict = {}
    kwinrc = ConfigParser(interpolation=None, strict=False)
    kwinrc.optionxform = str
    try:
        kwinrc.read(cfg_dir / "kwinrc")
    except Exception as exc:  # malformed user config must not abort inventory
        result["kwinrcError"] = str(exc)[:200]
    plugins = dict(kwinrc["Plugins"]) if kwinrc.has_section("Plugins") else {}
    result["pluginsExplicitlyEnabled"] = sorted(k[:-7] for k, v in plugins.items() if k.endswith("Enabled") and v == "true")
    result["pluginsExplicitlyDisabled"] = sorted(k[:-7] for k, v in plugins.items() if k.endswith("Enabled") and v == "false")
    tiling = [s for s in kwinrc.sections() if s.startswith("Tiling")]
    result["nativeTilingSections"] = len(tiling)
    result["nativeTilingPaddings"] = sorted({kwinrc[s].get("padding") for s in tiling if kwinrc[s].get("padding")})
    result["decorationLibrary"] = kwinrc.get("org.kde.kdecoration2", "library", fallback=None)
    rules = ConfigParser(interpolation=None, strict=False)
    try:
        rules.read(cfg_dir / "kwinrulesrc")
        result["windowRuleCount"] = rules.getint("General", "count", fallback=0)
    except Exception:
        result["windowRuleCount"] = None
    shortcuts = (cfg_dir / "kglobalshortcutsrc")
    if shortcuts.exists():
        text = shortcuts.read_text(errors="replace")
        m = re.search(r"^Edit Tiles=([^\n]*)$", text, re.M)
        result["kwinEditTilesShortcut"] = m.group(1).split(",")[0] if m else None
        result["metaBindingsInKwinComponent"] = len(re.findall(r"^[^\n=]+=Meta\+", _section(text, "kwin"), re.M))
    for base in (Path("/usr/share/kwin/scripts"), Path.home() / ".local/share/kwin/scripts",
                 Path("/usr/share/kwin-wayland/scripts")):
        if base.exists():
            result.setdefault("installedScripts", {})[str(base).replace(str(Path.home()), "~")] = sorted(
                p.name for p in base.iterdir() if p.is_dir())
    return result


def _section(text: str, name: str) -> str:
    m = re.search(rf"^\[{re.escape(name)}\]\n(.*?)(?=^\[|\Z)", text, re.M | re.S)
    return m.group(1) if m else ""


def tools() -> dict:
    out = {}
    for t in TOOLS:
        out[t] = shutil.which(t) is not None
    _, caps = run(["getcap", "/usr/bin/kwin_wayland"])
    out["kwinWaylandFileCapabilities"] = caps.strip().split(" ", 1)[1] if " " in caps.strip() else None
    _, node = run(["node", "--version"])
    out["nodeVersion"] = node.strip() or None
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--publish", type=Path, default=None)
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = ROOT / "artifacts/environment" / stamp
    raw = out / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    _, rev = run(["git", "-C", str(ROOT), "rev-parse", "HEAD"])
    _, dirty = run(["git", "-C", str(ROOT), "status", "--porcelain"])
    profile = {
        "schemaVersion": 1,
        "collectedAtLocal": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "collector": "tools/collect_environment.py (read-only)",
        "repository": {"revision": rev.strip(), "dirty": bool(dirty.strip())},
        "os": os_release(),
        "kernel": platform.release(),
        "hardware": hardware(),
        "session": {k: os.environ.get(k) for k in ("XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "KDE_SESSION_VERSION")},
        "packages": packages(),
        "kwin": support_information(raw),
        "outputs": outputs(raw),
        "virtualDesktops": {
            "count": dbus_get("org.kde.KWin", "/VirtualDesktopManager", "org.kde.KWin.VirtualDesktopManager", "count"),
            "rows": dbus_get("org.kde.KWin", "/VirtualDesktopManager", "org.kde.KWin.VirtualDesktopManager", "rows"),
        },
        "activities": None,
        "config": kwin_config(),
        "tools": tools(),
    }
    code, acts = run(["qdbus6", "org.kde.ActivityManager", "/ActivityManager/Activities", "ListActivities"])
    profile["activities"] = {"serviceAvailable": code == 0, "count": len(acts.split()) if code == 0 else None}
    (out / "profile.json").write_text(json.dumps(profile, indent=1) + "\n")
    if args.publish:
        args.publish.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(out / "profile.json", args.publish)
    print(out / "profile.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
