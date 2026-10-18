"""Native tile coexistence scenarios (TEST_MATRIX L13/L14) with the production package.

Three fixture windows are tiled by Plastile (direct-geometry backend). The scenarios then
use KWin's own native tiling surface the way a user or another script would:

  a) edit the native root tile tree (split, resize, remove) through a one-shot script;
  b) associate a Plastile-tiled window with a native tile (Tile.manage), then release it
     (Tile.unmanage), then re-adopt it with window.adopt-native;
  c) toggle KWin's tiles editor ("Edit Tiles" kglobalaccel action) on and off;
  d) quick-tile left twice, then window.toggle-float repeatedly;
  e) window.adopt-native on an ordinary tiled window.

Geometry is judged by the oracle (one-shot KWin scripts reading real window state).
Plastile counters gate the amount of work; `inspect.explain-window` is read only to record
the placement decision (mode, nativeTile flag). A small observer script (plain KWin JS,
not Plastile) logs every `Window.tileChanged` emission so the signal behaviour of
manage/unmanage is measured directly.

Each scenario merges a redacted summary into docs/status/evidence/native-l14.json.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

from harness import ROOT, Session, delta, evidence_file, near, tiling_errors
from scenarios import Checks, Skipped, scenario, three

EVIDENCE = evidence_file("native-l14.json")
GAP = 8
ERR = r"plastile (error|warn)|TypeError|ReferenceError"
UUID = re.compile(r"\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?")
ROOT_JS = "const o = workspace.screens[0]; const root = workspace.rootTile(o, workspace.currentDesktopForScreen(o));\n"
TREE_JS = ("function d(t) { const g = t.relativeGeometry; return {rel: [g.x, g.y, g.width, g.height], dir: t.layoutDirection,"
           " windows: t.windows.length, tiles: t.tiles.map(d)}; }\n")
EDITOR_ACTION = "Edit Tiles"
F1, F2, F3 = "plastile-fixture 1", "plastile-fixture 2", "plastile-fixture 3"


# ------------------------------------------------------------------- helpers
def frames(s: Session) -> dict[str, dict]:
    return {k: v["frame"] for k, v in s.frames().items()}


def same(a: dict, b: dict, tol: float = 0.5) -> bool:
    return a.keys() == b.keys() and all(near(a[k], b[k], tol) for k in a)


def tree(s: Session):
    return json.loads(s.js(ROOT_JS + TREE_JS + "emit(d(root));")[0])


def explain(s: Session, caption: str) -> dict:
    s.act(caption, "workspace.activeWindow = w")
    off = s.kw.mark()
    s.cmd("inspect.explain-window")
    line = s.kw.wait_log(r"plastile info explain ", 5, off)[-1]
    return json.loads(line.split("plastile info explain ", 1)[1])


def brief(e: dict) -> dict:
    return {"mode": e.get("mode"), "userMode": e.get("userMode"), "nativeTile": e.get("nativeTile"),
            "slot": e.get("slot"), "ledger": (e.get("ledger") or {}).get("status")}


def effects(s: Session) -> list[str]:
    r = s.kw.call("/Effects", "org.freedesktop.DBus.Properties", "Get", "ss", "org.kde.kwin.Effects", "activeEffects")
    return list(r[0]["data"])


def errors(s: Session, off: int = 0) -> list[str]:
    return s.log_lines(ERR, off)


def three_tiled(s: Session) -> list[str]:
    f = s.frames_list()
    return (["expected 3 windows"] if len(f) != 3 else []) + tiling_errors(f, s.area(), GAP) + \
        [x["caption"] + " has a native tile" for x in f if x["tile"]]


def two_full_height(s: Session, a: str, b: str) -> bool:
    f = s.frames()
    pair = [f[a], f[b]]
    return not tiling_errors(pair, s.area(), GAP) and all(x["frame"]["height"] > 700 for x in pair)


def start_observer(s: Session) -> int:
    """Plain KWin JS observer: log each tileChanged of a fixture window (not Plastile code)."""
    path = s.kw.root / "plt-tile-observer.js"
    path.write_text(
        "workspace.windowList().filter(w => w.resourceClass === 'plastile-fixture').forEach(w => {\n"
        "  w.tileChanged.connect(() => print('PLT-TC ' + w.caption + ' ' + (w.tile !== null)));\n"
        "});\nprint('PLT-TC-READY');\n")
    off = s.kw.mark()
    s.kw.load_script(path, "plt-tile-observer")
    s.kw.wait_log(r"PLT-TC-READY", 5, off)
    return off


def stop_observer(s: Session) -> None:
    try:
        if s.kw.is_loaded("plt-tile-observer"):
            s.kw.unload("plt-tile-observer")
    except Exception:
        pass


def record(name: str, data: dict, out: Path, c: Checks) -> None:
    data = json.loads(UUID.sub("<id>", json.dumps(data)))
    data = {"layer": "nested KWin virtual backend (not physical)", "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "run": out.parent.name, "checks": {k: v["pass"] for k, v in c.items.items()}, **data}
    (out / "facts.json").write_text(json.dumps(data, indent=1))
    try:
        ev = json.loads(EVIDENCE.read_text())
    except (OSError, ValueError):
        ev = {}
    kwin = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
    ev.setdefault("what", "L13/L14 native tile coexistence with the production package (tests/integration/scenarios_native.py)")
    ev["kwin"] = kwin
    ev.setdefault("scenarios", {})[name] = data
    EVIDENCE.write_text(json.dumps(ev, indent=1) + "\n")


def started(s: Session) -> None:
    three(s)
    s.load()
    s.settle()


# ------------------------------------------------------------------ scenarios
@scenario("native-tree-edit-L14")
def native_tree_edit(out: Path, c: Checks):
    """(a) Editing the native root tile tree must not move Plastile-tiled windows."""
    with Session(out) as s:
        started(s)
        c("setup: three tiled", not three_tiled(s), three_tiled(s))
        f0, t0, c0, off = frames(s), tree(s), s.counters(), s.kw.mark()
        split = s.js(ROOT_JS + "const r = root.split(1); emit({returned: r === null || r === undefined ? null : typeof r,"
                     " children: root.tiles.length});")
        t1 = tree(s)
        s.js(ROOT_JS + "root.tiles[0].relativeGeometry = {x: 0, y: 0, width: 0.3, height: 1}; emit(1);")
        t2 = tree(s)
        rm = s.js(ROOT_JS + "const t = root.tiles[root.tiles.length - 1]; const can = t.canBeRemoved; t.remove();"
                  " emit({canBeRemoved: can, children: root.tiles.length});")
        t3 = tree(s)
        time.sleep(1.0)
        c1 = s.settle()
        f1 = frames(s)
        d = delta(c0, c1)
        c("a: native tree actually changed (split, resize, remove)", t1 != t0 and t2 != t1 and t3 != t2,
          {"before": len(t0["tiles"]), "split": len(t1["tiles"]), "removed": len(t3["tiles"])})
        c("a: Plastile-tiled windows did not move (oracle)", same(f0, f1), {"before": f0, "after": f1})
        c("a: no Plastile writes, solves or corrections", not any(d.get(k, 0) for k in ("writes", "solves", "corrections")), d)
        c("a: no window gained a native tile", all(not x["tile"] for x in s.frames_list()))
        c("a: Plastile errors counter 0 and no warnings logged", c1["counters"]["errors"] == 0 and not errors(s, off),
          errors(s, off)[:3])
        ex = {k: brief(explain(s, k)) for k in (F1, F2, F3)}
        c("a: explain: all still tiled, nativeTile false", all(e["mode"] == "tiled" and not e["nativeTile"] for e in ex.values()), ex)
        record("native-tree-edit-L14", {"treeBefore": t0, "afterSplit": t1, "afterResize": t2, "afterRemove": t3,
                                        "splitResult": json.loads(split[0]), "removeResult": json.loads(rm[0]),
                                        "counterDelta": d, "explain": ex}, out, c)


@scenario("native-manage-L14")
def native_manage(out: Path, c: Checks):
    """(b) Tile.manage on a Plastile-tiled window yields; Tile.unmanage does not re-adopt."""
    with Session(out) as s:
        started(s)
        try:
            obs_off = start_observer(s)
            pre = frames(s)
            ex0 = brief(explain(s, F2))
            c0, off = s.counters(), s.kw.mark()
            m = json.loads(s.js(
                ROOT_JS + f"const w = workspace.windowList().find(x => x.caption === {json.dumps(F2)});\n"
                "const t = root.tiles[0]; print('PLT-MARK manage-begin');\nconst r = t.manage(w);\n"
                "print('PLT-MARK manage-end');\nconst g = t.absoluteGeometry;\n"
                "emit({returned: r, hasTileSync: w.tile !== null, sameTile: w.tile === t, padding: t.padding,"
                " tile: {x: g.x, y: g.y, width: g.width, height: g.height}});")[0])
            time.sleep(1.0)
            c1 = s.settle()
            f = frames(s)
            q, tg, pad = f[F2], m["tile"], m["padding"]
            inside = (q["x"] >= tg["x"] - 0.5 and q["y"] >= tg["y"] - 0.5 and q["x"] + q["width"] <= tg["x"] + tg["width"] + 0.5
                      and q["y"] + q["height"] <= tg["y"] + tg["height"] + 0.5)
            hugs = (abs(q["x"] - tg["x"]) <= pad + 1 and abs(q["y"] - tg["y"]) <= pad + 1 and
                    abs(tg["x"] + tg["width"] - q["x"] - q["width"]) <= pad + 1 and
                    abs(tg["y"] + tg["height"] - q["y"] - q["height"]) <= pad + 1)
            c("b: manage() returned true and set w.tile synchronously", m["returned"] is True and m["hasTileSync"] and m["sameTile"], m)
            c("b: fixture 2 takes the native tile geometry (oracle, within padding)", inside and hugs, {"frame": q, "tile": tg, "padding": pad})
            c("b: peers retile as two full-height tiles", two_full_height(s, F1, F3), {k: f[k] for k in (F1, F3)})
            d = delta(c0, c1)
            c("b: yield costs one solve and at most two writes (peers), no corrections",
              d.get("solves", 0) == 1 and d.get("writes", 0) <= 2 and d.get("corrections", 0) == 0, d)
            ex1 = brief(explain(s, F2))
            c("b: explain mode native, nativeTile true", ex1["mode"] == "native" and ex1["nativeTile"] is True, ex1)
            time.sleep(1.5)
            c2 = s.counters()
            c("b: native tile not fought afterwards (no writes in 1.5 s, frame unchanged)",
              delta(c1, c2).get("writes", 0) == 0 and near(frames(s)[F2], q, 0.5), delta(c1, c2))

            # ---- user releases the native tile
            u = json.loads(s.js(
                f"const w = workspace.windowList().find(x => x.caption === {json.dumps(F2)});\n"
                "print('PLT-MARK unmanage-begin');\nconst r = w.tile ? w.tile.unmanage(w) : 'no tile';\n"
                "print('PLT-MARK unmanage-end');\nemit({returned: r, hasTileSync: w.tile !== null});")[0])
            time.sleep(1.0)
            c3 = s.settle()
            fu = frames(s)
            ex2 = brief(explain(s, F2))
            du = delta(c2, c3)
            c("b: unmanage() returned true and cleared w.tile synchronously", u["returned"] is True and not u["hasTileSync"], u)
            c("b: unmanage: no Plastile write (no snap back into the layout)",
              du.get("writes", 0) == 0 and du.get("solves", 0) == 0, du)
            c("b: unmanage: still yielded (mode native, nativeTile false, no slot)",
              ex2["mode"] == "native" and ex2["nativeTile"] is False and ex2["slot"] is None, ex2)
            c("b: unmanage: peers keep the two-tile layout", near(fu[F1], f[F1], 0.5) and near(fu[F3], f[F3], 0.5),
              {k: fu[k] for k in (F1, F3)})
            # Where the window ends up is KWin's decision (recorded): Plastile wrote nothing.
            kwin_restored_pre = near(fu[F2], pre[F2], 0.5)
            # An unrelated peer solve must not pull the released window back in.
            s.act(F1, "workspace.activeWindow = w")
            s.cmd("resize.grow")
            time.sleep(0.6)
            c4 = s.settle()
            fg = frames(s)
            dg = delta(c3, c4)
            c("b: peer resize solve leaves the released window alone", near(fg[F2], fu[F2], 0.5) and dg.get("solves", 0) == 1,
              {"frame": fg[F2], "delta": dg})
            time.sleep(1.5)
            c5 = s.counters()
            c("b: released window stays put (1.5 s, no writes)", near(frames(s)[F2], fu[F2], 0.5) and delta(c4, c5).get("writes", 0) == 0,
              delta(c4, c5))
            s.cmd("resize.shrink")
            s.settle()

            # ---- explicit re-adoption
            s.act(F2, "workspace.activeWindow = w")
            off2 = s.kw.mark()
            s.cmd("window.adopt-native")
            time.sleep(0.6)
            c6 = s.settle()
            ex3 = brief(explain(s, F2))
            c("b: adopt-native retiles three (oracle)", not three_tiled(s), three_tiled(s))
            c("b: adopt-native: explain tiled, nativeTile false", ex3["mode"] == "tiled" and not ex3["nativeTile"], ex3)
            c("b: adopt-native: one solve, no corrections", delta(c5, c6).get("solves", 0) >= 1 and delta(c5, c6).get("corrections", 0) == 0,
              delta(c5, c6))
            c("b: no Plastile errors/warnings", c6["counters"]["errors"] == 0 and not errors(s, off), errors(s, off)[:3])

            # ---- measured tileChanged emissions and their order relative to the calls
            lines = [ln.split(" ", 2)[-1] for ln in s.log_lines(r"PLT-TC |PLT-MARK ", obs_off)]
            lines = [re.sub(r"^.*?(PLT-)", r"\1", ln) for ln in lines]

            def between(a: str, b: str) -> list[str]:
                i, j = lines.index(a), lines.index(b)
                return [x for x in lines[i + 1:j] if x.startswith("PLT-TC ")]
            sync_manage = between("PLT-MARK manage-begin", "PLT-MARK manage-end")
            sync_unmanage = between("PLT-MARK unmanage-begin", "PLT-MARK unmanage-end")
            tc_f2 = [x for x in lines if x.startswith(f"PLT-TC {F2} ")]
            c("b: tileChanged observed for manage (true) and unmanage (false)",
              f"PLT-TC {F2} true" in tc_f2 and f"PLT-TC {F2} false" in tc_f2, tc_f2)
            record("native-manage-L14", {
                "manageCall": m, "unmanageCall": u, "explainBefore": ex0, "explainManaged": ex1, "explainReleased": ex2,
                "explainAdopted": ex3, "frames": {"pre": pre, "managed": f, "released": fu},
                "releasedFrameEqualsPreManageFrame": kwin_restored_pre,
                "counterDelta": {"manage": d, "unmanage": du, "peerResize": dg, "adopt": delta(c5, c6)},
                "tileChanged": {"sequence": lines, "emittedInsideManage": sync_manage, "emittedInsideUnmanage": sync_unmanage},
            }, out, c)
        finally:
            stop_observer(s)


@scenario("native-editor-toggle-L14")
def native_editor_toggle(out: Path, c: Checks):
    """(c) Toggling KWin's tiles editor while Plastile is active causes no work and no movement."""
    with Session(out) as s:
        started(s)
        names = s.kw.shortcut_names()
        cand = sorted(n for n in names if "tile" in n.lower() and "quick" not in n.lower() and not n.startswith("plastile."))
        comp = s.kw.compositing_type()
        if EDITOR_ACTION not in names and comp == "QPainter":
            raise Skipped(f"'{EDITOR_ACTION}' is registered by the GL-only tileseditor effect; "
                          "this session composites with QPainter (no DRM render node)")
        c(f"c: '{EDITOR_ACTION}' kglobalaccel action exists", EDITOR_ACTION in names, {"candidates": cand, "compositing": comp})
        f0, c0, off = frames(s), s.counters(), s.kw.mark()
        e0 = effects(s)
        s.kw.invoke_shortcut(EDITOR_ACTION)
        ok_on = True
        try:
            s.wait_for(lambda: "tileseditor" in effects(s), 5, "tiles editor effect active")
        except Exception:
            ok_on = False
        time.sleep(0.8)
        e1, fm, cm = effects(s), frames(s), s.counters()
        s.kw.invoke_shortcut(EDITOR_ACTION)
        ok_off = True
        try:
            s.wait_for(lambda: "tileseditor" not in effects(s), 5, "tiles editor effect inactive")
        except Exception:
            ok_off = False
        time.sleep(0.8)
        c1 = s.settle()
        e2, f1 = effects(s), frames(s)
        c("c: editor became active then inactive (activeEffects)", ok_on and ok_off, {"before": e0, "open": e1, "closed": e2})
        c("c: windows unchanged while the editor is open (oracle)", same(f0, fm), fm)
        c("c: layout unchanged after closing the editor (oracle)", same(f0, f1), f1)
        d = delta(c0, c1)
        c("c: no writes/solves/corrections caused by the toggle", not any(d.get(k, 0) for k in ("writes", "solves", "corrections")),
          {"open": delta(c0, cm), "total": d})
        c("c: no Plastile errors/warnings", c1["counters"]["errors"] == 0 and not errors(s, off), errors(s, off)[:3])
        c("c: still three tiled", not three_tiled(s), three_tiled(s))
        record("native-editor-toggle-L14", {"action": EDITOR_ACTION, "tileShortcutCandidates": cand,
                                            "activeEffects": {"before": e0, "open": e1, "closed": e2}, "counterDelta": d},
               out, c)


