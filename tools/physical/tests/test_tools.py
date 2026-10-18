"""observe/soak helpers, the checklist bundle, CLI guards and runbook anchors (no desktop)."""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent
REPO = TOOLS.parents[1]
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(REPO / "tools"))
import checklist  # noqa: E402
import observe  # noqa: E402
import soak  # noqa: E402

MS = 1_000_000


class ObserveTests(unittest.TestCase):
    def _cfg(self, t, w, h, act=True):
        return {"ev": "configure", "win": "main", "t_ns": t, "width": w, "height": h,
                "states": ["activated"] if act else []}

    def test_reversals_and_stats(self):
        ev = [self._cfg(1 * MS, 400, 300), {"ev": "commit", "win": "main", "t_ns": 2 * MS, "width": 400, "height": 300},
              self._cfg(10 * MS, 500, 300), self._cfg(20 * MS, 400, 300), self._cfg(30 * MS, 500, 300),
              {"ev": "commit", "win": "main", "t_ns": 31 * MS, "width": 500, "height": 300},
              {"ev": "presented", "win": "main", "t_ns": 35 * MS, "seq": 2, "present_ns": 34 * MS,
               "refresh_ns": 6_944_444}]
        self.assertEqual(observe.size_sequence(ev, 5 * MS, 40 * MS), [(500, 300), (400, 300), (500, 300)])
        self.assertEqual(observe.reversals([(1, 1), (2, 2), (1, 1), (2, 2)]), 2)
        st = observe.phase_stats({"fixture-1": ev}, 5 * MS, 40 * MS)
        w = st["windows"]["fixture-1"]
        self.assertEqual((w["configures"], w["reversals"], w["finalSize"]), (3, 1, [500, 300]))
        self.assertEqual(w["refreshNs"], 6_944_444)
        self.assertIn("reversal", observe.verdict_hint(st, True))
        self.assertIn("tail timeout", observe.verdict_hint(st, False))
        calm = observe.phase_stats({"fixture-1": ev[:2]}, 5 * MS, 40 * MS)
        self.assertIn("converged", observe.verdict_hint(calm, True))

    def test_counter_delta(self):
        a = {"counters": {"writes": 1, "corrections": 0}, "outstanding": 0}
        b = {"counters": {"writes": 5, "corrections": 2}, "outstanding": 1, "windows": 3, "connections": 40}
        d = observe.counter_delta(a, b)
        self.assertEqual((d["writes"], d["corrections"], d["outstandingAfter"]), (4, 2, 1))
        self.assertIsNone(observe.counter_delta(None, b))


class SoakTests(unittest.TestCase):
    def test_slope(self):
        self.assertAlmostEqual(soak.slope_per_hour([(0, 10), (1800, 15), (3600, 20)]), 10.0)
        self.assertIsNone(soak.slope_per_hour([(0, 1), (1, 2)]))
        s = soak.series_summary([{"elapsedS": t, "connections": 40} for t in (0, 600, 1200)], "connections")
        self.assertEqual((s["first"], s["last"], s["slopePerHour"]), (40, 40, 0.0))
        self.assertIsNone(soak.series_summary([{"elapsedS": 0}], "windows"))


class ChecklistTests(unittest.TestCase):
    def test_new_set_report(self):
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "20261018T120000"
            with redirect_stdout(io.StringIO()):
                self.assertEqual(checklist.main(["new", str(run)]), 0)
                self.assertEqual(checklist.main(["new", str(run)]), 1)  # never overwrites
                self.assertEqual(checklist.main(["set", str(run), "PHY-03a", "pass", "no tile under the panel"]), 0)
                self.assertEqual(checklist.main(["set", str(run), "PHY-07a", "fail", "Meta+Shift+= does nothing"]), 0)
            cl = json.loads((run / "checklist.json").read_text())
            self.assertEqual(checklist.validate(cl), [])
            g = checklist.gate(cl)
            self.assertIn("PHY-01", g["requiredOpen"])
            self.assertNotIn("PHY-09", g["requiredOpen"])  # optional
            (run / "lat").mkdir()
            (run / "lat" / "summary-redacted.json").write_text(json.dumps({"groups": [], "comparisons": []}))
            (run / "session.json").write_text(json.dumps({"kwin": {"kwinVersion": "6.7.5", "qtVersion": "6.12.0",
                                                                    "package": "kwin 6.7.5-3", "compositingType": "OpenGL",
                                                                    "openglRenderer": "AMD"},
                                                           "outputs": [{"name": "DP-1", "serial": "x"}],
                                                           "compositor": {"kwinPid": 1}}))
            with redirect_stdout(io.StringIO()) as out:
                self.assertEqual(checklist.main(["report", str(run)]), 0)
            red = json.loads((run / "report-redacted.json").read_text())
            self.assertEqual(red["latency"][0]["dir"], "lat")
            self.assertNotIn("serial", json.dumps(red))
            self.assertNotIn("kwinPid", json.dumps(red))
            row = [ln for ln in out.getvalue().splitlines() if ln.startswith("| kwin 6.7.5-3 |")][0]
            self.assertIn("| 6.12.0 | Plasma Wayland (physical) |", row)
            self.assertIn("O07", row)  # PHY-03a passed
            self.assertIn("PHY-07a (Meta+Shift+= does nothing)", row)

    def test_failed_status_needs_a_note(self):
        cl = checklist.new_checklist("x")
        cl["items"][0]["status"] = "fail"
        self.assertTrue(any("needs a note" in e for e in checklist.validate(cl)))
        cl["items"][0]["status"] = "bogus"
        self.assertTrue(any("unknown status" in e for e in checklist.validate(cl)))

    def test_procedure_anchors_exist_in_the_runbook(self):
        import check_docs
        runbook = REPO / checklist.RUNBOOK
        anchors = check_docs.heading_anchors(runbook.read_text())
        for _id, _t, _ids, anchor, _opt in checklist.ITEMS:
            self.assertIn(anchor, anchors, f"{_id}: #{anchor} missing from {checklist.RUNBOOK}")


class LiveEntryPointsRefuseOutsideKWin(unittest.TestCase):
    """Every live-session CLI exits 3 before doing anything when not in a KWin Wayland session."""

    def test_refusal(self):
        env = {k: v for k, v in os.environ.items() if k not in ("XDG_SESSION_TYPE", "WAYLAND_DISPLAY")}
        cmds = [["session_check.py"], ["orchestrate.py", "run", "--output", "DP-1", "--yes"], ["orchestrate.py", "keys"],
                ["observe.py"],
                ["soak.py", "sample"], ["soak.py", "idle", "--yes"]]
        for c in cmds:
            with self.subTest(cmd=c[0]), tempfile.TemporaryDirectory() as d:
                r = subprocess.run([sys.executable, str(TOOLS / c[0]), *c[1:]], env={**env, "HOME": d},
                                   capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
                self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
                self.assertIn("wayland", (r.stdout + r.stderr).lower())
                self.assertFalse((Path(d) / ".config").exists())  # nothing written under HOME

    def test_plan_touches_nothing(self):
        r = subprocess.run([sys.executable, str(TOOLS / "orchestrate.py"), "plan", "--rounds", "5", "--samples", "1000"],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0)
        self.assertIn("25 blocks; 5000 measured samples", r.stdout)


if __name__ == "__main__":
    unittest.main()
