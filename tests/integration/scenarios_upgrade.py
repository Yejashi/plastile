"""Version-to-version upgrade (T26 "user bindings survive updates", T32 "update preserves config";
TEST_MATRIX Q08, Q11).

An older Plastile package is installed into a private XDG profile (data, config, state and cache
directories outside any one nested session, so a KWin restart keeps them as a re-login keeps the
home directory, KWin's QML disk cache in $XDG_CACHE_HOME/kwin/qmlcache included), configured with
non-default kwinrc values and a user rebinding made the way the Shortcuts settings page makes it
(KGlobalAccel setForeignShortcutKeys on the nested bus), then upgraded with tools/install.sh
upgrade. The script is restarted (kwinrc + Scripting.start), then the nested KWin itself, and
finally the package is removed with the documented path.

The older package is built from git commit OLD_COMMIT (the last one with the three replaced
defaults, see docs/user/SHORTCUTS.md) with its version relabelled OLD_VERSION, both in
metadata.json and in the bundle's `started` line, so the log says which code KWin runs. Where
that commit cannot be built (no git history, no Node), the current tree relabelled OLD_VERSION is
used instead; the evidence and a check name say which.

Oracles: geometry from one-shot KWin scripts; bindings from KGlobalAccel's D-Bus answers, the
private kglobalshortcutsrc and real key presses through libei (tools/input); "reached Plastile"
from Plastile's debug dispatch line (key routing only, as in shortcuts-defaults-real-input), and
for the rebound focus commands also from KWin's active window.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import subprocess
import tarfile
import time
from pathlib import Path

from harness import ROOT, PLUGIN, Input, NestedError, Session, evidence_file, near
from scenarios import Checks, Skipped, scenario
from scenarios_package import STARTED, STOPPED, build_zip, redact

INSTALL = ROOT / "tools/install.sh"
OLD_COMMIT = "34204e2b11f668f2b744d2d09705e05b96aa733f"  # 0b1c8b9^: suspend Meta+Shift+S, grow/shrink Meta+Shift+=/-
OLD_VERSION = "0.0.1"
NEW_VERSION = json.loads((ROOT / "package/metadata.json").read_text())["KPlugin"]["Version"]
CONFIG = {"diagnostics": "debug", "gapInner": "20", "gapOuter": "14", "masterRatio": "0.6"}

# Qt key combinations as KGlobalAccel marshals them: QKeySequence -> (ai) of four combined keys.
META, SHIFT, CTRL, ALT = 0x10000000, 0x02000000, 0x04000000, 0x08000000
QT_RETURN = 0x01000004
# linux/input-event-codes.h
EV = {"Meta": 125, "Shift": 42, "Ctrl": 29, "Alt": 56, "N": 49, "P": 25, "C": 46, "H": 35, "T": 20, "S": 31,
      "Return": 28, "Escape": 1}

# The user's changes, as System Settings > Shortcuts would save them (component kwin).
REBIND = {
    "plastile.focus.next": ("Plastile: Focus next", META | ALT | ord("N"), "Meta+Alt+N"),
    "plastile.focus.previous": ("Plastile: Focus previous", META | ALT | ord("P"), "Meta+Alt+P"),
    "plastile.inspect.counters": ("Plastile: Log counters", META | ALT | ord("C"), "Meta+Alt+C"),  # unbound by default
}
UNBIND = ("plastile.swap.master", "Plastile: Swap with master")  # default Meta+Shift+Return
# Defaults OLD_COMMIT shipped and the current tree replaced (docs/user/SHORTCUTS.md "Changed defaults").
REPLACED = {"plastile.runtime.toggle-suspend": (META | SHIFT | ord("S"), META | CTRL | ord("S")),
            "plastile.resize.grow": (META | SHIFT | ord("="), META | CTRL | ord("=")),
            "plastile.resize.shrink": (META | SHIFT | ord("-"), META | CTRL | ord("-"))}


def dispatched(cid: str) -> str:
    return r'plastile debug command \{"command":"' + re.escape(cid) + '"'


ANY_DISPATCH = r'plastile debug command \{"command":"'
OLD_KEYS = {"Meta+Shift+S", "Meta+Shift+=", "Meta+Shift+-"}
CONFLICT_KEY = re.compile(r'(\S+): "Plastile: ')


def unexpected_warnings(warn: list[str], replaced: bool) -> list[str]:
    """Warnings other than a conflict report naming only the replaced old defaults. Such a report (Spectacle's
    Meta+Shift+S, where Spectacle is installed) is the conflict check pointing at a stale default as documented."""
    def allowed(line: str) -> bool:
        if not replaced or "plastile warn shortcut conflicts: " not in line:
            return False
        keys = CONFLICT_KEY.findall(line.split("shortcut conflicts: ", 1)[1])
        return bool(keys) and set(keys) <= OLD_KEYS
    return [ln for ln in warn if not allowed(ln)]


# ------------------------------------------------------------------ the older package
def build_old_package(out: Path) -> dict:
    """OLD_COMMIT's package/ built with its own src/ and tools/build.mjs, relabelled OLD_VERSION."""
    work = out / "old-tree"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    info: dict = {"commit": OLD_COMMIT, "version": OLD_VERSION}
    try:
        # safe.directory: the CI sandbox runs as root over a checkout owned by another user.
        tar = subprocess.run(["git", "-c", "safe.directory=*", "-C", str(ROOT), "archive", "--format=tar", OLD_COMMIT,
                              "package", "src", "tools/build.mjs", "package.json"],
                             capture_output=True, timeout=60)
        if tar.returncode != 0:
            raise RuntimeError(f"git archive: {tar.stderr.decode(errors='replace').strip()[-300:]}")
        with tarfile.open(fileobj=io.BytesIO(tar.stdout)) as tf:
            tf.extractall(work, filter="data")
        (work / "node_modules").symlink_to(ROOT / "node_modules")
        main_ts = work / "src/runtime/main.ts"
        text = main_ts.read_text()
        relabelled = re.sub(r'export const VERSION = "[^"]*";', f'export const VERSION = "{OLD_VERSION}";', text)
        if relabelled == text:
            raise RuntimeError("VERSION constant not found in the old src/runtime/main.ts")
        main_ts.write_text(relabelled)
        r = subprocess.run(["node", "tools/build.mjs"], cwd=work, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError(f"old build: {(r.stderr or r.stdout).strip()[-300:]}")
        info["source"] = "git"
    except (OSError, RuntimeError, subprocess.SubprocessError, tarfile.TarError) as exc:
        # Fallback: the current tree, relabelled. Version-to-version mechanics only; the replaced defaults
        # are then not exercised.
        info = {"source": "current-tree", "version": OLD_VERSION, "whyNotGit": redact(str(exc))}
        shutil.rmtree(work)
        work.mkdir(parents=True)
        shutil.copytree(ROOT / "package", work / "package")
        bundle = work / "package/contents/code/plastile.mjs"
        code = bundle.read_text()
        bundle.write_text(re.sub(r'VERSION = "[^"]*"', f'VERSION = "{OLD_VERSION}"', code, count=1))
    meta_path = work / "package/metadata.json"
    meta = json.loads(meta_path.read_text())
    meta["KPlugin"]["Version"] = OLD_VERSION
    meta_path.write_text(json.dumps(meta, indent=4) + "\n")
    info["dir"] = work / "package"
    info["ids"] = set(re.findall(r'id: "(plastile\.[^"]+)"', (work / "package/contents/code/plastile.mjs").read_text()))
    info["commands"] = len(info["ids"])
    return info


# ------------------------------------------------------------------ the private profile
class Profile:
    """XDG data/config/state directories that outlive a nested KWin (the user's home, in miniature)."""

    def __init__(self, base: Path):
        self.base = base
        for sub in ("config", "data", "state", "cache"):
            (base / sub).mkdir(parents=True, exist_ok=True)
        self.kwinrc = base / "config/kwinrc"
        self.shortcutsrc = base / "config/kglobalshortcutsrc"
        self.installed = base / "data/kwin/scripts" / PLUGIN
        cfg = "\n".join(f"{k}={v}" for k, v in CONFIG.items())
        self.kwinrc.write_text(f"[Plugins]\n{PLUGIN}Enabled=true\n\n[Script-{PLUGIN}]\n{cfg}\n\n"
                               "[org.kde.kdecoration2]\nlibrary=org.kde.breeze\n")

    def env(self) -> dict:
        return {"XDG_CONFIG_HOME": str(self.base / "config"), "XDG_DATA_HOME": str(self.base / "data"),
                "XDG_STATE_HOME": str(self.base / "state"), "XDG_CACHE_HOME": str(self.base / "cache")}

    def qmlcache(self) -> int:
        """Compiled units in KWin's QML disk cache (keyed by source URL, checked against the source's mtime)."""
        d = self.base / "cache/kwin/qmlcache"
        return sum(1 for _ in d.iterdir()) if d.is_dir() else 0

    def kwinrc_hash(self) -> str:
        return hashlib.sha256(self.kwinrc.read_bytes()).hexdigest()

    def group(self, name: str) -> dict:
        """One kwinrc group as {key: value} (read-only)."""
        out, cur = {}, None
        for line in self.kwinrc.read_text().splitlines():
            if line.startswith("["):
                cur = line.strip("[]")
            elif cur == name and "=" in line:
                k, v = line.split("=", 1)
                out[k] = v
        return out

    def set_enabled(self, enabled: bool) -> None:
        """What System Settings > KWin Scripts writes before it calls Scripting.start (test-side edit)."""
        text = self.kwinrc.read_text()
        self.kwinrc.write_text(re.sub(rf"^{PLUGIN}Enabled=.*$", f"{PLUGIN}Enabled={'true' if enabled else 'false'}",
                                      text, flags=re.M))

    def entries(self) -> dict:
        """kglobalshortcutsrc [kwin] plastile.* lines: {action: (active, default)}."""
        out, group = {}, ""
        if not self.shortcutsrc.exists():
            return out
        for line in self.shortcutsrc.read_text().splitlines():
            if line.startswith("["):
                group = line.strip("[]")
            elif group == "kwin" and line.startswith("plastile.") and "=" in line:
                action, value = line.split("=", 1)
                fields = value.split(",")
                out[action] = (fields[0], fields[1] if len(fields) > 1 else "")
        return out


class ProfileSession(Session):
    """A nested KWin over a Profile; `prepare` (optional) runs before KWin starts."""

    def __init__(self, out: Path, profile: Profile, prepare=None):
        super().__init__(out, config=CONFIG, extra_env=profile.env())
        self.profile = profile
        self.kw.prepare = prepare


def install_sh(s_or_kw, profile: Profile, *args: str) -> dict:
    kw = getattr(s_or_kw, "kw", s_or_kw)
    before = profile.kwinrc_hash()
    r = subprocess.run(["sh", str(INSTALL), *args], env=kw.env(), capture_output=True, text=True, timeout=60)
    clean = lambda t: redact(t.replace(str(profile.base), "<profile>"), kw)  # noqa: E731
    return {"argv": ["tools/install.sh", *[clean(a) for a in args]], "rc": r.returncode, "stdout": clean(r.stdout),
            "stderr": clean(r.stderr), "kwinrcUnchanged": before == profile.kwinrc_hash()}


# ------------------------------------------------------------------ KGlobalAccel on the nested bus
class Accel:
    def __init__(self, s: Session):
        import dbus
        self.dbus = dbus
        conn = s.kw._bus_connection()
        self.kga = dbus.Interface(conn.get_object("org.kde.kglobalaccel", "/kglobalaccel"), "org.kde.KGlobalAccel")
        self.comp = dbus.Interface(conn.get_object("org.kde.kglobalaccel", "/component/kwin"),
                                   "org.kde.kglobalaccel.Component")

    def seqs(self, *combined: int):
        d = self.dbus
        return d.Array([d.Struct([d.Array([k, 0, 0, 0], signature="i")], signature=None) for k in combined],
                       signature="(ai)")

    def set_keys(self, action: str, friendly: str, *combined: int) -> None:
        """The Shortcuts settings page's save path for another component's action (setForeignShortcutKeys)."""
        self.kga.setForeignShortcutKeys(["kwin", action, "KWin", friendly], self.seqs(*combined))

    def keys(self, action: str) -> list[int]:
        return [int(seq[0][0]) for seq in self.kga.shortcutKeys(["kwin", action, "", ""]) if len(seq[0])]

    def holder(self, combined: int) -> list[str]:
        """KGlobalAccel's answer to 'which action owns this key' (component, action, ...)."""
        return [str(x) for x in self.kga.actionList(self.seqs(combined)[0])]

    def plastile_with(self, combined: int) -> list[str]:
        return [str(i[0]) for i in self.comp.allShortcutInfos() if str(i[0]).startswith("plastile.")
                and combined in [int(k) for k in i[6]]]

    def names(self) -> list[str]:
        return [str(n) for n in self.comp.shortcutNames() if str(n).startswith("plastile.")]


def press(inp: Input, *keys: str) -> None:
    *mods, key = keys
    for m in mods:
        inp.do(f"key {EV[m]} down")
    inp.do(f"key {EV[key]} down", f"key {EV[key]} up")
    for m in reversed(mods):
        inp.do(f"key {EV[m]} up")


def press_count(s: Session, inp: Input, keys: tuple[str, ...], pattern: str, quiet: float = 0.6) -> list[str]:
    """Press a chord once; wait for the first matching line, then a quiet period for duplicates."""
    off = s.kw.mark()
    press(inp, *keys)
    try:
        s.kw.wait_log(pattern, 2.0, off)
    except NestedError:
        return []
    time.sleep(quiet)
    return s.kw.lines_since(off, pattern)


def press_none(s: Session, inp: Input, keys: tuple[str, ...], quiet: float = 1.0) -> list[str]:
    """Press a chord that must reach no Plastile command; return any dispatch lines seen."""
    off = s.kw.mark()
    press(inp, *keys)
    time.sleep(quiet)
    return s.kw.lines_since(off, ANY_DISPATCH) + s.kw.lines_since(off, r"plastile counters ")


def active(s: Session) -> str | None:
    out = s.js("emit(workspace.activeWindow ? workspace.activeWindow.caption : null)")
    return json.loads(out[0]) if out else None


def config_oracle(s: Session) -> dict:
    """gapOuter 14, gapInner 20, masterRatio 0.6 measured on two fixtures' frames."""
    a = s.area()
    l, r = sorted((f["frame"] for f in s.frames_list()), key=lambda f: f["x"])
    got = {"outer": l["x"] - a["x"], "inner": r["x"] - (l["x"] + l["width"]),
           "ratio": round(l["width"] / (l["width"] + r["width"]), 4)}
    got["ok"] = abs(got["outer"] - 14) <= 0.5 and abs(got["inner"] - 20) <= 0.5 and abs(got["ratio"] - 0.6) <= 0.01
    return got


def wait_started(s: Session, off: int, timeout: float = 30) -> str | None:
    try:
        line = s.kw.wait_log(STARTED, timeout, off)[-1]
    except NestedError:
        return None
    m = re.search(STARTED + r"(\S+)", line)
    return m.group(1) if m else ""


def restart_script(s: Session, p: Profile) -> tuple[bool, str | None]:
    """Disable and re-enable the way KWin Scripts' Apply does: kwinrc [Plugins] + Scripting.start."""
    off = s.kw.mark()
    p.set_enabled(False)
    s.kw.call("/Scripting", "org.kde.kwin.Scripting", "start")
    try:
        s.kw.wait_log(STOPPED, 15, off)
        stopped = True
    except NestedError:
        stopped = False
    off = s.kw.mark()
    p.set_enabled(True)
    s.kw.call("/Scripting", "org.kde.kwin.Scripting", "start")
    return stopped, wait_started(s, off, 15)


def bindings(s: Session, p: Profile, acc: Accel, c: Checks, phase: str, expect_version: str, commands: set[str],
             replaced: bool) -> dict:
    """Every binding claim for one phase (after the script restart, after the KWin restart)."""
    ev: dict = {}
    ent = p.entries()
    ev["file"] = {a: ent.get(a) for a in [*REBIND, UNBIND[0], *REPLACED, "plastile.focus.left"]}
    for action, (_, combined, text) in REBIND.items():
        c(f"{phase}: {action} keeps the user's {text} (KGlobalAccel shortcutKeys and kglobalshortcutsrc)",
          acc.keys(action) == [combined] and ent.get(action, ("",))[0] == text,
          {"keys": acc.keys(action), "file": ent.get(action)})
    c(f"{phase}: {UNBIND[0]} stays unbound (no keys; kglobalshortcutsrc 'none')",
      acc.keys(UNBIND[0]) == [] and ent.get(UNBIND[0], ("?",))[0] == "none",
      {"keys": acc.keys(UNBIND[0]), "file": ent.get(UNBIND[0])})
    c(f"{phase}: an untouched default keeps its key (focus.left Meta+Shift+H)",
      acc.keys("plastile.focus.left") == [META | SHIFT | ord("H")], acc.keys("plastile.focus.left"))
    # Recorded, not asserted: ShortcutHandler registers no default key (KGlobalAccel defaultShortcutKeys).
    ev["defaultKeys"] = {a: [int(q[0][0]) for q in acc.kga.defaultShortcutKeys(["kwin", a, "", ""]) if len(q[0])]
                         for a in ("plastile.focus.left", "plastile.runtime.toggle-suspend")}
    names = acc.names()
    ev["names"] ={"count": len(names), "unique": len(set(names)), "commands": len(commands),
                   "missing": sorted(commands - set(names))[:5]}
    c(f"{phase}: KGlobalAccel lists every command of {expect_version} once",
      len(names) == len(set(names)) and commands <= set(names), ev["names"])
    if replaced:
        # Measured behaviour of KGlobalAccel, not Plastile's: KWin's ShortcutHandler registers with setShortcut
        # (autoloading, no default), so the key stored by the older version wins over the new sequence.
        ev["replacedDefaults"] = {a: {"keys": acc.keys(a), "file": ent.get(a)} for a in REPLACED}
        c(f"{phase}: defaults the upgrade replaced keep the older key the old version stored "
          "(KGlobalAccel autoloading; documented in SHORTCUTS.md)",
          all(acc.keys(a) == [old] for a, (old, _new) in REPLACED.items()), ev["replacedDefaults"])

    try:
        inp = Input(s)
    except Exception as exc:  # noqa: BLE001
        raise Skipped(f"libei input injector unavailable: {exc}")
    try:
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        # KWin's active window around the focus presses: with two tiles, next and previous each move to the other.
        focus = {"start": active(s)}
        presses = {"Meta+Alt+N": press_count(s, inp, ("Meta", "Alt", "N"), ANY_DISPATCH)}
        focus["Meta+Alt+N"] = active(s)
        presses["Meta+Alt+P"] = press_count(s, inp, ("Meta", "Alt", "P"), ANY_DISPATCH)
        focus["Meta+Alt+P"] = active(s)
        presses["Meta+Alt+C"] = press_count(s, inp, ("Meta", "Alt", "C"), r"plastile counters ")
        presses["Meta+Shift+H"] = press_count(s, inp, ("Meta", "Shift", "H"), ANY_DISPATCH)
        focus["before Meta+Shift+N"] = active(s)
        none = {"Meta+Shift+N": press_none(s, inp, ("Meta", "Shift", "N"))}
        focus["Meta+Shift+N"] = active(s)
        none["Meta+Shift+Return"] = press_none(s, inp, ("Meta", "Shift", "Return"))
        ev["presses"] = {k: [ln.split("plastile ", 1)[-1][:120] for ln in v] for k, v in {**presses, **none}.items()}
        ev["activeWindow"] = focus
        c(f"{phase}: Meta+Alt+N, then Meta+Alt+P, move KWin's active window to the other tile and back (KWin oracle)",
          focus["start"] == "plastile-fixture 1" and focus["Meta+Alt+N"] == "plastile-fixture 2"
          and focus["Meta+Alt+P"] == "plastile-fixture 1", focus)
        c(f"{phase}: Meta+Shift+N leaves KWin's active window where it was (KWin oracle)",
          focus["before Meta+Shift+N"] is not None and focus["Meta+Shift+N"] == focus["before Meta+Shift+N"], focus)
        for chord, cid in (("Meta+Alt+N", "plastile.focus.next"), ("Meta+Alt+P", "plastile.focus.previous"),
                           ("Meta+Shift+H", "plastile.focus.left")):
            lines = presses[chord]
            c(f"{phase}: pressing {chord} (libei) dispatches {cid} exactly once",
              len(lines) == 1 and re.search(dispatched(cid), lines[0]) is not None, ev["presses"][chord])
        c(f"{phase}: pressing Meta+Alt+C (libei) runs the user-bound Log counters exactly once",
          len(presses["Meta+Alt+C"]) == 1, ev["presses"]["Meta+Alt+C"])
        c(f"{phase}: the old chord Meta+Shift+N and the unbound Meta+Shift+Return reach no Plastile command",
          not none["Meta+Shift+N"] and not none["Meta+Shift+Return"], {k: ev["presses"][k] for k in none})
        # Meta+T stays KWin's tile editor: KGlobalAccel names it, no Plastile action holds it, and a real
        # press reaches no Plastile command (the editor itself may open: GL only; Escape closes it).
        holder = acc.holder(META | ord("T"))
        mt = press_none(s, inp, ("Meta", "T"))
        press(inp, "Escape")
        ev["metaT"] = {"holder": holder[:2], "plastileActions": acc.plastile_with(META | ord("T")), "dispatch": mt}
        # Under QPainter compositing (the CI sandbox) the GL-only tile editor registers nothing, so Meta+T has no
        # holder at all; what matters is that it is not Plastile's.
        c(f"{phase}: Meta+T is not stolen (held by kwin 'Edit Tiles', or by nobody where the GL-only editor is absent; no "
          "Plastile action has it, a press reaches no Plastile command)",
          holder[:2] in (["kwin", "Edit Tiles"], []) and not ev["metaT"]["plastileActions"] and not mt, ev["metaT"])
    finally:
        inp.close()
    return ev


@scenario("package-upgrade-bindings-T26-T32")
def package_upgrade_bindings(out: Path, c: Checks):
    old = build_old_package(out)
    zip_path, zip_info = build_zip(out, c)
    c(f"older package: built from {'commit ' + OLD_COMMIT[:7] if old['source'] == 'git' else 'the current tree'}, "
      f"relabelled {OLD_VERSION}", (old["dir"] / "contents/code/plastile.mjs").is_file(), redact(json.dumps(
          {k: v for k, v in old.items() if k not in ("dir", "ids")})))
    replaced = old["source"] == "git"
    new_commands = set(re.findall(r'id: "(plastile\.[^"]+)"', (ROOT / "package/contents/code/plastile.mjs").read_text()))
    profile = Profile(out / "profile")
    ev: dict = {"old": {k: v for k, v in old.items() if k not in ("dir", "ids")}, "new": {"version": NEW_VERSION,
                "sha256": zip_info["sha256"], "commands": len(new_commands)}, "config": CONFIG, "steps": {}}
    ev["layer"] = ("nested KWin virtual backend (not physical); private XDG profile kept across two nested KWin "
                   "processes; bindings set over D-Bus (setForeignShortcutKeys), keys pressed through libei")
    ev["kwin"] = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
    ev["kpackagetool6"] = subprocess.run(["kpackagetool6", "--version"], capture_output=True, text=True).stdout.strip()
    steps = ev["steps"]
    config0 = profile.group(f"Script-{PLUGIN}")

    def install_old(kw):
        steps["installOld"] = install_sh(kw, profile, "install", str(old["dir"]))

    # ---------------------------------------------------------------- KWin 1: the older version, configured
    with ProfileSession(out / "kwin1", profile, prepare=install_old) as s:
        inst = steps["installOld"]
        c(f"install {OLD_VERSION}: install.sh install rc 0 into the private data home, kwinrc untouched",
          inst["rc"] == 0 and profile.installed.is_dir() and inst["kwinrcUnchanged"], inst)
        v1 = wait_started(s, 0)
        c(f"autoload: KWin starts the older package ('started {OLD_VERSION}')", v1 == OLD_VERSION, v1)
        s.spawn(1); s.spawn(2)
        s.settle()
        cfg = config_oracle(s)
        c("old version applies the non-default config (outer 14, inner 20, master ratio 0.6; oracle)", cfg["ok"], cfg)
        acc = Accel(s)
        if replaced:
            c("old version registered its own defaults (suspend Meta+Shift+S)",
              acc.keys("plastile.runtime.toggle-suspend") == [META | SHIFT | ord("S")],
              acc.keys("plastile.runtime.toggle-suspend"))
        free = {text: acc.holder(k) for _a, (_f, k, text) in REBIND.items()}
        c("the chosen user chords are free before the rebinding (KGlobalAccel actionList empty)",
          all(not h for h in free.values()), free)
        for action, (friendly, combined, _text) in REBIND.items():
            acc.set_keys(action, friendly, combined)
        acc.set_keys(*UNBIND)
        want = {a: t for a, (_f, _k, t) in REBIND.items()} | {UNBIND[0]: "none"}
        try:
            s.wait_for(lambda: all(profile.entries().get(a, ("",))[0] == t for a, t in want.items()), 10,
                       "kglobalshortcutsrc to hold the rebinding")
        except NestedError:
            pass
        before = {a: profile.entries().get(a) for a in want}
        steps["rebound"] = before
        c("rebinding saved by KGlobalAccel in the private kglobalshortcutsrc (3 rebound, 1 unbound)",
          all((before.get(a) or ("",))[0] == t for a, t in want.items()), before)
        inp = Input(s)
        try:
            s.act("plastile-fixture 1", "workspace.activeWindow = w")
            pre = press_count(s, inp, ("Meta", "Alt", "N"), ANY_DISPATCH)
        finally:
            inp.close()
        c(f"control on {OLD_VERSION}: Meta+Alt+N (libei) already reaches focus.next before the upgrade",
          len(pre) == 1 and re.search(dispatched("plastile.focus.next"), pre[0]) is not None, pre)

        # ------------------------------------------------------------ upgrade while KWin runs
        off = s.kw.mark()
        up = install_sh(s, profile, "upgrade", str(zip_path))
        steps["upgrade"] = up
        installed_meta = json.loads((profile.installed / "metadata.json").read_text())
        c(f"upgrade: install.sh upgrade {zip_path.name} rc 0, installed version {NEW_VERSION}, kwinrc untouched",
          up["rc"] == 0 and installed_meta["KPlugin"]["Version"] == NEW_VERSION and up["kwinrcUnchanged"], up)
        status = install_sh(s, profile, "status")
        c(f"upgrade: install.sh status reports version {NEW_VERSION}", f"version   : {NEW_VERSION}" in status["stdout"],
          status["stdout"][-400:])
        time.sleep(0.5)
        c("upgrade: the running KWin keeps the loaded script (no stop/start without a restart, as install.sh says)",
          not s.kw.lines_since(off, STOPPED) and not s.kw.lines_since(off, STARTED) and s.kw.is_loaded(PLUGIN), None)
        c("upgrade: kglobalshortcutsrc rebinding untouched by the package upgrade",
          {a: profile.entries().get(a) for a in want} == before, {a: profile.entries().get(a) for a in want})

        # ------------------------------------------------------------ restart the script (KWin Scripts: off, Apply, on, Apply)
        # Which code then runs is KWin's business and recorded, not asserted: KWin 6.7.5 loads every declarative
        # script into one shared QQmlEngine (Scripting's m_qmlEngine) by the same file URL and never clears its
        # component cache, so the measured answer there is the older bundle (docs/user/INSTALL.md, Updating).
        stopped, v2 = restart_script(s, profile)
        steps["scriptRestart"] = {"stopped": stopped, "startedVersion": v2}
        c("script restart: the script stops and exactly one Plastile starts again",
          stopped and v2 in (OLD_VERSION, NEW_VERSION) and len(s.log_lines(STARTED)) == 2, steps["scriptRestart"])
        s.settle()
        cfg = config_oracle(s)
        c(f"script restart ({v2} running): config preserved and applied (oracle; [Script-plastile] unchanged)",
          cfg["ok"] and profile.group(f"Script-{PLUGIN}") == config0, cfg)
        steps["scriptRestart"]["bindings"] = bindings(
            s, profile, acc, c, "script restart", v2 or "?", new_commands if v2 == NEW_VERSION else old["ids"], replaced)
        # The same with the script unloaded while the files change: disable, upgrade, enable.
        off = s.kw.mark()
        profile.set_enabled(False)
        s.kw.call("/Scripting", "org.kde.kwin.Scripting", "start")
        try:
            s.kw.wait_log(STOPPED, 15, off)
        except NestedError:
            pass
        up2 = install_sh(s, profile, "upgrade", str(zip_path))
        off = s.kw.mark()
        profile.set_enabled(True)
        s.kw.call("/Scripting", "org.kde.kwin.Scripting", "start")
        v2b = wait_started(s, off, 15)
        steps["disableUpgradeEnable"] = {"upgradeRc": up2["rc"], "startedVersion": v2b}
        c("disable, upgrade, enable: upgrade rc 0 and exactly one Plastile starts again",
          up2["rc"] == 0 and v2b in (OLD_VERSION, NEW_VERSION) and len(s.log_lines(STARTED)) == 3,
          steps["disableUpgradeEnable"])
        steps["qmlcacheAfterKwin1"] = profile.qmlcache()
        warn = unexpected_warnings(s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError"), replaced)
        c("KWin 1: no Plastile errors, warnings or JS exceptions (beyond conflict reports on the stale defaults)",
          not warn, warn[:3])

    # ---------------------------------------------------------------- KWin 2: a compositor restart, same profile
    # The profile keeps KWin 1's QML disk cache, as ~/.cache survives a re-login, so the restart below also shows
    # that this cache does not bring the older version back (it is checked against the source file's mtime, and
    # kpackagetool6 writes the files with the install time, not the archive's 1980 entry dates).
    mjs = profile.installed / "contents/code/plastile.mjs"
    steps["beforeKwin2"] = {"qmlcacheEntries": profile.qmlcache(),
                            "installedBundleMtime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mjs.stat().st_mtime))}
    c("the profile keeps KWin 1's QML disk cache for the restart (a re-login keeps ~/.cache)",
      steps["qmlcacheAfterKwin1"] > 0 and profile.qmlcache() == steps["qmlcacheAfterKwin1"], steps["beforeKwin2"])
    with ProfileSession(out / "kwin2", profile) as s:
        v3 = wait_started(s, 0)
        starts = s.log_lines(STARTED)
        c(f"KWin restart: autoload starts {NEW_VERSION} exactly once", v3 == NEW_VERSION and len(starts) == 1,
          [ln.split("plastile ", 1)[-1][:60] for ln in starts])
        s.spawn(1); s.spawn(2)
        s.settle()
        cfg = config_oracle(s)
        c("KWin restart: config preserved and applied (oracle; [Script-plastile] unchanged)",
          cfg["ok"] and profile.group(f"Script-{PLUGIN}") == config0, cfg)
        acc = Accel(s)
        steps["kwinRestart"] = {"startedVersion": v3,
                                "bindings": bindings(s, profile, acc, c, "KWin restart", NEW_VERSION, new_commands,
                                                     replaced)}
        # Control for the removal check below: cleanUp() drops only registrations without a live action,
        # so while Plastile runs it keeps every Plastile name (and the user's keys).
        all_before = len(acc.comp.shortcutNames())
        acc.comp.cleanUp()
        kept = acc.names()
        steps["cleanUpControl"] = {"kwinNamesBefore": all_before, "kwinNamesAfter": len(acc.comp.shortcutNames()),
                                   "plastileNames": len(kept)}
        c("control: Component.cleanUp() while Plastile runs keeps every Plastile action and the rebinding",
          new_commands <= set(kept) and acc.keys("plastile.focus.next") == [META | ALT | ord("N")],
          steps["cleanUpControl"])

        # ------------------------------------------------------------ remove with the documented path
        off = s.kw.mark()
        profile.set_enabled(False)
        s.kw.call("/Scripting", "org.kde.kwin.Scripting", "start")
        try:
            s.kw.wait_log(STOPPED, 15, off)
            stopped = True
        except NestedError:
            stopped = False
        c("remove step 1: untick + Apply (kwinrc false + Scripting.start) stops the script", stopped
          and not s.kw.is_loaded(PLUGIN), None)
        rm = install_sh(s, profile, "remove")
        steps["remove"] = rm
        c("remove step 2: install.sh remove rc 0, package directory gone, kwinrc untouched",
          rm["rc"] == 0 and not profile.installed.exists() and rm["kwinrcUnchanged"], rm)
        off = s.kw.mark()
        s.kw.call("/Scripting", "org.kde.kwin.Scripting", "start")
        time.sleep(1.5)
        c("after removal: Scripting.start loads nothing; KWin does not run the script",
          not s.kw.lines_since(off, STARTED) and not s.kw.is_loaded(PLUGIN), None)
        inp = Input(s)
        try:
            gone = {"Meta+Alt+N": press_none(s, inp, ("Meta", "Alt", "N")),
                    "Meta+Alt+C": press_none(s, inp, ("Meta", "Alt", "C")),
                    "Meta+Shift+H": press_none(s, inp, ("Meta", "Shift", "H"))}
        finally:
            inp.close()
        c("after removal: the rebound and default chords reach nothing (libei)", not any(gone.values()), gone)
        left = acc.names()
        leftover = profile.entries()
        kwin_before = len(acc.comp.shortcutNames())
        cleaned = bool(acc.comp.cleanUp())
        after = acc.names()
        kwin_after = len(acc.comp.shortcutNames())
        try:
            s.wait_for(lambda: not profile.entries(), 10, "kglobalshortcutsrc without plastile entries")
        except NestedError:
            pass
        steps["release"] = {"namesAfterRemove": len(left), "fileEntriesAfterRemove": len(leftover),
                            "cleanUp": cleaned, "namesAfterCleanUp": len(after),
                            "kwinNamesBeforeCleanUp": kwin_before, "kwinNamesAfterCleanUp": kwin_after,
                            "fileEntriesAfterCleanUp": len(profile.entries())}
        c("after removal: no Plastile action is active in KGlobalAccel (cleanUp(), which keeps live actions, "
          "removes every leftover Plastile registration)", bool(left) and cleaned and not after, steps["release"])
        c("after removal: the leftover entries are gone from kglobalshortcutsrc after cleanUp()",
          not profile.entries(), steps["release"])
        steps["kwinRestart"]["conflictReport"] = [ln.split("plastile ", 1)[-1]
                                                  for ln in s.log_lines(r"plastile \w+ shortcut (conflicts|check)")]
        warn = unexpected_warnings(s.log_lines(r"plastile (error|warn)|TypeError|ReferenceError"), replaced)
        c("KWin 2: no Plastile errors, warnings or JS exceptions (beyond conflict reports on the stale defaults)",
          not warn, warn[:3])

    shutil.copy(profile.kwinrc, out / "kwinrc-final")
    ev["checks"] = c.items
    evidence_file("package-upgrade-T26-T32.json").write_text(json.dumps(ev, indent=1, default=str) + "\n")
