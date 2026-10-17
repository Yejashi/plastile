#!/usr/bin/env python3
"""T03 timing probe: clocks, scheduler delay, dispatch delay, delayed-commit geometry.

Runs in a disposable nested KWin with the measurement-only Plastile.Measure
module on QML_IMPORT_PATH and the C fixture client. All timestamps share
CLOCK_MONOTONIC (harness, script via Plastile.Measure, fixture client).

Dispatch samples measure D-Bus kglobalaccel invokeShortcut -> QML handler entry.
That is a command-API path, not physical input.

Usage: python3 probes/timing/run.py [--dispatch-samples N] [--configure-delay-ms N]
Writes artifacts/timing/<stamp>/{timing.json,timeline.jsonl,fixture.jsonl,kwin.log}.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from nested import NestedKwin  # noqa: E402

PLUGIN = "plt-timing"
MEASURE = ROOT / "build/measure/qml"
FIXTURE = ROOT / "fixtures/client/build/plastile-fixture"
TM = re.compile(r"PLT-TM (\S+) (\{.*\})$")


def tm_events(lines):
    out = []
    for ln in lines:
        m = TM.search(ln)
        if m:
            out.append((m.group(1), json.loads(m.group(2))))
    return out


def quantiles(xs):
    s = sorted(xs)
    if not s:
        return None
    q = lambda p: s[min(len(s) - 1, int(p * (len(s) - 1)))]  # noqa: E731
    return {"n": len(s), "min": s[0], "p50": q(0.5), "p95": q(0.95), "p99": q(0.99), "max": s[-1]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dispatch-samples", type=int, default=500)
    ap.add_argument("--configure-delay-ms", type=int, default=300)
    ap.add_argument("--reversal-gap-ms", type=int, default=50)
    args = ap.parse_args()
    for need in (MEASURE / "Plastile/Measure/qmldir", FIXTURE):
        if not need.exists():
            sys.exit(f"missing {need}; build tools/measure and fixtures/client first")

    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = ROOT / "artifacts/timing" / stamp
    out.mkdir(parents=True, exist_ok=True)
    kwinrc = f"[Script-{PLUGIN}]\nfixtureClass=plastile-fixture\n"
    result: dict = {"configureDelayMs": args.configure_delay_ms, "reversalGapMs": args.reversal_gap_ms}
    fixture_log = open(out / "fixture.jsonl", "w")
    with NestedKwin(out, kwinrc=kwinrc, extra_env={"QML_IMPORT_PATH": str(MEASURE)}) as kw:
        fixture = kw.spawn([str(FIXTURE), "--ssd", "--configure-delay-ms", str(args.configure_delay_ms),
                            "--delay-mode", "latest"], stdout=fixture_log, stdin=subprocess.PIPE)
        time.sleep(1.0)
        off = kw.mark()
        kw.load_declarative(HERE / "package/contents/ui/main.qml", PLUGIN)
        kw.wait_log(r"PLT-TM adopt ", 10, off)
        kw.wait_log(r"PLT-TM calibrated ", 60, off)
        cal = dict(tm_events(kw.lines_since(off)))
        result["scriptClock"] = cal.get("clock")
        result["callLaterDelayNs"] = cal.get("callLater")
        result["timerDelayNs"] = [e for n, e in tm_events(kw.lines_since(off)) if n == "timer"]
        result["coalescing"] = cal.get("coalesce")

        # Harness D-Bus round trip on the same persistent connection (calibration).
        conn = kw._bus_connection()
        ping = conn.get_object("org.kde.KWin", "/Scripting").get_dbus_method("Ping", "org.freedesktop.DBus.Peer")
        rtts = []
        for _ in range(500):
            t0 = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
            ping()
            rtts.append(time.clock_gettime_ns(time.CLOCK_MONOTONIC) - t0)
        result["harnessDbusPingRttNs"] = quantiles(rtts)

        # Dispatch delay: invokeShortcut send -> handler entry.
        dispatch, replies = [], []
        doff = kw.mark()
        for i in range(args.dispatch_samples):
            t_send = kw.invoke_shortcut("plastile-probe-timing-dispatch")
            replies.append(time.clock_gettime_ns(time.CLOCK_MONOTONIC) - t_send)
            lines = kw.wait_log(r"PLT-TM dispatch ", 5, doff, count=i + 1)
            handler = json.loads(TM.search(lines[i]).group(2))["handlerNs"]
            dispatch.append(handler - t_send)
        result["dispatchSendToHandlerNs"] = quantiles(dispatch)
        result["invokeShortcutReplyRttNs"] = quantiles(replies)
        result["dispatchHandlerBeforeReply"] = sum(1 for d, r in zip(dispatch, replies) if d < r)

        # Geometry: A (settle), B, A after a short gap (reversal under delayed commit),
        # then a position-only move, then an identical target.
        goff = kw.mark()
        settle = args.configure_delay_ms / 1000 + 0.7
        plan = [("A", settle), ("B", args.reversal_gap_ms / 1000), ("A", settle * 2),
                ("A-moved", settle), ("A-moved-again", settle)]
        for _name, wait in plan:
            kw.invoke_shortcut("plastile-probe-timing-geometry")
            time.sleep(wait)
        geo = tm_events(kw.lines_since(goff))
        kw.unload(PLUGIN)
        kw.wait_log(r"PLT-TM teardown ", 5, goff)
        fixture.stdin.write(b"quit\n")
        fixture.stdin.flush()
        fixture.wait(timeout=5)
    fixture_log.close()

    # Merge script and client events into one timeline (same clock domain).
    timeline = []
    for name, e in geo:
        if name == "request":
            timeline.append({"t": e["writeStartNs"], "src": "script", "ev": "request", "seq": e["seq"],
                             "name": e["name"], "target": e["target"], "before": e["before"],
                             "immediate": e["immediate"], "writeNs": e["writeEndNs"] - e["writeStartNs"]})
        elif name == "observed":
            timeline.append({"t": e["t"], "src": "script", "ev": "observed", "seq": e["seq"], "frame": e["frame"],
                             "client": e["client"]})
    first_req = min((x["t"] for x in timeline if x["ev"] == "request"), default=0)
    for line in (out / "fixture.jsonl").read_text().splitlines():
        rec = json.loads(line)
        if rec.get("ev") in ("configure", "ack", "commit", "superseded", "presented") and rec.get("win", "main") == "main" \
                and rec["t_ns"] >= first_req:
            timeline.append({"t": rec["t_ns"], "src": "client", **{k: v for k, v in rec.items() if k != "t_ns"}})
    timeline.sort(key=lambda x: x["t"])
    with open(out / "timeline.jsonl", "w") as f:
        for x in timeline:
            f.write(json.dumps({**x, "tRelMs": round((x["t"] - first_req) / 1e6, 3)}) + "\n")

    requests = [x for x in timeline if x["ev"] == "request"]
    observed = [x for x in timeline if x["ev"] == "observed"]
    final_frame = observed[-1]["frame"] if observed else None
    final_target = requests[-1]["target"] if requests else None
    result["geometry"] = {
        "requests": [{k: r[k] for k in ("seq", "name", "target", "before", "immediate", "writeNs")} for r in requests],
        "observedCount": len(observed),
        "clientConfigures": sum(1 for x in timeline if x["ev"] == "configure"),
        "clientCommits": sum(1 for x in timeline if x["ev"] == "commit"),
        "clientSuperseded": sum(1 for x in timeline if x["ev"] == "superseded"),
        "finalObservedFrame": final_frame,
        "finalTarget": final_target,
        "finalMatchesTarget": final_frame == final_target,
    }
    (out / "timing.json").write_text(json.dumps(result, indent=1))
    print(json.dumps(result, indent=1))
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
