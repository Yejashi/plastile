"""XWayland scenarios (TEST_MATRIX G10: increment/aspect hints, plus min/fixed/dialog X11 cases).

Each scenario starts a fresh nested KWin with `--xwayland` (its own private bus, XDG tree and
X display), two Wayland fixture windows, the real Plastile package, and one
fixtures/xclient/build/plastile-xclient (xcb) client. The nested X display is discovered
by tools/nested.py (NestedKwin.x_display: the Xwayland child's command line, else the
lowest-numbered X lock file owned by the nested KWin, which starts Xwayland lazily); the
user's own display is never used.

Geometry is judged by the oracle (one-shot KWin scripts reading real window state) and by
the X client's own ConfigureNotify log. Plastile's counters are used only for work-amount
gates; `inspect.explain-window` is read only to record the placement decision.

Each scenario merges a redacted summary into docs/status/evidence/xwayland-g10.json (titles
are fixture titles chosen here; no paths, users or real application titles).
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

from harness import NestedError, ROOT, Session, delta, evidence_file, near, tiling_errors
import sysinfo  # tools/ is on sys.path via harness  # noqa: E402
from scenarios import Checks, scenario

XCLIENT = ROOT / "fixtures/xclient/build/plastile-xclient"
XCLASS = "plastile-xclient"
EVIDENCE = evidence_file("xwayland-g10.json")
GAP = 8
FIELDS = (
    "({id: String(w.internalId), caption: w.caption, resourceClass: w.resourceClass, resourceName: w.resourceName,"
    " windowType: w.windowType, windowRole: w.windowRole, desktopFileName: w.desktopFileName,"
    " frame: {x: w.frameGeometry.x, y: w.frameGeometry.y, width: w.frameGeometry.width, height: w.frameGeometry.height},"
    " client: {x: w.clientGeometry.x, y: w.clientGeometry.y, width: w.clientGeometry.width, height: w.clientGeometry.height},"
    " minSize: {width: w.minSize.width, height: w.minSize.height}, maxSize: {width: w.maxSize.width, height: w.maxSize.height},"
    " normalWindow: w.normalWindow, dialog: w.dialog, transient: w.transient,"
    " transientFor: w.transientFor ? w.transientFor.caption : null, modal: w.modal, specialWindow: w.specialWindow,"
    " resizeable: w.resizeable, managed: w.managed, minimized: w.minimized, hidden: w.hidden, fullScreen: w.fullScreen,"
    " maximizeMode: w.maximizeMode, active: w.active, noBorder: w.noBorder, onAllDesktops: w.onAllDesktops,"
    " output: w.output ? w.output.name : null, tile: w.tile !== null, stackIndex: workspace.stackingOrder.indexOf(w)})"
)
UNBOUNDED = 2147483647


# --------------------------------------------------------------------------- helpers
def x_display(s: Session, timeout: float = 10.0) -> str:
    """The nested KWin's public X display (never the user's); see NestedKwin.x_display."""
    return s.kw.x_display(timeout)


class XClient:
    def __init__(self, s: Session, title: str, *args: str, wait: bool = True):
        self.title = title
        self.log = s.out / f"xclient-{re.sub(r'[^a-z0-9]+', '-', title.lower())}.jsonl"
        env = s.kw.client_env()
        env["DISPLAY"] = x_display(s)
        self.display = env["DISPLAY"]
        self.proc = subprocess.Popen([str(XCLIENT), "--title", title, "--class", XCLASS, *args], env=env,
                                     stdin=subprocess.PIPE, stdout=open(self.log, "w"), stderr=subprocess.STDOUT)
        s.kw._clients.append(self.proc)  # the nested session terminates it on every exit path
        if wait:
            Session.wait_for(lambda: any(w["caption"] == title for w in xwins(s)), 15, f"map {title}")

    def send(self, line: str) -> None:
        self.proc.stdin.write((line + "\n").encode())
        self.proc.stdin.flush()

    def quit(self, s: Session) -> int:
        self.send("quit")
        code = self.proc.wait(timeout=5)
        Session.wait_for(lambda: all(w["caption"] != self.title for w in xwins(s)), 5, f"unmap {self.title}")
        return code

    def events(self, ev: str | None = None, win: str = "main") -> list[dict]:
        out = []
        for line in self.log.read_text().splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if (ev is None or e.get("ev") == ev) and e.get("win", win) == win:
                out.append(e)
        return out


def xwins(s: Session) -> list[dict]:
    out = s.js(f"emit(workspace.windowList().filter(w => w.resourceClass === {json.dumps(XCLASS)}).map(w => {FIELDS}));")
    data = json.loads(out[0])
    if isinstance(data, dict) and "error" in data:
        raise NestedError(data["error"])
    return data


def by_caption(s: Session, caption: str) -> dict | None:
    out = s.js(f"emit(workspace.windowList().filter(w => w.caption === {json.dumps(caption)}).map(w => {FIELDS}));")
    data = json.loads(out[0])
    return data[0] if isinstance(data, list) and data else None


def xwin(s: Session, caption: str) -> dict:
    for w in xwins(s):
        if w["caption"] == caption:
            return w
    raise NestedError(f"no X window {caption}")


def all_frames(s: Session, captions: tuple[str, ...] = ()) -> list[dict]:
    """Fixture frames plus the named X windows, in the oracle's {caption, frame} shape."""
    return s.frames_list() + [{"caption": w["caption"], "frame": w["frame"]} for w in xwins(s) if w["caption"] in captions]


