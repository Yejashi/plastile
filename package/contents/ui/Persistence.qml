// Saved session preferences (T27, ADR-013): two QtCore Settings files ("slots") under
// $XDG_STATE_HOME/plastile/ and the one-shot maintenance Timer that writes them. Policy lives
// in src/runtime/persistence.ts; this file only does the I/O it is asked for.
//
// QtCore is optional. It is imported only inside Qt.createQmlObject, so without the module
// open() returns the error and Plastile keeps its preferences in memory. Settings always gets
// an explicit location: its default would write KWin's own kde.org/kwin.conf.
import QtQuick

Item {
    id: persistence
    property var slots: []
    property var due: null

    Timer {
        id: maintenance
        repeat: false
        onTriggered: { var f = persistence.due; persistence.due = null; if (f) f(); }
    }

    function open() {
        if (slots.length > 0) return "";
        var made = [];
        try {
            for (var i = 0; i < 2; ++i) {
                made.push(Qt.createQmlObject("import QtCore\nSettings {\n"
                    + "  location: StandardPaths.writableLocation(StandardPaths.GenericStateLocation) + \"/plastile/state-" + i + ".ini\"\n"
                    + "  category: \"plastile\"\n}\n", persistence, "plastile-state-" + i));
            }
        } catch (e) {
            for (var j = 0; j < made.length; ++j) made[j].destroy();
            var why = e && e.qmlErrors && e.qmlErrors.length ? e.qmlErrors[0].message : String(e);
            return why || "Settings could not be created";
        }
        slots = made;
        return "";
    }
    function location() { return slots.length > 0 ? String(slots[0].location) : ""; }
    function read(slot) {
        var v = slots[slot].value("snapshot", "");
        return v === undefined || v === null ? "" : String(v);
    }
    function write(slot, text) {
        slots[slot].setValue("snapshot", text);
        slots[slot].sync();
    }
    function schedule(ms, fn) {
        due = fn;
        maintenance.interval = ms;
        maintenance.restart();
    }
    function cancel() {
        maintenance.stop();
        due = null;
    }

    Component.onDestruction: cancel()
}
