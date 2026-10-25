#!/usr/bin/env python3
"""Run Plastile integration scenarios in disposable nested KWin sessions.

Usage: python3 tests/integration/run.py [--only NAME[,NAME]] [--list] [--fail-on-skip] [--expect-skips NAME[,NAME]]
Requires: npm run build, make -C fixtures/client, the persistence helper (cmake -S helper -B build/helper &&
cmake --build build/helper, or PLASTILE_STATE_HELPER).
Writes artifacts/integration/<stamp>/{report.json,<scenario>/kwin.log,...}.
Exit status is non-zero if any check fails. A scenario whose required capability is
absent here (e.g. no activity service, no OpenGL compositing) is reported as SKIP
with its reason and ID; skips are never counted as passes, and --fail-on-skip makes
them fatal.
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
from harness import FIXTURE, PACKAGE_QML, ROOT, STATE_HELPER, provenance  # noqa: E402
import importlib  # noqa: E402
from scenarios import SCENARIOS, Checks, Skipped  # noqa: E402

# Additional scenario modules (tests/integration/scenarios_*.py) register into SCENARIOS.
for _mod in sorted(HERE.glob("scenarios_*.py")):
    importlib.import_module(_mod.stem)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--fail-on-skip", action="store_true", help="treat SKIP (missing capability) as failure")
    ap.add_argument("--expect-skips", default=None,
                    help="comma-separated scenarios allowed to SKIP; any other SKIP fails the run (CI allowlist)")
    ap.add_argument("--markdown", type=Path, help="also append a Markdown summary (e.g. $GITHUB_STEP_SUMMARY)")
    args = ap.parse_args()
    if args.list:
        print("\n".join(SCENARIOS))
        return 0
    for need in (FIXTURE, PACKAGE_QML.parent.parent / "code/plastile.mjs", STATE_HELPER):
        if not need.exists():
            sys.exit(f"missing {need}: run `make -C fixtures/client`, `npm run build` and "
                     "`cmake -S helper -B build/helper && cmake --build build/helper`")
    names = [n for n in args.only.split(",") if n] or list(SCENARIOS)
    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = ROOT / "artifacts/integration" / stamp
    kwin = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
    report = {**provenance(), "kwin": kwin, "layer": "nested KWin virtual backend (not physical)", "scenarios": {}}
    failed = 0
    skipped: dict[str, str] = {}
    for name in names:
        c = Checks()
        t0 = time.monotonic()
        error = None
        skip = None
        try:
            SCENARIOS[name](out / name, c)
        except Skipped as exc:
            skip = str(exc)
        except Exception as exc:  # a crash is a failure, reported with its trace
            error = "".join(traceback.format_exception(exc))[-1500:]
        res = {"checks": c.items, "error": error, "seconds": round(time.monotonic() - t0, 1)}
        if skip is not None and not args.fail_on_skip and all(v["pass"] for v in c.items.values()):
            res["pass"] = None
            res["skipped"] = skip
            skipped[name] = skip
            report["scenarios"][name] = res
            print(f"SKIP {name} ({res['seconds']} s): {skip}")
            continue
        if skip is not None:
            error = f"skipped (fatal with --fail-on-skip or after failed checks): {skip}"
            res["error"] = error
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
    ran = len(names) - len(skipped)
    report["summary"] = {"scenarios": len(names), "failedScenarios": failed, "skippedScenarios": len(skipped),
                         "skipped": skipped, "checks": total, "passedChecks": passed}
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=1))
    print(f"{passed}/{total} checks, {ran - failed}/{ran} run scenarios passed, {len(skipped)} skipped "
          f"-> {out / 'report.json'}")
    for name, why in skipped.items():
        print(f"     SKIP {name}: {why}")
    if args.markdown:
        write_markdown(args.markdown, report)
    if args.expect_skips is not None:
        allowed = {n for n in args.expect_skips.split(",") if n}
        unexpected = sorted(set(skipped) - allowed)
        report["summary"]["unexpectedSkips"] = unexpected
        (out / "report.json").write_text(json.dumps(report, indent=1))
        for name in unexpected:
            print(f"     ✖ unexpected SKIP {name} (not in --expect-skips): {skipped[name]}")
        if unexpected:
            return 1
    return 1 if failed else 0


def write_markdown(path: Path, report: dict) -> None:
    """Per-scenario outcome table; failures and skips are listed by ID with their reason."""
    sm = report["summary"]
    ran = sm["scenarios"] - sm["skippedScenarios"]
    lines = [f"### Nested KWin integration ({report['kwin']}, {report['layer']})", "",
             f"{sm['passedChecks']}/{sm['checks']} checks; {ran - sm['failedScenarios']}/{ran} run scenarios passed; "
             f"{sm['skippedScenarios']} skipped. Commit `{report['implementationCommit'][:12]}`"
             f"{' (dirty)' if report['implementationDirty'] else ''}.", "",
             "| Scenario | Result | Detail |", "|---|---|---|"]
    for name, r in report["scenarios"].items():
        if r.get("skipped"):
            lines.append(f"| {name} | SKIP | {r['skipped']} |")
        elif r["pass"]:
            lines.append(f"| {name} | PASS | {len(r['checks'])} checks |")
        else:
            bad = [k for k, v in r["checks"].items() if not v["pass"]]
            err = (r["error"] or "").strip().splitlines()
            why = "; ".join(bad[:3]) if bad else (err[-1] if err else "")
            lines.append(f"| {name} | **FAIL** | {why.replace('|', '/')[:300]} |")
    with path.open("a") as fh:
        fh.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    sys.exit(main())
