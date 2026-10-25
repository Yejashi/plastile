"""Plastile Motion, the optional transform-only KWin effect (effect/, T31, ADR-023), in nested KWin.

The effect package is installed into each session's private data home with kpackagetool6 before
KWin starts (as tools/install.sh does) and loaded or unloaded through the nested bus's /Effects
interface, or enabled through the nested kwinrc and a reconfigure. Nothing touches the user's session.

Oracles, independent of the effect's own claims:
- KWin's real window state (one-shot scripts) for frames;
- the fixture clients' protocol logs for every configure they received (the client-side view of
  "no intermediate resizes") and their commit times;
- a passive listener script for the time of each frameGeometryChanged;
- KWin's ScreenShot2 on the nested bus for what the compositor draws: each window's marker colour
  must fill its client rectangle and its black/white strip must sit at the client's top-left corner.
  A screenshot is also compared with a later reference of the same, settled scene.
The effect's debug lines (start/retarget/end/skip/cancel, [Effect-plastile_motion] Debug=true) say what
it decided; they are cross-checked against the oracles, never used alone for a visual claim.

Layer: nested KWin, virtual backend, rendered with the host GPU when the session composites with
OpenGL. A screenshot is the composited image KWin produced, not what a physical display presented.
KWin only loads scripted effects when it composites with OpenGL on a hardware renderer
(ScriptedEffect::supported -> EffectsHandler::animationsSupported); elsewhere these scenarios SKIP.
"""
from __future__ import annotations

import json
import os
import re
import statistics
import subprocess
import time
from pathlib import Path

from harness import (KEY_LEFTMETA, ROOT, Input, Listener, NestedError, Session, centre, delta, evidence_file,
                     fixture_events, near, tiling_errors)
from scenarios import Checks, Skipped, scenario

EFFECT_DIR = ROOT / "effect"
EFFECT = "plastile_motion"
ERRORS = r"plastile (error|warn)|TypeError|ReferenceError|plastile_motion/contents/code/main\.js"
LINE = re.compile(r"^(\d+\.\d+) \S+ plastile_motion (\w+)(?: (\".*?\"))?(.*)$")
DEFAULT_MS = 180
EVIDENCE = evidence_file("motion-T31.json")


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def boot_s() -> float:
    """The clock of KWin's log timestamps (QT_MESSAGE_PATTERN %{time boot}): Qt reads CLOCK_MONOTONIC on
    Linux (it does not count suspended time; it matches the fixtures' t_ns, measured on the reference host)."""
    return time.monotonic()


class MotionSession(Session):
    """A Session whose private data home has the effect installed before KWin starts.

    `effect_config` becomes [Effect-plastile_motion] (Debug=true unless given); `kdeglobals` is written to
    the private config home (e.g. the global animation speed); `enabled` sets [Plugins] plastile_motionEnabled.
    """

    def __init__(self, out: Path, *, effect_config: dict | None = None, kdeglobals: str = "",
                 enabled: bool | None = None, install: bool = True, **kw):
        cfg = {"Debug": "true", **(effect_config or {})}
        more = kw.pop("kwinrc_extra", "")
        extra = f"[Effect-{EFFECT}]\n" + "".join(f"{k}={v}\n" for k, v in cfg.items())
        if enabled is not None:
            extra += f"\n[Plugins]\n{EFFECT}Enabled={'true' if enabled else 'false'}\n"
        super().__init__(out, kwinrc_extra=extra + more, **kw)
        self.kdeglobals = kdeglobals
        self.install_effect = install
        self.install_result: dict | None = None
        self.kw.prepare = self._prepare

    def _prepare(self, kw) -> None:
        if self.kdeglobals:
            (kw.root / "config/kdeglobals").write_text(self.kdeglobals)
        if self.install_effect:
            r = subprocess.run(["kpackagetool6", "--type", "KWin/Effect", "--install", str(EFFECT_DIR)], env=kw.env(),
                               capture_output=True, text=True, timeout=60)
            self.install_result = {"rc": r.returncode, "stderr": r.stderr.strip()[-300:]}

    # ------------------------------------------------------------- effect control (nested bus only)
    def effects_call(self, method: str, *args):
        return self.kw.call("/Effects", "org.kde.kwin.Effects", method, "s" if args else "", *args)

    def supported(self) -> bool:
        return bool(self.effects_call("isEffectSupported", EFFECT)[0])

    def effect_loaded(self) -> bool:
        return bool(self.effects_call("isEffectLoaded", EFFECT)[0])

    def load_effect(self) -> bool:
        off = self.kw.mark()
        ok = bool(self.effects_call("loadEffect", EFFECT)[0])
        if ok:
            self.kw.wait_log(r"plastile_motion loaded ", 5, off)
        return ok

    def unload_effect(self) -> None:
        self.effects_call("unloadEffect", EFFECT)

    def require_effect(self) -> None:
        """Fail if the package did not install (that does not depend on the renderer); SKIP if KWin cannot run
        scripted effects in this session."""
        if self.install_effect and (not self.install_result or self.install_result["rc"] != 0):
            raise NestedError(f"kpackagetool6 --type KWin/Effect --install failed: {self.install_result}")
        comp = self.kw.compositing_type()
        try:
            supported = self.supported()
        except NestedError as exc:
            if comp == "OpenGL":
                raise
            raise Skipped(f"no effects interface in this session (compositing: {comp}): {exc}") from None
        if not supported:
            raise Skipped(f"KWin does not support scripted effects here (compositing: {comp}; "
                          "ScriptedEffect::supported needs OpenGL on a hardware renderer, "
                          "EffectsHandler::animationsSupported)")

    def motion(self, offset: int, kind: str | None = None, caption: str | None = None) -> list[dict]:
        """The effect's debug lines since `offset`, parsed: {t, kind, caption, rest}."""
        out = []
        for ln in self.kw.lines_since(offset, r" plastile_motion "):
            m = LINE.match(ln)
            if not m:
                continue
            rec = {"t": float(m.group(1)), "kind": m.group(2), "caption": json.loads(m.group(3)) if m.group(3) else None,
                   "rest": m.group(4).strip()}
            if (kind is None or rec["kind"] == kind) and (caption is None or rec["caption"] == caption):
                out.append(rec)
        return out

    # ------------------------------------------------------------------------ screenshots
    def screenshot(self) -> dict:
        """The composited workspace through KWin's ScreenShot2 on the nested bus (raw pixels)."""
        import dbus
        obj = self.kw._bus_connection().get_object("org.kde.KWin", "/org/kde/KWin/ScreenShot2")
        r, w = os.pipe()
        try:
            res = obj.CaptureWorkspace({"native-resolution": True}, dbus.types.UnixFd(w),
                                       dbus_interface="org.kde.KWin.ScreenShot2", timeout=10)
        finally:
            os.close(w)
        chunks = []
        while True:
            b = os.read(r, 1 << 20)
            if not b:
                break
            chunks.append(b)
        os.close(r)
        meta = {str(k): (str(v) if isinstance(v, dbus.String) else float(v) if isinstance(v, dbus.Double) else int(v))
                for k, v in res.items()}
        return {**meta, "data": b"".join(chunks)}


