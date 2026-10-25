"""Summarizer statistics, p99 refusal, bootstrap-by-run CIs and verdicts (synthetic data)."""
from __future__ import annotations

import io
import json
import random
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import summarize  # noqa: E402
from synth import MS, record  # noqa: E402


def runs(workload: str, condition: str, n_runs: int, per_run: int, base_ms: float, spread_ms: float, seed: int,
         **kw) -> list[dict]:
    rng = random.Random(seed)
    out = []
    for r in range(n_runs):
        drift = rng.uniform(-0.2, 0.2) * MS
        for i in range(per_run):
            v = int(base_ms * MS + drift + rng.random() * spread_ms * MS)
            out.append(record(f"{workload}-run{r}", v, workload=workload, condition=condition, sample=i, **kw))
    return out


class QuantileTests(unittest.TestCase):
    def test_nearest_rank(self):
        xs = list(range(1, 101))
        self.assertEqual(summarize.quantile(xs, 0.5), 50)
        self.assertEqual(summarize.quantile(xs, 0.95), 95)
        self.assertEqual(summarize.quantile(xs, 0.99), 99)
        self.assertEqual(summarize.quantile(xs, 1.0), 100)
        self.assertEqual(summarize.quantile([7], 0.99), 7)
        self.assertIsNone(summarize.quantile([], 0.5))
        self.assertEqual(summarize.quantile([1, 2, 3, 4], 0.5), 2)  # lower median

    def test_p99_withheld_below_5000(self):
        s = summarize.stats(list(range(4999)))
        self.assertIsNone(s["p99"])
        self.assertIn("4999 < 5000", s["p99WithheldReason"])
        s = summarize.stats(list(range(5000)))
        self.assertEqual(s["p99"], 4949)
        self.assertNotIn("p99WithheldReason", s)


