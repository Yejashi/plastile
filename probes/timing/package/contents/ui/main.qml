// Plastile M0 timing/scheduler probe (T03, E06, E13).
//
// Requires the measurement-only module Plastile.Measure (tools/measure), loaded
// through QML_IMPORT_PATH in nested sessions. All timestamps are CLOCK_MONOTONIC
// nanoseconds, the same domain as the harness and the fixture client logs.
//
// Phases:
//   calibrate (on load): clock overhead, Qt.callLater / Timer dispatch delay,
//                        coalescing of stable vs fresh callbacks.
//   shortcut "plastile-probe-timing-dispatch": logs handler entry time.
//   shortcut "plastile-probe-timing-geometry": applies the next target from a
//            fixed sequence to the fixture window and logs request + observations.
//
// Log lines: "PLT-TM <event> <json>".
import QtQuick
import org.kde.kwin
import Plastile.Measure

Item {
    id: root

    readonly property string fixtureClass: KWin.readConfig("fixtureClass", "plastile-fixture")
    property bool alive: false
    property var fixture: null
    property int targetIndex: 0
    property int requestSeq: 0
    property var connections: []

    // Targets relative to the fixture output's placement area (fractions).
    // A, B, A exercises reversal; then a position-only move; then a same-target no-op.
    readonly property var sequence: [
        { name: "A", x: 0.05, y: 0.05, w: 0.40, h: 0.50 },
        { name: "B", x: 0.05, y: 0.05, w: 0.60, h: 0.70 },
        { name: "A", x: 0.05, y: 0.05, w: 0.40, h: 0.50 },
        { name: "A-moved", x: 0.20, y: 0.10, w: 0.40, h: 0.50 },
        { name: "A-moved-again", x: 0.20, y: 0.10, w: 0.40, h: 0.50 },
    ]

    function log(event, data) {
        console.info("PLT-TM " + event + " " + JSON.stringify(data));
    }

    function own(signal, fn) {
        signal.connect(fn);
        connections.push({ signal: signal, fn: fn });
    }

    function quantiles(xs) {
        const s = xs.slice().sort((a, b) => a - b);
        const q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
        return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] };
    }

    // ---------------------------------------------------------------- calibrate
    property var cl: ({ samples: [], t0: 0, remaining: 0 })
    property var tm: ({ samples: [], t0: 0, remaining: 0, interval: 0 })
    property int coalesceStableRuns: 0
    property int coalesceFreshRuns: 0

    function calibrateClock() {
        const n = 20000;
        const diffs = new Array(n);
        let prev = MonotonicClock.nowNs();
        const start = prev;
        for (let i = 0; i < n; ++i) {
            const now = MonotonicClock.nowNs();
            diffs[i] = now - prev;
            prev = now;
        }
        const nonzero = diffs.filter(d => d > 0);
        log("clock", {
            resolutionNs: MonotonicClock.resolutionNs(),
            nowNs: start,
            exactAsDouble: start < 9007199254740992,
            meanCallNs: (prev - start) / n,
            callDiffNs: quantiles(diffs),
            minNonzeroStepNs: nonzero.length ? Math.min.apply(null, nonzero) : null,
        });
    }

    function callLaterSample() {
        if (!alive) return;
        cl.samples.push(MonotonicClock.nowNs() - cl.t0);
        if (--cl.remaining > 0) {
            cl.t0 = MonotonicClock.nowNs();
            Qt.callLater(root.callLaterSample);
        } else {
            log("callLater", quantiles(cl.samples));
            startTimerSamples(0);
        }
    }

    function startTimerSamples(interval) {
        tm.samples = []; tm.remaining = 100; tm.interval = interval;
        probeTimer.interval = interval;
        tm.t0 = MonotonicClock.nowNs();
        probeTimer.restart();
    }

    Timer {
        id: probeTimer
        repeat: false
        onTriggered: {
            if (!root.alive) return;
            root.tm.samples.push(MonotonicClock.nowNs() - root.tm.t0);
            if (--root.tm.remaining > 0) {
                root.tm.t0 = MonotonicClock.nowNs();
                probeTimer.restart();
            } else {
                root.log("timer", Object.assign({ intervalMs: root.tm.interval }, root.quantiles(root.tm.samples)));
                if (root.tm.interval === 0) root.startTimerSamples(1);
                else if (root.tm.interval === 1) root.startTimerSamples(16);
                else root.coalesce();
            }
        }
    }

    function stableRun() { if (alive) coalesceStableRuns++; }

    function coalesce() {
        const n = 1000;
        const t0 = MonotonicClock.nowNs();
        for (let i = 0; i < n; ++i) Qt.callLater(root.stableRun);
        const t1 = MonotonicClock.nowNs();
        for (let i = 0; i < n; ++i) Qt.callLater(function () { if (root.alive) root.coalesceFreshRuns++; });
        const t2 = MonotonicClock.nowNs();
        Qt.callLater(root.reportCoalesce, n, t1 - t0, t2 - t1);
    }

    function reportCoalesce(n, stableScheduleNs, freshScheduleNs) {
        if (!alive) return;
        log("coalesce", {
            scheduled: n,
            stableRuns: coalesceStableRuns,
            freshRuns: coalesceFreshRuns,
            stableScheduleNsPerCall: stableScheduleNs / n,
            freshScheduleNsPerCall: freshScheduleNs / n,
        });
        log("calibrated", {});
    }

    // ------------------------------------------------------------------ dispatch
    ShortcutHandler {
        name: "plastile-probe-timing-dispatch"
        text: "Plastile timing probe dispatch"
        sequence: ""
        onActivated: {
            const t = MonotonicClock.nowNs();
            if (root.alive) root.log("dispatch", { handlerNs: t });
        }
    }

    // ------------------------------------------------------------------ geometry
    function areaFor(w) {
        return Workspace.clientArea(Workspace.PlacementArea, w.output, Workspace.currentDesktopForScreen(w.output));
    }

    function rectOf(r) { return { x: r.x, y: r.y, width: r.width, height: r.height }; }

    function adopt(w) {
        if (!w || fixture !== null || w.resourceClass !== fixtureClass) return;
        fixture = w;
        own(w.frameGeometryChanged, function () {
            const t = MonotonicClock.nowNs();
            if (root.alive && root.fixture === w)
                root.log("observed", { t: t, seq: root.requestSeq, frame: root.rectOf(w.frameGeometry), client: root.rectOf(w.clientGeometry) });
        });
        log("adopt", { frame: rectOf(w.frameGeometry), client: rectOf(w.clientGeometry) });
    }

    ShortcutHandler {
        name: "plastile-probe-timing-geometry"
        text: "Plastile timing probe geometry step"
        sequence: ""
        onActivated: {
            const tEntry = MonotonicClock.nowNs();
            const w = root.fixture;
            if (!root.alive || w === null) { root.log("geometry-skipped", { reason: "no fixture" }); return; }
            const spec = root.sequence[root.targetIndex % root.sequence.length];
            root.targetIndex++;
            const a = root.areaFor(w);
            const target = Qt.rect(Math.round(a.x + spec.x * a.width), Math.round(a.y + spec.y * a.height),
                                   Math.round(spec.w * a.width), Math.round(spec.h * a.height));
            const before = root.rectOf(w.frameGeometry);
            root.requestSeq++;
            const tWrite0 = MonotonicClock.nowNs();
            w.frameGeometry = target;
            const tWrite1 = MonotonicClock.nowNs();
            root.log("request", {
                seq: root.requestSeq, name: spec.name, entryNs: tEntry, writeStartNs: tWrite0, writeEndNs: tWrite1,
                target: root.rectOf(target), before: before, immediate: root.rectOf(w.frameGeometry),
            });
        }
    }

    // ------------------------------------------------------- baseline workloads
    // P01 direct one-window placement (resize and position-only separately) and
    // P02 native quick tile, each alternating between two states per activation.
    property int altResize: 0
    property int altMove: 0
    property int altQuick: 0

    function applyTarget(mode, name, target) {
        const w = fixture;
        const tEntry = MonotonicClock.nowNs();
        const before = rectOf(w.frameGeometry);
        requestSeq++;
        const tWrite0 = MonotonicClock.nowNs();
        w.frameGeometry = target;
        const tWrite1 = MonotonicClock.nowNs();
        log("request", { seq: requestSeq, mode: mode, name: name, entryNs: tEntry, writeStartNs: tWrite0,
                         writeEndNs: tWrite1, target: rectOf(target), before: before, immediate: rectOf(w.frameGeometry) });
    }

    ShortcutHandler {
        name: "plastile-probe-timing-alt-resize"
        text: "Plastile timing probe alternate resize"
        sequence: ""
        onActivated: {
            if (!root.alive || root.fixture === null) return;
            const a = root.areaFor(root.fixture);
            const big = (root.altResize++ % 2) === 1;
            root.applyTarget("P01-resize", big ? "R2" : "R1", Qt.rect(a.x + 64, a.y + 40,
                Math.round(a.width * (big ? 0.45 : 0.40)), Math.round(a.height * (big ? 0.55 : 0.50))));
        }
    }

    ShortcutHandler {
        name: "plastile-probe-timing-alt-move"
        text: "Plastile timing probe alternate move"
        sequence: ""
        onActivated: {
            if (!root.alive || root.fixture === null) return;
            const f = root.fixture.frameGeometry;
            const a = root.areaFor(root.fixture);
            const right = (root.altMove++ % 2) === 1;
            root.applyTarget("P01-move", right ? "M2" : "M1", Qt.rect(a.x + (right ? 160 : 64), a.y + 40, f.width, f.height));
        }
    }

    ShortcutHandler {
        name: "plastile-probe-timing-quicktile"
        text: "Plastile timing probe alternate native quick tile"
        sequence: ""
        onActivated: {
            const w = root.fixture;
            if (!root.alive || w === null) return;
            Workspace.activeWindow = w;
            // Odd activations: unmeasured direct reset to a floating rect (mode P02-reset).
            // Even activations: measured native quick-tile-left from that floating state.
            // Alternating quick-tile directions is unsuitable: left/right halves are
            // position-only, and quick-tile-left from a left-tiled or top-left-tiled
            // window was observed to be a no-op in 6.7.5.
            const reset = (root.altQuick++ % 2) === 0;
            if (reset) {
                // A direct frameGeometry write alone was observed NOT to clear KWin's
                // quick-tile state; release the native association explicitly first.
                const a = root.areaFor(w);
                const tileBefore = w.tile !== null;
                const unmanaged = tileBefore ? w.tile.unmanage(w) : null;
                root.log("reset-tile", { tileBefore: tileBefore, unmanaged: unmanaged, tileAfter: w.tile !== null });
                root.applyTarget("P02-reset", "float", Qt.rect(a.x + 160, a.y + 40, Math.round(a.width * 0.45), Math.round(a.height * 0.55)));
                return;
            }
            const before = root.rectOf(w.frameGeometry);
            root.requestSeq++;
            const t0 = MonotonicClock.nowNs();
            Workspace.slotWindowQuickTileLeft();
            const t1 = MonotonicClock.nowNs();
            root.log("request", { seq: root.requestSeq, mode: "P02-quicktile", name: "QL", entryNs: t0,
                                  writeStartNs: t0, writeEndNs: t1, target: null, before: before,
                                  immediate: root.rectOf(w.frameGeometry), activeIsFixture: Workspace.activeWindow === w });
        }
    }

    ShortcutHandler {
        name: "plastile-probe-timing-undersize"
        text: "Plastile timing probe request below client minimum"
        sequence: ""
        onActivated: {
            const w = root.fixture;
            if (!root.alive || w === null) return;
            const a = root.areaFor(w);
            root.log("constraints", { minSize: { width: w.minSize.width, height: w.minSize.height },
                                      maxSize: { width: w.maxSize.width, height: w.maxSize.height } });
            root.applyTarget("undersize", "U", Qt.rect(a.x + 64, a.y + 40,
                Math.max(1, Math.round(w.minSize.width / 2)), Math.max(1, Math.round(w.minSize.height / 2))));
        }
    }

    Component.onCompleted: {
        alive = true;
        own(Workspace.windowAdded, root.adopt);
        const ws = Workspace.windows;
        for (let i = 0; i < ws.length; ++i) adopt(ws[i]);
        calibrateClock();
        cl.samples = []; cl.remaining = 200; cl.t0 = MonotonicClock.nowNs();
        Qt.callLater(root.callLaterSample);
    }

    Component.onDestruction: {
        alive = false;
        probeTimer.stop();
        for (let i = connections.length - 1; i >= 0; --i) connections[i].signal.disconnect(connections[i].fn);
        connections = [];
        fixture = null;
        console.info("PLT-TM teardown {}");
    }
}
