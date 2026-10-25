#!/usr/bin/env python3
"""Physical input-to-visible latency runs for Plastile (PERFORMANCE P00-P03).

Runs workloads against the RUNNING live Plasma Wayland session through its real global
shortcuts: a uinput virtual keyboard (build/physical/plastile-keytap) presses each chord,
controlled fixture clients (fixtures/client) report wp_presentation feedback, and
tools/physical/latency.py correlates the two on CLOCK_MONOTONIC.

    python3 tools/physical/orchestrate.py plan [--workloads ...] [--windows 4] [--rounds 5] [--seed N]
    python3 tools/physical/orchestrate.py run --output HDMI-A-1 [--toggle manual|dbus] [--rounds 5]
        [--samples 1000] [--warmup 50] [--windows 4] [--workloads P00-maximize,...] [--binding ACTION=CHORD]
    python3 tools/physical/orchestrate.py correlate artifacts/physical/<stamp>   # recompute records offline

Design:
- Randomized complete blocks: each round runs every (workload, window count) once, in a
  seeded random order, so baselines and Plastile alternate across the session's drift.
  One block is one "run" for the bootstrap. Warmup taps are recorded to warmup.jsonl,
  never pooled with samples.jsonl.
- Conditions: 'none' needs Plastile NOT loaded, 'plastile' needs it loaded. With
  --toggle manual (default) the script tells you what to change and verifies it read-only
  (org.kde.kwin.Scripting.isScriptLoaded). With --toggle dbus (explicit consent) it calls
  org.kde.kwin.Scripting.unloadScript / start itself: neither writes kwinrc; the loaded
  state you started with is restored on every exit path.
- Safety stops: the run refuses to start outside a live, non-nested KWin Wayland session
  (common.guard_live_session) or when a chord lacks Meta; a block stops when keyboard focus
  leaves the fixture windows, or after --max-consecutive-misses taps without any effect.
- Nothing here writes kwinrc or kglobalshortcutsrc, or restarts the compositor.

Results: artifacts/physical/<stamp>/ (see docs/validation/PHYSICAL_RUNBOOK.md).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import common  # noqa: E402
import latency  # noqa: E402
import summarize  # noqa: E402

WORKLOAD_FILE = HERE / "workloads.json"


class Abort(RuntimeError):
    """Stop the whole run (safety stop or user abort)."""


class BlockAbort(RuntimeError):
    """Stop the current block; the run may continue."""


# ----------------------------------------------------------------------- workloads


def load_workloads(path: Path = WORKLOAD_FILE) -> dict[str, dict]:
    data = json.loads(path.read_text())
    wl = data["workloads"]
    for name, w in wl.items():
        if w.get("condition") not in ("none", "plastile"):
            raise ValueError(f"{name}: condition must be 'none' or 'plastile'")
        if w.get("expect") not in ("resize", "activate"):
            raise ValueError(f"{name}: expect must be 'resize' or 'activate'")
        if not w.get("cycle"):
            raise ValueError(f"{name}: empty cycle")
        baselines = ([w["matchedBaseline"]] if w.get("matchedBaseline") else []) + list(w.get("controlBaselines", []))
        for c in baselines:
            if c not in wl or c == name:
                raise ValueError(f"{name}: unknown baseline {c}")
    return wl


def select_workloads(all_wl: dict[str, dict], names: str | None) -> list[str]:
    if not names:
        return [n for n, w in all_wl.items() if not w.get("optional")]
    chosen = [n.strip() for n in names.split(",") if n.strip()]
    unknown = [n for n in chosen if n not in all_wl]
    if unknown:
        raise SystemExit(f"unknown workloads: {', '.join(unknown)} (known: {', '.join(all_wl)})")
    return chosen


def missing_baselines(all_wl: dict[str, dict], names: list[str]) -> list[str]:
    """Selected candidates whose matched baseline is not selected: they will get no verdict."""
    return [f"{n}: matched baseline {all_wl[n]['matchedBaseline']} is not selected, so {n} gets no verdict "
            f"(add it with --workloads)" for n in names
            if all_wl[n].get("matchedBaseline") and all_wl[n]["matchedBaseline"] not in names]


def make_plan(workloads: list[str], windows: list[int], rounds: int, seed: int,
              wl_defs: dict[str, dict] | None = None) -> list[dict]:
    """Randomized complete block design: every round contains each cell once, shuffled."""
    rng = random.Random(seed)
    cells = [(w, n) for w in workloads for n in windows
             if wl_defs is None or n >= wl_defs[w].get("minWindows", 1)]
    plan = []
    for r in range(rounds):
        order = cells[:]
        rng.shuffle(order)
        for w, n in order:
            plan.append({"index": len(plan), "round": r, "workload": w, "windowCount": n})
    return plan


def resolve_bindings(actions: list[str], shortcuts: dict[str, list[str]], overrides: dict[str, str]) -> dict[str, dict]:
    """action -> {sequence, mods, key}. Refuses unbound actions and chords without Meta."""
    out, problems = {}, []
    for a in actions:
        seq = overrides.get(a)
        if seq is None:
            seqs = shortcuts.get(a) or []
            if not seqs:
                problems.append(f"{a}: no key bound in kglobalshortcutsrc (bind one, or pass --binding {a}=CHORD)")
                continue
            seq = seqs[0]
        try:
            mods, key = common.parse_sequence(seq)
        except common.KeySpecError as exc:
            problems.append(f"{a}: {exc}")
            continue
        if not common.has_meta(mods):
            problems.append(f"{a}: {seq!r} has no Meta modifier; the injector only sends Meta chords")
            continue
        out[a] = {"sequence": seq, "mods": mods, "key": key}
    if problems:
        raise Abort("cannot resolve key bindings:\n  " + "\n  ".join(problems))
    return out


# ------------------------------------------------------------------- event plumbing


class Monitor:
    """Event-driven reader for fixture and injector pipes (selectors; no polling loop)."""

    def __init__(self):
        self.sel = selectors.DefaultSelector()

    def add(self, fileobj, handler) -> None:
        os.set_blocking(fileobj.fileno(), False)
        self.sel.register(fileobj, selectors.EVENT_READ, handler)

    def remove(self, fileobj) -> None:
        try:
            self.sel.unregister(fileobj)
        except (KeyError, ValueError):
            pass

    def pump(self, timeout: float) -> None:
        for key, _ in self.sel.select(max(0.0, timeout)):
            try:
                data = os.read(key.fd, 1 << 16)
            except BlockingIOError:
                continue
            except OSError:
                data = b""
            if not data:
                self.remove(key.fileobj)
            key.data(data)

    def wait_until(self, pred, timeout_s: float) -> bool:
        deadline = time.monotonic() + timeout_s
        while True:
            if pred():
                return True
            left = deadline - time.monotonic()
            if left <= 0:
                return pred()
            self.pump(min(left, 0.25))


class LineSink:
    def __init__(self, raw_path: Path, on_record):
        self.raw = open(raw_path, "ab")
        self.buf = b""
        self.on_record = on_record
        self.eof = False

    def feed(self, data: bytes) -> None:
        if not data:
            self.eof = True
            self.raw.flush()
            return
        self.raw.write(data)
        self.buf += data
        *lines, self.buf = self.buf.split(b"\n")
        for line in lines:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            self.on_record(rec)

    def close(self) -> None:
        try:
            self.raw.close()
        except OSError:
            pass


class Fixture:
    """One controlled client and its online state (for pacing and safety only)."""

    def __init__(self, ident: int, proc: subprocess.Popen, log_path: Path, monitor: Monitor):
        self.ident, self.proc, self.log_path = ident, proc, log_path
        self.mapped = False
        self.activated: bool | None = None
        self.pending: dict[int, int] = {}  # commit seq -> commit t_ns, until presented/discarded
        self.last_event_ns = 0
        self.last_cfg_ns = 0
        self.refresh_ns: int | None = None
        self.presented = 0
        self.exited = False
        self.sink = LineSink(log_path, self._on)
        monitor.add(proc.stdout, self.sink.feed)

    def _on(self, e: dict) -> None:
        ev = e.get("ev")
        if ev == "exit":
            self.exited = True
        if e.get("win", "main") != "main":
            return
        t = int(e.get("t_ns", 0))
        if ev == "configure":
            self.last_cfg_ns = self.last_event_ns = t
            self.activated = "activated" in (e.get("states") or [])
        elif ev == "commit":
            self.pending[int(e["seq"])] = t
            self.last_event_ns = t
            for s in [s for s, ts in self.pending.items() if t - ts > 5_000_000_000]:
                del self.pending[s]
        elif ev == "mapped":
            self.mapped = True
        elif ev == "presented":
            self.pending.pop(int(e["seq"]), None)
            self.presented += 1
            if e.get("refresh_ns"):
                self.refresh_ns = int(e["refresh_ns"])
        elif ev == "discarded":
            self.pending.pop(int(e["seq"]), None)

    def quit(self) -> None:
        try:
            self.proc.stdin.write(b"quit\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass


class KeyTap:
    """The injector process. tap() returns its timestamped record or raises."""

    def __init__(self, argv: list[str], monitor: Monitor, log_path: Path, pass_fds=(), env=None):
        self.monitor = monitor
        self.records: dict[str, dict] = {}
        self.errors: dict[str, str] = {}
        self.ready: dict | None = None
        self.exit: dict | None = None
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, pass_fds=pass_fds, env=env)
        self.sink = LineSink(log_path, self._on)
        monitor.add(self.proc.stdout, self.sink.feed)

    def _on(self, rec: dict) -> None:
        ev = rec.get("ev")
        if ev == "ready":
            self.ready = rec
        elif ev == "tap":
            self.records[rec["id"]] = rec
        elif ev == "exit":
            self.exit = rec
        elif ev == "error":
            msg = rec.get("msg", "")
            parts = msg.split(" ", 2)
            if len(parts) >= 2 and parts[0] == "tap":
                self.errors[parts[1].rstrip(":")] = msg
            else:
                self.errors["_"] = msg

    def wait_ready(self, timeout_s: float = 15.0) -> dict:
        self.monitor.wait_until(lambda: self.ready is not None or self.exit is not None or self.proc.poll() is not None,
                                timeout_s)
        if self.ready is None:
            raise Abort(f"injector did not become ready: {self.errors.get('_') or self.exit or 'timeout'}")
        return self.ready

    def tap(self, tap_id: str, mods: list[int], key: int, timeout_s: float = 3.0) -> dict:
        line = f"tap {tap_id} {','.join(map(str, mods)) if mods else '-'} {key}\n"
        try:
            self.proc.stdin.write(line.encode())
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise Abort(f"injector is gone: {exc}") from exc
        self.monitor.wait_until(lambda: tap_id in self.records or tap_id in self.errors or self.exit is not None,
                                timeout_s)
        if tap_id in self.records:
            return self.records[tap_id]
        raise Abort(f"tap {tap_id} failed: {self.errors.get(tap_id) or self.exit or 'no answer'}")

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write(b"quit\n")
                self.proc.stdin.flush()
                self.proc.stdin.close()
            except (BrokenPipeError, OSError, ValueError):
                pass
            self.monitor.wait_until(lambda: self.proc.poll() is not None, 5.0)
            if self.proc.poll() is None:
                self.proc.send_signal(signal.SIGTERM)  # keytap releases keys and destroys the device
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        self.monitor.pump(0)
        self.sink.close()


# --------------------------------------------------------------------------- drivers


class Driver:
    """Where fixtures run and how the tiler condition is controlled."""
    layer = "physical"
    input_source = "uinput virtual keyboard (kernel evdev) via plastile-keytap"

    def ensure_condition(self, condition: str) -> None:
        raise NotImplementedError

    def spawn_fixture(self, ident: int, log_name: str) -> subprocess.Popen:
        raise NotImplementedError

    def counters(self) -> dict | None:
        return None

    def motion(self) -> dict | None:
        """Plastile Motion's state for a block (PERFORMANCE section 6.1), or None when not observable."""
        return None

    def before_block(self, block: dict) -> None:
        pass

    def close(self) -> None:
        pass