def pixel(shot: dict, x: float, y: float) -> tuple[int, int, int] | None:
    x, y = int(x), int(y)
    if not (0 <= x < shot["width"] and 0 <= y < shot["height"]):
        return None
    i = y * shot["stride"] + x * 4
    d = shot["data"]
    # QImage::Format_RGBX8888 (16) / RGBA8888 (17, 18) store R, G, B in byte order; ARGB32 (4-6) is B, G, R in memory.
    return (d[i], d[i + 1], d[i + 2]) if shot["format"] >= 16 else (d[i + 2], d[i + 1], d[i])


def close(a, b, tol: int = 4) -> bool:
    """Equal colours up to `tol` per channel: neighbours' soft shadows tint a tile by a unit or two."""
    return a is not None and b is not None and all(abs(p - q) <= tol for p, q in zip(a, b))


def visual_errors(shot: dict, frames: list[dict]) -> list[str]:
    """Whether every fixture is drawn at its real client rectangle (KWin's oracle).

    The client fills its buffer with one marker colour and draws a 256x32 black/white strip at its
    top-left (fixtures/client). Checked: five interior points (inset 48 px, clear of neighbours' shadows
    and of the strip) have the colour at the client's centre (within 4 per channel); three points inside
    the strip are black or white; the points 4 px beyond its right and bottom edges have the marker colour
    (within 16: a shadow from the window above). A window drawn translated or scaled away from its real
    rectangle fails at least one of these.
    """
    errs = []
    if shot.get("format") not in (4, 5, 6, 16, 17, 18):
        return [f"unsupported image format {shot.get('format')}"]
    for f in frames:
        c = f["client"]
        x0, y0, x1, y1 = c["x"], c["y"], c["x"] + c["width"], c["y"] + c["height"]
        ref = pixel(shot, (x0 + x1) / 2, (y0 + y1) / 2)
        inset = 48
        pts = [(x0 + inset, y0 + inset), (x1 - inset, y0 + inset), (x0 + inset, y1 - inset), (x1 - inset, y1 - inset),
               ((x0 + x1) / 2, y1 - inset)]
        bad = [(round(x), round(y), pixel(shot, x, y)) for x, y in pts if not close(pixel(shot, x, y), ref)]
        # The strip's corners and the marker colour just beyond its right and bottom edges pin the strip (so the
        # client's origin) to within 4 px; the soft shadow of a window above tints these points a little.
        strip = [pixel(shot, x0 + dx, y0 + dy) for dx, dy in ((4, 4), (252, 4), (128, 28))]
        beyond = [pixel(shot, x0 + dx, y0 + dy) for dx, dy in ((260, 16), (128, 36))] if c["width"] > 280 else []
        bad_strip = [p for p in strip if not (close(p, (0, 0, 0), 24) or close(p, (255, 255, 255), 24))]
        bad_beyond = [p for p in beyond if not close(p, ref, 16)]
        if bad or bad_strip or bad_beyond:
            errs.append(f"{f['caption']} not drawn at its client rect {[x0, y0, c['width'], c['height']]}: centre {ref}, "
                        f"off-colour points {bad[:3]}, strip {strip}, beyond the strip {beyond}")
    return errs


def image_diff(a: dict, b: dict) -> float:
    """Fraction of pixels (sampled every 4th pixel on every 4th row) that differ between two screenshots."""
    if (a["width"], a["height"], a["stride"]) != (b["width"], b["height"], b["stride"]):
        return 1.0
    total = diff = 0
    da, db, stride = a["data"], b["data"], a["stride"]
    for y in range(0, a["height"], 4):
        row = y * stride
        for x in range(0, a["width"], 4):
            i = row + x * 4
            total += 1
            if da[i:i + 3] != db[i:i + 3]:
                diff += 1
    return diff / total if total else 1.0


def frames_by_caption(s: Session) -> dict[str, dict]:
    return {f["caption"]: f["frame"] for f in s.frames_list()}


def wait_motion(s: MotionSession, off: int, kind: str, count: int, timeout: float = 3.0) -> list[dict]:
    deadline = time.monotonic() + timeout
    while True:
        got = s.motion(off, kind)
        if len(got) >= count or time.monotonic() > deadline:
            return got
        time.sleep(0.03)


def rect_of(rest: str, key: str) -> list[float] | None:
    m = re.search(rf"{key}=\[([-\d.,]+)\]", rest)
    return [float(v) for v in m.group(1).split(",")] if m else None


def as_list(r: dict) -> list[float]:
    return [r["x"], r["y"], r["width"], r["height"]]


def three_loaded(s: MotionSession) -> None:
    s.spawn(1); s.spawn(2); s.spawn(3)
    s.load(); s.settle()


def record(name: str, data: dict) -> None:
    """Merge one scenario's summary into the evidence file (artifacts/evidence unless publishing)."""
    try:
        doc = json.loads(EVIDENCE.read_text())
    except (OSError, ValueError):
        doc = {}
    doc.setdefault("layer", "nested KWin virtual backend, OpenGL compositing (not physical)")
    doc.setdefault("scenarios", {})[name] = data
    out = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
    doc["kwin"] = out
    EVIDENCE.write_text(json.dumps(doc, indent=1, sort_keys=True))


