// Plastile M0 capability probe (T01/E03).
//
// Records which KWin APIs are actually script-visible in this runtime and how
// they behave. Phase A needs no windows. Phase B runs once a window whose
// resourceClass equals the configured fixtureClass is present.
//
// Mutating checks (direct placement, native tile manage/unmanage) run only when
// the script config sets disposable=true, i.e. in a nested test session, and
// only on the fixture window. The probe never touches other windows.
//
// Output: single console lines "PLT-CAPS-A <json>" and "PLT-CAPS-B <json>".
import QtQuick
import org.kde.kwin

Item {
    id: root

    readonly property string fixtureClass: KWin.readConfig("fixtureClass", "plastile-fixture")
    readonly property bool disposable: KWin.readConfig("disposable", false) === true
        || KWin.readConfig("disposable", "false") === "true"
    property bool phaseBDone: false

    ShortcutHandler {
        id: probeShortcut
        name: "plastile-probe-capability-noop"
        text: "Plastile capability probe (no-op)"
        sequence: ""
        onActivated: console.info("PLT-CAPS-SHORTCUT activated")
    }

    // QV4 wraps Q_INVOKABLEs, slots and signals alike as functions that expose
    // connect(), so callables are reported together without a signal/method split.
    function members(obj) {
        const props = [], callables = [];
        if (obj === null || obj === undefined)
            return null;
        for (const k in obj) {
            let v;
            try { v = obj[k]; } catch (e) { props.push(k + ":<throws>"); continue; }
            if (typeof v === "function") callables.push(k);
            else props.push(k);
        }
        props.sort(); callables.sort();
        return { properties: props, callables: callables };
    }

    function rect(r) {
        if (r === null || r === undefined) return null;
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    }

    function attempt(fn) {
        try { return { ok: true, value: fn() }; }
        catch (e) { return { ok: false, error: String(e) }; }
    }

    function jsFeatures() {
        const tests = {
            letConst: "let a = 1; const b = 2; return a + b === 3;",
            arrow: "return [1,2].map(x => x * 2)[1] === 4;",
            classBasic: "class A { constructor() { this.v = 1; } get p() { return this.v; } static s() { return 2; } } class B extends A { constructor() { super(); this.v = 3; } } return new B().p === 3 && A.s() === 2;",
            classFieldsPublic: "class A { x = 3; static y = 4; } return new A().x + A.y === 7;",
            classPrivateFields: "class A { #p = 1; get p() { return this.#p; } } return new A().p === 1;",
            defaultParams: "function f(a = 2) { return a; } return f() === 2;",
            exponent: "return 2 ** 3 === 8;",
            arrayFind: "return [1, 2].find(x => x > 1) === 2 && [1].findIndex(x => x === 1) === 0;",
            arrayFrom: "return Array.from(new Set([1, 2])).length === 2;",
            objectAssignValues: "return Object.assign({}, {a: 1}).a === 1 && Object.values({a: 1})[0] === 1;",
            stringIncludes: "return 'abc'.includes('b') && 'abc'.startsWith('a');",
            mapIteration: "const m = new Map([[1, 2]]); let s = 0; for (const [k, v] of m) s += k + v; return s === 3;",
            computedKeys: "const k = 'a'; return ({[k]: 1}).a === 1;",
            shorthandMethods: "return ({f() { return 1; }}).f() === 1;",
            labeledBreak: "outer: for (const a of [1]) { for (const b of [2]) { break outer; } } return true;",
            tryFinally: "let s = 0; try { s = 1; } finally { s += 1; } return s === 2;",
            optionalCatchBinding: "try { throw 1; } catch { return true; }",
            templateLiterals: "const a = 1; return `${a}` === '1';",
            destructuringBasic: "const {a, b: c} = {a: 1, b: 2}; const [x, y] = [3, 4]; return a + c + x + y === 10;",
            destructuringArrayRest: "const [x, ...y] = [1, 2]; return y[0] === 2;",
            destructuringObjectRest: "const {a, ...r} = {a: 1, b: 2}; return r.b === 2;",
            objectSpread: "const o = {...{a: 1}}; return o.a === 1;",
            spread: "return Math.max(...[1, 5, 3]) === 5;",
            mapSet: "const m = new Map([[1, 2]]); const s = new Set([1]); return m.get(1) === 2 && s.has(1);",
            weakMap: "const k = {}; const w = new WeakMap(); w.set(k, 1); return w.get(k) === 1;",
            weakRef: "return typeof WeakRef === 'function';",
            symbol: "return typeof Symbol.iterator === 'symbol';",
            generators: "function* g() { yield 1; } return g().next().value === 1;",
            forOf: "let s = 0; for (const v of [1, 2]) s += v; return s === 3;",
            promise: "return typeof Promise === 'function';",
            asyncAwait: "const f = async () => 1; return typeof f === 'function';",
            exponentAssign: "let a = 2; a **= 2; return a === 4;",
            optionalChaining: "const o = {a: null}; return o?.a?.b === undefined;",
            nullishCoalescing: "return (null ?? 5) === 5;",
            logicalAssign: "let a = null; a ??= 2; return a === 2;",
            numericSeparator: "return 1_000 === 1000;",
            bigint: "return typeof 1n === 'bigint';",
            arrayIncludes: "return [1].includes(1);",
            arrayFlat: "return [[1], [2]].flat().length === 2;",
            arrayAt: "return [1, 2].at(-1) === 2;",
            objectEntries: "return Object.entries({a: 1})[0][1] === 1;",
            objectFromEntries: "return Object.fromEntries([['a', 1]]).a === 1;",
            stringPad: "return '1'.padStart(2, '0') === '01';",
            proxyReflect: "return typeof Proxy === 'function' && typeof Reflect === 'object';",
            globalThis: "return typeof globalThis === 'object';",
            typedArrays: "return new Float64Array(2).length === 2;",
            structuredClone: "return typeof structuredClone === 'function';",
            queueMicrotask: "return typeof queueMicrotask === 'function';",
            setTimeout: "return typeof setTimeout === 'function';",
            performanceNow: "return typeof performance === 'object' && typeof performance.now === 'function';",
            consoleTime: "return typeof console.time === 'function';",
        };
        const out = {};
        for (const name in tests) {
            try { out[name] = new Function(tests[name])() === true; }
            catch (e) { out[name] = "error: " + String(e); }
        }
        return out;
    }

    function clockGranularity() {
        // Smallest positive Date.now() step observed in a short spin (bounded).
        let minStep = Infinity, steps = 0;
        let last = Date.now();
        const end = last + 30;
        for (let i = 0; i < 5000000 && steps < 20; ++i) {
            const now = Date.now();
            if (now !== last) {
                minStep = Math.min(minStep, now - last);
                last = now;
                ++steps;
                if (now >= end) break;
            }
        }
        const result = { dateNowMinStepMs: minStep, dateNowSteps: steps };
        if (typeof performance === "object" && typeof performance.now === "function") {
            let pmin = Infinity, p = performance.now();
            for (let i = 0; i < 100000; ++i) {
                const q = performance.now();
                if (q > p) { pmin = Math.min(pmin, q - p); p = q; }
            }
            result.performanceNowMinStepMs = pmin;
        }
        return result;
    }

    function outputInfo(o) {
        return {
            members: members(o),
            name: o.name,
            geometry: rect(o.geometry),
            devicePixelRatio: o.devicePixelRatio,
            manufacturer: o.manufacturer,
            model: o.model,
            serialNumberPresent: typeof o.serialNumber === "string" && o.serialNumber.length > 0,
        };
    }

    function phaseA() {
        const ws = Workspace;
        const result = {
            phase: "A",
            disposable: disposable,
            fixtureClass: fixtureClass,
            js: jsFeatures(),
            clocks: clockGranularity(),
            qt: {
                callLater: typeof Qt.callLater === "function",
                rect: typeof Qt.rect === "function",
                point: typeof Qt.point === "function",
                createQmlObject: typeof Qt.createQmlObject === "function",
            },
            kwinGlobal: members(KWin),
            options: members(Options),
            workspace: members(ws),
            enums: {
                workspacePlacementArea: ws.PlacementArea,
                workspaceMaximizeArea: ws.MaximizeArea,
                workspaceFullScreenArea: ws.FullScreenArea,
                workspaceWorkArea: ws.WorkArea,
                kwinPlacementArea: KWin.PlacementArea,
                kwinMaximizeArea: KWin.MaximizeArea,
            },
            windowsProperty: attempt(() => ws.windows.length),
            windowListMethod: attempt(() => ws.windowList().length),
            windowsIsArray: attempt(() => Array.isArray(ws.windows)),
            stackingOrder: attempt(() => ws.stackingOrder.length),
            activities: attempt(() => ({ list: ws.activities.length, currentIsString: typeof ws.currentActivity === "string", currentLength: ws.currentActivity.length })),
            desktops: attempt(() => ws.desktops.map(d => ({ idType: typeof d.id, idLength: String(d.id).length, x11DesktopNumber: d.x11DesktopNumber, name: d.name }))),
            desktopMembers: attempt(() => members(ws.desktops[0])),
            currentDesktop: attempt(() => ws.currentDesktop.x11DesktopNumber),
            screens: attempt(() => ws.screens.map(outputInfo)),
            screenOrder: attempt(() => ws.screenOrder.map(o => o.name)),
            activeScreen: attempt(() => ws.activeScreen.name),
            screenAt: attempt(() => ws.screenAt(Qt.point(10, 10)).name),
            currentDesktopForScreen: attempt(() => ws.screens.map(o => ws.currentDesktopForScreen(o).x11DesktopNumber)),
            clientArea: attempt(() => ws.screens.map(o => ({
                output: o.name,
                placement: rect(ws.clientArea(ws.PlacementArea, o, ws.currentDesktopForScreen(o))),
                maximize: rect(ws.clientArea(ws.MaximizeArea, o, ws.currentDesktopForScreen(o))),
                fullscreen: rect(ws.clientArea(ws.FullScreenArea, o, ws.currentDesktopForScreen(o))),
            }))),
            virtualScreenGeometry: attempt(() => rect(ws.virtualScreenGeometry)),
            rootTile: attempt(() => ws.screens.map(o => {
                const t = ws.rootTile(o, ws.currentDesktopForScreen(o));
                return t ? {
                    output: o.name,
                    childCount: t.tiles.length,
                    relativeGeometry: rect(t.relativeGeometry),
                    absoluteGeometry: rect(t.absoluteGeometry),
                    absoluteGeometryInScreen: rect(t.absoluteGeometryInScreen),
                    padding: t.padding,
                    minimumSize: t.minimumSize ? { width: t.minimumSize.width, height: t.minimumSize.height } : null,
                    isLayout: t.isLayout,
                    canBeRemoved: t.canBeRemoved,
                    layoutDirection: t.layoutDirection,
                    windowCount: t.windows.length,
                } : null;
            })),
            rootTileMembers: attempt(() => members(ws.rootTile(ws.screens[0], ws.currentDesktopForScreen(ws.screens[0])))),
            rootTileChildMembers: attempt(() => {
                const t = ws.rootTile(ws.screens[0], ws.currentDesktopForScreen(ws.screens[0]));
                return t.tiles.length > 0 ? members(t.tiles[0]) : null;
            }),
            tilingForScreen: attempt(() => {
                const o = ws.screens[0];
                const m = ws.tilingForScreen(o);
                return {
                    members: members(m),
                    rootMatchesCurrentDesktopRoot: m.rootTile === ws.rootTile(o, ws.currentDesktopForScreen(o)),
                };
            }),
            shortcutHandler: members(probeShortcut),
            // Window classes are listed only in disposable sessions (privacy).
            windowClasses: disposable ? Array.from(ws.windows).map(w => w.resourceClass) : null,
        };
        console.info("PLT-CAPS-A " + JSON.stringify(result));
    }

    function phaseB(w) {
        if (phaseBDone) return;
        phaseBDone = true;
        const ws = Workspace;
        const result = {
            phase: "B",
            disposable: disposable,
            window: members(w),
            identity: {
                internalIdType: typeof w.internalId,
                internalIdString: String(w.internalId).length,
                internalIdStable: String(w.internalId) === String(w.internalId),
                resourceClass: w.resourceClass,
                resourceName: w.resourceName,
                desktopFileName: w.desktopFileName,
                pid: typeof w.pid,
            },
            classification: {
                normalWindow: w.normalWindow, dialog: w.dialog, utility: w.utility, specialWindow: w.specialWindow,
                transient: w.transient, managed: w.managed, deleted: w.deleted, popupWindow: w.popupWindow,
                windowType: w.windowType, resizeable: w.resizeable, moveable: w.moveable,
                moveableAcrossScreens: w.moveableAcrossScreens, maximizable: w.maximizable,
                fullScreenable: w.fullScreenable, minimizable: w.minimizable, noBorder: w.noBorder,
            },
            geometryTypes: {
                frameGeometry: typeof w.frameGeometry,
                frameGeometryValue: rect(w.frameGeometry),
                clientGeometry: rect(w.clientGeometry),
                bufferGeometry: rect(w.bufferGeometry),
                minSize: w.minSize ? { width: w.minSize.width, height: w.minSize.height } : null,
                maxSize: w.maxSize ? { width: w.maxSize.width, height: w.maxSize.height } : null,
            },
            membership: attempt(() => ({
                output: w.output ? w.output.name : null,
                desktops: w.desktops.map(d => d.x11DesktopNumber),
                onAllDesktops: w.onAllDesktops,
                activitiesLength: w.activities.length,
                tile: w.tile === null ? null : typeof w.tile,
            })),
            outputWrite: attempt(() => {
                const before = w.output;
                w.output = ws.screens[ws.screens.length - 1];
                return { changed: w.output !== before };
            }),
        };

        if (disposable) {
            // Direct placement: does the setter emit frameGeometryChanged synchronously,
            // and what does an immediate read return?
            const direct = {};
            let syncEmits = 0, emitsTotal = 0, inSetter = false;
            const onChanged = () => { emitsTotal++; if (inSetter) syncEmits++; };
            w.frameGeometryChanged.connect(onChanged);
            const area = ws.clientArea(ws.PlacementArea, w.output, ws.currentDesktopForScreen(w.output));
            const before = rect(w.frameGeometry);
            // Position-only move.
            const moveTarget = Qt.rect(area.x + 20, area.y + 20, before.width, before.height);
            inSetter = true;
            direct.moveWrite = attempt(() => { w.frameGeometry = moveTarget; return true; });
            inSetter = false;
            direct.moveSyncEmits = syncEmits;
            direct.afterMoveImmediate = rect(w.frameGeometry);
            // Resize (asynchronous for Wayland clients: configure, ack, commit).
            syncEmits = 0;
            const resizeTarget = Qt.rect(area.x + 40, area.y + 40, Math.round(area.width / 2), Math.round(area.height / 2));
            inSetter = true;
            direct.resizeWrite = attempt(() => { w.frameGeometry = resizeTarget; return true; });
            inSetter = false;
            direct.resizeSyncEmits = syncEmits;
            direct.afterResizeImmediate = rect(w.frameGeometry);
            direct.resizeTarget = rect(resizeTarget);
            // Plain object literal instead of Qt.rect.
            direct.objectLiteralWrite = attempt(() => { w.frameGeometry = { x: area.x + 40, y: area.y + 40, width: resizeTarget.width, height: resizeTarget.height }; return true; });
            result.direct = direct;

            // Native tile association on a disposable root.
            const nativeResult = {};
            const r = ws.rootTile(w.output, ws.currentDesktopForScreen(w.output));
            nativeResult.rootPresent = r !== null;
            if (r) {
                const leaf = r.tiles.length > 0 ? r.tiles[0] : r;
                nativeResult.leafIsLayout = leaf.isLayout;
                nativeResult.leafAbsolute = rect(leaf.absoluteGeometry);
                let tileChanged = 0;
                const onTile = () => tileChanged++;
                w.tileChanged.connect(onTile);
                nativeResult.manage = attempt(() => leaf.manage(w));
                nativeResult.tileAfterManageIsLeaf = w.tile === leaf;
                nativeResult.leafWindowsAfterManage = leaf.windows.length;
                nativeResult.frameAfterManageImmediate = rect(w.frameGeometry);
                nativeResult.unmanage = attempt(() => leaf.unmanage(w));
                nativeResult.tileAfterUnmanage = w.tile === null ? null : (w.tile === leaf ? "leaf" : "other");
                nativeResult.leafWindowsAfterUnmanage = leaf.windows.length;
                nativeResult.tileChangedSignals = tileChanged;
                w.tileChanged.disconnect(onTile);
                // Split is a structural native mutation; probe on the disposable root only.
                nativeResult.splitPresent = typeof leaf.split === "function";
            }
            result.native = nativeResult;
            result.directEmitsAfterAll = emitsTotal;
            Qt.callLater(() => {
                w.frameGeometryChanged.disconnect(onChanged);
                console.info("PLT-CAPS-B " + JSON.stringify(result));
            });
        } else {
            console.info("PLT-CAPS-B " + JSON.stringify(result));
        }
    }

    function onWindowAdded(w) {
        if (w && w.resourceClass === fixtureClass) safePhaseB(w);
    }

    function safePhaseB(w) {
        try { phaseB(w); }
        catch (e) { console.info("PLT-CAPS-B " + JSON.stringify({ phase: "B", error: String(e), stack: e.stack })); }
    }

    Component.onCompleted: {
        try { phaseA(); } catch (e) { console.info("PLT-CAPS-A " + JSON.stringify({ phase: "A", error: String(e), stack: e.stack })); }
        Workspace.windowAdded.connect(root.onWindowAdded);
        const existing = Workspace.windows;
        for (let i = 0; i < existing.length; ++i) {
            if (existing[i].resourceClass === fixtureClass) { safePhaseB(existing[i]); break; }
        }
    }
    Component.onDestruction: {
        Workspace.windowAdded.disconnect(root.onWindowAdded);
        console.info("PLT-CAPS-DESTROYED");
    }
}
