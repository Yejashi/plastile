#!/usr/bin/env python3
"""Input-to-present correlation for Plastile's physical latency harness.

Inputs are two kinds of logs that share CLOCK_MONOTONIC:

- plastile-keytap JSON Lines: one `tap` record per injected chord, with `t_input_ns`
  read immediately before the write that carried the trigger key's press.
- plastile-fixture JSON Lines (fixtures/client/README.md): `configure`, `commit`,
  `presented` (wp_presentation, `present_ns`) and `discarded` per window.

For every tap, the attribution window runs from its `t_input_ns` to the next tap's
`t_input_ns` (or `timeout_ns`, whichever is first). A configure that arrives in that
window is attributed to the tap; the commit that acks it is found by xdg serial, and the
presentation of that commit by buffer `seq`. The orchestrator paces taps to the same
timeout: it sends the next tap only after a response settled or `timeout_ns` passed. A
tap that follows an input whose response did not complete within the timeout (no
configure at all, or the injector's `pacing` says so) is a failure: a late configure of
the earlier input would otherwise be taken for this input's fast response. Per sample:

- inputToFirstPresentNs: earliest presentation of any commit answering an attributed
  configure, minus t_input_ns (PERFORMANCE section 3 "input-to-first-visible").
- inputToFinalCommitPresentNs: for every affected window, the presentation of the commit
  answering its last attributed configure; the maximum over windows, minus t_input_ns.
- inputToSettledNs (t9_settled): inputToFinalCommitPresentNs while no effect animates the
  change. With Plastile Motion on (record context `motionOn`) it is null with a reason: the
  final commit is presented on the first animated frame, and the end of the animation has
  no client-visible signal (PERFORMANCE section 6.1).

A sample is successful only when the workload's expected effect was observed (a size
change for `resize`, an activation change for `activate`) and every affected window's
final commit was presented. Missing values are null with a reason; nothing is
synthesized from geometry signals (PERFORMANCE section 2).

CLI (offline re-correlation of a recorded block):

    python3 tools/physical/latency.py correlate --taps keytap.jsonl --fixtures 'fixture-*.jsonl' \
        --expect resize [--refresh-hz 144] [--out samples.jsonl]
"""
from __future__ import annotations

import argparse
import glob
import sys
from bisect import bisect_left
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read_jsonl, write_jsonl  # noqa: E402

DEFAULT_TIMEOUT_NS = 2_000_000_000
REFRESH_TOLERANCE = 0.03  # relative; 60/100/144 Hz differ by far more
SCHEMA_VERSION = 1

# PERFORMANCE section 8 fields every record carries (null allowed only with a reason).
SCHEMA_FIELDS = (
    "runId", "implementationCommit", "environmentId", "workload", "sample", "contextCount", "affectedWindowCount",
    "clock", "clockResolutionNs", "dispatchNs", "solveEndNs", "lastRequestNs", "observedNs", "presentedNs",
    "presentationUnavailableReason", "solves", "geometryWrites", "nativeMutations", "configureCount",
    "correctiveWrites", "success", "failureReason",
)
# Extensions used by the physical harness.
EXTENSION_FIELDS = (
    "schemaVersion", "layer", "inputSource", "condition", "action", "keys", "warmup", "run", "round", "windowCount",
    "outputName", "refreshHzDeclared", "refreshNsObserved", "inputNs", "inputWriteNs", "configureNs", "commitNs",
    "settledNs", "inputToFirstPresentNs", "inputToSettledNs", "commitCount", "discardedCount", "quietBeforeNs",
    "unavailableReasons", "motion", "inputToFinalCommitPresentNs", "settledUnavailableReason",
)
# Pacing outcomes (orchestrate.wait_settle) after which the next tap's window cannot be attributed.
INCOMPLETE_PACING = ("no-effect", "timeout")
MOTION_SETTLE_REASON = ("t9_settled is not observable with Plastile Motion on: the final commit is presented on the "
                        "first animated frame and the animation's end has no client-visible signal "
                        "(inputToFinalCommitPresentNs is that presentation; PERFORMANCE section 6.1)")
NULLABLE_WITH_REASON = ("contextCount", "dispatchNs", "solveEndNs", "lastRequestNs", "observedNs", "solves",
                        "geometryWrites", "nativeMutations", "correctiveWrites")