@scenario("native-quicktile-repeat-L13")
def native_quicktile_repeat(out: Path, c: Checks):
    """(d) Quick tile left (yield), repeat (KWin no-op), then toggle-float re-adopts."""
    with Session(out) as s:
        started(s)
        off = s.kw.mark()
        s.act(F2, "workspace.activeWindow = w; workspace.slotWindowQuickTileLeft()")
        time.sleep(1.0)
        s.settle()
        f1 = s.frames()
        q = f1[F2]["frame"]
        ex1 = brief(explain(s, F2))
        c("d: quick tile left kept (left half, native tile)", q["x"] <= 1 and abs(q["width"] - 640) <= 9 and f1[F2]["tile"], q)
        c("d: yielded: explain mode native", ex1["mode"] == "native" and ex1["nativeTile"], ex1)
        c("d: peers retiled as two", two_full_height(s, F1, F3), {k: f1[k]["frame"] for k in (F1, F3)})
        c0 = s.counters()
        s.act(F2, "workspace.activeWindow = w; workspace.slotWindowQuickTileLeft()")
        time.sleep(1.0)
        c1 = s.settle()
        f2 = s.frames()
        ex2 = brief(explain(s, F2))
        d2 = delta(c0, c1)
        noop = all(near(f2[k]["frame"], f1[k]["frame"], 0.5) for k in f1)
        c("d: repeated quick tile left: no Plastile work, still native", ex2["mode"] == "native" and
          not any(d2.get(k, 0) for k in ("writes", "solves")), {"explain": ex2, "delta": d2})
        steps = []
        for i in (1, 2, 3):
            s.act(F2, "workspace.activeWindow = w")
            s.cmd("window.toggle-float")
            time.sleep(0.6)
            s.settle()
            fr = s.frames()
            steps.append({"toggle": i, "explain": brief(explain(s, F2)), "frame": fr[F2]["frame"], "nativeTile": fr[F2]["tile"],
                          "threeTiledErrors": three_tiled(s), "peersTwo": two_full_height(s, F1, F3)})
        t1, t2, t3 = steps
        c("d: toggle-float #1 from native re-adopts: three tiled, tile association released",
          t1["explain"]["mode"] == "tiled" and not t1["threeTiledErrors"] and not t1["nativeTile"], t1)
        c("d: toggle-float #2 floats at the remembered (quick-tile) rect, peers two",
          t2["explain"]["mode"] == "floating" and near(t2["frame"], q, 1.0) and t2["peersTwo"], t2)
        c("d: toggle-float #3 returns the window to the layout",
          t3["explain"]["mode"] == "tiled" and not t3["threeTiledErrors"], t3)
        c("d: no Plastile errors/warnings", s.counters()["counters"]["errors"] == 0 and not errors(s, off), errors(s, off)[:3])
        record("native-quicktile-repeat-L13", {"quickTile": {"frame": q, "explain": ex1},
                                               "repeat": {"kwinNoop": noop, "explain": ex2, "counterDelta": d2},
                                               "toggles": steps}, out, c)


