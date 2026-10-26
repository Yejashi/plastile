#!/usr/bin/env python3
"""Nested dry run of the physical latency pipeline (NOT a physical measurement).

Runs the same block engine as orchestrate.py (randomized blocks, conditions, warmup,
pacing, safety stops, offline correlation, summary) inside a disposable nested KWin
(tools/nested.py, virtual backend). The only substitutions:

- input: plastile-keytap-ei (the same keytap.c built with the libei backend) emits through
  the nested KWin's own EIS socket. A uinput device cannot reach a nested virtual-backend
  KWin: kernel input goes to the compositor of the physical seat, which is exactly why the
  uinput backend refuses to start in a nested session.
- conditions: Plastile is loaded/unloaded in the disposable session (harness.Session).
- presentation: the virtual backend's software 60 Hz timeline, not scanout.

    python3 tools/physical/nested_dryrun.py [--rounds 2] [--samples 60] [--warmup 5] [--windows 3]
        [--workloads ...] [--keys] [--binding ACTION=CHORD ...] [--export-testdata DIR]

Prerequisites (inside tools/sandbox/run.sh or on a machine with KWin): npm run build,
make -C fixtures/client, make -C tools/physical ei, python-dbus, a C compiler (the guard self-check
builds keytap.c with a uinput node that does not exist and runs both guards against this session and against
a kwin_wayland started without a backend flag inside it).
Results: artifacts/physical/nested-<stamp>/ with layer "nested-dry-run" in every record.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import common  # noqa: E402
import orchestrate  # noqa: E402

sys.path.insert(0, str(common.REPO / "tests/integration"))
from harness import Session  # noqa: E402

# KWin's own defaults (kwin v6.7.5 src/useractions.cpp, initShortcut), used only when the
# nested kglobalshortcutsrc does not list an action yet.
KWIN_DEFAULTS = {
    "Window Maximize": "Meta+PgUp",
    "Window Quick Tile Left": "Meta+Left",
    "Window Quick Tile Top": "Meta+Up",
    "Window Quick Tile Bottom": "Meta+Down",
    "Switch Window Right": "Meta+Alt+Right",
}


def plastile_defaults() -> dict[str, str]:
    """Plastile's default chords as the code under test registers them (src/core/commands.ts)."""
    text = (common.REPO / "src/core/commands.ts").read_text()
    return dict(re.findall(r'id: "(plastile\.[a-z.-]+)",[^}]*?sequence: "([^"]+)"', text))


def default_bindings() -> dict[str, str]:
    return {**KWIN_DEFAULTS, **plastile_defaults()}


# PLASTILE_NESTED_HOST_DISPLAY (tools/nested.py) shows the nested outputs as windows on a running
# compositor and renders with the real GPU; presentation is then the nested KWin's timeline driven by
# the host's frame callbacks, still not scanout. The label says which.
WINDOWED = bool(os.environ.get("PLASTILE_NESTED_HOST_DISPLAY"))