@dataclass
class Window:
    """One fixture window's events, indexed for attribution."""
    name: str
    configures: list[dict] = field(default_factory=list)
    commits: list[dict] = field(default_factory=list)
    presented: dict[int, dict] = field(default_factory=dict)
    discarded: set[int] = field(default_factory=set)
    commit_by_serial: dict[int, dict] = field(default_factory=dict)
    clock_ok: bool | None = None
    cfg_times: list[int] = field(default_factory=list)
    commit_times: list[int] = field(default_factory=list)
    event_times: list[int] = field(default_factory=list)


def load_fixture(name: str, events: list[dict]) -> Window:
    """Index the main window's events (the transient child, if any, is ignored)."""
    w = Window(name)
    for e in events:
        ev = e.get("ev")
        if ev == "presentation_clock":
            w.clock_ok = bool(e.get("same_as_log_clock"))
            continue
        if e.get("win", "main") != "main":
            continue
        if ev == "configure":
            w.configures.append(e)
        elif ev == "commit":
            w.commits.append(e)
            if e.get("serial") is not None:
                w.commit_by_serial.setdefault(int(e["serial"]), e)
        elif ev == "presented":
            w.presented[int(e["seq"])] = e
        elif ev == "discarded":
            w.discarded.add(int(e["seq"]))
        if ev in ("configure", "commit") and "t_ns" in e:
            w.event_times.append(int(e["t_ns"]))
    w.configures.sort(key=lambda c: c["t_ns"])
    w.commits.sort(key=lambda c: c["t_ns"])
    w.cfg_times = [int(c["t_ns"]) for c in w.configures]
    w.commit_times = [int(c["t_ns"]) for c in w.commits]
    w.event_times.sort()
    return w


def _activated(cfg: dict | None) -> bool | None:
    return None if cfg is None else "activated" in (cfg.get("states") or [])


def _size_before(w: Window, t: int) -> tuple[int, int] | None:
    i = bisect_left(w.commit_times, t)
    if i == 0:
        return None
    c = w.commits[i - 1]
    return int(c["width"]), int(c["height"])


def _effective_size(cfg: dict, current: tuple[int, int] | None) -> tuple[int, int]:
    w, h = int(cfg.get("width") or 0), int(cfg.get("height") or 0)
    if current is not None:
        w = w or current[0]
        h = h or current[1]
    return w, h


def correlate(taps: list[dict], windows: list[Window], *, expect: str, refresh_ns_declared: int | None = None,
              end_ns: int | None = None, timeout_ns: int = DEFAULT_TIMEOUT_NS) -> list[dict]:
    """One result per tap (same order). See the module docstring for the definitions."""
    if expect not in ("resize", "activate"):
        raise ValueError(f"unknown expected effect {expect!r}")
    taps = sorted(taps, key=lambda t: t["t_input_ns"])
    results = []
    for i, tap in enumerate(taps):
        t0 = int(tap["t_input_ns"])
        t_next = int(taps[i + 1]["t_input_ns"]) if i + 1 < len(taps) else None
        t_end = t0 + timeout_ns
        if t_next is not None:
            t_end = min(t_end, t_next)
        if end_ns is not None and t_next is None:
            t_end = min(t_end, end_ns)
        r = _correlate_one(tap, t0, t_end, windows, expect, refresh_ns_declared, timeout_ns)
        if i > 0 and (results[-1]["affectedWindowCount"] == 0 or taps[i - 1].get("pacing") in INCOMPLETE_PACING):
            r["success"] = False
            r["failureReason"] = ("the previous input's response did not complete within the sample timeout: "
                                  "configures in this window may answer it, not this input")
        results.append(r)
    return results


