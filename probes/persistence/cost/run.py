#!/usr/bin/env python3
"""T27 cost of in-process saves (ADR-013 addendum), nested KWin only.

Phase A (cost.qml): the production Persistence.qml store; setValue and sync() timed with the
CLOCK_MONOTONIC measurement module for 1, 16 and 64 KiB texts, n samples each, one write per
20 ms Timer tick, alternating slots; open()+read() at load (first load in the process, then
reloads, which QSettings serves from its in-process cache after a stat).
Phase B (lock.qml): one save while the slot's QLockFile is (1) stale (dead pid) and (2) held by a
live process: the time the save blocks the compositor thread.
Phase C (commands.qml): the production bundle with persistence; bursts of preference-changing
commands while inotify watches the state directory. Each command's handler interval
(plastile perf entryNs + dispatchToReturnNs) and the inotify timestamps share CLOCK_MONOTONIC:
no state-file event may fall inside a command, and one save follows each burst.

The state directories live under artifacts/ on the repository's filesystem (recorded), not
tmpfs, so sync() includes the filesystem's real work for this (virtual) disk.

Usage: python3 probes/persistence/cost/run.py [--samples 250] [--publish docs/status/evidence/persistence-t27-cost.json]
Requires: npm run build, build/measure (tools/measure/README.md), make -C fixtures/client.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "tests/integration"))
from nested import NestedKwin  # noqa: E402
from harness import Session  # noqa: E402
from scenarios_persist import WRITE_EVENTS, Inotify, describe  # noqa: E402
import sysinfo  # noqa: E402

MEASURE = ROOT / "build/measure/qml"
COST = re.compile(r"PLT cost (\{.*\})$")
LOCK = re.compile(r"PLT lock (\{.*\})$")
PERF = re.compile(r"plastile perf (\{.*\})$")
SAVED = re.compile(r"plastile debug state saved (\{.*\})$")


def q(xs):
    s = sorted(xs)
    if not s:
        return None
    p = lambda f: s[min(len(s) - 1, int(f * (len(s) - 1)))]  # noqa: E731
    return {"n": len(s), "min": s[0], "p50": p(0.5), "p95": p(0.95), "p99": p(0.99), "max": s[-1],
            "mean": round(sum(s) / len(s), 1)}


def us(summary):
    return None if summary is None else {k: (round(v / 1000, 1) if k not in ("n",) else v) for k, v in summary.items()}


def fs_of(path: Path) -> str:
    r = subprocess.run(["findmnt", "-n", "-o", "FSTYPE,SOURCE,OPTIONS", "-T", str(path)], capture_output=True, text=True)
    return r.stdout.strip() or "unknown"


def phase_cost(out: Path, samples: int, reloads: int) -> dict:
    state = out / "cost-state"
    (state / "plastile").mkdir(parents=True, exist_ok=True)
    qml = HERE / "cost.qml"
    res: dict = {"stateFilesystem": fs_of(state)}
    with NestedKwin(out / "cost", extra_env={"QML_IMPORT_PATH": str(MEASURE), "XDG_STATE_HOME": str(state)}) as kw:
        # Another sample count runs a copy of the root beside it (its relative imports need that place).
        root = qml
        if samples != 250:
            root = HERE / "cost.run.qml"
            root.write_text(qml.read_text().replace("property int samples: 250", f"property int samples: {samples}"))
        try:
            off = kw.mark()
            kw.load_declarative(root, "plastilepersistcost")
            kw.wait_log(r"PLT cost done", 600, off)
            recs = [json.loads(COST.search(ln).group(1)) for ln in kw.lines_since(off, r"PLT cost \{")]
            kw.unload("plastilepersistcost")
            loads = [r for r in recs if r["kind"] == "load"]
            writes = [r for r in recs if r["kind"] == "write"]
            # Reloads with both slots holding 64 KiB: open()+read() as Plastile does before its first solve.
            for _ in range(reloads):
                off = kw.mark()
                kw.load_declarative(root, "plastilepersistcost")
                ln = kw.wait_log(r"PLT cost \{\"kind\":\"load\"", 10, off)[-1]
                kw.unload("plastilepersistcost")
                loads.append(json.loads(COST.search(ln).group(1)))
                time.sleep(0.1)
        finally:
            if root != qml:
                root.unlink(missing_ok=True)
        files = {p.name: p.stat().st_size for p in (state / "plastile").iterdir()}
    res["loads"] = {"firstInProcess": loads[0], "reloadsWith64KiBSlots": {
        "openUs": us(q([r["openNs"] for r in loads[2:]])), "readUs": us(q([r["readNs"] for r in loads[2:]])),
        "chars": loads[-1]["chars"]}, "secondLoadAfterWrites": loads[1] if len(loads) > 1 else None}
    res["writes"] = {}
    for kb in (1, 16, 64):
        ws = [r for r in writes if r["kb"] == kb]
        res["writes"][f"{kb}KiB"] = {"chars": ws[0]["chars"] if ws else None, "syncUs": us(q([r["syncNs"] for r in ws])),
                                     "setValueUs": us(q([r["setValueNs"] for r in ws])),
                                     "totalUs": us(q([r["totalNs"] for r in ws])),
                                     "over1ms": sum(1 for r in ws if r["totalNs"] > 1e6)}
    warm = [r for r in recs if r["kind"] == "warmup"]
    res["warmupWrites"] = [{"kb": r["kb"], "totalUs": round(r["totalNs"] / 1000, 1), "createsFile": i < 2}
                           for i, r in enumerate(warm)]
    res["slotFileBytesAfter"] = files
    res["rawWrites"] = writes
    return res


def lock_text(pid: int, name: str) -> str:
    # QLockFile's format (Qt 6 qlockfile.cpp lockFileContents): pid, process name, host name[, machine id, boot id].
    return f"{pid}\n{name}\n{socket.gethostname()}\n"


def phase_lock(out: Path) -> dict:
    res: dict = {}
    qml = HERE / "lock.qml"
    for case in ("stale", "held"):
        state = out / f"lock-{case}"
        d = state / "plastile"
        d.mkdir(parents=True, exist_ok=True)
        holder = None
        if case == "stale":
            p = subprocess.Popen(["true"])
            p.wait()
            (d / "state-0.ini.lock").write_text(lock_text(p.pid, "true"))
        else:
            holder = subprocess.Popen(["sleep", "300"])
            (d / "state-0.ini.lock").write_text(lock_text(holder.pid, "sleep"))
        try:
            with NestedKwin(out / f"lock-{case}-kwin", extra_env={"QML_IMPORT_PATH": str(MEASURE),
                                                                   "XDG_STATE_HOME": str(state)}) as kw:
                off = kw.mark()
                kw.load_declarative(qml, "plastilepersistlock")
                try:
                    ln = kw.wait_log(r"PLT lock \{\"writeNs\"", 90, off)[-1]
                    r = json.loads(LOCK.search(ln).group(1))
                    res[case] = {"writeMs": round(r["writeNs"] / 1e6, 3),
                                 "lockFileAfter": (d / "state-0.ini.lock").exists(),
                                 "slotWritten": (d / "state-0.ini").exists()}
                except Exception as exc:  # noqa: BLE001
                    res[case] = {"error": str(exc)[:300]}
        finally:
            if holder:
                holder.kill()
                holder.wait()
    return res


def phase_commands(out: Path, bursts: int, per_burst: int, seed: int) -> dict:
    rng = random.Random(seed)
    state = out / "cmd-state"
    (state / "plastile").mkdir(parents=True, exist_ok=True)
    cmds = ["resize.grow", "resize.shrink", "master.increase", "master.decrease", "layout.bsp", "layout.master-stack"]
    res: dict = {"bursts": bursts, "commandsPerBurst": per_burst, "commands": cmds}
    with Session(out / "commands", qml=HERE / "commands.qml", config={"diagnostics": "debug"},
                 extra_env={"QML_IMPORT_PATH": str(MEASURE), "XDG_STATE_HOME": str(state)}) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        s.load(); s.settle()
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        watch = Inotify(state / "plastile")
        off = s.kw.mark()
        burst_ends = []
        try:
            for b in range(bursts):
                for k in range(per_burst):
                    s.cmd(cmds[(b * per_burst + k) % len(cmds)])
                    time.sleep(rng.uniform(0.05, 0.4))
                # The cycle above nets out; one more step makes each burst end in a new state, so each
                # burst has something to save (unchanged content is not rewritten).
                s.cmd("resize.grow")
                time.sleep(rng.uniform(0.05, 0.4))
                burst_ends.append(time.monotonic())
                time.sleep(3.5)
        finally:
            watch.close()
        perf = [json.loads(PERF.search(ln).group(1)) for ln in s.log_lines(r"plastile perf \{", off)]
        saved = [json.loads(SAVED.search(ln).group(1)) for ln in s.log_lines(r"plastile debug state saved ", off)]
    intervals = [(p["entryNs"], p["entryNs"] + p["dispatchToReturnNs"]) for p in perf]
    events = [(int(t * 1e9), m, n) for t, m, n in watch.events]
    inside = [e for e in events if any(a <= e[0] <= b + 1_000_000 for a, b in intervals)]  # +1 ms read latency margin
    # Every event must come at least 1.5 s after the newest command handler that preceded it.
    early = []
    for e in events:
        prior = [b for a, b in intervals if b <= e[0]]
        if prior and (e[0] - max(prior)) < 1.5e9:
            early.append(e)
    write_groups = []
    for t, m, n in watch.events:
        if m & WRITE_EVENTS and (not write_groups or t - write_groups[-1] > 1.0):
            write_groups.append(t)
    res.update({
        "commandHandlers": len(perf), "accepted": sum(1 for p in perf if p["status"] == "accepted"),
        "dispatchToReturnUs": us(q([p["dispatchToReturnNs"] for p in perf])),
        "stateFileEvents": len(events), "eventsInsideCommandHandlers": len(inside),
        "eventsWithin1500msAfterACommand": len(early), "saves": len(write_groups),
        "savesLogged": saved,
        "productionWriteUs": us(q([x["writeNs"] for x in saved if x.get("writeNs") is not None])),
        "secondsFromBurstEndToSave": [round(w - e, 3) for w, e in zip(write_groups, burst_ends)],
        "eventSample": describe(watch.events[:14], watch.events[0][0] if watch.events else 0),
    })
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=250)
    ap.add_argument("--reloads", type=int, default=20)
    ap.add_argument("--bursts", type=int, default=3)
    ap.add_argument("--per-burst", type=int, default=40)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--skip-lock", action="store_true")
    ap.add_argument("--publish", type=Path)
    args = ap.parse_args()
    for need in (MEASURE, ROOT / "package/contents/code/plastile.mjs"):
        if not need.exists():
            sys.exit(f"missing {need}: build tools/measure and run npm run build")
    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = ROOT / "artifacts/persistence-cost" / stamp
    rev = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "src", "package", "probes"],
                                capture_output=True, text=True).stdout.strip())
    result = {
        "experiment": "T27 cost of in-process QtCore Settings saves (ADR-013 addendum)",
        "layer": "nested KWin virtual backend (not physical)",
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "implementationCommit": rev, "implementationDirty": dirty,
        "kwin": subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip(),
        "qtcoreQmlModule": sysinfo.component_version("qt6-declarative"),
        "cpus": os.cpu_count(),
        "clock": "CLOCK_MONOTONIC via tools/measure (inside KWin) and time.monotonic (harness, inotify)",
        "note": "Another nested-KWin suite may have been running on this 4-CPU machine; tails include that noise.",
    }
    result["cost"] = phase_cost(out, args.samples, args.reloads)
    if not args.skip_lock:
        result["lock"] = phase_lock(out)
    result["commands"] = phase_commands(out, args.bursts, args.per_burst, args.seed)
    raw = result["cost"].pop("rawWrites")
    out.mkdir(parents=True, exist_ok=True)
    (out / "raw-writes.json").write_text(json.dumps(raw))
    text = json.dumps(result, indent=1)
    print(text)
    (out / "result.json").write_text(text + "\n")
    if args.publish:
        args.publish.write_text(text + "\n")
    c = result["commands"]
    ok = c["eventsInsideCommandHandlers"] == 0 and c["eventsWithin1500msAfterACommand"] == 0 and c["saves"] == args.bursts
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
