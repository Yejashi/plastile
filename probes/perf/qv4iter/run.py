#!/usr/bin/env python3
"""Map/Set iteration under mutation: QV4's for...of against its forEach, with V8 as reference.

Review finding on wf/g2-perf (G2 report §16.9): the apply loop and fitMaxima() moved from
for...of to Map.forEach on the claim that QV4 handles deletion during either the same way. This
probe checks that claim. It runs probes/perf/qv4iter/cases.js twice:

- in QV4, through the `qml` tool on the offscreen platform (the same libQt6Qml that KWin loads;
  no compositor, no KWin, nothing nested);
- in Node (V8), whose behaviour is the ECMAScript one.

It prints a table of visit orders and writes JSON with --out. Exit 0 always; the table is the result.

Usage: python3 probes/perf/qv4iter/run.py [--qml qml6] [--out FILE]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

NODE = r"""
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[1], "utf8").replace(".pragma library", "");
console.log(JSON.stringify(new Function(src + "\nreturn results();")()));
"""


def qv4(qml: str) -> tuple[dict, str]:
    env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_FORCE_STDERR_LOGGING="1")
    p = subprocess.run([qml, str(HERE / "main.qml")], capture_output=True, text=True, env=env, timeout=60)
    m = re.search(r"qv4iter (\{.*\})", p.stdout + p.stderr)
    if not m:
        raise SystemExit(f"no result from {qml}: {p.stderr[-500:]}")
    ver = subprocess.run([qml, "--version"], capture_output=True, text=True).stdout.strip()
    return json.loads(m.group(1)), ver


def v8() -> tuple[dict, str]:
    p = subprocess.run(["node", "-e", NODE, str(HERE / "cases.js")], capture_output=True, text=True, check=True)
    ver = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    return json.loads(p.stdout), ver


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--qml", default="qml6")
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    q, qver = qv4(a.qml)
    s, sver = v8()
    rows, deviations = [], []
    for case, kinds in q.items():
        for kind, got in kinds.items():
            ref = s[case][kind]
            rows.append({"case": case, "kind": kind, "qv4": got, "v8": ref, "same": got == ref})
            if got != ref:
                deviations.append(f"{case} / {kind}: QV4 {got}, ECMAScript (V8) {ref}")
    print(f"{'case':32s} {'kind':16s} {'QV4':8s} {'V8':8s}")
    for r in rows:
        print(f"{r['case']:32s} {r['kind']:16s} {r['qv4']:8s} {r['v8']:8s}{'' if r['same'] else '  <- differs'}")
    out = {"probe": "probes/perf/qv4iter", "layer": "QV4 in the qml tool (offscreen), V8 in Node; not KWin, not nested",
           "qml": qver, "node": sver, "rows": rows, "deviations": deviations}
    if a.out:
        a.out.parent.mkdir(parents=True, exist_ok=True)
        a.out.write_text(json.dumps(out, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
