#!/usr/bin/env python3
"""Aggregate baseline-upstream runs (artifacts/baseline-upstream/<stamp>/) into the
committed evidence file. Pools every per-command sample of the primary repetitions
(none dropped) and lists each repetition and control run separately.

Usage: python3 probes/baseline-upstream/aggregate.py --primary S1,S2,S3
         [--control-rebuild-delay S] [--control-no-activities S]
         [--provenance JSON] [--out docs/status/evidence/baseline-upstream.json]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from run import q  # noqa: E402

ART = ROOT / "artifacts/baseline-upstream"
MS = 1e6


def ms(stat):
    if not stat:
        return None
    return {"n": stat["n"], **{k: round(stat[k] / MS, 3) for k in ("min", "p50", "p95", "p99", "max")}}


def load(stamp: str) -> tuple[dict, dict]:
    summary = json.loads((ART / stamp / "summary.json").read_text())
    samples = {t: json.loads((ART / stamp / t / "samples.json").read_text()) for t in summary["tilers"]}
    return summary, samples


def phase_view(ph: dict) -> dict:
    return {
        "commands": ph["commands"], "commandsWithConfigure": ph["commandsWithConfigure"],
        "sendToFirstConfigureMs": ms(ph["sendToFirstConfigureNs"]),
        "sendToFirstSizeConfigureMs": ms(ph["sendToFirstSizeConfigureNs"]),
        "configuresPerCommand": ph["configuresPerCommand"], "configuresTotal": ph["configuresTotal"],
        "idleConfiguresAfter1s": ph["idleConfiguresAfter1s"], "idleWindowSeconds": ph["idleWindowSeconds"],
        "oracleErrors": ph["oracle"]["errors"],
        **({"plastileCountersDelta": ph["plastileCountersDelta"]} if "plastileCountersDelta" in ph else {}),
    }


def tiler_view(res: dict) -> dict:
    out = {k: res[k] for k in ("context", "teardown", "activities", "kamdUsedNestedDataHome", "log", "scriptConfig",
                               "metadata", "packageSha256", "install", "seconds") if k in res}
    for key in ("afterOpen", "final"):
        if key in res:
            out[key] = {"errors": res[key]["errors"], "allNativeTile": res[key]["allNativeTile"],
                        "areaCoverage": res[key]["areaCoverage"], "frames": [f["frame"] for f in res[key]["frames"]]}
    out["phases"] = {n: phase_view(ph) for n, ph in res.get("phases", {}).items()}
    return out


def pooled(runs: list[dict]) -> dict:
    out: dict = {}
    for tiler in runs[0]:
        out[tiler] = {}
        for phase in runs[0][tiler].get("phases", {}):
            samples = [s for r in runs for s in r[tiler]["phases"][phase]["samples"]]
            idle = sum(r[tiler]["phases"][phase]["idleConfiguresAfter1s"] for r in runs)
            errs = sum(len(r[tiler]["phases"][phase]["oracle"]["errors"]) for r in runs)
            out[tiler][phase] = {
                "repetitions": len(runs), "commands": len(samples),
                "commandsWithoutConfigure": sum(1 for s in samples if s["firstConfigureNs"] is None),
                "sendToFirstConfigureMs": ms(q([s["firstConfigureNs"] for s in samples])),
                "sendToFirstSizeConfigureMs": ms(q([s["firstSizeConfigureNs"] for s in samples])),
                "configuresPerCommand": q([s["configures"] for s in samples]),
                "fixturesTouchedPerCommand": q([len(s["fixtures"]) for s in samples]),
                "idleConfiguresAfter1sTotal": idle, "oracleErrorsTotal": errs,
            }
    return out


def redact(text: str) -> str:
    text = text.replace(str(Path.home()), "~")
    return re.sub(r"/tmp/plastile-\d+/[^/\"\s]+", "<nested-root>", text)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--primary", required=True)
    ap.add_argument("--control-rebuild-delay")
    ap.add_argument("--control-no-activities")
    ap.add_argument("--provenance", type=Path, help="JSON file with package provenance facts")
    ap.add_argument("--out", type=Path, default=ROOT / "docs/status/evidence/baseline-upstream.json")
    args = ap.parse_args()
    stamps = args.primary.split(",")
    loaded = [load(s) for s in stamps]
    first = loaded[0][0]
    ev = {
        "task": "T04 upstream automatic-tiler baseline (Polonium vs Plastile)",
        "layer": first["layer"],
        "labels": "latency/churn/fights/geometry are MEASURED in nested KWin (virtual backend) from independent "
                  "sources (harness send clock, fixture xdg configure logs, one-shot KWin oracle scripts). "
                  "Attribution of Polonium swap latency to its RebuildDelay timer is MEASURED by the control run and "
                  "matches OBSERVED SOURCE (src/controller/config.ts RebuildDelay default 10; controller eventTimer). "
                  "No physical-session, presentation or input-to-photon claim is made.",
        "versions": first["versions"],
        "environment": first["environment"],
        "workload": first["workload"],
        "metrics": first["metrics"],
        "provenance": json.loads(args.provenance.read_text()) if args.provenance else None,
        "primaryRuns": stamps,
        "pooled": pooled([s for _, s in loaded]),
        "repetitions": [{"stamp": st, "tilers": {t: tiler_view(r) for t, r in s.items()}}
                        for st, (_, s) in zip(stamps, loaded)],
        "controls": {},
    }
    if args.control_rebuild_delay:
        _, s = load(args.control_rebuild_delay)
        ev["controls"]["poloniumRebuildDelay1"] = {
            "stamp": args.control_rebuild_delay,
            "purpose": "attribute Polonium swap latency: kwinrc [Script-polonium] RebuildDelay=1 (default 10 ms)",
            "tilers": {t: tiler_view(r) for t, r in s.items()}}
    if args.control_no_activities:
        st = args.control_no_activities
        _, s = load(st)
        log = (ART / st / "polonium" / "kwin.log").read_text(errors="replace").splitlines()
        pl = [ln for ln in log if "Polonium" in ln and "config -" not in ln]
        ev["controls"]["noActivitiesService"] = {
            "stamp": st,
            "purpose": "nested session without kactivitymanagerd (the default harness environment)",
            "tilers": {t: tiler_view(r) for t, r in s.items()},
            "poloniumLogExcerpt": [redact(ln) for ln in pl[:12]],
            "poloniumRebuildLines": sum(1 for ln in log if "Rebuilding for display" in ln),
        }
    text = redact(json.dumps(ev, indent=1))
    args.out.write_text(text + "\n")
    print(args.out, len(text), "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