# ------------------------------------------------------------------------------------------------ (1)
@scenario("motion-swap-T31")
def motion_swap(out: Path, c: Checks):
    """(1) The effect loads and animates a Plastile swap and a ratio step: the two swapped windows start,
    end at their real frame after about the duration, and the composited image then shows every window at
    its real rectangle (ScreenShot2 oracle). The unmoved window is not animated."""
    with MotionSession(out) as s:
        s.require_effect()
        c("setup: effect installed into the session's data home", s.install_result and s.install_result["rc"] == 0,
          s.install_result)
        c("(1) effect not loaded by default (EnabledByDefault false)", not s.effect_loaded())
        three_loaded(s)
        c("(1) /Effects loadEffect loads it on the nested bus", s.load_effect() and s.effect_loaded())
        before = frames_by_caption(s)
        off = s.kw.mark()
        t_cmd = boot_s()
        s.cmd("swap.next")
        ends = wait_motion(s, off, "end", 2)
        s.settle()
        after = frames_by_caption(s)
        moved = sorted(k for k in after if not near(after[k], before[k]))
        starts = s.motion(off, "start")
        c("(1) the swap moved two windows (oracle)", len(moved) == 2, {"moved": moved})
        c("(1) one start per moved window, none for the unmoved one", sorted(x["caption"] for x in starts) == moved,
          [(x["caption"], x["rest"]) for x in starts])
        c("(1) each start runs from the old frame to the new frame (oracle frames)",
          all(rect_of(x["rest"], "from") == as_list(before[x["caption"]]) and rect_of(x["rest"], "to") ==
              as_list(after[x["caption"]]) for x in starts), [x["rest"] for x in starts])
        c("(1) the default duration is 180 ms at animation speed 1", all(f"ms={DEFAULT_MS} " in x["rest"] + " " for x in starts))
        spans = [round((e["t"] - t_cmd) * 1000) for e in ends]
        c("(1) both animations end, at the real frame, about one duration after the command (180 ms + frames)",
          len(ends) == 2 and all(rect_of(e["rest"], "target") == rect_of(e["rest"], "frame") for e in ends)
          and all(DEFAULT_MS - 20 <= ms <= DEFAULT_MS + 250 for ms in spans), {"endMsAfterCommand": spans,
                                                                                  "ends": [e["rest"] for e in ends]})
        shot = s.screenshot()
        frames = s.frames_list()
        time.sleep(0.5)
        ref = s.screenshot()
        errs = visual_errors(shot, frames)
        c("(1) after the end every window is drawn at its real rectangle (ScreenShot2)", not errs, errs)
        c("(1) and the image equals a reference taken 0.5 s later (nothing still moving)", image_diff(shot, ref) == 0.0,
          image_diff(shot, ref))
        off = s.kw.mark()
        before = frames_by_caption(s)
        s.cmd("resize.grow")
        wait_motion(s, off, "end", 3)
        s.settle()
        after = frames_by_caption(s)
        moved = sorted(k for k in after if not near(after[k], before[k]))
        c("(1) a ratio step animates every window whose frame changed", sorted(x["caption"] for x in s.motion(off, "start"))
          == moved and len(moved) >= 2, {"moved": moved, "starts": [x["caption"] for x in s.motion(off, "start")]})
        c("no errors in KWin's log", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])
        record("motion-swap-T31", {"endMsAfterCommand": spans, "visualErrors": errs})


# ------------------------------------------------------------------------------------------------ (2) + (3)
SEQUENCE = ["swap.next", "resize.grow", "resize.grow", "swap.next", "resize.shrink", "layout.bsp", "layout.master-stack"]


def run_sequence(out: Path, effect: bool) -> dict:
    """The same commands on the same three fixtures, the effect loaded or not. Per step: every configure each
    client received, Plastile's work counters, the final frames, the latency from the command to each client's
    configure (fixture clock) and to KWin's frameGeometryChanged (listener, KWin log clock)."""
    with MotionSession(out) as s:
        if effect:
            s.require_effect()
        three_loaded(s)
        if effect:
            s.load_effect()
        lis = Listener(s, frames=(fx(1), fx(2), fx(3)))
        steps = []
        try:
            for name in SEQUENCE:
                time.sleep(0.4)          # previous animation over: each step starts from a still scene
                cfg0 = {i: len(fixture_events(s.fixtures[i].log, "configure")) for i in (1, 2, 3)}
                a = s.counters()
                off = s.kw.mark()
                t_boot = boot_s()
                t_mono = s.cmd(name)
                b = s.settle()
                time.sleep(0.4)
                cfgs, cfg_ms = {}, []
                for i in (1, 2, 3):
                    ev = fixture_events(s.fixtures[i].log, "configure")[cfg0[i]:]
                    cfgs[fx(i)] = [[e["width"], e["height"]] for e in ev]
                    cfg_ms += [(e["t_ns"] - t_mono) / 1e6 for e in ev]
                frame_ms = []
                for ln in lis.lines("frame", off):
                    m = re.match(r"^(\d+\.\d+) ", ln)
                    if m:
                        frame_ms.append((float(m.group(1)) - t_boot) * 1000)
                d = delta(a, b)
                steps.append({"command": name, "configures": cfgs,
                              "work": {k: d.get(k, 0) for k in ("commands", "solves", "writes", "corrections")},
                              "frames": {k: as_list(v) for k, v in frames_by_caption(s).items()},
                              "configureMs": sorted(round(x, 2) for x in cfg_ms),
                              "frameChangedMs": sorted(round(x, 1) for x in frame_ms),
                              "starts": len(s.motion(off, "start")), "retargets": len(s.motion(off, "retarget"))})
        finally:
            lis.close()
        return {"steps": steps, "errors": s.log_lines(ERRORS)[:5], "loaded": s.effect_loaded()}


@scenario("motion-client-cost-T31")
def motion_client_cost(out: Path, c: Checks):
    """(2) Clients receive exactly the same configures with the effect on as off (no intermediate resizes),
    Plastile does the same work, and the final frames are equal. (3) Commands do not wait for the effect:
    with it on, every configure reaches its client and every frameGeometryChanged happens well before an
    animation could have ended, at the same latency as with the effect off (nested timing, not physical)."""
    on = run_sequence(out / "on", effect=True)
    off = run_sequence(out / "off", effect=False)
    c("setup: the effect was loaded in the 'on' session and animated the moves",
      on["loaded"] and sum(st["starts"] for st in on["steps"]) >= len(SEQUENCE), [st["starts"] for st in on["steps"]])
    c("setup: no animation in the 'off' session", sum(st["starts"] for st in off["steps"]) == 0)
    same_cfg = [st_on["command"] for st_on, st_off in zip(on["steps"], off["steps"]) if st_on["configures"] != st_off["configures"]]
    c("(2) every client received exactly the same configures, step by step, with the effect on and off", not same_cfg,
      {"differs": same_cfg, "on": [st["configures"] for st in on["steps"]], "off": [st["configures"] for st in off["steps"]]})
    c("(2) every resize step reached the clients as one configure per changed window (no intermediate sizes)",
      all(len(v) <= 1 for st in on["steps"] for v in st["configures"].values()),
      [st["configures"] for st in on["steps"]])
    c("(2) Plastile's work (commands, solves, writes, corrections) is identical",
      [st["work"] for st in on["steps"]] == [st["work"] for st in off["steps"]],
      {"on": [st["work"] for st in on["steps"]], "off": [st["work"] for st in off["steps"]]})
    c("(2) the final frames are identical after every step",
      [st["frames"] for st in on["steps"]] == [st["frames"] for st in off["steps"]])
    on_cfg = [x for st in on["steps"] for x in st["configureMs"]]
    off_cfg = [x for st in off["steps"] for x in st["configureMs"]]
    on_fr = [x for st in on["steps"] for x in st["frameChangedMs"]]
    off_fr = [x for st in off["steps"] for x in st["frameChangedMs"]]
    stats = {"configureMs": {"on": {"p50": statistics.median(on_cfg), "max": max(on_cfg), "n": len(on_cfg)},
                             "off": {"p50": statistics.median(off_cfg), "max": max(off_cfg), "n": len(off_cfg)}},
             "frameChangedMs": {"on": {"p50": statistics.median(on_fr), "max": max(on_fr), "n": len(on_fr)},
                                "off": {"p50": statistics.median(off_fr), "max": max(off_fr), "n": len(off_fr)}}}
    c("(3) with the effect on, every configure reached its client within a third of the duration of the command "
      "(an animation that delayed commands would push them past 180 ms)", max(on_cfg) < DEFAULT_MS / 3, stats["configureMs"])
    c("(3) and every frameGeometryChanged happened within half the duration", max(on_fr) < DEFAULT_MS / 2, stats["frameChangedMs"])
    c("(3) median latencies with the effect on are within 5 ms of the effect-off run (same order of the same work)",
      stats["configureMs"]["on"]["p50"] <= stats["configureMs"]["off"]["p50"] + 5
      and stats["frameChangedMs"]["on"]["p50"] <= stats["frameChangedMs"]["off"]["p50"] + 5, stats)
    c("no errors in either session", not on["errors"] and not off["errors"], on["errors"] + off["errors"])
    record("motion-client-cost-T31", {"sequence": SEQUENCE, "latency": stats,
                                      "configures": [st["configures"] for st in on["steps"]],
                                      "work": [st["work"] for st in on["steps"]]})


