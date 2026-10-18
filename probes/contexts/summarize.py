#!/usr/bin/env python3
"""Summarize context-scenario reports into docs/status/evidence/contexts-o08-e08.json.

Usage: python3 probes/contexts/summarize.py artifacts/integration/<stamp>/report.json [...]
Keeps per-check pass/fail for every run, the recorded API facts and failing-check details from
the last run. Session-local UUIDs are replaced by stable labels; no paths or real-app titles.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAMES = ("per-output-desktops-O08", "activities-E08", "activities-late-service-E08", "activities-add-second-E08")
UUID = re.compile(r"\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?")


def redact(obj):
    labels: dict[str, str] = {}

    def sub(m):
        u = m.group(0)
        if u.strip("{}") == "00000000-0000-0000-0000-000000000000":
            return "<nil-uuid>"
        return labels.setdefault(u, f"<uuid-{len(labels) + 1}>")
    text = json.dumps(obj)
    text = UUID.sub(sub, text)
    text = text.replace(str(Path.home()), "~")
    return json.loads(text)


def main(paths: list[str]) -> None:
    reports = [json.loads(Path(p).read_text()) for p in paths]
    last = reports[-1]
    runs = []
    for r in reports:
        runs.append({n: {"pass": r["scenarios"][n]["pass"],
                         "checks": {k: v["pass"] for k, v in r["scenarios"][n]["checks"].items() if not k.startswith("facts")}}
                     for n in NAMES if n in r["scenarios"]})
    detail = {}
    for n in NAMES:
        sc = last["scenarios"].get(n)
        if not sc:
            continue
        detail[n] = {
            "facts": sc["checks"].get("facts (recorded, always passes)", {}).get("detail"),
            "failing": {k: v["detail"] for k, v in sc["checks"].items() if not v["pass"]},
            "error": sc["error"],
        }
    out = {
        "layer": last["layer"], "kwin": last["kwin"], "implementationCommit": last["implementationCommit"],
        "implementationDirty": last["implementationDirty"],
        "harness": "tests/integration/scenarios_contexts.py; listener probes/contexts/listen.js; "
                   "kactivitymanagerd 6.7.5 on the nested private bus",
        "runs": len(reports), "perRun": runs, "lastRun": detail,
    }
    dest = ROOT / "docs/status/evidence/contexts-o08-e08.json"
    dest.write_text(json.dumps(redact(out), indent=1) + "\n")
    print(dest)


if __name__ == "__main__":
    main(sys.argv[1:])
