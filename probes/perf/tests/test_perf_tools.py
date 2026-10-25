"""G2 perf probe oracles and aggregation on synthetic campaigns (no compositor, no session).

The probes themselves need a nested KWin; these tests exercise only the parts that judge and
summarize their output: per-sample and per-block success (qualify), the P03 cells and gates
(g2_aggregate), provenance (perfcommon) and the quantile helper of workloads/run.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PERF = HERE.parent
ROOT = PERF.parents[1]
sys.path.insert(0, str(ROOT / "tests/integration"))
sys.path.insert(0, str(PERF))
import g2_aggregate  # noqa: E402
import perfcommon  # noqa: E402
import qualify  # noqa: E402
import workloads  # noqa: E402

MS = 1_000_000


def row(n: int, mode: str, wl: str, k: int, t: int, outer_ns: int, *, success: bool = True, reason: str | None = None,
        cmd: str = "plastile.resize.grow") -> dict:
    """One qualify.py samples.jsonl row (PERFORMANCE §8 fields plus the stage columns)."""
    return {"runId": f"P03-n{n}-{mode}-r0", "implementationCommit": "c" * 40, "environmentId": "nested-virtual-kwin-6.8.1",
            "workload": f"P03-{wl}", "sample": k, "contextCount": 4, "affectedWindowCount": n, "clock": "CLOCK_MONOTONIC",
            "clockResolutionNs": 1, "dispatchNs": t, "solveEndNs": None, "lastRequestNs": t + outer_ns, "observedNs": None,
            "presentedNs": None, "presentationUnavailableReason": "nested", "solves": 1 if mode == "instrumented" else None,
            "geometryWrites": (n if success else 0) if mode == "instrumented" else None, "nativeMutations": None,
            "configureCount": 1, "correctiveWrites": None, "success": success, "failureReason": reason, "mode": mode,
            "diag": None, "n": n, "run": 0, "block": 0, "k": k, "warmup": False, "cmd": cmd, "sendNs": t - 50_000,
            "outerNs": outer_ns, "innerNs": outer_ns - 1000 if mode == "instrumented" else None, "innerEntryNs": None,
            "solveNs": outer_ns // 2 if mode == "instrumented" else None, "applyNs": 1000 if mode == "instrumented" else None,
            "activateNs": None, "logNs": None, "expectedWrites": n, "sizeConfigureCount": 1, "configuredWindows": n,
            "firstConfigureNs": t + outer_ns + 100_000, "lastConfigureNs": t + outer_ns + 200_000,
            "lastCommitNs": t + outer_ns + 300_000, "virtualPresentedNs": t + outer_ns + 400_000}


def campaign(d: Path, kwin: str = "kwin 6.8.1", focus_activations: int = 100) -> Path:
    """A one-unit-per-mode P03 campaign: 1000 ratio commands per mode, half of them failing fast in the
    instrumented unit, and one focus block of 100 commands with `focus_activations` activations."""
    (d / "units").mkdir(parents=True)
    (d / "plan.json").write_text(json.dumps({"environment": {"kwin": kwin}}))
    for mode in ("instrumented", "uninstrumented"):
        u = d / "units" / f"qualify-n4-{mode}-r0"
        u.mkdir()
        rows, t = [], 10_000 * MS
        for k in range(1000):
            fail = mode == "instrumented" and k % 2 == 1
            rows.append(row(4, mode, "ratio", k, t, 20_000 if fail else 1_500_000, success=not fail,
                            reason="writes 0 != expected 4" if fail else None))
            t += 20 * MS
        for k in range(100):
            rows.append(row(4, mode, "focus", k, t, 300_000, cmd="plastile.focus.next") | {"block": 1, "expectedWrites": 0,
                                                                                         "geometryWrites": 0 if mode == "instrumented" else None})
            t += 20 * MS
        (u / "samples.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        blocks = [{"block": 0, "workload": "ratio", "warmup": False, "commands": 1000, "tilingErrorsAfter": [],
                   "countersDelta": {"commands": 1000, "solves": 1000, "writes": 4000}},
                  {"block": 1, "workload": "focus", "warmup": False, "commands": 100, "tilingErrorsAfter": [],
                   "countersDelta": {"commands": 100, "activations": focus_activations}}]
        (u / "unit.json").write_text(json.dumps({
            "n": 4, "mode": mode, "diag": None, "run": 0, "versions": {"kwin": kwin}, "blocks": blocks,
            "machineStart": {"loadavg": ["1.0", "1.0", "1.0"], "busyProcessesPct": [], "nestedKwinRunning": 0},
            "implementationCommit": "c" * 40, "implementationDirty": False}))
    return d


class QualifyOracleTests(unittest.TestCase):
    OUTER = ["plastile.focus.next", 0, 20_000]

    def test_a_noop_focus_is_not_a_successful_sample(self):
        self.assertIsNone(qualify.sample_failure("focus", "plastile.focus.next", self.OUTER, {"status": "accepted"}, 0, 0))
        why = qualify.sample_failure("focus", "plastile.focus.next", self.OUTER, {"status": "noop"}, 0, 0)
        self.assertIn("did not activate", why)
        # a no-op is still a valid outcome for the no-op workload
        self.assertIsNone(qualify.sample_failure("noop", "plastile.context.reset", ["plastile.context.reset", 0, 1],
                                                 {"status": "noop"}, 0, 0))

    def test_a_focus_block_without_activations_fails(self):
        b = {"workload": "focus", "commands": 100, "outerIdsMatch": True, "tilingErrorsAfter": [], "outstandingAfter": 0,
             "countersDelta": {"commands": 100}}
        self.assertFalse(qualify.block_ok(b))
        self.assertTrue(qualify.block_ok(b | {"countersDelta": {"commands": 100, "activations": 100}}))


class G2AggregateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _p03(self, **kw) -> dict:
        cdir = campaign(self.dir / "c", **kw)
        rows, units = g2_aggregate.p03_rows(cdir)
        ev = self.dir / "ev"
        ev.mkdir(exist_ok=True)
        return g2_aggregate.p03(cdir, ev, rows, units)

    def test_failed_samples_are_kept_out_of_the_latency_cells(self):
        cell = self._p03()["cells"]["n4/ratio/instrumented"]
        self.assertEqual((cell["samples"], cell["successes"], cell["successRate"]), (1000, 500, 0.5))
        self.assertEqual(cell["failures"], {"writes 0 != expected 4": 500})
        outer = cell["dispatchToLastRequestOuter"]["pooled"]
        self.assertEqual((outer["n"], outer["p50"], outer["min"]), (500, 1.5, 1.5))
        self.assertEqual(cell["failedOuter"]["p50"], 0.02)  # failure timing is still reported

    def test_the_focus_gate_needs_an_activation_per_command(self):
        gates = self._p03(focus_activations=0)["gates"]["focusOnly"]
        self.assertEqual(gates["n4/uninstrumented"]["activations"], 0)
        self.assertFalse(gates["n4/uninstrumented"]["pass"])

    def test_the_focus_gate_passes_when_every_command_activated(self):
        self.assertTrue(self._p03()["gates"]["focusOnly"]["n4/uninstrumented"]["pass"])

    def test_the_layer_names_the_measured_kwin(self):
        self.assertTrue(self._p03()["layer"].startswith("nested KWin 6.8.1, virtual backend"))
        self.assertEqual(g2_aggregate.campaign_kwin(self.dir / "c"), "nested KWin 6.8.1")

    def test_copied_small_sample_p99_is_withheld(self):
        st = g2_aggregate.withhold_small_p99({"n": 50, "p50": 1, "p95": 2, "p99": 3, "max": 4, "min": 0})
        self.assertIsNone(st["p99"])
        self.assertIn("n=50 < 5000", st["p99WithheldReason"])
        big = {"n": 5000, "p99": 3}
        self.assertEqual(g2_aggregate.withhold_small_p99(big), big)


class AbQualifyTests(unittest.TestCase):
    def test_failed_samples_are_not_pooled_into_the_ab_cells(self):
        import ab_qualify
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "campaign.json").write_text(json.dumps({"variants": [{"name": "a", "spec": "A"}]}))
            u = d / "u000-r0-a"
            u.mkdir()
            rows = [row(32, "instrumented", "ratio", k, k * 20 * MS, 20_000 if k % 2 else 1_500_000, success=not k % 2,
                        reason="writes 0 != expected 32" if k % 2 else None) for k in range(200)]
            (u / "samples.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
            (u / "unit.json").write_text(json.dumps({"pass": False, "root": {"bundleSha256": "x"}, "implementationDirty": False,
                                                     "corrections": {"corrections": 0}, "failures": 100}))
            c = ab_qualify.summarize(d)["variants"]["A"]
        self.assertEqual(c["failures"], [100])
        self.assertEqual((c["ratio"]["outer"]["n"], c["ratio"]["outer"]["p50"]), (100, 1.5))


class ProvenanceTests(unittest.TestCase):
    def test_nested_kwin_label(self):
        self.assertEqual(perfcommon.nested_kwin(["kwin 6.8.1", "kwin 6.8.1"]), "nested KWin 6.8.1")
        self.assertEqual(perfcommon.nested_kwin(["kwin 6.7.5", "kwin 6.8.1"]),
                         "nested KWin (mixed versions: 6.7.5, 6.8.1)")
        self.assertEqual(perfcommon.nested_kwin([]), "nested KWin (version not recorded)")

    def test_a_helper_change_marks_the_tree_dirty(self):
        # Every nested session runs the persistence helper (harness Session(helper=True)).
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            (repo / "helper").mkdir()
            (repo / "helper/main.cpp").write_text("int main() {}\n")
            git = ["git", "-C", d, "-c", "user.email=t@example.invalid", "-c", "user.name=t"]
            subprocess.run(git + ["init", "-q"], check=True)
            subprocess.run(git + ["add", "."], check=True)
            subprocess.run(git + ["commit", "-qm", "x"], check=True)
            (repo / "helper/main.cpp").write_text("int main() { return 1; }\n")
            old = perfcommon.ROOT
            perfcommon.ROOT = repo
            try:
                meta = perfcommon.git_meta()
            finally:
                perfcommon.ROOT = old
        self.assertTrue(meta["implementationDirty"])
        self.assertEqual(meta["dirtyPaths"], ["helper/main.cpp"])


class QuantileTests(unittest.TestCase):
    def test_nearest_rank_and_p99_withheld_below_5000(self):
        s = workloads.q(range(1, 51))
        self.assertEqual((s["p50"], s["p95"], s["max"]), (25, 48, 50))  # nearest rank: ceil(p * n)
        self.assertIsNone(s["p99"])
        self.assertIn("n=50 < 5000", s["p99WithheldReason"])
        self.assertEqual(workloads.q(range(1, 5001))["p99"], 4950)
        self.assertIsNone(workloads.q([]))
        self.assertIn("p50/p95/p99 0/0/- us (n=50)", workloads.us(s))


if __name__ == "__main__":
    unittest.main()
