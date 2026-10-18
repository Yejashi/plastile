"""Recovery scenarios: resume and re-adoption after missed events (T19), per-send reflow (T24).

Two real paths lose Plastile's view of incremental changes:

- `runtime.toggle-suspend`: the engine keeps receiving KWin's events but writes nothing (flush
  drops its dirty work while suspended); resume marks every context dirty and solves once.
- Disable/enable (script unload/load): the runtime is gone, so every event in between is
  missed; the next start adopts `adapter.liveSnapshots()` as one batch.

Geometry is judged by the oracle (one-shot KWin scripts). Plastile's trace
(`inspect.dump-trace`) attributes solves to context ids and writes to window ids; its
counters give amounts of work. Everything runs in disposable nested KWin sessions.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from harness import Session, delta, near, steady_connections, tiling_errors, trace, trace_since, last_trace_t
from scenarios import Checks, scenario, script_objects
from scenarios_contexts import PerOutputSession, full, per_screen

GAP = 8
ERRORS = r"plastile (error|warn)|TypeError|ReferenceError"
SEP = "␟"  # contextId separator (src/core/types.ts)


def fx(i: int) -> str:
    return f"plastile-fixture {i}"


def until(pred, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if pred():
                return True
        except Exception:
            pass
        time.sleep(0.05)
    return False


def ids(s: Session) -> dict[str, str]:
    return {f["caption"]: f["id"] for f in s.frames_list()}


def frames(s: Session) -> dict[str, dict]:
    return {f["caption"]: f["frame"] for f in s.frames_list()}


def area_of(s: Session, output: str) -> dict:
    out = s.js(f"const o = workspace.screens.find(x => x.name === {json.dumps(output)}); const a = workspace.clientArea("
               f"workspace.MaximizeArea, o, workspace.currentDesktopForScreen(o)); emit({{x: a.x, y: a.y, width: a.width,"
               f" height: a.height}});")
    return json.loads(out[0])


def per_output_errors(s: Session) -> dict[str, list[str]]:
    """Oracle: the windows on each output's current desktop tile inside that output's work area."""
    cur = json.loads(s.js("emit(workspace.screens.map(o => [o.name, workspace.currentDesktopForScreen(o).id]))")[0])
    out: dict[str, list[str]] = {}
    for name, desk in cur:
        ws = [f for f in s.frames_list() if f["output"] == name and desk in f["desktops"]]
        errs = tiling_errors(ws, area_of(s, name), GAP) if ws else []
        if errs:
            out[name] = errs
    return out


def writes_in(records: list[dict]) -> dict[str, int]:
    n: dict[str, int] = {}
    for r in records:
        if r.get("kind") == "write":
            n[r["id"]] = n.get(r["id"], 0) + 1
    return n


def solves_in(records: list[dict]) -> dict[str, int]:
    """Solves per context, keyed `output/desktop-index-free id` as recorded (output␟desktop␟activity)."""
    n: dict[str, int] = {}
    for r in records:
        if r.get("kind") == "solve":
            n[r["id"]] = n.get(r["id"], 0) + 1
    return n


def ctx_key(output: str, desktop: str, ctx_ids) -> str | None:
    """The recorded context id for (output, desktop) among `ctx_ids` (the activity part is whatever KWin reports)."""
    for k in ctx_ids:
        o, d = k.split(SEP)[:2]
        if o == output and d == desktop:
            return k
    return None


def readable(n: dict[str, int]) -> dict[str, int]:
    return {k.replace(SEP, "/"): v for k, v in n.items()}


def members(s: Session) -> dict[str, int]:
    return {x["id"].replace(SEP, "/"): x["members"] for x in s.counters()["contexts"]}


def wait_command(s: Session, cmd: str, t0: float, timeout: float = 3.0) -> bool:
    """Wait until Plastile's trace records `cmd` after t0 (shortcut dispatch is asynchronous)."""
    full_id = cmd if cmd.startswith("plastile.") else f"plastile.{cmd}"
    return until(lambda: any(r.get("kind") == "command" and (r.get("data") or {}).get("id") == full_id
                             for r in trace_since(trace(s), t0)), timeout)


