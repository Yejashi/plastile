"""Block engine: plan design, binding resolution and an end-to-end block with fakes (no desktop).

The end-to-end test drives orchestrate.run_block with the dry keytap backend and fake
fixture processes that emit fixture-style events; it checks plumbing (files, phases,
warmup separation, safety stops, offline correlation), not compositor behaviour.
"""
from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import common  # noqa: E402
import orchestrate  # noqa: E402

CC = shutil.which(os.environ.get("CC", "cc")) or shutil.which("gcc") or shutil.which("clang")

FAKE_FIXTURE = r"""
import json, os, sys, time, select
ident, period_ms, mode = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
def now(): return time.clock_gettime_ns(time.CLOCK_MONOTONIC)
def out(**e): e['t_ns'] = now(); print(json.dumps(e), flush=True)
serial = seq = 0
w, h = 400, 300
active = ident == 1
out(ev='start', id=ident)
out(ev='presentation_clock', clk_id=1, name='CLOCK_MONOTONIC', same_as_log_clock=True)
def cycle(width, act):
    global serial, seq, w, active
    serial += 1; seq += 1; w = width; active = act
    out(ev='configure', win='main', serial=serial, width=w, height=h, states=['activated'] if active else [])
    out(ev='commit', win='main', seq=seq, width=w, height=h, serial=serial, reason='configure')
    if seq == 1: out(ev='mapped', win='main')
    out(ev='presented', win='main', seq=seq, present_ns=now() + 2_000_000, refresh_ns=16_666_666, flags=[])
cycle(w, active)
if mode == 'blur':
    time.sleep(0.2)
    cycle(w, False)  # something else took keyboard focus
k = 0
while True:
    r, _, _ = select.select([sys.stdin], [], [], period_ms / 1000)
    if r:
        line = sys.stdin.readline()
        if not line or line.strip() == 'quit':
            out(ev='exit', reason='quit'); break
    if mode == 'active' and period_ms < 10000:
        k += 1
        cycle(400 + (k % 2) * 10, active)
"""


