"""Membership scenarios (T24): multi-context windows, and a send racing an activity switch.

BEHAVIOR_SPEC §2 (ADR-009): a window on all desktops, or on several desktops or activities,
floats, so one real frame never receives competing targets. These scenarios keep such a window
on screen while desktops and activities switch and other windows are sent, and judge three
independent views:

- KWin's frames over time: a passive plain-JS listener (harness.Listener) logs every
  frameGeometryChanged of the fixtures, so a write Plastile did not record, or a frame that
  goes A -> B -> A (ping-pong), is visible even when the final geometry looks right;
- Plastile's trace (`inspect.dump-trace`): writes attributed to window ids, solves to context
  ids, `visibility` records marking where KWin reported a desktop/activity switch;
- the oracle (one-shot KWin scripts): final frames, desktops, activities.

The documented policy for a multi-context window is zero frame requests while it is
multi-context; when its membership narrows to one context it tiles there with one target.
Everything runs in disposable nested KWin sessions; kactivitymanagerd, when used, runs on the
nested private bus only.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from harness import Listener, Session, delta, explain, last_trace_t, near, tiling_errors, trace, trace_since
from scenarios import Checks, Skipped, scenario
from scenarios_contexts import KAMD, activity_state, add_activity, full, start_kamd

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


def desk_ids(s: Session) -> list[str]:
    return json.loads(s.js("emit(workspace.desktops.map(d => d.id))")[0])


def current_desktop(s: Session) -> str:
    return json.loads(s.js("emit(workspace.currentDesktop.id)")[0])


def show_desktop(s: Session, d: str) -> None:
    s.js(f"workspace.currentDesktop = workspace.desktops.find(x => x.id === {json.dumps(d)}); emit(1)")


def request_activity(s: Session, act: str) -> None:
    """Ask KWin to switch activity; KWin forwards it to kactivitymanagerd (asynchronous)."""
    s.js(f"workspace.currentActivity = {json.dumps(act)}; emit(1)")


def place(s: Session, where: dict[int, dict]) -> None:
    """Move fixtures in one one-shot script: {i: {"output": name, "desktops": [ids], "activities": [ids]}}."""
    body = []
    for i, w in where.items():
        body.append(f"(function () {{ const w = workspace.windowList().find(x => x.caption === {json.dumps(fx(i))});")
        if "output" in w:
            body.append(f"workspace.sendClientToScreen(w, workspace.screens.find(o => o.name === {json.dumps(w['output'])}));")
        if "desktops" in w:
            body.append(f"w.desktops = workspace.desktops.filter(d => {json.dumps(w['desktops'])}.includes(d.id));")
        if "activities" in w:
            body.append(f"w.activities = {json.dumps(w['activities'])};")
        body.append("})();")
    s.js("\n".join(body) + "\nemit(1)")


def window_state(s: Session) -> dict[int, dict]:
    out = s.js("emit(workspace.windowList().filter(w => w.resourceClass === 'plastile-fixture').map(w => [w.caption,"
               " {output: w.output.name, desktops: w.desktops.map(d => d.id), onAllDesktops: w.onAllDesktops,"
               " activities: Array.from(w.activities).map(String)}]))")
    return {int(k.rsplit(" ", 1)[1]): v for k, v in json.loads(out[0])}


def ids(s: Session) -> dict[str, str]:
    return {f["caption"]: f["id"] for f in s.frames_list()}


def by_caption(recs: list[dict], wid: dict[str, str], kind: str = "write") -> dict[str, int]:
    rev = {v: k for k, v in wid.items()}
    out: dict[str, int] = {}
    for r in recs:
        if r.get("kind") == kind and r.get("id") in rev:
            out[rev[r["id"]]] = out.get(rev[r["id"]], 0) + 1
    return out


def commands(recs: list[dict], cmd: str) -> list[dict]:
    return [r["data"] for r in recs if r.get("kind") == "command" and r["data"]["id"] == f"plastile.{cmd}"]


def kwin_frames(lst: Listener, offset: int) -> dict[str, list[dict]]:
    """Every frameGeometryChanged the passive listener logged after `offset`, per caption, in order."""
    out: dict[str, list[dict]] = {}
    for ln in lst.lines("frame", offset):
        rest = ln.split("PLT-L frame ", 1)[1]
        g = json.loads(rest.rsplit(" ", 1)[1])
        out.setdefault(rest.split("|", 1)[0], []).append({"x": g[0], "y": g[1], "width": g[2], "height": g[3]})
    return out


def steps(seq: list[dict]) -> list[dict]:
    """The rectangles KWin reported, consecutive repeats merged (one per write: a write is one
    frameGeometryChanged in these sessions)."""
    out: list[dict] = []
    for r in seq:
        if not out or not near(out[-1], r, 0.5):
            out.append(r)
    return out


def pingpong(seq: list[dict]) -> list[dict]:
    """Rectangles KWin reported again after the window had left them for another (A -> B -> A)."""
    st = steps(seq)
    return [r for k, r in enumerate(st) if any(near(r, p, 0.5) for p in st[:max(0, k - 1)])]


def unrecorded(kw: dict[str, list[dict]], writes: dict[str, int]) -> dict:
    """KWin's side of "one target per window": frames that changed without a Plastile write in
    the same interval, or that went through more than one rectangle (listener vs trace)."""
    return {k: v for k, v in kw.items() if k not in writes or len(steps(v)) > 1}


def covered(frames: list[dict], area: dict) -> float:
    """Share of the area the (non-overlapping) frames cover: a missing tile or a stale half frame drops it."""
    return sum(f["frame"]["width"] * f["frame"]["height"] for f in frames) / (area["width"] * area["height"])


class Run:
    """Shared state of one session: window ids, the passive listener and the expected tiling per context.

    `ctx` maps (output, desktop id, activity or None) to the fixtures Plastile should tile there;
    the activity is None in sessions without the activity service."""

    def __init__(self, s: Session, c: Checks, ctx: dict[tuple, list[int]], nums):
        self.s, self.c, self.ctx = s, c, ctx
        self.wid = ids(s)
        self.lst = Listener(s, frames=tuple(fx(i) for i in nums))

    def measure(self, act, ready, timeout: float = 6.0) -> dict:
        """Run `act`, wait for `ready` (an event wait on KWin state), settle; return what happened."""
        s = self.s
        t0 = last_trace_t(s)
        off = s.kw.mark()
        a = s.counters()
        act()
        ok = until(ready, timeout)
        b = s.settle(timeout=timeout, quiet=0.3)
        recs = trace_since(trace(s), t0)
        return {"ready": ok, "recs": recs, "delta": delta(a, b), "kwin": kwin_frames(self.lst, off),
                "writes": by_caption(recs, self.wid), "counters": b}

    def shown(self, desk: str, act: str | None) -> dict[str, list[int]]:
        out: dict[str, list[int]] = {}
        for (o, d, a), nums in self.ctx.items():
            if d == desk and a == act:
                out.setdefault(o, []).extend(nums)
        return out

    def view(self, label: str, desk: str, act: str | None, cnt: dict) -> None:
        """Every output's shown context tiles (oracle: containment, overlap, gaps, coverage) and
        Plastile's member count for it matches (counters)."""
        s = self.s
        f = s.frames()
        names = json.loads(s.js("emit(workspace.screens.map(o => o.name))")[0])
        members = {tuple(x["id"].split(SEP)[:2]) + ((x["id"].split(SEP)[2],) if act else (None,)): x["members"]
                   for x in cnt["contexts"]}
        bad = {}
        for k, o in enumerate(names):
            nums = self.shown(desk, act).get(o, [])
            if not nums:
                continue
            area = s.area(k)
            tiles = [f[fx(i)] for i in nums]
            errs = tiling_errors(tiles, area, GAP)
            cov = covered(tiles, area)
            got = members.get((o, desk, act), 0)
            if errs or cov < 0.9 or got != len(nums):
                bad[o] = {"errors": errs, "coverage": round(cov, 3), "members": got, "expected": nums}
        self.c(f"{label}: every output's shown context tiles its expected windows (oracle; members from counters)",
               not bad, bad)

    def judge_switch(self, label: str, r: dict, pinned: list[int], desk: str, act: str | None,
                     applied: bool, pinned_frames: dict[int, dict]) -> None:
        c = self.c
        c(f"{label}: the switch landed (oracle)", r["ready"])
        pw = {fx(i): r["writes"].get(fx(i), 0) for i in pinned}
        pk = {fx(i): r["kwin"].get(fx(i), []) for i in pinned}
        now = self.s.frames()
        c(f"{label}: multi-context windows get no request (trace) and KWin reports no frame change for them (listener, oracle)",
          not any(pw.values()) and not any(pk.values())
          and all(near(now[fx(i)]["frame"], pinned_frames[i], 0.5) for i in pinned), {"writes": pw, "kwin": pk})
        visible = {fx(i) for nums in self.shown(desk, act).values() for i in nums}
        c(f"{label}: at most one write per window, only to windows of the shown context; no corrections (trace)",
          all(v == 1 for v in r["writes"].values()) and set(r["writes"]) <= visible
          and r["delta"].get("corrections", 0) == 0, {"writes": r["writes"], "delta": r["delta"]})
        if applied:
            c(f"{label}: an already applied context is shown with no solve and no write (trace, counters)",
              not r["writes"] and r["delta"].get("solves", 0) == 0, {"writes": r["writes"], "delta": r["delta"]})
        pp = {k: pingpong(v) for k, v in r["kwin"].items() if pingpong(v)}
        c(f"{label}: no frame goes back to a rectangle it left (listener, every fixture)", not pp, pp)
        # Independent of Plastile's own records: KWin moved only windows the trace says were
        # written, each to one rectangle; an already applied context moved nothing at all.
        un = unrecorded(r["kwin"], r["writes"])
        c(f"{label}: KWin changed only frames Plastile wrote, each to one rectangle"
          + ("; nothing at all for an applied context" if applied else "") + " (listener vs trace)",
          not un and not (applied and any(r["kwin"].values())), {"kwin": r["kwin"], "writes": r["writes"]})
        self.view(label, desk, act, r["counters"])


