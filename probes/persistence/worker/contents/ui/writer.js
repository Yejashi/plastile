.import QtQuick.LocalStorage 2.15 as Sql

WorkerScript.onMessage = function (m) { work(m, function (o) { WorkerScript.sendMessage(o); }); };

function work(m, send) {
    var sql = typeof Sql === "undefined" ? undefined : Sql;
    send({ phase: "caps", xhr: typeof XMLHttpRequest, sql: typeof sql,
           openDb: typeof (sql && sql.LocalStorage && sql.LocalStorage.openDatabaseSync) });
    try {
        var t0 = Date.now();
        var db = sql.LocalStorage.openDatabaseSync("plastile-probe", "1", "probe", 1000000);
        db.transaction(function (tx) {
            tx.executeSql("CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)");
            tx.executeSql("INSERT OR REPLACE INTO kv VALUES(?, ?)", ["snapshot", m.text]);
        });
        var back = "";
        db.readTransaction(function (tx) { back = tx.executeSql("SELECT v FROM kv WHERE k = 'snapshot'").rows.item(0).v; });
        send({ phase: "sql", ok: back.length === m.text.length, ms: Date.now() - t0 });
    } catch (e) { send({ phase: "sql", ok: false, error: String(e) }); }
    try {
        var x = new XMLHttpRequest();
        x.open("PUT", m.dir + "xhr-" + m.tag + ".txt", false);
        x.send(m.text);
        send({ phase: "xhr-put", status: x.status, readyState: x.readyState });
    } catch (e2) { send({ phase: "xhr-put", ok: false, error: String(e2) }); }
    var b0 = Date.now(); while (Date.now() - b0 < m.busyMs) {} // the main thread must keep ticking meanwhile
    send({ phase: "busy-done", startedAt: b0, ms: Date.now() - b0 });
}