def toggle_suspend(s: Session) -> bool:
    t0 = last_trace_t(s)
    s.cmd("runtime.toggle-suspend")
    return wait_command(s, "runtime.toggle-suspend", t0)


def is_suspended(s: Session) -> bool:
    """A no-op probe: commands are rejected with 'tiling suspended' while suspended."""
    t0 = last_trace_t(s)
    s.cmd("focus.next")
    wait_command(s, "focus.next", t0)
    recs = [r for r in trace_since(trace(s), t0) if r.get("kind") == "command"]
    return bool(recs) and (recs[-1].get("data") or {}).get("reason") == "tiling suspended"


def send_next_output(s: Session, i: int, times: int = 1) -> None:
    for _ in range(times):
        s.act(fx(i), "workspace.activeWindow = w")
        s.cmd("move.output-next")
        s.settle()


def missed_changes(s: Session, desk2: str) -> dict[str, dict]:
    """The changes Plastile must not see live: close 3, open 6 on Virtual-0, resize 5 on Virtual-1,
    resize 2 in place (its slot does not change, so only the drift calls for a write), move 4 to
    Virtual-2 and 7 to desktop Two. Returns the externally set frames of 5 and 2."""
    s.kill(3)
    s.act(fx(2), "workspace.activeWindow = w")  # new windows open on the active output, after the focused one
    s.spawn(6)
    a0, a1 = area_of(s, "Virtual-0"), area_of(s, "Virtual-1")
    ext = {fx(5): {"x": a1["x"] + 60, "y": a1["y"] + 60, "width": 420, "height": 300},
           fx(2): {"x": a0["x"] + a0["width"] // 2 + 40, "y": a0["y"] + 40, "width": 380, "height": 260}}
    for cap, r in ext.items():
        s.act(cap, f"w.frameGeometry = {json.dumps(r)}")
    s.act(fx(4), "workspace.sendClientToScreen(w, workspace.screens.find(o => o.name === 'Virtual-2'))")
    s.act(fx(7), "w.desktops = [workspace.desktops.find(d => d.id === " + json.dumps(desk2) + ")]")
    until(lambda: (lambda f: f[fx(4)]["output"] == "Virtual-2" and f[fx(7)]["desktops"] == [desk2]
                   and all(near(f[cap]["frame"], r, 1.0) for cap, r in ext.items()))(s.frames()), 5)
    return ext


def setup_three_outputs(s: Session) -> str:
    """1,2,3 on Virtual-0; 4,5,7 on Virtual-1; Virtual-2 empty; a second desktop Two (empty)."""
    s.js("workspace.createDesktop(1, 'Two'); emit(1)")
    for i in (1, 2, 3, 4, 5, 7):
        s.spawn(i)
    s.load(); s.settle()
    for i in (4, 5, 7):
        send_next_output(s, i)
    return json.loads(s.js("emit(workspace.desktops[1].id)")[0])


def placement(s: Session) -> dict[str, str]:
    return {f["caption"]: f["output"] for f in s.frames_list()}


def check_adopted(c: Checks, s: Session, tag: str, before: dict[str, dict], wid: dict[str, str], recs: list[dict],
                  closed_id: str, desk1: str, desk2: str, ext: dict[str, dict], slots: dict[str, dict]) -> None:
    """Shared assertions after resume / re-adoption. `slots` holds the frames tiled before the
    missed changes; 1 and 2 keep their slots (2 was only resized away from it)."""
    f = s.frames()
    after = {k: v["frame"] for k, v in f.items()}
    a0, a1, a2 = area_of(s, "Virtual-0"), area_of(s, "Virtual-1"), area_of(s, "Virtual-2")
    errs = per_output_errors(s)
    c(f"{tag}: every output's visible windows tile inside its work area, gaps >= 8 (oracle)", not errs, errs)
    c(f"{tag}: the window opened meanwhile (6) is tiled on Virtual-0 next to 1 and 2 (oracle)",
      f[fx(6)]["output"] == "Virtual-0" and not tiling_errors([f[fx(i)] for i in (1, 2, 6)], a0, GAP)
      and f[fx(6)]["frame"]["width"] < a0["width"] - 2 * GAP, {i: f[fx(i)]["frame"] for i in (1, 2, 6)})
    c(f"{tag}: the window moved to Virtual-2 (4) fills it; the externally resized one (5) fills Virtual-1 (oracle)",
      near(f[fx(4)]["frame"], full(a2), 1.0) and near(f[fx(5)]["frame"], full(a1), 1.0),
      {"4": f[fx(4)]["frame"], "5": f[fx(5)]["frame"], "ext5": ext[fx(5)]})
    c(f"{tag}: the window resized in place (2) is back in its unchanged slot, 1 never left its slot (oracle)",
      near(f[fx(2)]["frame"], slots[fx(2)], 1.0) and near(f[fx(1)]["frame"], slots[fx(1)], 1.0),
      {"2": f[fx(2)]["frame"], "slot2": slots[fx(2)], "ext2": ext[fx(2)], "1": f[fx(1)]["frame"], "slot1": slots[fx(1)]})
    counts = s.counters()
    ctx = {x["id"]: x["members"] for x in counts["contexts"]}
    live = len(s.frames_list())
    c(f"{tag}: the closed window is not revived: Plastile tracks the {live} live windows only "
      f"(context members and adapter count)", sum(ctx.values()) == live and counts["windows"] == live,
      {"members": readable(ctx), "windows": counts["windows"], "live": live})
    c(f"{tag}: nothing recorded for the closed window's id after adoption",
      not [r for r in recs if r.get("id") == closed_id and r.get("kind") != "remove"],
      [r for r in recs if r.get("id") == closed_id][:3])
    w = writes_in(recs)
    changed = {k for k in after if k in before and not near(after[k], before[k], 0.5)} | {k for k in after if k not in before}
    by_cap = {cap: w.get(wid[cap], 0) for cap in after if cap in wid}
    c(f"{tag}: the window already in its slot (1) is not written and did not move (oracle + trace)",
      by_cap.get(fx(1), 0) == 0 and fx(1) not in changed, {"writes": by_cap, "changed": sorted(changed)})
    c(f"{tag}: minimal writes: one per window that had to move (2 drifted, 4, 5, 6), none for the hidden one (7)",
      {k: v for k, v in by_cap.items() if v} == {fx(2): 1, fx(4): 1, fx(5): 1, fx(6): 1},
      {"writes": by_cap, "changed": sorted(changed)})
    sv = solves_in(recs)
    keys = {n: ctx_key(o, desk1, list(ctx) + list(sv)) for n, o in (("V0", "Virtual-0"), ("V1", "Virtual-1"), ("V2", "Virtual-2"))}
    hidden = ctx_key("Virtual-1", desk2, list(ctx) + list(sv))
    c(f"{tag}: one solve per visible context (Virtual-0, -1, -2 on Desktop 1), none for the hidden one",
      all(k is not None and sv.get(k, 0) == 1 for k in keys.values()) and sv.get(hidden, 0) == 0
      and sum(sv.values()) == 3, readable(sv))
    c(f"{tag}: the window moved to desktop Two (7) is tracked there, not written while hidden",
      hidden is not None and ctx.get(hidden) == 1 and by_cap.get(fx(7), 0) == 0, {"members": readable(ctx)})


# ---------------------------------------------------------------- T19 suspend
@scenario("resume-missed-events-T19")
def resume_missed(out: Path, c: Checks):
    """Suspend, then open/close/move desktop/move output/external resize (one in place), then resume.

    While suspended Plastile still receives KWin's events (no write, no fight); resume must solve the
    current live state once per visible context, write only windows that are not in their slot, and
    never revive the closed window. A reconcile afterwards writes nothing."""
    facts: dict = {}
    with Session(out, outputs=3, config={"traceCapacity": 8192}) as s:
        off = s.kw.mark()
        desk2 = setup_three_outputs(s)
        desk1 = json.loads(s.js("emit(workspace.desktops[0].id)")[0])
        place = placement(s)
        c("setup: 1,2,3 on Virtual-0; 4,5,7 on Virtual-1; tiled (oracle)",
          [place[fx(i)] for i in (1, 2, 3, 4, 5, 7)] == ["Virtual-0"] * 3 + ["Virtual-1"] * 3 and not per_output_errors(s),
          {"place": place, "errors": per_output_errors(s)})
        wid = ids(s)
        slots = frames(s)
        closed = wid[fx(3)]
        c("suspend: accepted", toggle_suspend(s) and is_suspended(s))
        t_sus = last_trace_t(s)
        ext = missed_changes(s, desk2)
        time.sleep(0.8)  # give a (wrong) write a chance to land
        f = s.frames()
        recs = trace_since(trace(s), t_sus)
        c("suspended: Plastile wrote nothing while windows opened, closed and moved (trace)", not writes_in(recs),
          readable(writes_in(recs)))
        c("suspended: the external resizes (5, and 2 in place) are not fought (oracle)",
          all(near(f[cap]["frame"], r, 1.0) for cap, r in ext.items()), {cap: f[cap]["frame"] for cap in ext})
        c("suspended: setup moved 4 to Virtual-2 and 7 to desktop Two (oracle)",
          f[fx(4)]["output"] == "Virtual-2" and f[fx(7)]["desktops"] == [desk2] and fx(3) not in f,
          {"4": f[fx(4)]["output"], "7": f[fx(7)]["desktops"]})
        wid = {**wid, **ids(s)}
        before = frames(s)
        a = s.counters()
        t_res = last_trace_t(s)
        c("resume: accepted", toggle_suspend(s) and not is_suspended(s))
        time.sleep(0.3)
        b = s.settle()
        recs = trace_since(trace(s), t_res)
        facts["resume"] = {"writes": readable(writes_in(recs)), "solves": readable(solves_in(recs)), "delta": delta(a, b)}
        check_adopted(c, s, "resume", before, wid, recs, closed, desk1, desk2, ext, slots)
        # 2's settled request is its slot: re-placing it there after the drift is a correction
        # (ledger.decideWrite). Every other write is a plan write, and none is retried.
        reasons: dict[str, list[str]] = {}
        for cap, i in wid.items():
            rs = [r["data"]["reason"] for r in recs if r.get("kind") == "write" and r.get("id") == i]
            if rs:
                reasons[cap] = rs
        c("resume: each write landed as requested; the only correction re-places 2, which drifted in place",
          delta(a, b).get("corrections", 0) == 1
          and reasons == {fx(2): ["correction"], fx(4): ["plan"], fx(5): ["plan"], fx(6): ["plan"]},
          {"delta": delta(a, b), "reasons": reasons})

        # The hidden window is tiled once its desktop is shown.
        s.js("workspace.currentDesktop = workspace.desktops[1]; emit(1)")
        time.sleep(0.4); s.settle()
        a1 = area_of(s, "Virtual-1")
        f7 = s.frames()[fx(7)]["frame"]
        c("resume: 7 is tiled when desktop Two is shown (oracle)", near(f7, full(a1), 1.0), {"frame": f7, "area": a1})
        s.js("workspace.currentDesktop = workspace.desktops[0]; emit(1)")
        time.sleep(0.4); s.settle()

        # Recovery reconcile on a consistent state is a no-op.
        a = s.counters()
        t0 = last_trace_t(s)
        s.cmd("runtime.reconcile")
        until(lambda: any(r.get("kind") == "reconcile" for r in trace_since(trace(s), t0)), 3)
        time.sleep(0.4)
        b = s.settle()
        recs = trace_since(trace(s), t0)
        c("reconcile after resume: nothing written, every window kept (counters + trace)",
          delta(a, b).get("writes", 0) == 0 and not writes_in(recs) and b["windows"] == len(s.frames_list()),
          {"delta": delta(a, b), "windows": b["windows"]})
        errs = s.log_lines(ERRORS, off)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])
    c("facts (recorded, always passes)", True, facts)