class LiveDriver(Driver):
    def __init__(self, bus: common.Bus, toggle: str, output: str, assume_yes: bool):
        self.bus, self.toggle, self.output, self.assume_yes = bus, toggle, output, assume_yes
        self.initial_loaded = bus.script_loaded()
        if self.initial_loaded is None:
            raise Abort("cannot read org.kde.kwin.Scripting.isScriptLoaded on the session bus")

    def ensure_condition(self, condition: str) -> None:
        want = condition == "plastile"
        if self.bus.script_loaded() is want:
            return
        if self.toggle == "dbus":
            if want:
                self.bus.call("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", "start")
            else:
                self.bus.call("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", "unloadScript", "s", common.PLUGIN)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if self.bus.script_loaded() is want:
                    time.sleep(1.0)  # let a freshly loaded Plastile adopt windows and register shortcuts
                    return
                time.sleep(0.5)
            raise Abort(f"Plastile did not become {'loaded' if want else 'unloaded'} within 30 s")
        verb = "ENABLE (tick) and Apply" if want else "DISABLE (untick) and Apply"
        while self.bus.script_loaded() is not want:
            print(f"\n>>> This block needs Plastile {'LOADED' if want else 'NOT loaded'}.\n"
                  f"    System Settings > Window Management > KWin Scripts: {verb} Plastile.\n"
                  "    Then press Enter here (or type 'abort').")
            try:
                if input().strip().lower() == "abort":
                    raise Abort("aborted by the user")
            except EOFError:
                raise Abort("no terminal input to confirm the condition change") from None
        time.sleep(1.0)

    def restore(self) -> None:
        now = self.bus.script_loaded()
        if now is self.initial_loaded:
            return
        if self.toggle != "dbus":
            print(f"NOTE: Plastile is now {'loaded' if now else 'not loaded'}; it was "
                  f"{'loaded' if self.initial_loaded else 'not loaded'} when the run started.")
            return
        try:
            self.ensure_condition("plastile" if self.initial_loaded else "none")
            print(f"restored Plastile to {'loaded' if self.initial_loaded else 'not loaded'}")
        except (Abort, RuntimeError) as exc:
            print(f"WARNING: could not restore Plastile's loaded state: {exc}", file=sys.stderr)

    def motion(self) -> dict | None:
        return common.motion_state(self.bus)

    def spawn_fixture(self, ident: int, log_name: str) -> subprocess.Popen:
        return subprocess.Popen([str(common.FIXTURE), "--ssd", "--id", str(ident), "--app-id", "plastile-fixture",
                                 "--title", f"plastile-physical {ident}"],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    @staticmethod
    def _journal_cursor() -> str | None:
        try:
            r = subprocess.run(["journalctl", "--user", "-n", "1", "--show-cursor", "-o", "cat", "--no-pager"],
                               capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            return None
        for line in reversed(r.stdout.splitlines()):
            if line.startswith("-- cursor: "):
                return line[len("-- cursor: "):].strip()
        return None

    def counters(self) -> dict | None:
        """Ask the live Plastile to log its counters, then read that new line from the user journal.

        Only lines after a journal cursor taken before the request count, so an earlier
        counters line can never be mistaken for the answer.
        """
        cursor = self._journal_cursor()
        since = time.time() - 1
        try:
            self.bus.call("org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component",
                          "invokeShortcut", "s", "plastile.inspect.counters")
        except RuntimeError as exc:
            return {"unavailableReason": f"invokeShortcut failed: {exc}"}
        where = [f"--after-cursor={cursor}"] if cursor else ["--since", f"@{since:.0f}"]
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                r = subprocess.run(["journalctl", "--user", *where, "-o", "cat", "--no-pager"],
                                   capture_output=True, text=True, timeout=10)
            except (OSError, subprocess.TimeoutExpired) as exc:
                return {"unavailableReason": f"journalctl failed: {exc}"}
            lines = [ln for ln in r.stdout.splitlines() if "plastile counters " in ln]
            if lines:
                try:
                    return json.loads(lines[-1].split("plastile counters ", 1)[1])
                except (json.JSONDecodeError, IndexError):
                    return {"unavailableReason": "counters line not parseable"}
            time.sleep(0.3)
        return {"unavailableReason": "no 'plastile counters' line in the user journal within 3 s"}


# ------------------------------------------------------------------------- execution


class Params:
    def __init__(self, **kw):
        self.samples = kw.get("samples", 1000)
        self.warmup = kw.get("warmup", 50)
        self.gap_min_ms = kw.get("gap_min_ms", 30.0)
        self.gap_max_ms = kw.get("gap_max_ms", 90.0)
        self.sample_timeout_ms = kw.get("sample_timeout_ms", 2000.0)
        self.max_misses = kw.get("max_misses", 10)
        self.map_timeout_s = kw.get("map_timeout_s", 15.0)
        self.counters = kw.get("counters", True)
        self.refresh_hz = kw.get("refresh_hz")


def wait_settle(monitor: Monitor, fixtures: list[Fixture], t0: int, quiet_ns: int, sample_timeout_ns: int) -> str:
    """Pacing only: 'settled', 'no-effect' or 'timeout'. Records are computed offline.

    The next tap is sent only after this returns, and latency.correlate attributes configures
    up to the same sample timeout, so a slow response is never taken for the next tap's.
    """
    while True:
        now = common.monotonic_ns()
        cfg_seen = any(f.last_cfg_ns >= t0 for f in fixtures)
        wake = t0 + sample_timeout_ns
        if cfg_seen:
            pending = any(ts >= t0 for f in fixtures for ts in f.pending.values())
            last = max(f.last_event_ns for f in fixtures)
            if not pending and now - last >= quiet_ns:
                return "settled"
            if not pending:
                wake = min(wake, last + quiet_ns)
        if now - t0 >= sample_timeout_ns:
            return "timeout" if cfg_seen else "no-effect"
        monitor.pump(max(0.001, (wake - now) / 1e9))


def run_block(driver: Driver, keytap: KeyTap, monitor: Monitor, block: dict, wl: dict, bindings: dict[str, dict],
              params: Params, rng: random.Random, outdir: Path) -> dict:
    bdir = outdir / "blocks" / f"{block['index']:03d}-{block['workload']}-n{block['windowCount']}"
    bdir.mkdir(parents=True, exist_ok=True)
    meta = {**block, "condition": wl["condition"], "expect": wl["expect"], "dir": str(bdir.relative_to(outdir)),
            "startedNs": common.monotonic_ns(), "outcome": None, "taps": 0, "sampleTimeoutMs": params.sample_timeout_ms}
    taps_out = open(bdir / "taps.jsonl", "w")
    fixtures: list[Fixture] = []
    try:
        driver.ensure_condition(wl["condition"])
        driver.before_block(block)
        meta["motion"] = driver.motion()
        for i in range(1, block["windowCount"] + 1):
            proc = driver.spawn_fixture(i, f"fixture-{i}")
            fixtures.append(Fixture(i, proc, bdir / f"fixture-{i}.jsonl", monitor))
        if not monitor.wait_until(lambda: all(f.mapped and f.presented for f in fixtures), params.map_timeout_s):
            raise BlockAbort("fixture windows did not map and present in time")
        monitor.wait_until(lambda: False, 0.5)  # let placement / tiling settle
        observed = sorted(f.refresh_ns for f in fixtures if f.refresh_ns)
        meta["refreshNsObservedAtStart"] = observed[len(observed) // 2] if observed else None
        if params.refresh_hz and observed:
            want = 1e9 / params.refresh_hz
            if abs(meta["refreshNsObservedAtStart"] - want) > latency.REFRESH_TOLERANCE * want:
                # Every later block would open on the same wrong output: stop the run.
                raise Abort(f"fixtures present at {1e9 / meta['refreshNsObservedAtStart']:.2f} Hz, the target output "
                            f"runs at {params.refresh_hz} Hz: they opened on another output. Move the pointer to the "
                            "output under test, focus an empty desktop there, and start the run again")
        refresh_ns = meta["refreshNsObservedAtStart"] or int(1e9 / 60)
        quiet_ns = max(3 * refresh_ns, 30_000_000)
        if params.counters and wl["condition"] == "plastile":
            meta["countersBefore"] = driver.counters()
        seq = 0

        def tap(action: str, phase: str, sample: int | None) -> str:
            nonlocal seq
            if not any(f.activated for f in fixtures):
                raise BlockAbort("keyboard focus is not on a fixture window (did something else take focus?)")
            b = bindings[action]
            tap_id = f"b{block['index']:03d}t{seq:05d}"
            seq += 1
            rec = keytap.tap(tap_id, b["mods"], b["key"])
            meta["taps"] += 1
            res = wait_settle(monitor, fixtures, int(rec["t_input_ns"]), quiet_ns, int(params.sample_timeout_ms * 1e6))
            taps_out.write(json.dumps({**rec, "action": action, "phase": phase, "sample": sample,
                                       "sequence": b["sequence"], "pacing": res}) + "\n")
            monitor.wait_until(lambda: False, rng.uniform(params.gap_min_ms, params.gap_max_ms) / 1000)
            return res

        for action in wl.get("setup", []):
            tap(action, "setup", None)
        misses = 0
        cycle = wl["cycle"]
        total = params.warmup + params.samples
        for k in range(total):
            warm = k < params.warmup
            res = tap(cycle[k % len(cycle)], "warmup" if warm else "measure", k if warm else k - params.warmup)
            misses = misses + 1 if res == "no-effect" else 0
            if misses >= params.max_misses:
                raise Abort(f"{misses} consecutive taps produced no configure: the chords are not reaching the "
                            "fixtures (unbound or rebound shortcut, wrong condition, or focus elsewhere); stopping")
        meta["outcome"] = "completed"
    except BlockAbort as exc:
        meta["outcome"] = f"aborted: {exc}"
        print(f"  block {block['index']} aborted: {exc}", file=sys.stderr)
    except Abort as exc:
        meta["outcome"] = f"aborted run: {exc}"
        raise
    finally:
        taps_out.close()
        if params.counters and wl["condition"] == "plastile" and meta.get("countersBefore") is not None:
            meta["countersAfter"] = driver.counters()
        for f in fixtures:
            f.quit()
        monitor.wait_until(lambda: all(f.proc.poll() is not None for f in fixtures), 5.0)
        for f in fixtures:
            if f.proc.poll() is None:
                f.proc.terminate()
                try:
                    f.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    f.proc.kill()
        monitor.pump(0)
        for f in fixtures:
            monitor.remove(f.proc.stdout)
            f.sink.close()
        meta["endedNs"] = common.monotonic_ns()
        with open(bdir / "block.json", "w") as fh:
            json.dump(meta, fh, indent=1)
    return meta


def counters_delta(meta: dict) -> dict | None:
    a, b = meta.get("countersBefore"), meta.get("countersAfter")
    if not a or not b or "counters" not in a or "counters" not in b:
        return None
    return {k: b["counters"][k] - a["counters"].get(k, 0) for k in b["counters"]}


def execute(driver: Driver, keytap: KeyTap, monitor: Monitor, plan: list[dict], wl_defs: dict[str, dict],
            bindings: dict[str, dict], params: Params, seed: int, outdir: Path) -> list[dict]:
    rng = random.Random(seed + 7919)
    blocks = []
    with open(outdir / "blocks.jsonl", "a") as bl:
        for block in plan:
            wl = wl_defs[block["workload"]]
            print(f"[{block['index'] + 1}/{len(plan)}] round {block['round'] + 1}: {block['workload']} "
                  f"({wl['condition']}), {block['windowCount']} windows", flush=True)
            meta = run_block(driver, keytap, monitor, block, wl, bindings, params, rng, outdir)
            meta["countersDelta"] = counters_delta(meta)
            bl.write(json.dumps(meta) + "\n")
            bl.flush()
            blocks.append(meta)
    return blocks


def correlate_dir(outdir: Path, ctx: dict, wl_defs: dict[str, dict]) -> tuple[list[dict], list[dict], list[str]]:
    """Recompute every record from the raw logs of a results directory."""
    samples, warmups, problems = [], [], []
    metas = [json.loads(p.read_text()) for p in sorted((outdir / "blocks").glob("*/block.json"))]
    ctx["_blocks"] = metas
    for meta in metas:
        bdir = outdir / meta["dir"]
        taps = common.read_jsonl(bdir / "taps.jsonl") if (bdir / "taps.jsonl").exists() else []
        if not taps:
            continue
        windows = [latency.load_fixture(p.stem, common.read_jsonl(p)) for p in sorted(bdir.glob("fixture-*.jsonl"))]
        wl = wl_defs[meta["workload"]]
        refresh_ns = int(round(1e9 / ctx["refreshHzDeclared"])) if ctx.get("refreshHzDeclared") else None
        results = latency.correlate(taps, windows, expect=wl["expect"], refresh_ns_declared=refresh_ns,
                                    end_ns=meta.get("endedNs"),
                                    timeout_ns=int(meta.get("sampleTimeoutMs", latency.DEFAULT_TIMEOUT_NS / 1e6) * 1e6))
        motion = meta.get("motion") or {}
        by_id = {r["tapId"]: r for r in results}
        meta["presentGrid"] = latency.present_grid(windows, meta.get("refreshNsObservedAtStart"))
        for t in taps:
            if t.get("phase") == "setup":
                continue
            rec = latency.to_record(by_id[t["id"]], {
                **ctx, "runId": f"{ctx['stamp']}-b{meta['index']:03d}", "workload": meta["workload"],
                "condition": meta["condition"], "action": t["action"], "keys": t.get("sequence"),
                "warmup": t["phase"] == "warmup", "run": meta["index"], "round": meta["round"],
                "sample": t["sample"], "windowCount": meta["windowCount"], "motion": motion.get("label"),
                "motionOn": bool(motion.get("on"))})
            # Samples taken before a block abort stay in the data; the block outcome is reported
            # next to them in summary.json ("blocks"), never used to drop samples.
            errs = latency.validate_record(rec)
            if errs:
                problems.append(f"{t['id']}: {'; '.join(errs)}")
            (warmups if rec["warmup"] else samples).append(rec)
    return samples, warmups, problems


def finish(outdir: Path, ctx: dict, wl_defs: dict[str, dict], bootstrap: int = 2000, seed: int = 1) -> dict:
    samples, warmups, problems = correlate_dir(outdir, ctx, wl_defs)
    common.write_jsonl(outdir / "samples.jsonl", samples)
    common.write_jsonl(outdir / "warmup.jsonl", warmups)
    matched = {n: w["matchedBaseline"] for n, w in wl_defs.items() if w.get("matchedBaseline")}
    controls = {n: list(w["controlBaselines"]) for n, w in wl_defs.items() if w.get("controlBaselines")}
    s = summarize.summarize(samples, warmup=warmups, matched=matched, controls=controls, b=bootstrap, seed=seed)
    s["context"] = {k: ctx.get(k) for k in ("layer", "inputSource", "environmentId", "outputName", "refreshHzDeclared",
                                             "implementationCommit", "implementationDirty", "clockResolutionNs")}
    s["schemaProblems"] = problems
    s["blocks"] = [{"index": m["index"], "round": m["round"], "workload": m["workload"], "condition": m["condition"],
                    "windowCount": m["windowCount"], "outcome": m.get("outcome"), "taps": m.get("taps"),
                    "motion": m.get("motion"),
                    "refreshNsObservedAtStart": m.get("refreshNsObservedAtStart"),
                    "countersDelta": counters_delta(m), "presentGrid": m.get("presentGrid")}
                   for m in ctx.pop("_blocks", [])]
    s["blockChecks"] = block_checks(s["blocks"], wl_defs)
    (outdir / "summary.json").write_text(json.dumps(s, indent=1) + "\n")
    red = summarize.redact(s)
    red["context"] = s["context"]
    red["blocks"] = s["blocks"]
    red["blockChecks"] = s["blockChecks"]
    (outdir / "summary-redacted.json").write_text(json.dumps(red, indent=1) + "\n")
    print(summarize.render(s))
    for w in s["blockChecks"]:
        print(f"CHECK: {w}")
    if problems:
        print(f"WARNING: {len(problems)} records failed schema validation (see summary.json)", file=sys.stderr)
    return s


def block_checks(blocks: list[dict], wl_defs: dict[str, dict]) -> list[str]:
    """Functional gates and validity problems per block (reported, never used to drop samples).

    - an aborted block;
    - Plastile layout overflow or errors during a block (the measured layout was not the intended one);
    - PERFORMANCE section 4 "focus-only command: zero geometry writes and zero ordinary-layout solves"
      for Plastile workloads whose expected effect is activation only;
    - presentations off the output's refresh grid (frame-pacing sanity, < 95 % aligned).
    """
    out = []
    for b in blocks:
        tag = f"block {b['index']} {b['workload']} n={b['windowCount']}"
        if b.get("outcome") != "completed":
            out.append(f"{tag}: {b.get('outcome')}")
        d = b.get("countersDelta") or {}
        if d.get("overflow"):
            out.append(f"{tag}: Plastile overflow x{d['overflow']} (windows did not fit; use fewer windows)")
        if d.get("errors"):
            out.append(f"{tag}: Plastile errors x{d['errors']} during the block")
        wl = wl_defs.get(b["workload"], {})
        if wl.get("condition") == "plastile" and wl.get("expect") == "activate" and d and \
                (d.get("solves") or d.get("writes")):
            out.append(f"{tag}: focus-only workload issued {d.get('solves')} solves / {d.get('writes')} writes "
                       "(PERFORMANCE section 4 requires zero)")
        g = b.get("presentGrid")
        if g and g["alignedFraction"] < 0.95:
            out.append(f"{tag}: only {g['alignedFraction']:.0%} of presentation intervals on the refresh grid")
    return out


# ------------------------------------------------------------------------------ CLI


def parse_bindings(items: list[str]) -> dict[str, str]:
    out = {}
    for it in items or []:
        if "=" not in it:
            raise SystemExit(f"--binding expects ACTION=CHORD, got {it!r}")
        a, seq = it.split("=", 1)
        out[a.strip()] = seq.strip()
    return out


def cmd_plan(args) -> int:
    wl = load_workloads(args.workload_file)
    names = select_workloads(wl, args.workloads)
    plan = make_plan(names, [int(x) for x in args.windows.split(",")], args.rounds, args.seed, wl)
    for note in missing_baselines(wl, names):
        print(f"NOTE: {note}")
    for b in plan:
        print(f"{b['index']:3d} round {b['round'] + 1}: {b['workload']:<14} [{wl[b['workload']]['condition']}] "
              f"n={b['windowCount']}")
    per_cell = args.rounds * args.samples
    print(f"{len(plan)} blocks; {per_cell} measured samples per (workload, window count)"
          + ("" if per_cell >= summarize.P99_MIN_SAMPLES else f" -- below {summarize.P99_MIN_SAMPLES}: p99 will be withheld"))
    return 0


def cmd_run(args) -> int:
    try:
        guard = common.guard_live_session()
    except common.GuardError as exc:
        print("REFUSING TO RUN (not a live, non-nested KWin Wayland session of this user):", file=sys.stderr)
        for r in exc.reasons:
            print(f"  - {r}", file=sys.stderr)
        return 3
    import session_check  # noqa: E402  (local module; read-only)
    wl_defs = load_workloads(args.workload_file)
    names = select_workloads(wl_defs, args.workloads)
    windows = [int(x) for x in args.windows.split(",")]
    seed = args.seed if args.seed is not None else int(time.time())
    plan = make_plan(names, windows, args.rounds, seed, wl_defs)
    bus = common.Bus()
    report = session_check.collect(guard=guard, bus=bus)
    outputs = {o["name"]: o for o in (report.get("outputs") or [])}
    out = outputs.get(args.output)
    if out is None or not out.get("enabled"):
        print(f"output {args.output!r} is not an enabled, connected output (have: {', '.join(outputs) or 'none'})",
              file=sys.stderr)
        return 1
    if not common.FIXTURE.exists() or not common.KEYTAP.exists():
        print("build first: make -C fixtures/client && make -C tools/physical", file=sys.stderr)
        return 1
    if not os.access("/dev/uinput", os.W_OK):
        print("/dev/uinput is not writable by this user; see PHYSICAL_RUNBOOK.md (uinput access)", file=sys.stderr)
        return 1
    plastile_needed = any(wl_defs[n]["condition"] == "plastile" for n in names)
    if plastile_needed and not report["plastile"].get("installed"):
        print("Plastile is not installed in this session (tools/install.sh install; see the runbook)", file=sys.stderr)
        return 1
    if args.toggle == "dbus" and report["plastile"].get("enabledInKwinrc") != "true":
        print("--toggle dbus needs [Plugins] plastileEnabled=true in kwinrc (enable Plastile once in System Settings)",
              file=sys.stderr)
        return 1
    actions = sorted({a for n in names for a in wl_defs[n].get("setup", []) + wl_defs[n]["cycle"]})
    shortcuts = common.shortcut_bindings(common.config_home() / "kglobalshortcutsrc", "kwin").get("kwin", {})
    try:
        bindings = resolve_bindings(actions, shortcuts, parse_bindings(args.binding))
    except Abort as exc:
        print(str(exc), file=sys.stderr)
        return 1
    outdir = args.out or common.ARTIFACTS / common.stamp()
    if any((outdir / "blocks").glob("*/block.json")):
        # correlate_dir would pool the old blocks with this run's under one context.json.
        print(f"{outdir} already holds blocks of another run; pass a new --out", file=sys.stderr)
        return 1
    outdir.mkdir(parents=True, exist_ok=True)
    rev, dirty = common.git_revision()
    installed = report["plastile"].get("installedBundleSha256")
    ctx = {"stamp": outdir.name, "layer": "physical", "inputSource": Driver.input_source,
           "environmentId": report.get("environmentId"), "outputName": args.output,
           "refreshHzDeclared": out.get("refreshRate"), "implementationCommit": rev, "implementationDirty": dirty,
           "installedBundleSha256": installed, "repoBundleSha256": report["plastile"].get("repoBundleSha256")}
    per_cell = args.rounds * args.samples
    print(f"Plan: {len(plan)} blocks on {args.output} ({out.get('refreshRate')} Hz), seed {seed}; "
          f"{per_cell} measured samples per cell.")
    if per_cell < summarize.P99_MIN_SAMPLES:
        print(f"NOTE: fewer than {summarize.P99_MIN_SAMPLES} samples per cell: p99 will be withheld.")
    for note in missing_baselines(wl_defs, names):
        print(f"NOTE: {note}")
    motion = common.motion_state(bus)
    if motion["on"]:
        print(f"NOTE: Plastile Motion is on ({motion['label']}). Every block records its motion state and is labelled "
              "with it; inputToSettledNs (t9_settled) is null because the animation's end is not observable, and "
              "inputToFinalCommitPresentNs is reported instead (PERFORMANCE section 6.1).")
    if installed and ctx["repoBundleSha256"] and installed != ctx["repoBundleSha256"]:
        print("NOTE: the installed Plastile bundle differs from this checkout's build; implementationCommit "
              "will not describe what runs (installedBundleSha256 is recorded).")
    print("\nThis will:\n"
          f"  - create a virtual keyboard (/dev/uinput) and press {len(bindings)} global-shortcut chords\n"
          f"    ({', '.join(f'{a}={b['sequence']}' for a, b in bindings.items())}) in THIS session,\n"
          f"  - open up to {max(windows)} fixture windows at a time on the active output,\n"
          + ("  - unload/load Plastile through org.kde.kwin.Scripting (no kwinrc writes; restored at the end),\n"
             if args.toggle == "dbus" else "  - ask you to enable/disable Plastile between blocks,\n")
          + "  - never write kwinrc or kglobalshortcutsrc, never restart the compositor.\n"
          f"Keep the pointer on {args.output}, do not touch the keyboard, and leave the fixture windows focused.")
    if not common.confirm("Start?", args.yes):
        return 1
    (outdir / "session.json").write_text(json.dumps(report, indent=1) + "\n")
    (outdir / "plan.json").write_text(json.dumps({"seed": seed, "rounds": args.rounds, "samples": args.samples,
                                                  "warmup": args.warmup, "windows": windows, "workloads": names,
                                                  "bindings": bindings, "blocks": plan, "toggle": args.toggle,
                                                  "workloadDefinitions": {n: wl_defs[n] for n in names}}, indent=1))
    params = Params(samples=args.samples, warmup=args.warmup, gap_min_ms=args.gap_min_ms, gap_max_ms=args.gap_max_ms,
                    sample_timeout_ms=args.sample_timeout_ms,
                    max_misses=args.max_consecutive_misses, counters=not args.no_counters,
                    refresh_hz=out.get("refreshRate"))
    driver = LiveDriver(bus, args.toggle, args.output, args.yes)
    monitor = Monitor()
    keytap = None
    rc = 0
    old_int = signal.getsignal(signal.SIGINT)
    try:
        keytap = KeyTap([str(common.KEYTAP), "--backend", "uinput", "--name", "plastile-keytap"], monitor,
                        outdir / "keytap.jsonl")
        ready = keytap.wait_ready()
        ctx["clockResolutionNs"] = ready.get("clock_res_ns")
        execute(driver, keytap, monitor, plan, wl_defs, bindings, params, seed, outdir)
    except Abort as exc:
        print(f"STOPPED: {exc}", file=sys.stderr)
        rc = 2
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        rc = 130
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)  # finish cleanup even on a second Ctrl-C
        if keytap is not None:
            keytap.close()
        driver.restore()
        signal.signal(signal.SIGINT, old_int)
    (outdir / "context.json").write_text(json.dumps(ctx, indent=1) + "\n")
    finish(outdir, ctx, wl_defs, bootstrap=args.bootstrap, seed=seed)
    print(f"\nresults: {outdir}")
    return rc


# Never injected by `keys`: toggle-suspend suspends tiling (and its pre-D10-fix default
# Meta+Shift+S starts Spectacle's region capture); inspect/reload commands do not count as
# engine commands. Test these by hand (PHYSICAL_RUNBOOK.md P7).
KEYS_EXCLUDED = ("plastile.runtime.toggle-suspend", "plastile.runtime.reload-config", "plastile.inspect.")


def keys_plan(shortcuts: dict[str, list[str]]) -> tuple[list[tuple], list[dict]]:
    """(chords to press, skipped with reasons) from the kwin component's bindings."""
    todo, skipped = [], []
    for action, seqs in sorted(shortcuts.items()):
        if not action.startswith("plastile.") or not seqs:
            continue
        if action.startswith(KEYS_EXCLUDED):
            skipped.append({"action": action, "sequence": seqs[0], "reason": "excluded: test by hand"})
            continue
        try:
            mods, key = common.parse_sequence(seqs[0])
        except common.KeySpecError as exc:
            skipped.append({"action": action, "sequence": seqs[0], "reason": str(exc)})
            continue
        if not common.has_meta(mods):
            skipped.append({"action": action, "sequence": seqs[0], "reason": "no Meta modifier"})
            continue
        todo.append((action, seqs[0], mods, key))
    return todo, skipped


def commands_ran(c: dict) -> int:
    # Engine.execute counts every command it receives, no-ops included (src/core/engine.ts).
    return c["counters"].get("commands", 0) + c["counters"].get("commandsQueued", 0)


def run_keys(driver: Driver, keytap: KeyTap, monitor: Monitor, outdir: Path, todo: list[tuple],
             reset=None) -> list[dict]:
    """Press each chord once with 3 fixture windows focused; Plastile's command counter says if it arrived."""
    fixtures, results = [], []
    try:
        for i in (1, 2, 3):
            fixtures.append(Fixture(i, driver.spawn_fixture(i, f"fixture-{i}"), outdir / f"fixture-{i}.jsonl", monitor))
        if not monitor.wait_until(lambda: all(f.mapped and f.presented for f in fixtures), 15):
            raise Abort("fixture windows did not map")
        monitor.wait_until(lambda: False, 1.0)
        for n, (action, seq, mods, key) in enumerate(todo):
            if not any(f.activated for f in fixtures):
                raise Abort("keyboard focus left the fixture windows")
            c0 = driver.counters()
            rec = keytap.tap(f"k{n:03d}", mods, key)
            monitor.wait_until(lambda: False, 0.4)
            c1 = driver.counters()
            delivered = None
            if c0 and c1 and "counters" in c0 and "counters" in c1:
                delivered = commands_ran(c1) - commands_ran(c0) >= 1
            results.append({"action": action, "sequence": seq, "mods": mods, "key": key,
                            "tInputNs": rec["t_input_ns"], "delivered": delivered,
                            "countersUnavailable": None if delivered is not None else
                            (c1 or {}).get("unavailableReason") or (c0 or {}).get("unavailableReason")})
            state = "delivered" if delivered else "NOT delivered" if delivered is False else "unknown"
            print(f"  {action:<40} {seq:<22} {state}", flush=True)
        if reset is not None:
            reset()
    finally:
        for f in fixtures:
            f.quit()
        monitor.wait_until(lambda: all(f.proc.poll() is not None for f in fixtures), 5)
        for f in fixtures:
            if f.proc.poll() is None:
                f.proc.terminate()
            monitor.remove(f.proc.stdout)
            f.sink.close()
    return results


def keys_summary(results: list[dict], skipped: list[dict]) -> dict:
    return {"results": results, "skipped": skipped,
            "notDelivered": [r["action"] for r in results if r["delivered"] is False],
            "unknown": [r["action"] for r in results if r["delivered"] is None]}


def cmd_keys(args) -> int:
    """D10 on the real keymap: press every bound Plastile chord once and see whether Plastile ran it."""
    try:
        common.guard_live_session()
    except common.GuardError as exc:
        print("REFUSING TO RUN: " + "; ".join(exc.reasons), file=sys.stderr)
        return 3
    bus = common.Bus()
    if bus.script_loaded() is not True:
        print("Plastile must be loaded for this check", file=sys.stderr)
        return 1
    if not common.FIXTURE.exists() or not common.KEYTAP.exists() or not os.access("/dev/uinput", os.W_OK):
        print("needs the fixture and keytap builds and a writable /dev/uinput (see the runbook)", file=sys.stderr)
        return 1
    shortcuts = common.shortcut_bindings(common.config_home() / "kglobalshortcutsrc", "kwin").get("kwin", {})
    todo, skipped = keys_plan(shortcuts)
    print(f"{len(todo)} bound Plastile chords will be pressed once each with 3 fixture windows focused; "
          f"{len(skipped)} skipped. Plastile's counters (journal) tell whether each one arrived.")
    if not common.confirm("Start?", args.yes):
        return 1
    outdir = args.out or common.ARTIFACTS / f"keys-{common.stamp()}"
    outdir.mkdir(parents=True, exist_ok=True)
    monitor = Monitor()
    driver = LiveDriver(bus, "manual", "", True)
    keytap = None
    results: list[dict] = []

    def reset() -> None:
        try:
            bus.call("org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component", "invokeShortcut",
                     "s", "plastile.context.reset")
        except RuntimeError:
            pass
    try:
        keytap = KeyTap([str(common.KEYTAP), "--backend", "uinput"], monitor, outdir / "keytap.jsonl")
        keytap.wait_ready()
        results = run_keys(driver, keytap, monitor, outdir, todo, reset)
    except Abort as exc:
        print(f"STOPPED: {exc}", file=sys.stderr)
    finally:
        if keytap is not None:
            keytap.close()
    summary = keys_summary(results, skipped)
    (outdir / "keys.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(f"not delivered: {', '.join(summary['notDelivered']) or 'none'}; unknown: "
          f"{', '.join(summary['unknown']) or 'none'}; skipped: {', '.join(x['action'] for x in skipped) or 'none'}")
    print(f"results: {outdir}")
    return 0


def cmd_correlate(args) -> int:
    outdir = args.dir
    ctx = json.loads((outdir / "context.json").read_text())
    plan = json.loads((outdir / "plan.json").read_text())
    wl_defs = plan.get("workloadDefinitions") or load_workloads(args.workload_file)
    finish(outdir, ctx, wl_defs, bootstrap=args.bootstrap, seed=plan.get("seed", 1))
    return 0


def add_common(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--workload-file", type=Path, default=WORKLOAD_FILE)
    ap.add_argument("--workloads", default=None, help="comma list (default: every non-optional workload)")
    ap.add_argument("--windows", default="4", help="comma list of fixture window counts, e.g. 2,4,8")
    ap.add_argument("--rounds", type=int, default=5, help="blocks per (workload, window count); >= 5 for the protocol")
    ap.add_argument("--samples", type=int, default=1000, help="measured taps per block")
    ap.add_argument("--warmup", type=int, default=50, help="warmup taps per block (recorded separately)")
    ap.add_argument("--seed", type=int, default=None)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan", help="print the randomized block plan (touches nothing)")
    add_common(p)
    r = sub.add_parser("run", help="run the plan in the live session")
    add_common(r)
    r.add_argument("--output", required=True, help="connector of the output under test, e.g. HDMI-A-1")
    r.add_argument("--toggle", choices=("manual", "dbus"), default="manual")
    r.add_argument("--binding", action="append", default=[], help="ACTION=CHORD override, e.g. "
                   "plastile.resize.grow=Meta+Ctrl+= or ...=KEY_LEFTMETA+KEY_LEFTCTRL+KEY_EQUAL")
    r.add_argument("--gap-min-ms", type=float, default=30.0)
    r.add_argument("--gap-max-ms", type=float, default=90.0)
    r.add_argument("--sample-timeout-ms", type=float, default=2000.0,
                   help="longest response a tap waits for before the next tap; also the attribution window")
    r.add_argument("--max-consecutive-misses", type=int, default=10)
    r.add_argument("--no-counters", action="store_true", help="do not ask Plastile to log counters per block")
    r.add_argument("--bootstrap", type=int, default=2000)
    r.add_argument("--out", type=Path, default=None)
    r.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    c = sub.add_parser("correlate", help="recompute samples/summary from a results directory's raw logs")
    c.add_argument("dir", type=Path)
    c.add_argument("--workload-file", type=Path, default=WORKLOAD_FILE)
    c.add_argument("--bootstrap", type=int, default=2000)
    k = sub.add_parser("keys", help="press every bound Plastile chord once (D10 on the real keymap)")
    k.add_argument("--out", type=Path, default=None)
    k.add_argument("--yes", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "plan":
        if args.seed is None:
            args.seed = 1
        return cmd_plan(args)
    if args.cmd == "run":
        return cmd_run(args)
    if args.cmd == "keys":
        return cmd_keys(args)
    return cmd_correlate(args)


if __name__ == "__main__":
    sys.exit(main())
