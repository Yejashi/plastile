"""Window-lifecycle and client-constraint scenarios at the KWin layer.

TEST_MATRIX IDs: C04 (create/remove before adoption), C06 (geometry signal during a write),
C07 (removal during apply), G07 (fixed-size Wayland client), G09 (maximum-size client), and
the late-minimum regression for defect D3 (a client raises its xdg minimum after mapping).

Geometry is judged by the independent oracle: one-shot KWin scripts reading real window
state, a passive plain-JS listener script (harness.Listener) that logs the workspace and
frame signals KWin emits, and the fixture clients' own JSONL logs (the configures they
received and the buffers they committed). Plastile's counters and trace are used only for
amounts of work and for attributing writes to window ids; `inspect.explain-window` is read
for the recorded decision and model constraints.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

from harness import (FIXTURE, Listener, Session, delta, explain, fixture_events, last_trace_t, near,
                     tiling_errors, trace, trace_since, window_info)
from scenarios import Checks, scenario

GAP = 8
ERRORS = r"plastile (error|warn)|TypeError|ReferenceError"
CONSTRAINTS = ("{resizeable: w.resizeable, min: [w.minSize.width, w.minSize.height], max: [w.maxSize.width, w.maxSize.height],"
               " frame: [w.frameGeometry.x, w.frameGeometry.y, w.frameGeometry.width, w.frameGeometry.height],"
               " client: [w.clientGeometry.width, w.clientGeometry.height]}")


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def full(area: dict) -> dict:
    return {"x": area["x"] + GAP, "y": area["y"] + GAP, "width": area["width"] - 2 * GAP, "height": area["height"] - 2 * GAP}


def writes_for(records: list[dict], wid: str) -> list[dict]:
    return [r for r in records if r.get("kind") == "write" and r.get("id") == wid]


def frames_of(s: Session, nums) -> dict[int, dict]:
    f = s.frames()
    return {i: f[fx(i)]["frame"] for i in nums}


def same_frames(a: dict[int, dict], b: dict[int, dict], tol: float = 0.5) -> bool:
    return a.keys() == b.keys() and all(near(a[i], b[i], tol) for i in a)


def boot_seconds(line: str) -> float | None:
    """The `%{time boot}` prefix KWin's log lines carry (QT_MESSAGE_PATTERN in tools/nested.py)."""
    m = re.match(r"\s*(\d+\.\d+)\s", line)
    return float(m.group(1)) if m else None


# --------------------------------------------------------------------------- G07
# Single-line JSON without backslashes: written verbatim into kwinrc (no KConfig escaping).
TILE_FIXED_RULE = json.dumps({"schemaVersion": 1, "rules": [
    {"id": "tile-fixed", "match": {"title": "plastile-fixture 4"}, "actions": {"mode": "tiled"}}]}, separators=(",", ":"))