# ---------------------------------------------------------------- T19 disable/enable
@scenario("reenable-missed-events-T19")
def reenable_missed(out: Path, c: Checks):
    """Disable Plastile, make the same changes, enable it: start() adopts the live inventory.

    Then repeated suspend/resume and disable/enable cycles leave exactly one engine: one script
    object, one shortcut per command, steady connections, one command record per press."""
    facts: dict = {}
    with Session(out, outputs=3, config={"traceCapacity": 8192}) as s:
        off = s.kw.mark()
        desk2 = setup_three_outputs(s)
        desk1 = json.loads(s.js("emit(workspace.desktops[0].id)")[0])
        wid = ids(s)
        slots = frames(s)
        closed = wid[fx(3)]
        names0 = s.kw.shortcut_names()
        s.unload()
        ext = missed_changes(s, desk2)
        time.sleep(0.3)
        wid = {**wid, **ids(s)}
        before = frames(s)
        s.load()
        time.sleep(0.3)
        s.settle()
        recs = trace(s)  # a fresh runtime: its whole trace is the adoption
        facts["adopt"] = {"writes": readable(writes_in(recs)), "solves": readable(solves_in(recs))}
        check_adopted(c, s, "re-enable", before, wid, recs, closed, desk1, desk2, ext, slots)

        # Repeated suspend/resume, then disable/enable, with a command pending at each unload.
        cycles = 10
        errors = []
        for i in range(cycles):
            if not (toggle_suspend(s) and toggle_suspend(s)):
                errors.append(("suspend", i))
        steady = steady_connections(s.settle())
        for i in range(cycles):
            s.act(fx(1), "workspace.activeWindow = w")
            s.cmd("resize.grow" if i % 2 == 0 else "resize.shrink")
            s.unload()
            s.load()
            cc = s.settle()
            if steady_connections(cc) != steady or cc["windows"] != len(s.frames_list()):
                errors.append(("reload", i, cc["connections"], cc["windows"]))
        names1 = s.kw.shortcut_names()
        objects = script_objects(s)
        facts["cycles"] = {"errors": errors, "scriptObjects": objects, "shortcuts": [len(names0), len(names1)]}
        c(f"enable/disable: {cycles} suspend/resume and {cycles} reload cycles keep connection and window counts steady",
          not errors, errors)
        c("enable/disable: exactly one Plastile script object exported by KWin (independent)", len(objects) == 1, objects)
        c("enable/disable: one shortcut per command (kglobalaccel: same names, no duplicates)",
          sorted(names0) == sorted(names1) and len(names1) == len(set(names1)), (len(names0), len(names1)))
        c("enable/disable: not left suspended", not is_suspended(s))
        # One press, one engine: exactly one command record and one ratio step.
        a0 = area_of(s, "Virtual-0")
        s.act(fx(1), "workspace.activeWindow = w")
        m0 = s.frames()[fx(1)]["frame"]
        a = s.counters()
        t0 = last_trace_t(s)
        s.cmd("resize.grow")
        wait_command(s, "resize.grow", t0)
        time.sleep(0.3)
        b = s.settle()
        m1 = s.frames()[fx(1)]["frame"]
        cmds = [r for r in trace_since(trace(s), t0) if r.get("kind") == "command" and r["data"]["id"] == "plastile.resize.grow"]
        step = 0.05 * (a0["width"] - 2 * GAP - GAP)
        c("enable/disable: one grow press runs one command and moves the master edge by one step (oracle)",
          len(cmds) == 1 and delta(a, b).get("commands", 0) == 1 and abs((m1["width"] - m0["width"]) - step) <= 1.5,
          {"commands": len(cmds), "delta": delta(a, b), "before": m0["width"], "after": m1["width"], "step": step})
        errs = s.log_lines(ERRORS, off)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])
    c("facts (recorded, always passes)", True, facts)


