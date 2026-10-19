// MEASUREMENT-ONLY root (probes/perf/qv4solve): the engine with a mock host inside KWin's QV4.
// Never installed. Needs QML_IMPORT_PATH=build/measure/qml and the bundle built by run.py.
// Workloads run in blocks of `block` commands in a seeded shuffled order, one block per
// event-loop turn (a 20 ms Timer between blocks), warm-up blocks first; every solve span is
// kept in a preallocated Float64Array and printed after the last block.
import QtQuick
import QtQml
import org.kde.kwin
import Plastile.Measure
import "bench.mjs" as Bench

Item {
    id: root
    property var bench: null
    property var buf: null
    property var plan: []
    property int step: 0
    property int pos: 0
    property var spans: ({})

    function cfg(key, dflt) { return String(KWin.readConfig(key, dflt)); }

    Timer {
        id: tick
        interval: 20
        repeat: true
        onTriggered: root.next()
    }

    function next() {
        if (step >= plan.length) { tick.stop(); finish(); return; }
        var b = plan[step++];
        var t0 = MonotonicClock.nowNs();
        bench.run(b.wl, b.count, buf, pos);
        if (!b.warm) spans[b.wl].push([pos, b.count]);
        pos += b.count;
        if (step % 50 === 0) console.info("qv4solve progress " + step + "/" + plan.length + " " + (MonotonicClock.nowNs() - t0));
    }

    function finish() {
        for (var wl in spans) {
            var xs = [];
            var s = spans[wl];
            for (var i = 0; i < s.length; ++i)
                for (var j = 0; j < s[i][1]; ++j) xs.push(Math.round(buf[s[i][0] + j]));
            for (var k = 0; k < xs.length; k += 500)
                console.info("qv4solve samples " + wl + " " + JSON.stringify(xs.slice(k, k + 500)));
        }
        console.info("qv4solve done errors=" + bench.errors());
    }

    Component.onCompleted: {
        var n = parseInt(cfg("n", "32")), height = parseInt(cfg("height", "5798"));
        var samples = parseInt(cfg("samples", "5000")), warm = parseInt(cfg("warmup", "200")), block = parseInt(cfg("block", "100"));
        var wls = cfg("workloads", "ratio,swap,master").split(",");
        var seed = parseInt(cfg("seed", "1")) >>> 0;
        var rnd = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        var shuffle = function (a) { for (var i = a.length - 1; i > 0; --i) { var j = Math.floor(rnd() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
        var p = [], m = [];
        for (var i = 0; i < wls.length; ++i) {
            spans[wls[i]] = [];
            for (var w = 0; w < warm; w += block) p.push({ wl: wls[i], count: Math.min(block, warm - w), warm: true });
            for (var b = 0; b < samples; b += block) m.push({ wl: wls[i], count: Math.min(block, samples - b), warm: false });
        }
        plan = p.concat(shuffle(m));
        buf = new Float64Array(wls.length * (samples + warm));
        bench = Bench.createBench(function () { return MonotonicClock.nowNs(); }, n, height);
        console.info("qv4solve started blocks=" + plan.length);
        tick.start();
    }

    Component.onDestruction: tick.stop()
}
