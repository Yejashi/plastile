// M1 direct-geometry backend (T05): the spike's single geometry writer.
//
// Ledger per window: last requested rect + sequence, bounded history of recent
// targets, outstanding flag, correction count. A request is not repeated while
// the same target is outstanding; an observation equal to an *older* target
// while a newer one is outstanding is stale and triggers at most two
// corrections (the E04 reversal case measured in M0).

var B = null;

function create(qt, clock, log, near, rectOf) {
    B = {
        qt: qt, clock: clock, log: log, near: near, rectOf: rectOf,
        seq: 0, applying: 0, recs: {}, pendingCorrections: {}, correctionScheduled: false,
        c: { writes: 0, skipOutstanding: 0, skipNoop: 0, observations: 0, observationsDuringApply: 0,
             settled: 0, staleObservations: 0, partialObservations: 0, externalChanges: 0,
             corrections: 0, correctionBudgetExhausted: 0, unmanaged: 0 },
    };
    return { adopt: adopt, release: release, apply: apply, counters: counters, teardown: teardown };
}

function adopt(rec) {
    rec.ledger = { req: null, outstanding: false, history: [], corrections: 0 };
    rec.onFrame = function () { observed(rec); };
    rec.w.frameGeometryChanged.connect(rec.onFrame);
    B.recs[rec.id] = rec;
}

function release(rec) {
    if (rec.onFrame) rec.w.frameGeometryChanged.disconnect(rec.onFrame);
    rec.onFrame = null;
    delete B.recs[rec.id];
    delete B.pendingCorrections[rec.id];
}

function write(rec, target, reason) {
    var L = rec.ledger;
    var before = B.rectOf(rec.w.frameGeometry);
    B.c.writes++;
    L.req = { rect: target, seq: ++B.seq, t: B.clock.nowNs(), reason: reason };
    L.history.push(target);
    if (L.history.length > 4) L.history.shift();
    L.outstanding = true;
    B.applying++;
    try { rec.w.frameGeometry = B.qt.rect(target.x, target.y, target.width, target.height); }
    finally { B.applying--; }
    // Settle on readback only if the frame actually changed to the target
    // (position-only moves apply synchronously). If the old committed frame
    // already equals the target while another request is in flight, KWin sends
    // no configure (E04); stay outstanding so the late commit is recognized as
    // stale and corrected.
    if (!B.near(before, target) && B.near(B.rectOf(rec.w.frameGeometry), target)) settle(rec);
}

function apply(plan) {
    for (var i = 0; i < plan.length; ++i) {
        var rec = plan[i].rec, target = plan[i].rect, L = rec.ledger;
        try {
            if (L.req && B.near(L.req.rect, target)) {
                if (L.outstanding) { B.c.skipOutstanding++; continue; }
                if (B.near(B.rectOf(rec.w.frameGeometry), target)) { B.c.skipNoop++; continue; }
            }
            L.corrections = 0;
            write(rec, target, "plan");
        } catch (e) {
            B.log("error", { where: "direct.apply", id: rec.id, e: String(e) }); // peers continue
        }
    }
}

function settle(rec) {
    var L = rec.ledger;
    if (!L.outstanding) return;
    L.outstanding = false;
    B.c.settled++;
    B.log("settle", { id: rec.id, seq: L.req.seq, reason: L.req.reason, t: B.clock.nowNs(),
                      latencyNs: B.clock.nowNs() - L.req.t });
}

function observed(rec) {
    var L = rec.ledger;
    B.c.observations++;
    if (B.applying > 0) B.c.observationsDuringApply++;
    if (!L.req) return;
    var f = B.rectOf(rec.w.frameGeometry);
    if (B.near(f, L.req.rect)) { settle(rec); return; }
    if (!L.outstanding) { B.c.externalChanges++; return; } // yield: no fight after settlement
    var older = false;
    for (var i = 0; i < L.history.length - 1; ++i) {
        if (B.near(f, L.history[i])) { older = true; break; }
    }
    if (!older) { B.c.partialObservations++; return; }  // e.g. position applied, size pending
    B.c.staleObservations++;
    if (L.corrections >= 2) { B.c.correctionBudgetExhausted++; return; }
    B.pendingCorrections[rec.id] = true;
    if (!B.correctionScheduled) { B.correctionScheduled = true; B.qt.callLater(flushCorrections); }
}

function flushCorrections() {
    if (B === null) return;
    B.correctionScheduled = false;
    var ids = Object.keys(B.pendingCorrections);
    B.pendingCorrections = {};
    for (var i = 0; i < ids.length; ++i) {
        var rec = B.recs[ids[i]];
        if (!rec || !rec.ledger.outstanding) continue;
        if (B.near(B.rectOf(rec.w.frameGeometry), rec.ledger.req.rect)) { settle(rec); continue; }
        rec.ledger.corrections++;
        B.c.corrections++;
        var target = rec.ledger.req.rect, keep = rec.ledger.corrections;
        write(rec, target, "correction");
        rec.ledger.corrections = keep;
    }
}

function counters() {
    var out = {};
    for (var k in B.c) out[k] = B.c[k];
    var outstanding = 0;
    for (var id in B.recs) if (B.recs[id].ledger.outstanding) outstanding++;
    out.outstanding = outstanding;
    return out;
}

function teardown() {
    for (var id in B.recs) release(B.recs[id]);
    B.recs = {};
    B.pendingCorrections = {};
    B = null;
}
