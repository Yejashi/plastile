"""Real-application scenarios (TEST_MATRIX section 4, "representative real applications").

Each scenario starts a fresh nested KWin with two fixture windows and the real Plastile
package, launches one installed desktop application into that session, and judges the
result with the oracle (one-shot KWin scripts). Plastile's `inspect.explain-window` output
is read only to decide which oracle rule applies (tiled: no overlap inside the area;
floating: the window's own size is kept) and to record the decision.

Expectations are derived from what KWin (and, for X11 clients, the client's own ICCCM hints
read with xprop) reports, not from Plastile: a dialog, utility, transient, modal, non-resizable
or fixed-size (min == max) window must float and keep its size; a normal resizable window must
tile, or, when its minimum cannot fit next to the fixtures, float with an explained overflow.

Applications are only ever started inside the nested session (its private bus, XDG tree,
HOME and Wayland/X sockets). Every process whose XDG_RUNTIME_DIR is this session's private
run directory (the app, its helpers and any D-Bus-activated services) is terminated before
and after the session stops. Raw window listings, which may contain window titles, go to
artifacts/realapps/ only; the per-scenario result.json carries app ids and versions.

Committed summary: python3 tests/integration/scenarios_realapps.py --evidence artifacts/integration/<stamp>
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from harness import NestedError, ROOT, Session, delta, tiling_errors
import sysinfo  # tools/ is on sys.path via harness  # noqa: E402
from scenarios import Checks, scenario

RAW_DIR = ROOT / "artifacts/realapps"
FIX = "plastile-fixture"
FIELDS = (
    "({id: String(w.internalId), caption: w.caption, appId: w.resourceClass, resourceName: w.resourceName, pid: w.pid,"
    # Plastile's own UI (the inspector the explain command opens), by adapter.ts isOwnUi's rule.
    " own: w.caption === 'Plastile inspector' && !w.resourceClass && !w.desktopFileName && !(w.pid > 0),"
    " frame: {x: w.frameGeometry.x, y: w.frameGeometry.y, width: w.frameGeometry.width, height: w.frameGeometry.height},"
    " client: {x: w.clientGeometry.x, y: w.clientGeometry.y, width: w.clientGeometry.width, height: w.clientGeometry.height},"
    " minSize: {width: w.minSize.width, height: w.minSize.height}, maxSize: {width: w.maxSize.width, height: w.maxSize.height},"
    " normalWindow: w.normalWindow, dialog: w.dialog, utility: w.utility, transient: w.transient, modal: w.modal,"
    " popupWindow: w.popupWindow, specialWindow: w.specialWindow, resizeable: w.resizeable, managed: w.managed,"
    " minimized: w.minimized, fullScreen: w.fullScreen, maximizeMode: w.maximizeMode, active: w.active,"
    " tile: w.tile !== null, output: w.output ? w.output.name : null, noBorder: w.noBorder,"
    " windowType: w.windowType, desktopFileName: w.desktopFileName})"
)
ERR_RX = r"plastile (error|warn)|TypeError|ReferenceError"
KIND_KEYS = ("normalWindow", "dialog", "utility", "transient", "modal", "popupWindow", "specialWindow", "resizeable",
             "windowType")


def package_version(binary: str) -> str | None:
    """Owning package and version (pacman, dpkg or rpm), or None."""
    return sysinfo.binary_version(binary)


def all_windows(s: Session) -> list[dict]:
    """Oracle snapshot of every managed window; captions are replaced by neutral labels before recording."""
    out = s.js(f"emit(workspace.windowList().map(w => {FIELDS}));")
    data = json.loads(out[0])
    if isinstance(data, dict) and "error" in data:
        raise NestedError(data["error"])
    return data


def label(w: dict) -> str:
    return w["caption"] if w["appId"] == FIX else f"{w['appId']}#{w['id'][1:9]}"


def labelled(ws: list[dict]) -> list[dict]:
    return [{**w, "caption": label(w)} for w in ws]


def x_display(s: Session) -> str:
    """The nested KWin's public X11 display (XWayland sessions only); see NestedKwin.x_display."""
    return s.kw.x_display()


