// MEASUREMENT-ONLY observer (probes/perf/focus): never installed. Requires
// QML_IMPORT_PATH=build/measure/qml (nested sessions only).
// Logs CLOCK_MONOTONIC when KWin emits Workspace.windowActivated (inside
// Workspace::setActiveWindow, synchronously with the activation, whoever asked for it), and when
// a 0 ms timer started there fires: KWin's xdg configure is sent from a 0 ms single-shot timer
// started a moment earlier in the same activation (XdgSurfaceWindow::scheduleConfigure), so this
// timer runs right after it, on the same event-loop turn.
import QtQuick
import org.kde.kwin
import Plastile.Measure

Item {
    id: root
    property string lastCaption: ""
    property double activatedNs: 0

    Timer {
        id: after
        interval: 0
        repeat: false
        onTriggered: console.info("plastile-focus turn " + MonotonicClock.nowNs() + " " + root.activatedNs)
    }

    Connections {
        target: Workspace
        function onWindowActivated(w) {
            var t = MonotonicClock.nowNs();
            root.activatedNs = t;
            console.info("plastile-focus activated " + t + " " + (w ? w.caption : "null"));
            after.restart();
        }
    }
}