@scenario("native-adopt-noop-L13")
def native_adopt_noop(out: Path, c: Checks):
    """(e) adopt-native on an ordinary tiled window is a no-op with a logged reason."""
    with Session(out, config={"diagnostics": "debug"}) as s:
        started(s)
        f0 = frames(s)
        s.act(F1, "workspace.activeWindow = w")
        c0, off = s.counters(), s.kw.mark()
        s.cmd("window.adopt-native")
        lines = s.kw.wait_log(r"plastile debug command .*adopt-native", 5, off)
        c1 = s.settle()
        res = json.loads(lines[-1].split("plastile debug command ", 1)[1])
        d = delta(c0, c1)
        c("e: adopt-native on a tiled window is a noop with a reason",
          res.get("status") == "noop" and bool(res.get("reason")), res)
        c("e: no writes/solves", not any(d.get(k, 0) for k in ("writes", "solves", "corrections")), d)
        c("e: windows unchanged (oracle)", same(f0, frames(s)))
        c("e: no Plastile errors/warnings", not errors(s, off), errors(s, off)[:3])
        record("native-adopt-noop-L13", {"result": res, "counterDelta": d}, out, c)


@scenario("native-unmanage-config-L14")
def native_unmanage_config(out: Path, c: Checks):
    """(b, follow-up) A window released with Tile.unmanage must stay yielded across an
    unrelated configuration activation (which reclassifies every window)."""
    with Session(out) as s:
        started(s)
        s.js(ROOT_JS + f"const w = workspace.windowList().find(x => x.caption === {json.dumps(F2)}); emit(root.tiles[0].manage(w));")
        s.wait_for(lambda: brief(explain(s, F2))["mode"] == "native", 5, "yield on manage")
        s.settle()
        s.js(f"const w = workspace.windowList().find(x => x.caption === {json.dumps(F2)}); emit(w.tile.unmanage(w));")
        s.wait_for(lambda: brief(explain(s, F2))["nativeTile"] is False, 5, "nativeTile false after unmanage")
        s.settle()
        fu, exu = frames(s), brief(explain(s, F2))
        c("setup: released window yielded (mode native, nativeTile false)", exu["mode"] == "native" and not exu["nativeTile"], exu)
        rc = s.kw.root / "config/kwinrc"
        rc.write_text(rc.read_text().replace("[Script-plastile]", "[Script-plastile]\ngapInner=12", 1))
        c0, off = s.counters(), s.kw.mark()
        s.kw.call("/KWin", "org.kde.KWin", "reconfigure")
        s.kw.wait_log(r"plastile info configuration activated", 5, off)
        time.sleep(0.8)
        c1 = s.settle()
        fc, exc = frames(s), brief(explain(s, F2))
        c("config activation does not re-adopt the released window (mode stays native)", exc["mode"] == "native", exc)
        c("config activation does not move the released window (oracle)", near(fc[F2], fu[F2], 0.5), {"before": fu[F2], "after": fc[F2]})
        c("no Plastile errors/warnings", c1["counters"]["errors"] == 0 and not errors(s, off), errors(s, off)[:3])
        record("native-unmanage-config-L14", {"released": {"frame": fu[F2], "explain": exu},
                                              "afterConfigActivation": {"frame": fc[F2], "explain": exc},
                                              "counterDelta": delta(c0, c1)}, out, c)


NAMES = ["native-tree-edit-L14", "native-manage-L14", "native-editor-toggle-L14", "native-quicktile-repeat-L13",
         "native-adopt-noop-L13", "native-unmanage-config-L14"]
