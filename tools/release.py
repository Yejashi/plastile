#!/usr/bin/env python3
"""Build the distributable KWin script package, dist/plastile-<version>.kwinscript, the optional
Plastile Motion effect package, dist/plastile_motion-<version>.zip (ADR-023), and the persistence
helper's source tarball, dist/plastile-state-<version>.tar.gz (ADR-020).

The .kwinscript is script-only: a plain zip that `kpackagetool6 --type KWin/Script --install`
accepts, `metadata.json` at the zip root plus `contents/...`, nothing else (checked). With it
alone Plastile works and keeps its preferences in memory. The effect is a separate KWin/Effect
package (`kpackagetool6 --type KWin/Effect --install`), with the same version, metadata.json at its
zip root and contents/... only; KWin keeps it disabled until the user enables it. The helper is
built from the tarball (or the repository) with CMake; tools/install.sh install-helper does that.
Both zips are built deterministically:

- entries sorted by path, directories omitted;
- every entry's mtime is 1980-01-01 00:00:00 (the zip epoch), or the value of
  SOURCE_DATE_EPOCH when set (clamped to the zip epoch);
- no extra fields, fixed external attributes (0644 regular file), create_system 3;
- DEFLATE level 9 on every entry (the same zlib produces the same bytes).

The version is read from package/metadata.json (KPlugin.Version). Required entries
are verified before writing and the file's SHA-256 is printed. Running it twice
yields identical bytes. The tarball follows the same rules: sorted ustar entries under
plastile-state-<version>/, the same mtime, uid/gid 0, mode 0644, gzip level 9 with no file
name and mtime in its header. --check proves both against a perturbed rebuild: copies of the
package, the effect and the helper sources with different file mtimes and modes, built in a
separate process with a different umask and time zone, must produce the same bytes.

Usage: python3 tools/release.py [--out DIR] [--check] [--json] [--package DIR] [--helper DIR] [--effect DIR]
"""
from __future__ import annotations

import argparse
import calendar
import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "package"
HELPER = ROOT / "helper"
EFFECT = ROOT / "effect"
EFFECT_ID = "plastile_motion"
# What KWin's scripted-effect loader reads (main.js) and its generic configuration module (main.xml, config.ui).
EFFECT_REQUIRED = ("metadata.json", "contents/code/main.js", "contents/config/main.xml", "contents/ui/config.ui")
# The helper sources a build needs (helper/CMakeLists.txt lists them); the tarball holds exactly these.
HELPER_FILES = ("CMakeLists.txt", "README.md", "main.cpp", "org.kde.plastile.State.service.in", "stateservice.cpp", "stateservice.h")
REQUIRED = (
    "metadata.json",
    "contents/ui/main.qml",
    # Loaded by main.qml at runtime (Loader.setSource / the persistence item): a zip without
    # them installs and starts, then fails only when the inspector, persistence or overlay is used.
    "contents/ui/Inspector.qml",
    "contents/ui/Persistence.qml",
    "contents/ui/ZoneOverlay.qml",
    "contents/ui/config.ui",
    "contents/config/main.xml",
    "contents/code/plastile.mjs",
)
# Files that may exist in the working tree but never belong in a release.
EXCLUDED_NAMES = {".DS_Store", "Thumbs.db"}
EXCLUDED_SUFFIXES = (".map", ".swp", "~", ".orig", ".rej")
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)


class ReleaseError(RuntimeError):
    pass


def read_version(metadata: Path = PACKAGE / "metadata.json") -> str:
    data = json.loads(metadata.read_text(encoding="utf-8"))
    try:
        version = data["KPlugin"]["Version"]
    except KeyError as exc:
        raise ReleaseError(f"{metadata}: missing KPlugin.Version") from exc
    if not isinstance(version, str) or not version or "/" in version or " " in version:
        raise ReleaseError(f"{metadata}: unusable version {version!r}")
    if data.get("KPackageStructure") != "KWin/Script":
        raise ReleaseError(f"{metadata}: KPackageStructure must be KWin/Script")
    return version


def source_date() -> tuple:
    raw = os.environ.get("SOURCE_DATE_EPOCH")
    if not raw:
        return ZIP_EPOCH
    try:
        epoch = int(raw)
    except ValueError as exc:
        raise ReleaseError(f"SOURCE_DATE_EPOCH is not an integer: {raw!r}") from exc
    t = time.gmtime(max(epoch, 315532800))  # zip cannot store dates before 1980
    return (t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec)