@scenario("fixed-size-G07")
def fixed_size(out: Path, c: Checks):
    """A Wayland client with min == max (xdg set_min_size == set_max_size) floats per policy.

    Fixture 3 uses the default policy; fixture 4 is matched by a rule that asks to tile it, which
    the policy refuses for fixed-size windows (CONFIGURATION: "a fixed-size or non-resizable window
    still floats, with reason `fixed size (rule asked to tile)`").
    """
    with Session(out, config={"traceCapacity": 8192, "configJson": TILE_FIXED_RULE}) as s:
        s.spawn(1); s.spawn(2)
        s.spawn(3, "--fixed")
        s.spawn(4, "--fixed", "--size", "360x240")
        time.sleep(0.3)
        placed = frames_of(s, (3, 4))  # KWin's own placement, before Plastile exists
        k3, k4 = window_info(s, fx(3), CONSTRAINTS), window_info(s, fx(4), CONSTRAINTS)
        c("setup: KWin reports both fixed clients as non-resizable with min == max",
          not k3["resizeable"] and k3["min"] == k3["max"] == [400, 300] and not k4["resizeable"] and k4["min"] == k4["max"] == [360, 240],
          {"3": k3, "4": k4})
        s.load(); s.settle(); time.sleep(0.5); s.settle()
        area = s.area()
        wid = {f["caption"]: f["id"] for f in s.frames_list()}
        tr = trace(s)
        f = s.frames()
        pair = [f[fx(1)], f[fx(2)]]
        c("positive control: the two resizable windows tile the area as a pair (oracle, gaps>=8)",
          not tiling_errors(pair, area, GAP) and all(x["frame"]["height"] >= area["height"] - 2 * GAP - 0.5 for x in pair)
          and all(writes_for(tr, wid[fx(i)]) for i in (1, 2)),
          {"errors": tiling_errors(pair, area, GAP), "frames": [x["frame"] for x in pair],
           "writes": {i: len(writes_for(tr, wid[fx(i)])) for i in (1, 2)}})
        now = frames_of(s, (3, 4))
        c("G07: fixed-size windows keep KWin's placement and size (oracle unchanged since before load)",
          same_frames(placed, now) and abs(f[fx(3)]["client"]["width"] - 400) <= 0.5
          and abs(f[fx(3)]["client"]["height"] - 300) <= 0.5,
          {"before": placed, "after": now, "client3": f[fx(3)]["client"]})
        c("G07: Plastile issued no write to either fixed-size window (trace)",
          not writes_for(tr, wid[fx(3)]) and not writes_for(tr, wid[fx(4)]),
          {i: len(writes_for(tr, wid[fx(i)])) for i in (3, 4)})
        e3, e4 = explain(s, fx(3)), explain(s, fx(4))
        d3, d4 = e3.get("decision") or {}, e4.get("decision") or {}
        c("G07: default policy floats the fixed-size window (decision source constraint, reason 'fixed size')",
          e3.get("mode") == "floating" and d3.get("source") == "constraint" and d3.get("reason") == "fixed size", d3)
        c("G07: a rule asking to tile a fixed-size window still floats it, with the rule recorded",
          e4.get("mode") == "floating" and d4.get("reason") == "fixed size (rule asked to tile)" and "tile-fixed" in (d4.get("ruleIds") or []),
          d4)
        c("G07: model constraints are fixed (minFrame == maxFrame)", (e3.get("constraints") or {}).get("fixed") is True,
          e3.get("constraints"))
        # An explicit tile request is refused for a fixed-size window: no write, still floating.
        a = s.counters()
        t0 = last_trace_t(s)
        s.act(fx(3), "workspace.activeWindow = w")
        s.cmd("window.toggle-float")
        time.sleep(0.5)
        b = s.settle()
        e3b = explain(s, fx(3))
        after = frames_of(s, (1, 2, 3, 4))
        c("G07: toggle-float on a fixed-size window leaves it floating and unwritten",
          e3b.get("mode") == "floating" and not writes_for(trace_since(trace(s), t0), wid[fx(3)])
          and near(after[3], placed[3], 0.5), {"mode": e3b.get("mode"), "frame": after[3], "delta": delta(a, b)})
        c("G07: the refused request wrote nothing at all", delta(a, b).get("writes", 0) == 0, delta(a, b))
        errs = s.log_lines(ERRORS)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])