def settle_all(s: Session, timeout: float = 6.0, quiet: float = 0.4) -> dict:
    """s.settle(), then wait until fixture and X frames have not changed for `quiet` seconds."""
    c = s.settle(timeout)
    deadline = time.monotonic() + timeout
    last, since = None, time.monotonic()
    while time.monotonic() < deadline:
        cur = {f["caption"]: f["frame"] for f in s.frames_list()}
        cur.update({w["caption"]: w["frame"] for w in xwins(s)})
        if cur != last:
            last, since = cur, time.monotonic()
        elif time.monotonic() - since >= quiet:
            break
        time.sleep(0.05)
    return s.counters()


def stability(s: Session, seconds: float = 1.5, step: float = 0.1) -> dict[str, int]:
    """Distinct frames per window over a sampling window (1 == no oscillation)."""
    seen: dict[str, list] = {}
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        for f in s.frames_list():
            seen.setdefault(f["caption"], [])
            if f["frame"] not in seen[f["caption"]]:
                seen[f["caption"]].append(f["frame"])
        for w in xwins(s):
            seen.setdefault(w["caption"], [])
            if w["frame"] not in seen[w["caption"]]:
                seen[w["caption"]].append(w["frame"])
        time.sleep(step)
    return {k: len(v) for k, v in seen.items()}


def explain(s: Session, caption: str) -> dict:
    s.act(caption, "workspace.activeWindow = w")
    time.sleep(0.1)
    off = s.kw.mark()
    s.cmd("inspect.explain-window")
    line = s.kw.wait_log(r"plastile notice explain ", 5, off)[-1]
    return json.loads(line.split("plastile notice explain ", 1)[1])


def brief(e: dict) -> dict:
    keys = ("kind", "mode", "userMode", "decision", "layout", "suspensions", "constraints", "learnedMin", "learnedMax",
            "ledger", "slot", "exception")
    return {k: e.get(k) for k in keys if k in e}


def facts_of(w: dict) -> dict:
    """Script-visible identity/constraint facts for an X client (no ids, no pids)."""
    return {k: w[k] for k in ("resourceClass", "resourceName", "windowType", "windowRole", "desktopFileName", "normalWindow",
                              "dialog", "transient", "modal", "specialWindow", "resizeable", "minSize", "maxSize", "noBorder")}