# ------------------------------------------------------------------------------------------------ (4)
@scenario("motion-rapid-retarget-T31")
def motion_rapid(out: Path, c: Checks):
    """(4) Ten ratio steps 25 ms apart retarget the running animations instead of queueing them: one start
    per moved window, retargets for the following steps, exactly one end per window about one duration after
    the LAST command, at the final frame; the image then shows every window at its real rectangle."""
    with MotionSession(out) as s:
        s.require_effect()
        three_loaded(s)
        s.load_effect()
        before = frames_by_caption(s)
        off = s.kw.mark()
        sent = []
        for _ in range(10):
            sent.append(boot_s())
            s.cmd("resize.grow")
            time.sleep(0.025)
        last = sent[-1]
        ends = wait_motion(s, off, "end", 3, timeout=4)
        s.settle()
        time.sleep(0.3)
        final = frames_by_caption(s)
        moved = sorted(k for k in final if not near(final[k], before[k]))
        starts, retargets = s.motion(off, "start"), s.motion(off, "retarget")
        per = {k: {"starts": sum(1 for x in starts if x["caption"] == k),
                   "retargets": sum(1 for x in retargets if x["caption"] == k),
                   "ends": sum(1 for x in s.motion(off, "end") if x["caption"] == k)} for k in moved}
        c("(4) the burst moved all three windows (oracle)", len(moved) == 3, moved)
        c("(4) one start per window; the later steps retarget it (no queue, no restart from the old frame)",
          all(v["starts"] == 1 and v["retargets"] >= 5 and v["ends"] == 1 for v in per.values()), per)
        end_ms = [round((e["t"] - last) * 1000) for e in ends]
        c("(4) each animation ends once, about one duration after the last command (each retarget restarts the "
          "full duration from the current visual)", len(ends) == 3 and all(DEFAULT_MS - 30 <= x <= DEFAULT_MS + 250 for x in end_ms),
          end_ms)
        c("(4) the end is at the final frame (oracle)",
          all(rect_of(e["rest"], "target") == as_list(final[e["caption"]]) == rect_of(e["rest"], "frame") for e in ends),
          [(e["caption"], e["rest"]) for e in ends])
        shot = s.screenshot()
        frames = s.frames_list()
        time.sleep(0.5)
        ref = s.screenshot()
        errs = visual_errors(shot, frames)
        c("(4) the visual settled at the final frames (ScreenShot2) and stays there", not errs and image_diff(shot, ref) == 0.0,
          {"errors": errs, "diff": image_diff(shot, ref)})
        c("no errors in KWin's log", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])
        record("motion-rapid-retarget-T31", {"perWindow": per, "endMsAfterLastCommand": end_ms,
                                             "commandSpanMs": round((sent[-1] - sent[0]) * 1000)})


# ------------------------------------------------------------------------------------------------ (5)
def mid_animation(s: MotionSession, c: Checks, tag: str, stop) -> None:
    """Swap with a 2 s animation, prove it is mid-flight on screen, `stop()` the effect, prove every window is
    drawn at its real rectangle long before the animation would have ended."""
    before = frames_by_caption(s)
    off = s.kw.mark()
    s.cmd("swap.next")
    wait_motion(s, off, "start", 2)
    time.sleep(0.5)
    frames = s.frames_list()
    mid = s.screenshot()
    moved = [f for f in frames if not near(f["frame"], before[f["caption"]])]
    mid_errs = visual_errors(mid, moved)
    c(f"(5) {tag}: positive control: 0.5 s into a 2 s animation the swapped windows are NOT drawn at their real "
      "rectangles", len(moved) == 2 and len(mid_errs) == 2, {"moved": [f["caption"] for f in moved], "errors": mid_errs})
    t0 = time.monotonic()
    stop()
    gone = not s.effect_loaded()
    time.sleep(0.15)
    shot = s.screenshot()
    shot_at = time.monotonic() - t0
    frames = s.frames_list()
    errs = visual_errors(shot, frames)
    time.sleep(0.8)
    ref = s.screenshot()
    c(f"(5) {tag}: the effect is unloaded", gone)
    c(f"(5) {tag}: {round(shot_at, 2)} s after unloading (1.4 s before the animation's end) every window is drawn at its "
      "real rectangle, and the image equals a later reference", not errs and image_diff(shot, ref) == 0.0,
      {"errors": errs, "diff": image_diff(shot, ref)})


def set_enabled(s: MotionSession, on: bool) -> None:
    """What System Settings > Desktop Effects does (KWin's EffectsModel::save): write [Plugins] <id>Enabled with
    KConfig::Notify, which KWin's config watcher turns into a load or an unload. Nested config and bus only."""
    r = subprocess.run(["kwriteconfig6", "--file", "kwinrc", "--group", "Plugins", "--key", f"{EFFECT}Enabled", "--notify",
                        "true" if on else "false"], env=s.kw.env(), capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        raise RuntimeError(f"kwriteconfig6 failed: {r.stderr.strip()}")


@scenario("motion-unload-mid-T31")
def motion_unload(out: Path, c: Checks):
    """(5) Unloading the effect mid-animation (D-Bus unloadEffect, and the System Settings path: kwinrc
    [Plugins] plastile_motionEnabled=false written with a change notification) leaves every window drawn at its real geometry at
    once. Plastile is not involved and keeps working; the effect loads and animates again afterwards."""
    with MotionSession(out, effect_config={"Duration": 2000}) as s:
        s.require_effect()
        three_loaded(s)
        s.load_effect()
        mid_animation(s, c, "unloadEffect", s.unload_effect)
        set_enabled(s, True)
        Session.wait_for(s.effect_loaded, 5, "effect enabled through kwinrc with a change notification")
        c("(5) kwinrc [Plugins] plastile_motionEnabled=true with a change notification (the System Settings path) "
          "loads it again", s.effect_loaded())
        time.sleep(0.3)

        def disable():
            set_enabled(s, False)
            Session.wait_for(lambda: not s.effect_loaded(), 5, "effect disabled through kwinrc with a change notification")
        mid_animation(s, c, "kwinrc Enabled=false with a change notification", disable)
        cnt = s.settle()
        c("Plastile kept tiling throughout (oracle) and recorded no error", not tiling_errors(s.frames_list(), s.area(), 8)
          and cnt["counters"]["errors"] == 0, tiling_errors(s.frames_list(), s.area(), 8))
        c("no errors in KWin's log", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])


