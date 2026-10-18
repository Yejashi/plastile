"""Correlation against fixture logs recorded in a nested KWin 6.7.5 (tools/physical/tests/data/).

The data are trimmed slices of a nested dry run (tools/physical/nested_dryrun.py --rebind-ratio,
Ubuntu 26.10 sandbox, virtual backend, QPainter, 60 Hz synthetic timeline, libei input). They
check that the correlator understands what the real fixture and the real KWin emit; they are
not physical measurements.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import common  # noqa: E402
import latency  # noqa: E402

DATA = HERE / "data"
# workload -> windows a sample is expected to touch (3 fixtures were open)
EXPECTED_AFFECTED = {"P00-maximize": {1}, "P02-quicktile": {1}, "P00-switch": {2}, "P03-ratio": {3},
                     "P03-swap": {2}, "P03-focus": {2}}


def load(name: str):
    meta = json.loads((DATA / f"{name}.block.json").read_text())
    taps = common.read_jsonl(DATA / f"{name}.taps.jsonl")
    windows = [latency.load_fixture(p.name.split(".")[1], common.read_jsonl(p))
               for p in sorted(DATA.glob(f"{name}.fixture-*.jsonl"))]
    return meta, taps, windows


class RecordedNestedLogs(unittest.TestCase):
    def test_every_recorded_workload_correlates(self):
        names = sorted(p.name[: -len(".block.json")] for p in DATA.glob("*.block.json"))
        self.assertEqual(len(names), 6, names)
        for name in names:
            with self.subTest(name=name):
                meta, taps, windows = load(name)
                self.assertTrue(all(w.clock_ok for w in windows), "fixture reported a non-monotonic presentation clock")
                results = latency.correlate(taps, windows, expect=meta["expect"],
                                            refresh_ns_declared=meta["refreshNsObservedAtStart"])
                # The last tap's window was cut by the export; judge the others.
                for r in results[:-1]:
                    self.assertTrue(r["success"], r)
                    self.assertIn(r["affectedWindowCount"], EXPECTED_AFFECTED[meta["workload"]], r)
                    self.assertGreater(r["inputToFirstPresentNs"], 0)
                    self.assertLess(r["inputToFirstPresentNs"], 200_000_000)
                    self.assertGreaterEqual(r["inputToSettledNs"], r["inputToFirstPresentNs"])
                    self.assertLessEqual(r["configureNs"], r["commitNs"])
                    self.assertEqual(r["refreshNsObserved"], meta["refreshNsObservedAtStart"])
                    # presentation lands after the commit it reports
                    self.assertGreaterEqual(r["inputToFirstPresentNs"], r["commitNs"])

    def test_records_from_recorded_logs_validate(self):
        meta, taps, windows = load("nested-P03-swap")
        for r in latency.correlate(taps, windows, expect=meta["expect"]):
            rec = latency.to_record(r, {"runId": "x", "environmentId": "nested-virtual-kwin", "layer": "nested-dry-run",
                                        "inputSource": "libei", "workload": meta["workload"], "condition": "plastile",
                                        "sample": 0})
            self.assertEqual(latency.validate_record(rec), [])

    def test_wrong_expectation_is_detected_on_real_logs(self):
        # Focus-next configures carry activation changes but no size change.
        meta, taps, windows = load("nested-P03-focus")
        results = latency.correlate(taps, windows, expect="resize")
        self.assertFalse(any(r["success"] for r in results))

    def test_present_grid_on_virtual_60hz(self):
        meta, _taps, windows = load("nested-P03-ratio")
        g = latency.present_grid(windows, meta["refreshNsObservedAtStart"])
        self.assertEqual(g["alignedFraction"], 1.0)


if __name__ == "__main__":
    unittest.main()
