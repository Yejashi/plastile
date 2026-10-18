#!/usr/bin/env python3
"""E15/M8 probe: can a script park a window outside every output, and does it stay?

Two side-by-side virtual outputs, one fixture window, no Plastile. Writes frames
left of, right of, and partly beyond the workspace, reads them back after the
client settles, then changes an output's scale and reads again. Also records which
window properties a script can write (opacity, minimized, skipTaskbar, keepBelow).

Usage: python3 probes/scrolling/offscreen.py [--publish docs/status/evidence/scrolling-offscreen-e15.json]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests/integration"))
sys.path.insert(0, str(ROOT / "tools"))
from harness import Session  # noqa: E402

FIND = "const w = workspace.windowList().find(x => x.caption === 'plastile-fixture 1');"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--publish", type=Path)
    args = ap.parse_args()
    out = ROOT / "artifacts/scrolling-offscreen" / time.strftime("%Y%m%dT%H%M%S")
    res: dict = {"experiment": "E15/M8: off-screen parking and writable window properties",
                 "layer": "nested KWin virtual backend (not physical)",
                 "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                 "kwin": subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip(),
                 "placements": {}}

    with Session(out, outputs=2) as s:
        def q(body: str) -> dict:
            return json.loads(s.js(FIND + body)[0])
        s.spawn(1)
        time.sleep(0.5)
        res["outputs"] = json.loads(s.js("emit(workspace.screens.map(o => ({name: o.name, geometry: o.geometry})))")[0])
        for label, x in (("left of all outputs", -2000), ("right of all outputs", 3060), ("partly beyond the right edge", 2400)):
            q(f"w.frameGeometry = {{x: {x}, y: 50, width: 600, height: 400}}; emit({{}})")
            time.sleep(0.6)
            res["placements"][label] = {"requestedX": x, "settled": q("emit({frame: w.frameGeometry, output: w.output.name})")}
        q("w.frameGeometry = {x: -2000, y: 50, width: 600, height: 400}; emit({})")
        time.sleep(0.6)
        subprocess.run(["kscreen-doctor", "output.Virtual-1.scale.1.5"], env=s.kw.client_env(), capture_output=True, timeout=15)
        time.sleep(1.0)
        res["afterTopologyChange"] = {"requestedX": -2000, "change": "Virtual-1 scale 1 -> 1.5",
                                      "settled": q("emit({frame: w.frameGeometry, output: w.output.name})")}
        q("w.frameGeometry = {x: 100, y: 50, width: 600, height: 400}; emit({})")
        res["writable"] = {
            "opacity": q("w.opacity = 0.0; const a = w.opacity; w.opacity = 1.0; emit({set0: a, back: w.opacity})"),
            "minimized": q("w.minimized = true; const a = w.minimized; w.minimized = false; emit({set: a, back: w.minimized})"),
            "skipTaskbar": q("w.skipTaskbar = true; const a = w.skipTaskbar; w.skipTaskbar = false; emit({set: a, back: w.skipTaskbar})"),
            "keepBelow": q("w.keepBelow = true; const a = w.keepBelow; w.keepBelow = false; emit({set: a, back: w.keepBelow})"),
        }
    left = res["placements"]["left of all outputs"]["settled"]["frame"]["x"]
    right = res["placements"]["right of all outputs"]["settled"]["frame"]["x"]
    res["conclusion"] = {
        "parkedOutsideAllOutputsStays": left == -2000 and right == 3060,
        "topologyChangePullsBack": res["afterTopologyChange"]["settled"]["frame"]["x"] != -2000,
    }
    text = json.dumps(res, indent=1)
    print(text)
    if args.publish:
        args.publish.write_text(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
