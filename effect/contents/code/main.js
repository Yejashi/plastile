/*
    Plastile Motion: an optional KWin effect that animates how a window *looks* when a program
    moves or resizes it. Original implementation for Plastile; see docs/design/DECISIONS.md ADR-023.

    The effect never changes real window geometry. KWin has already applied the new frame (input,
    hit-testing and the client's own size are at the final rectangle) when this effect is told
    about it. The effect only paints the window's current texture translated and scaled from the
    rectangle it was last drawn at to the new frame (AnimationEffect Size + Position), over a short,
    configurable duration. A change that arrives mid-animation retargets the running animation from
    the visual state painted last, so rapid commands never queue behind an animation.

    Rules (motionDecide() below): only managed normal windows, both rectangles valid and different,
    not while any window is in an interactive move/resize (nor the resized window's late commits
    right after one), not a maximize or fullscreen transition, not the first placement of a newly
    opened window, not while hidden or right after a desktop, activity, output or minimize change,
    not while a fullscreen effect such as Overview runs, and never with the global animation speed
    at "instant" (animationTimeFactor 0). The effect cannot tell who changed the geometry: every
    qualifying programmatic change animates, Plastile's or not (ADR-023).

    This file is a plain script run by KWin's scripted-effect engine (one QJSEngine per effect,
    destroyed on unload together with every connection made here). tests/core/motion.test.ts runs
    it in Node against a fake effect host. It uses no timer: every decision is taken inside a KWin
    signal handler.
*/

"use strict";

// Default duration in ms before the global animation speed factor is applied.
var MOTION_DEFAULT_MS = 180;
// A geometry change this soon after a window appeared is its first placement (the open
// animation, if any, belongs to another effect).
var MOTION_OPEN_GRACE_MS = 500;
// Changes this soon after a desktop/activity/output switch, a minimize or a desktop membership
// change are the switch's own reflow and are not animated.
var MOTION_TRANSITION_GRACE_MS = 300;
// How long a maximize request (windowMaximizedStateAboutToChange) claims the window's next geometry change.
var MOTION_STATE_GRACE_MS = 1000;
// KWin rounds frames to the device-pixel grid; differences below this are not motion.
var MOTION_TOLERANCE = 0.5;
// Configurable easing curves, by the index stored in [Effect-plastile_motion] Easing.
var MOTION_EASINGS = ["OutCubic", "OutQuart", "OutQuad", "InOutCubic", "Linear"];

function motionRect(r) {
    return { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) };
}

function motionValidRect(r) {
    return !!r && isFinite(r.x) && isFinite(r.y) && isFinite(r.width) && isFinite(r.height)
        && r.width >= 1 && r.height >= 1;
}

function motionSameRect(a, b, tol) {
    var t = tol === undefined ? MOTION_TOLERANCE : tol;
    return Math.abs(a.x - b.x) <= t && Math.abs(a.y - b.y) <= t
        && Math.abs(a.width - b.width) <= t && Math.abs(a.height - b.height) <= t;
}