def x11_hints(env: dict, app_id: str) -> dict | None:
    """The client's own ICCCM/EWMH hints (independent of KWin's interpretation), via xprop. The KWin 6 script
    API exposes no X11 window id (w.windowId is undefined), so the window is found in _NET_CLIENT_LIST by WM_CLASS."""
    r = subprocess.run(["xprop", "-root", "_NET_CLIENT_LIST"], env=env, capture_output=True, text=True, timeout=10)
    wid = None
    for cand in re.findall(r"0x[0-9a-f]+", r.stdout):
        cls = subprocess.run(["xprop", "-id", cand, "WM_CLASS"], env=env, capture_output=True, text=True, timeout=10).stdout
        if f'"{app_id}"' in cls:
            wid = cand
    if wid is None:
        return None
    r = subprocess.run(["xprop", "-id", wid, "WM_NORMAL_HINTS", "_NET_WM_WINDOW_TYPE", "WM_TRANSIENT_FOR",
                        "_GTK_FRAME_EXTENTS"], env=env, capture_output=True, text=True, timeout=10)
    txt = r.stdout
    out: dict = {"exit": r.returncode}
    m = re.search(r"_GTK_FRAME_EXTENTS\(CARDINAL\) = ([\d, ]+)", txt)
    out["gtkFrameExtents"] = [int(v) for v in m.group(1).split(",")] if m else None
    for key, rx in (("min", r"program specified minimum size: (\d+) by (\d+)"),
                    ("max", r"program specified maximum size: (\d+) by (\d+)"),
                    ("userSize", r"user specified size: (\d+) by (\d+)"),
                    ("programSize", r"program specified size: (\d+) by (\d+)")):
        m = re.search(rx, txt)
        out[key] = {"width": int(m.group(1)), "height": int(m.group(2))} if m else None
    m = re.search(r"_NET_WM_WINDOW_TYPE\(ATOM\) = (.*)", txt)
    out["netWmWindowType"] = m.group(1).strip() if m else None
    out["transientFor"] = "WM_TRANSIENT_FOR(WINDOW)" in txt and "not found" not in txt.split("WM_TRANSIENT_FOR", 1)[1][:40]
    return out


def _ppid(pid: int) -> int:
    try:
        return int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
    except (OSError, IndexError, ValueError):
        return 0


def descendants_of(roots: set[int]) -> set[int]:
    """`roots` and every live descendant (Xwayland under KWin, activated services under the private dbus-daemon)."""
    pids = [int(p) for p in os.listdir("/proc") if p.isdigit()]
    parent = {p: _ppid(p) for p in pids}
    out = set(r for r in roots if r and r > 0)
    changed = True
    while changed:
        changed = False
        for p, pp in parent.items():
            if pp in out and p not in out:
                out.add(p); changed = True
    return out


def session_procs(run_dir: str, exclude: set[int]) -> list[tuple[int, str]]:
    """Processes that live in this nested session: XDG_RUNTIME_DIR is its private run directory."""
    needle = f"XDG_RUNTIME_DIR={run_dir}".encode()
    found = []
    for p in os.listdir("/proc"):
        if not p.isdigit() or int(p) in exclude or int(p) == os.getpid():
            continue
        try:
            if os.stat(f"/proc/{p}").st_uid != os.getuid():
                continue
            if needle in open(f"/proc/{p}/environ", "rb").read().split(b"\0"):
                found.append((int(p), Path(f"/proc/{p}/comm").read_text().strip()))
        except OSError:
            continue
    return found


def sweep(run_dir: str, exclude: set[int], grace: float = 5.0) -> list[str]:
    """SIGTERM (then SIGKILL) every process of this session except `exclude`; returns their comm names."""
    victims = session_procs(run_dir, exclude)
    for pid, _ in victims:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline and session_procs(run_dir, exclude):
        time.sleep(0.1)
    for pid, _ in session_procs(run_dir, exclude):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    return sorted(c for _, c in victims)


