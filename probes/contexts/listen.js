// Plastile contexts probe: passive signal listener (plain-JS KWin script, nested sessions only).
// Logs the argument shapes of the desktop/activity signals as "PLT-LISTEN <name> <json>".
// It never changes state. Load with NestedKwin.load_script and unload before the session ends.
function d(x) {
    if (x === undefined) return "undefined";
    if (x === null) return null;
    if (typeof x !== "object") return x;
    var o = {};
    if (x.id !== undefined) o.id = String(x.id);
    if (x.name !== undefined) o.name = String(x.name);
    if (x.x11DesktopNumber !== undefined) o.x11DesktopNumber = x.x11DesktopNumber;
    o.type = String(x).replace(/\(0x[0-9a-f]+\)/, "");
    return o;
}
function args(a) { var out = []; for (var i = 0; i < a.length; ++i) out.push(d(a[i])); return out; }
function perScreen() {
    return workspace.screens.map(function (o) {
        var c = workspace.currentDesktopForScreen(o);
        return o.name + "=" + (c ? c.name : null);
    });
}
function log(name, a) {
    print("PLT-LISTEN " + name + " " + JSON.stringify({ args: args(a), currentDesktop: workspace.currentDesktop ? workspace.currentDesktop.name : null,
        perScreen: perScreen(), currentActivity: String(workspace.currentActivity),
        activities: Array.from(workspace.activities).map(String) }));
}
workspace.currentDesktopChanged.connect(function () { log("currentDesktopChanged", arguments); });
workspace.desktopsChanged.connect(function () { log("desktopsChanged", arguments); });
workspace.currentActivityChanged.connect(function () { log("currentActivityChanged", arguments); });
workspace.activitiesChanged.connect(function () { log("activitiesChanged", arguments); });
workspace.activityAdded.connect(function () { log("activityAdded", arguments); });
workspace.activityRemoved.connect(function () { log("activityRemoved", arguments); });
function watch(w) {
    if (w.resourceClass !== "plastile-fixture") return;
    w.activitiesChanged.connect(function () {
        print("PLT-LISTEN windowActivitiesChanged " + JSON.stringify({ caption: w.caption, argc: arguments.length,
            activities: Array.from(w.activities).map(String) }));
    });
}
workspace.windowList().forEach(watch);
workspace.windowAdded.connect(watch);
print("PLT-LISTEN ready {}");