# ---------------------------------------------------------------- T24 per-send reflow
def ctx_of(s: Session, output: str, desk_name: str) -> str:
    """The context id Plastile records for (output, desktop name) on the current activity."""
    did = json.loads(s.js(f"emit(workspace.desktops.find(d => d.name === {json.dumps(desk_name)}).id)")[0])
    ctxs = s.counters()["contexts"]
    for x in ctxs:
        o, d = x["id"].split(SEP)[:2]
        if o == output and d == did:
            return x["id"]
    # Not created yet (an empty context): same activity part as any existing one.
    return SEP.join([output, did, ctxs[0]["id"].split(SEP)[2]])


def send_and_measure(s: Session, i: int, cmd: str) -> tuple[list[dict], dict, dict]:
    """Activate fixture i, run `cmd`, settle; returns (trace records since, counter delta, frames before)."""
    s.act(fx(i), "workspace.activeWindow = w")
    before = frames(s)
    a = s.counters()
    t0 = last_trace_t(s)
    s.cmd(cmd)
    wait_command(s, cmd, t0)
    time.sleep(0.4)
    b = s.settle()
    return trace_since(trace(s), t0), delta(a, b), before


def minimal(c: Checks, name: str, recs: list[dict], before: dict, after: dict, wid: dict, expect: dict[str, int]) -> None:
    """Writes per window (trace) are exactly `expect`, and only those windows moved (oracle)."""
    w = writes_in(recs)
    by_cap = {cap: w.get(wid[cap], 0) for cap in wid if w.get(wid[cap], 0)}
    moved = sorted(k for k in after if k in before and not near(after[k], before[k], 0.5))
    c(name, by_cap == expect and set(moved) <= set(expect), {"writes": by_cap, "moved": moved, "expected": expect})