def explain(s: Session, win_id: str) -> dict:
    """Activate the window by internalId and read Plastile's explanation from the log."""
    s.js(f"const w = workspace.windowList().find(x => String(x.internalId) === {json.dumps(win_id)});"
         f"if (w) workspace.activeWindow = w; emit({{found: !!w}});")
    time.sleep(0.1)
    off = s.kw.mark()
    s.cmd("inspect.explain-window")
    line = s.kw.wait_log(r"plastile info explain ", 5, off)[-1]
    return json.loads(line.split("plastile info explain ", 1)[1])


def redact_explain(e: dict) -> dict:
    keys = ("appId", "kind", "mode", "userMode", "decision", "layout", "suspensions", "constraints", "learnedMin",
            "learnedMax", "ledger", "exception", "nativeTile")
    out = {k: e.get(k) for k in keys if k in e}
    if isinstance(out.get("exception"), str):  # the text names the window by internalId; keep the category and reason
        out["exception"] = re.sub(r"\{[0-9a-f-]{36}\}", "<window>", out["exception"])
    return out


def must_float(w: dict, hints: dict | None) -> str | None:
    """Kind-based expectation from KWin's (and the client's) own report, independent of Plastile."""
    if w["dialog"]:
        return "dialog"
    if w["utility"]:
        return "utility"
    if w["transient"] or w["modal"]:
        return "transient/modal"
    if not w["resizeable"]:
        return "not resizeable"
    mn, mx = w["minSize"], w["maxSize"]
    if mn["width"] > 0 and mn["width"] == mx["width"] and mn["height"] == mx["height"]:
        return "fixed size (KWin min == max)"
    if hints and hints.get("min") and hints.get("max") and hints["min"] == hints["max"]:
        return "fixed size (client WM_NORMAL_HINTS min == max)"
    return None


class App:
    """`expect`: "tiled", "floating", "overflow" (decision tiled but floated with an explained overflow
    exception because the minimum size does not fit next to the fixtures) or "kind" (derive from the
    window kind reported by KWin: must_float() -> floating, otherwise tiled or overflow)."""

    def __init__(self, name: str, binary: str, argv, classes: tuple[str, ...], env=None, xwayland: bool = False,
                 map_timeout: float = 20.0, expect: str = "kind", width: int = 1280, height: int = 800, note: str = ""):
        self.name, self.binary, self.argv, self.classes = name, binary, argv, classes
        self.env, self.xwayland, self.map_timeout, self.expect = env or {}, xwayland, map_timeout, expect
        self.width, self.height, self.note = width, height, note


