"""Packaging scenarios (T32): deterministic release zip, kpackagetool6 install into a nested
session's data home, autoload at KWin start, disable via kwinrc + Scripting.start, upgrade,
remove, and post-start package discovery.

Geometry is judged by the oracle (frames from KWin one-shot scripts). Plastile's own log
lines are used only as lifecycle markers ("started"/"stopped"), never for geometry.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from scenarios import scenario, Checks, Skipped, three  # noqa: F401
from harness import Session, delta, evidence_file, near, tiling_errors, Input, centre, ROOT, PLUGIN  # noqa: F401

sys.path.insert(0, str(ROOT / "tools"))
import release  # noqa: E402
from nested import NestedKwin  # noqa: E402

INSTALL = ROOT / "tools/install.sh"
EVIDENCE = evidence_file("package-install.json")
# Older packages (before 0.1.0's notice level) log these at info: an upgrade test starts one.
STARTED = r"plastile (?:info|notice) started "
STOPPED = r"plastile (?:info|notice) stopped"


def redact(text: str, kw: NestedKwin | None = None) -> str:
    """Strip session/home/repo paths so evidence carries no absolute private paths."""
    if kw is not None:
        text = text.replace(str(kw.root), "<session>")
    text = text.replace(str(ROOT), "<repo>")
    home = str(Path.home())
    if home and home != "/":
        text = text.replace(home, "<home>")
    return text


def kwinrc_entries(path: Path) -> dict:
    """Every kwinrc key as {"[group] key": value} (read-only), to name what changed."""
    out, cur = {}, ""
    for line in (path.read_text().splitlines() if path.exists() else ()):
        if line.startswith("["):
            cur = line
        elif "=" in line:
            k, v = line.split("=", 1)
            out[f"{cur} {k}"] = v
    return out


def kwinrc_change(before: dict, after: dict) -> dict:
    """Whether the installer left kwinrc alone, and every key that changed while it ran.

    KWin's tile manager writes its own [Tiling][output][desktop] layout on a deferred save (KWin 6.8 writes the
    default layout for each output and desktop some time after start-up, measured in CI); a save landing while
    install.sh runs is KWin's, not the installer's, so those groups are recorded but do not count.
    """
    changed = {k: [before.get(k), after.get(k)] for k in sorted(before.keys() | after.keys())
               if before.get(k) != after.get(k)}
    return {"kwinrcUnchanged": all(k.startswith("[Tiling]") for k in changed), "kwinrcChanged": changed}


def sh(kw: NestedKwin, *args: str) -> dict:
    """Run tools/install.sh inside the nested session's environment (XDG_DATA_HOME etc.).

    kwinrc is read immediately before and after: the installer must never write it.
    """
    path = kw.root / "config/kwinrc"
    before = kwinrc_entries(path)
    r = subprocess.run(["sh", str(INSTALL), *args], env=kw.env(), capture_output=True, text=True, timeout=60)
    return {**kwinrc_change(before, kwinrc_entries(path)), "rc": r.returncode,
            "argv": ["tools/install.sh", *[redact(a, kw) for a in args]],
            "stdout": redact(r.stdout, kw), "stderr": redact(r.stderr, kw)}


def kpt(kw: NestedKwin, *args: str) -> dict:
    r = subprocess.run(["kpackagetool6", "--type", "KWin/Script", *args], env=kw.env(),
                       capture_output=True, text=True, timeout=60)
    return {"argv": ["kpackagetool6", "--type", "KWin/Script", *[redact(a, kw) for a in args]],
            "rc": r.returncode, "stdout": redact(r.stdout, kw), "stderr": redact(r.stderr, kw)}


def installed_dir(kw: NestedKwin) -> Path:
    return kw.root / "data/kwin/scripts" / PLUGIN


def kwinrc_text(enabled: bool, diagnostics: str = "info") -> str:
    return f"[Plugins]\n{PLUGIN}Enabled={'true' if enabled else 'false'}\n\n[Script-{PLUGIN}]\ndiagnostics={diagnostics}\n"


def set_enabled(kw: NestedKwin, enabled: bool) -> None:
    """Test-side edit of the nested kwinrc (the installer never does this)."""
    path = kw.root / "config/kwinrc"
    text = path.read_text()
    text = re.sub(rf"^{PLUGIN}Enabled=.*$", f"{PLUGIN}Enabled={'true' if enabled else 'false'}", text, flags=re.M)
    path.write_text(text)


def scripting_start(kw: NestedKwin) -> None:
    kw.call("/Scripting", "org.kde.kwin.Scripting", "start")


class PackagedSession(Session):
    """Session whose KWin autoloads Plastile from a package installed before KWin starts.

    Session.load() is never called: autoload is the thing under test. `prepare` runs
    tools/install.sh with the nested environment after the private XDG tree exists.
    """

    def __init__(self, out: Path, zip_path: Path | None, *, enabled: bool = True, outputs: int = 1,
                 width: int = 1280, height: int = 800):
        super().__init__(out, outputs=outputs, width=width, height=height)
        self.zip_path = zip_path
        self.prepare_result: dict | None = None
        self.kw = NestedKwin(out, outputs=outputs, width=width, height=height,
                             kwinrc=kwinrc_text(enabled), prepare=self._prepare if zip_path else None,
                             dbus_services=self.kw.dbus_services)

    def _prepare(self, kw: NestedKwin) -> None:
        self.prepare_result = sh(kw, "install", str(self.zip_path))
        self.prepare_result["installedDir"] = installed_dir(kw).is_dir()
        self.prepare_result["bundlePresent"] = (installed_dir(kw) / "contents/code/plastile.mjs").is_file()


def build_zip(out: Path, c: Checks) -> tuple[Path, dict]:
    """Build the release zip twice and demand identical bytes."""
    first = release.build(out / "dist")
    data1 = Path(first["path"]).read_bytes()
    second = release.build(out / "dist")
    data2 = Path(second["path"]).read_bytes()
    identical = data1 == data2 and first["sha256"] == second["sha256"]
    c("release: two builds yield identical bytes", identical, {"sha256": first["sha256"], "bytes": first["bytes"]})
    c("release: required entries present and sorted",
      first["entries"] == sorted(first["entries"]) and all(r in first["entries"] for r in release.REQUIRED),
      first["entries"])
    # Also prove the CLI path (what a release engineer runs) agrees with the library.
    cli = subprocess.run([sys.executable, str(release.ROOT / "tools/release.py"), "--out", str(out / "dist-cli"),
                          "--check", "--json"], capture_output=True, text=True, timeout=120)
    cli_res = json.loads(cli.stdout) if cli.returncode == 0 and cli.stdout.strip() else {}
    c("release: CLI --check passes and matches the library hash",
      cli.returncode == 0 and cli_res.get("sha256") == first["sha256"] and cli_res.get("reproducible") is True,
      {"rc": cli.returncode, "stderr": cli.stderr[-300:], "cliSha256": cli_res.get("sha256")})
    info = {"version": first["version"], "sha256": first["sha256"], "bytes": first["bytes"],
            "entries": first["entries"], "reproducible": identical,
            "mtimePolicy": "1980-01-01 00:00:00 unless SOURCE_DATE_EPOCH", "name": Path(first["path"]).name}
    return Path(first["path"]), info


def merge_evidence(section: str, data: dict) -> None:
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    existing: dict = {}
    if EVIDENCE.exists():
        try:
            existing = json.loads(EVIDENCE.read_text())
        except json.JSONDecodeError:
            existing = {}
    kwin = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
    existing["layer"] = "nested KWin virtual backend (not physical); package installed into the session's private XDG_DATA_HOME"
    existing["kwin"] = kwin
    existing["kpackagetool6"] = subprocess.run(["kpackagetool6", "--version"], capture_output=True, text=True).stdout.strip()
    existing[section] = data
    EVIDENCE.write_text(json.dumps(existing, indent=1) + "\n")


@scenario("package-install-autoload-T32")
def package_install_autoload(out: Path, c: Checks):
    zip_path, zip_info = build_zip(out, c)
    ev: dict = {"zip": zip_info, "steps": {}}
    with PackagedSession(out, zip_path) as s:
        kw = s.kw
        pr = s.prepare_result or {}
        ev["steps"]["install"] = pr
        c("install.sh install into nested XDG_DATA_HOME: rc 0, directory and bundle present",
          pr.get("rc") == 0 and pr.get("installedDir") and pr.get("bundlePresent"), pr)
        c("install.sh prints enable instructions, does not execute them",
          "kwriteconfig6 --file kwinrc --group Plugins --key plastileEnabled true" in pr.get("stdout", "")
          and "org.kde.kwin.Scripting.start" in pr.get("stdout", "")
          and "Window Management > KWin Scripts" in pr.get("stdout", ""), None)
        # The installer must not have written the session's kwinrc (hashed around the call, before KWin ran).
        c("install.sh left kwinrc untouched (every key read before and after, taken before KWin started)",
          pr.get("kwinrcUnchanged") is True, None)

        # Autoload: nobody called loadDeclarativeScript; KWin itself must have started the package.
        try:
            lines = kw.wait_log(STARTED, 30, 0)
            autoload = True
        except Exception as exc:  # noqa: BLE001
            lines, autoload = [str(exc)], False
        c("autoload: 'plastile notice started' observed after KWin start without manual load", autoload, lines[:1])
        c("autoload: Scripting.isScriptLoaded(plastile) is true", kw.is_loaded(PLUGIN), None)
        ev["steps"]["autoload"] = {"observed": autoload, "isScriptLoaded": kw.is_loaded(PLUGIN)}

        # Two fixtures tile (oracle).
        s.spawn(1); s.spawn(2)
        cs = s.settle()
        area = s.area()
        frames = s.frames_list()
        errs = tiling_errors(frames, area, 8)
        c("tiling: 2 fixtures tiled by the autoloaded package (oracle, no overlap, gaps>=8)",
          len(frames) == 2 and not errs, errs or [f["frame"] for f in frames])
        c("tiling: counters show work (solves>=1, writes>=1, errors=0)",
          cs["counters"]["solves"] >= 1 and cs["counters"]["writes"] >= 1 and cs["counters"]["errors"] == 0,
          cs["counters"])
        ev["steps"]["tiling"] = {"area": area, "frames": [f["frame"] for f in frames], "errors": errs,
                                 "counters": cs["counters"]}

        # Package tooling sees it.
        show = kpt(kw, "--show", PLUGIN)
        listing = kpt(kw, "--list")
        status = sh(kw, "status")
        ev["steps"]["show"], ev["steps"]["list"], ev["steps"]["status"] = show, listing, status
        c("kpackagetool6 --show plastile lists the package", show["rc"] == 0 and "Plugin     : plastile" in show["stdout"],
          show["stdout"][-400:])
        c("kpackagetool6 --list names plastile under the nested data home",
          listing["rc"] == 0 and "plastile" in listing["stdout"].split() and "<session>/data/kwin/scripts" in listing["stdout"],
          listing["stdout"])
        c("install.sh status reports installed, version and enabled=true",
          status["rc"] == 0 and "installed : yes" in status["stdout"] and f"version   : {zip_info['version']}" in status["stdout"]
          and "enabled   : true" in status["stdout"], status["stdout"][-600:])

        # Disable through kwinrc + Scripting.start -> the script unloads itself cleanly.
        off = kw.mark()
        set_enabled(kw, False)
        scripting_start(kw)
        try:
            stopped = kw.wait_log(STOPPED, 15, off)
        except Exception as exc:  # noqa: BLE001
            stopped = []
            ev["steps"]["disableError"] = str(exc)
        c("disable: kwinrc plastileEnabled=false + Scripting.start -> 'plastile notice stopped'", bool(stopped), stopped[:1])
        c("disable: isScriptLoaded false afterwards", not kw.is_loaded(PLUGIN), None)
        c("disable: no Plastile shortcut handlers keep firing (inspect.counters after unload emits nothing)",
          _no_counters_after_unload(kw), None)
        ev["steps"]["disable"] = {"stopped": bool(stopped), "isScriptLoaded": kw.is_loaded(PLUGIN)}

        # Upgrade with the same zip succeeds while KWin runs.
        up = sh(kw, "upgrade", str(zip_path))
        ev["steps"]["upgrade"] = up
        same = (installed_dir(kw) / "contents/code/plastile.mjs").is_file() and \
            hashlib.sha256((installed_dir(kw) / "metadata.json").read_bytes()).hexdigest() == \
            hashlib.sha256((ROOT / "package/metadata.json").read_bytes()).hexdigest()
        c("upgrade: install.sh upgrade with the same zip rc 0, files intact", up["rc"] == 0 and same, up)

        # Re-enable after the upgrade: the script loads again. The zip is the same code, so which version runs is
        # not observable here; with a different version KWin runs the one it loaded first until KWin restarts
        # (package-upgrade-bindings-T26-T32).
        off = kw.mark()
        set_enabled(kw, True)
        scripting_start(kw)
        try:
            restarted = kw.wait_log(STARTED, 15, off)
        except Exception as exc:  # noqa: BLE001
            restarted = []
            ev["steps"]["reenableError"] = str(exc)
        c("re-enable after upgrade: 'plastile notice started' again", bool(restarted), restarted[:1])
        if restarted:
            s.settle()
            frames2 = s.frames_list()
            errs2 = tiling_errors(frames2, area, 8)
            c("re-enable: 2 fixtures still tiled (oracle)", len(frames2) == 2 and not errs2, errs2)
            ev["steps"]["reenable"] = {"frames": [f["frame"] for f in frames2], "errors": errs2}
            # Disable again so removal happens with the script unloaded.
            off = kw.mark()
            set_enabled(kw, False)
            scripting_start(kw)
            kw.wait_log(STOPPED, 15, off)

        # Remove deletes the directory.
        rm = sh(kw, "remove")
        ev["steps"]["remove"] = rm
        c("remove: install.sh remove rc 0 and the package directory is gone",
          rm["rc"] == 0 and not installed_dir(kw).exists(), {"rc": rm["rc"], "exists": installed_dir(kw).exists()})
        rm2 = sh(kw, "remove")
        c("remove twice: second remove fails cleanly (rc 2) without touching anything", rm2["rc"] == 2, rm2["stderr"])
        listing2 = kpt(kw, "--list")
        c("kpackagetool6 --list is empty after remove", listing2["rc"] == 0 and "plastile" not in listing2["stdout"].split(),
          listing2["stdout"])
        ev["steps"]["listAfterRemove"] = listing2
        ev["steps"]["removeTwice"] = rm2
        ev["steps"]["refusalAndDefaultSource"] = _refusal_and_default_source(kw, out, c)
        # The installer never touched kwinrc in any step (KWin itself may rewrite it; that is not ours).
        c("install.sh never wrote kwinrc (status/upgrade/remove hashed before and after each call)",
          all(step.get("kwinrcUnchanged") is True for step in (status, up, rm, rm2)), None)
        text = (kw.root / "config/kwinrc").read_text()
        c("kwinrc still carries the test's keys", f"{PLUGIN}Enabled=false" in text and "[Script-plastile]" in text, None)
        shutil.copy(kw.root / "config/kwinrc", out / "kwinrc-final")
        ev["kwinLogErrors"] = [redact(l, kw) for l in kw.lines_since(0, r"plastile (error|warn)")][:20]
    ev["checks"] = c.items
    merge_evidence("installAutoload", ev)


def _refusal_and_default_source(kw: NestedKwin, out: Path, c: Checks) -> dict:
    """install/upgrade refuse a package without the bundle; the default source (package/) installs."""
    nob = out / "package-without-bundle"
    if nob.exists():
        shutil.rmtree(nob)
    shutil.copytree(ROOT / "package", nob)
    (nob / "contents/code/plastile.mjs").unlink()
    nob_zip = out / "package-without-bundle.kwinscript"
    with zipfile.ZipFile(nob_zip, "w") as zf:
        for rel in ("metadata.json", "contents/ui/main.qml"):
            zf.write(nob / rel, rel)
    res: dict = {}
    for key, args in (("installDir", ("install", str(nob))), ("upgradeDir", ("upgrade", str(nob))),
                      ("installZip", ("install", str(nob_zip)))):
        r = sh(kw, *args)
        res[key] = r
        c(f"refuse {key} without contents/code/plastile.mjs: rc 1, says 'run npm run build', nothing installed",
          r["rc"] == 1 and "run npm run build" in r["stderr"] and not installed_dir(kw).exists() and r["kwinrcUnchanged"],
          {"rc": r["rc"], "stderr": r["stderr"]})
    d = sh(kw, "install")  # default SOURCE = repository package/
    res["installDefaultSource"] = d
    ok = d["rc"] == 0 and (installed_dir(kw) / "contents/code/plastile.mjs").is_file()
    again = sh(kw, "install")
    res["installTwice"] = again
    rm = sh(kw, "remove")
    res["removeDefaultSource"] = rm
    c("install with default source (package/) succeeds; second install refuses (rc 4); remove cleans up",
      ok and again["rc"] == 4 and rm["rc"] == 0 and not installed_dir(kw).exists()
      and all(x["kwinrcUnchanged"] for x in (d, again, rm)),
      {"install": d["rc"], "installTwice": again["rc"], "remove": rm["rc"]})
    return res


def _no_counters_after_unload(kw: NestedKwin) -> bool:
    """After unload, kglobalaccel may still accept the action name; no handler may run."""
    off = kw.mark()
    try:
        kw.invoke_shortcut(f"{PLUGIN}.inspect.counters")
    except Exception:  # noqa: BLE001  (the action may be gone entirely, which is also fine)
        return True
    time.sleep(0.3)
    return not kw.lines_since(off, r"plastile counters ")


@scenario("package-post-start-discovery-T32")
def package_post_start_discovery(out: Path, c: Checks):
    """Does Scripting.start() find a package installed AFTER KWin started? (API_PROFILE: inference only.)"""
    zip_path, zip_info = build_zip(out, c)
    ev: dict = {"zip": zip_info["sha256"], "attempts": []}
    with PackagedSession(out, None, enabled=True) as s:  # enabled in kwinrc, but nothing installed yet
        kw = s.kw
        time.sleep(1.0)
        c("pre-install: Plastile is not loaded (nothing to load)", not kw.is_loaded(PLUGIN) and not kw.lines_since(0, STARTED), None)
        t_install = time.monotonic()
        inst = sh(kw, "install", str(zip_path))
        ev["install"] = inst
        c("post-start install into the nested data home succeeds", inst["rc"] == 0 and installed_dir(kw).is_dir(), inst)
        # Call Scripting.start repeatedly; record when (if ever) the package is picked up.
        found_at = None
        deadline = time.monotonic() + 75.0
        while time.monotonic() < deadline and found_at is None:
            off = kw.mark()
            scripting_start(kw)
            t_call = round(time.monotonic() - t_install, 1)
            try:
                kw.wait_log(STARTED, 2.0, off)
                found_at = t_call
            except Exception:  # noqa: BLE001
                ev["attempts"].append({"startCalledAtPlusSeconds": t_call, "loaded": False})
                time.sleep(2.0)
        ev["discoveredAfterSeconds"] = found_at
        ev["isScriptLoaded"] = kw.is_loaded(PLUGIN)
        c("post-start discovery: Scripting.start eventually loads a package installed after KWin started (<=75 s)",
          found_at is not None, {"discoveredAfterSeconds": found_at, "attempts": ev["attempts"]})
        # Measured, not asserted: whether the very first start() after install already saw the package.
        ev["firstStartAfterInstallLoadedIt"] = found_at is not None and not ev["attempts"]
        ev["attemptsBeforeSuccess"] = len(ev["attempts"])
        if found_at is not None:
            s.spawn(1); s.spawn(2)
            s.settle()
            frames = s.frames_list()
            errs = tiling_errors(frames, s.area(), 8)
            c("post-start discovery: the late-loaded package tiles 2 fixtures (oracle)", len(frames) == 2 and not errs, errs)
            ev["frames"] = [f["frame"] for f in frames]
        rm = sh(kw, "remove")
        c("post-start: remove rc 0 and directory gone", rm["rc"] == 0 and not installed_dir(kw).exists(), rm)
    ev["checks"] = c.items
    merge_evidence("postStartDiscovery", ev)


@scenario("package-helper-install-T32")
def package_helper_install(out: Path, c: Checks):
    """tools/install.sh install-helper builds the persistence helper (ADR-020) and installs it and its D-Bus activation
    file into a private prefix and the nested session's data home; the session's bus then starts it for Plastile and a
    save lands. remove-helper removes both. Nothing is written outside the session and this scenario's directory."""
    if not shutil.which("cmake") or not (shutil.which("c++") or shutil.which("g++") or shutil.which("clang++")):
        raise Skipped("T32: cmake or a C++ compiler is not available here (the helper is built from source)")
    from scenarios_persist import newest, wait_generation, xdg
    base = out / "xdg"
    xdg(base)
    with Session(out / "s", helper=False, extra_env={"XDG_STATE_HOME": str(base / "state")}) as s:
        kw = s.kw
        prefix = kw.root / "helper prefix"  # the bus splits Exec= like a shell: a space must stay one argument
        env = {**kw.env(), "PLASTILE_HELPER_PREFIX": str(prefix), "PLASTILE_HELPER_BUILD": str(out / "helper-build")}

        def run(*args: str) -> dict:
            r = subprocess.run(["sh", str(INSTALL), *args], env=env, capture_output=True, text=True, timeout=600)
            return {"argv": ["tools/install.sh", *args], "rc": r.returncode, "stdout": redact(r.stdout, kw),
                    "stderr": redact(r.stderr, kw)}
        service = kw.root / "data/dbus-1/services/org.kde.plastile.State.service"
        exe = prefix / "libexec/plastile-state"
        before = run("status")
        c("status before: helper not installed", before["rc"] == 0 and "helper    : not installed" in before["stdout"], before)
        inst = run("install-helper")
        text = service.read_text() if service.exists() else ""
        c("install-helper: rc 0, the binary in the private prefix and the activation file in the session's data home "
          "naming it in double quotes", inst["rc"] == 0 and os.access(exe, os.X_OK) and f'Exec="{exe}"\n' in text
          and "Name=org.kde.plastile.State" in text, {"result": inst, "service": redact(text, kw)})
        c("install-helper asked the session's own bus to re-read its service files",
          "re-read its service files" in inst["stdout"], inst["stdout"][-400:])
        c("install-helper with no helper on the bus: nothing is running now", "nothing is running now" in inst["stdout"],
          inst["stdout"][-400:])
        status = run("status")
        c("status after install: helper installed, at the path with the space",
          f"helper    : installed ({redact(str(exe), kw)}, " in status["stdout"], status["stdout"][-600:])
        s.spawn(1); s.spawn(2)
        off = kw.mark()
        s.load()
        line = kw.wait_log(r"plastile (info|warn) (saved state|no saved state|persistence unavailable)", 10, off)[-1]
        c("Plastile reaches the installed helper through D-Bus activation (no saved state yet, no diagnostic)",
          "no saved state" in line, line)
        s.settle()
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        s.cmd("resize.grow")
        g = wait_generation(s, base, 1, 6)
        c("a save lands through the installed helper (generation 1 in the state directory)", g == 1, {"generation": g})
        reinst = run("install-helper")
        c("install-helper over the running helper: rc 0, and it says that helper keeps serving until KWin exits",
          reinst["rc"] == 0 and "keeps serving this session until\nKWin exits" in reinst["stdout"]
          and "nothing is running now" not in reinst["stdout"], reinst["stdout"][-400:])
        s.unload()
        rm = run("remove-helper")
        c("remove-helper: rc 0, the activation file and the binary are gone, the saved state is kept",
          rm["rc"] == 0 and not service.exists() and not exe.exists() and newest(base) is not None, rm)
        after = run("status")
        c("status after remove: helper not installed", "helper    : not installed" in after["stdout"], after["stdout"][-600:])
        again = run("remove-helper")
        c("remove-helper again: refuses with rc 2 (nothing installed)", again["rc"] == 2, again)
        leftovers = sorted(str(p.relative_to(prefix)) for p in prefix.rglob("*") if p.is_file()) if prefix.exists() else []
        c("nothing else was installed into the prefix", leftovers == [], leftovers)


