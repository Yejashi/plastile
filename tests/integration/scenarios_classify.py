"""T16 classification scenarios: built-in exclusions/floating helpers, title-glob rules, border rules (Q10).

Geometry and decoration state come from the independent oracle (one-shot KWin scripts:
frameGeometry, noBorder). Plastile's counters and trace are used only for work-amount
gates (writes per window id); `inspect.explain-window` is read for the recorded decision.
"""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from harness import FIXTURE, Fixture, Session, delta, near, tiling_errors  # noqa: F401
from scenarios import Checks, scenario, three

EVIDENCE: dict[str, dict] = {}

# Single-line JSON without backslashes: written verbatim into kwinrc, so no KConfig escaping applies.
FLOAT_TWO = json.dumps({"schemaVersion": 1, "rules": [
    {"id": "float-two", "match": {"title": {"glob": "plastile-fixture 2*"}}, "actions": {"mode": "floating"}}]},
    separators=(",", ":"))
NO_BORDERS = json.dumps({"schemaVersion": 1, "rules": [
    {"id": "no-borders", "match": {"appId": "plastile-fixture"}, "actions": {"border": "none"}}]},
    separators=(",", ":"))


def spawn_app(s: Session, ident: int, app_id: str, *args: str) -> Fixture:
    """Fixture client with a non-default app id (Session.spawn's oracle only lists plastile-fixture)."""
    log = s.out / f"fixture-{ident}.jsonl"
    proc = s.kw.spawn([str(FIXTURE), "--ssd", "--id", str(ident), "--app-id", app_id, *args], stdout=open(log, "w"),
                      stdin=subprocess.PIPE)
    fx = Fixture(proc, ident, log)
    s.fixtures[ident] = fx
    s.wait_for(lambda: any(f["caption"] == fx.caption for f in s.kw.fixtures(app_id)), 5, f"map {fx.caption}")
    return fx


def frame_of(s: Session, app_id: str, caption: str) -> dict:
    return next(f for f in s.kw.fixtures(app_id) if f["caption"] == caption)


def explain(s: Session, caption: str) -> dict:
    s.act(caption, "workspace.activeWindow = w")
    time.sleep(0.1)
    off = s.kw.mark()
    s.cmd("inspect.explain-window")
    line = s.kw.wait_log(r"plastile info explain ", 5, off)[-1]
    return json.loads(line.split("plastile info explain ", 1)[1])


def brief(e: dict | None) -> dict | None:
    if not isinstance(e, dict):
        return e
    return {k: e.get(k) for k in ("appId", "kind", "mode", "userMode", "decision", "exception") if k in e}


def writes_by_id(s: Session) -> dict[str, int]:
    """Per-window write counts from Plastile's own trace (work-amount only, not geometry)."""
    off = s.kw.mark()
    s.cmd("inspect.dump-trace")
    line = s.kw.wait_log(r"plastile trace ", 5, off)[-1]
    out: dict[str, int] = {}
    for r in json.loads(line.split("plastile trace ", 1)[1]):
        if r.get("kind") == "write" and r.get("id") is not None:
            out[r["id"]] = out.get(r["id"], 0) + 1
    return out


def save(out: Path, name: str) -> None:
    """Raw per-scenario summary next to kwin.log (artifacts/, local only)."""
    (out / "evidence.json").write_text(json.dumps(EVIDENCE.get(name), indent=1))


def rejected(s: Session) -> list[str]:
    return s.log_lines(r"plastile (error|warn) configuration")


