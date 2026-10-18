// M1 native-tile backend (T06): projects the spike plan into a native root.
//
// Root: Workspace.rootTile(screens[0], current desktop) of a DISPOSABLE nested
// session. Structure: root(horizontal) = [master leaf, stack], where the stack
// is a leaf (2 windows) or a vertical layout of leaves (3+). Nodes stay stable
// across ratio/swap/no-op; structure changes only when the window count does.
// Window frames come from KWin (tile geometry inset by tile padding); the plan's
// rects are used only to derive the master/stack boundary so both spikes target
// the same frames (padding p == direct outer gap, 2p == direct inner gap).

var N = null;
var HORIZONTAL = 1, VERTICAL = 2, RIGHT_EDGE = 4;

function create(qt, clock, log, near, rectOf, ws) {
    N = {
        qt: qt, clock: clock, log: log, near: near, rectOf: rectOf, ws: ws,
        root: null, master: null, stack: null, leaves: [], built: -1, recs: {}, owned: {},
        tileConns: [], seq: 0, pending: {},
        c: { nativeSplit: 0, nativeRemove: 0, nativeResize: 0, nativeRelGeomWrites: 0, nativeManage: 0,
             nativeUnmanage: 0, manageRejected: 0, tileGeometrySignals: 0, tileWindowSignals: 0,
             observations: 0, settled: 0, writes: 0 },
    };
    return { adopt: adopt, release: release, apply: apply, counters: counters, teardown: teardown,
             ownsTile: ownsTile };
}

function rootTile() {
    var o = N.ws.screens[0];
    return N.ws.rootTile(o, N.ws.currentDesktopForScreen(o));
}

function watchTile(t) {
    var g = function () { N.c.tileGeometrySignals++; };
    var w = function () { N.c.tileWindowSignals++; };
    t.relativeGeometryChanged.connect(g); t.windowsChanged.connect(w);
    N.tileConns.push({ t: t, g: g, w: w });
}

function unwatchAll() {
    for (var i = N.tileConns.length - 1; i >= 0; --i) {
        var c = N.tileConns[i];
        try { c.t.relativeGeometryChanged.disconnect(c.g); c.t.windowsChanged.disconnect(c.w); } catch (e) {}
    }
    N.tileConns = [];
}

function adopt(rec) {
    N.recs[rec.id] = rec;
    rec.onFrame = function () { observed(rec); };
    rec.w.frameGeometryChanged.connect(rec.onFrame);
}

function release(rec) {
    if (rec.onFrame) rec.w.frameGeometryChanged.disconnect(rec.onFrame);
    rec.onFrame = null;
    var t = N.owned[rec.id];
    if (t && rec.w.tile === t) {
        N.c.nativeUnmanage++;
        try { t.unmanage(rec.w); } catch (e) {}
    }
    delete N.owned[rec.id];
    delete N.recs[rec.id];
    delete N.pending[rec.id];
}

function ownsTile(rec) {
    var t = N.owned[rec.id];
    return t !== undefined && (rec.w.tile === t || rec.w.tile === null);
}

// (Re)build structure for n windows. Counted; only runs when n changes.
function build(n) {
    var root = rootTile();
    if (N.root !== root) { N.root = root; N.built = -1; }
    if (N.built === n) return;
    unwatchAll();
    // Start from an empty root: remove existing children (disposable session only).
    while (root.tiles.length > 0) { root.tiles[root.tiles.length - 1].remove(); N.c.nativeRemove++; }
    N.master = null; N.stack = null; N.leaves = [];
    if (n >= 1) {
        var two = root.split(HORIZONTAL); N.c.nativeSplit++;
        if (n === 1) {
            // Keep a single full-size leaf: remove the second child.
            two[1].remove(); N.c.nativeRemove++;
            N.master = root.tiles[0];
            N.leaves = [N.master];
        } else {
            N.master = two[0];
            N.stack = two[1];
            N.leaves = [N.master];
            if (n === 2) {
                N.leaves.push(N.stack);
            } else {
                var col = N.stack.split(VERTICAL); N.c.nativeSplit++;
                var stackLayout = N.root.tiles[1];
                var leaves = [col[0], col[1]];
                while (leaves.length < n - 1) {
                    var more = leaves[leaves.length - 1].split(VERTICAL); N.c.nativeSplit++;
                    leaves = [];
                    for (var i = 0; i < stackLayout.tiles.length; ++i) leaves.push(stackLayout.tiles[i]);
                }
                // Equalize stack heights.
                for (var j = 0; j < leaves.length; ++j) {
                    var g = leaves[j].relativeGeometry;
                    leaves[j].relativeGeometry = N.qt.rect(g.x, j / leaves.length, g.width, 1 / leaves.length);
                    N.c.nativeRelGeomWrites++;
                }
                N.stack = stackLayout;
                N.leaves = N.leaves.concat(leaves);
            }
        }
    }
    watchTile(root);
    for (var k = 0; k < N.leaves.length; ++k) watchTile(N.leaves[k]);
    N.built = n;
}

function apply(plan) {
    var n = plan.length;
    build(n);
    if (n === 0) return;
    var root = N.root;
    var abs = root.absoluteGeometry;
    // Master boundary: plan master frame right edge + padding == tile right edge.
    if (n >= 2) {
        var pad = root.padding;
        var wantRight = plan[0].rect.x + plan[0].rect.width + pad;
        var m = N.master.absoluteGeometry;
        var delta = Math.round(wantRight - (m.x + m.width));
        if (Math.abs(delta) >= 1) { N.master.resizeByPixels(delta, RIGHT_EDGE); N.c.nativeResize++; }
    }
    for (var i = 0; i < n; ++i) {
        var rec = plan[i].rec, leaf = N.leaves[i];
        if (rec.w.tile === leaf) continue;
        N.owned[rec.id] = leaf;
        N.c.nativeManage++;
        N.c.writes++;
        rec.t0 = N.clock.nowNs();
        N.pending[rec.id] = true;
        if (!leaf.manage(rec.w)) { N.c.manageRejected++; delete N.owned[rec.id]; }
    }
    // Every window whose tile geometry changed is also "pending" until observed stable.
    for (var j = 0; j < n; ++j) {
        var r = plan[j].rec;
        if (!N.pending[r.id] && !N.near(N.rectOf(r.w.frameGeometry), plan[j].rect)) {
            N.pending[r.id] = true; r.t0 = N.clock.nowNs(); N.c.writes++;
        }
        r.nativeTarget = plan[j].rect;
    }
}

function observed(rec) {
    N.c.observations++;
    if (!N.pending[rec.id] || !rec.nativeTarget) return;
    if (N.near(N.rectOf(rec.w.frameGeometry), rec.nativeTarget)) {
        delete N.pending[rec.id];
        N.c.settled++;
        N.log("settle", { id: rec.id, t: N.clock.nowNs(), latencyNs: N.clock.nowNs() - rec.t0, reason: "native" });
    }
}

function counters() {
    var out = {};
    for (var k in N.c) out[k] = N.c[k];
    out.outstanding = Object.keys(N.pending).length;
    out.leaves = N.leaves.length;
    return out;
}

function teardown() {
    for (var id in N.recs) release(N.recs[id]);
    unwatchAll();
    N = null;
}