# --------------------------------------------------------------------------- G09
def max_size_checks(c: Checks, tag: str, s: Session, log: Path, cfg_from: int, mx: tuple[int, int]) -> None:
    """Fixture 3 (maximum mx) sits in the lower stack cell: at its maximum, centred in that cell."""
    area = s.area()
    f = s.frames()
    m, top, w = f[fx(1)]["frame"], f[fx(2)]["frame"], f[fx(3)]
    r, cl = w["frame"], w["client"]
    mw, mh = r["width"] - cl["width"], r["height"] - cl["height"]
    # The cell, derived from the neighbours' real frames (not from Plastile's plan): right of the master
    # column, below fixture 2, inside the outer gap.
    cell = {"x": m["x"] + m["width"] + GAP, "y": top["y"] + top["height"] + GAP}
    cell["width"] = area["x"] + area["width"] - GAP - cell["x"]
    cell["height"] = area["y"] + area["height"] - GAP - cell["y"]
    c(f"{tag}: window held at its maximum size (client {mx[0]}x{mx[1]})",
      abs(cl["width"] - mx[0]) <= 0.5 and abs(cl["height"] - mx[1]) <= 0.5, {"client": cl, "max": mx})
    lm, rm = r["x"] - cell["x"], cell["x"] + cell["width"] - (r["x"] + r["width"])
    tm, bm = r["y"] - cell["y"], cell["y"] + cell["height"] - (r["y"] + r["height"])
    c(f"{tag}: centred in its cell (defined alignment: margins equal within 1 px)",
      min(lm, rm, tm, bm) >= -0.5 and abs(lm - rm) <= 1.0 and abs(tm - bm) <= 1.0,
      {"cell": cell, "frame": r, "margins": [lm, rm, tm, bm], "decoration": [mw, mh]})
    errs = tiling_errors([f[fx(1)], f[fx(2)], w], area, GAP)
    c(f"{tag}: all three inside the area without overlap, gaps>=8 (oracle)", not errs, errs)
    big = [e for e in fixture_events(log, "configure")[cfg_from:]
           if e["width"] > mx[0] + 0.5 or e["height"] > mx[1] + 0.5]
    c(f"{tag}: the client was never configured beyond its maximum (client log)", not big, big[:3])


@scenario("max-size-G09")
def max_size(out: Path, c: Checks):
    """A client with xdg max size 500x300 that clamps to it: no repeated force-resize, centred in its slot."""
    with Session(out, config={"traceCapacity": 8192}) as s:
        s.spawn(1); s.spawn(2)
        f3 = s.spawn(3, "--max", "500x300", "--clamp")
        k3 = window_info(s, fx(3), CONSTRAINTS)
        c("setup: KWin reports the client maximum 500x300", k3["max"] == [500, 300] and k3["resizeable"], k3)
        cfg0 = len(fixture_events(f3.log, "configure"))  # configures before Plastile existed
        s.load(); s.settle(); time.sleep(0.8)
        a = s.settle()
        max_size_checks(c, "G09 adopt", s, f3.log, cfg0, (500, 300))
        c("G09 adopt: no corrections (the request already honoured the maximum)", a["counters"]["corrections"] == 0, a["counters"])
        time.sleep(2.0)
        b = s.counters()
        cfg1 = len(fixture_events(f3.log, "configure"))
        time.sleep(1.0)
        c("G09: converged: no writes and no configures to the client for 3 s (counter + client log)",
          delta(a, b).get("writes", 0) == 0 and len(fixture_events(f3.log, "configure")) == cfg1 and b["outstanding"] == 0,
          {"delta": delta(a, b), "configures": [cfg1, len(fixture_events(f3.log, "configure"))]})
        # A layout change: the cell narrows; the window stays at its maximum, re-centred.
        s.act(fx(1), "workspace.activeWindow = w")
        mark = len(fixture_events(f3.log, "configure"))
        a = s.counters()
        s.cmd("resize.grow")
        time.sleep(0.8)
        b = s.settle()
        max_size_checks(c, "G09 after grow", s, f3.log, mark, (500, 300))
        d = delta(a, b)
        c("G09 after grow: one solve, at most one write per window, no corrections",
          d.get("solves", 0) == 1 and d.get("writes", 0) <= 3 and d.get("corrections", 0) == 0, d)
        errs = s.log_lines(ERRORS)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])