@scenario("classify-builtin-T16")
def classify_builtin(out: Path, c: Checks):
    """org.kde.krunner is excluded (never moved, zero writes); xdg-desktop-portal-kde floats."""
    with Session(out) as s:
        spawn_app(s, 9, "org.kde.krunner")
        spawn_app(s, 8, "xdg-desktop-portal-kde")
        kr0 = frame_of(s, "org.kde.krunner", "plastile-fixture 9")
        po0 = frame_of(s, "xdg-desktop-portal-kde", "plastile-fixture 8")
        s.load()
        c0 = s.settle()
        c("load with only krunner + portal: zero writes, zero solves",
          c0["counters"]["writes"] == 0 and c0["counters"]["solves"] == 0, c0["counters"])
        kr1 = frame_of(s, "org.kde.krunner", "plastile-fixture 9")
        po1 = frame_of(s, "xdg-desktop-portal-kde", "plastile-fixture 8")
        c("krunner frame unchanged by load", near(kr1["frame"], kr0["frame"]), [kr0["frame"], kr1["frame"]])
        c("portal frame unchanged by load", near(po1["frame"], po0["frame"]), [po0["frame"], po1["frame"]])

        s.spawn(1); s.spawn(2)
        c1 = s.settle()
        a = s.area()
        f = s.frames_list()
        c("ordinary fixtures tile beside the excluded/floating windows", len(f) == 2 and not tiling_errors(f, a, 8),
          tiling_errors(f, a, 8))
        c("tiled pair fills the area width (krunner/portal do not take slots)",
          abs(sum(x["frame"]["width"] for x in f) - (a["width"] - 24)) <= 2, [x["frame"] for x in f])
        kr2 = frame_of(s, "org.kde.krunner", "plastile-fixture 9")
        po2 = frame_of(s, "xdg-desktop-portal-kde", "plastile-fixture 8")
        c("krunner frame unchanged after neighbours opened", near(kr2["frame"], kr0["frame"]), kr2["frame"])
        c("portal frame unchanged after neighbours opened", near(po2["frame"], po0["frame"]), po2["frame"])

        # A user move of either window is not fought.
        s.act("plastile-fixture 9", "w.frameGeometry = {x: 50, y: 60, width: 420, height: 310}")
        s.act("plastile-fixture 8", "w.frameGeometry = {x: 600, y: 300, width: 410, height: 320}")
        time.sleep(0.5)
        c2 = s.settle()
        kr3 = frame_of(s, "org.kde.krunner", "plastile-fixture 9")
        po3 = frame_of(s, "xdg-desktop-portal-kde", "plastile-fixture 8")
        c("user move of krunner/portal: not corrected, no writes",
          near(kr3["frame"], {"x": 50, "y": 60, "width": 420, "height": 310}, 1.0)
          and near(po3["frame"], {"x": 600, "y": 300, "width": 410, "height": 320}, 1.0)
          and delta(c1, c2).get("writes", 0) == 0, {"krunner": kr3["frame"], "portal": po3["frame"], "delta": delta(c1, c2)})

        # Late-opened excluded window: the open path classifies it too.
        spawn_app(s, 7, "org.kde.krunner")
        k70 = frame_of(s, "org.kde.krunner", "plastile-fixture 7")
        c3 = s.settle()
        time.sleep(0.3)
        k71 = frame_of(s, "org.kde.krunner", "plastile-fixture 7")
        c("late krunner: frame unchanged, no writes, tiled pair untouched",
          near(k70["frame"], k71["frame"]) and delta(c2, c3).get("writes", 0) == 0, {"delta": delta(c2, c3)})

        wb = writes_by_id(s)
        ids = {"krunner9": kr0["id"], "portal8": po0["id"], "krunner7": k70["id"]}
        c("trace: zero writes for krunner and portal window ids", all(wb.get(i, 0) == 0 for i in ids.values()),
          {k: wb.get(v, 0) for k, v in ids.items()})
        c("trace: writes recorded for the tiled fixtures (trace is live)",
          sum(wb.get(x["id"], 0) for x in f) >= 2, {x["caption"]: wb.get(x["id"], 0) for x in f})

        ek = explain(s, "plastile-fixture 9")
        ep = explain(s, "plastile-fixture 8")
        c("explain krunner: excluded, builtin", ek.get("mode") == "excluded"
          and (ek.get("decision") or {}).get("source") == "builtin", brief(ek))
        c("explain portal: floating, builtin", ep.get("mode") == "floating"
          and (ep.get("decision") or {}).get("source") == "builtin", brief(ep))
        e1 = explain(s, "plastile-fixture 1")
        c("explain fixture 1: tiled by default", e1.get("mode") == "tiled"
          and (e1.get("decision") or {}).get("source") == "default", brief(e1))
        cz = s.counters()
        c("no model errors", cz["counters"]["errors"] == 0, cz["counters"]["errors"])
        EVIDENCE["classify-builtin-T16"] = {"explainKrunner": brief(ek), "explainPortal": brief(ep),
                                            "explainTiled": brief(e1), "writesByWindow": {k: wb.get(v, 0) for k, v in ids.items()},
                                            "loadCounters": {k: c0["counters"][k] for k in ("writes", "solves")}}
        save(out, "classify-builtin-T16")


