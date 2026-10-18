#!/usr/bin/env python3
"""Control run: load/unload an empty declarative script N times; record KWin RSS.

Compare its trend with probes/lifecycle/run.py to attribute reload memory growth.
Usage: python3 probes/lifecycle/control.py [--cycles N] [--package empty|shortcut] [--spawn-window]
  --package shortcut  : a script with only a ShortcutHandler (no connections)
  --spawn-window      : also add and remove a fixture window each cycle, as run.py does
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from nested import NestedKwin  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cycles", type=int, default=300)
    ap.add_argument("--package", choices=("empty", "shortcut"), default="empty")
    ap.add_argument("--spawn-window", action="store_true")
    args = ap.parse_args()
    tag = f"{args.package}{'-churn' if args.spawn_window else ''}-control"
    out = ROOT / "artifacts/lifecycle" / f"{time.strftime('%Y%m%dT%H%M%S')}-{tag}"
    qml = HERE / f"{args.package}-package/contents/ui/main.qml"
    fixture = [str(ROOT / "fixtures/client/build/plastile-fixture")]
    rss = []
    with NestedKwin(out) as kw:
        kw.spawn(fixture)
        time.sleep(1.0)
        base = kw.kwin_rss_kib()
        parts = [kw.kwin_rss_parts_kib()]
        for i in range(args.cycles):
            kw.load_declarative(qml, "plt-empty")
            time.sleep(0.05)
            kw.unload("plt-empty")
            deadline = time.monotonic() + 5
            while kw.is_loaded("plt-empty") and time.monotonic() < deadline:
                time.sleep(0.01)
            if args.spawn_window:
                extra = kw.spawn(fixture)
                time.sleep(0.5)
                extra.terminate()
                extra.wait(timeout=5)
                time.sleep(0.4)
            else:
                time.sleep(0.9)  # match the lifecycle probe's per-cycle wall time roughly
            rss.append(kw.kwin_rss_kib())
        parts.append(kw.kwin_rss_parts_kib())
    summary = {"partsFirstLast": parts, "cycles": args.cycles, "package": args.package, "spawnWindow": args.spawn_window, "baselineRssKiB": base, "finalRssKiB": rss[-1],
               "rssKiBByCycle": rss[:: max(1, len(rss) // 10)]}
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