class FakeDriver(orchestrate.Driver):
    layer = "synthetic"
    input_source = "dry keytap (no device)"

    def __init__(self, script: Path, period_ms: float, mode: str):
        self.script, self.period_ms, self.mode = script, period_ms, mode
        self.conditions = []

    def ensure_condition(self, condition):
        self.conditions.append(condition)

    def spawn_fixture(self, ident, log_name):
        return subprocess.Popen([sys.executable, str(self.script), str(ident), str(self.period_ms), self.mode],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def counters(self):
        return {"counters": {"solves": 1, "writes": 2}}


class PlanTests(unittest.TestCase):
    def test_randomized_complete_blocks(self):
        wl = orchestrate.load_workloads()
        names = ["P00-maximize", "P02-quicktile", "P03-ratio", "P03-focus"]
        plan = orchestrate.make_plan(names, [1, 4], 5, seed=42, wl_defs=wl)
        # P03-* need >= 2 windows: 2 + 2 + 1 + 1 = 6 cells per round
        self.assertEqual(len(plan), 30)
        for r in range(5):
            cells = sorted((b["workload"], b["windowCount"]) for b in plan if b["round"] == r)
            self.assertEqual(len(cells), len(set(cells)))
            self.assertEqual(len(cells), 6)
            self.assertNotIn(("P03-ratio", 1), cells)
        orders = {tuple(b["workload"] for b in plan if b["round"] == r) for r in range(5)}
        self.assertGreater(len(orders), 1, "rounds should not all share one order")
        self.assertEqual(plan, orchestrate.make_plan(names, [1, 4], 5, seed=42, wl_defs=wl))
        self.assertNotEqual(plan, orchestrate.make_plan(names, [1, 4], 5, seed=43, wl_defs=wl))
        self.assertEqual([b["index"] for b in plan], list(range(30)))

    def test_default_selection_skips_optional(self):
        wl = orchestrate.load_workloads()
        self.assertNotIn("P00-switch", orchestrate.select_workloads(wl, None))
        self.assertEqual(orchestrate.select_workloads(wl, "P00-switch"), ["P00-switch"])
        with self.assertRaises(SystemExit):
            orchestrate.select_workloads(wl, "P99-nope")

    def test_workload_file_is_consistent(self):
        wl = orchestrate.load_workloads()
        for name, w in wl.items():
            if w.get("matchedBaseline"):
                self.assertEqual(wl[w["matchedBaseline"]]["condition"], "none", name)
                self.assertEqual(wl[w["matchedBaseline"]]["expect"], w["expect"], name)


class BindingTests(unittest.TestCase):
    def test_resolution(self):
        b = orchestrate.resolve_bindings(["plastile.focus.next", "Window Maximize"],
                                         {"plastile.focus.next": ["Meta+Shift+N"], "Window Maximize": ["Meta+PgUp"]}, {})
        self.assertEqual(b["plastile.focus.next"], {"sequence": "Meta+Shift+N", "mods": [125, 42], "key": 49})
        b = orchestrate.resolve_bindings(["plastile.resize.grow"], {"plastile.resize.grow": ["Meta+Shift+="]},
                                         {"plastile.resize.grow": "Meta+Ctrl+="})
        self.assertEqual(b["plastile.resize.grow"]["mods"], [125, 29])

    def test_refusals(self):
        with self.assertRaises(orchestrate.Abort) as cm:
            orchestrate.resolve_bindings(["a", "b", "c"], {"a": [], "b": ["Ctrl+Q"], "c": ["Meta+K, Meta+L"]}, {})
        msg = str(cm.exception)
        self.assertIn("a: no key bound", msg)
        self.assertIn("no Meta modifier", msg)
        self.assertIn("single chords only", msg)

    def test_parse_bindings_cli(self):
        self.assertEqual(orchestrate.parse_bindings(["x=Meta+A", "plastile.y = Meta+B"]),
                         {"x": "Meta+A", "plastile.y": "Meta+B"})
        with self.assertRaises(SystemExit):
            orchestrate.parse_bindings(["nope"])


@unittest.skipIf(CC is None, "no C compiler")
class BlockEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        cls.keytap = d / "plastile-keytap"
        subprocess.run([CC, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", str(HERE.parent / "keytap.c"), "-o",
                        str(cls.keytap)], check=True)
        cls.script = d / "fake_fixture.py"
        cls.script.write_text(FAKE_FIXTURE)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _run(self, mode: str, period_ms: float, samples=6, warmup=2, max_misses=10, windows=2):
        out = Path(tempfile.mkdtemp(dir=self.tmp.name))
        mon = orchestrate.Monitor()
        kt = orchestrate.KeyTap([str(self.keytap), "--backend", "dry", "--min-interval-ms", "0", "--hold-ms", "1",
                                 "--gap-ms", "0"], mon, out / "keytap.jsonl")
        kt.wait_ready()
        wl = {"condition": "plastile", "expect": "resize", "setup": ["setup.action"], "cycle": ["a.one", "a.two"]}
        bindings = {a: {"sequence": "Meta+X", "mods": [125], "key": 45} for a in ("setup.action", "a.one", "a.two")}
        params = orchestrate.Params(samples=samples, warmup=warmup, gap_min_ms=1, gap_max_ms=3, effect_timeout_ms=150,
                                    sample_timeout_ms=400, max_misses=max_misses, refresh_hz=60)
        driver = FakeDriver(self.script, period_ms, mode)
        block = {"index": 0, "round": 0, "workload": "P03-ratio", "windowCount": windows}
        try:
            meta = orchestrate.run_block(driver, kt, mon, block, wl, bindings, params, random.Random(1), out)
        finally:
            kt.close()
        return out, meta, driver

    def test_completed_block_files_and_records(self):
        out, meta, driver = self._run("active", 40)
        self.assertEqual(meta["outcome"], "completed")
        self.assertEqual(driver.conditions, ["plastile"])
        self.assertEqual(meta["taps"], 1 + 2 + 6)
        self.assertEqual(meta["countersBefore"], {"counters": {"solves": 1, "writes": 2}})
        bdir = out / meta["dir"]
        taps = common.read_jsonl(bdir / "taps.jsonl")
        self.assertEqual([t["phase"] for t in taps], ["setup"] + ["warmup"] * 2 + ["measure"] * 6)
        self.assertEqual([t["action"] for t in taps[1:5]], ["a.one", "a.two", "a.one", "a.two"])
        self.assertEqual(sorted(p.name for p in bdir.glob("fixture-*.jsonl")), ["fixture-1.jsonl", "fixture-2.jsonl"])
        self.assertTrue(json.loads((bdir / "block.json").read_text())["endedNs"] > 0)
        ctx = {"stamp": "s", "layer": "synthetic", "inputSource": "dry", "environmentId": "synthetic",
               "refreshHzDeclared": 60}
        samples, warmups, problems = orchestrate.correlate_dir(out, ctx, {"P03-ratio": {"expect": "resize"}})
        self.assertEqual(problems, [])
        self.assertEqual(len(samples), 6)
        self.assertEqual(len(warmups), 2)
        self.assertTrue(all(r["warmup"] for r in warmups))
        self.assertEqual([r["sample"] for r in samples], list(range(6)))
        # the fake fixtures change size every 40 ms on their own, so every window sees a resize
        self.assertGreaterEqual(sum(r["success"] for r in samples), 5)
        for p in (bdir / "fixture-1.jsonl", bdir / "fixture-2.jsonl"):
            self.assertTrue(any(json.loads(l).get("ev") == "exit" for l in p.read_text().splitlines()))

    def test_safety_stop_after_consecutive_misses(self):
        with self.assertRaises(orchestrate.Abort) as cm:
            self._run("idle", 100000, samples=20, warmup=0, max_misses=3)
        self.assertIn("3 consecutive taps produced no configure", str(cm.exception))

    def test_block_stops_when_focus_leaves_the_fixtures(self):
        out, meta, _ = self._run("blur", 100000, samples=5, warmup=0)
        self.assertTrue(meta["outcome"].startswith("aborted: keyboard focus"), meta["outcome"])


if __name__ == "__main__":
    unittest.main()