def _correlate_one(tap: dict, t0: int, t_end: int, windows: list[Window], expect: str,
                   refresh_declared: int | None, timeout_ns: int) -> dict:
    r = {
        "tapId": tap.get("id"), "inputNs": t0,
        "inputWriteNs": (int(tap["t_write_end_ns"]) - t0) if tap.get("t_write_end_ns") is not None else None,
        "configureNs": None, "commitNs": None, "presentedNs": None, "settledNs": None,
        "inputToFirstPresentNs": None, "inputToSettledNs": None, "configureCount": 0, "commitCount": 0,
        "discardedCount": 0, "affectedWindowCount": 0, "refreshNsObserved": None, "quietBeforeNs": None,
        "effectObserved": False, "success": False, "failureReason": None, "presentationUnavailableReason": None,
    }
    last_before = [w.event_times[bisect_left(w.event_times, t0) - 1] for w in windows
                   if bisect_left(w.event_times, t0) > 0]
    if last_before:
        r["quietBeforeNs"] = t0 - max(last_before)
    first_cfg = first_commit = first_present = None
    settled: list[int] = []
    settle_problem = None
    refresh_seen: list[int] = []
    clock_problem = None
    for w in windows:
        lo, hi = bisect_left(w.cfg_times, t0), bisect_left(w.cfg_times, t_end)
        cfgs = w.configures[lo:hi]
        if not cfgs:
            continue
        r["affectedWindowCount"] += 1
        r["configureCount"] += len(cfgs)
        prev_cfg = w.configures[lo - 1] if lo > 0 else None
        size0 = _size_before(w, t0)
        if expect == "resize":
            if size0 is None or any(_effective_size(c, size0) != size0 for c in cfgs):
                r["effectObserved"] = True
        elif any(_activated(c) != _activated(prev_cfg) for c in cfgs):
            r["effectObserved"] = True
        first_cfg = min(first_cfg, cfgs[0]["t_ns"]) if first_cfg is not None else cfgs[0]["t_ns"]
        if w.clock_ok is False:
            clock_problem = f"{w.name}: presentation clock is not the log clock (CLOCK_MONOTONIC)"
        for c in cfgs:
            commit = w.commit_by_serial.get(int(c["serial"]))
            if commit is None:
                continue
            r["commitCount"] += 1
            first_commit = min(first_commit, commit["t_ns"]) if first_commit is not None else commit["t_ns"]
            seq = int(commit["seq"])
            if seq in w.discarded:
                r["discardedCount"] += 1
            p = w.presented.get(seq)
            if p is not None:
                first_present = min(first_present, p["present_ns"]) if first_present is not None else p["present_ns"]
                if p.get("refresh_ns"):
                    refresh_seen.append(int(p["refresh_ns"]))
        final = w.commit_by_serial.get(int(cfgs[-1]["serial"]))
        if final is None:
            settle_problem = settle_problem or f"{w.name}: last attributed configure was never acked by a commit"
        elif int(final["seq"]) in w.discarded:
            settle_problem = settle_problem or f"{w.name}: final commit seq {final['seq']} was discarded"
        elif int(final["seq"]) not in w.presented:
            settle_problem = settle_problem or f"{w.name}: no presentation feedback for final commit seq {final['seq']}"
        else:
            settled.append(int(w.presented[int(final["seq"])]["present_ns"]))
    if first_cfg is not None:
        r["configureNs"] = int(first_cfg) - t0
    if first_commit is not None:
        r["commitNs"] = int(first_commit) - t0
    if refresh_seen:
        refresh_seen.sort()
        r["refreshNsObserved"] = refresh_seen[len(refresh_seen) // 2]
    if clock_problem:
        r["presentationUnavailableReason"] = clock_problem
    else:
        if first_present is not None:
            r["presentedNs"] = int(first_present)
            r["inputToFirstPresentNs"] = int(first_present) - t0
        if settled and settle_problem is None:
            r["settledNs"] = max(settled)
            r["inputToSettledNs"] = max(settled) - t0
        if r["affectedWindowCount"] == 0:
            r["presentationUnavailableReason"] = "no configure attributed to this input"
        elif settle_problem:
            r["presentationUnavailableReason"] = settle_problem
        elif first_present is None:
            r["presentationUnavailableReason"] = "no attributed commit was presented"
    # Success: expected effect, presented settle, sane clocks, expected output.
    if r["affectedWindowCount"] == 0:
        r["failureReason"] = (f"no configure within {timeout_ns / 1e6:g} ms of the input or before the next input "
                              "(key not delivered, unbound, no-op, or a response slower than the sample timeout)")
    elif not r["effectObserved"]:
        r["failureReason"] = f"configures arrived but no {expect} effect was observed"
    elif clock_problem:
        r["failureReason"] = clock_problem
    elif r["inputToFirstPresentNs"] is not None and r["inputToFirstPresentNs"] < 0:
        r["failureReason"] = "presentation precedes input: clock-domain error"
    elif r["inputToSettledNs"] is None:
        r["failureReason"] = r["presentationUnavailableReason"] or "settle not observed"
    elif refresh_declared and r["refreshNsObserved"] and \
            abs(r["refreshNsObserved"] - refresh_declared) > REFRESH_TOLERANCE * refresh_declared:
        r["failureReason"] = (f"presented at refresh {r['refreshNsObserved']} ns, expected {refresh_declared} ns: "
                              "the window is on another output")
    else:
        r["success"] = True
    return r


def present_grid(windows: list[Window], refresh_ns: int | None) -> dict | None:
    """Frame-pacing sanity check: do presentation times fall on the output's refresh grid?

    Uses every distinct presentation time of the block. An interval whose distance to the
    nearest multiple of refresh_ns is within 5 % of refresh_ns counts as aligned. This checks
    pacing of what was presented, not smoothness of an animation.
    """
    times = sorted({int(p["present_ns"]) for w in windows for p in w.presented.values()})
    if not refresh_ns or len(times) < 2:
        return None
    residuals = []
    for a, b in zip(times, times[1:]):
        rem = (b - a) % refresh_ns
        residuals.append(min(rem, refresh_ns - rem))
    aligned = sum(1 for x in residuals if x <= 0.05 * refresh_ns)
    residuals.sort()
    return {"intervals": len(residuals), "aligned": aligned, "alignedFraction": aligned / len(residuals),
            "residualP95Ns": residuals[min(len(residuals) - 1, int(0.95 * len(residuals)))],
            "residualMaxNs": residuals[-1], "refreshNs": refresh_ns}


# --------------------------------------------------------------------------- records


def to_record(result: dict, ctx: dict) -> dict:
    """Merge one correlation result with block context into a PERFORMANCE section 8 record."""
    na_engine = ("per-sample engine timestamps are not observable in a physical run without the measurement "
                 "build; see blocks.jsonl for block counter totals")
    final = result["inputToSettledNs"]
    settled = None if ctx.get("motionOn") else final
    rec = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": ctx["runId"], "implementationCommit": ctx.get("implementationCommit"),
        "implementationDirty": ctx.get("implementationDirty"), "installedBundleSha256": ctx.get("installedBundleSha256"),
        "environmentId": ctx["environmentId"], "layer": ctx["layer"], "inputSource": ctx["inputSource"],
        "workload": ctx["workload"], "condition": ctx["condition"], "action": ctx.get("action"),
        "keys": ctx.get("keys"), "warmup": bool(ctx.get("warmup")), "run": ctx.get("run"), "round": ctx.get("round"),
        "sample": ctx["sample"], "windowCount": ctx.get("windowCount"), "outputName": ctx.get("outputName"),
        "refreshHzDeclared": ctx.get("refreshHzDeclared"),
        "contextCount": None, "affectedWindowCount": result["affectedWindowCount"],
        "clock": "CLOCK_MONOTONIC (injector write, fixture log and wp_presentation share it)",
        "clockResolutionNs": ctx.get("clockResolutionNs"),
        "inputNs": result["inputNs"], "inputWriteNs": result["inputWriteNs"],
        "dispatchNs": None, "solveEndNs": None, "lastRequestNs": None, "observedNs": None,
        "configureNs": result["configureNs"], "commitNs": result["commitNs"],
        "presentedNs": result["inputToFirstPresentNs"], "settledNs": settled,
        "inputToFirstPresentNs": result["inputToFirstPresentNs"], "inputToSettledNs": settled,
        "inputToFinalCommitPresentNs": final, "motion": ctx.get("motion"),
        "settledUnavailableReason": MOTION_SETTLE_REASON if final is not None and settled is None else None,
        "presentationUnavailableReason": result["presentationUnavailableReason"],
        "refreshNsObserved": result["refreshNsObserved"], "quietBeforeNs": result["quietBeforeNs"],
        "solves": None, "geometryWrites": None, "nativeMutations": None, "correctiveWrites": None,
        "configureCount": result["configureCount"], "commitCount": result["commitCount"],
        "discardedCount": result["discardedCount"],
        "success": result["success"], "failureReason": result["failureReason"],
        "unavailableReasons": {
            "contextCount": "the context count is not observable from the client side",
            "dispatchNs": na_engine, "solveEndNs": na_engine, "lastRequestNs": na_engine,
            "observedNs": "window geometry observation needs a KWin script oracle; not loaded in physical runs",
            "solves": na_engine, "geometryWrites": na_engine, "nativeMutations": na_engine,
            "correctiveWrites": na_engine,
        },
    }
    return rec


