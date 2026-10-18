#!/usr/bin/env python3
"""T04 upstream baseline: an upstream automatic tiler (Polonium) and the Plastile
package under the same workload, the same fixture clients and the same oracle,
each in its own disposable nested KWin (virtual backend; NOT a physical session).

Independent sources only. Nothing here uses either tiler's own claims for timing or
geometry:
  latency    harness invokeShortcut send time (CLOCK_MONOTONIC, Python, taken just
             before the kglobalaccel D-Bus call) -> first xdg 'configure' record
             (t_ns, CLOCK_MONOTONIC) in any fixture's JSONL log inside that
             command's window [t_send, t_next_send). With 25 ms spacing a reply
             later than 25 ms is attributed to the next command (censoring), so a
             sparse pass (default 250 ms) is also run.
  churn      configures in the window, over all fixtures; split into size-changing
             configures and state-only ones (a pure move sends no configure)
  fights     configures that still arrive >= 1 s after the last command of a phase
  geometry   final frames from one-shot KWin scripts (tools/nested.py), judged by
             tests/integration/harness.tiling_errors (inside area, no overlap)
The D-Bus command API is not physical input.

Environment (identical for both tilers): kactivitymanagerd is started on the
session's private bus before KWin (prepare hook) because Polonium keys its layouts
on window.activities and never tiles when the Activities service is absent
(workspace.currentActivity === "" there; see docs/status/API_PROFILE.md).

Workload: 3 fixture windows, fixture 1 active, then per spacing a swap-like phase and
a resize-like phase of N commands each.
  Polonium : PoloniumPlaceRight/PoloniumPlaceLeft alternating (it has no pure swap;
             "place window in direction" moves the active window into the
             neighbouring tile), then PoloniumResizeRight/PoloniumResizeLeft
             alternating (Tile.resizeByPixels, TileResizeAmount default 10 px)
  Plastile : plastile.swap.right/plastile.swap.left alternating, then
             plastile.resize.grow/plastile.resize.shrink alternating
Polonium is installed with kpackagetool6 into the nested session's private data home
only (env = NestedKwin.env()) and enabled through that session's kwinrc [Plugins].

Usage: python3 probes/baseline-upstream/run.py [--commands 100] [--spacings-ms 25,250]
         [--tilers polonium,plastile] [--polonium-zip PATH] [--no-activities]
         [--polonium-config LogLevel=3] [--evidence PATH]
Writes artifacts/baseline-upstream/<stamp>/{summary.json,<tiler>/{kwin.log,fixture-*.jsonl,samples.json}}.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
import traceback
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "tests/integration"))
from nested import NestedKwin, NestedError, _terminate  # noqa: E402
from harness import Session, FIXTURE, tiling_errors  # noqa: E402
import sysinfo  # noqa: E402

DEFAULT_ZIP = Path("/tmp/claude-1000/upstream/nightly-zip/polonium.kwinscript")
POLONIUM_PIN = "227967ed448205d42b5e63e4cc4b868d72606467"
POLONIUM_ID = "polonium"
KAMD = sysinfo.find_helper("kactivitymanagerd")
NS = 1_000_000_000

WORKLOADS = {
    "polonium": {
        "swap": ["PoloniumPlaceRight", "PoloniumPlaceLeft"],
        "resize": ["PoloniumResizeRight", "PoloniumResizeLeft"],
    },
    "plastile": {
        "swap": ["plastile.swap.right", "plastile.swap.left"],
        "resize": ["plastile.resize.grow", "plastile.resize.shrink"],
    },
}


def mono() -> int:
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


def q(xs):
    """Nearest-rank percentiles over every sample (none dropped)."""
    s = sorted(x for x in xs if x is not None)
    if not s:
        return None
    p = lambda f: s[min(len(s) - 1, int(f * (len(s) - 1) + 0.5))]  # noqa: E731
    return {"n": len(s), "min": s[0], "p50": p(0.5), "p95": p(0.95), "p99": p(0.99), "max": s[-1]}


# --------------------------------------------------------- activities service
class Activities:
    """kactivitymanagerd on the nested session's private bus (PID we started only)."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.info: dict = {"enabled": True}

    def start(self, kw: NestedKwin) -> None:
        env = kw.env()
        env["QT_QPA_PLATFORM"] = "offscreen"
        if KAMD is None:
            raise NestedError("kactivitymanagerd not found (PATH, /usr/lib, libexec)")
        self.proc = subprocess.Popen([KAMD], env=env, stdout=open(kw.root / "kamd.log", "wb"),
                                     stderr=subprocess.STDOUT)

        def owned() -> bool:
            r = subprocess.run(["busctl", f"--address={kw.bus_address}", "--list", "--acquired", "--no-pager"],
                               capture_output=True, text=True)
            return "org.kde.ActivityManager" in r.stdout
        kw._wait(owned, 15, "org.kde.ActivityManager on the private bus")
        self.info["pid"] = self.proc.pid

    def stop(self) -> None:
        if self.proc is not None:
            _terminate(self.proc)
            self.info["exitCode"] = self.proc.returncode
            self.proc = None


