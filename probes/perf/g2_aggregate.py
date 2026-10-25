#!/usr/bin/env python3
"""Aggregate a G2 campaign (probes/perf/campaign.py) into the committed, redacted evidence.

Inputs: artifacts/g2/<campaign>/{plan.json,manifest.jsonl,units/<id>/...} (local, never committed).
Outputs (docs/status/evidence/, no window titles, no user paths):
  g2-campaign.json            provenance: commit, versions, hardware, seed, unit order, machine state per unit
  g2-p03.json                 P03 cells (n x workload x mode): pooled and per-run statistics, gates,
                              work per command, client stages, instrumentation overhead, tail analysis
  g2-p03-samples.csv.xz       every P03 sample (PERFORMANCE §8 fields first, then the stage columns)
  g2-baselines.json           P01/P02 (no tiler, KWin quick tile) and Polonium vs Plastile, pooled by run
  g2-baselines-samples.csv.xz every baseline sample
  g2-lifecycle.json           P05 bursts, the P05 n=32 boundary, P07/P12/P13 and root teardown
  g2-churn.json               P14 reload cycles, P15 churn, idle pairs, and their no-tiler controls
  g2-rss-bisect.json          the P14 memory bisection (--rss-campaign)
  g2-p04-node.json            P04 in Node (--p04; informational, not QV4)

Statistics: nearest-rank quantiles (tools/physical/summarize); p99 is withheld below 5000 samples;
95 % confidence intervals are percentile bootstraps over whole runs. Every sample is kept: warm-up
samples (declared before the run) are summarized separately, failures are counted by reason and
kept out of the latency statistics (PERFORMANCE §6.8: a fast failure is not a latency sample); their
own timing is reported as failedOuter.

Usage: python3 probes/perf/g2_aggregate.py artifacts/g2/<campaign> [--evidence docs/status/evidence]
         [--churn-campaign DIR --superseded TEXT] [--gc-campaign DIR] [--rss-campaign DIR] [--p04 pure.json]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import lzma
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import perfcommon as pc  # noqa: E402
from summarize import bootstrap_diff_ci  # noqa: E402  (tools/physical, on sys.path via perfcommon)

WORKLOADS = ("ratio", "swap", "master", "focus", "noop")
ORDINARY = ("ratio", "swap", "master", "focus")
SOLVING = ("ratio", "swap", "master")
BOOT = 2000
GC_DIRS: list[Path] = []  # further campaigns holding GC diagnostic units (--gc-campaign)


def jl(path: Path) -> list[dict]:
    return [json.loads(ln) for ln in path.read_text().splitlines() if ln.strip()] if path.exists() else []


def ms(v):
    return None if v is None else round(v / 1e6, 4)


def stat_ms(st: dict | None) -> dict | None:
    if not st:
        return None
    out = {"n": st["n"]}
    for k in ("min", "p50", "p95", "p99", "p999", "max", "mean"):
        if st.get(k) is not None:
            out[k] = round(st[k] / 1e6, 4)
    if "p99WithheldReason" in st:
        out["p99WithheldReason"] = st["p99WithheldReason"]
    return out


def ci_ms(runs: list[list[float]], stat: str, seed: int = 1) -> list[float] | None:
    ci = pc.run_ci([r for r in runs if r], stat, b=BOOT, seed=seed)
    return [round(ci[0] / 1e6, 4), round(ci[1] / 1e6, 4)] if ci else None


def by_run(rows: list[dict], key: str) -> dict[str, list[float]]:
    out: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        if r.get(key) is not None:
            out[r["runId"]].append(r[key])
    return out


def metric(rows: list[dict], key: str, seed: int = 1) -> dict | None:
    runs = by_run(rows, key)
    allx = [x for xs in runs.values() for x in xs]
    if not allx:
        return None
    pooled = stat_ms(pc.stats(allx))
    out = {"pooled": pooled, "runs": len(runs),
           "perRun": {k: {kk: v for kk, v in (stat_ms(pc.stats(xs)) or {}).items() if kk in ("n", "p50", "p95", "max")}
                      for k, xs in sorted(runs.items())},
           "ci95ByRun": {"p50": ci_ms(list(runs.values()), "median", seed), "p95": ci_ms(list(runs.values()), "p95", seed)}}
    if pooled.get("p99") is not None:
        out["ci95ByRun"]["p99"] = ci_ms(list(runs.values()), "p99", seed)
    return out


# ------------------------------------------------------------------------- campaign
def campaign(cdir: Path) -> tuple[dict, dict[str, dict]]:
    plan = json.loads((cdir / "plan.json").read_text())
    units: dict[str, dict] = {}
    for r in jl(cdir / "manifest.jsonl"):
        u = units.setdefault(r["id"], {"id": r["id"]})
        if r["event"] == "start":
            u.update(order=r["order"], start=r["t"], machine=r["machine"], commit=r["implementationCommit"],
                     dirty=r["implementationDirty"])
        else:
            u.update(rc=r["rc"], seconds=r["seconds"], end=r["t"], machineAfter=r["machineAfter"])
    loads = [float(u["machine"]["loadavg"][0]) for u in units.values() if u.get("machine")]
    busy = Counter()
    for u in units.values():
        for b in (u.get("machine") or {}).get("busyProcessesPct", []):
            busy[b["comm"]] += 1
    prov = {"seed": plan["seed"], "implementationCommit": plan["implementationCommit"],
            "implementationDirty": plan["implementationDirty"], "environment": plan["environment"],
            "unitsPlanned": len(plan["units"]), "unitsRun": sum(1 for u in units.values() if "rc" in u),
            "unitsFailed": sorted(u["id"] for u in units.values() if u.get("rc") not in (0, None)),
            "allUnitsFromCleanTree": all(not u.get("dirty") for u in units.values()),
            "allUnitsSameCommit": len({u.get("commit") for u in units.values()}) == 1,
            "otherNestedKwinAtUnitStart": sorted({u["id"] for u in units.values()
                                                  if (u.get("machine") or {}).get("nestedKwinRunning")}),
            "load1mAtUnitStart": {"min": min(loads), "max": max(loads), "mean": round(sum(loads) / len(loads), 2)} if loads else None,
            "cpuGovernor": sorted({(u.get("machine") or {}).get("cpuGovernor") for u in units.values()} - {None}),
            "energyPerformancePreference": sorted({(u.get("machine") or {}).get("energyPerformancePreference") for u in units.values()} - {None}),
            "backgroundProcessesSeenBusy": {k: v for k, v in busy.most_common(12)},
            "units": [{"order": u.get("order"), "id": u["id"], "rc": u.get("rc"), "seconds": u.get("seconds"),
                       "start": u.get("start"), "load1m": (u.get("machine") or {}).get("loadavg", [None])[0],
                       "busy": [f"{b['comm']}:{b['cpuPct']}" for b in (u.get("machine") or {}).get("busyProcessesPct", [])[:4]]}
                      for u in sorted(units.values(), key=lambda x: x.get("order", 1e9))],
            "argv": {u["id"]: [a for a in u["argv"][1:]] for u in plan["units"]}}
    return prov, units


# ---------------------------------------------------------------------------- P03
# PERFORMANCE §8 fields that are constant within a run are stored once per run (samplesFile.runs) and
# apply to every row with that runId; dispatchNs = runs[runId].t0Ns + dispatchOffsetNs and
# lastRequestNs = dispatchNs + outerNs are exact, so they are not repeated per row; `sample` is the
# row's index within its run (rows are in dispatch order).
P03_RUN_FIELDS = ("implementationCommit", "environmentId", "contextCount", "affectedWindowCount", "clock", "clockResolutionNs",
                  "presentationUnavailableReason", "mode", "diag", "n", "run")
P03_COLUMNS = ["runId", "workload", "block", "k", "warmup", "cmd", "dispatchOffsetNs", "outerNs", "innerNs", "solveNs", "applyNs",
               "activateNs", "solves", "geometryWrites", "expectedWrites", "configureCount", "sizeConfigureCount",
               "configuredWindows", "requestToFirstConfigureNs", "requestToLastCommitNs", "requestToVirtualPresentNs",
               "sendToDispatchNs", "success", "failureReason"]
P03_NULLS = {"solveEndNs": "the solve span is a duration (solveNs) inside solveAndApply; its absolute end is not logged",
             "observedNs": "KWin-side frameGeometryChanged is not recorded in measured units (it would add a handler to every "
                           "write); the frames diagnostic unit checks it per block; client configure/commit times are given",
             "presentedNs": "nested virtual backend: no physical output (requestToVirtualPresentNs is the software timeline)",
             "nativeMutations": "not counted per sample; Plastile's direct backend issues no native tile mutation (ADR-003)",
             "correctiveWrites": "per block (engine counters), see units[].corrections and corrections[]"}


def p03_rows(cdir: Path) -> tuple[list[dict], dict[str, dict]]:
    rows, units = [], {}
    for d in sorted((cdir / "units").glob("qualify-*")):
        if not (d / "unit.json").exists():
            continue
        u = json.loads((d / "unit.json").read_text())
        units[d.name] = u
        for r in jl(d / "samples.jsonl"):
            lr = r.get("lastRequestNs")
            rel = lambda k: (r[k] - lr) if r.get(k) is not None and lr is not None else None  # noqa: E731
            r["requestToFirstConfigureNs"] = rel("firstConfigureNs")
            r["requestToLastCommitNs"] = rel("lastCommitNs")
            r["requestToVirtualPresentNs"] = rel("virtualPresentedNs")
            r["sendToDispatchNs"] = (r["dispatchNs"] - r["sendNs"]) if r.get("dispatchNs") and r.get("sendNs") else None
            r["unit"] = d.name
            r["cmd"] = r["cmd"].replace("plastile.", "")
            rows.append(r)
    t0: dict[str, int] = {}
    for r in rows:
        if r.get("dispatchNs") is not None:
            t0[r["runId"]] = min(t0.get(r["runId"], r["dispatchNs"]), r["dispatchNs"])
    for r in rows:
        r["dispatchOffsetNs"] = (r["dispatchNs"] - t0[r["runId"]]) if r.get("dispatchNs") is not None else None
    return rows, units


def run_table(rows: list[dict]) -> dict[str, dict]:
    runs: dict[str, dict] = {}
    for r in rows:
        if r["runId"] not in runs:
            runs[r["runId"]] = {k: r.get(k) for k in P03_RUN_FIELDS} | {"t0Ns": r["dispatchNs"] - r["dispatchOffsetNs"]
                                                                       if r.get("dispatchNs") is not None else None, "rows": 0}
        runs[r["runId"]]["rows"] += 1
        for k in P03_RUN_FIELDS:
            assert r.get(k) == runs[r["runId"]][k], (k, r["runId"])
    return runs


def write_csv_xz(path: Path, columns: list[str], rows: list[dict]) -> int:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(columns)
    for r in rows:
        w.writerow(["" if r.get(c) is None else (int(r[c]) if isinstance(r[c], bool) else r[c]) for c in columns])
    data = pc.redact(buf.getvalue()).encode()
    path.write_bytes(lzma.compress(data, preset=9 | lzma.PRESET_EXTREME))
    return path.stat().st_size


def block_work(units: dict[str, dict], n: int, wl: str, mode: str) -> dict:
    """Work per command from the engine's counters over every measured block of the cell."""
    tot = Counter()
    cmds = 0
    blocks = 0
    errs = 0
    for u in units.values():
        if u["n"] != n or u["mode"] != mode or u.get("diag"):
            continue
        for b in u["blocks"]:
            if b["workload"] != wl or b["warmup"]:
                continue
            blocks += 1
            cmds += b["commands"]
            errs += len(b["tilingErrorsAfter"])
            for k, v in b["countersDelta"].items():
                tot[k] += v
    per = {k: round(v / cmds, 4) for k, v in sorted(tot.items()) if k != "commands"} if cmds else {}
    return {"blocks": blocks, "commands": cmds, "totals": dict(sorted(tot.items())), "perCommand": per,
            "oracleTilingErrorsAfterBlocks": errs}