# --------------------------------------------------------------------------- all desktops
@scenario("membership-all-desktops-T24")
def all_desktops(out: Path, c: Checks):
    """A window on all desktops (two outputs, three desktops) while desktops switch and peers are sent.

    Fixture 1 is tiled on Virtual-0/Desktop 1, then set on all desktops. Each switch, and two
    rounds of them, must leave it without a request; peers on each output tile their shown
    context; a second round writes nothing. Peers are sent across outputs and desktops while it
    is shown; commands on the pinned window itself are no-ops, except send-to-output, which KWin
    performs (Plastile still writes nothing). Unpinned again, it tiles in exactly one context."""
    facts: dict = {}
    with Session(out, outputs=2, config={"traceCapacity": 8192}) as s:
        off = s.kw.mark()
        s.js("workspace.createDesktop(1, 'Two'); workspace.createDesktop(2, 'Three'); emit(1)")
        D1, D2, D3 = desk_ids(s)
        name = {D1: "Desktop 1", D2: "Two", D3: "Three"}
        for i in range(1, 7):
            s.spawn(i)
        place(s, {3: {"desktops": [D2]}, 4: {"desktops": [D3]}, 5: {"output": "Virtual-1"},
                  6: {"output": "Virtual-1", "desktops": [D2]}})
        st = window_state(s)
        want = {1: ("Virtual-0", D1), 2: ("Virtual-0", D1), 3: ("Virtual-0", D2), 4: ("Virtual-0", D3),
                5: ("Virtual-1", D1), 6: ("Virtual-1", D2)}
        c("setup: fixtures placed (oracle)", all((st[i]["output"], st[i]["desktops"]) == (o, [d]) for i, (o, d) in want.items()), st)
        s.load(); s.settle()
        run = Run(s, c, {("Virtual-0", D1, None): [1, 2], ("Virtual-0", D2, None): [3], ("Virtual-0", D3, None): [4],
                         ("Virtual-1", D1, None): [5], ("Virtual-1", D2, None): [6]}, range(1, 7))

        r = run.measure(lambda: s.act(fx(1), "w.onAllDesktops = true"), lambda: window_state(s)[1]["onAllDesktops"])
        run.ctx[("Virtual-0", D1, None)] = [2]
        e1 = explain(s, fx(1))
        c("pin: fixture 1 floats, decided by membership ('on all desktops'), no context",
          e1.get("mode") == "floating" and (e1.get("decision") or {}).get("reason") == "on all desktops"
          and e1.get("context") is None, {"mode": e1.get("mode"), "decision": e1.get("decision"), "context": e1.get("context")})
        c("pin: no request for the pinned window; its peer reflows with one write (trace)",
          r["writes"] == {fx(2): 1} and not r["kwin"].get(fx(1)), {"writes": r["writes"], "kwin1": r["kwin"].get(fx(1))})
        run.view("pin", D1, None, r["counters"])
        pinned = {1: s.frames()[fx(1)]["frame"]}

        facts["round"] = []
        seen = {D1}
        for k, d in enumerate([D2, D3, D1, D3, D2, D1]):
            r = run.measure(lambda: show_desktop(s, d), lambda: current_desktop(s) == d)
            label = f"switch {k + 1} to {name[d]}"
            run.judge_switch(label, r, [1], d, None, d in seen, pinned)
            seen.add(d)
            facts["round"].append({"to": name[d], "writes": r["writes"], "solves": r["delta"].get("solves", 0)})

        # Desktop 1 is shown. Sends of other windows while the pinned window is on screen.
        r = run.measure(lambda: (s.act(fx(5), "workspace.activeWindow = w"), s.cmd("move.output-next")),
                        lambda: window_state(s)[5]["output"] == "Virtual-0")
        run.ctx[("Virtual-1", D1, None)] = []
        run.ctx[("Virtual-0", D1, None)] = [2, 5]
        c("send 5 to Virtual-0: the pinned window gets no request; 2 and 5 one write each (trace)",
          r["writes"] == {fx(2): 1, fx(5): 1} and not r["kwin"].get(fx(1)), {"writes": r["writes"], "kwin1": r["kwin"].get(fx(1))})
        run.view("send 5 to Virtual-0", D1, None, r["counters"])
        r = run.measure(lambda: (s.act(fx(2), "workspace.activeWindow = w"), s.cmd("move.desktop-next")),
                        lambda: window_state(s)[2]["desktops"] == [D2])
        run.ctx[("Virtual-0", D1, None)] = [5]
        run.ctx[("Virtual-0", D2, None)] = [3, 2]
        c("send 2 to Two: the pinned window gets no request; 5 reflows with one write, Two (hidden) is not solved (trace)",
          r["writes"] == {fx(5): 1} and r["delta"].get("solves", 0) == 1 and not r["kwin"].get(fx(1)),
          {"writes": r["writes"], "delta": r["delta"]})
        run.view("send 2 to Two", D1, None, r["counters"])
        r = run.measure(lambda: show_desktop(s, D2), lambda: current_desktop(s) == D2)
        run.judge_switch("show Two after the send", r, [1], D2, None, False, pinned)
        c("show Two after the send: 3 and 2 written once each, nothing else (trace)", r["writes"] == {fx(3): 1, fx(2): 1},
          r["writes"])

        # Commands on the pinned window itself.
        r = run.measure(lambda: (s.act(fx(1), "workspace.activeWindow = w"), s.cmd("move.desktop-next"),
                                 s.cmd("window.toggle-float")),
                        lambda: len(commands(trace(s), "window.toggle-float")) > 0)
        md, tf = commands(r["recs"], "move.desktop-next"), commands(r["recs"], "window.toggle-float")
        st = window_state(s)
        c("pinned: send-to-desktop is a no-op ('no other desktop'), it stays on all desktops (trace, oracle)",
          [x["status"] for x in md] == ["noop"] and md[0].get("reason") == "no other desktop" and st[1]["onAllDesktops"], md)
        c("pinned: toggle-float cannot tile it ('cannot tile: on all desktops')",
          [x["status"] for x in tf] == ["noop"] and tf[0].get("reason") == "cannot tile: on all desktops", tf)
        c("pinned: neither command wrote anything or moved it (trace, listener)", not r["writes"] and not r["kwin"].get(fx(1)),
          {"writes": r["writes"], "kwin": r["kwin"].get(fx(1))})
        r = run.measure(lambda: (s.act(fx(1), "workspace.activeWindow = w"), s.cmd("move.output-next")),
                        lambda: window_state(s)[1]["output"] == "Virtual-1")
        st = window_state(s)
        facts["pinnedOutputSend"] = {"kwinFrames": r["kwin"].get(fx(1), []), "state": st[1]}
        c("pinned: send-to-output is performed by KWin; Plastile writes nothing (trace), the window stays on all desktops "
          "and floating (oracle)", st[1]["output"] == "Virtual-1" and st[1]["onAllDesktops"] and not r["writes"],
          {"writes": r["writes"], "state": st[1]})
        run.view("pinned output send", D2, None, r["counters"])
        pinned = {1: s.frames()[fx(1)]["frame"]}
        for k, d in enumerate([D3, D1, D2]):
            r = run.measure(lambda: show_desktop(s, d), lambda: current_desktop(s) == d)
            run.judge_switch(f"round 3 to {name[d]}", r, [1], d, None, True, pinned)

        # Unpin while Two is shown: KWin puts it on Two; it tiles with 6 on Virtual-1, one target.
        r = run.measure(lambda: s.act(fx(1), "w.onAllDesktops = false"),
                        lambda: window_state(s)[1]["desktops"] == [D2])
        run.ctx[("Virtual-1", D2, None)] = [6, 1]
        e1 = explain(s, fx(1))
        c("unpin: back on one desktop it tiles on Virtual-1/Two with exactly one write; 6 reflows once (trace, explain)",
          e1.get("mode") == "tiled" and r["writes"] == {fx(1): 1, fx(6): 1}, {"mode": e1.get("mode"), "writes": r["writes"]})
        pp = {k: pingpong(v) for k, v in r["kwin"].items() if pingpong(v)}
        c("unpin: no frame goes back to a rectangle it left (listener)", not pp, pp)
        run.view("unpin", D2, None, s.counters())
        errs = s.log_lines(ERRORS, off)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])
        run.lst.close()
    c("facts (recorded, always passes)", True, facts)


