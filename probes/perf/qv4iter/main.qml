// QV4 side of probes/perf/qv4iter: prints the visit orders of cases.js as one JSON line and quits.
// Run with the qml tool on the offscreen platform (no compositor, no KWin).
import QtQml
import "cases.js" as Cases

QtObject {
    Component.onCompleted: {
        console.warn("qv4iter " + JSON.stringify(Cases.results()));
        Qt.exit(0);
    }
}
