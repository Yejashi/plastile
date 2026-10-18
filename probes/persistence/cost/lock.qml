// MEASUREMENT-ONLY (T27 cost, lock phase): one save while run.py holds the slot's QLockFile
// (or leaves a stale one). The write starts on a Timer, after the D-Bus call that ran this
// script has returned, and is timed with the measurement module: the time it blocks is the
// compositor stall a held lock causes. Never installed.
import QtQuick
import Plastile.Measure
import "../../../package/contents/ui" as Pkg

Item {
    id: root
    Pkg.Persistence { id: store }

    Timer {
        id: later
        interval: 200
        onTriggered: {
            var a = MonotonicClock.nowNs();
            store.write(0, JSON.stringify({ schemaVersion: 1, generation: 1, probe: "lock" }));
            var b = MonotonicClock.nowNs();
            console.info("PLT lock " + JSON.stringify({ writeNs: b - a, startNs: a }));
        }
    }

    Component.onCompleted: {
        var err = store.open();
        console.info("PLT lock " + JSON.stringify({ opened: err === "", error: err }));
        if (err === "") later.start();
    }
}