@scenario("send-reflow-once-T24")
def send_reflow_once(out: Path, c: Checks):
    """Each send solves each affected context exactly once and writes only the windows whose slot changed.

    Two outputs with per-output desktops (the follow-on-send-T24 setup): 1,2,3 on Virtual-0
    (Desktop 1); Virtual-1 shows the empty desktop Two. Fixture 3 is sent to Virtual-1, then
    fixture 2 to desktop Two. A context that is hidden when the send lands is solved once when it
    is shown (O08), so the count runs over the send and that showing. Solves are attributed per
    context from the trace's `solve` records (context id = output, desktop, activity)."""
    facts: dict = {}
    follow_doc = json.dumps({"schemaVersion": 1, "defaults": {"followOnSend": True}})
    for mode, config in (("default", {}), ("follow", {"configJson": follow_doc})):
        with PerOutputSession(out / mode, outputs=2, config={"traceCapacity": 8192, **config}) as s:
            off = s.kw.mark()
            s.js("workspace.createDesktop(1, 'Two'); emit(1)")
            for i in (1, 2, 3):
                s.spawn(i)
            s.load(); s.settle()
            s.js("workspace.setCurrentDesktopForScreen(workspace.desktops[1], workspace.screens[1]); emit(1)")
            time.sleep(0.3); s.settle()
            wid = ids(s)
            src = ctx_of(s, "Virtual-0", "Desktop 1")
            dst_out = ctx_of(s, "Virtual-1", "Two")
            dst_desk = ctx_of(s, "Virtual-0", "Two")

            # Send to output: both contexts visible.
            recs, d, before = send_and_measure(s, 3, "move.output-next")
            sv = solves_in(recs)
            facts[f"{mode}.output"] = {"solves": readable(sv), "writes": readable(writes_in(recs)), "delta": d}
            f = s.frames()
            c(f"{mode}: output send landed: 3 on Virtual-1, tiled full there (oracle)",
              f[fx(3)]["output"] == "Virtual-1" and near(f[fx(3)]["frame"], full(s.area(1)), 1.0), f[fx(3)])
            c(f"{mode}: output send solves the source and the destination exactly once each, nothing else "
              "(trace; the solves counter agrees)",
              sv == {src: 1, dst_out: 1} and d.get("solves", 0) == 2,
              {"solves": readable(sv), "src": src.replace(SEP, "/"), "dst": dst_out.replace(SEP, "/"), "delta": d})
            minimal(c, f"{mode}: output send writes 2 (reflowed) and 3 (placed) once each, not 1 (slot unchanged)",
                    recs, before, frames(s), wid, {fx(2): 1, fx(3): 1})
            c(f"{mode}: output send: no corrections", d.get("corrections", 0) == 0, d)

            # Send to desktop.
            recs, d, before = send_and_measure(s, 2, "move.desktop-next")
            sv = solves_in(recs)
            views = per_screen(s)
            facts[f"{mode}.desktop"] = {"solves": readable(sv), "writes": readable(writes_in(recs)), "delta": d, "views": views}
            two = json.loads(s.js("emit(workspace.desktops[1].id)")[0])
            c(f"{mode}: desktop send landed: 2 on desktop Two (oracle)", s.frames()[fx(2)]["desktops"] == [two])
            if mode == "default":
                # The destination is hidden: only the source is solved now; the destination when shown.
                c("default: desktop send solves the source once; the hidden destination not at all "
                  "(trace; the solves counter agrees)", sv == {src: 1} and d.get("solves", 0) == 1,
                  {"solves": readable(sv), "delta": d})
                minimal(c, "default: desktop send writes 1 (reflowed to full) once, nothing else",
                        recs, before, frames(s), wid, {fx(1): 1})
                shown, then = (dst_desk, {fx(2): 1}), "Two"
            else:
                # Follow shows the destination on Virtual-0: it is solved now; the source, hidden, when shown again.
                c("follow: desktop send solves the shown destination once; the now-hidden source not at all "
                  "(trace; the solves counter agrees)",
                  views["Virtual-0"] == "Two" and sv == {dst_desk: 1} and d.get("solves", 0) == 1,
                  {"solves": readable(sv), "views": views, "delta": d})
                minimal(c, "follow: desktop send writes 2 (placed on Two) once, nothing else",
                        recs, before, frames(s), wid, {fx(2): 1})
                shown, then = (src, {fx(1): 1}), "Desktop 1"
            c(f"{mode}: desktop send: no corrections", d.get("corrections", 0) == 0, d)
            # Show the context the send left hidden: one solve, its one window written once.
            before = frames(s)
            a = s.counters()
            t0 = last_trace_t(s)
            s.js(f"workspace.setCurrentDesktopForScreen(workspace.desktops.find(d => d.name === {json.dumps(then)}),"
                 " workspace.screens[0]); emit(1)")
            until(lambda: per_screen(s)["Virtual-0"] == then, 3)
            time.sleep(0.4)
            d = delta(a, s.settle())
            recs = trace_since(trace(s), t0)
            sv = solves_in(recs)
            facts[f"{mode}.show"] = {"solves": readable(sv), "writes": readable(writes_in(recs)), "delta": d}
            c(f"{mode}: showing the context the send left hidden solves it exactly once (trace; the solves counter agrees)",
              sv == {shown[0]: 1} and d.get("solves", 0) == 1,
              {"solves": readable(sv), "expected": shown[0].replace(SEP, "/"), "delta": d})
            minimal(c, f"{mode}: and writes its window once", recs, before, frames(s), wid, shown[1])
            c(f"{mode}: every output tiled after the sends (oracle)", not per_output_errors(s), per_output_errors(s))
            errs = s.log_lines(ERRORS, off)
            c(f"{mode}: no Plastile errors or JS exceptions", not errs, errs[:3])
    c("facts (recorded, always passes)", True, facts)