class GroupTests(unittest.TestCase):
    def test_per_run_and_pooled_and_failures(self):
        recs = runs("P03-ratio", "plastile", 3, 100, 10, 4, 1)
        recs += [record("P03-ratio-run0", 0, success=False, sample=999)]
        s = summarize.summarize(recs, b=200, seed=3)
        [g] = s["groups"]
        self.assertEqual(g["samples"], 301)
        self.assertEqual(g["successes"], 300)
        self.assertEqual(g["runs"], 3)
        self.assertEqual(g["failures"], {"no configure in the attribution window": 1})
        m = g["metrics"]["inputToFirstPresentNs"]
        self.assertEqual(m["pooled"]["n"], 300)
        self.assertIsNone(m["pooled"]["p99"])
        self.assertEqual(sorted(m["perRun"]), ["P03-ratio-run0", "P03-ratio-run1", "P03-ratio-run2"])
        self.assertTrue(all(v["p99"] is None for v in m["perRun"].values()))
        lo, hi = m["ci95ByRun"]["median"]
        self.assertLessEqual(lo, m["pooled"]["median"])
        self.assertGreaterEqual(hi, m["pooled"]["median"])
        self.assertFalse(g["protocol"]["met"])

    def test_pooled_p99_appears_at_5000_but_per_run_p99_stays_withheld(self):
        recs = runs("P03-ratio", "plastile", 5, 1000, 10, 4, 2)
        s = summarize.summarize(recs, b=50, seed=1)
        m = s["groups"][0]["metrics"]["inputToFirstPresentNs"]
        self.assertEqual(m["pooled"]["n"], 5000)
        self.assertIsNotNone(m["pooled"]["p99"])
        self.assertIn("p99", m["ci95ByRun"])
        self.assertTrue(all(v["p99"] is None for v in m["perRun"].values()))
        self.assertTrue(s["groups"][0]["protocol"]["met"])

    def test_ci_needs_two_runs_and_is_deterministic(self):
        one = runs("P03-ratio", "plastile", 1, 50, 10, 4, 1)
        s = summarize.summarize(one, b=100, seed=1)
        self.assertIsNone(s["groups"][0]["metrics"]["inputToFirstPresentNs"]["ci95ByRun"]["median"])
        two = runs("P03-ratio", "plastile", 4, 50, 10, 4, 1)
        a = summarize.summarize(two, b=100, seed=9)
        b = summarize.summarize(two, b=100, seed=9)
        self.assertEqual(a, b)

    def test_bootstrap_resamples_whole_runs(self):
        # Two runs with disjoint values: a run-level bootstrap can produce pooled medians from
        # either run alone, so the interval spans both clusters.
        rng = random.Random(1)
        ci = summarize.bootstrap_ci([[1] * 50, [100] * 50], "median", b=400, rng=rng)
        self.assertEqual(ci, [1, 100])

    def test_warmup_never_pooled(self):
        recs = runs("P03-ratio", "plastile", 2, 50, 10, 1, 1)
        warm = runs("P03-ratio", "plastile", 2, 5, 90, 1, 2, warmup=True)
        s = summarize.summarize(recs + warm[:3], warmup=warm[3:], b=50)
        g = s["groups"][0]
        self.assertEqual(g["samples"], 100)
        self.assertLess(g["metrics"]["inputToFirstPresentNs"]["pooled"]["max"], 20 * MS)
        self.assertEqual(sum(w["samples"] for w in s["warmup"]), len(warm))

    def test_groups_split_by_refresh_and_window_count(self):
        recs = runs("P03-ratio", "plastile", 2, 10, 10, 1, 1, hz=60)
        recs += runs("P03-ratio", "plastile", 2, 10, 5, 1, 1, hz=144, refresh_ns=6_944_444)
        recs += runs("P03-ratio", "plastile", 2, 10, 5, 1, 1, hz=144, refresh_ns=6_944_444, windows=8)
        s = summarize.summarize(recs, b=20)
        self.assertEqual(len(s["groups"]), 3)

    def test_runs_whose_samples_all_failed_do_not_count_toward_the_protocol(self):
        # 2 blocks x 2500 successes + 3 blocks with only failures, per side: 5 runs, 5000 successes,
        # but the bootstrap and the verdict rest on 2 runs.
        def side(workload, condition, base_ms, seed):
            recs = runs(workload, condition, 2, 2500, base_ms, 3, seed)
            recs += [record(f"{workload}-empty{i}", 0, workload=workload, condition=condition, success=False)
                     for i in range(3)]
            return recs
        recs = side("P03-ratio", "plastile", 10.5, 1) + side("P02-quicktile", "none", 10.0, 2)
        s = summarize.summarize(recs, matched={"P03-ratio": "P02-quicktile"}, b=50, seed=1)
        for g in s["groups"]:
            self.assertEqual((g["protocol"]["runs"], g["protocol"]["contributingRuns"]), (5, 2))
            self.assertFalse(g["protocol"]["met"])
        [c] = s["comparisons"]
        self.assertNotEqual(c["verdict"], "pass", c)

    def test_builds_environments_and_motion_states_never_pool(self):
        recs = runs("P03-ratio", "plastile", 3, 20, 10, 1, 1, implementationCommit="a" * 40,
                    environmentId="physical-arch-kwin-6.7.5")
        recs += runs("P03-ratio", "plastile", 3, 20, 30, 1, 2, implementationCommit="b" * 40,
                     environmentId="physical-arch-kwin-6.8.1")
        recs += runs("P03-ratio", "plastile", 3, 20, 30, 1, 3, implementationCommit="b" * 40,
                     environmentId="physical-arch-kwin-6.8.1", motion="on, Duration=180 ms, speed factor 1")
        s = summarize.summarize(recs, b=20)
        self.assertEqual(sorted(g["runs"] for g in s["groups"]), [3, 3, 3])
        self.assertEqual(sorted(s["mixedProvenance"]), ["environmentId", "implementationCommit", "motion"])
        self.assertIn("WARNING: the inputs mix environmentId", summarize.render(s))
        self.assertIn("mixedProvenance", summarize.redact(s))

    def test_comparisons_pair_only_the_same_build_and_motion_state(self):
        recs = runs("P03-ratio", "plastile", 2, 20, 10, 1, 1, motion="on, Duration=180 ms, speed factor 1")
        recs += runs("P02-quicktile", "none", 2, 20, 10, 1, 2, motion="off")
        s = summarize.summarize(recs, matched={"P03-ratio": "P02-quicktile"}, b=20)
        [c] = s["comparisons"]
        self.assertEqual(c["verdict"], "missing")


