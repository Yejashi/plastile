#!/usr/bin/env python3
"""Run the M0 capability probe in a disposable nested KWin and save raw JSON.

Usage: python3 probes/capability/run.py [--outputs N] [--fixture CMD...]
Writes artifacts/capability/<stamp>/{caps-a.json,caps-b.json,kwin.log,meta.json}.
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from nested import NestedKwin  # noqa: E402

PLUGIN = "plt-caps"


def extract(lines: list[str], tag: str) -> dict:
    line = lines[-1]
    return json.loads(line[line.index(tag) + len(tag) + 1:])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--outputs", type=int, default=2)
    ap.add_argument("--fixture", default=None, help="client command line; default: qml6 stand-in window")
    ap.add_argument("--fixture-class", default=None)
    args = ap.parse_args()
    fixture_bin = ROOT / "fixtures/client/build/plastile-fixture"
    if args.fixture:
        fixture, fixture_class = shlex.split(args.fixture), args.fixture_class or "plastile-fixture"
    elif fixture_bin.exists():
        fixture, fixture_class = [str(fixture_bin), "--ssd"], "plastile-fixture"
    else:
        fixture, fixture_class = ["qml6", str(HERE / "stand-in-window.qml")], args.fixture_class or "org.qt-project.qml"
    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = ROOT / "artifacts/capability" / stamp
    kwinrc = f"[Script-{PLUGIN}]\ndisposable=true\nfixtureClass={fixture_class}\n"
    with NestedKwin(out, outputs=args.outputs, kwinrc=kwinrc) as kw:
        kw.spawn(fixture)
        time.sleep(1.0)  # let the stand-in map before the probe enumerates windows
        kw.mark()
        kw.load_declarative(HERE / "package/contents/ui/main.qml", PLUGIN)
        a = extract(kw.wait_log(r"PLT-CAPS-A ", 10), "PLT-CAPS-A")
        try:
            b = extract(kw.wait_log(r"PLT-CAPS-B ", 10), "PLT-CAPS-B")
        except Exception as exc:  # report, do not hide
            b = {"error": f"phase B not reached: {exc}"}
        names = kw.shortcut_names()
        kw.unload(PLUGIN)
        kw.wait_log(r"PLT-CAPS-DESTROYED", 5)
        version = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
    out.mkdir(parents=True, exist_ok=True)
    (out / "caps-a.json").write_text(json.dumps(a, indent=1))
    (out / "caps-b.json").write_text(json.dumps(b, indent=1))
    (out / "meta.json").write_text(json.dumps({
        "kwinVersion": version, "outputs": args.outputs, "fixture": fixture,
        "fixtureClass": fixture_class, "kglobalaccelKwinShortcutNamesContainProbe":
        "plastile-probe-capability-noop" in names}, indent=1))
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
