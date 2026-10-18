// Saved session preferences (T27, ADR-020): a thin asynchronous store over KWin's DBusCall
// (org.kde.kwin 3.0) and the one-shot maintenance Timer. The plastile-state helper
// (org.kde.plastile.State, D-Bus activated, installed separately) owns the two slot files under
// $XDG_STATE_HOME/plastile/; nothing here touches a file. Policy lives in
// src/runtime/persistence.ts; this file only sends what it is asked to.
//
// One DBusCall per request, destroyed with its reply. call() sends the message at once
// (QDBusConnection::asyncCall), so a Write issued while the script unloads is still delivered;
// requests still pending at unload are destroyed with this item, and their replies are dropped.
// Without the helper the bus answers ServiceUnknown: failed(), and Plastile keeps its
// preferences in memory.
import QtQuick
import org.kde.kwin

Item {
    id: persistence
    property var due: null

    Timer {
        id: maintenance
        repeat: false
        onTriggered: { var f = persistence.due; persistence.due = null; if (f) f(); }
    }

    Component {
        id: request
        DBusCall {
            service: "org.kde.plastile.State"
            path: "/State"
            dbusInterface: "org.kde.plastile.State"
            property var done: null
            property var fail: null
            onFinished: function (reply) { var f = done; done = null; fail = null; destroy(); if (f) f(reply); }
            onFailed: { var f = fail; done = null; fail = null; destroy(); if (f) f(); }
        }
    }

    function send(method, args, done, fail) {
        var c = request.createObject(persistence, { method: method, arguments: args, done: done, fail: fail });
        c.call();
    }
    // done(texts): the reply's single "as" argument, an array-like of two strings.
    function read(done, fail) {
        send("Read", [], function (reply) {
            if (reply && reply.length > 0) done(reply[0]); else fail();
        }, fail);
    }
    // done(ok): true once the helper stored the slot. `slot | 0` keeps the D-Bus type an int ("i").
    function write(slot, text, done) {
        send("Write", [slot | 0, String(text)], function (reply) {
            done(!!(reply && reply.length > 0 && reply[0] === true));
        }, function () { done(false); });
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