# --------------------------------------------------------------------------- D3
@scenario("late-min-size-D3")
def late_min_size(out: Path, c: Checks):
    """Defect D3 regression: a client raises its xdg minimum (700x500) after it was tiled.

    KWin keeps no NOTIFY on minSize, but it updates minSize immediately (window.h, xdgshellwindow.cpp
    handleMinimumSizeChanged, which also emits maximizeableChanged). The client clamps configures to
    its minimum, as toolkits do. Expected: Plastile adopts the new minimum from the client's hint and
    re-solves to a feasible layout, rather than learning it from a refused request after the 750 ms
    convergence deadline (learnedMin) or leaving the window overlapping its peers.
    """
    facts: dict = {}
    with Session(out, config={"traceCapacity": 8192}) as s:
        # Fixture 3 first: it becomes the master (691 px wide, below the 700 px minimum it raises later).
        f3 = s.spawn(3, "--clamp", "--late-min-size", "700,500,4000")
        s.spawn(1); s.spawn(2)
        s.load(); s.settle()
        # Every configure makes this client enforce its minimum, so all focus changes happen before the hint.
        s.act(fx(2), "workspace.activeWindow = w")
        time.sleep(0.3)
        s.settle()
        area = s.area()
        wid = {f["caption"]: f["id"] for f in s.frames_list()}
        pre = s.frames()
        hinted = any(e.get("reason") == "late-min-size" for e in fixture_events(f3.log, "size_hints"))
        c("setup: before the hint the window is tiled as the master, narrower than 700 px (oracle)",
          not hinted and not tiling_errors(list(pre.values()), area, GAP) and abs(pre[fx(3)]["frame"]["x"] - (area["x"] + GAP)) <= 0.5
          and pre[fx(3)]["frame"]["width"] < 700, {"hinted": hinted, "frames": {k: v["frame"] for k, v in pre.items()}})
        s.wait_for(lambda: any(e.get("reason") == "late-min-size" for e in fixture_events(f3.log, "size_hints")), 8,
                   "late minimum hint")
        time.sleep(0.4)
        k3 = window_info(s, fx(3), CONSTRAINTS)
        c("setup: KWin reports the raised client minimum 700x500", k3["min"] == [700, 500], k3)
        hint_cfg = len(fixture_events(f3.log, "configure"))
        t0 = last_trace_t(s)
        a = s.counters()
        # A layout change with the stack window active: growing it shrinks the master column further.
        s.cmd("resize.grow")
        time.sleep(2.5)
        b = s.settle()
        f = s.frames()
        k3 = window_info(s, fx(3), CONSTRAINTS)
        mw, mh = k3["frame"][2] - k3["client"][0], k3["frame"][3] - k3["client"][1]
        errs = tiling_errors(list(f.values()), area, GAP)
        c("D3: after the re-solve the layout is feasible: all three inside the area, no overlap, gaps>=8 (oracle)",
          not errs, {"errors": errs, "frames": {k: v["frame"] for k, v in f.items()}})
        c("D3: the window is at or above its declared minimum (oracle client size)",
          k3["client"][0] >= 700 - 0.5 and k3["client"][1] >= 500 - 0.5, k3)
        e3 = explain(s, fx(3))
        mf = (e3.get("constraints") or {}).get("minFrame") or {}
        c("D3: Plastile's model minimum covers the client's minimum plus decoration",
          mf.get("width", 0) >= 700 + mw - 0.5 and mf.get("height", 0) >= 500 + mh - 0.5,
          {"modelMinFrame": mf, "expectedAtLeast": [700 + mw, 500 + mh]})
        recs = trace_since(trace(s), t0)
        learned = [r for r in recs if r.get("kind") == "deadline" and r.get("id") == wid[fx(3)] and r.get("data") == "learn"]
        c("D3: minimum adopted from the client's hint, not learned from a refused request (learnedMin null, no 'learn' deadline)",
          e3.get("learnedMin") is None and not learned,
          {"learnedMin": e3.get("learnedMin"), "learnDeadlines": len(learned), "exception": e3.get("exception")})
        d = delta(a, b)
        time.sleep(1.5)
        b2 = s.counters()
        c("D3: bounded work: corrections <= 2, nothing outstanding, no writes in the next 1.5 s",
          d.get("corrections", 0) <= 2 and b2["outstanding"] == 0 and delta(b, b2).get("writes", 0) == 0,
          {"delta": d, "after": delta(b, b2), "outstanding": b2["outstanding"]})
        below = [[e["width"], e["height"]] for e in fixture_events(f3.log, "configure")[hint_cfg:]
                 if 0 < e["width"] < 700 or 0 < e["height"] < 500]
        facts["configuresBelowMinimumAfterHint"] = below
        facts["learnedMin"] = e3.get("learnedMin")
        facts["counters"] = d
        errs = s.log_lines(ERRORS)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])
    c("facts (recorded, always passes)", True, facts)