def margins(w: dict) -> dict:
    f, c = w["frame"], w["client"]
    return {"left": c["x"] - f["x"], "top": c["y"] - f["y"], "right": f["x"] + f["width"] - c["x"] - c["width"],
            "bottom": f["y"] + f["height"] - c["y"] - c["height"]}


def last_configure(x: XClient, win: str = "main") -> dict | None:
    ev = x.events("configure", win)
    return {k: ev[-1][k] for k in ("w", "h", "synthetic", "n")} if ev else None


def direct_write(s: Session, x: XClient, rect: dict) -> dict:
    """Plastile unloaded: one plain-script frameGeometry write, then what KWin and the X client ended with."""
    n0 = len(x.events("configure"))
    s.act(x.title, f"w.frameGeometry = {json.dumps(rect)}")
    try:
        Session.wait_for(lambda: len(x.events("configure")) > n0, 3, "configure after direct write")
    except NestedError:
        pass
    time.sleep(0.4)
    w = xwin(s, x.title)
    return {"requestedFrame": rect, "frame": w["frame"], "client": w["client"], "xConfigure": last_configure(x)}


UUID = re.compile(r"\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?")


def record(name: str, data: dict, out: Path, c: Checks) -> None:
    # Window/desktop UUIDs are per-session noise; drop them from the committed summary.
    data = json.loads(UUID.sub("<id>", json.dumps(data)))
    data = {"layer": "nested KWin virtual backend + nested Xwayland (not physical)",
            "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "run": out.parent.name,
            "checks": {k: v["pass"] for k, v in c.items.items()}, **data}
    (out / "facts.json").write_text(json.dumps(data, indent=1))
    try:
        ev = json.loads(EVIDENCE.read_text())
    except (OSError, ValueError):
        ev = {}
    kwin = subprocess.run(["kwin_wayland", "--version"], capture_output=True, text=True).stdout.strip()
    xw = sysinfo.component_version("xwayland")
    ev.update({"what": "G10 XWayland fixture scenarios (tests/integration/scenarios_xwayland.py)",
               "kwin": kwin, "xwayland": xw or None, "client": "fixtures/xclient/build/plastile-xclient (xcb)"})
    ev.setdefault("scenarios", {})[name] = data
    EVIDENCE.write_text(json.dumps(ev, indent=1) + "\n")


def base_session(s: Session) -> dict:
    s.spawn(1); s.spawn(2)
    s.load()
    return settle_all(s)