def context(kw: NestedKwin) -> dict:
    out = kw.run_js("emit({currentActivity: workspace.currentActivity, activities: workspace.activities,"
                    " windows: workspace.windowList().filter(w => w.resourceClass === 'plastile-fixture')"
                    ".map(w => ({caption: w.caption, activities: w.activities}))});")
    d = json.loads(out[0])
    # Redact the random UUIDs to shape only.
    return {"currentActivityEmpty": d.get("currentActivity", "") == "",
            "workspaceActivities": len(d.get("activities", [])),
            "windowActivityCounts": sorted(len(w["activities"]) for w in d.get("windows", []))}


# ------------------------------------------------------------------ fixture logs
def read_events(paths: dict[int, Path], ev: str = "configure") -> list[dict]:
    """All complete main-window records of type `ev` from the fixture JSONL logs, with a size-change flag."""
    out = []
    for ident, path in paths.items():
        if not path.exists():
            continue
        text = path.read_text(errors="replace")
        text = text[: text.rfind("\n") + 1]  # never parse a partial line
        prev = None
        for ln in text.splitlines():
            try:
                rec = json.loads(ln)
            except ValueError:
                continue
            if rec.get("ev") == ev and rec.get("win", "main") == "main":
                size = (rec.get("width"), rec.get("height"))
                rec["fixture"] = ident
                rec["sizeChanged"] = prev is not None and size != prev and size != (0, 0)
                prev = size if size != (0, 0) else prev
                out.append(rec)
    out.sort(key=lambda r: r["t_ns"])
    return out


def wait_quiet(paths: dict[int, Path], quiet_s: float = 0.6, timeout: float = 15.0) -> int:
    """Wait until no fixture has received a configure for `quiet_s`; return the last configure t_ns."""
    deadline = time.monotonic() + timeout
    while True:
        cfgs = read_events(paths)
        last = cfgs[-1]["t_ns"] if cfgs else 0
        if mono() - last >= quiet_s * NS or time.monotonic() > deadline:
            return last
        time.sleep(0.05)


def drive(send, cmds: list[str], count: int, spacing_s: float) -> list[tuple[str, int]]:
    """Send `count` commands (cycling through cmds) on an absolute schedule; return (cmd, t_send_ns)."""
    sends = []
    next_at = time.monotonic()
    for k in range(count):
        cmd = cmds[k % len(cmds)]
        sends.append((cmd, send(cmd)))
        next_at += spacing_s
        delay = next_at - time.monotonic()
        if delay > 0:
            time.sleep(delay)
    return sends