# --------------------------------------------------------------------------- two of three desktops
@scenario("membership-two-desktops-T24")
def two_desktops(out: Path, c: Checks):
    """A window on two of three desktops while desktops switch and a peer is sent between them.

    Fixture 1 is on Desktop 1 and Two (shown on both, hidden on Three). Then its membership
    narrows to Three alone (it tiles there, one target, written when Three is shown) and widens
    to Three and Desktop 1 (it floats again where it is; no request)."""
    with Session(out, config={"traceCapacity": 8192}) as s:
        off = s.kw.mark()
        s.js("workspace.createDesktop(1, 'Two'); workspace.createDesktop(2, 'Three'); emit(1)")
        D1, D2, D3 = desk_ids(s)
        name = {D1: "Desktop 1", D2: "Two", D3: "Three"}
        for i in range(1, 6):
            s.spawn(i)
        place(s, {4: {"desktops": [D2]}, 5: {"desktops": [D3]}})
        s.load(); s.settle()
        run = Run(s, c, {("Virtual-0", D1, None): [1, 2, 3], ("Virtual-0", D2, None): [4], ("Virtual-0", D3, None): [5]},
                  range(1, 6))
        r = run.measure(lambda: s.act(fx(1), f"w.desktops = workspace.desktops.filter(d => d.id !== {json.dumps(D3)})"),
                        lambda: sorted(window_state(s)[1]["desktops"]) == sorted([D1, D2]))
        run.ctx[("Virtual-0", D1, None)] = [2, 3]
        e1 = explain(s, fx(1))
        c("two desktops: fixture 1 floats ('on several desktops'), no context",
          e1.get("mode") == "floating" and (e1.get("decision") or {}).get("reason") == "on several desktops"
          and e1.get("context") is None, {"mode": e1.get("mode"), "decision": e1.get("decision")})
        c("two desktops: no request for it; 2 and 3 reflow with one write each (trace)",
          r["writes"] == {fx(2): 1, fx(3): 1} and not r["kwin"].get(fx(1)), r["writes"])
        run.view("two desktops", D1, None, r["counters"])
        multi = {1: s.frames()[fx(1)]["frame"]}
        seen = {D1}
        for k, d in enumerate([D2, D3, D1, D2, D3, D1]):
            r = run.measure(lambda: show_desktop(s, d), lambda: current_desktop(s) == d)
            run.judge_switch(f"switch {k + 1} to {name[d]}", r, [1], d, None, d in seen, multi)
            seen.add(d)

        r = run.measure(lambda: (s.act(fx(1), "workspace.activeWindow = w"), s.cmd("move.desktop-next")),
                        lambda: len(commands(trace(s), "move.desktop-next")) > 0)
        md = commands(r["recs"], "move.desktop-next")
        c("multi: send-to-desktop on it is a no-op ('no other desktop'); membership unchanged; nothing written",
          [x["status"] for x in md] == ["noop"] and md[0].get("reason") == "no other desktop" and not r["writes"]
          and sorted(window_state(s)[1]["desktops"]) == sorted([D1, D2]), {"command": md, "writes": r["writes"]})

        r = run.measure(lambda: (s.act(fx(2), "workspace.activeWindow = w"), s.cmd("move.desktop-next")),
                        lambda: window_state(s)[2]["desktops"] == [D2])
        run.ctx[("Virtual-0", D1, None)] = [3]
        run.ctx[("Virtual-0", D2, None)] = [4, 2]
        c("send 2 to Two while 1 is on both: 3 reflows with one write; no request for 1 (trace, listener)",
          r["writes"] == {fx(3): 1} and not r["kwin"].get(fx(1)), {"writes": r["writes"], "kwin1": r["kwin"].get(fx(1))})
        run.view("send 2 to Two", D1, None, r["counters"])
        r = run.measure(lambda: show_desktop(s, D2), lambda: current_desktop(s) == D2)
        run.judge_switch("show Two after the send", r, [1], D2, None, False, multi)
        c("show Two after the send: 4 and 2 written once each, nothing else (trace)", r["writes"] == {fx(4): 1, fx(2): 1},
          r["writes"])

        # Narrow to Three only (hidden now): it joins Three's context; one write, when Three is shown.
        r = run.measure(lambda: s.act(fx(1), f"w.desktops = workspace.desktops.filter(d => d.id === {json.dumps(D3)})"),
                        lambda: window_state(s)[1]["desktops"] == [D3])
        run.ctx[("Virtual-0", D3, None)] = [5, 1]
        c("narrow to Three: nothing written while Three is hidden (trace, listener)", not r["writes"] and not r["kwin"].get(fx(1)),
          {"writes": r["writes"], "kwin1": r["kwin"].get(fx(1))})
        r = run.measure(lambda: show_desktop(s, D3), lambda: current_desktop(s) == D3)
        e1 = explain(s, fx(1))
        c("narrow to Three: shown, it is tiled there with exactly one write; 5 reflows once (trace, explain)",
          e1.get("mode") == "tiled" and r["writes"] == {fx(1): 1, fx(5): 1} and r["delta"].get("corrections", 0) == 0,
          {"mode": e1.get("mode"), "writes": r["writes"], "delta": r["delta"]})
        pp = {k: pingpong(v) for k, v in r["kwin"].items() if pingpong(v)}
        c("narrow to Three: no frame goes back to a rectangle it left (listener)", not pp, pp)
        run.view("narrow to Three", D3, None, r["counters"])

        # Widen to Three and Desktop 1 while Three is shown: it floats where it is.
        tile1 = s.frames()[fx(1)]["frame"]
        r = run.measure(lambda: s.act(fx(1), f"w.desktops = workspace.desktops.filter(d => d.id !== {json.dumps(D2)})"),
                        lambda: sorted(window_state(s)[1]["desktops"]) == sorted([D1, D3]))
        run.ctx[("Virtual-0", D3, None)] = [5]
        e1 = explain(s, fx(1))
        c("widen to Three and Desktop 1: it floats in place, no request; 5 reflows with one write (trace, oracle)",
          e1.get("mode") == "floating" and r["writes"] == {fx(5): 1} and near(s.frames()[fx(1)]["frame"], tile1, 0.5),
          {"mode": e1.get("mode"), "writes": r["writes"]})
        run.view("widen", D3, None, r["counters"])
        multi = {1: s.frames()[fx(1)]["frame"]}
        for k, d in enumerate([D1, D2, D3, D1]):
            r = run.measure(lambda: show_desktop(s, d), lambda: current_desktop(s) == d)
            run.judge_switch(f"after widening, to {name[d]}", r, [1], d, None, True, multi)
        errs = s.log_lines(ERRORS, off)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])
        run.lst.close()


