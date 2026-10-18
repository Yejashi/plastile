// MEASUREMENT-ONLY (persistence cost, probes/persistence/cost/run.py): the production
// Persistence.qml store over the plastile-state helper (ADR-020), timed with the CLOCK_MONOTONIC
// measurement module. Never installed. Requires QML_IMPORT_PATH=build/measure/qml (nested only).
//
// At load: read() timed twice, the call itself (what KWin's thread spends issuing it) and the
// reply (issue to callback, which includes the helper's work and, the first time, its D-Bus
// activation). Then one write per Timer tick (not back to back, like the runtime's debounced
// saves), alternating slots, for each size in `sizes` KiB: `warmup` writes (reported as such),
// then `samples` measured ones. Each write's call and its reply are timed separately. The next
// write is issued only after the previous reply, as the runtime does (one write in flight).
import QtQuick
import Plastile.Measure
import "../../../package/contents/ui" as Pkg

Item {
    id: root
    property var sizes: [1, 16, 64]
    property int samples: 250
    property int warmup: 10
    property int gapMs: 20
    property int si: 0
    property int k: 0
    property bool waiting: false

    Pkg.Persistence { id: store }

    Timer {
        id: tick
        interval: root.gapMs
        repeat: true
        onTriggered: if (!root.waiting) root.step()
    }

    function makeText(bytes, i) {
        var head = JSON.stringify({ schemaVersion: 1, generation: i, savedAt: "2026-10-18T00:00:00.000Z", pad: "" });
        var n = Math.max(0, bytes - head.length);
        return JSON.stringify({ schemaVersion: 1, generation: i, savedAt: "2026-10-18T00:00:00.000Z", pad: "x".repeat(n) });
    }

    function step() {
        if (si >= sizes.length) {
            tick.stop();
            console.info("PLT cost done");
            return;
        }
        var text = makeText(sizes[si] * 1024, k);
        var kind = k >= warmup ? "write" : "warmup", kb = sizes[si], i = k - warmup;
        waiting = true;
        var a = MonotonicClock.nowNs();
        store.write(k % 2, text, function (ok) {
            var c = MonotonicClock.nowNs();
            root.waiting = false;
            // Warm-up writes are reported too, under their own kind (PERFORMANCE §6: recorded separately, not dropped).
            console.info("PLT cost " + JSON.stringify({ kind: kind, kb: kb, i: i, chars: text.length, ok: ok,
                                                       callNs: b - a, replyNs: c - a }));
        });
        var b = MonotonicClock.nowNs();
        k++;
        if (k >= warmup + samples) { k = 0; si++; }
    }

    Component.onCompleted: {
        var t0 = MonotonicClock.nowNs();
        var t1 = 0;
        store.read(function (texts) {
            var t2 = MonotonicClock.nowNs();
            console.info("PLT cost " + JSON.stringify({ kind: "load", callNs: t1 - t0, replyNs: t2 - t0,
                                                       chars: String(texts[0]).length + String(texts[1]).length,
                                                       clockResolutionNs: MonotonicClock.resolutionNs() }));
            if (root.samples > 0) tick.start();
        }, function () {
            console.info("PLT cost " + JSON.stringify({ kind: "load", error: "no helper" }));
        });
        t1 = MonotonicClock.nowNs();
    }

    Component.onDestruction: tick.stop()
}