def analyse(sends: list[tuple[str, int]], cfgs: list[dict], phase_end_ns: int) -> dict:
    """Per-command latency/churn from fixture configure records; idle configures after 1 s."""
    per = []
    idle_from = sends[-1][1] + NS
    for k, (cmd, t0) in enumerate(sends):
        t1 = sends[k + 1][1] if k + 1 < len(sends) else idle_from
        win = [c for c in cfgs if t0 <= c["t_ns"] < t1]
        sized = [c for c in win if c["sizeChanged"]]
        per.append({
            "cmd": cmd, "sendNs": t0, "windowNs": t1 - t0,
            "firstConfigureNs": (win[0]["t_ns"] - t0) if win else None,
            "firstSizeConfigureNs": (sized[0]["t_ns"] - t0) if sized else None,
            "configures": len(win), "sizeConfigures": len(sized),
            "fixtures": sorted({c["fixture"] for c in win}),
        })
    idle = [c for c in cfgs if idle_from <= c["t_ns"] < phase_end_ns]
    send_gaps = [sends[k + 1][1] - sends[k][1] for k in range(len(sends) - 1)]
    return {
        "commands": len(per),
        "commandsWithConfigure": sum(1 for p in per if p["firstConfigureNs"] is not None),
        "commandsWithoutConfigure": sum(1 for p in per if p["firstConfigureNs"] is None),
        "sendToFirstConfigureNs": q([p["firstConfigureNs"] for p in per]),
        "sendToFirstSizeConfigureNs": q([p["firstSizeConfigureNs"] for p in per]),
        "configuresPerCommand": q([p["configures"] for p in per]),
        "sizeConfiguresPerCommand": q([p["sizeConfigures"] for p in per]),
        "configuresTotal": sum(p["configures"] for p in per),
        "sizeConfiguresTotal": sum(p["sizeConfigures"] for p in per),
        "fixturesTouchedPerCommand": q([len(p["fixtures"]) for p in per]),
        "sendGapNs": q(send_gaps),
        "idleConfiguresAfter1s": len(idle),
        "idleWindowSeconds": round((phase_end_ns - idle_from) / NS, 2),
        "fights": len(idle) > 0,
        "samples": per,
    }


def area_js(kw: NestedKwin) -> dict:
    out = kw.run_js("const o = workspace.screens[0]; const a = workspace.clientArea(workspace.MaximizeArea, o, "
                    "workspace.currentDesktop); emit({x: a.x, y: a.y, width: a.width, height: a.height});")
    return json.loads(out[0])


def snapshot(kw: NestedKwin) -> dict:
    frames = kw.fixtures()
    area = area_js(kw)
    return {"area": area, "frames": [{"caption": f["caption"], "frame": f["frame"], "tile": f["tile"]} for f in frames],
            "errors": tiling_errors(frames, area), "allNativeTile": all(f["tile"] for f in frames),
            "count": len(frames), "areaCoverage": round(sum(f["frame"]["width"] * f["frame"]["height"] for f in frames)
                                                        / (area["width"] * area["height"]), 3)}


def versions() -> dict:
    kwin = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
    pk = [sysinfo.component_version(c) for c in ("kwin", "kactivitymanagerd", "qt6-declarative")]
    # git, not .git/HEAD: in a linked worktree .git is a file.
    commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "src", "package", "probes", "tests/integration",
                                 "fixtures", "tools"], capture_output=True, text=True).stdout.strip())
    meta = json.loads((ROOT / "package/metadata.json").read_text())
    bundle = ROOT / "package/contents/code/plastile.mjs"
    return {"kwin": kwin, "packages": [p for p in pk if p], "plastileVersion": meta["KPlugin"]["Version"],
            "plastileCommit": commit, "implementationDirty": dirty,
            "plastileBundleSha256": hashlib.sha256(bundle.read_bytes()).hexdigest(), "python": sys.version.split()[0]}


def workload(kw: NestedKwin, logs: dict[int, Path], tiler: str, count: int, spacings: list[float],
             idle_s: float, counters=None) -> dict:
    phases = {}
    c0 = counters() if counters else None
    for spacing in spacings:
        for kind in ("swap", "resize"):
            name = f"{kind}@{int(spacing * 1000)}ms"
            wait_quiet(logs)
            n_cmds = count(spacing) if callable(count) else count
            sends = drive(kw.invoke_shortcut, WORKLOADS[tiler][kind], n_cmds, spacing)
            time.sleep(idle_s)
            ph = analyse(sends, read_events(logs), mono())
            ph["spacingMs"] = spacing * 1000
            ph["oracle"] = snapshot(kw)
            if counters:
                c1 = counters()
                ph["plastileCountersDelta"] = {k: c1["counters"][k] - c0["counters"].get(k, 0)
                                               for k in c1["counters"] if c1["counters"][k] != c0["counters"].get(k, 0)}
                c0 = c1
            phases[name] = ph
    return phases


