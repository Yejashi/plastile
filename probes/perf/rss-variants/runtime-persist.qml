// MEASUREMENT-ONLY root variant (probes/perf/rss_bisect.py): the runtime, its deadline Timer and the
// production persistence store, without shortcuts, for the reload memory bisection. Never installed.
import QtQuick
import QtQml
import org.kde.kwin
import "../../../package/contents/code/plastile.mjs" as Bundle
import "../../../package/contents/ui" as Production

Item {
    id: root
    property var runtime: null
    Timer { id: deadline; repeat: false; onTriggered: if (root.runtime) root.runtime.onDeadline() }
    Production.Persistence { id: persistence }
    Component.onCompleted: {
        runtime = Bundle.createRuntime({ workspace: Workspace, kwin: KWin, qt: Qt, options: Options,
            setDeadline: function (ms) { deadline.interval = ms; deadline.restart(); }, clearDeadline: function () { deadline.stop(); },
            print: function (line) { console.info(line); }, state: persistence });
    }
    Component.onDestruction: { deadline.stop(); if (runtime) runtime.shutdown(); runtime = null; }
}
