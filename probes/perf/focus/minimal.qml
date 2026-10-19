// MEASUREMENT-ONLY minimal activation script (probes/perf/focus): never installed. Requires
// QML_IMPORT_PATH=build/measure/qml (nested sessions only).
// One ShortcutHandler, the same script path Plastile's commands take (kglobalaccel ->
// ShortcutHandler.activated in KWin's QML engine), whose only work is to pick the next fixture
// window shown on the current desktop by caption and assign workspace.activeWindow: the script-side activation with nothing
// else around it. Logs CLOCK_MONOTONIC at handler entry and after the assignment returned.
import QtQuick
import org.kde.kwin
import Plastile.Measure

Item {
    ShortcutHandler {
        name: "plastile-focus-minimal-next"
        text: "Plastile measurement: minimal focus next"
        sequence: "Meta+Shift+U"
        onActivated: {
            var t0 = MonotonicClock.nowNs();
            var list = Workspace.windows;
            var fx = [];
            for (var i = 0; i < list.length; ++i) {
                var w = list[i];
                if (w.resourceClass === "plastile-fixture" && !w.minimized && w.output === Workspace.activeScreen
                        && w.desktops.indexOf(Workspace.currentDesktop) >= 0) fx.push(w);
            }
            fx.sort(function (a, b) { return a.caption < b.caption ? -1 : a.caption > b.caption ? 1 : 0; });
            if (fx.length < 2) return;
            var cur = fx.indexOf(Workspace.activeWindow);
            var next = fx[(cur + 1) % fx.length];
            var t1 = MonotonicClock.nowNs();
            Workspace.activeWindow = next;
            var t2 = MonotonicClock.nowNs();
            console.info("plastile-focus minimal " + t0 + " " + (t1 - t0) + " " + (t2 - t1));
        }
    }
}
