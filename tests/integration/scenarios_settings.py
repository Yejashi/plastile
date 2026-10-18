"""Settings dialog scenarios (T28, ADR-019): KWin's real script settings dialog, driven with real input.

`settings-dialog-T28` opens the dialog the way System Settings does: the KWin Scripts KCM
(`kcm_kwin_scripts`, hosted by kcmshell6) lists the package installed in the session's private
data home, and its per-script *Configure…* button opens a KCMultiDialog with the config module that
Plastile's metadata.json names (`X-KDE-ConfigModule`, KWin's generic scripted config, which loads
contents/ui/config.ui bound to contents/config/main.xml). Every change is made with real pointer and
key events through KWin's EIS endpoint (libei, tools/input). AT-SPI is used read-only, to find where
a widget is and what it shows; no AT-SPI action or value setter is ever called. The oracles are the
session's private kwinrc, the runtime's own flat-key parser (src/config/schema.ts, through node), and
KWin's frames for the two fixtures (the dialog windows sit on their own virtual desktop, where
Plastile tiles them like any application).

`settings-keyboard-only-inspector-T28` presses every default binding with real key events and
counts Plastile's own windows through KWin: keyboard-only use must never instantiate the inspector
(main.qml's Loader stays inactive).

Layer: nested KWin (virtual backend). The dialog is the installed KCM and config module, run inside
the nested session (private bus, XDG tree and kwinrc); it is not a physical session.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from harness import ROOT, Input, Session, evidence_file, tiling_errors
from scenarios import Checks, Skipped, scenario
from scenarios_package import STARTED, installed_dir, kwinrc_text, sh
from scenarios_shortcuts import codes, defaults

sys.path.insert(0, str(ROOT / "tools"))
from nested import NestedKwin  # noqa: E402
import sysinfo  # noqa: E402

GAP = 8
KCM = "kcm_kwin_scripts"
SCRIPTS_WINDOW = "KWin Scripts"  # the KCM's window caption and its AT-SPI window name
DIALOG = "Configure"             # KCMultiDialog's caption
ATSPI_TREE = Path(__file__).resolve().parent / "atspi_tree.py"
REGISTRYD = sysinfo.find_helper("at-spi2-registryd")
ACTIVATED = r"plastile info configuration activated"
RELOAD_REQUESTED = r"plastile info configuration reload requested"
OWN_UI = ("Plastile inspector", "Plastile zones")  # adapter.ts isOwnUi captions
# linux/input-event-codes.h
KEY_LEFTCTRL, KEY_A, KEY_DOWN, KEY_ENTER = 29, 30, 108, 28
DIGITS = {str(d): (11 if d == 0 else d + 1) for d in range(10)}
# The dialog's own environment: system defaults only (the user's kdedefaults, icon theme and colour
# scheme must not reach the nested session) and a fixed language for the widget names.
SESSION_ENV = {"XDG_CONFIG_DIRS": "/etc/xdg", "XDG_DATA_DIRS": "/usr/local/share:/usr/share"}
DIALOG_ENV = {"LANGUAGE": "C", "LC_ALL": "C.UTF-8", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON": "1"}
# Observation window for "nothing happened" checks: KWin's reconfigure timer is 200 ms and Plastile's
# activation follows on its configChanged, so a reload caused by an action would land well within it.
QUIET_S = 1.5


def requirements() -> list[str]:
    missing = []
    if not shutil.which("kcmshell6"):
        missing.append("kcmshell6")
    if REGISTRYD is None:
        missing.append("at-spi2-registryd")
    try:
        import gi
        gi.require_version("Atspi", "2.0")
    except (ImportError, ValueError):
        missing.append("AT-SPI Python bindings (gi Atspi 2.0)")
    if not shutil.which("node"):
        missing.append("node (the runtime's flat-key parser)")
    if not Path(ROOT / "build/input/plastile-input").exists():
        missing.append("build/input/plastile-input")
    return missing


class SettingsSession(Session):
    """Plastile installed into the private data home and autoloaded (as a user has it), two fixtures."""

    def __init__(self, out: Path, zip_path: Path):
        super().__init__(out)
        self.zip_path = zip_path
        self.prepare_result: dict | None = None
        self.kw = NestedKwin(out, kwinrc=kwinrc_text(True), prepare=self._prepare, extra_env=SESSION_ENV,
                             dbus_services=self.kw.dbus_services)

    def _prepare(self, kw: NestedKwin) -> None:
        self.prepare_result = sh(kw, "install", str(self.zip_path))

    def dialog_env(self) -> dict:
        # AT-SPI on the session's private bus: Qt's bridge, the registry and the reader all honour
        # AT_SPI_BUS_ADDRESS, so no accessibility bus launcher (or systemd unit) is involved.
        return {**self.kw.client_env(), **DIALOG_ENV, "AT_SPI_BUS_ADDRESS": self.kw.bus_address}

    def start_owned(self, argv: list[str], log: str) -> subprocess.Popen:
        proc = subprocess.Popen(argv, env=self.dialog_env(), stdout=open(self.out / log, "w"), stderr=subprocess.STDOUT)
        self.kw._clients.append(proc)  # terminated by NestedKwin.stop()
        return proc


# ------------------------------------------------------------------ observation helpers
def kwinrc_bytes(s: Session) -> bytes:
    path = s.kw.root / "config/kwinrc"
    return path.read_bytes() if path.exists() else b""


def groups(text: str) -> dict[str, dict[str, str]]:
    """KConfig groups of a kwinrc (plain keys; Plastile's values need no unescaping)."""
    out: dict[str, dict[str, str]] = {}
    cur = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("[") and line.endswith("]"):
            cur = out.setdefault(line[1:-1], {})
        elif cur is not None and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            cur[k.strip()] = v
    return out


def runtime_parse(flat: dict[str, str]) -> dict:
    """The runtime's own reader of [Script-plastile] (src/config/schema.ts readFlat), run by node."""
    code = ("import { readFlat } from " + json.dumps(str(ROOT / "src/config/schema.ts")) + ";\n"
            "import { sink } from " + json.dumps(str(ROOT / "src/config/validate.ts")) + ";\n"
            "const s = sink(); const r = readFlat(s, JSON.parse(process.argv[1]));\n"
            "console.log(JSON.stringify({errors: s.errors, warnings: s.warnings, patch: r.patch,"
            " diagnostics: r.diagnostics, json: r.json}));\n")
    r = subprocess.run(["node", "--input-type=module", "-e", code, json.dumps(flat)], capture_output=True, text=True,
                       timeout=30)
    if r.returncode != 0:
        return {"error": r.stderr.strip()[-400:]}
    return json.loads(r.stdout)


def windows_of(s: Session, pid: int) -> list[dict]:
    out = s.js(f"emit(workspace.windowList().filter(w => w.pid === {pid}).map(w => ({{caption: w.caption,"
               " popup: w.popupWindow, desktops: w.desktops.map(d => d.id),"
               " client: {x: w.clientGeometry.x, y: w.clientGeometry.y, width: w.clientGeometry.width,"
               " height: w.clientGeometry.height},"
               " frame: {x: w.frameGeometry.x, y: w.frameGeometry.y, width: w.frameGeometry.width,"
               " height: w.frameGeometry.height}})));")
    return json.loads(out[0])


def kcm_frames(s: Session, pid: int) -> dict[str, dict]:
    return {w["caption"]: w["frame"] for w in windows_of(s, pid) if not w["popup"]}


def own_ui(s: Session) -> list[dict]:
    """Plastile's own windows as KWin lists them (its internal QML windows have no client process)."""
    out = s.js(f"emit(workspace.windowList().filter(w => {json.dumps(list(OWN_UI))}.indexOf(String(w.caption)) >= 0)"
               ".map(w => ({caption: w.caption, pid: w.pid, appId: w.resourceClass})));")
    return json.loads(out[0])


def internal_windows(s: Session) -> list[str]:
    """Every window without a client process (KWin's and scripts' own QML windows)."""
    out = s.js("emit(workspace.windowList().filter(w => !(w.pid > 0)).map(w => String(w.caption)));")
    return json.loads(out[0])


def until(pred, timeout: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if pred():
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.05)
    return False


def two_fixtures(s: Session) -> dict:
    f = s.frames()
    a, b = sorted((f["plastile-fixture 1"]["frame"], f["plastile-fixture 2"]["frame"]), key=lambda r: r["x"])
    return {"left": a, "right": b, "gap": b["x"] - (a["x"] + a["width"]), "widths": [a["width"], b["width"]],
            "errors": tiling_errors([f["plastile-fixture 1"], f["plastile-fixture 2"]], s.area(), GAP)}


def fixtures_desktop(s: Session) -> dict:
    """The fixtures' tiles, read on their own desktop: Plastile solves a hidden context when it is shown,
    so the first desktop is shown for the reading and the settings desktop again afterwards."""
    s.js("workspace.currentDesktop = workspace.desktops[0]; emit(1);")
    s.settle()
    res = two_fixtures(s)
    s.js("workspace.currentDesktop = workspace.desktops[1]; emit(1);")
    s.settle()
    return res


# ------------------------------------------------------------------ the dialog through AT-SPI and real input
class Dialogs:
    """The KCM process: AT-SPI reads (read-only) and libei clicks/keys at KWin's window positions."""

    def __init__(self, s: SettingsSession, inp: Input, kcm: subprocess.Popen):
        self.s, self.inp, self.kcm = s, inp, kcm

    def tree(self, window: str) -> list[dict] | None:
        r = subprocess.run([sys.executable, "-I", str(ATSPI_TREE), str(self.kcm.pid), window], env=self.s.dialog_env(),
                           capture_output=True, text=True, timeout=30)
        try:
            data = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            return None
        return data if isinstance(data, list) else None

    def window(self, caption: str) -> dict | None:
        return next((w for w in windows_of(self.s, self.kcm.pid) if w["caption"] == caption and not w["popup"]), None)

    def popups(self) -> list[dict]:
        return [w for w in windows_of(self.s, self.kcm.pid) if w["popup"]]

    def stable(self, caption: str) -> dict | None:
        """The window once KWin and Plastile stopped moving it (it is tiled when it maps) and its
        accessibility tree reports the same size, so widget positions are current."""
        last, since = None, time.monotonic()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.s.settle(timeout=2.0)
            w = self.window(caption)
            if w is not None and w["client"] == (last or {}).get("client") and time.monotonic() - since >= 0.3:
                nodes = self.tree(caption)
                top = nodes[0] if nodes else None
                if top and top["ext"] and top["ext"][2:] == [w["client"]["width"], w["client"]["height"]]:
                    return {"window": w, "nodes": nodes}
            if w is None or w["client"] != (last or {}).get("client"):
                last, since = w, time.monotonic()
            time.sleep(0.1)
        return None

    def click(self, win: dict, node: dict, dx: float | None = None) -> None:
        x, y, w, h = node["ext"]
        px = win["client"]["x"] + x + (w / 2 if dx is None else dx)
        py = win["client"]["y"] + y + h / 2
        self.inp.do(f"move {px} {py}")
        time.sleep(0.05)
        self.inp.do("press left", "release left")

    def keys(self, *codes_: int, mods: tuple[int, ...] = ()) -> None:
        for m in mods:
            self.inp.do(f"key {m} down")
        for k in codes_:
            self.inp.do(f"key {k} down", f"key {k} up")
        for m in reversed(mods):
            self.inp.do(f"key {m} up")


def find(nodes: list[dict], role: str, name: str | None = None, under: tuple[str, str] | None = None,
         prefix: bool = False) -> dict | None:
    for n in nodes:
        if n["role"] != role or not n["ext"] or n["ext"][2] <= 0:
            continue
        if name is not None and not (n["name"].startswith(name) if prefix else n["name"] == name):
            continue
        if under is not None and list(under) not in n["ancestors"]:
            continue
        return n
    return None


def form(nodes: list[dict]) -> dict:
    """What the dialog shows for the fields the scenario edits (read from its accessibility tree)."""
    layout = find(nodes, "combo box", under=("panel", "Layout"))
    gap = find(nodes, "spin button", "Gap between windows:")
    single = find(nodes, "check box", "Keep screen-edge gaps around a single window")
    apply_ = find(nodes, "button", "Apply")
    return {"layout": layout["name"] if layout else None, "gapInner": gap["value"] if gap else None,
            "singleWindowGaps": ("checked" in single["states"]) if single else None,
            "applyEnabled": ("enabled" in apply_["states"]) if apply_ else None}


def open_dialog(d: Dialogs) -> dict | None:
    """Click Plastile's Configure… button in the KWin Scripts list; return the stable dialog."""
    scripts = d.stable(SCRIPTS_WINDOW)
    if scripts is None:
        return None
    button = find(scripts["nodes"], "button", "Configure", under=("check box", "Plastile"), prefix=True)
    if button is None or "enabled" not in button["states"]:
        return None
    d.click(scripts["window"], button)
    if not until(lambda: d.window(DIALOG) is not None, 10):
        return None
    return d.stable(DIALOG)


def edit(d: Dialogs, dlg: dict, gap: int, want: dict) -> dict:
    """Change the layout combo (one step down), the inner-gap spin box and the single-window check box
    with real input, then read back what the dialog shows."""
    win, nodes = dlg["window"], dlg["nodes"]
    combo = find(nodes, "combo box", under=("panel", "Layout"))
    d.click(win, combo)  # opens the combo's popup (an xdg popup KWin lists)
    until(lambda: d.popups(), 5)
    d.keys(KEY_DOWN, KEY_ENTER)
    until(lambda: not d.popups(), 5)
    spin = find(nodes, "spin button", "Gap between windows:")
    d.click(win, spin, dx=12)  # into the text, clear of the arrows
    d.keys(KEY_A, mods=(KEY_LEFTCTRL,))
    d.keys(*(DIGITS[ch] for ch in str(gap)))
    check = find(nodes, "check box", "Keep screen-edge gaps around a single window")
    d.click(win, check, dx=9)  # the box itself
    shown: dict = {}

    def matches() -> bool:
        nonlocal shown
        shown = form(d.tree(DIALOG) or [])
        return all(shown.get(k) == v for k, v in want.items())
    until(matches, 8)
    return shown


def press(d: Dialogs, dlg: dict, button: str) -> None:
    node = find(d.tree(DIALOG) or dlg["nodes"], "button", button)
    d.click(dlg["window"], node)


@scenario("settings-dialog-T28")
def settings_dialog(out: Path, c: Checks):
    missing = requirements()
    if missing:
        raise Skipped("the KWin script settings dialog cannot be driven here: missing " + ", ".join(missing))
    import release
    zip_path = Path(release.build(out / "dist")["path"])
    git = lambda *a: subprocess.run(["git", "-C", str(ROOT), *a], capture_output=True, text=True).stdout.strip()  # noqa: E731
    ev: dict = {"layer": "nested KWin virtual backend (not physical); package installed into the private data home",
                "implementationCommit": git("rev-parse", "HEAD"),
                "implementationDirty": bool(git("status", "--porcelain", "--", "src", "package", "tests", "tools")),
                "kwin": subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip(),
                "kcmshell6": sysinfo.binary_version("kcmshell6"), "atspiRegistry": sysinfo.owning_package(REGISTRYD),
                "entryPoint": f"kcmshell6 {KCM} > Plastile > Configure… (KCMultiDialog with X-KDE-ConfigModule)",
                "input": "libei (tools/input) pointer clicks and key presses; AT-SPI read-only for positions and values"}
    with SettingsSession(out, zip_path) as s:
        kw = s.kw
        c("setup: package installed into the private data home",
          (s.prepare_result or {}).get("rc") == 0 and installed_dir(kw).is_dir(), s.prepare_result)
        meta = json.loads((installed_dir(kw) / "metadata.json").read_text())
        ev["configModule"] = meta.get("X-KDE-ConfigModule")
        listed = subprocess.run(["kcmshell6", "--list"], env={**kw.env(), "QT_QPA_PLATFORM": "offscreen"},
                                capture_output=True, text=True, timeout=30).stdout.split()
        if KCM not in listed:
            raise Skipped(f"kcmshell6 does not list the {KCM} KCM here")
        kw.wait_log(STARTED, 30, 0)
        s.spawn(1); s.spawn(2)
        s.settle()
        area = s.area()
        before = two_fixtures(s)
        c("setup: master/stack (ratio 0.55, unequal widths) with inner gap 8 (oracle)",
          abs(before["gap"] - GAP) <= 0.5 and before["widths"][0] - before["widths"][1] > 50 and not before["errors"],
          before)
        ev["kwinrcBefore"] = groups(kwinrc_bytes(s).decode()).get("Script-plastile")

        # The settings windows get their own desktop, so the fixtures stay a two-window layout.
        s.js("workspace.createDesktop(1, 'Settings'); workspace.currentDesktop = workspace.desktops[1]; emit(1);")
        s.start_owned([REGISTRYD], "atspi-registryd.log")
        kcm = s.start_owned(["kcmshell6", KCM], "kcmshell6.log")
        inp = Input(s)
        d = Dialogs(s, inp, kcm)
        try:
            listed = until(lambda: find(d.tree(SCRIPTS_WINDOW) or [], "check box", "Plastile") is not None, 20)
            c("the KWin Scripts KCM lists the installed Plastile package (enabled)", listed
              and "checked" in (find(d.tree(SCRIPTS_WINDOW) or [], "check box", "Plastile") or {}).get("states", []), None)

            # ---- open, edit, Apply ----
            dlg = open_dialog(d)
            c("Configure… opens KWin's settings dialog for Plastile (a KWin window of the KCM process)", dlg is not None,
              windows_of(s, kcm.pid))
            if dlg is None:
                return
            shown0 = form(dlg["nodes"])
            ev["dialogOpened"] = shown0
            # kwinrc has no layout keys yet, so this is main.xml's defaults (= the running settings); the
            # reopened dialog below is what shows values read back from kwinrc.
            c("the dialog shows the running settings: main.xml defaults, kwinrc has none of these keys "
              "(master/stack, gap 8, single-window gaps on, Apply disabled)",
              shown0 == {"layout": "Master and stack", "gapInner": 8.0, "singleWindowGaps": True, "applyEnabled": False},
              shown0)
            want = {"layout": "Binary split (BSP)", "gapInner": 20.0, "singleWindowGaps": False, "applyEnabled": True}
            shown = edit(d, dlg, 20, want)
            ev["dialogEdited"] = shown
            c("real input changed the combo (BSP), the spin box (20) and the check box (off); Apply enabled",
              shown == want, shown)
            off = kw.mark()
            raw = kwinrc_bytes(s)
            rc0 = groups(raw.decode())
            tiles0 = kcm_frames(s, kcm.pid)
            press(d, dlg, "Apply")
            written = until(lambda: kwinrc_bytes(s) != raw, 8)
            until(lambda: form(d.tree(DIALOG) or []).get("applyEnabled") is False, 5)
            rc1 = groups(kwinrc_bytes(s).decode())
            group = rc1.get("Script-plastile", {})
            ev["kwinrcAfterApply"] = group
            c("Apply writes kwinrc", written, None)
            c("[Script-plastile] holds exactly the edited keys in the runtime's vocabulary "
              "(layout=bsp, gapInner=20, singleWindowGaps=false; diagnostics kept)",
              group == {"diagnostics": "info", "layout": "bsp", "gapInner": "20", "singleWindowGaps": "false"}, group)
            parsed = runtime_parse(group)
            ev["runtimeParse"] = parsed
            c("the runtime's flat-key parser accepts the group with no error or warning and reads the edits",
              parsed.get("errors") == [] and parsed.get("warnings") == []
              and parsed.get("patch") == {"layout": "bsp", "gaps": {"inner": 20}, "singleWindowGaps": False}, parsed)
            others0 = {k: v for k, v in rc0.items() if k != "Script-plastile"}
            others1 = {k: v for k, v in rc1.items() if k != "Script-plastile"}
            c("Apply changed no other kwinrc group", others0 == others1,
              {k: [others0.get(k), others1.get(k)] for k in set(others0) | set(others1) if others0.get(k) != others1.get(k)})
            # The settings desktop is the visible context: a reload would re-tile its two windows (BSP, gap 20).
            time.sleep(QUIET_S)
            tiles1 = kcm_frames(s, kcm.pid)
            c("Apply alone does not reach the running script (ADR-015): no activation, visible tiles unchanged (oracle)",
              not s.log_lines(ACTIVATED, off) and tiles1 == tiles0 and len(tiles0) == 2,
              {"activations": s.log_lines(ACTIVATED, off), "tiles": [tiles0, tiles1]})

            raw = kwinrc_bytes(s)
            press(d, dlg, "OK")
            closed = until(lambda: d.window(DIALOG) is None, 8)
            c("OK with nothing pending closes the dialog and leaves kwinrc as Apply wrote it",
              closed and kwinrc_bytes(s) == raw, closed)

            # ---- reload: the running layout changes ----
            off = kw.mark()
            s.cmd("runtime.reload-config")
            activated = until(lambda: s.log_lines(ACTIVATED, off), 5)
            s.settle()
            c("Reload configuration activates the applied settings once", activated and len(s.log_lines(ACTIVATED, off)) == 1,
              s.log_lines(ACTIVATED, off))
            alone = kcm_frames(s, kcm.pid).get(SCRIPTS_WINDOW)
            ev["aloneAfterReload"] = alone
            c("singleWindowGaps=false: the lone KWin Scripts window now fills the whole work area (oracle)",
              alone is not None and all(abs(alone[k] - area[k]) <= 0.5 for k in area), {"frame": alone, "area": area})
            after = fixtures_desktop(s)
            ev["afterReload"] = after
            c("after the reload: BSP halves (equal widths) with inner gap 20 and outer gap 8 (oracle)",
              abs(after["gap"] - 20) <= 0.5 and abs(after["widths"][0] - after["widths"][1]) <= 1 and not after["errors"],
              after)

            # ---- open again, edit, Cancel ----
            dlg = open_dialog(d)
            c("the dialog opens again", dlg is not None, windows_of(s, kcm.pid))
            if dlg is None:
                return
            shown1 = form(dlg["nodes"])
            ev["dialogReopened"] = shown1
            c("reopened, the dialog reads back what Apply wrote (BSP, 20, off)",
              shown1 == {"layout": "Binary split (BSP)", "gapInner": 20.0, "singleWindowGaps": False,
                         "applyEnabled": False}, shown1)
            want = {"layout": "Monocle (one window at a time)", "gapInner": 40.0, "singleWindowGaps": True,
                    "applyEnabled": True}
            shown = edit(d, dlg, 40, want)
            ev["dialogEditedBeforeCancel"] = shown
            c("real input changed all three fields again (monocle, 40, on)", shown == want, shown)
            # A passive plain-JS script (not Plastile) reports KWin's configChanged, so a KWin re-read is
            # observed, not assumed: Plastile skips an identical input silently (main.ts loadConfig), so its
            # own log cannot show that Cancel caused no reconfigure.
            probe = kw.root / "plt-config-listen.js"
            probe.write_text("options.configChanged.connect(function () { print('PLT-CFG changed'); });\n"
                             "print('PLT-CFG ready');\n")
            off = kw.mark()
            kw.load_script(probe, "plt-config-listen")
            kw.wait_log(r"PLT-CFG ready", 5, off)
            raw = kwinrc_bytes(s)
            off = kw.mark()
            press(d, dlg, "Cancel")
            closed = until(lambda: d.window(DIALOG) is None, 8)
            time.sleep(QUIET_S)
            s.settle()
            alone = kcm_frames(s, kcm.pid).get(SCRIPTS_WINDOW)
            quiet = s.log_lines(rf"{ACTIVATED}|{RELOAD_REQUESTED}|plastile notice (started|stopped)", off)
            kwin_reread = s.log_lines(r"PLT-CFG changed", off)
            ev["cancel"] = {"closed": closed, "kwinrcUnchanged": kwinrc_bytes(s) == raw, "logged": quiet,
                            "kwinConfigChanged": kwin_reread, "alone": alone}
            c("Cancel closes the dialog and kwinrc is byte-for-byte unchanged", closed and kwinrc_bytes(s) == raw,
              ev["cancel"])
            # Monocle with single-window gaps on would inset the lone window by the outer gap.
            c("Cancel reloads nothing: no activation, reload request, start or stop; the lone window still fills "
              "the area (oracle)", not quiet and alone is not None and all(abs(alone[k] - area[k]) <= 0.5 for k in area),
              ev["cancel"])
            c("Cancel makes KWin re-read nothing: no configChanged reached the passive listener (oracle)",
              not kwin_reread, ev["cancel"])
            # KWin's own reconfigure (what other settings pages trigger) re-reads kwinrc; the same listener is
            # the positive control for the check above. The input is what the last activation read, so
            # Plastile makes no new revision (main.ts loadConfig).
            off = kw.mark()
            kw.call("/KWin", "org.kde.KWin", "reconfigure")
            reread = until(lambda: s.log_lines(r"PLT-CFG changed", off), 5)
            s.settle()
            kw.unload("plt-config-listen")
            again = fixtures_desktop(s)
            ev["reconfigureAfterCancel"] = {"configChanged": reread, "activations": s.log_lines(ACTIVATED, off), "tiles": again}
            c("KWin's reconfigure after Cancel re-reads kwinrc (configChanged observed), Plastile finds nothing new "
              "(no activation) and keeps BSP halves with gap 20 (oracle)",
              reread and not s.log_lines(ACTIVATED, off) and abs(again["gap"] - 20) <= 0.5
              and abs(again["widths"][0] - again["widths"][1]) <= 1 and not again["errors"], ev["reconfigureAfterCancel"])

            ui = own_ui(s)
            c("the settings flow never instantiated Plastile's inspector (KWin window list, Loader state)",
              ui == [] and s.counters().get("inspectorOpen") is False, ui)
            errs = s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError")
            c("no Plastile errors, warnings or JS exceptions", not errs, errs[:3])
        finally:
            inp.close()
    evidence_file("settings-dialog-T28.json").write_text(json.dumps({**ev, "checks": c.items}, indent=1) + "\n")


@scenario("settings-keyboard-only-inspector-T28")
def keyboard_only_inspector(out: Path, c: Checks):
    """Every default binding pressed with real keys; Plastile's own windows counted through KWin."""
    binds = [b for b in defaults() if b[0] != "plastile.runtime.toggle-suspend"]
    binds += [b for b in defaults() if b[0] == "plastile.runtime.toggle-suspend"] * 2
    with Session(out, config={"diagnostics": "debug"}) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        s.load(); s.settle()
        internal0 = internal_windows(s)
        try:
            inp = Input(s)
        except Exception as exc:  # noqa: BLE001
            raise Skipped(f"libei input injector unavailable: {exc}")
        missed = []
        try:
            for cid, seq in binds:
                mods, key = codes(seq)
                off = s.kw.mark()
                for m in mods:
                    inp.do(f"key {m} down")
                inp.do(f"key {key} down", f"key {key} up")
                for m in reversed(mods):
                    inp.do(f"key {m} up")
                if not until(lambda: s.log_lines(r'plastile debug command \{"command":"' + re.escape(cid) + '"', off), 2.0):
                    missed.append(cid)
        finally:
            inp.close()
        s.settle()
        c("every default binding reached Plastile (real key events)", not missed, {"missed": missed, "pressed": len(binds)})
        ui, internal1, cn = own_ui(s), internal_windows(s), s.counters()
        c("keyboard-only use instantiated no inspector: no Plastile window in KWin's list, Loader inactive",
          ui == [] and cn.get("inspectorOpen") is False, {"own": ui, "inspectorOpen": cn.get("inspectorOpen")})
        c("no window without a client process appeared (KWin's window list)", internal1 == internal0,
          {"before": internal0, "after": internal1})
        # Positive control: the same count sees the inspector once its command runs.
        s.cmd("inspect.explain-window")
        seen = until(lambda: len(own_ui(s)) == 1, 5)
        s.cmd("inspect.explain-window")
        gone = until(lambda: own_ui(s) == [], 5)
        c("control: explain-window creates exactly one inspector window and closing removes it", seen and gone,
          {"seen": seen, "gone": gone})
