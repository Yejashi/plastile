#!/usr/bin/env python3
"""T02 lifecycle probe: repeated load/unload with a live window and pending work.

Per cycle:
  load -> start + adoption of the live fixture window
  invoke shortcut once            -> exactly one 'shortcut' line, then one flush
  invoke shortcut, unload at once -> pending Qt.callLater flush + 250 ms deadline at unload
  after teardown: invoke shortcut, add + remove a window, wait > deadline
                  -> no line from any dead instance (except explicit stale rejections)
Records kwin RSS, fd count, and kglobalaccel 'kwin' shortcut name count per cycle.

Usage: python3 probes/lifecycle/run.py [--cycles N] [--leak-control]
Writes artifacts/lifecycle/<stamp>/{cycles.jsonl,summary.json,kwin.log}.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from nested import NestedKwin, NestedError  # noqa: E402

PLUGIN = "plt-lifecycle"
SHORTCUT = "plastile-probe-lifecycle-ping"
LINE = re.compile(r"PLT-LC (\S+) (\S+)(?: (.*))?$")


def events(lines: list[str]) -> list[tuple[str, str, str]]:
    out = []
    for ln in lines:
        m = LINE.search(ln)
        if m:
            out.append((m.group(1), m.group(2), m.group(3) or ""))
    return out


def fd_count(pid: int) -> int | None:
    # kwin_wayland has file capabilities (cap_sys_nice), so it is non-dumpable and
    # /proc/<pid>/fd is unreadable to the same user. Report unavailable, not zero.
    try:
        return len(os.listdir(f"/proc/{pid}/fd"))
    except PermissionError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cycles", type=int, default=100)
    ap.add_argument("--leak-control", action="store_true")
    ap.add_argument("--settle", type=float, default=0.4, help="seconds to wait for stale callbacks (> 250 ms deadline)")
    args = ap.parse_args()

    fixture_bin = ROOT / "fixtures/client/build/plastile-fixture"
    if fixture_bin.exists():
        window_cmd, fixture_class = [str(fixture_bin)], "plastile-fixture"
    else:
        window_cmd, fixture_class = ["qml6", str(ROOT / "probes/capability/stand-in-window.qml")], "org.qt-project.qml6"

    stamp = time.strftime("%Y%m%dT%H%M%S") + ("-leak" if args.leak_control else "")
    out = ROOT / "artifacts/lifecycle" / stamp
    out.mkdir(parents=True, exist_ok=True)
    kwinrc = (f"[Script-{PLUGIN}]\nfixtureClass={fixture_class}\n"
              f"leakControl={'true' if args.leak_control else 'false'}\n")
    failures: list[str] = []
    records = []
    with NestedKwin(out, kwinrc=kwinrc) as kw:
        live = kw.spawn(window_cmd)
        time.sleep(1.0)
        baseline = {"rssKiB": kw.kwin_rss_kib(), "fds": fd_count(kw.kwin_pid)}
        dead: set[str] = set()
        for cycle in range(args.cycles):
            rec: dict = {"cycle": cycle}
            off = kw.mark()
            kw.load_declarative(HERE / "package/contents/ui/main.qml", PLUGIN)
            start = kw.wait_log(r"PLT-LC start ", 5, off)
            inst = events(start)[-1][1]
            kw.wait_log(rf"PLT-LC adopt {inst} ", 5, off)

            # One activation -> exactly one handler and one coalesced flush.
            t_send = kw.invoke_shortcut(SHORTCUT)
            kw.wait_log(rf"PLT-LC flush {inst} ", 5, off)
            # Pending work at unload: shortcut schedules flush + deadline, then unload immediately.
            kw.invoke_shortcut(SHORTCUT)
            kw.unload(PLUGIN)
            kw.wait_log(rf"PLT-LC teardown {inst} ", 5, off)
            dead.add(inst)
            post = kw.mark()

            # Stimuli after teardown.
            try:
                kw.invoke_shortcut(SHORTCUT)
                rec["postUnloadShortcutInvoke"] = "accepted"
            except NestedError as exc:
                rec["postUnloadShortcutInvoke"] = f"rejected: {str(exc)[:120]}"
            extra = kw.spawn(window_cmd)
            time.sleep(0.5)
            extra.terminate()
            extra.wait(timeout=5)
            time.sleep(args.settle)

            text = kw.log_text()
            pre = events(text[off:post].splitlines())
            after = events(text[post:].splitlines())
            ev = pre + after
            mine = [e for e in ev if e[1] == inst]
            shortcuts = [e for e in mine if e[0] == "shortcut"]
            rec.update({
                "instance": inst,
                "dispatchSendNs": t_send,
                "shortcutHandlers": len(shortcuts),
                "flushes": len([e for e in mine if e[0] == "flush"]),
                "teardown": next((e[2] for e in mine if e[0] == "teardown"), None),
                "staleRejections": [e[0] for e in ev if e[0].startswith("stale-")],
                "postTeardownLinesFromDeadInstances": [f"{e[0]} {e[1]}" for e in after if e[1] in dead],
                "leakClosureFiredAfterUnload": len([e for e in after if e[0] == "leak-closure-fired"]),
                "otherInstanceLinesDuringCycle": [f"{e[0]} {e[1]}" for e in pre if e[1] != inst],
                "rssKiB": kw.kwin_rss_kib(),
                "fds": fd_count(kw.kwin_pid),
                "kwinShortcutNames": len(kw.shortcut_names()),
                "liveWindowAlive": live.poll() is None,
            })
            # Acceptance checks for the registry/guard path (leak control lines are expected
            # to be the only dead-instance output when --leak-control is set).
            unexpected = [x for x in rec["postTeardownLinesFromDeadInstances"] if not x.startswith("leak-closure-fired")]
            if rec["shortcutHandlers"] != 2:
                failures.append(f"cycle {cycle}: {rec['shortcutHandlers']} shortcut handlers (expected 2: one probe + one pending)")
            if unexpected:
                failures.append(f"cycle {cycle}: dead-instance activity {unexpected}")
            if rec["otherInstanceLinesDuringCycle"]:
                failures.append(f"cycle {cycle}: other instance active {rec['otherInstanceLinesDuringCycle']}")
            if rec["teardown"] is None or "remaining=0" not in rec["teardown"]:
                failures.append(f"cycle {cycle}: incomplete teardown {rec['teardown']}")
            records.append(rec)
        final = {"rssKiB": kw.kwin_rss_kib(), "fds": fd_count(kw.kwin_pid)}
        kglobal = (Path(kw.root) / "config/kglobalshortcutsrc")
        kglobal_text = kglobal.read_text() if kglobal.exists() else None

    with open(out / "cycles.jsonl", "w") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")
    leak_total = sum(r["leakClosureFiredAfterUnload"] for r in records)
    summary = {
        "cycles": args.cycles,
        "leakControl": args.leak_control,
        "windowCommand": window_cmd[0] if fixture_bin.exists() else "qml6 stand-in",
        "baseline": baseline,
        "final": final,
        "rssKiBByCycle": [r["rssKiB"] for r in records[:: max(1, len(records) // 10)]],
        "fdsByCycle": [r["fds"] for r in records[:: max(1, len(records) // 10)]],
        "kwinShortcutNamesFirstLast": [records[0]["kwinShortcutNames"], records[-1]["kwinShortcutNames"]] if records else None,
        "staleRejectionKinds": sorted({k for r in records for k in r["staleRejections"]}),
        "staleRejectionCount": sum(len(r["staleRejections"]) for r in records),
        "postUnloadShortcutInvoke": sorted({r["postUnloadShortcutInvoke"] for r in records}),
        "leakClosureFiredAfterUnloadTotal": leak_total,
        "kglobalshortcutsrcMentionsProbe": bool(kglobal_text and SHORTCUT in kglobal_text),
        "failures": failures,
        "pass": not failures,
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))
    print(out)
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