# --------------------------------------------------------------------------- scenarios
@scenario("xwayland-tile-close-G10")
def x_tile_close(out: Path, c: Checks):
    with Session(out, xwayland=True) as s:
        c0 = base_session(s)
        a = s.area()
        pre = s.frames()
        x = XClient(s, "xc plain")
        c1 = settle_all(s)
        f = all_frames(s, (x.title,))
        errs = tiling_errors(f, a, GAP)
        c("open: X client tiles with 2 Wayland fixtures, no overlap, gaps>=8", len(f) == 3 and not errs, errs or f)
        w = xwin(s, x.title)
        e = explain(s, x.title)
        c("open: explain says tiled", e.get("mode") == "tiled", brief(e))
        d_open = delta(c0, c1)
        c("open: one solve, writes<=3, no corrections", d_open.get("solves", 0) >= 1 and d_open.get("writes", 0) <= 3
          and d_open.get("corrections", 0) == 0, d_open)
        cfg = last_configure(x)
        c("X client's last ConfigureNotify matches the oracle client size",
          cfg is not None and cfg["w"] == w["client"]["width"] and cfg["h"] == w["client"]["height"], [cfg, w["client"]])
        stab = stability(s)
        c("open: no oscillation (1 distinct frame per window over 1.5 s)", all(v == 1 for v in stab.values()), stab)

        # Client-initiated resize of a tiled X window (ConfigureRequest): recorded, bounded.
        before = xwin(s, x.title)["frame"]
        x.send("resize 300 200")
        time.sleep(1.0)
        c2 = settle_all(s)
        after_req = xwin(s, x.title)
        d_req = delta(c1, c2)
        c("client resize request: bounded work (writes<=3, corrections<=2)",
          d_req.get("writes", 0) <= 3 and d_req.get("corrections", 0) <= 2, d_req)
        stab2 = stability(s, 1.0)
        c("client resize request: final frames stable", all(v == 1 for v in stab2.values()), stab2)

        x.quit(s)
        c3 = settle_all(s)
        post = s.frames()
        f2 = s.frames_list()
        c("close: 2 fixtures retile without overlap", len(f2) == 2 and not tiling_errors(f2, a, GAP), tiling_errors(f2, a, GAP))
        c("close: fixtures return to their 2-window slots",
          all(near(post[k]["frame"], pre[k]["frame"], 1.0) for k in pre), {k: [pre[k]["frame"], post[k]["frame"]] for k in pre})
        c("close: one solve, no errors", delta(c2, c3).get("solves", 0) >= 1 and c3["counters"]["errors"] == 0, delta(c2, c3))
        # WM_CLASS case: is a mixed-case class reported verbatim (matters for appId rules)?
        mixed = XClient(s, "xc case", "--class", "Plastile-XClient-Case", wait=False)
        Session.wait_for(lambda: by_caption(s, mixed.title) is not None, 15, "map xc case")
        wc = by_caption(s, mixed.title)
        mixed.send("quit"); mixed.proc.wait(timeout=5)
        c("mixed-case WM_CLASS is visible to the script (recorded)", wc["resourceClass"] != "", facts_of(wc))
        record("xwayland-tile-close-G10", {
            "xDisplayDiscovery": "lock file owned by nested KWin pid (Xwayland started lazily on first X client)",
            "xFacts": facts_of(w), "decorationMargins": margins(w), "explain": brief(e), "openDelta": d_open,
            "resizeRequest": {"requestedClient": {"width": 300, "height": 200}, "frameBefore": before,
                              "frameAfter": after_req["frame"], "clientAfter": after_req["client"],
                              "returnedToSlot": near(after_req["frame"], before, 1.0), "delta": d_req,
                              "xConfigure": last_configure(x)},
            "closeDelta": delta(c2, c3),
            "mixedCaseWmClass": {"set": "instance=class=Plastile-XClient-Case", "resourceClass": wc["resourceClass"],
                                 "resourceName": wc["resourceName"]}}, out, c)


@scenario("xwayland-min-G10")
def x_min(out: Path, c: Checks):
    with Session(out, xwayland=True) as s:
        c0 = base_session(s)
        a = s.area()
        x = XClient(s, "xc min", "--size", "900x700", "--min", "900x700")
        time.sleep(0.5)
        c1 = settle_all(s, 8)
        w = xwin(s, x.title)
        c("KWin exposes WM_NORMAL_HINTS min size as window.minSize (client space)",
          w["minSize"] == {"width": 900, "height": 700}, w["minSize"])
        e = explain(s, x.title)
        d = delta(c0, c1)
        c("writes bounded (<=10)", d.get("writes", 0) <= 10, d)
        stab = stability(s, 2.0)
        c("no oscillation over 2 s", all(v == 1 for v in stab.values()), stab)
        fx = s.frames_list()
        c("Wayland fixtures still tiled without overlap", not tiling_errors(fx, a, GAP), tiling_errors(fx, a, GAP))
        tiled = e.get("mode") == "tiled"
        honoured = w["client"]["width"] >= 900 and w["client"]["height"] >= 700
        if tiled:
            f = all_frames(s, (x.title,))
            c("tiled X window: no overlap", not tiling_errors(f, a, GAP), tiling_errors(f, a, GAP))
        else:
            c("floating X window keeps at least its minimum size", honoured, w["client"])
        c("engine knows the minimum (constraints.minFrame >= 900x700 + margins)",
          (e.get("constraints") or {}).get("minFrame", {}).get("width", 0) >= 900, brief(e))
        s.unload()
        dw = direct_write(s, x, {"x": 10, "y": 10, "width": 333, "height": 277})
        record("xwayland-min-G10", {
            "hints": {"size": "900x700", "min": "900x700"}, "xFacts": facts_of(w), "explain": brief(e), "delta": d,
            "stableDistinctFrames": stab, "final": {"frame": w["frame"], "client": w["client"]}, "minHonoured": honoured,
            "directScriptWriteBelowMin": {**dw, "kwinClamped": dw["client"]["width"] >= 900 and dw["client"]["height"] >= 700}},
            out, c)


