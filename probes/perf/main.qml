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
            onActivated: if (root.runtime) root.runtime.dispatch(modelData.id)
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
            clockNs: function () { return MonotonicClock.nowNs(); },
            perf: true,
        });
    }

    Component.onDestruction: {
        deadline.stop();
        if (runtime) runtime.shutdown();
        runtime = null;
        Options.configChanged.disconnect(root.markConfigChanged);
    }
}
