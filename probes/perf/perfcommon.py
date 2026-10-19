"""Shared helpers for the G2 performance probes (probes/perf): provenance, machine state and statistics.

Nothing here touches a compositor. Machine state is read from /proc and /sys only, and process
information is reduced to command names and counts (no arguments, no paths) so that it can be
committed with the redacted evidence.
"""
from __future__ import annotations

import json
import math
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tools/physical"))
from summarize import P99_MIN_SAMPLES, bootstrap_ci, quantile  # noqa: E402

# Paths whose state decides what was measured: the runtime (src, package), the probes, the
# harness, the fixtures and the tools that build them. A probe run from a tree with changes
# here is recorded as implementationDirty: true and is not publishable evidence.
TRACKED = ("src", "package", "probes", "tests/integration", "fixtures", "tools")
CLK_TCK = os.sysconf("SC_CLK_TCK")


def git_meta() -> dict:
    def git(*a: str) -> str:
        return subprocess.run(["git", "-C", str(ROOT), *a], capture_output=True, text=True).stdout.strip()
    dirty = git("status", "--porcelain", "--", *TRACKED)
    return {"implementationCommit": git("rev-parse", "HEAD"), "implementationDirty": bool(dirty),
            "dirtyPaths": [ln[3:] for ln in dirty.splitlines()][:20]}


def sha256(path: Path) -> str | None:
    """Content hash of a file (the bundle a unit measured), or None when it is missing."""
    import hashlib
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


def versions() -> dict:
    def out(argv: list[str]) -> str | None:
        try:
            return subprocess.run(argv, capture_output=True, text=True, timeout=10).stdout.strip() or None
        except (OSError, subprocess.TimeoutExpired):
            return None
    pkgs = {}
    for name in ("kwin", "qt6-base", "qt6-declarative", "kglobalaccel", "kactivitymanagerd", "wayland", "mesa"):
        v = out(["pacman", "-Q", name])
        pkgs[name] = v.split()[1] if v else None
    return {"kwin": out(["kwin_wayland", "--version"]), "packages": pkgs, "kernel": platform.release(),
            "python": platform.python_version(), "node": out(["node", "--version"])}


def _read(path: str) -> str | None:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def cpu_model() -> str | None:
    for line in (_read("/proc/cpuinfo") or "").splitlines():
        if line.startswith("model name"):
            return line.split(":", 1)[1].strip()
    return None


def _proc_snapshot() -> dict[int, tuple[str, int]]:
    """pid -> (comm, utime+stime ticks) for every readable process."""
    snap = {}
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            stat = Path(f"/proc/{d}/stat").read_text()
        except OSError:
            continue
        comm = stat[stat.index("(") + 1:stat.rindex(")")]
        f = stat[stat.rindex(")") + 2:].split()
        snap[int(d)] = (comm, int(f[11]) + int(f[12]))
    return snap


def machine_state(sample_s: float = 1.0) -> dict:
    """Load, governor and the busiest processes over `sample_s` (command names only).

    `otherNestedKwin` counts kwin_wayland processes started with --virtual or --wayland-display
    that are not children of this process tree: other nested sessions running on the machine.
    """
    a = _proc_snapshot()
    t0 = time.monotonic()
    time.sleep(sample_s)
    b = _proc_snapshot()
    dt = time.monotonic() - t0
    busy = []
    for pid, (comm, ticks) in b.items():
        if pid in a and a[pid][0] == comm:
            pct = (ticks - a[pid][1]) * 100.0 / CLK_TCK / dt
            if pct >= 2.0:
                busy.append((round(pct, 1), comm))
    busy.sort(reverse=True)
    nested, live = 0, 0
    for pid, (comm, _) in b.items():
        if comm != "kwin_wayland":
            continue
        args = (_read(f"/proc/{pid}/cmdline") or "").split("\0")
        if "--virtual" in args or "--wayland-display" in args:
            nested += 1
        else:
            live += 1
    gov = _read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
    epp = _read("/sys/devices/system/cpu/cpufreq/policy0/energy_performance_preference")
    return {"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "loadavg": (_read("/proc/loadavg") or "").split()[:3],
            "cpuGovernor": gov, "energyPerformancePreference": epp, "cpus": os.cpu_count(),
            "busyProcessesPct": [{"comm": c, "cpuPct": p} for p, c in busy[:8]],
            "nestedKwinRunning": nested, "liveKwinRunning": live}