def validate_record(rec: dict) -> list[str]:
    """Schema check for one record: every field present, null only with a reason, types sane."""
    errs = []
    for f in SCHEMA_FIELDS + EXTENSION_FIELDS:
        if f not in rec:
            errs.append(f"missing field {f}")
    if errs:
        return errs
    reasons = rec.get("unavailableReasons") or {}
    for f in NULLABLE_WITH_REASON:
        if rec[f] is None and not reasons.get(f):
            errs.append(f"{f} is null without a reason")
    if rec["presentedNs"] is None and not rec["presentationUnavailableReason"]:
        errs.append("presentedNs is null without presentationUnavailableReason")
    if not isinstance(rec["success"], bool):
        errs.append("success must be a boolean")
    settle_ok = rec["inputToSettledNs"] is not None or (rec["settledUnavailableReason"]
                                                         and rec["inputToFinalCommitPresentNs"] is not None)
    if rec["success"] and (rec["failureReason"] is not None or not settle_ok or rec["inputToFirstPresentNs"] is None):
        errs.append("a successful sample needs both latencies (or a reason for the settle) and no failure reason")
    if not rec["success"] and not rec["failureReason"]:
        errs.append("a failed sample needs a failureReason")
    for f in ("inputNs", "sample"):
        if not isinstance(rec[f], int):
            errs.append(f"{f} must be an integer")
    for f in ("inputToFirstPresentNs", "inputToSettledNs", "inputToFinalCommitPresentNs", "configureNs", "commitNs"):
        if rec[f] is not None and not isinstance(rec[f], int):
            errs.append(f"{f} must be an integer or null")
    for f in ("inputToSettledNs", "inputToFinalCommitPresentNs"):
        if rec["inputToFirstPresentNs"] is not None and rec[f] is not None and rec[f] < rec["inputToFirstPresentNs"]:
            errs.append("settled precedes first present")
            break
    if rec["layer"] not in ("physical", "nested-dry-run", "nested-windowed-gpu", "synthetic"):
        errs.append(f"unknown layer {rec['layer']!r}")
    return errs


