"""Correlation logic and raw-record schema (synthetic logs; no desktop)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import latency  # noqa: E402
from synth import MS, REFRESH_60, FakeFixture, tap  # noqa: E402

CTX = {"runId": "r1", "environmentId": "synthetic", "layer": "synthetic", "inputSource": "test", "workload": "P03-ratio",
       "condition": "plastile", "sample": 0, "implementationCommit": "0" * 40, "clockResolutionNs": 1}


def windows(*fixtures: FakeFixture) -> list[latency.Window]:
    return [latency.load_fixture(f.name, f.events) for f in fixtures]


class CorrelateTests(unittest.TestCase):
    def test_first_present_and_settled_over_two_windows(self):
        t0 = 2_000 * MS
        a, b = FakeFixture("a"), FakeFixture("b", activated=False)
        a.configure(t0 + 2 * MS, 600, 300, present_after=5 * MS)   # presented t0+7.2ms
        b.configure(t0 + 3 * MS, 200, 300, present_after=20 * MS)  # presented t0+23.2ms
        [r] = latency.correlate([tap(1, t0)], windows(a, b), expect="resize", refresh_ns_declared=REFRESH_60)
        self.assertTrue(r["success"], r)
        self.assertEqual(r["affectedWindowCount"], 2)
        self.assertEqual(r["configureNs"], 2 * MS)
        self.assertEqual(r["commitNs"], 2 * MS + 200_000)
        self.assertEqual(r["inputToFirstPresentNs"], 7 * MS + 200_000)
        self.assertEqual(r["inputToSettledNs"], 23 * MS + 200_000)
        self.assertEqual(r["inputWriteNs"], 20_000)
        self.assertEqual(r["refreshNsObserved"], REFRESH_60)

    def test_settled_uses_last_configure_per_window(self):
        t0 = 2_000 * MS
        a = FakeFixture("a")
        a.configure(t0 + 1 * MS, 500, 300, present_after=None)       # superseded, never presented
        a.configure(t0 + 9 * MS, 520, 300, present_after=8 * MS)     # final
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="resize")
        self.assertTrue(r["success"])
        self.assertEqual(r["inputToFirstPresentNs"], 17 * MS + 200_000)
        self.assertEqual(r["inputToSettledNs"], 17 * MS + 200_000)
        self.assertEqual(r["configureCount"], 2)

    def test_window_ends_at_next_tap(self):
        t0, t1 = 2_000 * MS, 2_100 * MS
        a = FakeFixture("a")
        a.configure(t0 + 2 * MS, 500, 300)
        a.configure(t1 + 2 * MS, 400, 300)
        r0, r1 = latency.correlate([tap(1, t0), tap(2, t1)], windows(a), expect="resize")
        self.assertEqual(r0["configureCount"], 1)
        self.assertEqual(r1["configureCount"], 1)
        self.assertEqual(r1["configureNs"], 2 * MS)
        self.assertGreater(r1["quietBeforeNs"], 90 * MS)

    def test_no_configure_is_a_failure_with_reason(self):
        a = FakeFixture("a")
        [r] = latency.correlate([tap(1, 5_000 * MS)], windows(a), expect="resize")
        self.assertFalse(r["success"])
        self.assertIn("no configure", r["failureReason"])
        self.assertIsNone(r["inputToFirstPresentNs"])
        self.assertEqual(r["presentationUnavailableReason"], "no configure attributed to this input")

    def test_configure_without_size_change_is_not_a_resize(self):
        t0 = 2_000 * MS
        a = FakeFixture("a")
        a.configure(t0 + 2 * MS, 400, 300, activated=False)   # activation-only configure
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="resize")
        self.assertFalse(r["success"])
        self.assertIn("no resize effect", r["failureReason"])
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="activate")
        self.assertTrue(r["success"], r)

    def test_zero_size_configure_means_client_keeps_its_size(self):
        t0 = 2_000 * MS
        a = FakeFixture("a")
        a.configure(t0 + 2 * MS, 0, 0)
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="resize")
        self.assertFalse(r["success"])

    def test_discarded_final_commit_fails_settle(self):
        t0 = 2_000 * MS
        a = FakeFixture("a")
        a.configure(t0 + 2 * MS, 600, 300, discard=True)
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="resize")
        self.assertFalse(r["success"])
        self.assertIn("discarded", r["failureReason"])
        self.assertEqual(r["discardedCount"], 1)

    def test_unacked_configure_fails_settle(self):
        t0 = 2_000 * MS
        a = FakeFixture("a")
        a.configure(t0 + 2 * MS, 600, 300, ack=False)
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="resize")
        self.assertFalse(r["success"])
        self.assertIn("never acked", r["failureReason"])

    def test_refresh_mismatch_means_wrong_output(self):
        t0 = 2_000 * MS
        a = FakeFixture("a", refresh_ns=6_944_444)  # 144 Hz
        a.configure(t0 + 2 * MS, 600, 300)
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="resize", refresh_ns_declared=REFRESH_60)
        self.assertFalse(r["success"])
        self.assertIn("another output", r["failureReason"])
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="resize", refresh_ns_declared=6_944_444)
        self.assertTrue(r["success"])

    def test_presentation_clock_must_be_log_clock(self):
        t0 = 2_000 * MS
        a = FakeFixture("a", same_clock=False)
        a.configure(t0 + 2 * MS, 600, 300)
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="resize")
        self.assertFalse(r["success"])
        self.assertIsNone(r["inputToFirstPresentNs"])
        self.assertIn("presentation clock", r["presentationUnavailableReason"])

    def test_presentation_before_input_is_a_clock_error(self):
        t0 = 2_000 * MS
        a = FakeFixture("a")
        a.configure(t0 + 2 * MS, 600, 300, present_after=-10 * MS)
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="resize")
        self.assertFalse(r["success"])
        self.assertIn("clock-domain", r["failureReason"])

    def test_child_window_events_are_ignored(self):
        t0 = 2_000 * MS
        a = FakeFixture("a")
        a.events.append({"ev": "configure", "win": "child", "serial": 99, "width": 1, "height": 1, "states": [],
                         "t_ns": t0 + MS})
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="resize")
        self.assertEqual(r["affectedWindowCount"], 0)

    def test_timeout_bounds_the_last_window(self):
        t0 = 2_000 * MS
        a = FakeFixture("a")
        a.configure(t0 + 3_000 * MS, 600, 300)
        [r] = latency.correlate([tap(1, t0)], windows(a), expect="resize", timeout_ns=2_000 * MS)
        self.assertEqual(r["affectedWindowCount"], 0)

    def test_a_late_response_is_not_taken_for_the_next_taps(self):
        # Tap 1's configure comes 700 ms late, after tap 2 (sent 690 ms after tap 1, as the old 600 ms
        # effect timeout plus the gap allowed). It must not become a falsely fast tap-2 sample.
        t0, t1 = 2_000 * MS, 2_690 * MS
        a = FakeFixture("a")
        a.configure(t0 + 700 * MS, 600, 300)
        a.configure(t1 + 23 * MS, 400, 300)
        r0, r1 = latency.correlate([tap(1, t0), tap(2, t1)], windows(a), expect="resize")
        self.assertFalse(r0["success"])
        self.assertIn("slower than the sample timeout", r0["failureReason"])
        self.assertFalse(r1["success"], r1)
        self.assertIn("previous input's response did not complete", r1["failureReason"])

    def test_incomplete_pacing_fails_the_following_tap(self):
        t0, t1, t2 = 2_000 * MS, 4_100 * MS, 4_200 * MS
        a = FakeFixture("a")
        a.configure(t0 + 2 * MS, 600, 300)
        a.configure(t1 + 2 * MS, 400, 300)
        a.configure(t2 + 2 * MS, 600, 300)
        taps = [dict(tap(1, t0), pacing="timeout"), dict(tap(2, t1), pacing="settled"), dict(tap(3, t2))]
        r0, r1, r2 = latency.correlate(taps, windows(a), expect="resize")
        self.assertTrue(r0["success"])
        self.assertFalse(r1["success"])
        self.assertIn("previous input's response", r1["failureReason"])
        self.assertTrue(r2["success"], r2)

    def test_present_grid(self):
        a = FakeFixture("a")
        base = 3_000 * MS
        for k in range(5):
            a.configure(base + k * 3 * REFRESH_60, 400 + k, 300, present_after=0, commit_after=0)
        g = latency.present_grid(windows(a), REFRESH_60)
        self.assertGreaterEqual(g["intervals"], 4)
        self.assertEqual(g["refreshNs"], REFRESH_60)


class RecordSchemaTests(unittest.TestCase):
    def _result(self, success=True):
        t0 = 2_000 * MS
        a = FakeFixture("a")
        if success:
            a.configure(t0 + 2 * MS, 600, 300)
        return latency.correlate([tap(1, t0)], windows(a), expect="resize")[0]

    def test_records_carry_every_schema_field_and_reasons(self):
        for ok in (True, False):
            rec = latency.to_record(self._result(ok), CTX)
            self.assertEqual(latency.validate_record(rec), [], rec)
            for f in latency.SCHEMA_FIELDS:
                self.assertIn(f, rec)
            self.assertEqual(rec["presentedNs"], rec["inputToFirstPresentNs"])
            self.assertIsNone(rec["dispatchNs"])
            self.assertTrue(rec["unavailableReasons"]["dispatchNs"])

    def test_motion_on_has_no_settle_and_says_why(self):
        # Under Plastile Motion the final commit is presented on the first animated frame: reporting it as
        # t9_settled would end the settle about one duration early.
        res = self._result(True)
        rec = latency.to_record(res, {**CTX, "motion": "on, Duration=180 ms, speed factor 1", "motionOn": True})
        self.assertEqual(latency.validate_record(rec), [], rec)
        self.assertTrue(rec["success"])
        self.assertIsNone(rec["inputToSettledNs"])
        self.assertIsNone(rec["settledNs"])
        self.assertIn("not observable with Plastile Motion on", rec["settledUnavailableReason"])
        self.assertEqual(rec["inputToFinalCommitPresentNs"], res["inputToSettledNs"])
        self.assertEqual(rec["motion"], "on, Duration=180 ms, speed factor 1")
        off = latency.to_record(res, {**CTX, "motion": "off", "motionOn": False})
        self.assertEqual(off["inputToSettledNs"], off["inputToFinalCommitPresentNs"])
        self.assertIsNone(off["settledUnavailableReason"])
        bad = dict(rec, settledUnavailableReason=None)
        self.assertTrue(any("both latencies" in e for e in latency.validate_record(bad)))

    def test_validator_rejects_bad_records(self):
        rec = latency.to_record(self._result(True), CTX)
        bad = dict(rec, unavailableReasons={})
        self.assertTrue(any("without a reason" in e for e in latency.validate_record(bad)))
        bad = dict(rec, failureReason="x")
        self.assertTrue(latency.validate_record(bad))
        bad = dict(rec, success=False, failureReason=None)
        self.assertTrue(latency.validate_record(bad))
        bad = dict(rec, inputToSettledNs=rec["inputToFirstPresentNs"] - 1)
        self.assertTrue(any("settled precedes" in e for e in latency.validate_record(bad)))
        bad = dict(rec, layer="nested")
        self.assertTrue(latency.validate_record(bad))
        bad = dict(rec)
        del bad["clock"]
        self.assertEqual(latency.validate_record(bad), ["missing field clock"])
        bad = dict(rec, presentedNs=None, presentationUnavailableReason=None)
        self.assertTrue(latency.validate_record(bad))


if __name__ == "__main__":
    unittest.main()
