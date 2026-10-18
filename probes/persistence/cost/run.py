#!/usr/bin/env python3
"""Compositor-thread cost of persistence through the plastile-state helper (ADR-020), nested KWin only.

Phase A (store.qml): the production Persistence.qml store. For 1, 16 and 64 KiB texts, n samples each, one write
per 20 ms tick (the next only after the previous reply), alternating slots: the time KWin's thread spends in the
write() call (building the DBusCall and sending the message) and the time to its reply (the helper's QSaveFile
commit with fsync, in the helper's process). At load: the read() call and its reply, the first time including the
helper's D-Bus activation, then on reloads with two 64 KiB slots.
Phase B (commands.qml, the production bundle with perf: true and diagnostics debug):
  B1, bursts of preference-changing commands while inotify watches the state directory. Each command's handler
  interval (plastile perf entryNs + dispatchToReturnNs) and the inotify timestamps share CLOCK_MONOTONIC: no
  state-file event may fall inside a command or within 1.5 s after one, and one save follows each burst. Each save's
  issueNs (snapshot build + serialize + the store call) comes from "state save issued".
  B2, a typical snapshot (2 contexts, 2 floats) and a full one (64 contexts, 64 floats, about 25 KB): reload cycles;
  applyNs (parse + apply of the Read reply, inside the reply callback) from "saved state loaded", and issueNs of the
  save after one command.

The old QtCore Settings measurement (ADR-013 addendum, docs/status/evidence/persistence-t27-cost.json) came from
this directory's run.py at commit 7a27cf7 (git show 7a27cf7:probes/persistence/cost/run.py); that store no longer
exists.

The state directories live under artifacts/ on the repository's filesystem (recorded), not tmpfs.

Usage: python3 probes/persistence/cost/run.py [--samples 250] [--publish docs/status/evidence/persistence-helper-cost.json]
Requires: npm run build, build/measure (tools/measure/README.md), build/helper, make -C fixtures/client.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "tests/integration"))
from nested import NestedKwin  # noqa: E402
from harness import STATE_HELPER, Session, state_service_file  # noqa: E402
from scenarios_persist import DESKTOP_ID, WRITE_EVENTS, Inotify, describe, write_slot, xdg  # noqa: E402
import sysinfo  # noqa: E402

MEASURE = ROOT / "build/measure/qml"
COST = re.compile(r"PLT cost (\{.*\})$")
PERF = re.compile(r"plastile perf (\{.*\})$")
ISSUED = re.compile(r"plastile debug state save issued (\{.*\})$")
LOADED = re.compile(r"plastile info saved state loaded (\{.*\})$")


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


def phase_store(out: Path, samples: int, reloads: int) -> dict:
    state = out / "store-state"
    (state / "plastile").mkdir(parents=True, exist_ok=True)
    qml = HERE / "store.qml"
    res: dict = {"stateFilesystem": fs_of(state)}
    with NestedKwin(out / "store", extra_env={"QML_IMPORT_PATH": str(MEASURE), "XDG_STATE_HOME": str(state)},
                    dbus_services=state_service_file()) as kw:
        root = HERE / "store.run.qml"
        root.write_text(qml.read_text().replace("property int samples: 250", f"property int samples: {samples}"))
        reload_root = HERE / "store.reload.qml"
        reload_root.write_text(qml.read_text().replace("property int samples: 250", "property int samples: 0"))
        try:
            off = kw.mark()
            kw.load_declarative(root, "plastilepersistcost")
            kw.wait_log(r"PLT cost done", 900, off)
            time.sleep(0.2)
            recs = [json.loads(COST.search(ln).group(1)) for ln in kw.lines_since(off, r"PLT cost \{")]
            kw.unload("plastilepersistcost")
            loads = [r for r in recs if r["kind"] == "load"]
            writes = [r for r in recs if r["kind"] == "write"]
            # Reloads with both slots holding the last 64 KiB texts: the Read Plastile issues at start-up.
            for _ in range(reloads):
                off = kw.mark()
                kw.load_declarative(reload_root, "plastilepersistcost")
                ln = kw.wait_log(r"PLT cost \{\"kind\":\"load\"", 10, off)[-1]
                kw.unload("plastilepersistcost")
                loads.append(json.loads(COST.search(ln).group(1)))
                time.sleep(0.1)
        finally:
            root.unlink(missing_ok=True)
            reload_root.unlink(missing_ok=True)
        files = {p.name: p.stat().st_size for p in (state / "plastile").iterdir()}
    res["loads"] = {
        "firstWithActivation": loads[0],
        "reloadsWith64KiBSlots": {"callUs": us(q([r["callNs"] for r in loads[1:]])),
                                  "replyUs": us(q([r["replyNs"] for r in loads[1:]])),
                                  "chars": loads[-1].get("chars")}}
    res["writes"] = {}
    for kb in (1, 16, 64):
        ws = [r for r in writes if r["kb"] == kb]
        res["writes"][f"{kb}KiB"] = {"chars": ws[0]["chars"] if ws else None, "callUs": us(q([r["callNs"] for r in ws])),
                                     "replyUs": us(q([r["replyNs"] for r in ws])),
                                     "callsOver1ms": sum(1 for r in ws if r["callNs"] > 1e6),
                                     "failed": sum(1 for r in ws if not r["ok"])}
    warm = [r for r in recs if r["kind"] == "warmup"]
    res["warmupWrites"] = [{"kb": r["kb"], "callUs": round(r["callNs"] / 1000, 1), "replyUs": round(r["replyNs"] / 1000, 1)}
                           for r in warm]
    res["slotFileBytesAfter"] = files
    res["rawWrites"] = writes
    return res


def full_snapshot(generation: int, n: int = 64) -> str:
    """A snapshot with n contexts and n floats; n = 64 is the largest Plastile writes (MAX_CONTEXTS, MAX_FLOATS)."""
    area = {"x": 0, "y": 0, "width": 1280, "height": 800}
    contexts = [{"outputKey": "Virtual-0" if i == 0 else f"edid:Vendor/Model-{i:02d}/SERIAL{i:04d}",
                 "desktopId": DESKTOP_ID, "activity": "default", "layout": None if i % 3 else "bsp",
                 "masterStack": {"ratio": 0.6, "masterCount": 1} if i % 3 else None} for i in range(n)]
    floats = [{"appId": f"org.example.application{i:02d}", "resourceName": f"application{i:02d}", "role": f"MainWindow#{i}",
               "rect": {"x": 100 + i, "y": 80 + i, "width": 640, "height": 480}, "outputKey": "Virtual-0", "area": area}
              for i in range(n)]
    return json.dumps({"schemaVersion": 1, "generation": generation, "savedAt": "2026-10-18T00:00:00.000Z",
                       "contexts": contexts, "floats": floats}, separators=(",", ":"))


def phase_commands(out: Path, bursts: int, per_burst: int, seed: int, cycles: int) -> dict:
    rng = random.Random(seed)
    base = out / "cmd-xdg"
    xdg(base)
    cmds = ["resize.grow", "resize.shrink", "master.increase", "master.decrease", "layout.bsp", "layout.master-stack"]
    res: dict = {"bursts": bursts, "commandsPerBurst": per_burst, "commands": cmds}
    env = {"QML_IMPORT_PATH": str(MEASURE), "XDG_STATE_HOME": str(base / "state")}
    with Session(out / "commands", qml=HERE / "commands.qml", config={"diagnostics": "debug"}, extra_env=env) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        off0 = s.kw.mark()
        s.load()
        s.kw.wait_log(r"plastile info (no saved state|saved state)", 10, off0)
        s.settle()
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        watch = Inotify(base / "state/plastile")
        off = s.kw.mark()
        burst_ends = []
        try:
            for b in range(bursts):
                for k in range(per_burst):
                    s.cmd(cmds[(b * per_burst + k) % len(cmds)])
                    time.sleep(rng.uniform(0.05, 0.4))
                # The cycle above nets out; one more step makes each burst end in a new state.
                s.cmd("resize.grow")
                time.sleep(rng.uniform(0.05, 0.4))
                burst_ends.append(time.monotonic())
                time.sleep(3.5)
        finally:
            watch.close()
        perf = [json.loads(PERF.search(ln).group(1)) for ln in s.log_lines(r"plastile perf \{", off)]
        issued = [json.loads(ISSUED.search(ln).group(1)) for ln in s.log_lines(r"plastile debug state save issued ", off)]
        intervals = [(p["entryNs"], p["entryNs"] + p["dispatchToReturnNs"]) for p in perf]
        events = [(int(t * 1e9), m, n) for t, m, n in watch.events]
        inside = [e for e in events if any(a <= e[0] <= b + 1_000_000 for a, b in intervals)]  # +1 ms read margin
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
            "savesIssued": issued,
            "issueUs": us(q([x["issueNs"] for x in issued if x.get("issueNs") is not None])),
            "issueBreakdownUs": {k: us(q([x[k] for x in issued if x.get(k) is not None]))
                                 for k in ("buildNs", "serializeNs", "callNs")},
            "secondsFromBurstEndToSave": [round(w - e, 3) for w, e in zip(write_groups, burst_ends)],
            "eventSample": describe(watch.events[:14], watch.events[0][0] if watch.events else 0),
        })
    # B2: a snapshot in slot 0; each cycle loads it (applyNs) and saves it after one command (issueNs).
    res["typicalSnapshot"] = reload_cycles(out, "typical", 2, cycles)
    res["fullSnapshot"] = reload_cycles(out, "full", 64, cycles)
    return res


def reload_cycles(out: Path, name: str, n: int, cycles: int) -> dict:
    base = out / f"{name}-xdg"
    xdg(base)
    write_slot(base, 0, full_snapshot(1, n))
    applied, full_issued = [], []
    with Session(out / name, qml=HERE / "commands.qml", config={"diagnostics": "debug"},
                 extra_env={"QML_IMPORT_PATH": str(MEASURE), "XDG_STATE_HOME": str(base / "state")}) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        for i in range(cycles):
            off = s.kw.mark()
            s.load()
            ln = s.kw.wait_log(r"plastile (info|warn) (saved state|no saved state)", 10, off)[-1]
            m = LOADED.search(ln)
            if m:
                applied.append(json.loads(m.group(1)))
            s.settle()
            s.act("plastile-fixture 1", "workspace.activeWindow = w")
            s.cmd("resize.grow" if i % 2 == 0 else "resize.shrink")
            ln = s.kw.wait_log(r"plastile debug state saved ", 8, off)
            full_issued += [json.loads(ISSUED.search(x).group(1)) for x in s.log_lines(r"plastile debug state save issued ", off)]
            s.unload()
        return {
            "entries": {"contexts": n, "floats": n},
            "slotBytes": {p.name: p.stat().st_size for p in (base / "state/plastile").iterdir()},
            "cycles": cycles, "loads": len(applied), "loadSummaries": applied[:2],
            "applyUs": us(q([a["applyNs"] for a in applied if a.get("applyNs") is not None])),
            "issueUs": us(q([x["issueNs"] for x in full_issued if x.get("issueNs") is not None])),
            "issueBreakdownUs": {k: us(q([x[k] for x in full_issued if x.get(k) is not None]))
                                 for k in ("buildNs", "serializeNs", "callNs")},
            "parseUs": us(q([a["parseNs"] for a in applied if a.get("parseNs") is not None])),
            "issuedBytes": sorted({x["bytes"] for x in full_issued}),
        }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=250)
    ap.add_argument("--reloads", type=int, default=20)
    ap.add_argument("--bursts", type=int, default=3)
    ap.add_argument("--per-burst", type=int, default=40)
    ap.add_argument("--cycles", type=int, default=10)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--publish", type=Path)
    args = ap.parse_args()
    for need in (MEASURE, ROOT / "package/contents/code/plastile.mjs", STATE_HELPER):
        if not need.exists():
            sys.exit(f"missing {need}: build tools/measure and the helper (build/helper), and run npm run build")
    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = ROOT / "artifacts/persistence-cost" / stamp
    rev = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "src", "package", "probes", "helper"],
                                capture_output=True, text=True).stdout.strip())
    result = {
        "experiment": "Compositor-thread cost of persistence through the plastile-state helper (ADR-020)",
        "layer": "nested KWin virtual backend (not physical)",
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "implementationCommit": rev, "implementationDirty": dirty,
        "kwin": subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip(),
        "qtbase": sysinfo.component_version("qt6-base"),
        "helper": str(STATE_HELPER.relative_to(ROOT)) if STATE_HELPER.is_relative_to(ROOT) else "PLASTILE_STATE_HELPER",
        "cpus": os.cpu_count(),
        "clock": "CLOCK_MONOTONIC via tools/measure (inside KWin) and time.monotonic (harness, inotify)",
        "note": "Other agents' nested-KWin suites may have been running on this machine; tails include that noise.",
    }
    result["store"] = phase_store(out, args.samples, args.reloads)
    result["commands"] = phase_commands(out, args.bursts, args.per_burst, args.seed, args.cycles)
    raw = result["store"].pop("rawWrites")
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
