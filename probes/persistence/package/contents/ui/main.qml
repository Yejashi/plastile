// T27/E12 probe: can a KWin declarative script persist data through QtCore's
// Settings type (a public Qt API), without a helper process? Each load reads the
// previous value, increments it and writes a JSON blob, then syncs.
import QtQuick
import QtCore
import org.kde.kwin

Item {
    Settings {
        id: st
        location: StandardPaths.writableLocation(StandardPaths.GenericStateLocation) + "/plastile-probe/state.ini"
        category: "probe"
        property int counter: 0
        property string json: ""
    }
    Component.onCompleted: {
        console.info("PLT persistence " + JSON.stringify({
            phase: "loaded", counter: st.counter, json: st.json, location: String(st.location) }));
        st.counter = st.counter + 1;
        st.json = JSON.stringify({ v: 1, ratio: 0.6, layouts: { "Virtual-0": "bsp" } });
        st.sync();
        console.info("PLT persistence " + JSON.stringify({ phase: "synced", counter: st.counter }));
    }
}