@scenario("send-stale-close-T24")
def send_stale_close(out: Path, c: Checks):
    """A window closed right after a send: the transfer's leftovers (its outstanding destination
    write, its deadline, late signals) do nothing.

    Fixture 4 delays every configure ack by 400 ms, so the destination write is still outstanding
    when it closes. Case A closes it as soon as the trace shows that write; case B closes it
    straight after the shortcut, whatever KWin has processed by then."""
    facts: dict = {}
    for case in ("after-write", "immediate"):
        with Session(out / case, outputs=2, config={"traceCapacity": 8192}) as s:
            off = s.kw.mark()
            s.spawn(1); s.spawn(2); s.spawn(4, "--configure-delay-ms", "400")
            s.load(); s.settle(timeout=6)
            w4 = ids(s)[fx(4)]
            s.act(fx(4), "workspace.activeWindow = w")
            a = s.counters()
            t0 = last_trace_t(s)
            s.cmd("move.output-next")
            if case == "after-write":
                wrote = until(lambda: any(r.get("kind") == "write" and r.get("id") == w4
                                          for r in trace_since(trace(s), t0)), 3)
                c("after-write: the destination write was issued before the close (trace)", wrote)
            s.kill(4)
            time.sleep(1.5)  # past the 750 ms request deadline and the delayed ack
            b = s.settle()
            recs = trace_since(trace(s), t0)
            rm = [k for k, r in enumerate(recs) if r.get("kind") == "remove" and r.get("id") == w4]
            later = [r for r in recs[rm[0] + 1:] if r.get("id") == w4] if rm else None
            ctx = {x["id"]: x["members"] for x in b["contexts"]}
            facts[case] = {"delta": delta(a, b), "recordsFor4": [r["kind"] for r in recs if r.get("id") == w4],
                           "members": readable(ctx)}
            if case == "after-write":
                # The leftovers exist only if the write was still outstanding at the close: not
                # settled inside the write, and no `settled` record before the removal.
                upto = [r for r in recs[:rm[0]] if r.get("id") == w4] if rm else []
                wr = [r for r in upto if r.get("kind") == "write"]
                c("after-write: that write was still outstanding when the window closed (trace)",
                  len(wr) == 1 and not wr[0]["data"]["settled"] and not [r for r in upto if r.get("kind") == "settled"],
                  [(r["kind"], r.get("data")) for r in upto])
            c(f"{case}: the closed window's removal is recorded, and nothing for it afterwards (no write, deadline, correction)",
              bool(rm) and later == [], {"records": facts[case]["recordsFor4"], "after": later})
            c(f"{case}: no request outstanding and no correction",
              b["outstanding"] == 0 and delta(a, b).get("corrections", 0) == 0, {"outstanding": b["outstanding"], "delta": delta(a, b)})
            c(f"{case}: Plastile tracks the two live windows only", sum(ctx.values()) == 2 and b["windows"] == 2,
              {"members": readable(ctx), "windows": b["windows"]})
            fl = s.frames_list()
            c(f"{case}: the remaining windows tile Virtual-0 (oracle)",
              not per_output_errors(s) and all(f["output"] == "Virtual-0" and f["frame"]["height"] > 700 for f in fl),
              {"errors": per_output_errors(s), "frames": {f["caption"]: f["frame"] for f in fl}})
            errs = s.log_lines(ERRORS, off)
            c(f"{case}: no Plastile errors or JS exceptions", not errs, errs[:3])
    c("facts (recorded, always passes)", True, facts)