class NestedDriver(orchestrate.Driver):
    layer = "nested-windowed-gpu" if WINDOWED else "nested-dry-run"
    input_source = "libei (the nested KWin's EIS socket) via plastile-keytap-ei"

    def __init__(self, session: Session):
        self.s = session

    def ensure_condition(self, condition: str) -> None:
        want = condition == "plastile"
        if want and not self.s.loaded:
            self.s.load()
        elif not want and self.s.loaded:
            self.s.unload()

    def spawn_fixture(self, ident: int, log_name: str) -> subprocess.Popen:
        return subprocess.Popen([str(common.FIXTURE), "--ssd", "--id", str(ident), "--app-id", "plastile-fixture",
                                 "--title", f"plastile-physical {ident}"], env=self.s.kw.client_env(),
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def counters(self) -> dict | None:
        if not self.s.loaded:
            return None
        try:
            return self.s.counters()
        except Exception as exc:  # noqa: BLE001 - diagnostics only
            return {"unavailableReason": str(exc)}


def eis_fd(session: Session) -> int:
    import dbus
    conn = session.kw._bus_connection()
    obj = conn.get_object("org.kde.KWin", "/org/kde/KWin/EIS/RemoteDesktop")
    fd, _cookie = obj.connectToEIS(1 | 2, dbus_interface="org.kde.KWin.EIS.RemoteDesktop")
    return fd.take() if isinstance(fd, dbus.types.UnixFd) else int(fd)


def nested_outputs(session: Session) -> list[dict] | None:
    try:
        r = subprocess.run(["kscreen-doctor", "-j"], env=session.kw.client_env(), capture_output=True, text=True,
                           timeout=15)
        return common.parse_kscreen(json.loads(r.stdout)) if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return None


def guard_keytap(outdir: Path) -> Path:
    """keytap.c built for the guard checks with a uinput node that does not exist (-DKEYTAP_UINPUT_PATH):
    even a guard that wrongly passed could not create a device on the host's seat."""
    exe, node = outdir / "plastile-keytap-guardcheck", outdir / "no-uinput" / "uinput"
    cc = os.environ.get("CC", "cc")
    subprocess.run([cc, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", f'-DKEYTAP_UINPUT_PATH="{node}"',
                    str(HERE / "keytap.c"), "-o", str(exe)], check=True, capture_output=True, timeout=120)
    return exe


def run_guards(keytap: Path, env: dict[str, str], bus_address: str) -> dict:
    """Both guards against the compositor serving env's WAYLAND_DISPLAY, with that session's bus."""
    out: dict = {}
    r = subprocess.run([str(keytap), "--backend", "uinput", "--settle-ms", "0"], env=env,
                       stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    first = json.loads(r.stdout.splitlines()[0]) if r.stdout.strip() else {}
    out["keytapUinput"] = {"exitCode": r.returncode, "message": first.get("msg")}
    try:
        common.guard_live_session(env, bus=common.Bus(bus_address))
        out["pythonGuard"] = {"refused": False}
    except common.GuardError as exc:
        out["pythonGuard"] = {"refused": True, "reasons": exc.reasons}
    return out


def refused_with(res: dict, needle: str) -> bool:
    return (res["keytapUinput"]["exitCode"] == 3 and needle in (res["keytapUinput"]["message"] or "")
            and res["pythonGuard"]["refused"] and any(needle in x for x in res["pythonGuard"].get("reasons", [])))


def flag_free_guard_check(session: Session, keytap: Path, outdir: Path) -> dict:
    """A kwin_wayland started with no backend flag inside this nested session (it picks the Wayland backend
    itself, as a nested Plasma does) on a bus of its own: the command line looks physical, so only the
    output-backend check can refuse it (B14). Its WAYLAND_DISPLAY is this session's socket by absolute path,
    checked to exist first: without one, a flag-free KWin would try the DRM backend of the host's seat."""
    host = Path(session.kw.run_dir) / session.kw.socket
    if not host.is_socket():
        return {"run": False, "reason": f"nested socket {host} missing"}
    root = outdir / "flag-free-kwin"
    (root / "config").mkdir(parents=True, exist_ok=True)
    bus = Path(session.kw.root) / "guardcheck-bus"  # a short path: a socket path has at most 107 bytes
    env = {**session.kw.env(), "WAYLAND_DISPLAY": str(host), "DBUS_SESSION_BUS_ADDRESS": f"unix:path={bus}",
           "XDG_CONFIG_HOME": str(root / "config")}
    env.pop("DISPLAY", None)
    socket = "wl-guardcheck"
    dbus = subprocess.Popen(["dbus-daemon", "--session", f"--address=unix:path={bus}", "--nofork", "--nopidfile"],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    kwin = None
    log = open(root / "kwin.log", "wb")
    try:
        deadline = time.monotonic() + 5
        while not bus.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        kwin = subprocess.Popen(["kwin_wayland", "--socket", socket, "--no-lockscreen"], env=env, stdout=log,
                                stderr=subprocess.STDOUT)
        up = False
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and kwin.poll() is None and not up:
            up = (Path(session.kw.run_dir) / socket).exists() and subprocess.run(
                ["busctl", f"--address=unix:path={bus}", "call", "org.kde.KWin", "/KWin", "org.freedesktop.DBus.Peer",
                 "Ping"], capture_output=True).returncode == 0
            time.sleep(0.05)
        if not up:
            return {"run": False, "reason": f"the flag-free kwin_wayland did not come up (rc {kwin.poll()}); see {root}"}
        res = run_guards(keytap, {**env, "WAYLAND_DISPLAY": socket, "XDG_SESSION_TYPE": "wayland"}, f"unix:path={bus}")
        return {"run": True, **res, "ok": refused_with(res, "not DRM")}
    finally:
        for p in (kwin, dbus):
            if p is not None and p.poll() is None:
                p.terminate()
                try:
                    p.wait(10)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
        log.close()


def guard_self_check(session: Session, outdir: Path) -> dict:
    """The uinput injector and the Python guard must both refuse this nested session, and a flag-free KWin
    nested inside it. The injector is a build that cannot open /dev/uinput (guard_keytap)."""
    keytap = guard_keytap(outdir)
    out = run_guards(keytap, {**session.kw.client_env(), "XDG_SESSION_TYPE": "wayland"}, session.kw.bus_address)
    out["flagFree"] = flag_free_guard_check(session, keytap, outdir)
    # A flag-free KWin that cannot start here (no renderer for the Wayland backend) is reported, not a failure.
    out["ok"] = refused_with(out, "runs nested") and out["flagFree"].get("ok", not out["flagFree"]["run"])
    return out


def export_testdata(outdir: Path, dest: Path, taps_per_block: int) -> list[str]:
    """Copy a trimmed slice of each recorded expect type (first completed block) for unit tests."""
    dest.mkdir(parents=True, exist_ok=True)
    written, seen = [], set()
    for meta_path in sorted((outdir / "blocks").glob("*/block.json")):
        meta = json.loads(meta_path.read_text())
        key = meta["workload"]
        if meta.get("outcome") != "completed" or key in seen:
            continue
        seen.add(key)
        bdir = meta_path.parent
        taps = common.read_jsonl(bdir / "taps.jsonl")
        keep = taps[: taps_per_block]
        cut = taps[taps_per_block]["t_input_ns"] if len(taps) > taps_per_block else None
        name = f"nested-{key}"
        common.write_jsonl(dest / f"{name}.taps.jsonl", keep)
        for fx in sorted(bdir.glob("fixture-*.jsonl")):
            recs = [r for r in common.read_jsonl(fx) if cut is None or r.get("t_ns", 0) < cut]
            for r in recs:  # no absolute local paths in committed data
                if r.get("ev") == "start" and r.get("args"):
                    r["args"] = ["fixtures/client/build/plastile-fixture", *r["args"][1:]]
            common.write_jsonl(dest / f"{name}.{fx.stem}.jsonl", recs)
        (dest / f"{name}.block.json").write_text(json.dumps(
            {k: meta.get(k) for k in ("workload", "condition", "expect", "windowCount", "refreshNsObservedAtStart")},
            indent=1) + "\n")
        written.append(name)
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workload-file", type=Path, default=orchestrate.WORKLOAD_FILE)
    ap.add_argument("--workloads", default=None, help="comma list (default: every non-optional workload)")
    ap.add_argument("--windows", default="3")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--samples", type=int, default=60)
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--binding", action="append", default=[], metavar="ACTION=CHORD",
                    help="store a user binding in the nested kglobalshortcutsrc before KWin starts (kglobalaccel "
                         "keeps it over the registered default), e.g. plastile.resize.grow=Meta+Shift+=")
    ap.add_argument("--bootstrap", type=int, default=500)
    ap.add_argument("--export-testdata", type=Path, default=None)
    ap.add_argument("--export-taps", type=int, default=12)
    ap.add_argument("--keys", action="store_true",
                    help="also press every bound Plastile chord once (the `orchestrate.py keys` check, via libei)")
    ap.add_argument("--no-latency", action="store_true", help="skip the latency blocks")
    args = ap.parse_args(argv)
    for need in (common.FIXTURE, common.KEYTAP_EI, common.REPO_BUNDLE):
        if not need.exists():
            print(f"missing {need}: build it first (see the module docstring)", file=sys.stderr)
            return 1
    wl_defs = orchestrate.load_workloads(args.workload_file)
    names = orchestrate.select_workloads(wl_defs, args.workloads)
    windows = [int(x) for x in args.windows.split(",")]
    plan = [] if args.no_latency else orchestrate.make_plan(names, windows, args.rounds, args.seed, wl_defs)
    outdir = common.ARTIFACTS / f"nested-{common.stamp()}"
    outdir.mkdir(parents=True, exist_ok=True)
    width, height = 1280, 800
    s = Session(outdir / "session", width=width, height=height)

    stored_user = orchestrate.parse_bindings(args.binding)
    defaults = default_bindings()

    def prepare(kw) -> None:
        if stored_user:
            lines = ["[kwin]"] + [f"{a}={chord.replace(',', chr(92) + ',')},{defaults.get(a, 'none')},{a}"
                                  for a, chord in stored_user.items()]
            (kw.root / "config" / "kglobalshortcutsrc").write_text("\n".join(lines) + "\n")
    s.kw.prepare = prepare
    monitor = orchestrate.Monitor()
    keytap = None
    rev, dirty = common.git_revision()
    ctx = {"stamp": outdir.name, "layer": NestedDriver.layer, "inputSource": NestedDriver.input_source,
           "environmentId": "nested-windowed-kwin" if WINDOWED else "nested-virtual-kwin", "outputName": None, "refreshHzDeclared": None,
           "implementationCommit": rev, "implementationDirty": dirty,
           "installedBundleSha256": common.sha256_file(common.REPO_BUNDLE)}
    rc = 0
    with s:
        driver = NestedDriver(s)
        outs = nested_outputs(s)
        if outs:
            ctx["outputName"] = outs[0]["name"]
            ctx["refreshHzDeclared"] = outs[0]["refreshRate"]
        compositing = s.kw.compositing_type()
        guard = guard_self_check(s, outdir)
        print(f"uinput guard self-check (must refuse this nested session and a flag-free KWin inside it): "
              f"{json.dumps(guard)}")
        if not guard["flagFree"]["run"]:
            print(f"NOTE: flag-free KWin guard check not run: {guard['flagFree']['reason']}")
        if not guard["ok"]:
            print("the session guard did NOT refuse a nested KWin; stopping", file=sys.stderr)
            return 1
        # Bindings: load Plastile once so it registers its shortcuts, then read the nested file.
        s.load()
        time.sleep(1.0)
        stored = common.shortcut_bindings(Path(s.kw.root) / "config" / "kglobalshortcutsrc", "kwin").get("kwin", {})
        actions = sorted({a for n in names for a in wl_defs[n].get("setup", []) + wl_defs[n]["cycle"]})
        overrides, sources = {}, {}
        for a in actions:
            if stored.get(a):
                sources[a] = "nested kglobalshortcutsrc"
            else:
                overrides[a] = defaults[a]
                sources[a] = "registered default (not yet in the nested kglobalshortcutsrc)"
        bindings = orchestrate.resolve_bindings(actions, stored, overrides)
        print("bindings: " + ", ".join(f"{a}={b['sequence']} [{sources[a]}]" for a, b in bindings.items()))
        (outdir / "plan.json").write_text(json.dumps({
            "seed": args.seed, "rounds": args.rounds, "samples": args.samples, "warmup": args.warmup,
            "windows": windows, "workloads": names, "bindings": bindings, "bindingSources": sources,
            "storedUserBindings": stored_user, "blocks": plan, "compositing": compositing, "guardSelfCheck": guard,
            "workloadDefinitions": {n: wl_defs[n] for n in names}}, indent=1))
        params = orchestrate.Params(samples=args.samples, warmup=args.warmup, refresh_hz=ctx["refreshHzDeclared"],
                                    gap_min_ms=20, gap_max_ms=50)
        fd = eis_fd(s)
        try:
            keytap = orchestrate.KeyTap([str(common.KEYTAP_EI), "--backend", "libei", "--ei-fd", str(fd)], monitor,
                                        outdir / "keytap.jsonl", pass_fds=(fd,), env=s.kw.client_env())
            os.close(fd)
            ready = keytap.wait_ready()
            ctx["clockResolutionNs"] = ready.get("clock_res_ns")
            orchestrate.execute(driver, keytap, monitor, plan, wl_defs, bindings, params, args.seed, outdir)
            if args.keys:
                driver.ensure_condition("plastile")
                stored = common.shortcut_bindings(Path(s.kw.root) / "config" / "kglobalshortcutsrc",
                                                  "kwin").get("kwin", {})
                todo, skipped = orchestrate.keys_plan(stored)
                print(f"keys check: {len(todo)} bound Plastile chords, {len(skipped)} skipped")
                kdir = outdir / "keys"
                kdir.mkdir(exist_ok=True)
                results = orchestrate.run_keys(driver, keytap, monitor, kdir, todo,
                                               reset=lambda: s.cmd("context.reset"))
                summary = orchestrate.keys_summary(results, skipped)
                (kdir / "keys.json").write_text(json.dumps(summary, indent=1) + "\n")
                print(f"keys check: not delivered: {', '.join(summary['notDelivered']) or 'none'}; "
                      f"unknown: {', '.join(summary['unknown']) or 'none'}")
        except orchestrate.Abort as exc:
            print(f"STOPPED: {exc}", file=sys.stderr)
            rc = 2
        finally:
            if keytap is not None:
                keytap.close()
    (outdir / "context.json").write_text(json.dumps(ctx, indent=1) + "\n")
    if plan:
        orchestrate.finish(outdir, ctx, {n: wl_defs[n] for n in names}, bootstrap=args.bootstrap, seed=args.seed)
    if args.export_testdata:
        print("exported test data:", ", ".join(export_testdata(outdir, args.export_testdata, args.export_taps)))
    print(f"results: {outdir}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
