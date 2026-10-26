#!/usr/bin/env python3
"""Read-only pre-flight check of the live Plasma session for physical validation.

    python3 tools/physical/session_check.py [--json PATH] [--require-output NAME]
        [--require-plastile loaded|unloaded|any]

It confirms, without changing anything:
- the session is Wayland and its compositor is a non-nested kwin_wayland of this user
  (Wayland socket peer credentials, /proc, and the org.kde.KWin bus-name owner);
- KWin/Qt versions, compositing type and loaded effects (KWin supportInformation getter);
- outputs with modes, refresh rates, scales, priorities and VRR policy (kscreen-doctor -j);
- whether Plastile is installed, enabled in kwinrc (read), loaded (isScriptLoaded getter),
  and whether the installed bundle matches this checkout's build;
- Plastile Motion: kwinrc/kdeglobals settings (read) and whether the effect is loaded
  (isEffectLoaded getter), PERFORMANCE section 6.1;
- Plastile and KWin shortcut bindings, duplicate key sequences, the native tile editor (Meta+T);
- activities, virtual desktops, the logind session state, /dev/uinput access, CPU governor.

Exit codes: 0 all required checks passed; 1 a requirement failed; 3 not a live, non-nested
KWin Wayland session (nothing else is queried then). Output goes to stdout and, with --json,
to a file (default under artifacts/physical/). Window titles, host names, serial numbers and
EDID are never collected.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common  # noqa: E402

KNOWN_TILERS = ("polonium", "krohnkite", "bismuth", "kwin-tiling", "tilingkwin", "kzones", "geometrychange")
WORKLOAD_KWIN_ACTIONS = ("Window Maximize", "Window Quick Tile Left", "Window Quick Tile Top",
                         "Window Quick Tile Bottom", "Switch Window Right", "Edit Tiles")


def _run(cmd: list[str], timeout: float = 10.0) -> tuple[int, str]:
    if shutil.which(cmd[0]) is None:
        return -1, f"{cmd[0]} not found"
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return -1, "timeout"
    return r.returncode, r.stdout if r.returncode == 0 else (r.stderr or r.stdout)


def parse_support_information(text: str | None) -> dict:
    if not text:
        return {"available": False}
    info: dict = {"available": True}
    for key, rx in {"kwinVersion": r"^KWin version: (.+)$", "qtVersion": r"^Qt Version: (.+)$",
                    "operationMode": r"^Operation Mode: (.+)$", "compositingType": r"^Compositing Type: (.+)$",
                    "openglRenderer": r"^OpenGL renderer string: (.+)$"}.items():
        m = re.search(rx, text, re.M)
        info[key] = m.group(1).strip() if m else None
    m = re.search(r"^Loaded Effects:\n-+\n(.*?)\n\n", text, re.M | re.S)
    info["loadedEffects"] = sorted(m.group(1).split()) if m else None
    return info


def plastile_state(bus: common.Bus, env: dict[str, str]) -> dict:
    data_home = Path(env.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    target = data_home / "kwin/scripts" / common.PLUGIN
    meta = target / "metadata.json"
    version = None
    if meta.exists():
        try:
            version = json.loads(meta.read_text())["KPlugin"]["Version"]
        except (json.JSONDecodeError, KeyError):
            version = "unreadable"
    kwinrc = common.read_kconfig(common.config_home(env) / "kwinrc")
    plugins = kwinrc.get("Plugins", {})
    enabled_tilers = sorted(k[:-7] for k, v in plugins.items() if k.endswith("Enabled") and v.strip() == "true"
                            and k[:-7].lower() in KNOWN_TILERS)
    return {
        "installed": target.is_dir(), "installedVersion": version,
        "installedBundleSha256": common.sha256_file(target / "contents/code/plastile.mjs"),
        "repoBundleSha256": common.sha256_file(common.REPO_BUNDLE),
        "enabledInKwinrc": plugins.get(f"{common.PLUGIN}Enabled", "unset").strip(),
        "settingsGroupPresent": f"Script-{common.PLUGIN}" in kwinrc,
        "loaded": bus.script_loaded(common.PLUGIN),
        "otherTilersEnabled": enabled_tilers,
    }


def shortcut_state(env: dict[str, str]) -> dict:
    path = common.config_home(env) / "kglobalshortcutsrc"
    allb = common.shortcut_bindings(path)
    kwin = allb.get("kwin", {})
    plastile = {a: s for a, s in sorted(kwin.items()) if a.startswith("plastile.")}
    dups = {seq: who for seq, who in common.duplicate_bindings(allb).items()
            if any("/plastile." in w for w in who)}
    unparseable = {}
    for a, seqs in plastile.items():
        for seq in seqs:
            try:
                common.parse_sequence(seq)
            except common.KeySpecError as exc:
                unparseable[a] = str(exc)
    return {"file": str(path).replace(str(Path.home()), "~"), "fileExists": path.exists(),
            "plastile": plastile, "plastileCount": len(plastile),
            "kwinWorkloadActions": {a: kwin.get(a) for a in WORKLOAD_KWIN_ACTIONS},
            "duplicatesInvolvingPlastile": dups, "unmappableForInjector": unparseable}


def environment_id(osr: dict, kwin: dict) -> str:
    ver = (kwin.get("kwinVersion") or "unknown").replace(" ", "")
    return f"physical-{osr.get('ID', 'linux')}-kwin-{ver}"


def os_release() -> dict:
    try:
        data = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    except OSError:
        return {}
    return {k: data[k].strip('"') for k in ("ID", "NAME", "VERSION_ID", "BUILD_ID") if k in data}


def logind_state(env: dict[str, str]) -> dict | None:
    sid = env.get("XDG_SESSION_ID")
    if not sid:
        return None
    code, out = _run(["loginctl", "show-session", sid, "-p", "Active", "-p", "Remote", "-p", "Type", "-p", "State"])
    if code != 0:
        return None
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def collect(guard: dict | None = None, bus: common.Bus | None = None, env: dict[str, str] | None = None) -> dict:
    """Gather the report. Call only after guard_live_session() succeeded (or pass its result)."""
    env = dict(os.environ if env is None else env)
    bus = bus or common.Bus()
    guard = guard or common.guard_live_session(env, bus=bus)
    kwin = parse_support_information(bus.support_information())
    osr = os_release()
    try:
        import sysinfo  # tools/sysinfo.py: distribution-neutral package lookups
        kwin_pkg = sysinfo.component_version("kwin")
        qt_pkg = sysinfo.component_version("qt6-declarative")
    except Exception:  # noqa: BLE001 - optional enrichment only
        kwin_pkg = qt_pkg = None
    acts_code, acts = _run(["busctl", "--user", "--json=short", "call", "org.kde.ActivityManager",
                            "/ActivityManager/Activities", "org.kde.ActivityManager.Activities", "ListActivities"])
    activities = None
    if acts_code == 0:
        try:
            activities = len(json.loads(acts)["data"][0])
        except (json.JSONDecodeError, KeyError, IndexError):
            activities = None
    desktops = None
    code, out = _run(["busctl", "--user", "--json=short", "get-property", "org.kde.KWin", "/VirtualDesktopManager",
                      "org.kde.KWin.VirtualDesktopManager", "count"])
    if code == 0:
        try:
            desktops = json.loads(out)["data"]
        except (json.JSONDecodeError, KeyError):
            desktops = None
    gov = Path("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
    pcode, profile = _run(["powerprofilesctl", "get"])
    rev, dirty = common.git_revision()
    effects = kwin.get("loadedEffects") or []
    report = {
        "schemaVersion": 1, "collector": "tools/physical/session_check.py (read-only)",
        "repository": {"revision": rev, "dirty": dirty},
        "os": osr, "kernel": platform.release(),
        "session": {"type": env.get("XDG_SESSION_TYPE"), "desktop": env.get("XDG_CURRENT_DESKTOP"),
                    "kdeSessionVersion": env.get("KDE_SESSION_VERSION"), "logind": logind_state(env)},
        "compositor": guard, "kwin": {**kwin, "package": kwin_pkg, "qtDeclarativePackage": qt_pkg,
                                      "tileEditorEffectLoaded": "tileseditor" in effects},
        "outputs": common.kscreen_outputs(),
        "plastile": plastile_state(bus, env),
        "motion": common.motion_state(bus, common.config_home(env)),
        "shortcuts": shortcut_state(env),
        "activities": {"count": activities}, "virtualDesktops": {"count": desktops},
        "input": {"uinputExists": Path("/dev/uinput").exists(), "uinputWritable": os.access("/dev/uinput", os.W_OK)},
        "power": {"cpuGovernor": gov.read_text().strip() if gov.exists() else None,
                  "powerProfile": profile.strip() if pcode == 0 else None},
        "builds": {"fixture": common.FIXTURE.exists(), "keytap": common.KEYTAP.exists(),
                   "repoBundle": common.REPO_BUNDLE.exists()},
    }
    report["environmentId"] = environment_id(osr, kwin)
    return report


def evaluate(report: dict, require_output: str | None, require_plastile: str) -> list[tuple[str, str, str]]:
    """[(level, item, detail)] with level OK/WARN/FAIL. FAIL means a requirement is not met."""
    rows = [("OK", "session", f"Wayland, kwin_wayland pid {report['compositor']['kwinPid']} (not nested)")]
    k = report["kwin"]
    if not k.get("available"):
        rows.append(("FAIL", "kwin", "supportInformation unavailable"))
    else:
        level = "OK" if (k.get("kwinVersion") or "").startswith("6.7") else "WARN"
        rows.append((level, "kwin", f"{k.get('kwinVersion')} (Qt {k.get('qtVersion')}), {k.get('compositingType')}, "
                                    f"package {k.get('package')}"))
    outs = report.get("outputs")
    if outs is None:
        rows.append(("FAIL", "outputs", "kscreen-doctor -j unavailable"))
    else:
        for o in outs:
            rows.append(("OK" if o.get("enabled") else "WARN", f"output {o['name']}",
                         f"{o.get('size')} @ {o.get('refreshRate')} Hz, scale {o.get('scale')}, pos {o.get('pos')}, "
                         f"priority {o.get('priority')}, vrr {o.get('vrrPolicy')}"
                         + ("" if o.get("enabled") else " (disabled)")))
        if require_output and not any(o["name"] == require_output and o.get("enabled") for o in outs):
            rows.append(("FAIL", "required output", f"{require_output} is not an enabled output"))
    p = report["plastile"]
    rows.append(("OK" if p["installed"] else "WARN", "plastile installed",
                 f"{p['installed']} (version {p['installedVersion']})"))
    if p["installed"] and p["installedBundleSha256"] != p["repoBundleSha256"]:
        rows.append(("WARN", "plastile bundle", "installed bundle differs from this checkout's build (or no build)"))
    rows.append(("OK", "plastile enabled in kwinrc", str(p["enabledInKwinrc"])))
    m = report.get("motion") or {}
    rows.append(("WARN" if m.get("on") else "OK", "plastile motion",
                 f"{m.get('label')} (loaded {m.get('loaded')}, kwinrc {m.get('enabledInKwinrc')}, effective "
                 f"{m.get('effectiveDurationMs')} ms)" + ("; P6 blocks are labelled motion on and report no t9_settled"
                                                         if m.get("on") else "")))
    loaded = p["loaded"]
    want = {"loaded": True, "unloaded": False}.get(require_plastile)
    level = "FAIL" if (loaded is None or (want is not None and loaded is not want)) else "OK"
    rows.append((level, "plastile loaded", f"{loaded} (required: {require_plastile})"))
    if p["otherTilersEnabled"]:
        rows.append(("FAIL", "other tilers", f"enabled: {', '.join(p['otherTilersEnabled'])} (disable them first)"))
    s = report["shortcuts"]
    rows.append(("OK" if s["plastileCount"] else "WARN", "plastile shortcuts",
                 f"{s['plastileCount']} registered in {s['file']}"))
    for seq, who in s["duplicatesInvolvingPlastile"].items():
        rows.append(("WARN", "duplicate binding", f"{seq}: {', '.join(who)}"))
    for a, why in s["unmappableForInjector"].items():
        rows.append(("WARN", "binding not injectable", f"{a}: {why}"))
    edit = (s["kwinWorkloadActions"] or {}).get("Edit Tiles")
    rows.append(("OK" if k.get("tileEditorEffectLoaded") else "WARN", "native tile editor",
                 f"Edit Tiles bound to {edit}; tileseditor effect loaded: {k.get('tileEditorEffectLoaded')}"))
    lg = report["session"].get("logind")
    if lg:
        ok = lg.get("Active") == "yes" and lg.get("Remote") == "no"
        rows.append(("OK" if ok else "WARN", "logind session", f"Active={lg.get('Active')} Remote={lg.get('Remote')}"))
    rows.append(("OK" if report["input"]["uinputWritable"] else "WARN", "uinput",
                 "writable" if report["input"]["uinputWritable"] else "not writable (needed only for latency runs)"))
    pw = report["power"]
    rows.append(("OK", "power", f"governor {pw['cpuGovernor']}, profile {pw['powerProfile']}"))
    b = report["builds"]
    rows.append(("OK" if all(b.values()) else "WARN", "builds",
                 ", ".join(f"{k2} {'present' if v else 'MISSING'}" for k2, v in b.items())))
    rows.append(("OK", "activities / desktops",
                 f"{report['activities']['count']} activities, {report['virtualDesktops']['count']} virtual desktops"))
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", type=Path, default=None, help="write the report here (default: artifacts/physical/)")
    ap.add_argument("--no-json", action="store_true", help="print only")
    ap.add_argument("--require-output", default=None)
    ap.add_argument("--require-plastile", choices=("loaded", "unloaded", "any"), default="any")
    args = ap.parse_args(argv)
    try:
        guard = common.guard_live_session()
    except common.GuardError as exc:
        print("FAIL  session: not a live, non-nested KWin Wayland session of this user:")
        for r in exc.reasons:
            print(f"        - {r}")
        print("Nothing else was queried.")
        return 3
    report = collect(guard=guard)
    rows = evaluate(report, args.require_output, args.require_plastile)
    for level, item, detail in rows:
        print(f"{level:<5} {item}: {detail}")
    if not args.no_json:
        path = args.json or common.ARTIFACTS / f"session-{common.stamp()}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=1) + "\n")
        print(f"report: {path}")
    return 1 if any(level == "FAIL" for level, _, _ in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
