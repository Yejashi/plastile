"""Distribution-neutral package and helper lookups for probes and integration tests.

The first nested runs happened on Arch Linux (pacman, /usr/lib/<helper>); the second
environment is Ubuntu 26.10 (dpkg, /usr/lib/<multiarch>/libexec/<helper>); the Nix
environment (tools/sandbox/nix) has no package database, so file owners come from the
`/nix/store/<hash>-<name>-<version>` path and helpers from PATH. Every
lookup returns None instead of raising when a tool or package is absent, so a
missing version string can never turn into a scenario failure.
"""
from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess

# Logical component -> package names per packaging family.
PACKAGE_NAMES: dict[str, dict[str, tuple[str, ...]]] = {
    "kwin": {"pacman": ("kwin",), "dpkg": ("kwin-wayland",), "rpm": ("kwin-wayland", "kwin")},
    "xwayland": {"pacman": ("xorg-xwayland",), "dpkg": ("xwayland",), "rpm": ("xorg-x11-server-Xwayland",)},
    "kactivitymanagerd": {"pacman": ("kactivitymanagerd",), "dpkg": ("kactivitymanagerd",),
                          "rpm": ("kactivitymanagerd",)},
    "qt6-declarative": {"pacman": ("qt6-declarative",), "dpkg": ("libqt6qml6",), "rpm": ("qt6-qtdeclarative",)},
}


def _run(argv: list[str]) -> str | None:
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def packaging() -> str | None:
    for tool, name in (("pacman", "pacman"), ("dpkg-query", "dpkg"), ("rpm", "rpm")):
        if shutil.which(tool):
            return name
    return None


def package_version(name: str) -> str | None:
    """Installed version of a distribution package name, or None."""
    fam = packaging()
    if fam == "pacman":
        out = _run(["pacman", "-Q", name])
        return out.split()[1] if out and len(out.split()) > 1 else None
    if fam == "dpkg":
        out = _run(["dpkg-query", "-W", "-f=${Status}\t${Version}", name])
        if out and out.startswith("install ok installed\t"):
            return out.split("\t", 1)[1]
        return None
    if fam == "rpm":
        return _run(["rpm", "-q", "--qf", "%{VERSION}-%{RELEASE}", name])
    return None


def component_version(component: str) -> str | None:
    """`<package> <version>` for a logical component (see PACKAGE_NAMES), or None."""
    fam = packaging()
    for name in PACKAGE_NAMES.get(component, {}).get(fam or "", (component,)):
        v = package_version(name)
        if v:
            return f"{name} {v}"
    return None


def owning_package(path: str) -> str | None:
    """`<package> <version>` owning a file, or None."""
    real = os.path.realpath(path)
    # Nix store paths (tools/sandbox/nix) carry `<name>-<version>` in the path itself.
    m = re.match(r"/nix/store/[0-9a-z]{32}-([^/]+)/", real)
    if m:
        return m.group(1)
    fam = packaging()
    if fam == "pacman":
        out = _run(["pacman", "-Qo", real])
        m = re.search(r"is owned by (\S+) (\S+)", out or "")
        return f"{m.group(1)} {m.group(2)}" if m else None
    if fam == "dpkg":
        for candidate in (real, path):
            out = _run(["dpkg-query", "-S", candidate])
            if out:
                name = out.split(":", 1)[0].split(",")[0].strip()
                v = package_version(name)
                return f"{name} {v}" if v else name
        return None
    if fam == "rpm":
        return _run(["rpm", "-qf", "--qf", "%{NAME} %{VERSION}-%{RELEASE}", real])
    return None


def binary_version(binary: str) -> str | None:
    path = shutil.which(binary)
    return owning_package(path) if path else None


def find_helper(name: str) -> str | None:
    """Locate a helper that distributions install outside PATH (e.g. kactivitymanagerd)."""
    found = shutil.which(name)
    if found:
        return found
    candidates = [f"/usr/lib/{name}", f"/usr/libexec/{name}", f"/usr/lib64/libexec/{name}",
                  f"/usr/lib/libexec/{name}", *sorted(glob.glob(f"/usr/lib/*/libexec/{name}"))]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None