@scenario("classify-rule-title-T16")
def classify_rule_title(out: Path, c: Checks):
    """configJson title glob 'plastile-fixture 2*' -> floating: 2 floats while 1 and 3 tile."""
    with Session(out, config={"configJson": FLOAT_TWO}) as s:
        three(s)
        pre = s.frames()
        s.load()
        s.settle()
        c("configuration accepted (no rejection/warnings)", not rejected(s), rejected(s))
        a = s.area()
        fr = s.frames()
        tiled = [fr["plastile-fixture 1"], fr["plastile-fixture 3"]]
        c("fixtures 1 and 3 tile without overlap", not tiling_errors(tiled, a, 8), tiling_errors(tiled, a, 8))
        c("fixtures 1 and 3 split the area width (2 holds no slot)",
          abs(sum(x["frame"]["width"] for x in tiled) - (a["width"] - 24)) <= 2, [x["frame"] for x in tiled])
        c("fixture 2 floats: frame unchanged by load", near(fr["plastile-fixture 2"]["frame"], pre["plastile-fixture 2"]["frame"]),
          [pre["plastile-fixture 2"]["frame"], fr["plastile-fixture 2"]["frame"]])
        wb = writes_by_id(s)
        c("trace: zero writes for fixture 2", wb.get(fr["plastile-fixture 2"]["id"], 0) == 0,
          {k: wb.get(v["id"], 0) for k, v in fr.items()})
        e2 = explain(s, "plastile-fixture 2")
        d2 = e2.get("decision") or {}
        c("explain 2: floating by rule with ruleIds ['float-two']",
          e2.get("mode") == "floating" and d2.get("source") == "rule" and d2.get("ruleIds") == ["float-two"], brief(e2))
        e1 = explain(s, "plastile-fixture 1")
        c("explain 1: tiled by default, no ruleIds", e1.get("mode") == "tiled"
          and (e1.get("decision") or {}).get("ruleIds") == [], brief(e1))

        # Title rules are re-evaluated on title change (titleRules=true): 3 -> '...2b' floats; 2 -> '...x' tiles.
        s.fixtures[3].send("title plastile-fixture 2b")
        s.wait_for(lambda: "plastile-fixture 2b" in s.frames(), 5, "retitle 3")
        s.settle()
        s.fixtures[2].send("title plastile-fixture x2")
        s.wait_for(lambda: "plastile-fixture x2" in s.frames(), 5, "retitle 2")
        s.settle()
        fr2 = s.frames()
        e3 = explain(s, "plastile-fixture 2b")
        ex = explain(s, "plastile-fixture x2")
        tiled2 = [fr2["plastile-fixture 1"], fr2["plastile-fixture x2"]]
        c("retitle: former 3 now floats by rule", e3.get("mode") == "floating"
          and (e3.get("decision") or {}).get("ruleIds") == ["float-two"], brief(e3))
        c("retitle: former 2 now tiles by default", ex.get("mode") == "tiled", brief(ex))
        c("retitle: 1 and x2 tile without overlap", not tiling_errors(tiled2, a, 8), tiling_errors(tiled2, a, 8))
        cz = s.counters()
        c("no model errors", cz["counters"]["errors"] == 0, cz["counters"]["errors"])
        EVIDENCE["classify-rule-title-T16"] = {"rule": json.loads(FLOAT_TWO), "explainFloating": brief(e2),
                                               "explainTiled": brief(e1), "explainRetitledFloating": brief(e3),
                                               "explainRetitledTiled": brief(ex)}
        save(out, "classify-rule-title-T16")