def tail(rows: list[dict], key: str, top: int) -> list[dict]:
    s = sorted((r for r in rows if r.get(key) is not None), key=lambda r: r[key], reverse=True)[:top]
    return [{"unit": r["unit"], "block": r["block"], "k": r["k"], key: ms(r[key]),
             "innerMs": ms(r.get("innerNs")), "solveMs": ms(r.get("solveNs")), "applyMs": ms(r.get("applyNs")),
             "activateMs": ms(r.get("activateNs")), "configures": r.get("configureCount"),
             "sendToDispatchMs": ms(r.get("sendToDispatchNs"))} for r in s]


def first_in_block_effect(rows: list[dict], key: str) -> dict:
    a = [r[key] for r in rows if r.get(key) is not None and r["k"] == 0]
    b = [r[key] for r in rows if r.get(key) is not None and r["k"] > 0]
    sa, sb = pc.stats(a), pc.stats(b)
    if not sa or not sb:
        return {}
    thr = pc.quantile(sorted(a + b), 0.99)
    top = [r for r in rows if r.get(key) is not None and r[key] >= thr]
    return {"firstOfBlock": {"n": sa["n"], "p50Ms": ms(sa["p50"]), "p95Ms": ms(sa["p95"]), "maxMs": ms(sa["max"])},
            "rest": {"n": sb["n"], "p50Ms": ms(sb["p50"]), "p95Ms": ms(sb["p95"]), "maxMs": ms(sb["max"])},
            "shareOfFirstOfBlockAll": round(sa["n"] / (sa["n"] + sb["n"]), 4),
            "shareOfFirstOfBlockInTop1pct": round(sum(1 for r in top if r["k"] == 0) / max(1, len(top)), 4),
            "top1pctThresholdMs": ms(thr)}


