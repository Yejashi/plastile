// M1 spike core (T05/T06), shared by the direct and native spikes.
//
// Deliberately small and isolated from production code (roadmap M1): fixture
// windows only, one output/desktop context, master/stack with one master.
// The backend object supplied by each spike's main.qml applies plans.
//
// Backend contract:
//   backend.adopt(rec), backend.release(rec)
//   backend.apply(plan)   plan = [{rec, rect}] in layout order; rects are frame targets
//   backend.counters()    -> backend-specific counters
//   backend.teardown()

var S = null; // spike state, created by init()

function rect(x, y, w, h) { return { x: x, y: y, width: w, height: h }; }
function rectOf(r) { return { x: r.x, y: r.y, width: r.width, height: r.height }; }
function near(a, b) {
    return a !== null && b !== null && Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5
        && Math.abs(a.width - b.width) <= 0.5 && Math.abs(a.height - b.height) <= 0.5;
}

// Shared-cut master/stack. Gaps: outer around the area, inner between tiles.
function masterStack(area, n, ratio, outer, inner) {
    var out = [];
    if (n === 0) return out;
    var x0 = area.x + outer, y0 = area.y + outer;
    var x1 = area.x + area.width - outer, y1 = area.y + area.height - outer;
    if (n === 1) { out.push(rect(x0, y0, x1 - x0, y1 - y0)); return out; }
    var cut = Math.round(x0 + (x1 - x0 - inner) * ratio);
    out.push(rect(x0, y0, cut - x0, y1 - y0));
    var sx = cut + inner, k = n - 1;
    var span = y1 - y0 - inner * (k - 1);
    var prev = y0;
    for (var i = 0; i < k; ++i) {
        var end = i === k - 1 ? y1 : Math.round(y0 + span * (i + 1) / k + inner * i);
        out.push(rect(sx, prev, x1 - sx, end - prev));
        prev = end + inner;
    }
    return out;
}

function init(ws, kwin, qt, backend, log) {
    S = {
        ws: ws, qt: qt, backend: backend, log: log,
        alive: true, epoch: 1,
        fixtureClass: kwin.readConfig("fixtureClass", "plastile-fixture"),
        outer: 4, inner: 8, ratio: 0.55,
        order: [],            // ids in layout order (tiled + suspended)
        recs: {},             // id -> rec
        connections: [],      // {signal, fn}
        dirty: false, flushScheduled: false, applying: 0,
        counters: { solves: 0, flushes: 0, commands: 0, focusCommands: 0, adopted: 0, removed: 0,
                    suspended: 0, yielded: 0, errors: 0 },
    };
    own(ws.windowAdded, onWindowAdded);
    own(ws.windowRemoved, onWindowRemoved);
    var all = ws.windows;
    var initial = [];
    for (var i = 0; i < all.length; ++i) initial.push(all[i]);
    // Deterministic initial order: by caption (fixtures are "plastile-fixture <id>").
    initial.sort(function (a, b) { return a.caption < b.caption ? -1 : a.caption > b.caption ? 1 : 0; });
    for (var j = 0; j < initial.length; ++j) adopt(initial[j]);
    markDirty();
}

function own(signal, fn) { signal.connect(fn); S.connections.push({ signal: signal, fn: fn }); }

function eligible(w) {
    return w && w.resourceClass === S.fixtureClass && w.normalWindow && !w.transient && w.resizeable;
}

function adopt(w) {
    if (!eligible(w)) return;
    var id = String(w.internalId);
    if (S.recs[id]) return;
    // A window the user quick-tiled natively before adoption stays native (yield).
    if (w.tile !== null) { S.counters.yielded++; return; }
    var rec = { id: id, w: w, gen: S.epoch, suspended: suspendedNow(w), yielded: false, conns: [] };
    S.recs[id] = rec;
    S.order.push(id);
    S.counters.adopted++;
    var watch = function (signal) {
        var fn = function () { onStateChanged(rec); };
        signal.connect(fn); rec.conns.push({ signal: signal, fn: fn });
    };
    watch(w.fullScreenChanged); watch(w.minimizedChanged); watch(w.maximizedChanged); watch(w.outputChanged);
    var tileFn = function () { onTileChanged(rec); };
    w.tileChanged.connect(tileFn); rec.conns.push({ signal: w.tileChanged, fn: tileFn });
    S.backend.adopt(rec);
    markDirty();
}

function suspendedNow(w) { return w.minimized || w.fullScreen || w.maximizeMode !== 0; }

