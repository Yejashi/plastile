"""Recorded replay fixtures (T10): capture the engine's normalized event stream from a real nested KWin.

Each capture loads the production bundle through the recording root (tools/replay/record.qml) into a
disposable nested KWin (tools/nested.py), drives one lifecycle shape with fixture clients, reads KWin's
own frames (the independent oracle), and unloads; at unload the runtime prints the recording
("plastile replay <json>", src/runtime/replay.ts). The capture joins the oracle to the recorded window
ids, drops the real ids, adds how and where it was captured, and writes one fixture.

Capture the committed fixtures (tests/fixtures/replay/, replayed by tests/core/replay.test.ts):

    python3 tests/integration/scenarios_replay.py [--only NAME[,NAME]] [--out DIR]

The scenario `replay-capture-T10` captures every shape into its own output directory and replays the
fresh recordings with the same unit test (PLASTILE_REPLAY_DIR), so the suite checks the recorder end to
end without touching the committed fixtures.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from harness import ROOT, Session, fixture_events, provenance, tiling_errors  # noqa: E402
from scenarios import Checks, Skipped, scenario  # noqa: E402

RECORD_QML = ROOT / "tools/replay/record.qml"
BUNDLE = ROOT / "package/contents/code/plastile.mjs"
FIXTURES = ROOT / "tests/fixtures/replay"
GAP = 8
ERRORS = r"plastile (error|warn)|TypeError|ReferenceError"
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def three(s: Session, *extra: str) -> None:
    for i in (1, 2, 3):
        s.spawn(i, *extra)


def activate(s: Session, i: int) -> None:
    s.act(fx(i), "workspace.activeWindow = w")


# ------------------------------------------------------------------- shapes
def open_close_burst(s: Session) -> None:
    three(s)
    s.load(); s.settle()
    for i in range(4, 10):
        s.spawn(i, wait=False)
    s.wait_for(lambda: len(s.frames_list()) == 9, 8, "9 windows")
    s.settle()
    for i in range(4, 10):
        s.kill(i, wait=False)
    s.wait_for(lambda: len(s.frames_list()) == 3, 8, "3 windows")
    s.settle()


def remove_during_apply(s: Session) -> None:
    for i in (1, 2, 3):
        s.spawn(i, "--configure-delay-ms", "400")
    s.load(); s.settle(); time.sleep(0.5); s.settle()
    activate(s, 1)
    log2 = s.fixtures[2].log
    n2 = len(fixture_events(log2, "configure"))
    s.cmd("resize.grow")
    s.wait_for(lambda: len(fixture_events(log2, "configure")) > n2, 3, "configure for fixture 2")
    s.kill(2, wait=False)
    s.wait_for(lambda: all(f["caption"] != fx(2) for f in s.frames_list()), 5, "fixture 2 removed")
    time.sleep(2.0)
    s.settle()


def ratio_reversal(s: Session) -> None:
    three(s, "--configure-delay-ms", "300", "--delay-mode", "latest")
    s.load(); s.settle()
    activate(s, 1)
    for _ in range(2):
        s.cmd("resize.grow"); time.sleep(0.05); s.cmd("resize.shrink")
        time.sleep(1.2)
        s.settle()


def kscreen(s: Session, *args: str) -> None:
    try:
        r = subprocess.run(["kscreen-doctor", *args], env=s.kw.client_env(), capture_output=True, text=True, timeout=15)
    except FileNotFoundError:
        raise Skipped("kscreen-doctor (libkscreen) is not installed")
    if r.returncode != 0:
        raise RuntimeError(f"kscreen-doctor {args}: {r.stderr[-200:]}")


def output_unplug_replug(s: Session) -> None:
    s.spawn(1); s.spawn(2)
    s.spawn(3, "--configure-delay-ms", "400"); s.spawn(4, "--configure-delay-ms", "400")
    s.load(); s.settle()
    for i in (3, 4):
        activate(s, i)
        s.cmd("move.output-next"); s.settle()
    second = json.loads(s.js("emit(workspace.screens[1].name);")[0])
    activate(s, 3)
    s.cmd("resize.grow")  # requests outstanding on the output about to go away
    time.sleep(0.05)
    kscreen(s, f"output.{second}.disable")
    time.sleep(1.5); s.settle()
    kscreen(s, f"output.{second}.enable")
    time.sleep(1.0); s.settle()


def quick_tile_yield(s: Session) -> None:
    three(s)
    s.load(); s.settle()
    s.act(fx(2), "workspace.activeWindow = w; workspace.slotWindowQuickTileLeft()")
    time.sleep(1.0); s.settle()
    activate(s, 2)
    s.cmd("window.adopt-native")
    time.sleep(0.6); s.settle()


CAPTURES = {
    "open-close-burst": {
        "run": open_close_burst, "session": {"height": 1600},
        "description": "Three windows adopted, six more mapped at once (no waits), then the six closed at once "
                       "(burst-C09 shape; 1600 px tall so nine fit without overflow).",
    },
    "remove-during-apply": {
        "run": remove_during_apply, "session": {},
        "description": "Three clients that commit configures 400 ms late; a grow sends each a new size and fixture 2 "
                       "quits before acknowledging it (remove-during-apply-C07 shape). KWin removes a Wayland window "
                       "only during Wayland dispatch, never inside the synchronous frame write, so this is a removal "
                       "while its geometry request is outstanding; removal inside the write itself is mock-only "
                       "(engine.test.ts C07, replay.test.ts round trip).",
    },
    "ratio-reversal": {
        "run": ratio_reversal, "session": {},
        "description": "A->B->A twice: grow then shrink 50 ms apart while every client commits 300 ms late, keeping "
                       "only its latest configure (ratio-reversal-G05 shape).",
    },
    "output-unplug-replug": {
        "run": output_unplug_replug, "session": {"outputs": 2},
        "description": "Two outputs, two windows each (the second output's clients commit 400 ms late); a grow leaves "
                       "requests outstanding, the second output is disabled and enabled again with kscreen-doctor "
                       "(unplug-O04 shape).",
    },
    "quick-tile-yield": {
        "run": quick_tile_yield, "session": {},
        "description": "Three tiled windows; KWin's quick tile left on fixture 2 (Plastile yields it), then "
                       "window.adopt-native takes it back (native-quicktile-L13 shape).",
    },
}


def nested_versions(s: Session) -> dict:
    """KWin, Qt and compositing of the nested instance itself (its supportInformation on the private bus)."""
    try:
        text = s.kw.call("/KWin", "org.kde.KWin", "supportInformation")[0]
    except Exception as exc:  # recorded, not fatal: the fixture still names the KWin binary below
        return {"supportInformation": f"unavailable: {exc}"[:200]}
    out = {}
    for key, rx in {"kwin": r"^KWin version: (.+)$", "qt": r"^Qt Version: (.+)$",
                    "compositing": r"^Compositing Type: (.+)$"}.items():
        m = re.search(rx, text, re.M)
        out[key] = m.group(1).strip() if m else None
    return out


def capture(name: str, out: Path) -> tuple[dict, dict]:
    """Run one shape in a fresh nested KWin. Returns (fixture, facts for checks)."""
    spec = CAPTURES[name]
    with Session(out, qml=RECORD_QML, **spec["session"]) as s:
        spec["run"](s)
        oracle = s.frames_list()
        versions = nested_versions(s)
        areas = [s.area(i) for i in range(len(json.loads(s.js("emit(workspace.screens.map(o => o.name));")[0])))]
        tiling = tiling_errors(oracle, areas[0], GAP) if len(areas) == 1 else []
        off = s.kw.mark()
        s.unload()
        line = s.kw.lines_since(off, r"plastile replay ")
        errs = s.log_lines(ERRORS)
    if not line:
        raise RuntimeError("no recording printed at unload")
    rec = json.loads(line[-1].split("plastile replay ", 1)[1])
    ids = rec.pop("ids")
    fixture = {
        "format": rec.pop("format"),
        "name": name,
        "description": spec["description"],
        "captured": {
            **versions,
            "layer": "nested KWin, virtual backend (tools/nested.py), not a physical session",
            "how": f"python3 tests/integration/scenarios_replay.py --only {name} (recording root tools/replay/record.qml)",
            # The captures this run already wrote do not make the next one dirty.
            **provenance(exclude=("tests/fixtures/replay",)),
            # The bundle KWin ran: rebuilding at the commit (npm run build) reproduces this hash.
            "bundleSha256": hashlib.sha256(BUNDLE.read_bytes()).hexdigest(),
            "date": time.strftime("%Y-%m-%d"),
        },
        **rec,
        "oracle": {ids[f["id"]]: {"fixture": int(f["caption"].rsplit(" ", 1)[1]), "frame": f["frame"]}
                   for f in oracle if f["id"] in ids},
    }
    facts = {"errors": errs[:3], "tiling": tiling, "unmapped": [f["caption"] for f in oracle if f["id"] not in ids]}
    return fixture, facts


def write_fixture(path: Path, fixture: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, indent=1) + "\n")


def check_capture(c: Checks, name: str, fixture: dict, facts: dict) -> None:
    c(f"{name}: recorded without truncation or unrecordable inputs",
      not fixture["truncated"] and fixture["anomalies"] == 0, {k: fixture[k] for k in ("truncated", "anomalies", "nodes")})
    c(f"{name}: the recording contains frame writes and ends with stop",
      len(fixture["writes"]) > 0 and fixture["events"][-1]["k"] == "stop", len(fixture["writes"]))
    c(f"{name}: every fixture window KWin reports is in the recording (oracle joined)", not facts["unmapped"], facts["unmapped"])
    c(f"{name}: KWin's frames tile the area (oracle, gaps>=8; single-output shapes)", not facts["tiling"], facts["tiling"])
    c(f"{name}: no Plastile errors or JS exceptions", not facts["errors"], facts["errors"])
    titles = sorted(set(titles_in(fixture["events"])))
    uuids = UUID.findall(json.dumps(fixture))
    c(f"{name}: titles redacted and no KWin window or desktop id in the recording",
      set(titles) <= {"[title]", ""} and not uuids, {"titles": titles[:5], "uuids": uuids[:3]})


def titles_in(v) -> list[str]:
    """Every window title in a recording (snapshot and metadata `meta.title`)."""
    if isinstance(v, dict):
        out = [v["title"]] if isinstance(v.get("title"), str) and "appId" in v else []
        for x in v.values():
            out += titles_in(x)
        return out
    if isinstance(v, list):
        return [t for x in v for t in titles_in(x)]
    return []


@scenario("replay-capture-T10")
def replay_capture(out: Path, c: Checks):
    """Capture every shape and replay the fresh recordings with tests/core/replay.test.ts."""
    fresh = out / "fixtures"
    for name in CAPTURES:
        fixture, facts = capture(name, out / name)
        check_capture(c, name, fixture, facts)
        write_fixture(fresh / f"{name}.json", fixture)
    node = shutil.which("node")
    if node is None:
        raise Skipped("node is not on PATH here: the fresh recordings were captured and checked but not replayed")
    r = subprocess.run([node, "--test", "--test-reporter=spec", str(ROOT / "tests/core/replay.test.ts")],
                       env={**os.environ, "PLASTILE_REPLAY_DIR": str(fresh)}, capture_output=True, text=True, timeout=300)
    (out / "replay-test.txt").write_text(r.stdout + r.stderr)
    tail = [ln for ln in (r.stdout + r.stderr).splitlines() if "✖" in ln or ln.startswith("ℹ")][:12]
    c("fresh recordings replay through the engine with the mock host (node --test tests/core/replay.test.ts)",
      r.returncode == 0, tail)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", default="")
    ap.add_argument("--out", type=Path, default=FIXTURES)
    args = ap.parse_args()
    names = [n for n in args.only.split(",") if n] or list(CAPTURES)
    work = ROOT / "artifacts/replay-capture" / time.strftime("%Y%m%dT%H%M%S")
    bad = 0
    for name in names:
        c = Checks()
        fixture, facts = capture(name, work / name)
        check_capture(c, name, fixture, facts)
        failed = [k for k, v in c.items.items() if not v["pass"]]
        for k in failed:
            print(f"     ✖ {k}: {json.dumps(c.items[k]['detail'])[:300]}")
        if failed:
            bad += 1
            print(f"FAIL {name}: not written")
            continue
        write_fixture(args.out / f"{name}.json", fixture)
        print(f"wrote {args.out / (name + '.json')} ({fixture['nodes']} nodes, {len(fixture['writes'])} writes)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