# ------------------------------------------------------------------------------------------------ (6)
@scenario("motion-excluded-T31")
def motion_excluded(out: Path, c: Checks):
    """(6) Not animated: a window being dragged or resized with the mouse (and peers moved meanwhile), the
    maximize and fullscreen transitions, and a newly opened window's first placement. Positive controls in the
    same session: the windows that reflow when a window opens, and the drop placement after a move."""
    with MotionSession(out) as s:
        s.require_effect()
        three_loaded(s)
        s.load_effect()
        inp = Input(s)
        try:
            # Interactive move: Meta+drag fixture 3 onto fixture 1's tile, held, then released.
            slot = frames_by_caption(s)
            x0, y0 = centre(slot[fx(3)]); x1, y1 = centre(slot[fx(1)])
            off = s.kw.mark()
            inp.drag(x0, y0, x1, y1, release=False)
            time.sleep(0.3)
            during = s.motion(off)
            c("(6) drag: the dragged window moved (oracle) and nothing was animated while the button was held",
              not near(frames_by_caption(s)[fx(3)], slot[fx(3)], 1.0) and not [x for x in during if x["kind"] == "start"]
              and any(x["kind"] == "skip" and "reason=interactive" in x["rest"] for x in during),
              [(x["kind"], x["caption"], x["rest"][:40]) for x in during][:8])
            off = s.kw.mark()
            inp.do("release left", f"key {KEY_LEFTMETA} up")
            wait_motion(s, off, "end", 1)
            s.settle()
            g = frames_by_caption(s)
            starts = sorted(x["caption"] for x in s.motion(off, "start"))
            c("(6) drop: the swap placement after the release is animated (documented: a move's drop placement is "
              "a programmatic change)", near(g[fx(3)], slot[fx(1)], 1.0) and fx(1) in starts, starts)
            # Interactive resize: Meta+right-drag near the master's bottom-right corner.
            time.sleep(0.4)
            slot = frames_by_caption(s)
            master = min(slot.values(), key=lambda r: r["x"])
            mx, my = master["x"] + master["width"] - 20, master["y"] + master["height"] - 20
            master_cap = next(k for k, v in slot.items() if v == master)
            off = s.kw.mark()
            inp.drag(mx, my, mx + 120, my, button="right", release=False)
            time.sleep(0.3)
            during = s.motion(off, "start")
            inp.do("release right", f"key {KEY_LEFTMETA} up")
            time.sleep(0.6)
            s.settle()
            g = frames_by_caption(s)
            resized = [x for x in s.motion(off, "start") if x["caption"] == master_cap]
            c("(6) resize: the master was resized (oracle), nothing animated during the resize and the resized window "
              "is not animated after the release", g[master_cap]["width"] > master["width"] + 60 and not during and not resized,
              {"during": [x["caption"] for x in during], "resizedStarts": [x["rest"] for x in resized],
               "afterRelease": [(x["caption"], x["rest"]) for x in s.motion(off, "start")]})
        finally:
            inp.close()
        # Maximize and restore through KWin's own action.
        time.sleep(0.4)
        off = s.kw.mark()
        s.act(fx(2), "w.setMaximize(true, true)")
        Session.wait_for(lambda: s.frames()[fx(2)]["maximizeMode"] == 3, 3, "maximized")
        time.sleep(0.4)
        skips = [x["rest"] for x in s.motion(off, "skip", fx(2))]
        c("(6) maximize: the transition is not animated by this effect (left to KWin's maximize effect)",
          not s.motion(off, "start", fx(2)) and any("reason=maximize" in r for r in skips), skips)
        off = s.kw.mark()
        s.act(fx(2), "w.setMaximize(false, false)")
        Session.wait_for(lambda: s.frames()[fx(2)]["maximizeMode"] == 0, 3, "restored")
        time.sleep(0.4)
        s.settle()
        restore = [(x["kind"], x["rest"]) for x in s.motion(off, caption=fx(2))]
        c("(6) restore: the un-maximize transition itself is not animated", restore and restore[0][0] == "skip"
          and "reason=maximize" in restore[0][1], restore)
        # Fullscreen on and off.
        time.sleep(0.4)
        off = s.kw.mark()
        s.act(fx(1), "w.fullScreen = true")
        Session.wait_for(lambda: s.frames()[fx(1)]["fullScreen"], 3, "fullscreen")
        time.sleep(0.4)
        s.act(fx(1), "w.fullScreen = false")
        Session.wait_for(lambda: not s.frames()[fx(1)]["fullScreen"], 3, "not fullscreen")
        time.sleep(0.4)
        s.settle()
        fs = [(x["kind"], x["rest"]) for x in s.motion(off, caption=fx(1))]
        c("(6) fullscreen: entering and leaving are not animated",
          not [k for k, _ in fs if k == "start"] and sum(1 for k, r in fs if k == "skip" and "reason=fullscreen" in r) >= 2, fs)
        # A newly opened window: its first placement is not animated; the reflow of the others is.
        time.sleep(0.4)
        before = frames_by_caption(s)
        off = s.kw.mark()
        s.spawn(4)
        s.settle()
        time.sleep(0.4)
        after = frames_by_caption(s)
        starts = sorted({x["caption"] for x in s.motion(off, "start")})
        reflowed = sorted(k for k in before if not near(after[k], before[k]))
        new_skips = [x["rest"] for x in s.motion(off, "skip", fx(4))]
        c("(6) open: the new window's placement is not animated; the windows that made room are",
          fx(4) not in starts and new_skips and starts == reflowed and len(reflowed) >= 1,
          {"starts": starts, "reflowed": reflowed, "newWindowSkips": new_skips})
        c("no errors in KWin's log", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])