class VerdictTests(unittest.TestCase):
    def _compare(self, cand_ms, base_ms, n_runs=5, per_run=1000, spread=3.0):
        recs = runs("P03-ratio", "plastile", n_runs, per_run, cand_ms, spread, 11)
        recs += runs("P02-quicktile", "none", n_runs, per_run, base_ms, spread, 12)
        s = summarize.summarize(recs, matched={"P03-ratio": "P02-quicktile"}, b=100, seed=1)
        [c] = s["comparisons"]
        self.assertTrue(c["matchedBaseline"])
        return c

    def test_pass_requires_protocol(self):
        c = self._compare(10.5, 10.0)
        self.assertTrue(c["protocolMet"])
        self.assertEqual(c["verdict"], "pass", c)
        c = self._compare(10.5, 10.0, n_runs=4, per_run=1000)
        self.assertFalse(c["protocolMet"])
        self.assertEqual(c["verdict"], "inconclusive")
        self.assertIn("protocol not met", c["reason"])

    def test_just_under_one_interval_with_tight_ci_passes(self):
        c = self._compare(25.5, 10.0, spread=1.0)  # diff ~15.5 ms < 16.67 ms with a tight run-level CI
        self.assertEqual(c["verdict"], "pass", c)

    def test_extra_frame_at_median_fails(self):
        c = self._compare(28.0, 10.0)
        self.assertEqual(c["verdict"], "fail")
        self.assertEqual(c["medianRule"], "fail")
        self.assertNotIn("indicative", c)
        c = self._compare(28.0, 10.0, n_runs=2, per_run=100)
        self.assertEqual(c["verdict"], "fail")
        self.assertTrue(c["indicative"])

    def test_close_to_threshold_is_inconclusive(self):
        c = self._compare(26.6, 10.0, spread=1.0)  # median diff ~16.6 ms vs a 16.67 ms interval: CI straddles it
        self.assertIn(c["verdict"], ("inconclusive", "fail"))
        self.assertNotEqual(c["verdict"], "pass")

    def test_unmatched_baselines_are_controls(self):
        recs = runs("P03-ratio", "plastile", 2, 20, 10, 1, 1) + runs("P00-maximize", "none", 2, 20, 10, 1, 2)
        s = summarize.summarize(recs, matched={"P03-ratio": "P02-quicktile"}, b=20)
        control, missing = s["comparisons"]
        self.assertFalse(control["matchedBaseline"])
        self.assertEqual(control["baseline"], "P00-maximize")
        self.assertEqual((missing["baseline"], missing["verdict"]), ("P02-quicktile", "missing"))

    def test_a_missing_matched_baseline_is_reported(self):
        # The default run selects no optional workload, so P03-focus has no P00-switch: its only
        # comparisons are resize controls, and the missing verdict must say so.
        recs = runs("P03-focus", "plastile", 2, 20, 10, 1, 1) + runs("P00-maximize", "none", 2, 20, 10, 1, 2)
        s = summarize.summarize(recs, matched={"P03-focus": "P00-switch"}, b=20)
        missing = [c for c in s["comparisons"] if c["matchedBaseline"]]
        self.assertEqual([(c["baseline"], c["verdict"]) for c in missing], [("P00-switch", "missing")])
        self.assertIn("P03-focus vs P00-switch (matched baseline", summarize.render(s))
        self.assertIn("-> missing - matched baseline not measured", summarize.render(s))

    def test_a_lower_success_rate_withholds_the_pass(self):
        # Failed samples are excluded from the latencies, so a candidate that fails half its taps (for
        # example its slowest responses) must not pass on the fast half.
        recs = runs("P03-ratio", "plastile", 5, 1000, 10.5, 3.0, 11)
        recs += [record(f"P03-ratio-run{i % 5}", 0, success=False, sample=1000 + i) for i in range(5000)]
        recs += runs("P02-quicktile", "none", 5, 1000, 10.0, 3.0, 12)
        s = summarize.summarize(recs, matched={"P03-ratio": "P02-quicktile"}, b=100, seed=1)
        [c] = s["comparisons"]
        self.assertEqual(c["successRate"], {"candidate": 0.5, "baseline": 1.0})
        self.assertEqual(c["verdict"], "inconclusive", c)
        self.assertIn("success rate", c["reason"])

    def test_named_controls_of_either_condition(self):
        recs = runs("P03-focus", "plastile", 2, 20, 10, 1, 1) + runs("P00-switch", "none", 2, 20, 5, 1, 2)
        recs += runs("P00-switch-tiled", "plastile", 2, 20, 10, 1, 3) + runs("P03-ratio", "plastile", 2, 20, 10, 1, 4)
        s = summarize.summarize(recs, matched={"P03-focus": "P00-switch"},
                                controls={"P03-focus": ["P00-switch-tiled"]}, b=20)
        pairs = {(c["candidate"], c["baseline"]): c["matchedBaseline"] for c in s["comparisons"]}
        self.assertTrue(pairs[("P03-focus", "P00-switch")])
        self.assertFalse(pairs[("P03-focus", "P00-switch-tiled")])
        self.assertNotIn(("P03-focus", "P03-ratio"), pairs)  # a Plastile workload is a baseline only when named
        self.assertNotIn(("P00-switch-tiled", "P03-focus"), pairs)

    def test_no_successes_is_inconclusive(self):
        recs = [record("a", 0, success=False)] + runs("P02-quicktile", "none", 2, 20, 10, 1, 2)
        s = summarize.summarize(recs, matched={"P03-ratio": "P02-quicktile"}, b=20)
        self.assertEqual(s["comparisons"][0]["verdict"], "inconclusive")