# --------------------------------------------------------------------------- C06
@scenario("write-signal-C06")
def write_signal(out: Path, c: Checks):
    """Geometry signals KWin emits inside Plastile's own frame writes: recorded, never re-solved.

    A swap of the two equal-size stack windows is a position-only change, which KWin applies inside
    the frameGeometry setter and reports synchronously (API_PROFILE: "KWin emits position
    observations inside the frameGeometry setter"). A grow is a real resize, observed on commit.
    """
    with Session(out, config={"traceCapacity": 8192}) as s:
        s.spawn(1); s.spawn(2); s.spawn(3)
        lis = Listener(s, frames=(fx(1), fx(2), fx(3)))
        try:
            s.load(); s.settle(); time.sleep(0.3); s.settle()
            area = s.area()
            pre = frames_of(s, (1, 2, 3))
            c("setup: the two stack windows have equal sizes (a swap is position-only)",
              abs(pre[2]["width"] - pre[3]["width"]) <= 0.5 and abs(pre[2]["height"] - pre[3]["height"]) <= 0.5, pre)
            s.act(fx(2), "workspace.activeWindow = w")
            time.sleep(0.1)
            a = s.counters()
            t0 = last_trace_t(s)
            off = s.kw.mark()
            s.cmd("swap.next")
            time.sleep(0.6)
            b = s.settle()
            post = frames_of(s, (1, 2, 3))
            d = delta(a, b)
            c("positive control: fixtures 2 and 3 exchanged positions (oracle)",
              near(post[2], pre[3], 0.5) and near(post[3], pre[2], 0.5) and near(post[1], pre[1], 0.5), post)
            signals = lis.lines("frame", off)
            c("C06: KWin emitted a frame signal for each moved window (independent listener)",
              len([x for x in signals if f"{fx(2)}|" in x]) >= 1 and len([x for x in signals if f"{fx(3)}|" in x]) >= 1,
              signals)
            c("C06: the signals arrived inside Plastile's writes (observationsDuringApply rose by >= 2)",
              d.get("observationsDuringApply", 0) >= 2, d)
            c("C06: every emitted frame signal was recorded as an observation (Plastile observations == listener count)",
              d.get("observations", 0) == len(signals), {"observations": d.get("observations", 0), "signals": len(signals)})
            recs = [r for r in trace_since(trace(s), t0) if r.get("kind") == "write"]
            c("C06: expected observations: both writes settled synchronously, nothing outstanding",
              len(recs) == 2 and all((r.get("data") or {}).get("settled") is True for r in recs) and b["outstanding"] == 0,
              {"writes": recs, "outstanding": b["outstanding"]})
            c("C06: no recursive solve: exactly one solve, two writes, no corrections",
              d.get("solves", 0) == 1 and d.get("writes", 0) == 2 and d.get("corrections", 0) == 0, d)
            # A real resize: observations arrive on the clients' commits, after the write returned.
            s.act(fx(1), "workspace.activeWindow = w")
            time.sleep(0.1)
            a = s.counters()
            off = s.kw.mark()
            s.cmd("resize.grow")
            time.sleep(0.8)
            b = s.settle()
            d = delta(a, b)
            signals = lis.lines("frame", off)
            c("C06 resize: one solve and one write per window; commits observed later trigger no further solve",
              d.get("solves", 0) == 1 and d.get("writes", 0) == 3 and d.get("observations", 0) == len(signals)
              and d.get("corrections", 0) == 0, {"delta": d, "signals": len(signals)})
            time.sleep(1.0)
            c("C06 resize: still one solve 1 s later", delta(a, s.counters()).get("solves", 0) == 1, delta(a, s.counters()))
            f = s.frames_list()
            c("C06: final layout valid (oracle, gaps>=8)", not tiling_errors(f, area, GAP), tiling_errors(f, area, GAP))
            errs = s.log_lines(ERRORS)
            c("no Plastile errors or JS exceptions", not errs, errs[:3])
        finally:
            lis.close()