# ------------------------------------------------------------------------------- CLI


def load_windows(patterns: list[str]) -> list[Window]:
    paths = sorted({p for pat in patterns for p in glob.glob(pat)})
    return [load_fixture(Path(p).stem, read_jsonl(Path(p))) for p in paths]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("correlate", help="correlate a keytap log with fixture logs")
    c.add_argument("--taps", type=Path, required=True)
    c.add_argument("--fixtures", nargs="+", required=True, help="fixture log paths or glob patterns")
    c.add_argument("--expect", choices=("resize", "activate"), required=True)
    c.add_argument("--refresh-hz", type=float, default=None)
    c.add_argument("--timeout-ms", type=float, default=DEFAULT_TIMEOUT_NS / 1e6)
    c.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)
    taps = [t for t in read_jsonl(args.taps) if t.get("ev") == "tap"]
    windows = load_windows(args.fixtures)
    refresh = int(round(1e9 / args.refresh_hz)) if args.refresh_hz else None
    results = correlate(taps, windows, expect=args.expect, refresh_ns_declared=refresh,
                        timeout_ns=int(args.timeout_ms * 1e6))
    if args.out:
        write_jsonl(args.out, results)
    ok = [r for r in results if r["success"]]
    print(f"{len(results)} taps, {len(ok)} successful, {len(windows)} fixture logs")
    for key in ("inputToFirstPresentNs", "inputToSettledNs"):
        xs = sorted(r[key] for r in ok)
        if xs:
            print(f"  {key}: median {xs[(len(xs) - 1) // 2] / 1e6:.3f} ms, max {xs[-1] / 1e6:.3f} ms (n={len(xs)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
