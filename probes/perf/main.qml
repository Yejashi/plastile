// MEASUREMENT-ONLY root (probes/perf): the production bundle plus the test clock.
// Never installed. Requires QML_IMPORT_PATH=build/measure/qml (nested sessions).
// Like the production root (package/contents/ui/main.qml) it owns the deadline Timer, one
// ShortcutHandler per command and the persistence store (Persistence.qml: the plastile-state
// helper over asynchronous D-Bus), so a command's work, persistence bookkeeping included, is
// the production path. It has no inspector, zones overlay or D-Bus reload hooks; none of
// them runs on a measured command.
import QtQuick
import QtQml
import org.kde.kwin
import Plastile.Measure
import "../../package/contents/code/plastile.mjs" as Bundle
import "../../package/contents/ui" as Production

Item {
    id: root
    property var runtime: null
    // PERFORMANCE §6 item 6: measureInstrumented=false in [Script-plastile] runs the bundle
    // without its own instrumentation (no clockNs, no per-command perf lines), the way the
    // production root does. Both settings record the same outer span around dispatch():
    // two clock reads per command, kept in memory and printed only on plastile-measure-dump.
    readonly property bool instrumented: String(KWin.readConfig("measureInstrumented", "true")) !== "false"
    property var outer: []

    // Measurement markers (probes/perf/workloads.py P13): CLOCK_MONOTONIC when KWin
    // emits Options.configChanged (connected before the runtime, so it runs first)
    // and when the runtime reports the activation. Disconnected in teardown.
    function markConfigChanged() { console.info("plastile-measure configChanged " + MonotonicClock.nowNs()); }

    Timer {
        id: deadline
        repeat: false
        onTriggered: if (root.runtime) root.runtime.onDeadline()
    }

    Instantiator {
        model: Bundle.COMMANDS
        delegate: ShortcutHandler {
            name: modelData.id
            text: modelData.text
            sequence: modelData.sequence
            onActivated: {
                if (!root.runtime) return;
                var t0 = MonotonicClock.nowNs();
                root.runtime.dispatch(modelData.id);
                var t1 = MonotonicClock.nowNs();
                root.outer.push([modelData.id, t0, t1 - t0]);
            }
        }
    }

    // Export the outer spans after a measured block, in chunks, then forget them.
    ShortcutHandler {
        name: "plastile-measure-dump"
        text: "Plastile measurement: dump outer dispatch spans"
        sequence: ""
        onActivated: {
            var all = root.outer;
            root.outer = [];
            for (var i = 0; i < all.length; i += 200)
                console.info("plastile-measure outer " + JSON.stringify(all.slice(i, i + 200)));
            console.info("plastile-measure outer-end " + all.length);
        }
    }

    // Clock calibration in this engine: back-to-back reads give the cost of one read (the
    // effective resolution of every span above); clock_getres gives the kernel's.
    ShortcutHandler {
        name: "plastile-measure-calibrate"
        text: "Plastile measurement: clock calibration"
        sequence: ""
        onActivated: {
            var n = 5000, d = [], prev = MonotonicClock.nowNs();
            for (var i = 0; i < n; ++i) { var t = MonotonicClock.nowNs(); d.push(t - prev); prev = t; }
            d.sort(function (a, b) { return a - b; });
            console.info("plastile-measure calibrate " + JSON.stringify({ resolutionNs: MonotonicClock.resolutionNs(), n: n,
                min: d[0], p50: d[n >> 1], p99: d[Math.floor(n * 0.99)], max: d[n - 1], nowNs: prev,
                exactAsDouble: prev < 9007199254740992 }));
        }
    }

    Production.Persistence { id: persistence }

    Component.onCompleted: {
        Options.configChanged.connect(root.markConfigChanged);
        runtime = Bundle.createRuntime({
            workspace: Workspace,
            kwin: KWin,
            qt: Qt,
            options: Options,
            setDeadline: function (ms) { deadline.interval = ms; deadline.restart(); },
            clearDeadline: function () { deadline.stop(); },
            print: function (line) {
                console.info(line);
                if (/^plastile (info|error) configuration (activated|rejected)/.test(line))
                    console.info("plastile-measure configuration " + MonotonicClock.nowNs());
            },
            clockNs: root.instrumented ? function () { return MonotonicClock.nowNs(); } : undefined,
            perf: root.instrumented,
            state: persistence,
        });
        console.info("plastile-measure instrumented " + root.instrumented);
    }

    Component.onDestruction: {
        deadline.stop();
        if (runtime) runtime.shutdown();
        runtime = null;
        Options.configChanged.disconnect(root.markConfigChanged);
    }
}