# --------------------------------------------------------------------------- C04
def xclient_display(s: Session) -> str:
    import scenarios_xwayland as X  # deferred: keeps this module importable without the X fixture
    return X.x_display(s)


@scenario("create-remove-C04")
def create_remove(out: Path, c: Checks):
    """C04 at the KWin layer: a window created and removed before Plastile adopts it gets no write.

    Plastile adopts (classifies and places) a window in the flush that follows windowAdded, on
    the next event-loop pass, so a Wayland client cannot remove its window in between (part C
    measures that race). Two KWin paths reach "removed before adoption":
      A. an X11 window with no WM_CLASS: resourceClass is empty, so Plastile holds it pending for
         its 300 ms readiness window (late metadata); the client exits ~120 ms after starting;
      B. a Wayland toplevel destroyed in the same flush as its first buffer commit
         (fixture --exit-on-map): KWin itself never reports the window.
    """
    import scenarios_xwayland as X
    facts: dict = {}
    with Session(out, config={"traceCapacity": 8192}, xwayland=True) as s:
        s.spawn(1); s.spawn(2)
        lis = Listener(s)
        try:
            s.load(); s.settle()
            X.XClient(s, "c04-warm")  # starts Xwayland (lazy) so part A measures mapping, not server start-up
            time.sleep(0.5)
            base = s.settle()
            keep = frames_of(s, (1, 2))

            # A: X11 window without a class, removed inside Plastile's readiness window.
            a = s.counters()
            t0 = last_trace_t(s)
            off = s.kw.mark()
            env = s.kw.client_env()
            env["DISPLAY"] = xclient_display(s)
            log = s.out / "xclient-c04-noclass.jsonl"
            p = subprocess.Popen([str(X.XCLIENT), "--title", "c04-noclass", "--class", "", "--exit-after-ms", "120"], env=env,
                                 stdin=subprocess.PIPE, stdout=open(log, "w"), stderr=subprocess.STDOUT)
            s.kw._clients.append(p)
            p.wait(timeout=10)
            time.sleep(0.6)
            b = s.settle()
            added = [ln for ln in lis.lines("added", off) if "c04-noclass|" in ln]
            removed = [ln for ln in lis.lines("removed", off) if "c04-noclass|" in ln]
            life = (boot_seconds(removed[0]) - boot_seconds(added[0])) if added and removed else None
            facts["A.lifetimeSeconds"] = life
            facts["A.addedLine"] = added[:1]
            c("A precondition: KWin added and removed the class-less X11 window (independent listener)",
              len(added) == 1 and len(removed) == 1, {"added": added, "removed": removed})
            c("A precondition: KWin reported it with an empty resourceClass", bool(added) and '"cls":""' in added[0], added[:1])
            c("A precondition: removed inside Plastile's 300 ms readiness window", life is not None and life < 0.28, life)
            d = delta(a, b)
            recs = trace_since(trace(s), t0)
            xid = added[0].split("c04-noclass|", 1)[1].split(" ", 1)[0] if added else None
            mine = [r for r in recs if r.get("id") == xid]
            c("A C04: Plastile registered and dropped it (adopted +1, removed +1)", d.get("adopted", 0) == 1 and d.get("removed", 0) == 1, d)
            c("A C04: zero placement writes and zero solves", d.get("writes", 0) == 0 and d.get("solves", 0) == 0, d)
            c("A C04: never classified or placed (trace has only add/remove for it)",
              sorted({r["kind"] for r in mine}) == ["add", "remove"], [(r["kind"], r.get("data")) for r in mine])
            c("A C04: peers untouched (oracle)", same_frames(keep, frames_of(s, (1, 2))), frames_of(s, (1, 2)))

            # B: mapping commit and destruction in one flush.
            a = s.counters()
            off = s.kw.mark()
            log = s.out / "fixture-exit-on-map.jsonl"
            p = s.kw.spawn([str(FIXTURE), "--ssd", "--id", "40", "--exit-on-map"], stdout=open(log, "w"), stdin=subprocess.PIPE)
            p.wait(timeout=10)
            time.sleep(0.6)
            b = s.settle()
            ev = fixture_events(log)
            c("B precondition: the client committed its first buffer and exited in the same flush (client log)",
              any(e.get("ev") == "commit" and e.get("flush_deferred") for e in ev) and any(e.get("ev") == "exit" and
              e.get("reason") == "exit-on-map" for e in ev), [e.get("ev") for e in ev][-6:])
            seen = [ln for ln in lis.lines("added", off) + lis.lines("removed", off) if "plastile-fixture 40|" in ln]
            facts["B.kwinReported"] = seen
            c("B: KWin never reported the window (no windowAdded/windowRemoved; independent listener)", not seen, seen)
            d = delta(a, b)
            c("B C04: Plastile recorded nothing and wrote nothing", d.get("adopted", 0) == 0 and d.get("writes", 0) == 0, d)
            c("B C04: peers untouched (oracle)", same_frames(keep, frames_of(s, (1, 2))), frames_of(s, (1, 2)))

            # C: removed right after mapping (the race Plastile wins: adopted, then removed).
            a = s.counters()
            t0 = last_trace_t(s)
            off = s.kw.mark()
            log = s.out / "fixture-exit-after-map.jsonl"
            p = s.kw.spawn([str(FIXTURE), "--ssd", "--id", "41", "--exit-after-map-ms", "0"], stdout=open(log, "w"),
                           stdin=subprocess.PIPE)
            p.wait(timeout=10)
            time.sleep(0.8)
            b = s.settle()
            added = [ln for ln in lis.lines("added", off) if "plastile-fixture 41|" in ln]
            removed = [ln for ln in lis.lines("removed", off) if "plastile-fixture 41|" in ln]
            c("C precondition: KWin added and removed the window (independent listener)", len(added) == 1 and len(removed) == 1,
              {"added": added, "removed": removed})
            wid41 = added[0].split("plastile-fixture 41|", 1)[1].split(" ", 1)[0] if added else None
            recs = trace_since(trace(s), t0)
            kinds = [r["kind"] for r in recs if r.get("id") == wid41]
            rm = next((i for i, r in enumerate(recs) if r.get("id") == wid41 and r["kind"] == "remove"), None)
            after_rm = [r for r in recs[rm + 1:] if r.get("id") == wid41] if rm is not None else []
            facts["C.windowRecords"] = kinds
            facts["C.adoptedBeforeRemoval"] = "write" in kinds
            c("C: no write and no record for the window after its removal (trace order)", rm is not None and not after_rm,
              {"records": kinds, "afterRemove": after_rm})
            c("C: peers back in their two-window slots, nothing outstanding (oracle)",
              same_frames(keep, frames_of(s, (1, 2)), 1.0) and b["outstanding"] == 0, {"frames": frames_of(s, (1, 2)),
                                                                                       "outstanding": b["outstanding"]})
            errs = s.log_lines(ERRORS)
            c("no Plastile errors or JS exceptions", not errs, errs[:3])
            c("model: Plastile adapter tracks exactly the live windows again", b["windows"] == base["windows"],
              {"before": base["windows"], "after": b["windows"]})
        finally:
            lis.close()
    c("facts (recorded, always passes)", True, facts)