# --------------------------------------------------------------------- polonium
def run_polonium(out: Path, zip_path: Path, count: int, spacings: list[float], idle_s: float,
                 script_cfg: dict[str, str], activities: bool) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    res: dict = {"tiler": "polonium", "package": zip_path.name,
                 "packageSha256": hashlib.sha256(zip_path.read_bytes()).hexdigest()}
    with zipfile.ZipFile(zip_path) as z:
        meta = json.loads(z.read(next(n for n in z.namelist() if n.endswith("metadata.json"))))
        res["metadata"] = {"Id": meta["KPlugin"]["Id"], "Version": meta["KPlugin"]["Version"],
                           "API": meta.get("X-Plasma-API"), "MinimumApi": meta.get("X-Plasma-API-Minimum-Version")}
    install_log: dict = {}
    act = Activities() if activities else None

    def prepare(kw: NestedKwin) -> None:
        if act:
            act.start(kw)
        # Install ONLY into the nested session's private data home (env from the session).
        r = subprocess.run(["kpackagetool6", "-t", "KWin/Script", "-i", str(zip_path)],
                           env=kw.env(), capture_output=True, text=True, timeout=60)
        installed = kw.root / "data/kwin/scripts" / POLONIUM_ID / "metadata.json"
        install_log.update(returncode=r.returncode, installedIntoNestedDataHome=installed.exists(),
                           stdout=r.stdout.strip().replace(str(kw.root), "<nested-root>")[-400:],
                           stderr=r.stderr.strip()[-400:])
        if r.returncode != 0 or not installed.exists():
            raise NestedError(f"kpackagetool6 install failed: {install_log}")

    kwinrc = f"[Plugins]\n{POLONIUM_ID}Enabled=true\n"
    if script_cfg:
        # KWin scripts read their config (KWin.readConfig) from kwinrc [Script-<id>].
        kwinrc += f"\n[Script-{POLONIUM_ID}]\n" + "".join(f"{k}={v}\n" for k, v in script_cfg.items())
    res["scriptConfig"] = script_cfg
    logs = {i: out / f"fixture-{i}.jsonl" for i in (1, 2, 3)}
    procs = []
    try:
        with NestedKwin(out, kwinrc=kwinrc, prepare=prepare) as kw:
            res["install"] = install_log
            # Default LogLevel is 1 (Warn): Polonium prints nothing at start. Startup is
            # confirmed by KWin's isScriptLoaded and by its ShortcutHandlers in kglobalaccel.
            def started() -> bool:
                return kw.is_loaded(POLONIUM_ID) and any(n.startswith("Polonium") for n in kw.shortcut_names())
            try:
                kw._wait(started, 20, "polonium loaded with shortcuts registered")
            except NestedError as exc:
                res["startError"] = str(exc)
                res["logExcerpt"] = kw.log_text()[-3000:]
                return res
            res["isScriptLoaded"] = True
            res["shortcutsRegistered"] = sorted(n for n in kw.shortcut_names() if n.startswith("Polonium"))
            for i in (1, 2, 3):
                procs.append(kw.spawn([str(FIXTURE), "--ssd", "--id", str(i)], stdout=open(logs[i], "w"),
                                      stdin=subprocess.PIPE))
                time.sleep(0.3)
            kw._wait(lambda: len(kw.fixtures()) == 3, 10, "3 fixture windows")
            wait_quiet(logs)
            res["context"] = context(kw)
            res["afterOpen"] = snapshot(kw)
            kw.act("plastile-fixture 1", "workspace.activeWindow = w")
            res["phases"] = workload(kw, logs, "polonium", count, spacings, idle_s)
            res["final"] = snapshot(kw)
            text = kw.log_text()
            lines = text.splitlines()
            res["log"] = {
                "poloniumErrors": [ln[-200:] for ln in lines if "Polonium ERR" in ln][:20],
                "poloniumWarnings": sum(1 for ln in lines if "Polonium WRN" in ln),
                "qmlErrors": [ln[-200:] for ln in lines
                              if re.search(r"\b(qml|js|kwin_scripting)\b.*(Error|TypeError|ReferenceError)", ln)][:20],
            }
            for p in procs:
                try:
                    p.stdin.write(b"quit\n"); p.stdin.flush()
                except Exception:
                    pass
            res["teardown"] = {"unloadReturned": kw.unload(POLONIUM_ID), "isScriptLoadedAfter": kw.is_loaded(POLONIUM_ID)}
            res["kamdUsedNestedDataHome"] = (kw.root / "data/kactivitymanagerd").exists() if act else None
    finally:
        if act:
            act.stop()
            res["activities"] = {k: v for k, v in act.info.items() if k != "pid"}
    return res


