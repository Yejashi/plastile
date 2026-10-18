// MEASUREMENT-ONLY root (probes/perf): the production bundle plus the test clock.
// Never installed. Requires QML_IMPORT_PATH=build/measure/qml (nested sessions).
import QtQuick
import QtQml
import org.kde.kwin
import Plastile.Measure
import "../../package/contents/code/plastile.mjs" as Bundle

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
