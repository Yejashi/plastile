#!/usr/bin/env python3
"""Run Plastile integration scenarios in disposable nested KWin sessions.

Usage: python3 tests/integration/run.py [--only NAME[,NAME]] [--list]
Requires: npm run build, make -C fixtures/client.
Writes artifacts/integration/<stamp>/{report.json,<scenario>/kwin.log,...}.
Exit status is non-zero if any check fails; skipped scenarios are listed by name.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from harness import FIXTURE, PACKAGE_QML, ROOT  # noqa: E402
from scenarios import SCENARIOS, Checks  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    if args.list:
        print("\n".join(SCENARIOS))
        return 0
    for need in (FIXTURE, PACKAGE_QML.parent.parent / "code/plastile.mjs"):
        if not need.exists():
            sys.exit(f"missing {need}: run `make -C fixtures/client` and `npm run build`")
    names = [n for n in args.only.split(",") if n] or list(SCENARIOS)
    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = ROOT / "artifacts/integration" / stamp
    rev = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "src", "package", "tests", "tools"],
                                capture_output=True, text=True).stdout.strip())
    kwin = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
    report = {"implementationCommit": rev, "implementationDirty": dirty, "kwin": kwin,
              "layer": "nested KWin virtual backend (not physical)", "scenarios": {}}
    failed = 0
    for name in names:
        c = Checks()
        t0 = time.monotonic()
        error = None
        try:
            SCENARIOS[name](out / name, c)
        except Exception as exc:  # a crash is a failure, reported with its trace
            error = "".join(traceback.format_exception(exc))[-1500:]
        res = {"checks": c.items, "error": error, "seconds": round(time.monotonic() - t0, 1)}
        res["pass"] = error is None and all(v["pass"] for v in c.items.values())
        failed += 0 if res["pass"] else 1
        report["scenarios"][name] = res
        mark = "PASS" if res["pass"] else "FAIL"
        print(f"{mark} {name} ({res['seconds']} s)")
        for k, v in c.items.items():
            if not v["pass"]:
                print(f"     ✖ {k}: {json.dumps(v['detail'])[:300]}")
        if error:
            print("     ✖ error: " + error.strip().splitlines()[-1])
    total = sum(len(r["checks"]) for r in report["scenarios"].values())
    passed = sum(1 for r in report["scenarios"].values() for v in r["checks"].values() if v["pass"])
    report["summary"] = {"scenarios": len(names), "failedScenarios": failed, "checks": total, "passedChecks": passed}
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=1))
    print(f"{passed}/{total} checks, {len(names) - failed}/{len(names)} scenarios passed -> {out / 'report.json'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
