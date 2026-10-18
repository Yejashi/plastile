// Plastile declarative root. Owns: one ShortcutHandler per command id, the single
// deadline Timer (only running while geometry requests are outstanding), the state
// persistence item (Persistence.qml), and the runtime instance. All policy lives in
// the bundled TypeScript core.
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

    // ---- D-Bus calls and the inspector (T26 shortcut report, T28 explain view, D9 reload) ----
    // One DBusCall (org.kde.kwin 3.0, asynchronous) per request, destroyed with its reply;
    // calls still pending at unload are destroyed with this root, so no reply outlives it.
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
    // No inspector object exists until "Explain active window" opens it; closing destroys it.
    // Asynchronous: reading and compiling Inspector.qml happen off the command's call.
    Loader {
        id: inspector
        active: false
        asynchronous: true
        onLoaded: item.show()
    }
    Connections {
        target: inspector.item
        ignoreUnknownSignals: true
        function onDismissed() { Qt.callLater(root.closeInspector); }
    }
    function openInspector(view) {
        inspector.active = true;
        inspector.setSource("Inspector.qml", { view: view });
    }
    function closeInspector() {
        inspector.source = "";
        inspector.active = false;
    }
    // ---- end T26/T28/D9 ----

    // ---- persistence (T27, ADR-013): state slots and their one-shot maintenance timer ----
    Persistence { id: persistence }
    // ---- end T27 ----

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
            inspector: {
                open: root.openInspector,
                close: root.closeInspector,
                isOpen: function () { return inspector.active; },
            },
            state: persistence,
        });
    }

    Component.onDestruction: {
        deadline.stop();
        closeInspector();
        if (runtime) runtime.shutdown();
        runtime = null;
    }
}