# --------------------------------------------------------------------------- two of three activities
def need_kamd() -> None:
    if KAMD is None:
        raise Skipped("kactivitymanagerd not found (PATH, /usr/lib, libexec): the scenario needs the activity service")


def current_activity(s: Session) -> str:
    return activity_state(s)["current"]


@scenario("membership-two-activities-T24")
def two_activities(out: Path, c: Checks):
    """A window on two of three activities while activities switch and windows are sent.

    Fixture 1 is on activities A and B (shown on both, hidden on C). Peers are sent between
    desktops; fixture 1 itself is sent to desktop Two by Plastile (it stays on both activities,
    still floating, no request). Then its membership narrows to B alone: it tiles in B's
    context, one write when shown."""
    need_kamd()
    facts: dict = {}
    with Session(out, config={"traceCapacity": 8192}) as s:
        off = s.kw.mark()
        A = start_kamd(s)["current"]
        B = add_activity(s, "Two")
        C = add_activity(s, "Three")
        s.js("workspace.createDesktop(1, 'Two'); emit(1)")
        D1, D2 = desk_ids(s)
        nm = {A: "A", B: "B", C: "C"}
        for i in range(1, 6):
            s.spawn(i)
        place(s, {4: {"activities": [B]}, 5: {"activities": [C]}})
        st = window_state(s)
        c("setup: 1-3 on A, 4 on B, 5 on C (oracle)", [st[i]["activities"] for i in range(1, 6)] == [[A]] * 3 + [[B], [C]], st)
        s.load(); s.settle()
        run = Run(s, c, {("Virtual-0", D1, A): [1, 2, 3], ("Virtual-0", D1, B): [4], ("Virtual-0", D1, C): [5]}, range(1, 6))
        r = run.measure(lambda: s.act(fx(1), f"w.activities = {json.dumps([A, B])}"),
                        lambda: sorted(window_state(s)[1]["activities"]) == sorted([A, B]))
        run.ctx[("Virtual-0", D1, A)] = [2, 3]
        e1 = explain(s, fx(1))
        facts["decision"] = e1.get("decision")
        c("two activities: fixture 1 floats ('on several activities'), no context",
          e1.get("mode") == "floating" and (e1.get("decision") or {}).get("reason") == "on several activities"
          and e1.get("context") is None, {"mode": e1.get("mode"), "decision": e1.get("decision")})
        c("two activities: no request for it; 2 and 3 reflow with one write each (trace)",
          r["writes"] == {fx(2): 1, fx(3): 1} and not r["kwin"].get(fx(1)), r["writes"])
        run.view("two activities", D1, A, r["counters"])
        multi = {1: s.frames()[fx(1)]["frame"]}
        seen = {A}
        for k, a in enumerate([B, C, A, B, C, A]):
            r = run.measure(lambda: request_activity(s, a), lambda: current_activity(s) == a, timeout=10)
            run.judge_switch(f"switch {k + 1} to {nm[a]}", r, [1], D1, a, a in seen, multi)
            seen.add(a)

        # On A: send 2 to desktop Two, then send fixture 1 itself (one desktop, two activities).
        r = run.measure(lambda: (s.act(fx(2), "workspace.activeWindow = w"), s.cmd("move.desktop-next")),
                        lambda: window_state(s)[2]["desktops"] == [D2])
        run.ctx[("Virtual-0", D1, A)] = [3]
        run.ctx[("Virtual-0", D2, A)] = [2]
        c("send 2 to Two on A: 3 reflows with one write; no request for 1 (trace, listener)",
          r["writes"] == {fx(3): 1} and not r["kwin"].get(fx(1)), {"writes": r["writes"], "kwin1": r["kwin"].get(fx(1))})
        r = run.measure(lambda: (s.act(fx(1), "workspace.activeWindow = w"), s.cmd("move.desktop-next")),
                        lambda: window_state(s)[1]["desktops"] == [D2])
        st = window_state(s)[1]
        # Read from the trace, not explain: explain activates the window, and activating a window
        # on a hidden desktop makes KWin show that desktop.
        modes = [x["data"] for x in r["recs"] if x.get("kind") == "mode" and x.get("id") == run.wid[fx(1)]]
        c("send 1 to Two: KWin moves it, it stays on A and B and floating; no request (trace, listener, oracle)",
          sorted(st["activities"]) == sorted([A, B]) and modes and all(m["mode"] == "floating" and m["source"] == "membership"
                                                                       for m in modes)
          and not r["writes"] and not r["kwin"].get(fx(1)), {"state": st, "modes": modes, "writes": r["writes"]})
        r = run.measure(lambda: show_desktop(s, D2), lambda: current_desktop(s) == D2)
        run.judge_switch("show Two on A", r, [1], D2, A, False, multi)
        c("show Two on A: 2 written once (full), nothing else (trace)", r["writes"] == {fx(2): 1}, r["writes"])
        for k, a in enumerate([B, C, A]):
            r = run.measure(lambda: request_activity(s, a), lambda: current_activity(s) == a, timeout=10)
            run.judge_switch(f"on Two, switch to {nm[a]}", r, [1], D2, a, True, multi)

        # Narrow 1 to B (hidden now: A is current): it joins B/Two; one write when B is shown.
        r = run.measure(lambda: s.act(fx(1), f"w.activities = {json.dumps([B])}"),
                        lambda: window_state(s)[1]["activities"] == [B])
        run.ctx[("Virtual-0", D2, B)] = [1]
        c("narrow to B: nothing written while B is hidden (trace, listener)", not r["writes"] and not r["kwin"].get(fx(1)),
          {"writes": r["writes"], "kwin1": r["kwin"].get(fx(1))})
        r = run.measure(lambda: request_activity(s, B), lambda: current_activity(s) == B, timeout=10)
        e1 = explain(s, fx(1))
        c("narrow to B: shown, it is tiled there alone with exactly one write, nothing else (trace, explain)",
          e1.get("mode") == "tiled" and r["writes"] == {fx(1): 1} and r["delta"].get("corrections", 0) == 0,
          {"mode": e1.get("mode"), "writes": r["writes"], "delta": r["delta"]})
        run.view("narrow to B", D2, B, r["counters"])
        r = run.measure(lambda: show_desktop(s, D1), lambda: current_desktop(s) == D1)
        run.judge_switch("B, back to Desktop 1", r, [], D1, B, True, {})
        errs = s.log_lines(ERRORS, off)
        c("no Plastile errors or JS exceptions", not errs, errs[:3])
        run.lst.close()
    c("facts (recorded, always passes)", True, facts)