# ------------------------------------------------------------------------------------------------ (7)
@scenario("motion-hit-test-T31")
def motion_hit_test(out: Path, c: Checks):
    """Input follows the real geometry, not the picture: during a 2 s animation a click at the centre of a moved
    window's real (new) rectangle, where the screen still shows something else, activates that window. This is the
    documented brief mismatch between what is drawn and where clicks go."""
    with MotionSession(out, effect_config={"Duration": 2000}) as s:
        s.require_effect()
        three_loaded(s)
        s.load_effect()
        inp = Input(s)
        try:
            before = frames_by_caption(s)
            off = s.kw.mark()
            s.cmd("swap.next")
            wait_motion(s, off, "start", 2)
            time.sleep(0.4)
            frames = {f["caption"]: f for f in s.frames_list()}
            act = json.loads(s.js("emit(workspace.activeWindow ? workspace.activeWindow.caption : null)")[0])
            moved = [k for k in frames if not near(frames[k]["frame"], before[k])]
            target = next((k for k in moved if k != act), None)
            cl = frames[target]["client"] if target else None
            x, y = (cl["x"] + cl["width"] / 2, cl["y"] + cl["height"] * 0.75) if cl else (0, 0)
            mid = s.screenshot()
            inp.do(f"move {x} {y}", "press left", "release left")
            activated = until_true(lambda: json.loads(s.js("emit(workspace.activeWindow ? "
                                                          "workspace.activeWindow.caption : null)")[0]) == target, 2)
            wait_motion(s, off, "end", 2, timeout=4)
            time.sleep(0.3)
            final = s.screenshot()
        finally:
            inp.close()
        c("setup: the swap moved a window that is not the active one", target is not None, {"moved": moved, "active": act})
        c("mid-animation the click point does not show that window yet (picture and input differ)",
          not close(pixel(mid, x, y), pixel(final, x, y)), {"mid": pixel(mid, x, y), "settled": pixel(final, x, y)})
        c("the click at the window's real rectangle activated it (input uses real geometry)", activated, target)
        c("no errors in KWin's log", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])


@scenario("motion-instant-T31")
def motion_instant(out: Path, c: Checks):
    """(7) The global animation speed 'Instant' (kdeglobals [KDE] AnimationDurationFactor=0) disables the
    effect: it loads, but a swap is not animated and the image shows the final frames at once."""
    with MotionSession(out, kdeglobals="[KDE]\nAnimationDurationFactor=0\n") as s:
        s.require_effect()
        three_loaded(s)
        off = s.kw.mark()
        c("(7) the effect loads (positive control)", s.load_effect() and s.effect_loaded())
        c("(7) it reports duration 0 at speed 'Instant'", any("duration=0 " in x["rest"] + " " for x in s.motion(off, "loaded")),
          [x["rest"] for x in s.motion(off, "loaded")])
        before = frames_by_caption(s)
        off = s.kw.mark()
        s.cmd("swap.next")
        s.settle()
        time.sleep(0.1)
        shot = s.screenshot()
        frames = s.frames_list()
        moved = [k for k, v in frames_by_caption(s).items() if not near(v, before[k])]
        skips = s.motion(off, "skip")
        c("(7) the swap moved two windows and neither was animated (skip reason=instant)",
          len(moved) == 2 and not s.motion(off, "start") and sorted(x["caption"] for x in skips if "reason=instant" in x["rest"])
          == sorted(moved), {"moved": moved, "skips": [(x["caption"], x["rest"]) for x in skips]})
        errs = visual_errors(shot, frames)
        c("(7) the image shows every window at its real rectangle right after the command", not errs, errs)
        c("no errors in KWin's log", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])


# ------------------------------------------------------------------------------------------------ outputs
@scenario("motion-outputs-T31")
def motion_outputs(out: Path, c: Checks):
    """Two outputs: sending a window to the other output (visible before and after) animates across the outputs
    and ends at its real frame; removing an output while windows on it animate stops those animations (output
    change), KWin's and Plastile's reflow onto the remaining output is not animated, and every window is then
    drawn at its real rectangle."""
    from scenarios import kscreen
    with MotionSession(out, outputs=2, effect_config={"Duration": 1000}) as s:
        s.require_effect()
        for i in (1, 2, 3, 4):
            s.spawn(i)
        s.load(); s.settle()
        s.load_effect()
        s.act(fx(4), "workspace.activeWindow = w")
        before = frames_by_caption(s)
        off = s.kw.mark()
        s.cmd("move.output-next")
        ends = wait_motion(s, off, "end", 1, timeout=4)
        time.sleep(0.3)
        s.settle()
        after = {f["caption"]: f for f in s.frames_list()}
        mine = [e for e in s.motion(off, "start") if e["caption"] == fx(4)]
        c("setup: fixture 4 moved to the second output (oracle)", after[fx(4)]["output"] != "Virtual-0",
          {k: v["output"] for k, v in after.items()})
        # KWin moves the window to the other output first (same relative place), Plastile then tiles it there:
        # one animation, retargeted to the tile.
        c("cross-output: the move is animated from the old frame and ends at the real tile on the other output",
          len(mine) == 1 and rect_of(mine[0]["rest"], "from") == as_list(before[fx(4)])
          and any(e["caption"] == fx(4) and rect_of(e["rest"], "target") == rect_of(e["rest"], "frame")
                  == as_list(after[fx(4)]["frame"]) for e in ends),
          {"starts": [x["rest"] for x in mine], "ends": [(e["caption"], e["rest"]) for e in ends]})
        # Two windows on Virtual-1, then a swap there with 1 s animations, and the output goes away mid-flight.
        s.act(fx(3), "workspace.activeWindow = w")
        s.cmd("move.output-next")
        time.sleep(1.4)
        s.settle()
        c("setup: two windows on the second output", sum(1 for f in s.frames_list() if f["output"] != "Virtual-0") == 2,
          [(f["caption"], f["output"]) for f in s.frames_list()])
        off = s.kw.mark()
        s.cmd("swap.next")
        wait_motion(s, off, "start", 2)
        time.sleep(0.2)
        kscreen(s, "output.Virtual-1.disable")
        time.sleep(1.2)
        s.settle()
        lines = s.motion(off)
        cancels = [x["caption"] for x in lines if x["kind"] == "cancel"]
        late = [x for x in lines if x["kind"] == "start" and x["t"] > max((y["t"] for y in lines if y["kind"] == "cancel"),
                                                                         default=float("inf"))]
        frames = s.frames_list()
        shot = s.screenshot()
        time.sleep(0.5)
        ref = s.screenshot()
        errs = visual_errors(shot, frames)
        c("unplug: the running animations were stopped by the output change", len(cancels) >= 2
          and all("reason=transition" in x["rest"] for x in lines if x["kind"] == "cancel"),
          [(x["kind"], x["caption"], x["rest"][:60]) for x in lines])
        c("unplug: the reflow onto the remaining output was not animated", not late, [(x["caption"], x["rest"]) for x in late])
        c("unplug: all four windows on the remaining output, tiled, and drawn at their real rectangles",
          all(f["output"] == "Virtual-0" for f in frames) and not tiling_errors(frames, s.area(0), 8) and not errs
          and image_diff(shot, ref) == 0.0, {"errors": errs, "diff": image_diff(shot, ref),
                                             "tiling": tiling_errors(frames, s.area(0), 8)})
        c("no errors in KWin's log", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])