function motionUnion(a, b) {
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return {
        x: x, y: y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
}

/** Effective duration in ms: 0 disables the effect (global speed "instant", factor 0). */
function motionDuration(configuredMs, factor) {
    var f = Number(factor);
    if (!(f > 0) || !isFinite(f)) {
        return 0;
    }
    var base = Number(configuredMs) > 0 ? Number(configuredMs) : MOTION_DEFAULT_MS;
    return Math.max(1, Math.round(base * f));
}

/** The easing curve name for a configured index (out-of-range values fall back to the default). */
function motionEasingName(index) {
    var i = Number(index);
    return MOTION_EASINGS[i >= 0 && i < MOTION_EASINGS.length && Math.floor(i) === i ? i : 0];
}

/**
 * Whether one geometry change is animated: "" to animate, otherwise the reason it is not.
 * `f` holds plain facts read from KWin by the caller, so this is testable without KWin.
 */
function motionDecide(f) {
    if (!(f.duration > 0)) return "instant";
    if (!f.managed || !f.normal || f.popup || f.internal || f.deleted) return "type";
    if (!motionValidRect(f.old) || !motionValidRect(f.next)) return "invalid";
    if (motionSameRect(f.old, f.next)) return "unchanged";
    if (f.statePendingAt !== null && f.now - f.statePendingAt <= MOTION_STATE_GRACE_MS) return "maximize";
    if (f.fullScreen || (f.screen && (motionSameRect(f.next, f.screen) || motionSameRect(f.old, f.screen)))) {
        return "fullscreen";
    }
    if (f.userMoveResize || f.interactions > 0) return "interactive";
    if (f.fullScreenEffect) return "fullscreen-effect";
    if (!f.visible || f.minimized) return "hidden";
    if (f.now < f.suppressUntil) return "transition";
    if (f.addedAt !== null && f.now - f.addedAt < MOTION_OPEN_GRACE_MS) return "opening";
    if (f.grabbed) return "grabbed";
    return "";
}

/** Position animates the frame centre in absolute coordinates; Size the frame size. */
function motionCentre(r) {
    return { value1: r.x + r.width / 2, value2: r.y + r.height / 2 };
}

function motionSize(r) {
    return { value1: r.width, value2: r.height };
}

function motionFormat(r) {
    return "[" + [r.x, r.y, r.width, r.height].map(function (v) { return Math.round(v * 100) / 100; }).join(",") + "]";
}

function PlastileMotion() {
    this.records = new Map();     // EffectWindow -> per-window record
    this.interactions = 0;        // windows in an interactive move/resize
    this.suppressUntil = 0;       // global transition grace (desktop/activity/output change)
    this.loadConfig();
    effect.configChanged.connect(this.loadConfig.bind(this));
    effect.animationEnded.connect(this.onAnimationEnded.bind(this));
    effects.windowAdded.connect(this.onWindowAdded.bind(this));
    effects.windowClosed.connect(this.forget.bind(this, "closed"));
    effects.windowDeleted.connect(this.forget.bind(this, "deleted"));
    var transition = this.onTransition.bind(this);
    effects.desktopChanged.connect(transition);
    effects.currentActivityChanged.connect(transition);
    effects.screenAdded.connect(transition);
    effects.screenRemoved.connect(transition);
    effects.showingDesktopChanged.connect(transition);
    var self = this;
    effects.stackingOrder.forEach(function (w) { self.manage(w, null); });
    this.log("loaded duration=" + this.duration() + " easing=" + this.easingName + " windows=" + this.records.size);
}

PlastileMotion.prototype.loadConfig = function () {
    this.configuredMs = Number(effect.readConfig("Duration", 0)) || 0;
    this.easingName = motionEasingName(effect.readConfig("Easing", 0));
    this.curve = QEasingCurve[this.easingName];
    this.debug = !!effect.readConfig("Debug", false);
};

// Read the global animation speed at each start: System Settings changes it without reconfiguring effects.
PlastileMotion.prototype.duration = function () {
    return motionDuration(this.configuredMs, effects.animationTimeFactor);
};

PlastileMotion.prototype.log = function (text) {
    if (this.debug) {
        console.info("plastile_motion " + text);
    }
};

PlastileMotion.prototype.label = function (w) {
    return JSON.stringify(String(w.caption));
};

PlastileMotion.prototype.onWindowAdded = function (w) {
    this.manage(w, Date.now());
};

PlastileMotion.prototype.manage = function (w, addedAt) {
    if (!w || this.records.has(w)) {
        return;
    }
    var rec = {
        addedAt: addedAt, statePendingAt: null, suppressUntil: 0, ids: null, bound: null, target: null,
        moving: false, resizing: false,
    };
    this.records.set(w, rec);
    var self = this;
    w.windowFrameGeometryChanged.connect(function (win, old) { self.onGeometry(win, old); });
    w.windowMaximizedStateAboutToChange.connect(function (win) { self.onMaximizeRequested(win); });
    w.windowStartUserMovedResized.connect(function (win) { self.onInteraction(win, true); });
    w.windowFinishUserMovedResized.connect(function (win) { self.onInteraction(win, false); });
    w.windowFullScreenChanged.connect(function (win) { self.interrupt(win, "fullscreen"); });
    w.minimizedChanged.connect(function (win) { self.suppressWindow(win, "minimized"); });
    w.windowDesktopsChanged.connect(function (win) { self.suppressWindow(win, "desktops"); });
    w.windowHiddenChanged.connect(function (win) { self.suppressWindow(win, "hidden"); });
};

PlastileMotion.prototype.forget = function (why, w) {
    var rec = this.records.get(w);
    if (!rec) {
        return;
    }
    // A closing window is left to the close animation (or removed at once): never kept alive by a move.
    this.interrupt(w, why);
    if (rec.moving) {
        this.moving(rec, false);
    }
    this.records.delete(w);
};

PlastileMotion.prototype.moving = function (rec, on) {
    if (rec.moving !== on) {
        rec.moving = on;
        this.interactions += on ? 1 : -1;
    }
};

PlastileMotion.prototype.onTransition = function () {
    this.suppressUntil = Date.now() + MOTION_TRANSITION_GRACE_MS;
    // A running animation may point into an output that is going away, or onto a desktop that is no longer
    // shown: stop them all (rare events; the switch's own effect, if any, takes over).
    var self = this;
    var animated = [];
    this.records.forEach(function (rec, w) {
        if (rec.ids) {
            animated.push(w);
        }
    });
    animated.forEach(function (w) { self.interrupt(w, "transition"); });
};

PlastileMotion.prototype.suppressWindow = function (w, why) {
    var rec = this.records.get(w);
    if (!rec) {
        return;
    }
    rec.suppressUntil = Date.now() + MOTION_TRANSITION_GRACE_MS;
    this.interrupt(w, why);
};

PlastileMotion.prototype.onMaximizeRequested = function (w) {
    var rec = this.records.get(w);
    if (!rec) {
        return;
    }
    rec.statePendingAt = Date.now();
    this.interrupt(w, "maximize");
};

PlastileMotion.prototype.onInteraction = function (w, started) {
    var rec = this.records.get(w);
    if (!rec) {
        return;
    }
    this.moving(rec, started);
    if (started) {
        rec.resizing = !!w.resize;
        this.interrupt(w, "interactive");
    } else if (rec.resizing) {
        // The client may still commit sizes it was asked for during the resize: those are the user's
        // resize arriving late, not a new placement. A move's drop placement does animate.
        rec.resizing = false;
        rec.suppressUntil = Date.now() + MOTION_TRANSITION_GRACE_MS;
    }
};

/** Stop this window's animation (if any) so it is drawn at its real geometry from the next frame. */
PlastileMotion.prototype.interrupt = function (w, why) {
    var rec = this.records.get(w);
    if (!rec || !rec.ids) {
        return;
    }
    var ids = rec.ids, bound = rec.bound;
    rec.ids = null;
    rec.bound = null;
    rec.target = null;
    cancel(ids);
    this.repaint(w, bound);
    this.log("cancel " + this.label(w) + " reason=" + why);
};

// cancel() does not schedule a repaint: damage what the animation covered plus the window's shadow.
PlastileMotion.prototype.repaint = function (w, bound) {
    var frame = motionRect(w.geometry);
    var expanded = motionRect(w.expandedGeometry);
    var pad = 2 + 2 * Math.max(0, frame.x - expanded.x, frame.y - expanded.y,
        expanded.x + expanded.width - frame.x - frame.width, expanded.y + expanded.height - frame.y - frame.height);
    var r = motionUnion(bound || frame, expanded);
    effects.addRepaint(Math.floor(r.x - pad), Math.floor(r.y - pad), Math.ceil(r.width + 2 * pad), Math.ceil(r.height + 2 * pad));
};

PlastileMotion.prototype.onAnimationEnded = function (w) {
    // KWin reports each of the two animations (Size, Position); both end in the same frame.
    var rec = this.records.get(w);
    if (!rec || !rec.ids) {
        return;
    }
    rec.ids = null;
    rec.bound = null;
    this.log("end " + this.label(w) + " target=" + motionFormat(rec.target) + " frame=" + motionFormat(motionRect(w.geometry)));
    rec.target = null;
};

PlastileMotion.prototype.onGeometry = function (w, oldGeometry) {
    var rec = this.records.get(w);
    if (!rec) {
        return;
    }
    var now = Date.now();
    var next = motionRect(w.geometry);
    var old = oldGeometry ? motionRect(oldGeometry) : null;
    var screen = w.screen ? motionRect(w.screen.geometry) : null;
    var duration = this.duration();
    var reason = motionDecide({
        duration: duration,
        managed: w.managed, normal: w.normalWindow, popup: w.popupWindow, internal: !!w.internalWindow,
        deleted: w.deleted,
        old: old, next: next, screen: screen,
        statePendingAt: rec.statePendingAt,
        fullScreen: w.fullScreen,
        userMoveResize: w.move || w.resize, interactions: this.interactions,
        fullScreenEffect: effects.hasActiveFullScreenEffect,
        visible: w.visible, minimized: w.minimized,
        now: now, suppressUntil: Math.max(this.suppressUntil, rec.suppressUntil),
        addedAt: rec.addedAt,
        grabbed: effect.isGrabbed(w, Effect.WindowAddedGrabRole) || effect.isGrabbed(w, Effect.WindowClosedGrabRole)
            || effect.isGrabbed(w, Effect.WindowMinimizedGrabRole) || effect.isGrabbed(w, Effect.WindowUnminimizedGrabRole),
    });
    if (reason === "maximize") {
        rec.statePendingAt = null;   // a maximize request claims one geometry change
    }
    if (reason !== "") {
        if (rec.ids) {
            this.interrupt(w, reason);
        }
        if (reason !== "unchanged") {
            this.log("skip " + this.label(w) + " reason=" + reason + " from=" + (old ? motionFormat(old) : "null")
                + " to=" + motionFormat(next));
        }
        return;
    }
    if (rec.ids) {
        // Mid-animation: KWin's retarget() restarts each timeline from the value painted last (Position is
        // absolute, Size is absolute), so the visual continues from where it is towards the new frame.
        var moved = retarget(rec.ids[0], motionCentre(next), duration);
        var sized = moved && retarget(rec.ids[1], motionSize(next), duration);
        if (sized) {
            rec.bound = motionUnion(rec.bound || old, next);
            rec.target = next;
            this.log("retarget " + this.label(w) + " to=" + motionFormat(next) + " ms=" + duration);
            return;
        }
        // Not running any more (it ended in this frame): start afresh from the frame it ended at.
        cancel(rec.ids);
        rec.ids = null;
    }
    var ids = animate({
        window: w,
        duration: duration,
        curve: this.curve,
        animations: [
            { type: Effect.Position, from: motionCentre(old), to: motionCentre(next) },
            { type: Effect.Size, from: motionSize(old), to: motionSize(next) },
        ],
    });
    rec.ids = ids;
    rec.bound = motionUnion(old, next);
    rec.target = next;
    this.log("start " + this.label(w) + " from=" + motionFormat(old) + " to=" + motionFormat(next) + " ms=" + duration
        + " easing=" + this.easingName);
};

if (typeof effect !== "undefined" && typeof effects !== "undefined") {
    new PlastileMotion();
}
