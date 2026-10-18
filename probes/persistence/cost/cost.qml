// MEASUREMENT-ONLY (T27 cost, probes/persistence/cost/run.py): the production Persistence.qml
// store, timed with the CLOCK_MONOTONIC measurement module. Never installed.
// Requires QML_IMPORT_PATH=build/measure/qml (nested sessions only).
//
// At load: open() and both slot reads, timed (what Plastile does once before its first solve).
// Then, one write per Timer tick (not back to back, like the runtime's debounced saves),
// alternating slots as the runtime does: setValue and sync timed separately, for each size in
// `sizes` KiB, `warmup` writes (reported as such) then `samples` measured ones. Every text
// differs from the previous one in the same slot, so every sync really writes.
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

    Pkg.Persistence { id: store }

    Timer {
        id: tick
        interval: root.gapMs
        repeat: true
        onTriggered: root.step()
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
        var s = store.slots[k % 2];
        var a = MonotonicClock.nowNs();
        s.setValue("snapshot", text);
        var b = MonotonicClock.nowNs();
        s.sync();
        var c = MonotonicClock.nowNs();
        // Warm-up writes are reported too, under their own kind (PERFORMANCE §6: recorded separately, not dropped).
        console.info("PLT cost " + JSON.stringify({ kind: k >= warmup ? "write" : "warmup", kb: sizes[si], i: k - warmup,
                                                   chars: text.length, setValueNs: b - a, syncNs: c - b, totalNs: c - a }));
        k++;
        if (k >= warmup + samples) { k = 0; si++; }
    }

    Component.onCompleted: {
        var t0 = MonotonicClock.nowNs();
        var err = store.open();
        var t1 = MonotonicClock.nowNs();
        var r0 = err === "" ? store.read(0) : "";
        var r1 = err === "" ? store.read(1) : "";
        var t2 = MonotonicClock.nowNs();
        console.info("PLT cost " + JSON.stringify({ kind: "load", openNs: t1 - t0, readNs: t2 - t1, chars: r0.length + r1.length,
                                                   error: err, location: store.location(),
                                                   clockResolutionNs: MonotonicClock.resolutionNs() }));
        if (err === "") tick.start();
    }

    Component.onDestruction: tick.stop()
}
