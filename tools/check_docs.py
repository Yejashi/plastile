#!/usr/bin/env python3
"""Check planning-document links, source pins, and backlog coverage offline."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
ERRORS: list[str] = []


def fail(message: str) -> None:
    ERRORS.append(message)


def without_fences(text: str) -> str:
    return re.sub(r"^```[^\n]*\n.*?^```\s*$", "", text, flags=re.M | re.S)


def heading_anchors(text: str) -> set[str]:
    anchors: set[str] = set()
    counts: dict[str, int] = {}
    for title in re.findall(r"^#{1,6}\s+(.+?)\s*#*\s*$", without_fences(text), re.M):
        title = re.sub(r"[`*_]", "", title).lower()
        slug = "".join(c for c in title if c.isalnum() or c in " -_").replace(" ", "-")
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        anchors.add(slug if count == 0 else f"{slug}-{count}")
    return anchors


def check_links(path: Path) -> int:
    count = 0
    for match in re.finditer(r"!?\[[^\]]*\]\(([^\s)]+)(?:\s+\"[^\"]*\")?\)", without_fences(path.read_text())):
        target = match.group(1)
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc:
            continue
        count += 1
        dest = (path.parent / unquote(parsed.path)).resolve() if parsed.path else path
        if not dest.is_relative_to(ROOT):
            fail(f"{path.relative_to(ROOT)}: link escapes repository: {target}")
        elif not dest.exists():
            fail(f"{path.relative_to(ROOT)}: missing target: {target}")
        elif parsed.fragment and dest.suffix == ".md":
            if unquote(parsed.fragment) not in heading_anchors(dest.read_text()):
                fail(f"{path.relative_to(ROOT)}: missing anchor: {target}")
    return count


def main() -> int:
    markdown = sorted(ROOT.rglob("*.md"))
    # Skip VCS data and local-only trees (agent worktrees, dependencies, generated results).
    local = {".git", ".claude", "node_modules", "artifacts"}
    markdown = [p for p in markdown if not local & set(p.relative_to(ROOT).parts)]
    link_count = sum(check_links(path) for path in markdown)
    lock = json.loads((ROOT / "docs/research/sources.lock.json").read_text())
    repositories = lock["repositories"]
    inventory: set[tuple[str, str, str]] = set()
    acquired = 0
    for repo in repositories:
        for file in repo["acquiredFiles"]:
            acquired += 1
            for field in ("ref", "blob"):
                if not re.fullmatch(r"[0-9a-f]{40}", file[field]):
                    fail(f"Invalid source {field}: {repo['repository']}/{file['path']}")
            inventory.add((repo["repository"], file["ref"], file["path"]))
    for evidence_id, evidence in lock["evidence"].items():
        key = (evidence["repository"], evidence["commit"], evidence["path"])
        if key not in inventory:
            fail(f"Evidence absent from acquired inventory: {evidence_id}")
        expected_url = f"https://github.com/{key[0]}/blob/{key[1]}/{key[2]}"
        if evidence["url"] != expected_url:
            fail(f"Non-pinned/mismatched evidence URL: {evidence_id}")
    if len(repositories) != 14 or acquired != 535:
        fail(f"Source coverage changed: {len(repositories)} repositories, {acquired} files")
    backlog = (ROOT / "docs/implementation/BACKLOG.md").read_text()
    task_ids = re.findall(r"^## (T\d{2})\s", backlog, re.M)
    expected_ids = [f"T{i:02d}" for i in range(38)]
    if task_ids != expected_ids:
        fail("Backlog must contain exactly T00 through T37 in order")
    for i, block in enumerate(re.split(r"^## T\d{2}\s[^\n]*\n", backlog, flags=re.M)[1:]):
        if not all(token in block for token in ("**Milestone:", "**Depends on:", "**Acceptance:")):
            fail(f"Task T{i:02d} lacks milestone, dependencies, or acceptance criteria")
    if ERRORS:
        print("\n".join(ERRORS), file=sys.stderr)
        return 1
    words = sum(len(path.read_text().split()) for path in markdown)
    print(f"PASS: {len(markdown)} Markdown files, {link_count} local links, "
          f"{len(lock['evidence'])} pinned evidence entries, {acquired} acquired source records, "
          f"38 task cards, approximately {words:,} Markdown words.")
    print("This is a documentation integrity check, not an implementation or runtime benchmark.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