@scenario("xwayland-inc-G10")
def x_inc(out: Path, c: Checks):
    with Session(out, xwayland=True) as s:
        c0 = base_session(s)
        a = s.area()
        x = XClient(s, "xc inc", "--size", "400x300", "--inc", "10x20")
        time.sleep(0.5)
        c1 = settle_all(s, 8)
        w = xwin(s, x.title)
        e = explain(s, x.title)
        d = delta(c0, c1)
        stab = stability(s, 2.0)
        c("final frame stable over 2 s", all(v == 1 for v in stab.values()), stab)
        c("corrections <= 2", d.get("corrections", 0) <= 2, d)
        c("writes bounded (<=10)", d.get("writes", 0) <= 10, d)
        f = all_frames(s, (x.title,))
        c("no overlap with the Wayland fixtures", not tiling_errors(f, a), tiling_errors(f, a))
        cw, ch = w["client"]["width"], w["client"]["height"]
        snapped = cw % 10 == 0 and ch % 20 == 0
        cfg = last_configure(x)
        slot = e.get("slot")
        s.unload()
        dw = direct_write(s, x, {"x": 10, "y": 10, "width": 333, "height": 277})
        dc = dw["client"]
        record("xwayland-inc-G10", {
            "hints": {"size": "400x300", "inc": "10x20", "base": "0x0"}, "xFacts": facts_of(w),
            "incrementsScriptVisible": False, "explain": brief(e), "delta": d, "stableDistinctFrames": stab,
            "slot": slot, "final": {"frame": w["frame"], "client": w["client"]}, "xConfigure": cfg,
            "committedClientSnappedToIncrements": snapped,
            "directScriptWrite": {**dw, "clientSnapped": dc["width"] % 10 == 0 and dc["height"] % 20 == 0}}, out, c)


@scenario("xwayland-fixed-G10")
def x_fixed(out: Path, c: Checks):
    with Session(out, xwayland=True) as s:
        c0 = base_session(s)
        a = s.area()
        x = XClient(s, "xc fixed", "--size", "400x300", "--fixed")
        time.sleep(0.3)
        c1 = settle_all(s)
        w = xwin(s, x.title)
        e = explain(s, x.title)
        c("fixed-size X client floats (explain mode floating)", e.get("mode") == "floating", brief(e))
        c("decision source is the size constraint", (e.get("decision") or {}).get("source") == "constraint", brief(e))
        c("its own 400x300 client size is kept", w["client"]["width"] == 400 and w["client"]["height"] == 300, w["client"])
        fx = s.frames_list()
        c("fixtures stay tiled without overlap", not tiling_errors(fx, a, GAP), tiling_errors(fx, a, GAP))
        d = delta(c0, c1)
        c("no writes to the fixed window (writes<=2 overall)", d.get("writes", 0) <= 2, d)
        record("xwayland-fixed-G10", {"hints": {"size": "400x300", "min": "400x300", "max": "400x300"},
                                      "xFacts": facts_of(w), "explain": brief(e), "delta": d,
                                      "final": {"frame": w["frame"], "client": w["client"]}}, out, c)


