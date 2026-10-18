// MEASUREMENT-ONLY root (T27 cost, command phase): the production bundle and Persistence.qml
// with the CLOCK_MONOTONIC measurement module, so each command's handler interval
// (plastile perf: entryNs, dispatchToReturnNs) shares a clock with the harness's inotify
// timestamps of the state directory. Never installed. Requires QML_IMPORT_PATH=build/measure/qml.
import QtQuick
import QtQml
import org.kde.kwin
import Plastile.Measure
import "../../../package/contents/code/plastile.mjs" as Bundle
import "../../../package/contents/ui" as Pkg

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

    Pkg.Persistence { id: persistence }

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
            state: persistence,
        });
    }

    Component.onDestruction: {
        deadline.stop();
        if (runtime) runtime.shutdown();
        runtime = null;
    }
}
