// Probe: can a KWin declarative script move file writes off the compositor thread with a WorkerScript?
// Each worker (classic .js and ES module .mjs) reports what its engine offers and tries the writes.
import QtQuick
import QtQml.WorkerScript

Item {
    id: root
    property string dir: ""
    function log(o) { console.log("PLT worker " + JSON.stringify(o)); }

    WorkerScript {
        id: classic
        source: "writer.js"
        onMessage: (m) => root.log(Object.assign({ worker: "js" }, m))
        onReadyChanged: if (ready) root.go(classic, "js")
    }
    WorkerScript {
        id: module
        source: "writer.mjs"
        onMessage: (m) => root.log(Object.assign({ worker: "mjs" }, m))
        onReadyChanged: if (ready) root.go(module, "mjs")
    }
    // Main-thread tick jitter while the workers run (a blocked main thread shows as a long gap).
    property real last: 0
    property real worstGapMs: 0
    Timer {
        interval: 5; repeat: true; running: true
        onTriggered: {
            var t = Date.now();
            if (root.last > 0) root.worstGapMs = Math.max(root.worstGapMs, t - root.last);
            root.last = t;
        }
    }
    Timer { interval: 6000; running: true; onTriggered: root.log({ phase: "main", worstTickGapMs: root.worstGapMs, ticks: root.ticks }) }
    property int ticks: 0
    onLastChanged: ticks++

    function go(w, name) {
        var t0 = Date.now();
        w.sendMessage({ dir: root.dir, tag: name, text: new Array(25 * 1024 + 1).join("x"), busyMs: 1500 });
        root.log({ phase: "posted", worker: name, sendMs: Date.now() - t0 });
    }
    Component.onCompleted: {
        root.dir = Qt.resolvedUrl(".").toString();
        root.log({ phase: "main", xhr: typeof XMLHttpRequest, offlineStoragePath: "n/a" });
    }
}
