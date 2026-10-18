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

from scenarios import scenario, Checks, three  # noqa: F401
from harness import Session, delta, evidence_file, near, tiling_errors, Input, centre, ROOT, PLUGIN  # noqa: F401

sys.path.insert(0, str(ROOT / "tools"))
import release  # noqa: E402
from nested import NestedKwin  # noqa: E402

INSTALL = ROOT / "tools/install.sh"
EVIDENCE = evidence_file("package-install.json")
STARTED = r"plastile info started "
STOPPED = r"plastile info stopped"


def redact(text: str, kw: NestedKwin | None = None) -> str:
    """Strip session/home/repo paths so evidence carries no absolute private paths."""
    if kw is not None:
        text = text.replace(str(kw.root), "<session>")
    text = text.replace(str(ROOT), "<repo>")
    home = str(Path.home())
    if home and home != "/":
        text = text.replace(home, "<home>")
    return text


def _kwinrc_hash(kw: NestedKwin) -> str:
    path = kw.root / "config/kwinrc"
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else "absent"


def sh(kw: NestedKwin, *args: str) -> dict:
    """Run tools/install.sh inside the nested session's environment (XDG_DATA_HOME etc.).

    kwinrc is hashed immediately before and after: the installer must never write it.
    """
    before = _kwinrc_hash(kw)
    r = subprocess.run(["sh", str(INSTALL), *args], env=kw.env(), capture_output=True, text=True, timeout=60)
    return {"argv": ["tools/install.sh", *[redact(a, kw) for a in args]], "rc": r.returncode,
            "stdout": redact(r.stdout, kw), "stderr": redact(r.stderr, kw),
            "kwinrcUnchanged": before == _kwinrc_hash(kw)}


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
                             kwinrc=kwinrc_text(enabled), prepare=self._prepare if zip_path else None)

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
        c("install.sh left kwinrc untouched (hash before == after, taken before KWin started)",
          pr.get("kwinrcUnchanged") is True, None)

        # Autoload: nobody called loadDeclarativeScript; KWin itself must have started the package.
        try:
            lines = kw.wait_log(STARTED, 30, 0)
            autoload = True
        except Exception as exc:  # noqa: BLE001
            lines, autoload = [str(exc)], False
        c("autoload: 'plastile info started' observed after KWin start without manual load", autoload, lines[:1])
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
        c("disable: kwinrc plastileEnabled=false + Scripting.start -> 'plastile info stopped'", bool(stopped), stopped[:1])
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
        c("re-enable after upgrade: 'plastile info started' again", bool(restarted), restarted[:1])
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