function forget(rec, why) {
    for (var i = rec.conns.length - 1; i >= 0; --i) rec.conns[i].signal.disconnect(rec.conns[i].fn);
    rec.conns = [];
    S.backend.release(rec);
    delete S.recs[rec.id];
    var k = S.order.indexOf(rec.id);
    if (k >= 0) S.order.splice(k, 1);
    S.counters[why]++;
    markDirty();
}

function onWindowAdded(w) { if (S.alive) adopt(w); }
function onWindowRemoved(w) {
    if (!S.alive || !w) return;
    var rec = S.recs[String(w.internalId)];
    if (rec) forget(rec, "removed"); // structural: never dropped, even during apply
}
function onStateChanged(rec) {
    if (!S.alive || !S.recs[rec.id]) return;
    var s = suspendedNow(rec.w);
    if (s !== rec.suspended) { rec.suspended = s; S.counters.suspended++; markDirty(); }
}
function onTileChanged(rec) {
    if (!S.alive || !S.recs[rec.id]) return;
    if (S.backend.ownsTile && S.backend.ownsTile(rec)) return;
    // Native quick tile or native editor association: yield this window.
    if (rec.w.tile !== null) { rec.yielded = true; forget(rec, "yielded"); }
}

function markDirty() {
    S.dirty = true;
    if (!S.flushScheduled) { S.flushScheduled = true; S.qt.callLater(flush); }
}

function flush() {
    if (!S || !S.alive) return;
    S.flushScheduled = false;
    S.counters.flushes++;
    if (S.dirty) solveAndApply();
}

function tiledIds() {
    var out = [];
    for (var i = 0; i < S.order.length; ++i) {
        var r = S.recs[S.order[i]];
        if (r && !r.suspended) out.push(r.id);
    }
    return out;
}

function area() {
    var o = S.ws.screens[0];
    return S.ws.clientArea(S.ws.PlacementArea, o, S.ws.currentDesktopForScreen(o));
}

function solveAndApply() {
    S.dirty = false;
    S.counters.solves++;
    var ids = tiledIds();
    var rects = masterStack(area(), ids.length, S.ratio, S.outer, S.inner);
    var plan = [];
    for (var i = 0; i < ids.length; ++i) plan.push({ rec: S.recs[ids[i]], rect: rects[i] });
    S.applying++;
    try { S.backend.apply(plan); }
    catch (e) { S.counters.errors++; S.log("error", { where: "apply", e: String(e) }); }
    finally { S.applying--; }
}

// ------------------------------------------------------------------ commands
function command(name) {
    if (!S || !S.alive) return;
    S.counters.commands++;
    var ids = tiledIds();
    if (name === "ratio-up") { S.ratio = Math.min(0.85, S.ratio + 0.05); solveAndApply(); }
    else if (name === "ratio-down") { S.ratio = Math.max(0.15, S.ratio - 0.05); solveAndApply(); }
    else if (name === "swap") {
        if (ids.length >= 2) {
            var a = S.order.indexOf(ids[0]), b = S.order.indexOf(ids[1]);
            var t = S.order[a]; S.order[a] = S.order[b]; S.order[b] = t;
        }
        solveAndApply();
    }
    else if (name === "noop") { solveAndApply(); }
    else if (name === "focus-next") {
        // Focus-only: no solve, no geometry.
        S.counters.focusCommands++;
        var active = S.ws.activeWindow ? String(S.ws.activeWindow.internalId) : null;
        var k = ids.indexOf(active);
        var next = ids.length ? S.recs[ids[(k + 1) % ids.length]] : null;
        if (next) S.ws.activeWindow = next.w;
    }
}

function snapshot() {
    var c = {};
    for (var k in S.counters) c[k] = S.counters[k];
    var b = S.backend.counters();
    for (var k2 in b) c[k2] = b[k2];
    c.tiled = tiledIds().length;
    c.ratio = S.ratio;
    return c;
}

function teardown() {
    if (!S) return;
    S.alive = false;
    S.epoch++;
    var ids = Object.keys(S.recs);
    for (var i = 0; i < ids.length; ++i) {
        var rec = S.recs[ids[i]];
        for (var j = rec.conns.length - 1; j >= 0; --j) rec.conns[j].signal.disconnect(rec.conns[j].fn);
        rec.conns = [];
    }
    for (var k = S.connections.length - 1; k >= 0; --k) S.connections[k].signal.disconnect(S.connections[k].fn);
    S.connections = [];
    try { S.backend.teardown(); } catch (e) { S.log("error", { where: "teardown", e: String(e) }); }
    S.recs = {}; S.order = [];
}