OWN_UI = ("Plastile inspector", "Replaced inspector", "Plastile zones")  # adapter.ts OWN_UI_TITLE, ZONES_UI_TITLE


def own_captions(s: Session) -> list[str]:
    return json.loads(s.js(f"emit(workspace.windowList().map(w => w.caption).filter(t => {json.dumps(OWN_UI)}.includes(t)));")[0])


def until(pred, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return False


@scenario("package-files-replaced-T32")
def files_replaced(out: Path, c: Checks):
    """A loaded Plastile keeps the inspector and the zones overlay of the version it loaded, as it keeps main.qml
    and the bundle, when an upgrade or a removal changes the package files while it runs. The package is a copy in
    the output directory: after load, Inspector.qml is replaced by a variant with another caption (an upgrade to a
    version whose inspector differs) and ZoneOverlay.qml is deleted (a removal); both are then opened for the first
    time. Before main.qml compiled them with itself, the first use read the files on disk."""
    pkg = out / "package"
    if pkg.exists():
        shutil.rmtree(pkg)
    shutil.copytree(ROOT / "package", pkg)
    ui = pkg / "contents/ui"
    with Session(out / "session", config={"layout": "zones"}, qml=ui / "main.qml") as s:
        s.spawn(1)
        s.load()
        s.settle()
        inspector = ui / "Inspector.qml"
        text = inspector.read_text()
        c("setup: the inspector's caption comes from its view", "title: view.windowTitle" in text)
        inspector.write_text(text.replace("title: view.windowTitle", 'title: "Replaced inspector"'))
        (ui / "ZoneOverlay.qml").unlink()
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        s.cmd("inspect.explain-window")
        until(lambda: own_captions(s) != [], 5.0)
        time.sleep(0.3)
        got = own_captions(s)
        c("the inspector opened is the loaded version's, not the replaced file (oracle: KWin's window list)",
          got == ["Plastile inspector"], got)
        s.cmd("inspect.explain-window")
        until(lambda: own_captions(s) == [], 3.0)
        s.cmd("zone.show")
        until(lambda: len(own_captions(s)) == 2, 5.0)
        time.sleep(0.3)
        got = own_captions(s)
        state = s.counters().get("zoneOverlay")
        c("the zones overlay and its legend appear although ZoneOverlay.qml was removed (oracle)",
          got == ["Plastile zones", "Plastile zones"] and state == "shown", {"windows": got, "state": state})
        s.cmd("zone.show")
        s.unload()
        # "No such file" only next to a QML path: PipeWire logs a missing client.conf in the same journal.
        errs = s.log_lines(r"Inspector\.qml|ZoneOverlay\.qml|\.qml\b.*No such file|TypeError|ReferenceError")
        c("no QML load errors or JS exceptions", not errs, errs[:5])
