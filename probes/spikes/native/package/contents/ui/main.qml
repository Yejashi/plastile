// M1 spike root (T05 direct / T06 native share this file shape).
// Nested sessions only: requires the measurement-only Plastile.Measure module.
// Log lines: "PLT-SPIKE <event> <json>".
import QtQuick
import QtQml
import org.kde.kwin
import Plastile.Measure
import "../../../../common/core.js" as Core
import "native.js" as Backend

Item {
    id: root
    readonly property string backendName: "native"
    property bool alive: false

    function log(event, data) { console.info("PLT-SPIKE " + event + " " + JSON.stringify(data)); }

    function run(name) {
        if (!alive) return;
        const t0 = MonotonicClock.nowNs();
        Core.command(name);
        const t1 = MonotonicClock.nowNs();
        log("command", { name: name, entryNs: t0, endNs: t1 });
    }

    Instantiator {
        model: ["ratio-up", "ratio-down", "swap", "noop", "focus-next"]
        delegate: ShortcutHandler {
            name: "plastile-spike-" + modelData
            text: "Plastile spike " + modelData
            sequence: ""
            onActivated: root.run(modelData)
        }
    }

    ShortcutHandler {
        name: "plastile-spike-dump"
        text: "Plastile spike dump counters"
        sequence: ""
        onActivated: if (root.alive) root.log("counters", Object.assign({ backend: root.backendName, t: MonotonicClock.nowNs() }, Core.snapshot()))
    }

    Component.onCompleted: {
        alive = true;
        const backend = Backend.create(Qt, MonotonicClock, root.log, Core.near, Core.rectOf, Workspace);
        Core.init(Workspace, KWin, Qt, backend, root.log);
        log("start", { backend: backendName });
    }

    Component.onDestruction: {
        alive = false;
        Core.teardown();
        log("teardown", { backend: backendName });
    }
}
