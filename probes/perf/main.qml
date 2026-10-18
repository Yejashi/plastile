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
        runtime = Bundle.createRuntime({
            workspace: Workspace,
            kwin: KWin,
            qt: Qt,
            options: Options,
            setDeadline: function (ms) { deadline.interval = ms; deadline.restart(); },
            clearDeadline: function () { deadline.stop(); },
            print: function (line) { console.info(line); },
            clockNs: function () { return MonotonicClock.nowNs(); },
            perf: true,
        });
    }

    Component.onDestruction: {
        deadline.stop();
        if (runtime) runtime.shutdown();
        runtime = null;
    }
}
