WorkerScript.onMessage = function (m) {
    WorkerScript.sendMessage({ phase: "caps", xhr: typeof XMLHttpRequest, qt: typeof Qt,
        localStorage: typeof (typeof LocalStorage === "undefined" ? undefined : LocalStorage) });
    try {
        const x = new XMLHttpRequest();
        x.open("PUT", m.dir + "xhr-" + m.tag + ".txt", false);
        x.send(m.text);
        WorkerScript.sendMessage({ phase: "xhr-put", status: x.status, readyState: x.readyState });
    } catch (e) { WorkerScript.sendMessage({ phase: "xhr-put", ok: false, error: String(e) }); }
};