GC_LINE = re.compile(r"^\s*(\d+\.\d+) qt\.qml\.gc\.(\S+) (.*)$")
PERF_LINE = re.compile(r"^\s*(\d+\.\d+) .*plastile perf (\{.*\})$")
STEP = re.compile(r"Performed (\w+) in (\d+) microseconds")


def gc_attribution(cdir: Path, rows: list[dict]) -> dict | None:
    """In the GC diagnostic unit: did a QV4 GC step run inside the handler of the slowest commands?

    The log keeps the order of lines from KWin's thread: GC step lines that appear after the previous
    command's perf line and before this command's perf line, with a log timestamp (ms) at or after this
    command's entry, ran during this command (the perf line is printed at the end of the handler).
    """
    d = cdir / "units/qualify-n32-diag-gc"
    if not (d / "diag.log").exists():
        return None
    lines = (d / "diag.log").read_text().splitlines()
    perf = []
    pending: list[tuple[float, str, int]] = []
    steps_total = Counter()
    for ln in lines:
        m = GC_LINE.match(ln)
        if m:
            sm = STEP.search(m.group(3))
            if sm:
                pending.append((float(m.group(1)), sm.group(1), int(sm.group(2))))
                steps_total[sm.group(1)] += 1
            continue
        m = PERF_LINE.match(ln)
        if m:
            rec = json.loads(m.group(2))
            perf.append((rec, float(m.group(1)), pending))
            pending = []
    # Log clock (boot, ms) minus CLOCK_MONOTONIC: the minimum over perf lines (the log line is written after entry).
    off = min(ts * 1e3 - rec["entryNs"] / 1e6 for rec, ts, _ in perf) if perf else 0.0
    out = []
    for rec, ts, steps in perf:
        entry_ms = rec["entryNs"] / 1e6 + off
        inside = [(t, name, us) for t, name, us in steps if t * 1e3 >= entry_ms - 1.0]
        t = rec.get("timing") or {}
        out.append({"ns": rec["dispatchToReturnNs"], "id": rec["id"], "gcStepsInside": len(inside),
                    "gcUsInside": sum(us for _, _, us in inside), "solveNs": t.get("solveNs"), "applyNs": t.get("applyNs")})
    if not out:
        return None
    # Which span held the collection: the span that exceeds its own median for that command by at least half
    # the GC's logged step time.
    med = {}
    for key in ("solveNs", "applyNs"):
        for cmd in {r["id"] for r in out}:
            xs = sorted(r[key] for r in out if r["id"] == cmd and r[key] is not None and not r["gcStepsInside"])
            if xs:
                med[(key, cmd)] = xs[len(xs) // 2]
    where = Counter()
    for r in out:
        if not r["gcStepsInside"]:
            continue
        g = r["gcUsInside"] * 1000 * 0.5
        if r["solveNs"] is not None and r["solveNs"] - med.get(("solveNs", r["id"]), 0) >= g:
            where["solve"] += 1
        elif r["applyNs"] is not None and r["applyNs"] - med.get(("applyNs", r["id"]), 0) >= g:
            where["apply"] += 1
        else:
            where["outsideSolveAndApply"] += 1
    solving = [r for r in out if r["solveNs"] is not None]
    s = sorted(out, key=lambda r: r["ns"])
    thr99 = s[int(0.99 * (len(s) - 1))]["ns"]
    top = [r for r in s if r["ns"] >= thr99]
    rest = [r for r in s if r["ns"] < thr99]
    gcs = [r for r in s if r["gcStepsInside"]]
    return {
        "unit": "qualify-n32-diag-gc (instrumented + QT_LOGGING_RULES qt.qml.gc.*=true; never pooled)",
        "commands": len(s), "gcStepLinesTotal": dict(steps_total), "logClockOffsetMs": round(off, 3),
        "commandsWithGcStepInside": len(gcs), "gcCyclesTotal": steps_total.get("MarkStart", 0),
        "gcHeldBy": dict(where),
        "solvingCommands": len(solving),
        "shareOfSolvesHoldingGc": round(where["solve"] / max(1, len(solving)), 4),
        "gcStepTimeInHandlerMs": stat_ms(pc.stats([r["gcUsInside"] * 1000 for r in gcs])),
        "shareWithGcInside": {"top1pct": round(sum(1 for r in top if r["gcStepsInside"]) / max(1, len(top)), 4),
                              "rest": round(sum(1 for r in rest if r["gcStepsInside"]) / max(1, len(rest)), 4)},
        "top1pctThresholdMs": ms(thr99),
        "medianWithGcMs": ms(sorted(r["ns"] for r in gcs)[len(gcs) // 2]) if gcs else None,
        "medianWithoutGcMs": ms(sorted(r["ns"] for r in s if not r["gcStepsInside"])[(len(s) - len(gcs)) // 2]),
        "slowest10": [{"ms": ms(r["ns"]), "cmd": r["id"].replace("plastile.", ""), "gcStepsInside": r["gcStepsInside"],
                       "gcUsInside": r["gcUsInside"]} for r in s[-10:][::-1]],
    }


def frames_check(cdir: Path) -> dict | None:
    """Frames diagnostic unit: KWin's own frameGeometryChanged emissions against Plastile's writes, per block.

    A move is applied (and logged) inside the write, before its command's perf line; a resize is applied
    when the client commits, after the command returned. A block is a run of consecutive commands of one
    command family; the harness settles after each block. A frame line belongs to the block of the next
    perf line when it was logged at or after that command's entry (log clock, ms, calibrated against the
    perf lines' CLOCK_MONOTONIC entry times), otherwise to the block of the previous perf line.
    """
    d = cdir / "units/qualify-n32-diag-frames"
    if not (d / "diag.log").exists():
        return None
    events = []  # (kind, ts_ms, payload)
    for ln in (d / "diag.log").read_text().splitlines():
        m = re.match(r"^\s*(\d+\.\d+) ", ln)
        if not m:
            continue
        ts = float(m.group(1)) * 1e3
        if "plastile perf " in ln:
            events.append(("perf", ts, json.loads(ln.split("plastile perf ", 1)[1])))
        elif "PLT-L frame " in ln:
            events.append(("frame", ts, ln.split("PLT-L frame ", 1)[1].split("|", 1)[0]))
    perfs = [(ts, rec) for k, ts, rec in events if k == "perf"]
    off = min(ts - rec["entryNs"] / 1e6 for ts, rec in perfs) if perfs else 0.0
    blocks: list[dict] = []
    pending: list[float] = []

    def family(rec):
        return rec["id"].replace("plastile.", "").split(".")[0]

    for k, ts, x in events:
        if k == "frame":
            pending.append(ts)
            continue
        entry = x["entryNs"] / 1e6 + off
        fam = family(x)
        new_block = not blocks or blocks[-1]["family"] != fam
        mine = [f for f in pending if f >= entry - 0.5]
        older = [f for f in pending if f < entry - 0.5]
        if blocks:
            blocks[-1]["frameChanges"] += len(older)
        if new_block:
            blocks.append({"family": fam, "commands": 0, "writes": 0, "frameChanges": 0})
        b = blocks[-1]
        b["frameChanges"] += len(mine)
        b["commands"] += 1
        b["writes"] += (x.get("timing") or {}).get("writes", 0) if x.get("timing") else 0
        pending = []
    if blocks:
        blocks[-1]["frameChanges"] += len(pending)
    per = defaultdict(lambda: Counter())
    for b in blocks:
        c = per[b["family"]]
        c["blocks"] += 1
        c["commands"] += b["commands"]
        c["writes"] += b["writes"]
        c["frameChanges"] += b["frameChanges"]
        c["blocksWhereChangesEqualWrites"] += int(b["frameChanges"] == b["writes"])
    u = json.loads((d / "unit.json").read_text())
    return {"unit": "qualify-n32-diag-frames (instrumented + passive frameGeometryChanged listener; never pooled)",
            "note": "family = command family (resize = ratio, swap, master, focus, context and layout = no-op); writes are "
                    "the commands' plan writes; ledger corrections are counted by the engine separately (unit corrections)",
            "logClockOffsetMs": round(off, 3), "unitCorrections": u.get("corrections"),
            "perFamily": {k: dict(v) for k, v in sorted(per.items())}}


def gc_rate(cdirs: list[Path]) -> dict | None:
    """QV4 collection cycles per 1000 commands inside the measured blocks of each GC diagnostic unit.

    A block's interval runs from its first command's entry to its last command's return (dispatchNs and
    lastRequestNs of the samples, CLOCK_MONOTONIC) and is matched against the MarkStart log lines (log clock,
    ms; offset from the instrumented unit's perf lines, which is a property of the session's clocks)."""
    out = {}
    for d in sorted(p for cd in cdirs for p in (cd / "units").glob("*")):
        if not (d / "diag.log").exists() or not (d / "unit.json").exists():
            continue
        u = json.loads((d / "unit.json").read_text())
        if u.get("diag") != "gc":
            continue
        lines = (d / "diag.log").read_text().splitlines()
        starts = [float(m.group(1)) * 1e3 for ln in lines if (m := GC_LINE.match(ln)) and "Performed MarkStart" in m.group(3)]
        perf = [(float(m.group(1)) * 1e3, json.loads(m.group(2))) for ln in lines if (m := PERF_LINE.match(ln))]
        rows = jl(d / "samples.jsonl")
        blocks = defaultdict(list)
        for r in rows:
            if not r["warmup"] and r.get("dispatchNs") is not None:
                blocks[r["block"]].append(r)
        if perf:
            off = min(ts - rec["entryNs"] / 1e6 for ts, rec in perf)
        else:
            # Uninstrumented: no perf lines. KWin's log clock (%{time boot}) minus CLOCK_MONOTONIC is the time the
            # machine spent suspended, constant within a session; the instrumented units measured it.
            off = None
        out[d.name] = {"mode": u["mode"], "commands": sum(len(v) for v in blocks.values()), "blocks": len(blocks),
                       "_starts": starts, "_blocks": {b: (min(r["dispatchNs"] for r in v), max(r["lastRequestNs"] for r in v), len(v))
                                                       for b, v in blocks.items()}, "_off": off}
    offs = [v["_off"] for v in out.values() if v["_off"] is not None]
    if not out:
        return None
    off_all = sorted(offs)[len(offs) // 2] if offs else 0.0
    res = {}
    for name, v in out.items():
        off = v["_off"] if v["_off"] is not None else off_all
        inside = 0
        for t0, t1, _n in v["_blocks"].values():
            a, b = t0 / 1e6 + off - 1.0, t1 / 1e6 + off + 1.0
            inside += sum(1 for s in v["_starts"] if a <= s <= b)
        res[name] = {"mode": v["mode"], "commands": v["commands"], "gcCyclesInsideBlocks": inside,
                     "gcCyclesTotalInLog": len(v["_starts"]),
                     "cyclesPer1000Commands": round(1000 * inside / max(1, v["commands"]), 2),
                     "logClockOffsetMs": round(off, 3), "offsetSource": "own perf lines" if v["_off"] is not None else
                     "median of the instrumented units (same machine, no suspend during the campaign)"}
    by_mode = defaultdict(lambda: [0, 0])
    for v in res.values():
        by_mode[v["mode"]][0] += v["gcCyclesInsideBlocks"]
        by_mode[v["mode"]][1] += v["commands"]
    return {"note": "QV4 collections are logged by KWin's process for every engine (Plastile's declarative engine and the "
                    "harness's one-shot oracle scripts); only cycles inside measured blocks are counted, when no oracle runs",
            "units": res,
            "pooledCyclesPer1000Commands": {m: round(1000 * c / max(1, n), 2) for m, (c, n) in by_mode.items()}}


def withhold_small_p99(st: dict | None) -> dict | None:
    """A copied summary with its p99 withheld below 5000 samples (PERFORMANCE §6.5), whatever produced it."""
    if not st or st.get("p99") is None or st.get("n", 0) >= pc.P99_MIN_SAMPLES:
        return st
    return {**st, "p99": None, "p99WithheldReason": f"n={st['n']} < {pc.P99_MIN_SAMPLES} (PERFORMANCE §6.5)"}


def campaign_kwin(cdir: Path) -> str:
    """The nested KWin a campaign measured, from the versions its plan recorded."""
    plan = json.loads((cdir / "plan.json").read_text()) if (cdir / "plan.json").exists() else {}
    return pc.nested_kwin([v for v in [(plan.get("environment") or {}).get("kwin")] if v])


def p03(cdir: Path, ev: Path, rows: list[dict], units: dict[str, dict]) -> dict:
    main = [r for r in rows if not r.get("diag")]
    # Latency statistics are over successful samples only (PERFORMANCE §6.8); failures are counted next to them.
    meas = [r for r in main if not r["warmup"]]
    meas_ok = [r for r in meas if r["success"]]
    cells = {}
    counts = sorted({r["n"] for r in main})
    for n in counts:
        for wl in WORKLOADS:
            for mode in ("uninstrumented", "instrumented"):
                every = [r for r in meas if r["n"] == n and r["workload"] == f"P03-{wl}" and r["mode"] == mode]
                if not every:
                    continue
                cr = [r for r in every if r["success"]]
                warm = [r for r in main if r["warmup"] and r["n"] == n and r["workload"] == f"P03-{wl}" and r["mode"] == mode]
                fails = Counter(r["failureReason"] for r in every if not r["success"])
                cell = {
                    "samples": len(every), "successes": len(cr), "successRate": round(len(cr) / len(every), 6),
                    "runs": len({r["runId"] for r in every}), "failures": dict(fails),
                    "dispatchToLastRequestOuter": metric(cr, "outerNs"),
                    "failedOuter": stat_ms(pc.stats([r["outerNs"] for r in every if not r["success"]
                                                     and r.get("outerNs") is not None])),
                    "warmupOuter": stat_ms(pc.stats([r["outerNs"] for r in warm if r.get("outerNs") is not None])),
                    # Alternating workloads mix two commands (no-op: context.reset re-solves, layout.master-stack
                    # does not), so the pooled median can sit between two modes.
                    "outerByCommand": {c: stat_ms(pc.stats([r["outerNs"] for r in cr if r["cmd"] == c and r.get("outerNs") is not None]))
                                       for c in sorted({r["cmd"] for r in cr})},
                    "sendToDispatch": stat_ms(pc.stats([r["sendToDispatchNs"] for r in cr if r.get("sendToDispatchNs")])),
                    "work": block_work(units, n, wl, mode),
                    "client": {
                        "configuresPerCommand": stat_ms(pc.stats([r["configureCount"] * 1e6 for r in cr if r.get("configureCount") is not None])),
                        "requestToFirstConfigure": stat_ms(pc.stats([r["requestToFirstConfigureNs"] for r in cr])),
                        "requestToLastCommit": stat_ms(pc.stats([r["requestToLastCommitNs"] for r in cr])),
                        "requestToVirtualPresent": stat_ms(pc.stats([r["requestToVirtualPresentNs"] for r in cr])),
                    },
                }
                cc = cell["client"]["configuresPerCommand"]
                if cc:  # stored as count * 1e6 to reuse the ms formatter: undo
                    cell["client"]["configuresPerCommand"] = {k: (round(v * 1e6) / 1e6 if isinstance(v, float) else v)
                                                              for k, v in cc.items()}
                if mode == "instrumented":
                    cell["innerDispatchToReturn"] = metric(cr, "innerNs")
                    cell["solve"] = metric(cr, "solveNs")
                    cell["apply"] = metric(cr, "applyNs")
                    cell["kwinActivate"] = stat_ms(pc.stats([r["activateNs"] for r in cr if r.get("activateNs") is not None]))
                    # Focus: KWin's activation setter (workspace.activeWindow = w) runs inside the span.
                    cell["outerMinusKwinActivate"] = stat_ms(pc.stats([r["outerNs"] - r["activateNs"] for r in cr
                                                                       if r.get("activateNs") is not None and r.get("outerNs") is not None]))
                    w = [r["geometryWrites"] for r in cr if r.get("geometryWrites") is not None]
                    cell["writesPerCommand"] = dict(Counter(w))
                    cell["solvesPerCommand"] = dict(Counter(r["solves"] for r in cr if r.get("solves") is not None))
                cells[f"n{n}/{wl}/{mode}"] = cell
    # Instrumentation effect: same outer span in both modes.
    overhead = {}
    for n in counts:
        for wl in WORKLOADS:
            a = [r for r in meas_ok if r["n"] == n and r["workload"] == f"P03-{wl}" and r["mode"] == "instrumented"]
            b = [r for r in meas_ok if r["n"] == n and r["workload"] == f"P03-{wl}" and r["mode"] == "uninstrumented"]
            if not a or not b:
                continue
            ra, rb = list(by_run(a, "outerNs").values()), list(by_run(b, "outerNs").values())
            sa, sb = pc.stats([x for xs in ra for x in xs]), pc.stats([x for xs in rb for x in xs])
            rng = random.Random(7)
            d50 = bootstrap_diff_ci([sorted(x) for x in ra], [sorted(x) for x in rb], "median", b=BOOT, rng=rng)
            d95 = bootstrap_diff_ci([sorted(x) for x in ra], [sorted(x) for x in rb], "p95", b=BOOT, rng=rng)
            inner_gap = pc.stats([r["outerNs"] - r["innerNs"] for r in a if r.get("innerNs") is not None])
            overhead[f"n{n}/{wl}"] = {
                "outerP50Ms": {"instrumented": ms(sa["p50"]), "uninstrumented": ms(sb["p50"]), "diff": ms(sa["p50"] - sb["p50"]),
                               "diffCi95ByRun": [ms(d50[0]), ms(d50[1])] if d50 else None},
                "outerP95Ms": {"instrumented": ms(sa["p95"]), "uninstrumented": ms(sb["p95"]), "diff": ms(sa["p95"] - sb["p95"]),
                               "diffCi95ByRun": [ms(d95[0]), ms(d95[1])] if d95 else None},
                "outerMinusInnerMs": stat_ms(inner_gap),
            }
    # Gates over every block of both modes (counter gates hold regardless of the clock).
    gates = {"focusOnly": {}, "noop": {}, "oneRequestPerChangedWindow": {}}
    for n in counts:
        for mode in ("uninstrumented", "instrumented"):
            f = block_work(units, n, "focus", mode)
            gates["focusOnly"][f"n{n}/{mode}"] = {"commands": f["commands"], "solves": f["totals"].get("solves", 0),
                                                 "writes": f["totals"].get("writes", 0),
                                                 "activations": f["totals"].get("activations", 0)}
            z = block_work(units, n, "noop", mode)
            zr = [r for r in meas if r["n"] == n and r["workload"] == "P03-noop" and r["mode"] == mode]
            gates["noop"][f"n{n}/{mode}"] = {"commands": z["commands"], "solves": z["totals"].get("solves", 0),
                                            "writes": z["totals"].get("writes", 0), "skipNoop": z["totals"].get("skipNoop", 0),
                                            "clientConfiguresDuringNoopCommands": sum(r.get("configureCount") or 0 for r in zr)}
            for wl in SOLVING:
                wk = block_work(units, n, wl, mode)
                exp = {"ratio": n, "swap": 2, "master": n}[wl]
                gates["oneRequestPerChangedWindow"][f"n{n}/{wl}/{mode}"] = {
                    "commands": wk["commands"], "writes": wk["totals"].get("writes", 0), "expected": exp * wk["commands"],
                    "corrections": wk["totals"].get("corrections", 0), "stale": wk["totals"].get("stale", 0),
                    "planWrites": wk["totals"].get("writes", 0) - wk["totals"].get("corrections", 0)}
    for g in gates["focusOnly"].values():
        # Every focus.next over n >= 2 visible windows activates one: a no-op focus does nothing and passes
        # the zero-work gates trivially.
        g["pass"] = g["commands"] > 0 and g["solves"] == 0 and g["writes"] == 0 and g["activations"] == g["commands"]
    for g in gates["noop"].values():
        g["pass"] = g["commands"] > 0 and g["writes"] == 0 and g["clientConfiguresDuringNoopCommands"] == 0
    for g in gates["oneRequestPerChangedWindow"].values():
        g["pass"] = g["commands"] > 0 and g["planWrites"] == g["expected"] and g["corrections"] <= g["stale"]
    # Corrections: each with Plastile's trace excerpt (window ids are KWin internal UUIDs, not titles).
    corr = []
    for name, u in sorted(units.items()):
        for b in u.get("blocks", []):
            if b["countersDelta"].get("corrections"):
                ex = []
                for seg in b.get("correctionTrace", []):
                    st = next((t for t in seg if t["kind"] == "stale"), None)
                    fix = [t for t in seg if t["kind"] == "write" and (t.get("data") or {}).get("reason") == "correction"]
                    ex.append({"stale": st.get("data") if st else None, "correctionWrites": len(fix)})
                corr.append({"unit": name, "block": b["block"], "workload": b["workload"], "warmup": b["warmup"],
                             "counters": {k: b["countersDelta"].get(k, 0) for k in ("corrections", "stale", "superseded", "partial",
                                                                                 "deadlines", "diverged")},
                             "traceExcerpts": ex})
    # Tails at the reference load.
    tails = {}
    for mode, key in (("uninstrumented", "outerNs"), ("instrumented", "outerNs"), ("instrumented", "solveNs")):
        for wl in ORDINARY:
            cr = [r for r in meas_ok if r["n"] == 32 and r["workload"] == f"P03-{wl}" and r["mode"] == mode]
            if cr:
                tails[f"n32/{wl}/{mode}/{key}"] = {"slowest": tail(cr, key, 6), "firstOfBlockEffect": first_in_block_effect(cr, key)}
    unit_view = {name: {k: u.get(k) for k in ("n", "mode", "diag", "run", "unitSeed", "blockOrder", "calibration", "setupOk",
                                                  "instrumentedReported", "corrections", "teardown", "badLines", "pass", "seconds",
                                                  "sampleCount", "failures", "implementationCommit", "implementationDirty")}
                 | {"setup": {k: (u.get("setup") or {}).get(k) for k in ("visible", "hidden", "feasibility", "tilingErrors",
                                                                          "inactiveContexts", "windowsInModel")},
                    "machineStart": {k: u["machineStart"].get(k) for k in ("loadavg", "busyProcessesPct", "nestedKwinRunning")},
                    "final": u.get("final")}
                 for name, u in sorted(units.items())}
    size = write_csv_xz(ev / "g2-p03-samples.csv.xz", P03_COLUMNS, rows)
    calib = [u["calibration"] for u in units.values() if u.get("calibration")]
    return {
        "layer": f"{pc.nested_kwin((u.get('versions') or {}).get('kwin') for u in units.values())}, virtual backend "
                 "(not physical); commands via kglobalaccel invokeShortcut (D-Bus command API, not input)",
        "clock": "CLOCK_MONOTONIC via Plastile.Measure (tools/measure) inside KWin's QV4; fixture logs and the harness use the same clock",
        "clockCalibration": {"units": len(calib), "readCostNsP50": sorted(c["p50"] for c in calib)[len(calib) // 2] if calib else None,
                             "readCostNsMin": min(c["min"] for c in calib) if calib else None,
                             "clockGetresNs": sorted({c["resolutionNs"] for c in calib}) if calib else None},
        "definitions": {
            "dispatchToLastRequestOuter": "measurement root: ShortcutHandler.onActivated entry -> runtime.dispatch() returned, after "
                                          "every frame request of the command was issued (t1 -> t4); same span in both modes",
            "innerDispatchToReturn": "the runtime's own span inside dispatch() (instrumented only)",
            "solve": "engine solveAndApply: solve input + layout solve (instrumented only); apply: plan application, every frame write",
            "requestToFirstConfigure/LastCommit/VirtualPresent": "last request -> first xdg configure received by any fixture / last "
                                                                 "commit answering a configure / wp_presentation time of that commit "
                                                                 "on the virtual backend's software timeline (not physical scanout)",
            "sendToDispatch": "harness D-Bus send -> handler entry (kglobalaccel path; not input latency)",
            "warmup": "declared before the run: the first block of 20 commands of every workload in every session",
        },
        "samplesFile": {"path": "g2-p03-samples.csv.xz", "rows": len(rows), "bytes": size, "columns": P03_COLUMNS,
                        "format": "xz-compressed CSV, one row per command in dispatch order per run; empty = null. PERFORMANCE §8: "
                                  "fields constant within a run are in runs[runId]; dispatchNs = runs[runId].t0Ns + dispatchOffsetNs; "
                                  "lastRequestNs = dispatchNs + outerNs; sample = row index within the run. Window titles are "
                                  "never recorded.",
                        "nullFields": P03_NULLS, "runs": run_table(rows)},
        "cells": cells, "instrumentationEffect": overhead, "gates": gates, "corrections": corr, "tails": tails,
        "gcAttribution": gc_attribution(cdir, rows), "gcRate": gc_rate([cdir] + GC_DIRS), "framesCheck": frames_check(cdir),
        "units": unit_view,
    }


# ------------------------------------------------------------------------ baselines
BASE_COLUMNS = ["runId", "implementationCommit", "environmentId", "workload", "sample", "clock", "dispatchNs", "writeNs",
                "configureNs", "commitNs", "observedNs", "presentedNs", "presentationUnavailableReason", "observations",
                "configures", "success", "failureReason", "noop"]
UP_COLUMNS = ["runId", "tiler", "phase", "sample", "cmd", "sendToFirstConfigureNs", "sendToFirstSizeConfigureNs", "configureCount",
              "sizeConfigureCount", "fixturesTouched", "windowNs"]


def baselines(cdir: Path, ev: Path) -> dict:
    rows = []
    calib = []
    for d in sorted((cdir / "units").glob("baseline-p01-p02-r*")):
        s = json.loads((d / "summary.json").read_text()) if (d / "summary.json").exists() else None
        if s:
            calib += s.get("calibration", [])
        for r in jl(d / "samples.jsonl"):
            r["runId"] = d.name
            r["sample"] = r.pop("seq")
            rows.append(r)
    out = {"P01-P02": {"layer": f"{campaign_kwin(cdir)} virtual backend; probes/timing (no tiler loaded): one placement per "
                                "activation",
                       "definitions": "durations from the probe's request (frameGeometry write start), except dispatchNs = harness "
                                      "send -> handler entry; presentedNs on the virtual backend's software timeline",
                       "workloads": {}}}
    for wl in sorted({r["workload"] for r in rows}):
        cr = [r for r in rows if r["workload"] == wl]
        ok = [r for r in cr if r["success"] and not r.get("noop")]
        out["P01-P02"]["workloads"][wl] = {
            "samples": len(cr), "successes": len(ok), "noops": sum(1 for r in cr if r.get("noop")),
            "failures": dict(Counter(r["failureReason"] for r in cr if not r["success"])),
            **{k: metric(ok, k) for k in ("dispatchNs", "writeNs", "configureNs", "commitNs", "observedNs", "presentedNs")},
        }
    out["P01-P02"]["clockCalibration"] = calib[:1]
    size_b = write_csv_xz(ev / "g2-baselines-samples.csv.xz", BASE_COLUMNS + ["tiler", "phase", "cmd", "sendToFirstConfigureNs",
                                                                               "sendToFirstSizeConfigureNs", "sizeConfigureCount",
                                                                               "fixturesTouched", "windowNs"],
                          rows + upstream_rows(cdir))
    out["upstream"] = upstream(cdir)
    out["samplesFile"] = {"path": "g2-baselines-samples.csv.xz", "bytes": size_b,
                          "note": "P01/P02 rows (workload P01-*/P02-*) and Polonium/Plastile rows (tiler, phase); empty = null"}
    return out


def upstream_rows(cdir: Path) -> list[dict]:
    rows = []
    for d in sorted((cdir / "units").glob("upstream-*-r*")):
        tiler = d.name.split("-")[1]
        f = d / tiler / "samples.json"
        if not f.exists():
            continue
        res = json.loads(f.read_text())
        for phase, ph in res.get("phases", {}).items():
            for i, p in enumerate(ph["samples"]):
                rows.append({"runId": d.name, "tiler": tiler, "phase": phase, "sample": i, "cmd": p["cmd"],
                             "sendToFirstConfigureNs": p["firstConfigureNs"], "sendToFirstSizeConfigureNs": p["firstSizeConfigureNs"],
                             "configures": p["configures"], "sizeConfigureCount": p["sizeConfigures"],
                             "fixturesTouched": len(p["fixtures"]), "windowNs": p["windowNs"], "workload": f"T04-{tiler}-{phase}",
                             "success": p["firstConfigureNs"] is not None})
    return rows


def upstream(cdir: Path) -> dict:
    out = {"layer": f"{campaign_kwin(cdir)} virtual backend, kactivitymanagerd on the private bus for both tilers; "
                     "3 fixtures; kglobalaccel D-Bus command API (not input)",
           "metric": "harness send -> first fixture xdg configure in [send, next send) (independent of both tilers)",
           "package": None, "tilers": {}}
    rows = upstream_rows(cdir)
    for d in sorted((cdir / "units").glob("upstream-*-r*")):
        s = d / "summary.json"
        if s.exists():
            sm = json.loads(s.read_text())
            for t, v in sm.get("tilers", {}).items():
                out["tilers"].setdefault(t, {"runs": []})["runs"].append(
                    {"unit": d.name, "error": v.get("error") or v.get("startError"), "teardown": v.get("teardown"),
                     "fights": {k: p.get("idleConfiguresAfter1s") for k, p in v.get("phases", {}).items()},
                     "oracleErrors": {k: len(p.get("oracleErrors") or []) for k, p in v.get("phases", {}).items()},
                     "plastileCountersDelta": {k: p.get("plastileCountersDelta") for k, p in v.get("phases", {}).items()
                                               if p.get("plastileCountersDelta")} or None})
                if t == "polonium" and v.get("packageSha256"):
                    out["package"] = {"sha256": v["packageSha256"], "metadata": v.get("metadata"),
                                      "provenance": "probes/baseline-upstream/README.md (research pin 227967ed, verified)"}
    for t in sorted({r["tiler"] for r in rows}):
        for phase in sorted({r["phase"] for r in rows if r["tiler"] == t}):
            cr = [r for r in rows if r["tiler"] == t and r["phase"] == phase]
            out["tilers"][t].setdefault("phases", {})[phase] = {
                "commands": len(cr), "withoutConfigure": sum(1 for r in cr if r["sendToFirstConfigureNs"] is None),
                "sendToFirstConfigure": metric(cr, "sendToFirstConfigureNs"),
                "configuresPerCommand": dict(Counter(r["configures"] for r in cr)),
            }
    return out


# ------------------------------------------------------------------------ lifecycle
def lifecycle(cdir: Path) -> dict:
    p05 = defaultdict(list)
    checks = defaultdict(list)
    for d in sorted((cdir / "units").glob("p05-n*-r*")):
        s = d / "summary.json"
        if not s.exists():
            continue
        sm = json.loads(s.read_text())
        for n, row in (sm.get("p05") or {}).items():
            p05[n].append({"unit": d.name, "solvesPerFlush": row["solvesPerFlush"], "create": row["create"], "close": row["close"],
                           "closeSolvesPerFlush": row["closeSolvesPerFlush"], "feasibility": row.get("feasibility"),
                           "mappedSpanMs": row["mappedSpanMs"], "lastMappedToLastClientCommitMs": row["lastMappedToLastClientCommitMs"],
                           "lastMappedToOracleTiledBoundsMs": row["lastMappedToOracleTiledBoundsMs"],
                           "configuresPerWindow": withhold_small_p99(row["configuresPerWindow"]),
                           "finalTilingErrors": row["finalTilingErrors"]})
        for k, v in sm["checks"].items():
            checks[k].append(v["pass"])
    out = {"P05": {"perN": dict(p05), "checks": {k: {"pass": sum(v), "of": len(v)} for k, v in sorted(checks.items())}}}
    b = cdir / "units/p05-boundary-n32/unit.json"
    if b.exists():
        u = json.loads(b.read_text())
        out["P05-boundary-n32"] = {k: u.get(k) for k in ("measured", "checks", "pass", "implementationCommit", "implementationDirty")} | {
            "feasible": {k: u["feasible"].get(k) for k in ("height", "overflow", "tilingErrorsAll", "counters")},
            "infeasible": {k: u["infeasible"].get(k) for k in ("height", "overflow", "floated", "newestMapped", "tilingErrorsAmongTiled",
                                                               "floatedConfigureSizes")}}
    w = cdir / "units/workloads-p07-p12-p13-teardown/summary.json"
    if w.exists():
        sm = json.loads(w.read_text())
        out["P07-P12-P13-teardown"] = {"checks": {k: v["pass"] for k, v in sm["checks"].items()},
                                       "exceptions": sm.get("exceptions"),
                                       "p07": {n: {"burst": withhold_small_p99(v["burst"]["dispatchToReturnNs"]),
                                                   "paced": withhold_small_p99(v["paced"]["dispatchToReturnNs"]),
                                                   "commandsQueued": v["commandsQueued"], "counters": v["counters"]}
                                               for n, v in (sm.get("p07") or {}).items()},
                                       "p12": {k: (sm.get("p12") or {}).get(k) for k in ("commandDelta", "switchDelta", "desktops")},
                                       "p13": {"activation": (sm.get("p13") or {}).get("activation"),
                                               "p50RatioRules256OverNone": (sm.get("p13") or {}).get("p50RatioRules256OverNone")},
                                       "teardown": sm.get("teardown")}
    return out


# ---------------------------------------------------------------------------- churn
def churn(cdir: Path) -> dict:
    out = {}
    for name in ("churn-p14", "churn-p14-control", "churn-p15", "churn-p15-control"):
        d = cdir / "units" / name
        f = next(iter(sorted(d.glob("unit-*.json"))), None) if d.exists() else None
        if not f:
            continue
        u = json.loads(f.read_text())
        sm = u["summary"]
        keep = {k: v for k, v in sm.items() if k not in ("samplesEvery30s",)}
        if "samplesEvery30s" in sm:
            keep["samplesEvery30s"] = [{k: v for k, v in r.items() if k in ("tSeconds", "windowsLive", "rssKiB", "rssAnonKiB", "connections", "windows",
                                                                          "outstanding", "corrections", "errors", "oracleWindows",
                                                                          "badLines")} for r in sm["samplesEvery30s"]]
        out[name] = {"implementationCommit": u["implementationCommit"], "implementationDirty": u["implementationDirty"],
                     "machineStart": {k: u["machineStart"].get(k) for k in ("loadavg", "busyProcessesPct", "nestedKwinRunning")},
                     "summary": keep}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("campaign", type=Path)
    ap.add_argument("--evidence", type=Path, default=ROOT / "docs/status/evidence")
    ap.add_argument("--churn-campaign", type=Path, default=None,
                    help="a later campaign (campaign.py --only churn) whose churn units replace the main campaign's")
    ap.add_argument("--superseded", default="", help="text recorded for the replaced churn units")
    ap.add_argument("--p04", type=Path, default=None, help="probes/perf/pure.ts JSON output (Node, informational)")
    ap.add_argument("--gc-campaign", type=Path, action="append", default=[],
                    help="a campaign (campaign.py --only gc-rate) with the QV4 collection-rate units")
    ap.add_argument("--rss-campaign", type=Path, default=None, help="a campaign (campaign.py --only rss-bisect)")
    args = ap.parse_args()
    GC_DIRS.extend(args.gc_campaign)
    cdir, ev = args.campaign, args.evidence
    ev.mkdir(parents=True, exist_ok=True)
    prov, _ = campaign(cdir)
    record = {"purpose": "G2 (T20/T34/T04) measurement campaign provenance", "main": prov}
    if args.churn_campaign:
        record["churn"] = campaign(args.churn_campaign)[0] | {"replaces": args.superseded}
    for g in args.gc_campaign:
        record.setdefault("gcRate", []).append(campaign(g)[0])
    if args.rss_campaign:
        record["rssBisect"] = campaign(args.rss_campaign)[0]
        units = {}
        for d in sorted((args.rss_campaign / "units").glob("*")):
            if (d / "unit.json").exists():
                u = json.loads((d / "unit.json").read_text())
                units[d.name] = {k: u.get(k) for k in ("mode", "args", "implementationCommit", "implementationDirty", "metric",
                                                       "result")} | {"load1mAtStart": u["machineStart"]["loadavg"][0]}
        pc.write_json(ev / "g2-rss-bisect.json", {
            "purpose": "T34: where P14's anonymous-memory growth comes from (probes/perf/rss_bisect.py)",
            "layer": "nested KWin virtual backend (not physical)", "units": units})
    pc.write_json(ev / "g2-campaign.json", record)
    if args.p04:
        pc.write_json(ev / "g2-p04-node.json", {
            "purpose": "P04 pure-core scaling (PERFORMANCE §5): production engine + mock compositor in Node",
            "label": "Node V8 with a mock host: informs algorithm and queue scaling only; it is not QV4, not KWin, and "
                     "proves nothing about desktop latency", **json.loads(args.p04.read_text())})
    rows, units = p03_rows(cdir)
    pc.write_json(ev / "g2-p03.json", {"purpose": "G2 P03 qualification (T20/T34)", **p03(cdir, ev, rows, units)})
    pc.write_json(ev / "g2-baselines.json", {"purpose": "T04 baselines: P01/P02 no-tiler controls, Polonium vs Plastile", **baselines(cdir, ev)})
    pc.write_json(ev / "g2-lifecycle.json", {"purpose": "G2 P05 bursts, P05 boundary, P07/P12/P13", **lifecycle(cdir)})
    ch = churn(args.churn_campaign or cdir)
    if args.churn_campaign:
        ch["supersededChurnUnits"] = {"campaign": cdir.name, "reason": args.superseded, "units": churn(cdir)}
    pc.write_json(ev / "g2-churn.json", {"purpose": "T34 P14/P15 resource tracking and idle", **ch})
    for f in sorted(ev.glob("g2-*")):
        print(f"{f.stat().st_size:>10}  {f.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
