// RECORDING-ONLY root (tools/replay, T10): the production bundle with the replay recorder on.
// Never installed. Loaded by tests/integration/scenarios_replay.py into a disposable nested
// KWin; at unload the runtime prints "plastile replay <json>" (src/runtime/replay.ts).
// Unlike package/contents/ui/main.qml it has no persistence store (a restored preference would
// not be part of the recorded stream), no inspector and no zones overlay.
import QtQuick
import QtQml
import org.kde.kwin
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

    Component {
        id: busCall
        DBusCall {
            property var done: null
            property var fail: null
            onFinished: function (reply) { var f = done; destroy(); if (f) f(reply); }
            onFailed: { var f = fail; destroy(); if (f) f(); }
        }
    }
    function dbus(call, done, fail) {
        var c = busCall.createObject(root, { service: call.service, path: call.path, dbusInterface: call.iface,
                                             method: call.method, done: done, fail: fail });
        c.call();
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
            dbus: root.dbus,
            record: {},
        });
    }

    Component.onDestruction: {
        deadline.stop();
        if (runtime) runtime.shutdown();
        runtime = null;
    }
}