# ------------------------------------------------------------------------------------------------ packaging
def until_true(pred, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return False


def notify_enabled(kw, value: bool) -> int:
    """The command install.sh prints: kwinrc [Plugins] plastile_motionEnabled with a change notification
    (nested config and bus)."""
    r = subprocess.run(["kwriteconfig6", "--file", "kwinrc", "--group", "Plugins", "--key", f"{EFFECT}Enabled", "--notify",
                        "true" if value else "false"], env=kw.env(), capture_output=True, text=True, timeout=10)
    return r.returncode


@scenario("motion-package-T31")
def motion_package(out: Path, c: Checks):
    """tools/install.sh installs the effect next to the script, disabled, and never writes kwinrc; status shows it;
    the command it prints (kwriteconfig6 --notify) turns it on in a running KWin; install-effect from the release
    zip, upgrade, remove-effect and remove behave; an effect installed after KWin started is found when enabled."""
    import release
    from scenarios_package import PackagedSession, build_zip, sh
    zip_path, _ = build_zip(out, c)
    effect_zip = Path(release.build(out / "dist")["effect"]["path"])
    with PackagedSession(out, zip_path) as s:
        kw = s.kw
        pr = s.prepare_result or {}
        target = kw.root / "data/kwin/effects" / EFFECT
        script_dir = kw.root / "data/kwin/scripts/plastile"
        c("install: script and effect installed into the nested data home (rc 0), kwinrc untouched",
          pr.get("rc") == 0 and (target / "contents/code/main.js").is_file() and pr.get("kwinrcUnchanged"),
          {k: pr.get(k) for k in ("rc", "stderr", "kwinrcUnchanged")})
        text = pr.get("stdout", "")
        c("install: prints how to enable it (System Settings > Desktop Effects, kwriteconfig6 --notify) and says it is "
          "disabled", "Desktop Effects" in text and f"--key {EFFECT}Enabled --notify true" in text and "disabled" in text,
          text[-900:])
        kw.wait_log(r"plastile (?:info|notice) started ", 30, 0)

        comp = kw.compositing_type()

        def loaded() -> bool:
            try:
                return bool(kw.call("/Effects", "org.kde.kwin.Effects", "isEffectLoaded", "s", EFFECT)[0])
            except NestedError:
                if comp == "OpenGL":
                    raise
                return False   # no effects interface without OpenGL compositing (KWin 6.7.5 QPainter)
        c("startup: the script autoloads, the effect stays off (EnabledByDefault false, no kwinrc key)", not loaded())
        st = sh(kw, "status")
        c("status: effect installed with its version, enabled key unset (default off)",
          st["rc"] == 0 and "effect    : installed" in st["stdout"] and "version 0.1.0" in st["stdout"]
          and "effect on : unset (default: off)" in st["stdout"], st["stdout"][-500:])
        try:
            supported = bool(kw.call("/Effects", "org.kde.kwin.Effects", "isEffectSupported", "s", EFFECT)[0])
        except NestedError:
            if comp == "OpenGL":
                raise
            supported = False
        # Where KWin cannot run scripted effects (QPainter, llvmpipe) the load checks below cannot be made; the
        # packaging checks still run. The detail of each load check says which case applied.
        rc = notify_enabled(kw, True)
        on = until_true(loaded, 5)
        c("enable: the printed kwriteconfig6 --notify command loads it in the running KWin (where KWin supports "
          "scripted effects)", rc == 0 and (on if supported else True), {"supported": supported, "compositing": comp, "loaded": on})
        st = sh(kw, "status")
        c("status: reports the kwinrc key as true", "effect on : true" in st["stdout"], st["stdout"][-300:])
        up = sh(kw, "upgrade", str(zip_path))
        c("upgrade: rc 0, effect still installed, kwinrc untouched by the installer",
          up["rc"] == 0 and target.is_dir() and up["kwinrcUnchanged"], {k: up.get(k) for k in ("rc", "stderr", "kwinrcUnchanged")})
        rm = sh(kw, "remove-effect")
        rm2 = sh(kw, "remove-effect")
        c("remove-effect: removes only the effect; a second call refuses with rc 2",
          rm["rc"] == 0 and not target.exists() and script_dir.is_dir() and rm2["rc"] == 2,
          {"rc": rm["rc"], "again": rm2["rc"], "stderr": rm2["stderr"]})
        env = {**kw.env(), "PLASTILE_EFFECT_SOURCE": str(effect_zip)}
        inst = subprocess.run(["sh", str(ROOT / "tools/install.sh"), "install-effect"], env=env, capture_output=True,
                              text=True, timeout=60)
        c("install-effect from the release zip (PLASTILE_EFFECT_SOURCE) after KWin started: rc 0",
          inst.returncode == 0 and (target / "metadata.json").is_file(), inst.stderr[-300:])
        notify_enabled(kw, False)
        until_true(lambda: not loaded(), 5)
        notify_enabled(kw, True)
        on = until_true(loaded, 5)
        c("post-start install: KWin finds the newly installed effect when it is enabled", on if supported else True,
          {"supported": supported, "compositing": comp, "loaded": on})
        notify_enabled(kw, False)
        until_true(lambda: not loaded(), 5)
        rmall = sh(kw, "remove")
        c("remove: removes the script and the effect, kwinrc untouched by the installer",
          rmall["rc"] == 0 and not target.exists() and not script_dir.exists() and rmall["kwinrcUnchanged"],
          {k: rmall.get(k) for k in ("rc", "stderr", "kwinrcUnchanged")})
        c("no errors in KWin's log", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])


# ------------------------------------------------------------------------------------------------ review edges
def on_screen(frames: list[dict], width: int = 1280, height: int = 800) -> list[dict]:
    """The fixtures a screenshot can show: not minimized and overlapping the (single) output."""
    return [f for f in frames if not f["minimized"] and f["frame"]["x"] < width and f["frame"]["y"] < height
            and f["frame"]["x"] + f["frame"]["width"] > 0 and f["frame"]["y"] + f["frame"]["height"] > 0]


def brief(lines: list[dict]) -> list:
    return [(x["kind"], x["caption"], x["rest"][:90]) for x in lines]