# --------------------------------------------------------------------- plastile
def run_plastile(out: Path, count: int, spacings: list[float], idle_s: float, activities: bool) -> dict:
    res: dict = {"tiler": "plastile"}
    act = Activities() if activities else None
    s = Session(out)
    if act:
        s.kw.prepare = act.start  # same environment as the Polonium session
    try:
        with s:
            kw = s.kw
            s.load()  # tiler active before the windows appear, as for Polonium
            for i in (1, 2, 3):
                s.spawn(i)
                time.sleep(0.3)
            logs = {i: s.out / f"fixture-{i}.jsonl" for i in (1, 2, 3)}
            s.settle(); wait_quiet(logs)
            res["context"] = context(kw)
            res["afterOpen"] = snapshot(kw)
            s.act("plastile-fixture 1", "workspace.activeWindow = w")
            s.settle()
            res["phases"] = workload(kw, logs, "plastile", count, spacings, idle_s, counters=s.counters)
            res["final"] = snapshot(kw)
            res["log"] = {"plastileErrors": [ln[-200:] for ln in kw.log_text().splitlines()
                                             if re.search(r"plastile (error|warn)", ln)][:20]}
            s.unload()
            res["teardown"] = {"stoppedLogged": True, "isScriptLoadedAfter": kw.is_loaded("plastile")}
            res["kamdUsedNestedDataHome"] = (kw.root / "data/kactivitymanagerd").exists() if act else None
    finally:
        if act:
            act.stop()
            res["activities"] = {k: v for k, v in act.info.items() if k != "pid"}
    return res


def summarize(res: dict) -> dict:
    keep = {k: v for k, v in res.items() if k not in ("phases", "afterOpen", "final")}
    for key in ("afterOpen", "final"):
        if key in res:
            keep[key] = {k: v for k, v in res[key].items() if k not in ("frames",)}
            keep[key]["tiledFrames"] = [f["frame"] for f in res[key]["frames"]]
    keep["phases"] = {}
    for name, ph in res.get("phases", {}).items():
        keep["phases"][name] = {k: v for k, v in ph.items() if k not in ("samples", "oracle")}
        keep["phases"][name]["oracleErrors"] = ph["oracle"]["errors"]
        keep["phases"][name]["oracleAllNativeTile"] = ph["oracle"]["allNativeTile"]
        keep["phases"][name]["commandsUsed"] = sorted({p["cmd"] for p in ph["samples"]})
    return keep