@scenario("classify-rule-border-Q10-T16")
def classify_rule_border(out: Path, c: Checks):
    """Rule border 'none': noBorder true while tiled, restored after unload; user changes are kept (Q10)."""
    with Session(out, config={"configJson": NO_BORDERS}) as s:
        three(s)
        # User removed fixture 3's border before Plastile started: Plastile must not "restore" it on unload.
        s.act("plastile-fixture 3", "w.noBorder = true")
        pre = s.frames()
        c("pre-load: 1 and 2 decorated, 3 user-borderless",
          not pre["plastile-fixture 1"]["noBorder"] and not pre["plastile-fixture 2"]["noBorder"]
          and pre["plastile-fixture 3"]["noBorder"], {k: v["noBorder"] for k, v in pre.items()})
        s.load()
        s.settle()
        c("configuration accepted (no rejection/warnings)", not rejected(s), rejected(s))
        fr = s.frames()
        a = s.area()
        c("tiled: all three noBorder true", all(v["noBorder"] for v in fr.values()), {k: v["noBorder"] for k, v in fr.items()})
        c("tiled: no overlap", not tiling_errors(list(fr.values()), a, 8), tiling_errors(list(fr.values()), a, 8))

        e1 = explain(s, "plastile-fixture 1")
        text = json.dumps(e1)
        c("explain 1 output contains the border rule id 'no-borders'", "no-borders" in text, brief(e1))

        # During the session the user restores fixture 2's border; Plastile must not fight it.
        c0 = s.counters()
        s.act("plastile-fixture 2", "w.noBorder = false")
        time.sleep(0.4)
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        s.cmd("resize.grow"); s.settle()
        s.cmd("resize.shrink"); s.settle()
        time.sleep(0.3)
        fr2 = s.frames()
        c1 = s.counters()
        c("user border change on 2 kept through solves", fr2["plastile-fixture 2"]["noBorder"] is False,
          {k: v["noBorder"] for k, v in fr2.items()})
        c("solves ran after the user change (the check exercised the engine)", delta(c0, c1).get("solves", 0) >= 2,
          delta(c0, c1))

        # Floating a tiled window restores its border; tiling it again re-applies the rule.
        s.act("plastile-fixture 1", "workspace.activeWindow = w")
        s.cmd("window.toggle-float"); s.settle()
        f_float = s.frames()["plastile-fixture 1"]["noBorder"]
        s.cmd("window.toggle-float"); s.settle()
        f_tiled = s.frames()["plastile-fixture 1"]["noBorder"]
        c("toggle-float: border restored while floating, removed again when re-tiled",
          f_float is False and f_tiled is True, {"floating": f_float, "tiled": f_tiled})

        s.unload()
        time.sleep(0.3)
        post = s.frames()
        nb = {k: v["noBorder"] for k, v in post.items()}
        c("unload: fixture 1 border restored (noBorder false)", nb.get("plastile-fixture 1") is False, nb)
        c("unload: fixture 2 keeps the user's in-session change (false)", nb.get("plastile-fixture 2") is False, nb)
        c("Q10 unload: fixture 3 keeps the user's pre-load noBorder true (not clobbered)",
          nb.get("plastile-fixture 3") is True, nb)
        EVIDENCE["classify-rule-border-Q10-T16"] = {
            "rule": json.loads(NO_BORDERS), "preLoad": {k: v["noBorder"] for k, v in pre.items()},
            "tiled": {k: v["noBorder"] for k, v in fr.items()}, "afterUserChange": {k: v["noBorder"] for k, v in fr2.items()},
            "toggleFloat": {"floating": f_float, "retiled": f_tiled}, "afterUnload": nb, "explain": brief(e1)}
        save(out, "classify-rule-border-Q10-T16")
