#!/usr/bin/env python3
"""Observe fixture windows in the live session while you change outputs, panels or activities.

    python3 tools/physical/observe.py [--windows 4] [--quiet-ms 2000] [--tail-timeout 20] [--no-counters]

It opens N controlled fixture windows (fixtures/client) in the live session and then runs
labelled phases. For each phase you press Enter, perform ONE action (change a scale with
kscreen-doctor, add a panel, switch activity, unplug a cable, suspend, toggle a border...),
wait until the windows look stable, and press Enter again. The tool then waits until no
window has received a configure for --quiet-ms (bounded by --tail-timeout) to catch a
trailing oscillation, and reports per window:

- configures and commits during the phase, the sequence of configured sizes, and size
  reversals (A -> B -> A), which indicate a geometry fight;
- the final size, activation, and the refresh interval of its last presentation (a proxy
  for which output the window is on, since the reference outputs run at 60/100/144 Hz);
- whether the phase ended quiet (converged) or hit the tail timeout;
- Plastile's counter deltas (corrections, writes, solves, diverged, overflow, errors) when
  it is loaded, from its "Log counters" command and the user journal.

This is an independent client-side oracle for convergence; it cannot see window positions.
Placement correctness (no tile under a panel, nothing off-screen) is a visual check you
record in the checklist (tools/physical/checklist.py), ideally with a screenshot.
Results: artifacts/physical/observe-<stamp>/ (phases.jsonl, observe-summary.json, fixture logs).
Read-only toward configuration: it never writes kwinrc or restarts the compositor; the
actions themselves are yours.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import common  # noqa: E402
import orchestrate  # noqa: E402

# Proposed corrective budget (PERFORMANCE section 4): initial request plus at most two corrections.
MAX_CONFIGURES_HINT = 3


def size_sequence(events: list[dict], t0: int, t1: int) -> list[tuple[int, int]]:
    seq: list[tuple[int, int]] = []
    for e in events:
        if e.get("ev") == "configure" and e.get("win", "main") == "main" and t0 <= e["t_ns"] < t1:
            wh = (int(e.get("width") or 0), int(e.get("height") or 0))
            if wh != (0, 0) and (not seq or seq[-1] != wh):
                seq.append(wh)
    return seq


def reversals(seq: list[tuple[int, int]]) -> int:
    """Count A -> B -> A returns in a de-duplicated size sequence."""
    return sum(1 for i in range(2, len(seq)) if seq[i] == seq[i - 2])


def phase_stats(logs: dict[str, list[dict]], t0: int, t1: int) -> dict:
    windows = {}
    for name, events in logs.items():
        main = [e for e in events if e.get("win", "main") == "main" and "t_ns" in e]
        cfgs = [e for e in main if e.get("ev") == "configure" and t0 <= e["t_ns"] < t1]
        commits = [e for e in main if e.get("ev") == "commit" and t0 <= e["t_ns"] < t1]
        before = [e for e in main if e.get("ev") == "commit" and e["t_ns"] < t1]
        presented = [e for e in main if e.get("ev") == "presented" and e["t_ns"] < t1]
        seq = size_sequence(events, t0, t1)
        last_cfg = [e for e in main if e.get("ev") == "configure" and e["t_ns"] < t1]
        windows[name] = {
            "configures": len(cfgs), "commits": len(commits), "sizes": seq, "reversals": reversals(seq),
            "lastConfigureAfterStartMs": round((cfgs[-1]["t_ns"] - t0) / 1e6, 1) if cfgs else None,
            "finalSize": [before[-1]["width"], before[-1]["height"]] if before else None,
            "activated": ("activated" in (last_cfg[-1].get("states") or [])) if last_cfg else None,
            "refreshNs": presented[-1].get("refresh_ns") if presented else None,
            "exited": any(e.get("ev") in ("exit", "close_requested") for e in events if e.get("t_ns", 0) < t1),
        }
    worst = max((w["configures"] for w in windows.values()), default=0)
    revs = sum(w["reversals"] for w in windows.values())
    return {"windows": windows, "maxConfiguresPerWindow": worst, "reversals": revs}


def verdict_hint(stats: dict, converged: bool) -> str:
    if not converged:
        return "CHECK: windows were still receiving configures at the tail timeout (possible oscillation)"
    if stats["reversals"]:
        return f"CHECK: {stats['reversals']} size reversal(s) A->B->A (possible geometry fight)"
    if stats["maxConfiguresPerWindow"] > MAX_CONFIGURES_HINT:
        return (f"CHECK: a window received {stats['maxConfiguresPerWindow']} configures "
                f"(> {MAX_CONFIGURES_HINT}); fine for a multi-step action, suspicious for one change")
    return "converged; no reversals (placement still needs your visual check)"


def counter_delta(a: dict | None, b: dict | None) -> dict | None:
    if not a or not b or "counters" not in a or "counters" not in b:
        return None
    keys = ("solves", "writes", "corrections", "diverged", "overflow", "errors", "deadlines", "external", "stale")
    d = {k: b["counters"].get(k, 0) - a["counters"].get(k, 0) for k in keys}
    d["outstandingAfter"] = b.get("outstanding")
    d["windowsAfter"] = b.get("windows")
    d["connectionsAfter"] = b.get("connections")
    return d


class StdinReader:
    def __init__(self, monitor: orchestrate.Monitor):
        self.lines: list[str] = []
        self.buf = b""
        self.eof = False
        monitor.add(sys.stdin, self._feed)

    def _feed(self, data: bytes) -> None:
        if not data:
            self.eof = True
            return
        self.buf += data
        *lines, self.buf = self.buf.split(b"\n")
        self.lines += [ln.decode(errors="replace").strip() for ln in lines]

    def take(self) -> str | None:
        return self.lines.pop(0) if self.lines else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--windows", type=int, default=4)
    ap.add_argument("--quiet-ms", type=float, default=2000.0)
    ap.add_argument("--tail-timeout", type=float, default=20.0, help="seconds to wait for quiet after the end Enter")
    ap.add_argument("--no-counters", action="store_true")
    ap.add_argument("--fixture-arg", action="append", default=[], help="extra fixture flag, e.g. --fixture-arg=--csd")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)
    try:
        guard = common.guard_live_session()
    except common.GuardError as exc:
        print("REFUSING TO RUN: " + "; ".join(exc.reasons), file=sys.stderr)
        return 3
    import session_check  # noqa: E402
    bus = common.Bus()
    outdir = args.out or common.ARTIFACTS / f"observe-{common.stamp()}"
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "session-start.json").write_text(json.dumps(session_check.collect(guard=guard, bus=bus), indent=1) + "\n")
    if not common.FIXTURE.exists():
        print("build the fixture first: make -C fixtures/client", file=sys.stderr)
        return 1
    monitor = orchestrate.Monitor()
    driver = orchestrate.LiveDriver(bus, "manual", "", True)
    fixtures = []
    phases = []
    logs: dict[str, list[dict]] = {}
    os.set_blocking(sys.stdin.fileno(), False)
    stdin = StdinReader(monitor)
    try:
        for i in range(1, args.windows + 1):
            proc = subprocess.Popen(
                [str(common.FIXTURE), "--ssd", "--id", str(i), "--app-id", "plastile-fixture",
                 "--title", f"plastile-physical {i}", *args.fixture_arg],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL)
            fixtures.append(orchestrate.Fixture(i, proc, outdir / f"fixture-{i}.jsonl", monitor))
        if not monitor.wait_until(lambda: all(f.mapped for f in fixtures), 15):
            print("fixture windows did not map", file=sys.stderr)
            return 1
        print(f"{args.windows} fixture windows are open ('plastile-physical N'). Results: {outdir}")
        n = 0
        while True:
            print("\nPhase label (what you are about to do), then Enter. Empty label + Enter finishes.")
            monitor.wait_until(lambda: stdin.lines or stdin.eof, 24 * 3600)
            label = stdin.take()
            if not label:
                break
            n += 1
            outputs_before = common.kscreen_outputs()
            loaded = bus.script_loaded()
            c0 = driver.counters() if loaded and not args.no_counters else None
            t0 = common.monotonic_ns()
            print(f"[{label}] started. Perform the action now; press Enter when the windows look stable.")
            monitor.wait_until(lambda: stdin.lines or stdin.eof, 24 * 3600)
            stdin.take()
            t_end_user = common.monotonic_ns()
            quiet_ns = int(args.quiet_ms * 1e6)
            converged = monitor.wait_until(
                lambda t=t_end_user, q=quiet_ns: common.monotonic_ns() - max([f.last_cfg_ns for f in fixtures] + [t]) >= q,
                args.tail_timeout + args.quiet_ms / 1000)
            t1 = common.monotonic_ns()
            c1 = driver.counters() if loaded and not args.no_counters else None
            for f in fixtures:
                f.sink.raw.flush()
                logs[f"fixture-{f.ident}"] = common.read_jsonl(f.log_path)
            st = phase_stats(logs, t0, t1)
            rec = {"phase": n, "label": label, "startNs": t0, "userEndNs": t_end_user, "endNs": t1,
                   "durationS": round((t1 - t0) / 1e9, 2), "converged": converged, "plastileLoaded": loaded,
                   "counterDelta": counter_delta(c0, c1), "outputsBefore": outputs_before,
                   "outputsAfter": common.kscreen_outputs(), **st}
            rec["hint"] = verdict_hint(st, converged)
            phases.append(rec)
            with open(outdir / "phases.jsonl", "a") as fh:
                fh.write(json.dumps(rec) + "\n")
            print(f"[{label}] {rec['durationS']} s, converged={converged}, max configures/window "
                  f"{st['maxConfiguresPerWindow']}, reversals {st['reversals']}, counters {rec['counterDelta']}")
            for name, w in st["windows"].items():
                hz = f"{1e9 / w['refreshNs']:.1f} Hz" if w["refreshNs"] else "?"
                print(f"    {name}: {w['configures']} configures, sizes {w['sizes'][-4:]}, final {w['finalSize']}, "
                      f"output refresh {hz}{' (exited)' if w['exited'] else ''}")
            print("    -> " + rec["hint"])
    finally:
        for f in fixtures:
            f.quit()
        monitor.wait_until(lambda: all(f.proc.poll() is not None for f in fixtures), 5)
        for f in fixtures:
            if f.proc.poll() is None:
                f.proc.terminate()
            f.sink.close()
    (outdir / "observe-summary.json").write_text(json.dumps(
        {"windows": args.windows, "quietMs": args.quiet_ms, "phases": [
            {k: p[k] for k in ("phase", "label", "durationS", "converged", "maxConfiguresPerWindow", "reversals",
                               "counterDelta", "hint")} for p in phases]}, indent=1) + "\n")
    print(f"\n{len(phases)} phases recorded in {outdir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
