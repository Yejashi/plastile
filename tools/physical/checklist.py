#!/usr/bin/env python3
"""Checklist and report bundle for a physical validation session (docs/validation/PHYSICAL_RUNBOOK.md).

    python3 tools/physical/checklist.py new  artifacts/physical/<stamp>        # creates checklist.json
    python3 tools/physical/checklist.py set  artifacts/physical/<stamp> PHY-03a pass "notes" [--evidence FILE]
    python3 tools/physical/checklist.py show artifacts/physical/<stamp>
    python3 tools/physical/checklist.py report artifacts/physical/<stamp> [--publish PATH]

`report` merges the checklist with what the tools wrote under that directory (session
report, latency summaries, observe phases, soak/idle summaries) into report.json (private)
and a redacted report-redacted.json (or --publish PATH) that contains only versions, output
modes, statuses, your notes, and statistics. Notes are published verbatim: keep window
titles, host names and anything private out of them. Touches no session state at all.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

RUNBOOK = "docs/validation/PHYSICAL_RUNBOOK.md"
STATUSES = ("not-run", "pass", "fail", "blocked", "skipped", "n/a")
# (id, title, TEST_MATRIX/PERFORMANCE ids, runbook anchor, optional)
ITEMS = [
    ("PHY-00", "Session check passes (read-only)", [], "p0-session-check", False),
    ("PHY-01", "Install, enable, smoke test (started, counters, explain), uninstall path known", ["Q11"],
     "p1-install-and-smoke-test", False),
    ("PHY-02a", "Mixed refresh outputs: correct placement on each; per-output timing recorded", ["O02"],
     "p2a-mixed-refresh-rates-o02", False),
    ("PHY-02b", "Fractional scale 1.25/1.5/1.75 on one physical output: converges, no repeated corrections", ["G03"],
     "p2b-fractional-scaling-g03-physical-half", False),
    ("PHY-02c", "Output priority change: identity and preferences unchanged", ["O03"],
     "p2c-output-priority-and-reordering-o03", False),
    ("PHY-02d", "Unplug and replug a monitor: windows visible, deterministic recovery or explained fallback",
     ["O04", "O05", "E16"], "p2d-unplug-and-replug-o05-e16", False),
    ("PHY-02e", "Suspend and resume with tiled windows: layout intact, no errors", ["O05"],
     "p2e-suspend-and-resume", False),
    ("PHY-03a", "Panel add and remove", ["O07"], "p3-panels-with-plasmashell-o07", False),
    ("PHY-03b", "Panel auto-hide on and off", ["O07"], "p3-panels-with-plasmashell-o07", False),
    ("PHY-03c", "Floating panel on and off", ["O07"], "p3-panels-with-plasmashell-o07", False),
    ("PHY-03d", "Panel resize (thickness)", ["O07"], "p3-panels-with-plasmashell-o07", False),
    ("PHY-03e", "Panel moved to another screen / edge", ["O07"], "p3-panels-with-plasmashell-o07", False),
    ("PHY-04", "Activities: tiled windows on two activities; switch, create, delete", ["E08", "O09", "L16"],
     "p4-activities-e08-o09", False),
    ("PHY-05-konsole", "Real app: Konsole", ["TEST_MATRIX section 4"], "p5-real-applications-g14-g15", False),
    ("PHY-05-kate", "Real app: Kate", ["TEST_MATRIX section 4"], "p5-real-applications-g14-g15", False),
    ("PHY-05-dolphin", "Real app: Dolphin", ["TEST_MATRIX section 4"], "p5-real-applications-g14-g15", False),
    ("PHY-05-browser", "Real app: Firefox or Chromium", ["TEST_MATRIX section 4"], "p5-real-applications-g14-g15",
     False),
    ("PHY-05-dialogs", "Real app: a dialog-heavy application", ["TEST_MATRIX section 4", "L07"],
     "p5-real-applications-g14-g15", False),
    ("PHY-05-xwayland", "Real app: an XWayland application", ["TEST_MATRIX section 4", "G10"],
     "p5-real-applications-g14-g15", False),
    ("PHY-05-g14", "Toggle 'no border' while tiled and back: no restore corruption", ["G14", "Q10"],
     "p5-real-applications-g14-g15", False),
    ("PHY-05-g15", "Titlebar buttons and tabs clickable after tile and resize", ["G15"],
     "p5-real-applications-g14-g15", False),
    ("PHY-06-60", "Input-to-visible latency at 60 Hz vs baselines (>= 5 runs, >= 5000 samples)", ["P00", "P02", "P03"],
     "p6-input-to-visible-latency-p00-p03", False),
    ("PHY-06-100", "Input-to-visible latency at 100 Hz vs baselines", ["P00", "P02", "P03"],
     "p6-input-to-visible-latency-p00-p03", False),
    ("PHY-06-144", "Input-to-visible latency at 144 Hz vs baselines", ["P00", "P02", "P03"],
     "p6-input-to-visible-latency-p00-p03", False),
    ("PHY-07a", "Every default binding on the real keymap reaches Plastile (or is reported as not working)",
     ["D10", "Q08"], "p7-shortcuts-on-the-real-keymap-d10-and-the-tile-editor", False),
    ("PHY-07b", "Meta+T still opens KWin's tile editor with Plastile loaded", ["L14"],
     "p7-shortcuts-on-the-real-keymap-d10-and-the-tile-editor", False),
    ("PHY-08a", "Soak: several hours of daily use; no growing connection/window counts; no errors",
     ["P15", "Q09"], "p8-soak-and-idle", False),
    ("PHY-08b", "Idle: no Plastile work while idle; kwin CPU/wakeups vs Plastile disabled", ["C14", "P15"],
     "p8-soak-and-idle", False),
    ("PHY-09", "G1 physical repeat (direct vs native spike), only with explicit consent", ["ADR-003"],
     "p9-g1-physical-repeat-optional-consent", True),
    ("PHY-10", "Uninstall and clean-up verified", ["Q11"], "6-uninstall-and-clean-up", False),
]


def new_checklist(stamp: str) -> dict:
    return {"schema": 1, "stamp": stamp, "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "statuses": list(STATUSES), "items": [
                {"id": i, "title": t, "matrixIds": ids, "procedure": f"{RUNBOOK}#{anchor}", "optional": opt,
                 "status": "not-run", "notes": "", "evidence": []} for i, t, ids, anchor, opt in ITEMS]}


def validate(cl: dict) -> list[str]:
    errs = []
    known = {i[0] for i in ITEMS}
    seen = set()
    for it in cl.get("items", []):
        if it.get("status") not in STATUSES:
            errs.append(f"{it.get('id')}: unknown status {it.get('status')!r}")
        if it.get("status") in ("fail", "blocked", "skipped", "n/a") and not it.get("notes"):
            errs.append(f"{it['id']}: status {it['status']} needs a note saying why")
        seen.add(it.get("id"))
    missing = known - seen
    if missing:
        errs.append(f"missing items: {', '.join(sorted(missing))}")
    return errs


def gate(cl: dict) -> dict:
    items = cl["items"]
    required = [i for i in items if not i["optional"]]
    counts = {s: sum(1 for i in items if i["status"] == s) for s in STATUSES}
    open_items = [i["id"] for i in required if i["status"] not in ("pass", "n/a")]
    return {"counts": counts, "requiredOpen": open_items,
            "physicalGate": "closed (all required physical items pass)" if not open_items else
            f"open: {len(open_items)} required item(s) not passed"}


def _latest(dirpath: Path, pattern: str) -> list[Path]:
    return sorted(dirpath.rglob(pattern))


def redacted_session(report: dict | None) -> dict | None:
    if not report:
        return None
    k = report.get("kwin") or {}
    p = report.get("plastile") or {}
    return {"os": report.get("os"), "kernel": report.get("kernel"),
            "kwin": {x: k.get(x) for x in ("kwinVersion", "qtVersion", "compositingType", "openglRenderer", "package",
                                           "tileEditorEffectLoaded")},
            "outputs": [{x: o.get(x) for x in ("name", "size", "refreshRate", "scale", "rotation", "vrrPolicy")}
                        for o in (report.get("outputs") or [])],
            "plastile": {x: p.get(x) for x in ("installedVersion", "installedBundleSha256", "enabledInKwinrc")},
            "repository": report.get("repository"), "power": report.get("power")}


def build_report(d: Path) -> tuple[dict, dict]:
    cl = json.loads((d / "checklist.json").read_text())
    sessions = _latest(d, "session*.json")
    session = json.loads(sessions[-1].read_text()) if sessions else None
    latency = [{"dir": str(p.parent.relative_to(d)), **json.loads(p.read_text())}
               for p in _latest(d, "summary-redacted.json")]
    observe = [{"dir": str(p.parent.relative_to(d)), **json.loads(p.read_text())}
               for p in _latest(d, "observe-summary.json")]
    soak = [{"dir": str(p.parent.relative_to(d)), **json.loads(p.read_text())} for p in _latest(d, "soak-summary.json")]
    idle = [{"dir": str(p.parent.relative_to(d)), **json.loads(p.read_text())} for p in _latest(d, "idle-summary.json")]
    full = {"checklist": cl, "validation": validate(cl), "gate": gate(cl), "session": session, "latency": latency,
            "observe": observe, "soak": soak, "idle": idle}
    red = {"schema": 1, "layer": "physical", "stamp": cl.get("stamp"), "gate": gate(cl),
           "items": [{k: i[k] for k in ("id", "title", "matrixIds", "status", "notes", "optional")} for i in cl["items"]],
           "session": redacted_session(session), "latency": latency,
           "observe": [{"dir": o["dir"], "phases": [{k: p.get(k) for k in ("label", "converged", "maxConfiguresPerWindow",
                                                                         "reversals", "counterDelta", "hint")}
                                                    for p in o.get("phases", [])]} for o in observe],
           "soak": soak, "idle": idle}
    return full, red


def version_row(red: dict) -> str:
    s = red.get("session") or {}
    k = s.get("kwin") or {}
    passed = sorted({m for i in red["items"] if i["status"] == "pass" for m in i["matrixIds"]})
    failed = [f"{i['id']} ({i['notes'][:60]})" for i in red["items"] if i["status"] == "fail"]
    return (f"| {k.get('package') or k.get('kwinVersion')} | {k.get('qtVersion')} | Plasma Wayland (physical) | "
            f"{k.get('compositingType')} / {k.get('openglRenderer')} | Physical | {', '.join(passed) or 'None'} | "
            f"{'; '.join(failed) or 'None'} |")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new")
    n.add_argument("dir", type=Path)
    s = sub.add_parser("set")
    s.add_argument("dir", type=Path)
    s.add_argument("id")
    s.add_argument("status", choices=STATUSES)
    s.add_argument("notes", nargs="?", default=None)
    s.add_argument("--evidence", action="append", default=[])
    sh = sub.add_parser("show")
    sh.add_argument("dir", type=Path)
    r = sub.add_parser("report")
    r.add_argument("dir", type=Path)
    r.add_argument("--publish", type=Path, default=None)
    args = ap.parse_args(argv)
    path = args.dir / "checklist.json"
    if args.cmd == "new":
        if path.exists():
            print(f"{path} exists; not overwriting", file=sys.stderr)
            return 1
        args.dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(new_checklist(args.dir.name), indent=1) + "\n")
        print(path)
        return 0
    cl = json.loads(path.read_text())
    if args.cmd == "set":
        item = next((i for i in cl["items"] if i["id"] == args.id), None)
        if item is None:
            print(f"unknown item {args.id}", file=sys.stderr)
            return 1
        item["status"] = args.status
        if args.notes is not None:
            item["notes"] = args.notes
        item["evidence"] += args.evidence
        path.write_text(json.dumps(cl, indent=1) + "\n")
    if args.cmd in ("set", "show"):
        for i in cl["items"]:
            print(f"{i['id']:<16} {i['status']:<8} {i['title']}" + (f"  -- {i['notes']}" if i["notes"] else ""))
        for e in validate(cl):
            print(f"WARNING: {e}")
        print(gate(cl)["physicalGate"])
        return 0
    full, red = build_report(args.dir)
    (args.dir / "report.json").write_text(json.dumps(full, indent=1) + "\n")
    out = args.publish or args.dir / "report-redacted.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(red, indent=1) + "\n")
    for e in full["validation"]:
        print(f"WARNING: {e}")
    print(f"{red['gate']['physicalGate']}; counts {red['gate']['counts']}")
    print("TEST_MATRIX section 8 row (review before pasting):")
    print(version_row(red))
    print(f"private: {args.dir / 'report.json'}\npublishable: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
