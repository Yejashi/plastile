#!/usr/bin/env python3
"""Build the distributable KWin script package: dist/plastile-<version>.kwinscript.

The output is a plain zip that `kpackagetool6 --type KWin/Script --install` accepts:
`metadata.json` at the zip root plus `contents/...`. It is built deterministically:

- entries sorted by path, directories omitted;
- every entry's mtime is 1980-01-01 00:00:00 (the zip epoch), or the value of
  SOURCE_DATE_EPOCH when set (clamped to the zip epoch);
- no extra fields, fixed external attributes (0644 regular file), create_system 3;
- DEFLATE level 9 on every entry (the same zlib produces the same bytes).

The version is read from package/metadata.json (KPlugin.Version). Required entries
are verified before writing and the file's SHA-256 is printed. Running it twice
yields identical bytes. --check proves it against a perturbed rebuild: a copy of the
package with different file mtimes and modes, built in a separate process with a
different umask and time zone, must produce the same bytes.

Usage: python3 tools/release.py [--out DIR] [--check] [--json] [--package DIR]
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "package"
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


def collect_entries(package: Path = PACKAGE) -> list[tuple[str, Path]]:
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
    missing = [r for r in REQUIRED if r not in names]
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


def verify_zip(data: bytes) -> list[str]:
    """Re-open the produced archive and check the entries kpackagetool6 relies on."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        bad = zf.testzip()
        if bad is not None:
            raise ReleaseError(f"corrupt entry in archive: {bad}")
        names = zf.namelist()
        for required in REQUIRED:
            if required not in names:
                raise ReleaseError(f"archive is missing {required}")
        if names != sorted(names):
            raise ReleaseError("archive entries are not sorted")
        for info in zf.infolist():
            if info.extra:
                raise ReleaseError(f"{info.filename}: unexpected extra field")
        meta = json.loads(zf.read("metadata.json").decode("utf-8"))
        if meta.get("KPlugin", {}).get("Id") != "plastile":
            raise ReleaseError("metadata.json KPlugin.Id is not 'plastile'")
        return names


def build(out_dir: Path, package: Path = PACKAGE) -> dict:
    version = read_version(package / "metadata.json")
    entries = collect_entries(package)
    data = build_bytes(entries, source_date())
    names = verify_zip(data)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"plastile-{version}.kwinscript"
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, out)
    return {
        "path": str(out),
        "version": version,
        "entries": names,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def perturbed_rebuild_sha256(package: Path = PACKAGE) -> str:
    """Build a copy of `package` whose metadata differs in everything the archive must not
    depend on (mtimes, permission bits, umask, time zone), in a separate interpreter."""
    with tempfile.TemporaryDirectory(prefix="plastile-release-check-") as tmp:
        copy = Path(tmp) / "package"
        shutil.copytree(package, copy)
        for i, path in enumerate(sorted(p for p in copy.rglob("*") if p.is_file())):
            os.chmod(path, 0o755 if i % 2 else 0o600)
            stamp = 1_000_000_000 + 7919 * i  # 2001, distinct per file
            os.utime(path, (stamp, stamp))
        env = {**os.environ, "TZ": "Pacific/Kiritimati"}
        r = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--package", str(copy), "--out", str(Path(tmp) / "out"),
             "--json"], env=env, capture_output=True, text=True, preexec_fn=lambda: os.umask(0o077))
        if r.returncode != 0:
            raise ReleaseError(f"perturbed rebuild failed: {r.stderr.strip()}")
        return json.loads(r.stdout)["sha256"]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "dist"), help="output directory (default: dist/)")
    ap.add_argument("--check", action="store_true",
                    help="also build a perturbed copy in a separate process and fail unless the bytes match")
    ap.add_argument("--json", action="store_true", help="print the result as JSON")
    ap.add_argument("--package", default=str(PACKAGE), help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    try:
        result = build(Path(args.out), Path(args.package))
        if args.check:
            result["reproducible"] = perturbed_rebuild_sha256(Path(args.package)) == result["sha256"]
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
        if args.check:
            print("reproducible: identical bytes from a rebuild with different mtimes, modes, umask and time zone")
    return 0


if __name__ == "__main__":
    sys.exit(main())
