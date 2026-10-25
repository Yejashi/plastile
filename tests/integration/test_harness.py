"""Offline tests of the integration harness's own oracles (no KWin is started).

Run: python3 -m unittest discover -s tests/integration -p 'test_*.py' -v
"""
from __future__ import annotations

import ast
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import harness  # noqa: E402
import scenarios_motion  # noqa: E402
from harness import NestedError  # noqa: E402
from scenarios import Checks  # noqa: E402


class ChecksTest(unittest.TestCase):
    def test_a_reused_name_keeps_both_results(self):
        c = Checks()
        c("no errors in KWin's log", False, ["TypeError"])
        c("no errors in KWin's log", True, [])
        self.assertEqual(len(c.items), 2)
        self.assertFalse(all(v["pass"] for v in c.items.values()), "the earlier failure still fails the scenario")
        self.assertEqual(c.items["no errors in KWin's log"]["detail"], ["TypeError"])
        self.assertTrue(c.items["no errors in KWin's log (#2)"]["pass"])

    def test_no_scenario_records_one_literal_name_twice(self):
        """Within one scenario function, a check name written twice as a literal is a slip, not a loop."""
        dups = []
        for path in sorted(HERE.glob("scenarios*.py")):
            for fn in ast.walk(ast.parse(path.read_text())):
                if not isinstance(fn, ast.FunctionDef):
                    continue
                seen: dict[str, int] = {}
                for node in ast.walk(fn):
                    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "c" and node.args
                            and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
                        name = node.args[0].value
                        if name in seen:
                            dups.append(f"{path.name}:{node.lineno} repeats line {seen[name]}: {name!r}")
                        seen.setdefault(name, node.lineno)
        self.assertEqual(dups, [])


class MotionLogTest(unittest.TestCase):
    # Qt pads %{time boot} to six digits: below 100000 s of uptime the line starts with spaces.
    PADDED = '  3110.598 js plastile_motion start "plastile-fixture 1" from=[8,8,691,784] to=[707,404,565,388] ms=2000'
    WIDE = '123456.789 js plastile_motion skip "plastile-fixture 2" reason=instant from=[707,8,565,388] to=[8,8,691,784]'

    def test_line_allows_the_padding(self):
        self.assertIsNotNone(scenarios_motion.LINE.match(self.PADDED))

    def test_padded_and_unpadded_timestamps_parse(self):
        recs = scenarios_motion.parse_motion([self.PADDED, self.WIDE])
        self.assertEqual([(r["t"], r["kind"], r["caption"]) for r in recs],
                         [(3110.598, "start", "plastile-fixture 1"), (123456.789, "skip", "plastile-fixture 2")])
        self.assertTrue(recs[1]["rest"].startswith("reason=instant"))

    def test_an_effect_line_the_parser_cannot_read_raises(self):
        with self.assertRaises(NestedError):
            scenarios_motion.parse_motion(['[3110.598] js plastile_motion start "plastile-fixture 1" from=[8,8,1,1]'])

    def test_other_lines_are_ignored(self):
        self.assertEqual(scenarios_motion.parse_motion(
            ["  3110.1 kwin_scripting plastile_motion/contents/code/main.js:12: TypeError: x is undefined"]), [])

    def test_log_seconds_allows_the_padding(self):
        self.assertEqual(scenarios_motion.log_seconds("   12.500 js PLT-L frame plastile-fixture 1|1,2,3,4"), 12.5)
        with self.assertRaises(NestedError):
            scenarios_motion.log_seconds("js PLT-L frame plastile-fixture 1")


class ProvenanceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
        self.git = lambda *a: subprocess.run(["git", "-C", str(self.root), *a], check=True, capture_output=True, env=env)
        self.git("init", "-q")
        for rel in ("src/a.ts", "effect/contents/code/main.js", "helper/main.cpp", "fixtures/client/client.c",
                    "tests/fixtures/replay/x.json", "docs/x.md", "package.json"):
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.root / rel).write_text("1\n")
        self.git("add", "-A")
        self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")

    def tearDown(self):
        self.dir.cleanup()

    def dirty_after(self, rel: str, exclude: tuple[str, ...] = ()) -> bool:
        (self.root / rel).write_text("2\n")
        return harness.provenance(self.root, exclude)["implementationDirty"]

    def test_clean_tree(self):
        p = harness.provenance(self.root)
        self.assertFalse(p["implementationDirty"])
        self.assertEqual(len(p["implementationCommit"]), 40)

    def test_effect_helper_fixtures_and_build_config_count(self):
        for rel in ("effect/contents/code/main.js", "helper/main.cpp", "fixtures/client/client.c", "package.json"):
            with self.subTest(rel=rel):
                self.assertTrue(self.dirty_after(rel))
                self.git("checkout", "-q", "--", rel)

    def test_documentation_and_untracked_links_do_not(self):
        self.assertFalse(self.dirty_after("docs/x.md"))
        os.symlink("/nonexistent", self.root / "node_modules")
        self.assertFalse(harness.provenance(self.root)["implementationDirty"])

    def test_an_excluded_path_does_not(self):
        self.assertFalse(self.dirty_after("tests/fixtures/replay/x.json", ("tests/fixtures/replay",)))
        self.assertTrue(harness.provenance(self.root)["implementationDirty"])


if __name__ == "__main__":
    unittest.main()
