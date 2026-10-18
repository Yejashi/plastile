"""Configuration scenarios (T25, T26, T28, D9; TEST_MATRIX Q02, Q04, Q08).

Geometry comes from the independent oracle (one-shot KWin scripts reading frameGeometry).
Plastile's log is read only for what it reports about itself (explanations, the shortcut
report, lifecycle markers) and its counters only for work amounts; neither is used as a
geometry claim.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

from harness import Input, Session, delta, evidence_file, near, tiling_errors, steady_connections
from scenarios import Checks, Skipped, scenario
from scenarios_classify import brief, explain, rejected

GAP = 8
INSPECTOR = "Plastile inspector"  # adapter.ts OWN_UI_TITLE
KEY_ESC = 1

# Single-line JSON without backslashes: written verbatim into kwinrc, so no KConfig escaping applies.
CONTEXT_RULES = json.dumps({"schemaVersion": 1, "rules": [
    {"id": "notes-floats", "match": {"desktopName": "Notes"}, "actions": {"mode": "floating"}},
    {"id": "second-output-floats", "match": {"outputName": "Virtual-1"}, "actions": {"mode": "floating"}},
    {"id": "wide-two", "match": {"title": "plastile-fixture 2"}, "actions": {"minSize": {"width": 760}}},
]}, separators=(",", ":"))


def full(a: dict) -> dict:
    return {"x": a["x"] + GAP, "y": a["y"] + GAP, "width": a["width"] - 2 * GAP, "height": a["height"] - 2 * GAP}


def no_errors(s: Session) -> tuple[bool, list[str]]:
    warn = s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError")
    return s.counters()["counters"]["errors"] == 0 and not warn, warn[:3]


@scenario("rules-context-T25")
def rules_context(out: Path, c: Checks):
    """Rules matching desktop name, output and title (minSize): applied, re-evaluated on membership and rename."""
    with Session(out, outputs=2, config={"configJson": CONTEXT_RULES}) as s:
        s.js("workspace.createDesktop(1, 'Notes'); emit(1);")
        for i in (1, 2, 3):
            s.spawn(i)
        s.load()
        s.settle()
        c("configuration accepted (no rejection/warnings)", not rejected(s), rejected(s))
        a0, a1 = s.area(0), s.area(1)
        f = s.frames()
        tiles = [f[f"plastile-fixture {i}"] for i in (1, 2, 3)]
        c("adopt: three tiles on Virtual-0, no overlap (oracle)", not tiling_errors(tiles, a0, GAP), tiling_errors(tiles, a0, GAP))
        w2 = f["plastile-fixture 2"]["frame"]["width"]
        c("minSize rule: fixture 2's tile is at least 760 px wide (oracle)", w2 >= 760, f["plastile-fixture 2"]["frame"])
        e2 = explain(s, "plastile-fixture 2")
        c("explain names the minSize action and its rule", (e2.get("rules") or {}).get("actions", {}).get("minSize") == "760x0"
          and (e2.get("rules") or {}).get("reasons", {}).get("minSize") == "rule wide-two", e2.get("rules"))

        # Membership change: fixture 3 moves to the desktop named Notes, where a rule floats it.
        s.act("plastile-fixture 3", "w.desktops = [workspace.desktops[1]]")
        time.sleep(0.3)
        s.settle()
        f = s.frames()
        left = [f["plastile-fixture 1"], f["plastile-fixture 2"]]
        c("desktop 1 reflows to two tiles after the move (oracle)", not tiling_errors(left, a0, GAP)
          and abs(sum(x["frame"]["width"] for x in left) - (a0["width"] - 3 * GAP)) <= 2, [x["frame"] for x in left])
        before = f["plastile-fixture 3"]["frame"]
        s.js("workspace.currentDesktop = workspace.desktops[1]; emit(1);")
        time.sleep(0.4)
        s.settle()
        f = s.frames()
        c("on Notes fixture 3 floats: Plastile did not tile it (frame unchanged, not the full area; oracle)",
          near(f["plastile-fixture 3"]["frame"], before, 1.0) and not near(f["plastile-fixture 3"]["frame"], full(a0), 2.0),
          {"before": before, "after": f["plastile-fixture 3"]["frame"]})
        e3 = explain(s, "plastile-fixture 3")
        c("explain: floating by rule notes-floats", e3.get("mode") == "floating"
          and (e3.get("decision") or {}).get("ruleIds") == ["notes-floats"], brief(e3))

        # Rename: the desktop no longer matches; the window tiles alone on it.
        s.js("workspace.desktops[1].name = 'Two'; emit(1);")
        time.sleep(0.4)
        s.settle()
        f = s.frames()
        c("after renaming Notes to Two, fixture 3 tiles the full area (oracle)",
          near(f["plastile-fixture 3"]["frame"], full(a0), 1.0), f["plastile-fixture 3"]["frame"])

        # Output rule: fixture 1 sent to Virtual-1 floats there; fixture 2 fills Virtual-0.
        s.js("workspace.currentDesktop = workspace.desktops[0]; emit(1);")
        time.sleep(0.3)
        s.act("plastile-fixture 1", "workspace.sendClientToScreen(w, workspace.screens[1])")
        time.sleep(0.5)
        s.settle()
        f = s.frames()
        on1 = f["plastile-fixture 1"]
        c("fixture 1 is on Virtual-1 and not tiled there (oracle)", on1["output"] == "Virtual-1"
          and not near(on1["frame"], full(a1), 2.0), on1)
        c("fixture 2 alone fills Virtual-0 (oracle)", near(f["plastile-fixture 2"]["frame"], full(a0), 1.0),
          f["plastile-fixture 2"]["frame"])
        e1 = explain(s, "plastile-fixture 1")
        c("explain: floating by rule second-output-floats", e1.get("mode") == "floating"
          and (e1.get("decision") or {}).get("ruleIds") == ["second-output-floats"], brief(e1))
        ok, warn = no_errors(s)
        c("no model errors or JS exceptions", ok, warn)


# ------------------------------------------------------------------ D9 / Q04
def kwriteconfig(s: Session, key: str, value: str) -> None:
    """Change [Script-plastile] the way the settings dialog does: kwinrc only, no change notification."""
    r = subprocess.run(["kwriteconfig6", "--file", "kwinrc", "--group", "Script-plastile", "--key", key, value],
                       env=s.kw.env(), capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        raise RuntimeError(f"kwriteconfig6 failed: {r.stderr.strip()}")


def inner_gap(s: Session) -> float:
    f = s.frames()
    a, b = sorted((f["plastile-fixture 1"]["frame"], f["plastile-fixture 2"]["frame"]), key=lambda r: r["x"])
    return b["x"] - (a["x"] + a["width"])


@scenario("reload-config-D9-Q04")
def reload_config(out: Path, c: Checks):
    """Reload configuration after a dialog-style kwinrc write; a storm of reloads: one engine, one activation."""
    import release
    from scenarios_package import STARTED, PackagedSession
    zip_path = Path(release.build(out / "dist")["path"])
    ev: dict = {}
    with PackagedSession(out, zip_path) as s:
        # Autoloaded from the installed, enabled package: KWin's reconfigure also runs
        # Scripting::start, which must not load it a second time.
        s.kw.wait_log(STARTED, 30, 0)
        s.spawn(1); s.spawn(2)
        base = s.settle()
        names0 = len(s.kw.shortcut_names())
        c("setup: default inner gap 8 (oracle)", abs(inner_gap(s) - 8) <= 0.5, inner_gap(s))

        kwriteconfig(s, "gapInner", "20")
        off = s.kw.mark()
        t0 = time.monotonic()
        s.cmd("runtime.reload-config")
        try:
            s.kw.wait_log(r"plastile info configuration activated", 5, off)
            activated_after = round(time.monotonic() - t0, 3)
        except Exception:  # noqa: BLE001
            activated_after = None
        time.sleep(0.6)
        s.settle()
        acts = s.log_lines(r"plastile info configuration activated", off)
        ev["single"] = {"activatedAfterS": activated_after, "activations": len(acts), "gap": inner_gap(s)}
        c("D9: after a kwinrc write without notification, one reload command activates the new gap 20 (oracle)",
          abs(inner_gap(s) - 20) <= 0.5, ev["single"])
        c("D9: exactly one activation for one reload", len(acts) == 1, acts)
        c("D9: the command asked KWin to reconfigure (logged request)",
          bool(s.log_lines(r"plastile info configuration reload requested", off)), None)

        kwriteconfig(s, "gapInner", "12")
        off = s.kw.mark()
        t0 = time.monotonic()
        for _ in range(20):
            s.cmd("runtime.reload-config")
        storm_s = round(time.monotonic() - t0, 3)
        time.sleep(1.2)
        cc = s.settle()
        acts = s.log_lines(r"plastile info configuration activated", off)
        started = s.log_lines(STARTED, 0)
        stopped = s.log_lines(r"plastile info stopped", 0)
        names1 = len(s.kw.shortcut_names())
        ev["storm"] = {"requests": 20, "sendSeconds": storm_s, "activations": len(acts), "gap": inner_gap(s),
                       "started": len(started), "stopped": len(stopped),
                       "connections": [base["connections"], cc["connections"]],
                       "transientConnections": [base.get("transientConnections"), cc.get("transientConnections")],
                       "steadyConnections": [steady_connections(base), steady_connections(cc)],
                       "windows": [base["windows"], cc["windows"]], "shortcutNames": [names0, names1]}
        c("Q04: 20 rapid reloads activate the new gap 12 once (oracle + one activation)",
          abs(inner_gap(s) - 12) <= 0.5 and len(acts) == 1, ev["storm"])
        c("Q04: one engine: started once, never stopped, script still loaded", len(started) == 1 and not stopped
          and s.kw.is_loaded("plastile"), ev["storm"])
        c("Q04: connection and window counts unchanged, one shortcut per command",
          steady_connections(cc) == steady_connections(base) and cc["windows"] == base["windows"] and names0 == names1, ev["storm"])
        ok, warn = no_errors(s)
        c("no model errors or JS exceptions", ok, warn)
    evidence_file("reload-config-D9-Q04.json").write_text(json.dumps(ev, indent=1) + "\n")


# ------------------------------------------------------------------ T26 / Q08
PREBOUND = "[kwin]\nWindow Maximize=Meta+Shift+H,Meta+PgUp,Maximize Window\n"


def shortcut_entry(s: Session, action: str) -> str | None:
    rc = s.kw.root / "config/kglobalshortcutsrc"
    if not rc.exists():
        return None
    group = ""
    for line in rc.read_text().splitlines():
        if line.startswith("["):
            group = line.strip("[]")
        elif group == "kwin" and line.startswith(action + "="):
            return line.split("=", 1)[1]
    return None


def no_errors_except(s: Session, allowed: str) -> tuple[bool, list[str]]:
    warn = [ln for ln in s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError") if not re.search(allowed, ln)]
    return s.counters()["counters"]["errors"] == 0 and not warn, warn[:3]


@scenario("shortcuts-conflict-Q08")
def shortcuts_conflict(out: Path, c: Checks):
    """A user binding on a Plastile default key is reported (log, counters, explain) and left in place."""
    ev: dict = {}
    s = Session(out / "prebound", config={"diagnostics": "debug"})
    s.kw.prepare = lambda kw: (kw.root / "config/kglobalshortcutsrc").write_text(PREBOUND)
    with s:
        s.spawn(1); s.spawn(2)
        off = s.kw.mark()
        s.load()
        try:
            line = s.kw.wait_log(r"plastile warn shortcut conflicts: ", 5, off)[-1]
        except Exception:  # noqa: BLE001
            line = ""
        ev["log"] = line.split("plastile ", 1)[-1] if line else None
        c("T26: startup reports the conflict in one warning naming the key and both actions",
          "Meta+Shift+H" in line and "Focus left" in line and "Maximize Window" in line, ev["log"])
        s.settle()
        cz = s.counters()
        c("T26: counters expose the report (done, one conflict)", cz.get("shortcuts") == {"state": "done", "conflicts": 1},
          cz.get("shortcuts"))
        e = explain(s, "plastile-fixture 1")
        sc = e.get("shortcutConflicts") or []
        c("T26: explain output carries the conflict (key, command, other action)",
          len(sc) == 1 and sc[0].get("key") == "Meta+Shift+H" and sc[0].get("command") == "plastile.focus.left"
          and [o.get("action") for o in sc[0].get("others", [])] == ["Window Maximize"], sc)
        s.cmd("inspect.explain-window")  # close the inspector the explain opened
        held = shortcut_entry(s, "Window Maximize")
        mine = shortcut_entry(s, "plastile.focus.left")
        ev["registry"] = {"Window Maximize": held, "plastile.focus.left": mine}
        c("Q08: the user's binding is preserved (Window Maximize keeps Meta+Shift+H)",
          held is not None and held.split(",")[0].split("\t")[0] == "Meta+Shift+H", ev["registry"])
        # Which action KGlobalAccel runs for the shared key (recorded, not asserted).
        try:
            inp = Input(s)
            try:
                s.act("plastile-fixture 1", "workspace.activeWindow = w")
                off = s.kw.mark()
                inp.do("key 125 down", "key 42 down", "key 35 down", "key 35 up", "key 42 up", "key 125 up")
                time.sleep(0.6)
                ev["pressMetaShiftH"] = {
                    "plastileDispatched": bool(s.log_lines(r'plastile debug command \{"command":"plastile.focus.left"', off)),
                    "fixture1MaximizeMode": s.frames()["plastile-fixture 1"]["maximizeMode"]}
            finally:
                inp.close()
        except Exception as exc:  # noqa: BLE001
            ev["pressMetaShiftH"] = f"not measured: {exc}"
        ok, warn = no_errors_except(s, r"shortcut conflicts")
        c("no model errors or JS exceptions", ok, warn)
    with Session(out / "control") as s:
        off = s.kw.mark()
        s.load()
        try:
            ctrl = s.kw.wait_log(r"plastile info shortcut check: no conflicts", 5, off)[-1]
        except Exception:  # noqa: BLE001
            ctrl = ""
        ev["control"] = ctrl.split("plastile ", 1)[-1] if ctrl else None
        c("control: without the user binding the check reports no conflicts", bool(ctrl), ev["control"])
    evidence_file("shortcuts-conflict-Q08.json").write_text(json.dumps(ev, indent=1) + "\n")


# ------------------------------------------------------------------ T28
def own_windows(s: Session) -> list[dict]:
    out = s.js(f"emit(workspace.windowList().filter(w => w.caption === {json.dumps(INSPECTOR)}).map(w => ("
               "{id: String(w.internalId), popup: w.popupWindow, appId: w.resourceClass, pid: w.pid,"
               " frame: {x: w.frameGeometry.x, y: w.frameGeometry.y, width: w.frameGeometry.width,"
               " height: w.frameGeometry.height}})));")
    return json.loads(out[0])


def trace_modes(s: Session, wid: str) -> list[dict]:
    off = s.kw.mark()
    s.cmd("inspect.dump-trace")
    line = s.kw.wait_log(r"plastile trace ", 5, off)[-1]
    return [r.get("data") for r in json.loads(line.split("plastile trace ", 1)[1])
            if r.get("kind") == "mode" and r.get("id") == wid]


@scenario("inspector-T28")
def inspector(out: Path, c: Checks):
    """The explain view opens only on its command, is excluded from tiling, closes on Escape/command/unload."""
    with Session(out) as s:
        s.spawn(1); s.spawn(2)
        s.load()
        s.settle()
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        for cmd in ("focus.next", "resize.grow", "resize.shrink", "focus.previous"):
            s.cmd(cmd)
        s.settle()
        c("keyboard-only use: no inspector window exists",
          own_windows(s) == [] and s.counters().get("inspectorOpen") is False, own_windows(s))

        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        f0 = s.frames()
        c0 = s.counters()
        s.cmd("inspect.explain-window")
        try:
            s.wait_for(lambda: own_windows(s) != [], 5, "inspector window")
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.4)
        wins = own_windows(s)
        c1 = s.settle()
        c("explain opens one inspector window (oracle: KWin's window list)",
          len(wins) == 1 and c1.get("inspectorOpen") is True, wins)
        if wins:
            modes = trace_modes(s, wins[0]["id"])
            c("the inspector is classified as Plastile's own UI and excluded",
              bool(modes) and all(m.get("mode") == "excluded" and m.get("source") == "builtin" for m in modes), modes)
        d = delta(c0, c1)
        c("opening the inspector solved nothing and wrote no geometry (counters)",
          d.get("solves", 0) == 0 and d.get("writes", 0) == 0, d)
        f1 = s.frames()
        c("tiles unchanged while the inspector is open (oracle)",
          all(near(f0[k]["frame"], f1[k]["frame"], 0.5) for k in f0), {k: f1[k]["frame"] for k in f1})
        ui = s.log_lines(r"Inspector\.qml|main\.qml.*(rror|arning)")
        c("no QML warnings from the inspector", not ui, ui[:3])

        escape_note = ""
        try:
            inp = Input(s)
        except Exception as exc:  # noqa: BLE001
            inp = None
            escape_note = f"libei unavailable: {exc}"
        if inp is not None:
            try:
                inp.do(f"key {KEY_ESC} down", f"key {KEY_ESC} up")
                time.sleep(0.5)
                c("Escape closes and destroys the inspector (oracle)",
                  own_windows(s) == [] and s.counters().get("inspectorOpen") is False, own_windows(s))
                # A global shortcut pressed while the popup holds the keyboard still reaches Plastile
                # (focus next: Meta+Shift+N); the activation it causes closes the inspector.
                s.act("plastile-fixture 1", "workspace.activeWindow = w")
                s.cmd("inspect.explain-window")
                s.wait_for(lambda: own_windows(s) != [], 5, "inspector window")
                inp.do("key 125 down", "key 42 down", "key 49 down", "key 49 up", "key 42 up", "key 125 up")
                time.sleep(0.5)
                active = [k for k, v in s.frames().items() if v["active"]]
                c("a real Plastile key press works while the inspector is open, and the activation closes it (oracle)",
                  active == ["plastile-fixture 2"] and own_windows(s) == [], {"active": active, "inspector": own_windows(s)})
                # A click outside the inspector closes it (KWin's popup filter).
                s.cmd("inspect.explain-window")
                s.wait_for(lambda: own_windows(s) != [], 5, "inspector window")
                inp.do("move 40 760", "press left", "release left")
                time.sleep(0.5)
                c("a click elsewhere closes the inspector (oracle)", own_windows(s) == [], own_windows(s))
            finally:
                inp.close()

        s.cmd("inspect.explain-window")
        time.sleep(0.5)
        opened = len(own_windows(s)) == 1
        s.cmd("inspect.explain-window")
        time.sleep(0.5)
        c("the command toggles: a second explain closes it (oracle)", opened and own_windows(s) == [], opened)

        s.cmd("inspect.explain-window")
        time.sleep(0.5)
        reopened = len(own_windows(s)) == 1
        s.unload()
        time.sleep(0.4)
        c("unload removes an open inspector (oracle)", reopened and own_windows(s) == [], reopened)
        warn = s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError|Inspector\.qml")
        c("no errors, warnings or JS exceptions", not warn, warn[:3])
        if inp is None:
            raise Skipped(f"Escape check not run: {escape_note}")