def run_app(app: App, out: Path, c: Checks) -> None:
    stamp = time.strftime("%Y%m%dT%H%M%S")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    raw = (RAW_DIR / f"{stamp}-{app.name}.jsonl").open("w")
    result: dict = {"app": app.name, "binary": app.binary, "version": package_version(app.binary), "layer":
                    "nested KWin virtual backend (not physical)", "xwayland": app.xwayland,
                    "output": {"width": app.width, "height": app.height}, "expect": app.expect, "note": app.note,
                    "windows": []}

    def rec(ev: str, **data) -> None:
        raw.write(json.dumps({"t": time.time(), "ev": ev, **data}) + "\n"); raw.flush()

    def finish() -> None:
        result["checks"] = {k: v["pass"] for k, v in c.items.items()}
        result["kwin"] = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
        (out / "result.json").write_text(json.dumps(result, indent=1))
        raw.close()

    if not shutil.which(app.binary):
        c(f"{app.name}: installed", False, "binary not found")
        result["skipped"] = "not installed"
        finish()
        return
    s = Session(out, xwayland=app.xwayland, width=app.width, height=app.height)
    run_dir = str(s.kw.run_dir)
    try:
        with s:
            # NestedKwin picks a fresh session root when it starts (mkdtemp): read the run
            # directory now, or the sweeps and the survivor check look at a path nothing uses.
            run_dir = str(s.kw.run_dir)
            infra = {s.kw.kwin_pid, s.kw._dbus.pid if s.kw._dbus else -1}
            s.spawn(1); s.spawn(2)
            s.load(); s.settle()
            infra |= {fx.proc.pid for fx in s.fixtures.values()}
            # Anything else already in the session (e.g. XWayland, kwin helpers) is infrastructure, not the app.
            infra |= {pid for pid, _ in session_procs(run_dir, set())}
            area = s.area()
            base_frames = {f["caption"]: f["frame"] for f in s.frames_list()}
            c(f"{app.name}: baseline two fixtures tiled", not tiling_errors(s.frames_list(), area, 8))
            env = s.kw.client_env()
            if app.xwayland:
                env["DISPLAY"] = x_display(s)
            env["HOME"] = str(s.kw.root / "home")  # apps never write into the user's home
            (s.kw.root / "home").mkdir(exist_ok=True)
            env.update({k: v.replace("{root}", str(s.kw.root)) for k, v in app.env.items()})
            argv = [a.replace("{root}", str(s.kw.root)) for a in app.argv]
            before_ids = {w["id"] for w in all_windows(s)}
            off = s.kw.mark()
            c0 = s.counters()
            proc = subprocess.Popen(argv, env=env, stdout=(out / f"{app.name}.log").open("w"), stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
            rec("launch", argv=argv, pid=proc.pid)
            new: list[dict] = []
            main = None
            try:
                def appeared() -> bool:
                    nonlocal new
                    new = [w for w in all_windows(s) if w["id"] not in before_ids and w["appId"] != FIX
                           and (w["normalWindow"] or w["dialog"] or w["utility"])]
                    return bool(new)
                t0 = time.monotonic()
                try:
                    s.wait_for(appeared, app.map_timeout, f"{app.name} window")
                    map_s = round(time.monotonic() - t0, 2)
                except NestedError:
                    map_s = None
                rec("mapped", windows=new, seconds=map_s)
                c(f"{app.name}: window mapped within {app.map_timeout:.0f} s", bool(new), {"seconds": map_s, "exit": proc.poll()})
                result["mapTimeSeconds"] = map_s
                if not new:
                    result["mapped"] = False
                    return
                main = sorted(new, key=lambda w: (not w["normalWindow"] and not w["dialog"],
                                                  -w["frame"]["width"] * w["frame"]["height"]))[0]
                c(f"{app.name}: resourceClass in {app.classes}", main["appId"] in app.classes, main["appId"])
                initial = dict(main["frame"])
                s.settle(timeout=8.0)
                time.sleep(0.5)
                s.settle(timeout=4.0)
                hints = x11_hints(env, main["appId"]) if app.xwayland else None
                result["x11"] = hints is not None
                if hints is not None:
                    result["x11Hints"] = hints
                exp = explain(s, main["id"])
                rec("explain", explain=exp)
                result["explain"] = redact_explain(exp)
                mode = exp.get("mode")
                c1 = s.counters()
                time.sleep(3.0)
                c2 = s.settle(timeout=4.0)
                ws = labelled(all_windows(s))
                rec("windows_after_settle", windows=ws)
                for w in ws:
                    if w["appId"] != FIX:
                        result["windows"].append({k: w[k] for k in ("appId", "resourceName", "desktopFileName", *KIND_KEYS,
                                                                     "minSize", "maxSize", "frame", "client", "noBorder")}
                                                 | {"main": w["id"] == main["id"]})
                app_main = next((w for w in ws if w["id"] == main["id"]), None)
                c(f"{app.name}: main window still present", app_main is not None)
                if app_main is None:
                    return
                result["kind"] = {k: app_main[k] for k in KIND_KEYS}
                floats_because = must_float(app_main, hints)
                result["mustFloat"] = floats_because
                tiled_set = [w for w in ws if w["appId"] == FIX] + ([app_main] if mode == "tiled" else [])
                errs = tiling_errors(tiled_set, area, 8)
                if mode == "tiled":
                    c(f"{app.name}: tiled with the fixtures without overlap (oracle)", not errs, errs)
                    others = [w for w in ws if w["appId"] != FIX and w["id"] != main["id"] and not w["transient"] and w["normalWindow"]
                              and not w.get("own")]
                    c(f"{app.name}: no extra untracked normal windows", not others, [label(w) for w in others])
                else:
                    c(f"{app.name}: floating window keeps its own size (not fought)",
                      abs(app_main["frame"]["width"] - initial["width"]) <= 1 and abs(app_main["frame"]["height"] - initial["height"]) <= 1,
                      {"initial": initial, "now": app_main["frame"], "decision": exp.get("decision")})
                    c(f"{app.name}: fixtures keep the whole area", not errs and all(w["frame"]["height"] > area["height"] - 20
                                                                                for w in tiled_set), [w["frame"] for w in tiled_set])
                overflow = (mode == "floating" and (exp.get("decision") or {}).get("mode") == "tiled"
                            and str(exp.get("exception", "")).startswith("overflow"))
                if floats_because:
                    c(f"{app.name}: {floats_because} -> floating", mode == "floating",
                      {"mode": mode, "decision": exp.get("decision")})
                if app.expect == "kind":
                    if not floats_because:
                        c(f"{app.name}: normal resizable -> tiled or explained overflow", mode == "tiled" or overflow,
                          {"mode": mode, "decision": exp.get("decision"), "exception": exp.get("exception")})
                elif app.expect in ("tiled", "floating"):
                    c(f"{app.name}: expected mode {app.expect}", mode == app.expect, {"mode": mode, "decision": exp.get("decision"),
                                                                                      "exception": exp.get("exception")})
                elif app.expect == "overflow":
                    c(f"{app.name}: minimum does not fit -> explained overflow float", overflow,
                      {"mode": mode, "exception": exp.get("exception")})
                d = delta(c1, c2)
                total = delta(c0, c2)
                ledger_corr = (exp.get("ledger") or {}).get("corrections", 0)
                result["counters"] = {"sinceLaunch": total, "quiet3s": d, "outstanding": c2["outstanding"],
                                      "windowLedgerCorrections": ledger_corr}
                c(f"{app.name}: corrections <= 2 over 3 s after settle", d.get("corrections", 0) <= 2, d)
                c(f"{app.name}: corrections <= 2 since launch (engine and window ledger)",
                  total.get("corrections", 0) <= 2 and ledger_corr <= 2, {"engine": total.get("corrections", 0),
                                                                          "ledger": ledger_corr})
                c(f"{app.name}: converged (no outstanding requests)", c2["outstanding"] == 0, c2["outstanding"])
                # Constraint handling: honoured minSize (pre-clamped) or learned from the client's refusal.
                fr, mn = app_main["frame"], app_main["minSize"]
                if mode == "tiled":  # minSize is client-space; the client may be larger than the frame (X11 CSD)
                    cg = app_main["client"]
                    c(f"{app.name}: client >= KWin-reported minSize (client coords)",
                      cg["width"] >= mn["width"] - 0.5 and cg["height"] >= mn["height"] - 0.5, {"client": cg, "minSize": mn})
                # Plastile's constraint model vs KWin's current report: frame-space minimum is the client
                # minimum plus (frame - client), which is negative for X11 CSD clients whose client geometry
                # includes the shadow (_GTK_FRAME_EXTENTS); fixed-ness must match KWin's.
                eff = exp.get("constraints") or {}
                cl = app_main["client"]
                want_min = {k: (mn[k] + fr[k] - cl[k]) if mn[k] > 0 else 0 for k in ("width", "height")}
                mx = app_main["maxSize"]
                kwin_fixed = (not app_main["resizeable"]) or (0 < mx["width"] < 2147483647 and mn["width"] == mx["width"]
                                                               and mn["height"] == mx["height"])
                got_min = eff.get("minFrame") or {}
                c(f"{app.name}: Plastile constraints match KWin's current minSize/fixed (frame space)",
                  eff.get("fixed") == kwin_fixed and all(abs(got_min.get(k, -1) - want_min[k]) <= 1 for k in ("width", "height")),
                  {"plastile": eff, "kwinFixed": kwin_fixed, "expectedMinFrame": want_min, "kwinMinSize": mn,
                   "frameMinusClient": {k: fr[k] - cl[k] for k in ("width", "height")}})
                result["constraint"] = {"kwinMinSize": mn, "kwinMaxSize": app_main["maxSize"], "resizeable": app_main["resizeable"],
                                        "kwinFixed": kwin_fixed, "expectedMinFrame": want_min,
                                        "learnedMin": exp.get("learnedMin"), "learnedMax": exp.get("learnedMax"),
                                        "effective": eff}
                errs_log = s.log_lines(ERR_RX, off)
                c(f"{app.name}: no plastile error/warn or JS exceptions", not errs_log, errs_log[:3])
                result["logErrors"] = len(errs_log)
            finally:
                # Kill the app's whole process group (we created it with start_new_session), then every other
                # process of this session that is not infrastructure (helpers, D-Bus-activated services).
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except OSError:
                    pass
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except OSError:
                        pass
                    proc.wait(timeout=5)
                rec("killed", exit=proc.returncode)
                # Spare KWin's and the private bus's own children (Xwayland, activated services): they are
                # torn down with the session and swept, if they survive it, after stop.
                result["sweptBeforeStop"] = sweep(run_dir, descendants_of(infra))
                rec("swept", procs=result["sweptBeforeStop"])
            try:
                s.wait_for(lambda: all(w["appId"] == FIX for w in all_windows(s)), 20, "app windows gone")
                gone = True
            except NestedError:
                gone = False
            c(f"{app.name}: all app windows gone after kill", gone, [label(w) for w in all_windows(s) if w["appId"] != FIX])
            s.settle(timeout=6.0)
            f = s.frames_list()
            c(f"{app.name}: fixtures retiled to two full-height tiles after close",
              len(f) == 2 and not tiling_errors(f, area, 8) and all(x["frame"]["height"] > area["height"] - 20 for x in f),
              [x["frame"] for x in f])
            c(f"{app.name}: fixtures back at the baseline slots", all(abs(x["frame"]["x"] - base_frames[x["caption"]]["x"]) <= 1
                                                                      and abs(x["frame"]["width"] - base_frames[x["caption"]]["width"]) <= 1
                                                                      for x in f), [x["frame"] for x in f])
            final_errs = s.log_lines(ERR_RX, off)
            c(f"{app.name}: no errors through close", not final_errs, final_errs[:3])
            result["logErrorsTotal"] = len(final_errs)
    finally:
        # After KWin, XWayland and the private bus are gone, nothing of this session may remain.
        result["sweptAfterStop"] = sweep(run_dir, set())
        time.sleep(0.5)
        left = session_procs(run_dir, set())
        c(f"{app.name}: no process of the session survives teardown", not left, [n for _, n in left])
        finish()


GTK = {"GDK_BACKEND": "wayland"}
APPS = [
    App("dolphin", "dolphin", ["dolphin"], ("org.kde.dolphin", "dolphin")),
    # systemsettings reports minSize 930x650 (client): a stack column of two on a 1280x800 output
    # cannot hold it, so the expected result is an explained overflow float; on 1920x1200 it tiles.
    App("systemsettings", "systemsettings", ["systemsettings"], ("systemsettings", "org.kde.systemsettings"), expect="overflow"),
    App("systemsettings-tall", "systemsettings", ["systemsettings"], ("systemsettings", "org.kde.systemsettings"),
        width=1920, height=1200, expect="tiled"),
    # gnome-calculator (GTK4/libadwaita, CSD) reports minSize 360x616: same overflow case at 800 px height.
    App("gnome-calculator", "gnome-calculator", ["gnome-calculator"], ("org.gnome.Calculator", "gnome-calculator"),
        env=GTK, expect="overflow"),
    App("gnome-calculator-tall", "gnome-calculator", ["gnome-calculator"], ("org.gnome.Calculator", "gnome-calculator"),
        env=GTK, width=1920, height=1200, expect="tiled"),
    # The same GTK4 client over XWayland: CSD with _GTK_FRAME_EXTENTS, so KWin's clientGeometry includes the
    # shadow and is larger than frameGeometry; exercises Plastile's client->frame constraint conversion.
    App("gnome-calculator-x11-tall", "gnome-calculator", ["gnome-calculator"], ("org.gnome.Calculator", "gnome-calculator"),
        env={"GDK_BACKEND": "x11"}, xwayland=True, width=1920, height=1200, expect="tiled"),
    App("alacritty", "alacritty", ["alacritty"], ("Alacritty", "alacritty"), expect="tiled"),
    App("firefox", "firefox", ["firefox", "--no-remote", "--new-instance", "--profile", "{root}/home/ffprofile", "about:blank"],
        ("firefox", "org.mozilla.firefox", "Firefox"), env={"MOZ_ENABLE_WAYLAND": "1"}, map_timeout=40.0, expect="tiled"),
    App("chromium", "chromium", ["chromium", "--ozone-platform=wayland", "--user-data-dir={root}/home/chromium", "--no-first-run",
                                 "--disable-gpu", "--no-default-browser-check", "about:blank"],
        ("chromium", "Chromium", "chromium-browser"), map_timeout=40.0, expect="tiled"),
    # XWayland client: the expectation follows the client's own WM_NORMAL_HINTS (read with xprop).
    App("xmessage", "xmessage", ["xmessage", "-center", "plastile xmessage fixture"], ("Xmessage", "xmessage"),
        xwayland=True, note="task expected fixed-size float; expectation derived from the client's hints instead"),
    # kdialog is not installed here; zenity (GTK4) message boxes are the stand-in dialog clients.
    App("zenity-info", "zenity", ["zenity", "--info", "--text=plastile zenity fixture"], ("zenity", "org.gnome.Zenity"),
        env=GTK, note="stand-in for kdialog --msgbox (Wayland xdg_toplevel without parent)"),
    App("zenity-info-x11", "zenity", ["zenity", "--info", "--text=plastile zenity fixture"], ("zenity", "Zenity", "org.gnome.Zenity"),
        env={"GDK_BACKEND": "x11"}, xwayland=True, note="stand-in for kdialog --msgbox (X11 client, EWMH window type)"),
    # Candidates from the task list that may not be installed; registered only when present.
    App("kdialog", "kdialog", ["kdialog", "--msgbox", "plastile kdialog fixture"], ("kdialog", "org.kde.kdialog"), expect="floating"),
    App("kcalc", "kcalc", ["kcalc"], ("org.kde.kcalc", "kcalc")),
    App("konsole", "konsole", ["konsole"], ("org.kde.konsole", "konsole")),
    App("kate", "kate", ["kate", "-n"], ("org.kde.kate", "kate")),
    App("kwrite", "kwrite", ["kwrite"], ("org.kde.kwrite", "kwrite")),
    App("gwenview", "gwenview", ["gwenview"], ("org.kde.gwenview", "gwenview")),
    App("okular", "okular", ["okular"], ("org.kde.okular", "okular")),
    App("gtk4-demo", "gtk4-demo", ["gtk4-demo"], ("org.gtk.Demo4", "gtk4-demo"), env=GTK),
    App("foot", "foot", ["foot"], ("foot",)),
]
CHECKED = ("konsole", "kate", "kwrite", "dolphin", "kcalc", "gwenview", "okular", "systemsettings", "kdialog", "xmessage",
           "gtk4-demo", "gnome-calculator", "foot", "alacritty", "firefox", "chromium")


def _make(app: App):
    @scenario(f"realapps-{app.name}")
    def _run(out: Path, c: Checks):
        run_app(app, out, c)
    return _run


for _app in APPS:
    if shutil.which(_app.binary):
        _make(_app)


def evidence(run_dirs: list[Path], dest: Path, notes: list[str] | None = None) -> dict:
    """Committed summary: app ids, versions, kinds, modes, counters and check results; no titles or home paths."""
    apps: dict = {}
    meta: dict = {}
    for rd in sorted(run_dirs, key=lambda p: p.name):  # the latest run's details win; every run is kept in "runs"
        rep = json.loads((rd / "report.json").read_text())
        meta = {k: rep.get(k) for k in ("implementationCommit", "implementationDirty", "kwin", "layer")}
        for name, sc in rep["scenarios"].items():
            if not name.startswith("realapps-"):
                continue
            rp = rd / name / "result.json"
            r = json.loads(rp.read_text()) if rp.exists() else {}
            win = next((w for w in r.get("windows", []) if w.get("main")), None)
            history = (apps.get(name) or {}).get("runs", []) + [{"run": rd.name, "pass": sc["pass"],
                                                                 "failed": sorted(k for k, v in sc["checks"].items() if not v["pass"])}]
            apps[name] = {"runs": history,
                "run": rd.name, "pass": sc["pass"], "error": (sc["error"] or "").strip().splitlines()[-1:] or None,
                "seconds": sc["seconds"], "version": r.get("version"), "xwayland": r.get("xwayland"), "output": r.get("output"),
                "expect": r.get("expect"), "note": r.get("note") or None, "x11": r.get("x11"), "mapTimeSeconds": r.get("mapTimeSeconds"),
                "resourceClass": (win or {}).get("appId"), "desktopFileName": (win or {}).get("desktopFileName"),
                "kind": r.get("kind"), "mustFloat": r.get("mustFloat"), "x11Hints": r.get("x11Hints"),
                "finalMode": (r.get("explain") or {}).get("mode"), "decision": (r.get("explain") or {}).get("decision"),
                "exception": (r.get("explain") or {}).get("exception"), "constraint": r.get("constraint"),
                "frame": (win or {}).get("frame"), "counters": r.get("counters"),
                "extraWindows": [{k: w.get(k) for k in ("appId", *KIND_KEYS)} for w in r.get("windows", []) if not w.get("main")],
                "logErrorsTotal": r.get("logErrorsTotal"), "sweptBeforeStop": r.get("sweptBeforeStop"),
                "sweptAfterStop": r.get("sweptAfterStop"),
                "checks": {k: v["pass"] for k, v in sc["checks"].items()},
                "failedChecks": {k: v["detail"] for k, v in sc["checks"].items() if not v["pass"]},
            }
    installed = {b: package_version(b) for b in CHECKED}
    doc = {"what": "TEST_MATRIX section 4: representative real applications in a nested KWin with two fixture windows",
           "layer": "nested KWin virtual backend; not a physical session", **meta,
           "judgement": "geometry by the KWin oracle (one-shot scripts); Plastile counters only for work amounts",
           "candidates": {b: (v or "not installed") for b, v in installed.items()},
           "notes": notes or [], "apps": apps,
           "summary": {"scenarios": len(apps), "passedLatest": sum(1 for a in apps.values() if a["pass"]),
                       "runs": sorted({rd.name for rd in run_dirs})}}
    text = json.dumps(doc, indent=1)
    for secret in (str(Path.home()), os.environ.get("USER", "\0")):
        text = text.replace(secret, "<redacted>")
    dest.write_text(text + "\n")
    return doc


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--evidence", nargs="+", required=True, help="artifacts/integration/<stamp> directories")
    ap.add_argument("--out", default=str(ROOT / "docs/status/evidence/realapps-nested.json"))
    ap.add_argument("--note", action="append", default=[])
    a = ap.parse_args()
    d = evidence([Path(p) for p in a.evidence], Path(a.out), a.note)
    print(json.dumps(d["summary"]))
    sys.exit(0)