# --------------------------------------------------------------------------- send racing an activity switch
SAME_TURN_JS = """
// Plastile membership scenario helper (plain JS, nested sessions only): when KWin reports the
// switch to activity %(act)s, send %(cap)s to desktop %(desk)s inside that same signal emission,
// with the adapter's own primitive (Window.desktops = [desktop]). Fires once.
var fired = false;
workspace.currentActivityChanged.connect(function () {
    if (fired || String(workspace.currentActivity) !== %(act)s) return;
    fired = true;
    var w = workspace.windowList().find(function (x) { return x.caption === %(cap)s; });
    var d = workspace.desktops.find(function (x) { return x.id === %(desk)s; });
    w.desktops = [d];
    print("PLT-SAMETURN sent");
});
print("PLT-SAMETURN ready");
"""


@scenario("send-activity-switch-T24")
def send_activity_switch(out: Path, c: Checks):
    """Send a window to another desktop and switch activity in the same event-loop turn, and right after.

    Activities A and B, desktops 1 and Two. On A/Desktop 1: 1, 2 and 3 (3 delays every configure
    ack by 400 ms, so a write to it is outstanding across the switch); 4 on A/Two; 5, 6 on
    B/Desktop 1; 7 on both A and B (KWin reports that as all activities while only two exist; it
    floats, ADR-009). Every context is applied before the race.
    Fixture 2 goes to Two while the view switches to B:

    - same-turn: the send runs inside KWin's currentActivityChanged emission (a helper script),
      so Plastile sees both before it flushes;
    - one-script: one one-shot script sets 2's desktops and requests activity B (KWin forwards
      the request to kactivitymanagerd, so the switch lands later);
    - command-then-switch: Plastile's move.desktop-next shortcut, then the activity request at
      once, without waiting for any effect.

    Documented end state (BEHAVIOR §2, §3; no follow by default): B/Desktop 1 is shown with 5, 6
    untouched; 2 is on A/Two; nothing is written after the switch; returning to A shows 1, 3
    tiled with 3 written once over the whole race; showing Two on A tiles 4, 2. Fixture 7 is
    never written."""
    need_kamd()
    facts: dict = {}
    for case in ("same-turn", "one-script", "command-then-switch"):
        with Session(out / case, config={"traceCapacity": 8192}) as s:
            off = s.kw.mark()
            A = start_kamd(s)["current"]
            B = add_activity(s, "Two")
            s.js("workspace.createDesktop(1, 'Two'); emit(1)")
            D1, D2 = desk_ids(s)
            s.spawn(1); s.spawn(2); s.spawn(3, "--configure-delay-ms", "400")
            for i in (4, 5, 6, 7):
                s.spawn(i)
            place(s, {4: {"desktops": [D2]}, 5: {"activities": [B]}, 6: {"activities": [B]}, 7: {"activities": [A, B]}})
            s.load(); s.settle(timeout=6)
            # Apply every context once: B/Desktop 1 and A/Two are hidden at load.
            request_activity(s, B); until(lambda: current_activity(s) == B, 10); s.settle(timeout=6)
            request_activity(s, A); until(lambda: current_activity(s) == A, 10); s.settle(timeout=6)
            show_desktop(s, D2); until(lambda: current_desktop(s) == D2); s.settle(timeout=6)
            show_desktop(s, D1); until(lambda: current_desktop(s) == D1); s.settle(timeout=6)
            run = Run(s, c, {("Virtual-0", D1, A): [1, 2, 3], ("Virtual-0", D2, A): [4], ("Virtual-0", D1, B): [5, 6]},
                      range(1, 8))
            st = window_state(s)
            facts[f"{case}.activitiesOf7"] = st[7]["activities"]
            c(f"{case}: setup placed (oracle; with two activities KWin reports 7's [A, B] as [], all activities)",
              [sorted(st[i]["activities"]) for i in range(1, 7)] == [[A]] * 4 + [[B], [B]]
              and sorted(st[7]["activities"]) in ([], sorted([A, B])) and [st[i]["desktops"] for i in range(1, 8)] == [[D1]] * 3 + [[D2]] + [[D1]] * 3, st)
            e7 = explain(s, fx(7))
            c(f"{case}: 7 floats ('on several activities')", e7.get("mode") == "floating", e7.get("decision"))
            s.act(fx(2), "workspace.activeWindow = w")
            run.view(f"{case}: before", D1, A, s.counters())
            f0 = s.frames()
            keepB = {i: f0[fx(i)]["frame"] for i in (5, 6, 7)}
            t0 = last_trace_t(s)
            mark = s.kw.mark()
            a = s.counters()
            if case == "same-turn":
                helper = s.kw.root / "plt-sameturn.js"
                helper.write_text(SAME_TURN_JS % {"act": json.dumps(B), "cap": json.dumps(fx(2)), "desk": json.dumps(D2)})
                hoff = s.kw.mark()
                s.kw.load_script(helper, "plt-sameturn")
                s.kw.wait_log(r"PLT-SAMETURN ready", 5, hoff)
                request_activity(s, B)
            elif case == "one-script":
                s.js(f"const w = workspace.windowList().find(x => x.caption === {json.dumps(fx(2))});"
                     f" w.desktops = [workspace.desktops.find(d => d.id === {json.dumps(D2)})];"
                     f" workspace.currentActivity = {json.dumps(B)}; emit(1)")
            else:
                s.cmd("move.desktop-next")
                request_activity(s, B)
            landed = until(lambda: current_activity(s) == B and window_state(s)[2]["desktops"] == [D2], 10)
            time.sleep(1.0)  # past the 400 ms delayed ack and the 750 ms request deadline: late leftovers would show
            b = s.settle(timeout=6, quiet=0.3)
            if case == "same-turn":
                fired = s.log_lines(r"PLT-SAMETURN sent", hoff)
                s.kw.unload("plt-sameturn")
            recs = trace_since(trace(s), t0)
            vis = [k for k, x in enumerate(recs) if x.get("kind") == "visibility"]
            mode2 = [k for k, x in enumerate(recs) if x.get("kind") == "mode" and x.get("id") == run.wid[fx(2)]]
            before, after = (recs[:vis[0]], recs[vis[0]:]) if vis else (recs, [])
            wb, wa = by_caption(before, run.wid), by_caption(after, run.wid)
            between = [x["kind"] for x in recs[min(vis[:1] + mode2[:1]):max(vis[:1] + mode2[:1]) + 1]] if vis and mode2 else None
            st = window_state(s)
            facts[case] = {"order": "send first" if mode2 and vis and mode2[0] < vis[0] else "switch first" if mode2 and vis else None,
                           "between": between, "writesBeforeSwitch": wb, "writesAfterSwitch": wa, "delta": delta(a, b),
                           "visibilityRecords": len(vis),
                           "kwinFrames": {k: len(v) for k, v in kwin_frames(run.lst, mark).items()}}
            # Same-turn: both handlers run inside one emission; which of the two scripts KWin calls
            # first is recorded ("order"), not assumed.
            c(f"{case}: end state: B and Desktop 1 shown (no follow), 2 on A/Two (oracle)",
              landed and current_activity(s) == B and current_desktop(s) == D1 and st[2]["desktops"] == [D2]
              and st[2]["activities"] == [A], {"current": activity_state(s), "desktop": current_desktop(s), "2": st[2]})
            c(f"{case}: KWin reported the switch to Plastile (trace visibility record)", bool(vis), facts[case])
            if case == "same-turn":
                c("same-turn: the helper sent 2 inside KWin's currentActivityChanged emission (log)", len(fired) == 1, fired)
                c("same-turn: the send and the switch reached Plastile with no flush work between them (trace)",
                  between is not None and not any(k in ("solve", "write") for k in between), between)
                c("same-turn: nothing written at all: the source context was hidden by the time Plastile flushed (trace)",
                  not wb and not wa, {"before": wb, "after": wa})
            else:
                c(f"{case}: before the switch at most the source reflow (3 once) was written (trace)",
                  wb in ({}, {fx(3): 1}), wb)
            c(f"{case}: no write after the switch, no corrections (trace)", not wa and delta(a, b).get("corrections", 0) == 0,
              {"after": wa, "delta": delta(a, b)})
            race_kw = kwin_frames(run.lst, mark)
            un = unrecorded(race_kw, {**wb, **wa})
            c(f"{case}: over the race KWin changed only frames Plastile wrote, each to one rectangle (listener vs trace)",
              not un, {"kwin": race_kw, "writes": {"before": wb, "after": wa}})
            f1 = s.frames()
            c(f"{case}: B's windows and the multi-activity window untouched (oracle)",
              all(near(f1[fx(i)]["frame"], keepB[i], 0.5) for i in (5, 6, 7)), {i: f1[fx(i)]["frame"] for i in (5, 6, 7)})
            run.ctx[("Virtual-0", D1, A)] = [1, 3]
            run.ctx[("Virtual-0", D2, A)] = [4, 2]
            run.view(f"{case}: on B", D1, B, b)
            race = wb
            # Back to A: Desktop 1 shows 1 and 3; 3 is written now only if it was not before the switch.
            r = run.measure(lambda: request_activity(s, A), lambda: current_activity(s) == A, timeout=10)
            run.judge_switch(f"{case}: back to A", r, [7], D1, A, False, keepB)
            total3 = race.get(fx(3), 0) + r["writes"].get(fx(3), 0)
            c(f"{case}: over the race and the return, 3 is written exactly once and 1 never (its slot is unchanged) (trace)",
              total3 == 1 and not race.get(fx(1)) and not r["writes"].get(fx(1)) and set(r["writes"]) <= {fx(3)},
              {"race": race, "return": r["writes"]})
            r = run.measure(lambda: show_desktop(s, D2), lambda: current_desktop(s) == D2)
            run.judge_switch(f"{case}: Two on A", r, [7], D2, A, False, keepB)
            c(f"{case}: Two on A: 4 and 2 written once each, nothing else (trace)", r["writes"] == {fx(4): 1, fx(2): 1},
              r["writes"])
            r = run.measure(lambda: request_activity(s, B), lambda: current_activity(s) == B, timeout=10)
            run.judge_switch(f"{case}: B again (Two)", r, [7], D2, B, True, keepB)
            errs = s.log_lines(ERRORS, off)
            c(f"{case}: no Plastile errors or JS exceptions", not errs, errs[:3])
            run.lst.close()
    c("facts (recorded, always passes)", True, facts)
