#!/usr/bin/env python3
"""T27/E12: QtCore Settings persistence from a KWin declarative script (nested KWin).

Loads probes/persistence/package twice (unload in between) in one disposable nested
session and checks that the second load reads what the first wrote. The settings
file lives in the session's private XDG_STATE_HOME, removed with the session.

Usage: python3 probes/persistence/run.py [--publish docs/status/evidence/persistence-t27.json]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from nested import NestedKwin  # noqa: E402
import sysinfo  # noqa: E402

QML = ROOT / "probes/persistence/package/contents/ui/main.qml"
PLUGIN = "plastileqtcoreprobe"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--publish", type=Path)
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = ROOT / "artifacts/persistence" / stamp
    events: list[dict] = []
    with NestedKwin(out) as kw:
        for _ in range(2):
            off = kw.mark()
            kw.load_declarative(QML, PLUGIN)
            kw.wait_log(r"PLT persistence .*synced", 10, off)
            events += [json.loads(l.split("PLT persistence ", 1)[1]) for l in kw.lines_since(off, r"PLT persistence ")]
            kw.call("/Scripting", "org.kde.kwin.Scripting", "unloadScript", "s", PLUGIN)
            time.sleep(0.3)
        state = Path(kw.root / "state/plastile-probe/state.ini")
        content = state.read_text() if state.exists() else None
    loads = [e for e in events if e["phase"] == "loaded"]
    ok = len(loads) == 2 and loads[0]["counter"] == 0 and loads[1]["counter"] == 1 and '"ratio":0.6' in loads[1]["json"]
    result = {
        "experiment": "E12/T27: QtCore Settings persistence from a declarative KWin script",
        "layer": "nested KWin virtual backend (not physical)",
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "kwin": subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip(),
        "qtcoreQmlModule": sysinfo.component_version("qt6-declarative"),
        "events": events,
        "fileWritten": content is not None,
        "secondLoadReadsFirstWrite": ok,
    }
    text = json.dumps(result, indent=1)
    print(text)
    if args.publish:
        args.publish.write_text(text + "\n")
    return 0 if ok and content is not None else 1


if __name__ == "__main__":
    sys.exit(main())
