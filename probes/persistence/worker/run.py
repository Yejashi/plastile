#!/usr/bin/env python3
"""Can a KWin declarative script write files off the compositor thread with a WorkerScript? (nested KWin)

Loads probes/persistence/worker in a disposable nested session. Two workers (classic .js and ES module .mjs)
report what their engine offers and try an XMLHttpRequest PUT to a file:// URL and, in the classic worker, a
QtQuick.LocalStorage (SQLite) write. The classic worker then spins for 1.5 s while the main thread's 5 ms
timer records its worst tick gap, which shows whether the worker runs on its own thread.

Usage: python3 probes/persistence/worker/run.py [--publish docs/status/evidence/persistence-worker-probe.json]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
from nested import NestedKwin  # noqa: E402

QML = ROOT / "probes/persistence/worker/contents/ui/main.qml"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--publish", type=Path)
    args = ap.parse_args()
    out = ROOT / "artifacts/persistence-worker" / time.strftime("%Y%m%dT%H%M%S")
    with NestedKwin(out) as kw:
        off = kw.mark()
        kw.load_declarative(QML, "plastileworkerprobe")
        time.sleep(9)
        events = [json.loads(l.split("PLT worker ", 1)[1]) for l in kw.lines_since(off, r"PLT worker ")]
        errors = [l.split(" ", 2)[-1] for l in kw.lines_since(off, r"ReferenceError|TypeError|WorkerScript")]
        written = sorted(p.name for p in Path(kw.root).rglob("xhr-*.txt"))
    result = {
        "experiment": "WorkerScript file writes from a KWin declarative script",
        "layer": "nested KWin virtual backend (not physical)",
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "kwin": subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip(),
        "events": events, "errors": [e.replace(str(ROOT), "<repo>") for e in errors], "filesWritten": written,
    }
    text = json.dumps(result, indent=1)
    print(text)
    if args.publish:
        args.publish.write_text(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