def read_effect_version(metadata: Path = EFFECT / "metadata.json") -> str:
    data = json.loads(metadata.read_text(encoding="utf-8"))
    if data.get("KPackageStructure") != "KWin/Effect" or data.get("X-Plasma-API") != "javascript":
        raise ReleaseError(f"{metadata}: must be a KWin/Effect package with X-Plasma-API javascript")
    if data.get("KPlugin", {}).get("Id") != EFFECT_ID:
        raise ReleaseError(f"{metadata}: KPlugin.Id must be {EFFECT_ID!r}")
    if data["KPlugin"].get("EnabledByDefault") is not False:
        raise ReleaseError(f"{metadata}: the effect must be disabled by default (EnabledByDefault false)")
    return str(data["KPlugin"].get("Version", ""))


def collect_entries(package: Path = PACKAGE, required: tuple[str, ...] = REQUIRED) -> list[tuple[str, Path]]:
    """All regular files below the package directory, sorted by archive name."""
    entries: list[tuple[str, Path]] = []
    for path in package.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        if path.name in EXCLUDED_NAMES or path.name.endswith(EXCLUDED_SUFFIXES):
            continue
        arc = path.relative_to(package).as_posix()
        entries.append((arc, path))
    entries.sort(key=lambda e: e[0])
    names = {arc for arc, _ in entries}
    missing = [r for r in required if r not in names]
    if missing:
        hint = " (run `npm run build`)" if "contents/code/plastile.mjs" in missing else ""
        raise ReleaseError("package is missing required entries: " + ", ".join(missing) + hint)
    return entries


def build_bytes(entries: list[tuple[str, Path]], date_time: tuple) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for arc, path in entries:
            info = zipfile.ZipInfo(arc, date_time=date_time)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # Unix
            info.external_attr = (0o100644 & 0xFFFF) << 16
            info.extra = b""
            info.comment = b""
            zf.writestr(info, path.read_bytes(), compresslevel=9)
    return buf.getvalue()


def verify_zip(data: bytes, required_entries: tuple[str, ...] = REQUIRED, plugin_id: str = "plastile") -> list[str]:
    """Re-open the produced archive and check the entries kpackagetool6 relies on."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        bad = zf.testzip()
        if bad is not None:
            raise ReleaseError(f"corrupt entry in archive: {bad}")
        names = zf.namelist()
        for required in required_entries:
            if required not in names:
                raise ReleaseError(f"archive is missing {required}")
        # Script-only: the helper is never inside the KWin package (ADR-020).
        stray = [n for n in names if n != "metadata.json" and not n.startswith("contents/")]
        if stray:
            raise ReleaseError(f"archive holds entries outside contents/: {', '.join(stray[:5])}")
        if names != sorted(names):
            raise ReleaseError("archive entries are not sorted")
        for info in zf.infolist():
            if info.extra:
                raise ReleaseError(f"{info.filename}: unexpected extra field")
        meta = json.loads(zf.read("metadata.json").decode("utf-8"))
        if meta.get("KPlugin", {}).get("Id") != plugin_id:
            raise ReleaseError(f"metadata.json KPlugin.Id is not {plugin_id!r}")
        return names


def helper_tarball_bytes(helper: Path, version: str, date_time: tuple) -> bytes:
    """The helper's source tarball, deterministic like the zip."""
    missing = [f for f in HELPER_FILES if not (helper / f).is_file()]
    if missing:
        raise ReleaseError("helper sources missing: " + ", ".join(missing))
    stamp = calendar.timegm(date_time + (0, 0, 0))
    prefix = f"plastile-state-{version}"
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name in sorted(HELPER_FILES):
            data = (helper / name).read_bytes()
            info = tarfile.TarInfo(f"{prefix}/{name}")
            info.size, info.mtime, info.mode = len(data), stamp, 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=out, compresslevel=9, mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def build(out_dir: Path, package: Path = PACKAGE, helper: Path = HELPER, effect: Path = EFFECT) -> dict:
    version = read_version(package / "metadata.json")
    entries = collect_entries(package)
    date = source_date()
    data = build_bytes(entries, date)
    names = verify_zip(data)
    tarball = helper_tarball_bytes(helper, version, date)
    effect_version = read_effect_version(effect / "metadata.json")
    if effect_version != version:
        raise ReleaseError(f"effect version {effect_version!r} differs from the script's {version!r}")
    effect_data = build_bytes(collect_entries(effect, EFFECT_REQUIRED), date)
    effect_names = verify_zip(effect_data, EFFECT_REQUIRED, EFFECT_ID)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"plastile-{version}.kwinscript"
    write_atomic(out, data)
    tar_out = out_dir / f"plastile-state-{version}.tar.gz"
    write_atomic(tar_out, tarball)
    effect_out = out_dir / f"{EFFECT_ID}-{version}.zip"
    write_atomic(effect_out, effect_data)
    return {
        "path": str(out),
        "version": version,
        "entries": names,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "helperTarball": {"path": str(tar_out), "bytes": len(tarball), "sha256": hashlib.sha256(tarball).hexdigest(),
                          "files": sorted(HELPER_FILES)},
        "effect": {"path": str(effect_out), "bytes": len(effect_data), "sha256": hashlib.sha256(effect_data).hexdigest(),
                   "entries": effect_names},
    }


