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

    // ---- D-Bus calls and the inspector (T26 shortcut report, T28 explain view, D9 reload, the OSD) ----
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
        var props = { service: call.service, path: call.path, dbusInterface: call.iface, method: call.method,
                      done: done, fail: fail };
        if (call.args) props.arguments = call.args; // as Persistence.qml passes them
        var c = busCall.createObject(root, props);
        c.call();
    }
    // No inspector object exists until "Explain active window" opens it; closing destroys it.
    // Inspector.qml and ZoneOverlay.qml are compiled with this file, not read on first use: KWin
    // keeps a loaded script's compiled files until it restarts, so a session keeps one version
    // of each after an upgrade or a removal changes the files on disk. Creation is asynchronous,
    // off the command's call.
    property var inspectorView: null
    Component {
        id: inspectorType
        Inspector { view: root.inspectorView }
    }
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
        inspectorView = view;
        inspector.sourceComponent = inspectorType;
        inspector.active = true;
    }
    function closeInspector() {
        inspector.sourceComponent = undefined;
        inspector.active = false;
    }
    // ---- end T26/T28/D9 ----

    // ---- zones overlay (M9, experimental; docs/design/ZONES.md §4) ----
    // Nothing exists until the first "Zones: show or hide the zone overlay"; it is then hidden and
    // shown again (Escape, a click, or the command hides it) and destroyed on unload.
    property bool zonesWanted: false
    property var zonesView: null
    Component {
        id: zoneOverlayType
        ZoneOverlay { view: root.zonesView }
    }
    Loader {
        id: zoneOverlay
        active: false
        asynchronous: true
        onLoaded: if (root.zonesWanted) item.showOverlay()
    }
    Connections {
        target: zoneOverlay.item
        ignoreUnknownSignals: true
        function onDismissed() { Qt.callLater(root.hideZones); }
    }
    function showZones(view) {
        zonesWanted = true;
        zonesView = view;
        if (zoneOverlay.item) { zoneOverlay.item.showOverlay(); return; }
        zoneOverlay.sourceComponent = zoneOverlayType;
        zoneOverlay.active = true;
    }
    function hideZones() {
        zonesWanted = false;
        if (zoneOverlay.item) zoneOverlay.item.hideOverlay();
    }
    function destroyZones() {
        zonesWanted = false;
        zoneOverlay.sourceComponent = undefined;
        zoneOverlay.active = false;
    }
    // ---- end zones overlay ----

    // ---- persistence (T27, ADR-020): asynchronous calls to the plastile-state helper and the
    // one-shot maintenance timer; no file I/O in KWin ----
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
            zones: {
                show: root.showZones,
                hide: root.hideZones,
                destroy: root.destroyZones,
                state: function () { return !zoneOverlay.active ? "absent" : root.zonesWanted ? "shown" : "hidden"; },
            },
            state: persistence,
        });
    }

    Component.onDestruction: {
        deadline.stop();
        closeInspector();
        destroyZones();
        if (runtime) runtime.shutdown();
        runtime = null;
    }
}