# --------------------------------------------------------------------------- C07
@scenario("remove-during-apply-C07")
def remove_during_apply(out: Path, c: Checks):
    """C07 at the KWin layer: a window is removed while Plastile's requests to it are outstanding.

    A Wayland window can only disappear during Wayland dispatch, never inside the synchronous JS
    write loop (windowRemoved comes from surface destruction), so the KWin half is "removed during
    the transaction": all three clients delay their commits by 400 ms, a grow requests new frames
    for all of them, and fixture 2 quits before acknowledging its configure.
    """
    with Session(out, config={"traceCapacity": 8192}) as s:
        fxs = {i: s.spawn(i, "--configure-delay-ms", "400") for i in (1, 2, 3)}
        lis = Listener(s)
        try:
            s.load(); s.settle(); time.sleep(0.5); s.settle()
            area = s.area()
            wid = {f["caption"]: f["id"] for f in s.frames_list()}
            pre = frames_of(s, (1, 2, 3))
            s.act(fx(1), "workspace.activeWindow = w")
            time.sleep(0.1)
            n2 = len(fixture_events(fxs[2].log, "configure"))
            a = s.counters()
            t0 = last_trace_t(s)
            off = s.kw.mark()
            s.cmd("resize.grow")
            s.wait_for(lambda: len(fixture_events(fxs[2].log, "configure")) > n2, 3, "configure for fixture 2")
            s.kill(2, wait=False)
            s.wait_for(lambda: all(f["caption"] != fx(2) for f in s.frames_list()), 5, "fixture 2 removed")
            time.sleep(2.0)
            b = s.settle()
            ev2 = fixture_events(fxs[2].log)
            last_cfg = max((e["serial"] for e in ev2 if e.get("ev") == "configure"), default=None)
            acked = {e.get("serial") for e in ev2 if e.get("ev") == "ack"}
            c("precondition: fixture 2 received Plastile's request and quit without acknowledging it (client log)",
              last_cfg is not None and last_cfg not in acked, {"lastConfigure": last_cfg, "acked": sorted(x for x in acked if x)})
            c("precondition: KWin removed the window (independent listener)", fx(2) in lis.captions("removed", off),
              lis.lines("removed", off))
            recs = trace_since(trace(s), t0)
            rm = next((i for i, r in enumerate(recs) if r.get("id") == wid[fx(2)] and r["kind"] == "remove"), None)
            after = [r for r in recs[rm + 1:] if r.get("id") == wid[fx(2)]] if rm is not None else ["no remove record"]
            c("C07: tombstoned: nothing is written to or recorded for the window after its removal (trace)", not after, after)
            f = s.frames()
            pair = [f[fx(1)], f[fx(3)]]
            c("C07: peers still applied: the two remaining windows tile the area (oracle, gaps>=8)",
              not tiling_errors(pair, area, GAP) and all(x["frame"]["height"] >= area["height"] - 2 * GAP - 0.5 for x in pair),
              {"errors": tiling_errors(pair, area, GAP), "frames": [x["frame"] for x in pair]})
            c("C07: the grow survived the removal (master wider than before)", f[fx(1)]["frame"]["width"] > pre[1]["width"] + 20,
              {"before": pre[1], "after": f[fx(1)]["frame"]})
            d = delta(a, b)
            c("C07: converged: nothing outstanding, corrections <= 2, removed +1",
              b["outstanding"] == 0 and d.get("corrections", 0) <= 2 and d.get("removed", 0) == 1, {"delta": d, "outstanding": b["outstanding"]})
            errs = s.log_lines(ERRORS)
            c("no Plastile errors or JS exceptions", not errs, errs[:3])
        finally:
            lis.close()