def perturbed_rebuild_sha256(package: Path = PACKAGE, helper: Path = HELPER, effect: Path = EFFECT) -> tuple[str, str, str]:
    """Build copies of `package`, `helper` and `effect` whose metadata differs in everything the archives
    must not depend on (mtimes, permission bits, umask, time zone), in a separate interpreter.
    Returns the script zip's, the tarball's and the effect zip's SHA-256."""
    with tempfile.TemporaryDirectory(prefix="plastile-release-check-") as tmp:
        copy, hcopy, ecopy = Path(tmp) / "package", Path(tmp) / "helper", Path(tmp) / "effect"
        shutil.copytree(package, copy)
        shutil.copytree(helper, hcopy)
        shutil.copytree(effect, ecopy)
        files = (sorted(p for p in copy.rglob("*") if p.is_file()) + sorted(p for p in hcopy.rglob("*") if p.is_file())
                 + sorted(p for p in ecopy.rglob("*") if p.is_file()))
        for i, path in enumerate(files):
            os.chmod(path, 0o755 if i % 2 else 0o600)
            stamp = 1_000_000_000 + 7919 * i  # 2001, distinct per file
            os.utime(path, (stamp, stamp))
        env = {**os.environ, "TZ": "Pacific/Kiritimati"}
        r = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--package", str(copy), "--helper", str(hcopy),
             "--effect", str(ecopy), "--out", str(Path(tmp) / "out"), "--json"], env=env, capture_output=True, text=True,
            preexec_fn=lambda: os.umask(0o077))
        if r.returncode != 0:
            raise ReleaseError(f"perturbed rebuild failed: {r.stderr.strip()}")
        res = json.loads(r.stdout)
        return res["sha256"], res["helperTarball"]["sha256"], res["effect"]["sha256"]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "dist"), help="output directory (default: dist/)")
    ap.add_argument("--check", action="store_true",
                    help="also build a perturbed copy in a separate process and fail unless the bytes match")
    ap.add_argument("--json", action="store_true", help="print the result as JSON")
    ap.add_argument("--package", default=str(PACKAGE), help=argparse.SUPPRESS)
    ap.add_argument("--helper", default=str(HELPER), help=argparse.SUPPRESS)
    ap.add_argument("--effect", default=str(EFFECT), help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    try:
        result = build(Path(args.out), Path(args.package), Path(args.helper), Path(args.effect))
        if args.check:
            zip_sha, tar_sha, effect_sha = perturbed_rebuild_sha256(Path(args.package), Path(args.helper), Path(args.effect))
            result["reproducible"] = (zip_sha == result["sha256"] and tar_sha == result["helperTarball"]["sha256"]
                                      and effect_sha == result["effect"]["sha256"])
            if not result["reproducible"]:
                raise ReleaseError("a rebuild with different mtimes, modes, umask and time zone produced different bytes")
    except ReleaseError as exc:
        print(f"release: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, indent=1))
    else:
        print(f"{result['path']}  ({result['bytes']} bytes, {len(result['entries'])} entries)")
        print(f"sha256 {result['sha256']}")
        t = result["helperTarball"]
        print(f"{t['path']}  ({t['bytes']} bytes, {len(t['files'])} files)")
        print(f"sha256 {t['sha256']}")
        e = result["effect"]
        print(f"{e['path']}  ({e['bytes']} bytes, {len(e['entries'])} entries)")
        print(f"sha256 {e['sha256']}")
        if args.check:
            print("reproducible: identical bytes from a rebuild with different mtimes, modes, umask and time zone")
    return 0


if __name__ == "__main__":
    sys.exit(main())