def fmt(lat) -> str:
    return "n/a" if not lat else f"{lat['p50']/1e6:.2f}/{lat['p95']/1e6:.2f}/{lat['p99']/1e6:.2f} ms (n={lat['n']})"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commands", type=int, default=100)
    ap.add_argument("--spacings-ms", default="25,250", help="comma list; 25 is the primary workload")
    ap.add_argument("--idle-s", type=float, default=3.0, help="idle after each phase (1 s grace + fight window)")
    ap.add_argument("--tilers", default="polonium,plastile")
    ap.add_argument("--polonium-zip", type=Path, default=DEFAULT_ZIP)
    ap.add_argument("--polonium-config", default="", help="k=v,k=v written to kwinrc [Script-polonium] (e.g. LogLevel=3)")
    ap.add_argument("--no-activities", action="store_true", help="do not start kactivitymanagerd (Polonium then cannot tile)")
    ap.add_argument("--evidence", type=Path, default=None, help="also write the redacted summary here")
    ap.add_argument("--commands-at", default="", help="per-spacing command counts overriding --commands, e.g. 250=100")
    ap.add_argument("--out", type=Path, default=None, help="artifact directory (default artifacts/baseline-upstream/<stamp>)")
    args = ap.parse_args()
    stamp = time.strftime("%Y%m%dT%H%M%S")
    out = args.out or ROOT / "artifacts/baseline-upstream" / stamp
    per_spacing = {float(k) / 1000: int(v) for k, v in (kv.split("=", 1) for kv in args.commands_at.split(",") if kv)}
    commands = (lambda sp: per_spacing.get(sp, args.commands)) if per_spacing else args.commands
    out.mkdir(parents=True, exist_ok=True)
    spacings = [float(x) / 1000 for x in args.spacings_ms.split(",") if x]
    activities = not args.no_activities
    result = {
        "task": "T04 upstream automatic-tiler baseline",
        "layer": "nested KWin virtual backend (not physical); kglobalaccel D-Bus command API, not input",
        "stamp": stamp,
        "versions": versions(),
        "polonium": {"researchPin": POLONIUM_PIN, "zipSha256": None},
        "environment": {"activitiesService": activities, "outputs": 1, "size": "1280x800", "decoration": "breeze SSD"},
        "workload": {"windows": 3, "commandsPerPhase": args.commands, "commandsAt": args.commands_at or None, "spacingsMs": [s * 1000 for s in spacings],
                     "commands": WORKLOADS, "idleAfterPhaseS": args.idle_s},
        "metrics": {
            "sendToFirstConfigureNs": "invokeShortcut send (CLOCK_MONOTONIC) -> first fixture xdg configure t_ns "
                                      "(CLOCK_MONOTONIC) within [t_send, t_next_send); later replies are censored "
                                      "into the next command at short spacing",
            "sendToFirstSizeConfigureNs": "same, first configure whose size differs from that fixture's previous one",
            "configuresPerCommand": "fixture configure records in [t_send, t_next_send) over all 3 fixtures",
            "idleConfiguresAfter1s": "configures >= 1 s after the last command of a phase (geometry fights)",
            "oracleErrors": "tests/integration/harness.tiling_errors on one-shot KWin script frames (no overlap, inside area)",
        },
        "tilers": {},
    }
    if args.polonium_zip.exists():
        result["polonium"]["zipSha256"] = hashlib.sha256(args.polonium_zip.read_bytes()).hexdigest()
    cfg = dict(kv.split("=", 1) for kv in args.polonium_config.split(",") if kv)
    for tiler in args.tilers.split(","):
        t0 = time.monotonic()
        try:
            if tiler == "polonium":
                res = run_polonium(out / tiler, args.polonium_zip, commands, spacings, args.idle_s, cfg, activities)
            else:
                res = run_plastile(out / tiler, commands, spacings, args.idle_s, activities)
        except Exception as exc:  # report, do not hide
            res = {"tiler": tiler, "error": "".join(traceback.format_exception(exc))[-2000:]}
        res["seconds"] = round(time.monotonic() - t0, 1)
        (out / tiler).mkdir(parents=True, exist_ok=True)
        (out / tiler / "samples.json").write_text(json.dumps(res, indent=1))
        result["tilers"][tiler] = summarize(res)
        print(f"== {tiler} ({res['seconds']} s) context={res.get('context')}")
        if "error" in res or "startError" in res:
            print("   ERROR:", (res.get("error") or res.get("startError", ""))[-600:])
        if "afterOpen" in res:
            print(f"   afterOpen errors={res['afterOpen']['errors']} coverage={res['afterOpen']['areaCoverage']}")
        for name, ph in res.get("phases", {}).items():
            print(f"   {name:14s} with-cfg={ph['commandsWithConfigure']}/{ph['commands']} "
                  f"send->cfg {fmt(ph['sendToFirstConfigureNs'])} send->size-cfg {fmt(ph['sendToFirstSizeConfigureNs'])} "
                  f"cfg/cmd p50/max {ph['configuresPerCommand']['p50']}/{ph['configuresPerCommand']['max']} "
                  f"idle-cfg {ph['idleConfiguresAfter1s']} oracle-errors {len(ph['oracle']['errors'])}")
    text = json.dumps(result, indent=1).replace(str(Path.home()), "~")
    (out / "summary.json").write_text(text)
    print(out / "summary.json")
    if args.evidence:
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        args.evidence.write_text(text + "\n")
        print(args.evidence)
    return 0


if __name__ == "__main__":
    sys.exit(main())