def environment() -> dict:
    return {"cpu": cpu_model(), "cpus": os.cpu_count(), "memTotalKiB": int((_read("/proc/meminfo") or "0 0").split()[1]),
            "os": (_read("/etc/os-release") or "").split("\n")[0], **versions()}


def stats(xs: list[float | int]) -> dict | None:
    """Nearest-rank summary (tools/physical/summarize.quantile); p99 withheld below 5000 samples.

    p99.9 is reported only from 50000 samples (the same one-in-ten-tail rule); below that the
    worst samples are listed individually by the analysis instead.
    """
    s = sorted(x for x in xs if x is not None)
    if not s:
        return None
    out = {"n": len(s), "min": s[0], "p50": quantile(s, 0.5), "p95": quantile(s, 0.95), "p99": None,
           "max": s[-1], "mean": sum(s) / len(s)}
    if len(s) >= P99_MIN_SAMPLES:
        out["p99"] = quantile(s, 0.99)
    else:
        out["p99WithheldReason"] = f"n={len(s)} < {P99_MIN_SAMPLES} (PERFORMANCE §6.5)"
    if len(s) >= 10 * P99_MIN_SAMPLES:
        out["p999"] = quantile(s, 0.999)
    return out


def run_ci(runs: list[list[float]], stat: str, b: int = 2000, seed: int = 1) -> list[float] | None:
    """95 % percentile-bootstrap interval resampling whole runs (PERFORMANCE §6.5)."""
    import random
    return bootstrap_ci([sorted(r) for r in runs], stat, b=b, rng=random.Random(seed))


def slope(points: list[tuple[float, float]]) -> float | None:
    """Least-squares slope of y over x."""
    if len(points) < 3:
        return None
    n = len(points)
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mx) ** 2 for p in points)
    if sxx == 0:
        return None
    return sum((p[0] - mx) * (p[1] - my) for p in points) / sxx


def proc_cpu(pid: int) -> dict:
    """Per-thread CPU accounting of `pid`, keyed by thread id: ticks from stat, ns from schedstat,
    voluntary and involuntary context switches.

    schedstat is the scheduler's own run-time accounting in ns (finer than the 10 ms ticks);
    voluntary context switches are the number of times a thread blocked and was woken again,
    the closest readable proxy for wakeups. Threads are kept apart because KWin starts and ends
    worker threads: a sum over the live threads drops when one exits.
    """
    threads = {}
    for tid in os.listdir(f"/proc/{pid}/task"):
        base = f"/proc/{pid}/task/{tid}"
        try:
            st = Path(base + "/stat").read_text()
            f = st[st.rindex(")") + 2:].split()
            ss = Path(base + "/schedstat").read_text().split()
            vol = invol = 0
            for line in Path(base + "/status").read_text().splitlines():
                if line.startswith("voluntary_ctxt_switches:"):
                    vol = int(line.split()[1])
                elif line.startswith("nonvoluntary_ctxt_switches:"):
                    invol = int(line.split()[1])
            threads[tid] = (int(f[11]) + int(f[12]), int(ss[0]), vol, invol)
        except (OSError, IndexError, ValueError):
            continue
    return threads


def cpu_delta(a: dict, b: dict, seconds: float) -> dict:
    """Work done between two proc_cpu snapshots by the threads alive at the second one (a thread
    started in between counts from zero). Work of threads that ended in between is not visible
    per thread; their number is reported, and the process-level stat ticks still include it."""
    d = [0, 0, 0, 0]
    for tid, cur in b.items():
        prev = a.get(tid, (0, 0, 0, 0))
        for i in range(4):
            d[i] += cur[i] - prev[i]
    return {"seconds": round(seconds, 3), "cpuMsTicks": d[0] * 1000 // CLK_TCK, "cpuMsSchedstat": round(d[1] / 1e6, 3),
            "wakeupsVoluntary": d[2], "involuntarySwitches": d[3],
            "wakeupsPerSecond": round(d[2] / seconds, 2) if seconds else None,
            "threads": len(b), "threadsStarted": len(set(b) - set(a)), "threadsEnded": len(set(a) - set(b))}


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=1) + "\n"
    if "docs/status/evidence" in str(path):
        text = redact(text)
    path.write_text(text)


def redact(text: str) -> str:
    """No absolute repository or home paths in committed evidence."""
    return text.replace(str(ROOT), "<repo>").replace(str(Path.home()), "~")


def finite(x) -> bool:
    return isinstance(x, (int, float)) and math.isfinite(x)