@scenario("motion-edges-T31")
def motion_edges(out: Path, c: Checks):
    """Cases added in review: the scrolling layout's parked columns, an output scale change, minimize and restore,
    a desktop switch, KWin's keyboard quick tile, suspend/resume, and a window closing mid-animation.
    - Scrolling: a column scrolled in from, or out to, its parked place off every output is not animated (it was or
      becomes invisible; AnimationEffect's Position also treats a negative coordinate as unset, so such a 'start'
      animated one axis only); a column visible before and after slides.
    - A scale change re-fits every window to the new logical size: an output change, not animated.
    - Minimize/restore: the minimized and restored window is not animated; the windows that make room are.
    - Desktop switch: nothing is animated while switching.
    - Keyboard quick tile: animated (documented: the effect cannot tell KWin's programmatic moves from Plastile's).
    - A window that closes mid-animation is released at once (cancel reason=closed); the others settle.
    Steps end with the composited image showing every visible window at its real rectangle (ScreenShot2)."""
    from scenarios import kscreen
    with MotionSession(out, config={"layout": "scrolling"}) as s:
        s.require_effect()
        for i in (1, 2, 3, 4):
            s.spawn(i)
        s.load(); s.settle()
        s.load_effect()
        shots = {}
        off = s.kw.mark()
        for _ in range(2):
            s.cmd("focus.left"); s.settle(); time.sleep(0.4)
        lines = s.motion(off)
        offscreen = [x for x in lines if x["kind"] == "skip" and "reason=offscreen" in x["rest"]]
        starts = [x for x in lines if x["kind"] == "start"]
        c("scrolling: the scroll steps park and unpark columns, none animated (skip reason=offscreen, one rectangle "
          "off the output)", len(offscreen) >= 2 and all((rect_of(x["rest"], "from")[1] < 0) != (rect_of(x["rest"], "to")[1] < 0)
                                                        for x in offscreen), brief(lines))
        c("scrolling: a column visible before and after slides (start, both rectangles on the output)",
          len(starts) >= 1 and all(rect_of(x["rest"], "from")[1] >= 0 and rect_of(x["rest"], "to")[1] >= 0 for x in starts),
          brief(starts))
        shots["scrolling"] = visual_errors(s.screenshot(), on_screen(s.frames_list()))
        c("scrolling: then every visible window is drawn at its real rectangle", not shots["scrolling"], shots["scrolling"])
        s.cmd("layout.master-stack"); s.settle(); time.sleep(0.4)
        s.kill(4); s.settle(); time.sleep(0.4)

        # Scale change: the re-fit is an output change.
        off = s.kw.mark()
        kscreen(s, "output.Virtual-0.scale.1.5")
        time.sleep(0.8); s.settle(); time.sleep(0.4)
        lines = s.motion(off)
        c("scale 1.5: the re-fit of every window is not animated (skip reason=transition)",
          not [x for x in lines if x["kind"] == "start"] and len([x for x in lines if "reason=transition" in x["rest"]]) >= 3,
          brief(lines))
        kscreen(s, "output.Virtual-0.scale.1")
        time.sleep(0.8); s.settle(); time.sleep(0.4)
        shots["scale"] = visual_errors(s.screenshot(), on_screen(s.frames_list()))
        c("scale back to 1: every window drawn at its real rectangle", not shots["scale"], shots["scale"])

        # Minimize and restore.
        off = s.kw.mark()
        s.act(fx(2), "w.minimized = true"); s.settle(); time.sleep(0.4)
        s.act(fx(2), "w.minimized = false"); s.settle(); time.sleep(0.4)
        c("minimize/restore: the minimized and restored window is not animated; a window that makes room is",
          not s.motion(off, "start", fx(2)) and len(s.motion(off, "start")) >= 2, brief(s.motion(off)))

        # Desktop switch (one desktop more, fixture 3 on it).
        s.js("if (workspace.desktops.length < 2) workspace.createDesktop(1, 'Two'); emit(1);")
        time.sleep(0.2)
        s.act(fx(3), "w.desktops = [workspace.desktops[1]]"); s.settle(); time.sleep(0.4)
        off = s.kw.mark()
        s.js("workspace.currentDesktop = workspace.desktops[1]; emit(1);"); s.settle(); time.sleep(0.6)
        s.js("workspace.currentDesktop = workspace.desktops[0]; emit(1);"); s.settle(); time.sleep(0.6)
        c("desktop switch there and back: nothing animated", not s.motion(off, "start"), brief(s.motion(off)))
        s.act(fx(3), "w.desktops = [workspace.desktops[0]]"); s.settle(); time.sleep(0.4)

        # Suspend, a command, resume.
        s.cmd("runtime.toggle-suspend"); s.settle(); time.sleep(0.2)
        s.cmd("swap.next"); s.settle(); time.sleep(0.2)
        s.cmd("runtime.toggle-suspend"); s.settle(); time.sleep(0.5)
        shots["suspend"] = visual_errors(s.screenshot(), on_screen(s.frames_list()))
        c("suspend/resume: no stuck transform, every window drawn at its real rectangle", not shots["suspend"], shots["suspend"])

        # KWin's keyboard quick tile (documented as animated).
        off = s.kw.mark()
        s.act(fx(2), "workspace.activeWindow = w; workspace.slotWindowQuickTileLeft()"); s.settle(); time.sleep(0.4)
        c("keyboard quick tile: animated like any programmatic change (documented)", bool(s.motion(off, "start", fx(2))),
          brief(s.motion(off)))
        a = s.screenshot()
        time.sleep(0.5)
        b = s.screenshot()
        c("keyboard quick tile: the image is still afterwards (no stuck transform; the quick tile overlaps a tile, so "
          "the per-window colour check does not apply)", image_diff(a, b) == 0.0, image_diff(a, b))
        c("no errors in KWin's log", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])

    with MotionSession(out / "close", effect_config={"Duration": 2000}) as s:
        s.require_effect()
        for i in (1, 2, 3, 4):
            s.spawn(i)
        s.load(); s.settle()
        s.load_effect()
        off = s.kw.mark()
        s.cmd("swap.next")
        wait_motion(s, off, "start", 2)
        time.sleep(0.3)
        animated = sorted({x["caption"] for x in s.motion(off, "start")})
        victim = animated[-1] if animated else fx(4)
        s.kill(int(victim.split()[-1]))
        s.settle()
        ends = wait_motion(s, off, "end", 1, timeout=4)
        time.sleep(0.4)
        lines = s.motion(off)
        c("close mid-animation: the closing window's animation is cancelled (reason=closed), never ended",
          any(x["kind"] == "cancel" and x["caption"] == victim and "reason=closed" in x["rest"] for x in lines)
          and not [x for x in lines if x["kind"] == "end" and x["caption"] == victim], brief(lines))
        shot = s.screenshot()
        frames = s.frames_list()
        time.sleep(0.5)
        ref = s.screenshot()
        errs = visual_errors(shot, frames)
        c("close mid-animation: the others settle; every window drawn at its real rectangle and still",
          len(ends) >= 1 and not errs and image_diff(shot, ref) == 0.0, {"errors": errs, "diff": image_diff(shot, ref)})
        c("no errors in KWin's log", not s.log_lines(ERRORS), s.log_lines(ERRORS)[:5])
        record("motion-edges-T31", {"visualErrors": shots, "closeVictim": victim})