class OutputTests(unittest.TestCase):
    def test_render_never_prints_p99_below_5000(self):
        s = summarize.summarize(runs("P03-ratio", "plastile", 2, 100, 10, 4, 1), b=20)
        text = summarize.render(s)
        self.assertIn("p99 withheld (n=200<5000)", text)
        self.assertIn("protocol NOT met", text)

    def test_redacted_summary_has_no_run_ids(self):
        s = summarize.summarize(runs("P03-ratio", "plastile", 2, 10, 10, 4, 1), b=20)
        red = json.dumps(summarize.redact(s))
        self.assertNotIn("P03-ratio-run0", red)
        self.assertIn("run1", red)
        self.assertIn("P03-ratio-run0", json.dumps(s))  # the original is not mutated

    def test_cli_writes_json_and_publish(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "samples.jsonl"
            p.write_text("\n".join(json.dumps(r) for r in runs("P03-ratio", "plastile", 2, 10, 10, 4, 1)) + "\n")
            out, pub = Path(d) / "s.json", Path(d) / "pub" / "r.json"
            with redirect_stdout(io.StringIO()):
                self.assertEqual(summarize.main([str(p), "--json", str(out), "--publish", str(pub),
                                                 "--bootstrap", "20"]), 0)
            self.assertEqual(json.loads(out.read_text())["groups"][0]["samples"], 20)
            self.assertTrue(pub.exists())


if __name__ == "__main__":
    unittest.main()
