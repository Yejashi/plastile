// Plastile declarative root. Owns: one ShortcutHandler per command id, the single
// deadline Timer (only running while geometry requests are outstanding), and the
// runtime instance. All policy lives in the bundled TypeScript core.
import QtQuick
import QtQml
import org.kde.kwin
import "../code/plastile.mjs" as Bundle

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
        });
    }

    Component.onDestruction: {
        deadline.stop();
        if (runtime) runtime.shutdown();
        runtime = null;
    }
}