@scenario("xwayland-dialog-G10")
def x_dialog(out: Path, c: Checks):
    with Session(out, xwayland=True) as s:
        c0 = base_session(s)
        a = s.area()
        x = XClient(s, "xc dlg", "--dialog")
        dlg = x.title + " dialog"
        Session.wait_for(lambda: any(w["caption"] == dlg for w in xwins(s)), 10, "map dialog")
        time.sleep(0.3)
        c1 = settle_all(s)
        main, d0 = xwin(s, x.title), xwin(s, dlg)
        em, ed = explain(s, x.title), explain(s, dlg)
        c("main X window tiles", em.get("mode") == "tiled", brief(em))
        c("transient dialog floats", ed.get("mode") == "floating", brief(ed))
        f = all_frames(s, (x.title,))
        c("main + fixtures: no overlap", not tiling_errors(f, a, GAP), tiling_errors(f, a, GAP))
        c("dialog keeps its own 300x200 client size", d0["client"]["width"] == 300 and d0["client"]["height"] == 200, d0["client"])
        c("script sees WM_TRANSIENT_FOR and the dialog type", d0["transient"] and d0["transientFor"] == x.title and d0["dialog"],
          facts_of(d0))
        # Trigger a retile of the context and check the dialog is still visible and above its parent.
        s.act(x.title, "workspace.activeWindow = w")
        s.cmd("layout.bsp"); settle_all(s)
        s.cmd("layout.master-stack"); c2 = settle_all(s)
        d1, main1 = xwin(s, dlg), xwin(s, x.title)
        r = d1["frame"]
        inside = (r["x"] < a["x"] + a["width"] and r["x"] + r["width"] > a["x"] and r["y"] < a["y"] + a["height"]
                  and r["y"] + r["height"] > a["y"])
        visible = not d1["minimized"] and not d1["hidden"] and inside
        c("dialog stays visible after retiles (not minimized/hidden, on the work area)", visible, d1)
        c("dialog is stacked above its parent", d1["stackIndex"] > main1["stackIndex"], [d1["stackIndex"], main1["stackIndex"]])
        c("dialog frame not moved by Plastile", near(d1["frame"], d0["frame"], 1.0), [d0["frame"], d1["frame"]])
        d = delta(c0, c2)
        c("no model errors", c2["counters"]["errors"] == 0, d)
        record("xwayland-dialog-G10", {"xFactsMain": facts_of(main), "xFactsDialog": facts_of(d0),
                                       "explainMain": brief(em), "explainDialog": brief(ed),
                                       "dialogVisible": visible, "stack": {"dialog": d1["stackIndex"], "main": main1["stackIndex"]},
                                       "delta": d}, out, c)


@scenario("xwayland-aspect-G10")
def x_aspect(out: Path, c: Checks):
    with Session(out, xwayland=True) as s:
        c0 = base_session(s)
        a = s.area()
        x = XClient(s, "xc aspect", "--size", "400x300", "--aspect", "4:3")
        time.sleep(0.5)
        c1 = settle_all(s, 8)
        w = xwin(s, x.title)
        e = explain(s, x.title)
        d = delta(c0, c1)
        stab = stability(s, 2.0)
        c("no oscillation over 2 s", all(v == 1 for v in stab.values()), stab)
        c("writes bounded (<=10), corrections<=2", d.get("writes", 0) <= 10 and d.get("corrections", 0) <= 2, d)
        f = all_frames(s, (x.title,) if e.get("mode") == "tiled" else ())
        c("no overlap among tiled windows", not tiling_errors(f, a), tiling_errors(f, a))
        cw, ch = w["client"]["width"], w["client"]["height"]
        s.unload()
        dw = direct_write(s, x, {"x": 10, "y": 10, "width": 600, "height": 277})
        dc = dw["client"]
        record("xwayland-aspect-G10", {
            "hints": {"size": "400x300", "aspect": "4:3 (min=max)"}, "xFacts": facts_of(w), "aspectScriptVisible": False,
            "explain": brief(e), "delta": d, "stableDistinctFrames": stab,
            "final": {"frame": w["frame"], "client": w["client"], "clientAspect": round(cw / ch, 4) if ch else None},
            "xConfigure": last_configure(x),
            "directScriptWrite": {**dw, "clientAspect": round(dc["width"] / dc["height"], 4) if dc["height"] else None}},
            out, c)
