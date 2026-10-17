// Plastile M0 lifecycle/teardown probe (T02/E10).
//
// Demonstrates the teardown contract the production runtime will use:
//   1. every connection goes through an owned registry;
//   2. deferred work uses one stable flush function scheduled with Qt.callLater
//      and is rejected by instance liveness + generation checks;
//   3. unload invalidates callbacks *before* disconnecting/destroying resources.
//
// Config (kwinrc [Script-<plugin>]): fixtureClass, leakControl.
// leakControl=true additionally connects ONE plain closure to Workspace.windowAdded
// that is never disconnected, to test whether KWin/Qt drops it on unload.
//
// Log lines: "PLT-LC <event> <instance> ..." (parsed by probes/lifecycle/run.py).
import QtQuick
import org.kde.kwin

Item {
    id: root

    readonly property string fixtureClass: KWin.readConfig("fixtureClass", "plastile-fixture")
    readonly property bool leakControl: String(KWin.readConfig("leakControl", "false")) === "true"
    readonly property string instance: Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36)

    // Liveness and generation tokens. Captured by deferred work, checked on entry.
    property bool alive: false
    property int generation: 0
    property bool flushScheduled: false
    property int pendingPings: 0
    property int shortcutCount: 0

    // Owned connection registry: [{signal, fn, scope}]
    property var connections: []
    // Adopted fixture windows: internalId string -> true
    property var adopted: ({})

    function log(event, detail) {
        console.info("PLT-LC " + event + " " + instance + (detail === undefined ? "" : " " + detail));
    }

    function own(signal, fn, scope) {
        signal.connect(fn);
        connections.push({ signal: signal, fn: fn, scope: scope });
    }

    function releaseScope(scope) {
        const keep = [];
        let released = 0;
        for (let i = connections.length - 1; i >= 0; --i) {
            const c = connections[i];
            if (scope === null || c.scope === scope) {
                try { c.signal.disconnect(c.fn); } catch (e) { log("disconnect-error", String(e)); }
                ++released;
            } else {
                keep.unshift(c);
            }
        }
        connections = keep;
        return released;
    }

    // Stable zero-argument flush: identity-stable so Qt.callLater coalesces it.
    function flush() {
        if (!alive) {
            // Should be unreachable once teardown completes; log if Qt still runs it.
            console.info("PLT-LC stale-flush-rejected " + instance);
            return;
        }
        flushScheduled = false;
        const n = pendingPings;
        pendingPings = 0;
        log("flush", "gen=" + generation + " pings=" + n);
    }

    function scheduleFlush() {
        if (flushScheduled) return;
        flushScheduled = true;
        Qt.callLater(root.flush);
    }

    function adopt(w) {
        if (!w || w.resourceClass !== fixtureClass) return;
        const id = String(w.internalId);
        if (adopted[id]) { log("adopt-duplicate", id); return; }
        adopted[id] = true;
        const gen = generation;
        own(w.frameGeometryChanged, function () {
            if (!alive || gen !== generation) { console.info("PLT-LC stale-geometry-rejected " + instance); return; }
            log("geometry", id);
        }, id);
        log("adopt", id + " connections=" + connections.length);
    }

    function onWindowAdded(w) { if (alive) adopt(w); }

    function onWindowRemoved(w) {
        if (!alive || !w) return;
        const id = String(w.internalId);
        if (!adopted[id]) return;
        delete adopted[id];
        const released = releaseScope(id);
        log("remove", id + " released=" + released + " connections=" + connections.length);
    }

    ShortcutHandler {
        id: ping
        name: "plastile-probe-lifecycle-ping"
        text: "Plastile lifecycle probe ping"
        sequence: ""
        onActivated: {
            if (!root.alive) { console.info("PLT-LC stale-shortcut-rejected " + root.instance); return; }
            root.shortcutCount++;
            root.log("shortcut", "n=" + root.shortcutCount);
            root.pendingPings++;
            root.scheduleFlush();
            deadline.restart();
        }
    }

    // Owned bounded deadline (stands in for a convergence deadline). Never repeats.
    Timer {
        id: deadline
        interval: 250
        repeat: false
        onTriggered: {
            if (!root.alive) { console.info("PLT-LC stale-timer-rejected " + root.instance); return; }
            root.log("deadline", "gen=" + root.generation);
        }
    }

    Component.onCompleted: {
        alive = true;
        generation = 1;
        own(Workspace.windowAdded, root.onWindowAdded, "workspace");
        own(Workspace.windowRemoved, root.onWindowRemoved, "workspace");
        if (leakControl) {
            const inst = instance;
            Workspace.windowAdded.connect(function (w) { console.info("PLT-LC leak-closure-fired " + inst); });
        }
        const existing = Workspace.windows;
        for (let i = 0; i < existing.length; ++i) adopt(existing[i]);
        log("start", "connections=" + connections.length + " leakControl=" + leakControl);
    }

    Component.onDestruction: {
        // Race a deferred callback against destruction: an unload D-Bus call is
        // handled in a later event-loop turn than an earlier Qt.callLater, so queue
        // one here deliberately to prove the liveness guard rejects it.
        const deadlineWasRunning = deadline.running;
        Qt.callLater(root.flush);
        // Invalidate first, then release resources.
        alive = false;
        generation++;
        deadline.stop();
        const released = releaseScope(null);
        adopted = ({});
        log("teardown", "released=" + released + " remaining=" + connections.length
            + " racingFlushQueued=true deadlineWasRunning=" + deadlineWasRunning);
    }
}
