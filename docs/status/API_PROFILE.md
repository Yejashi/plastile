# Script API profile: KWin 6.7.5, declarative scripts (T01 / E03)

**Scope:** what a *declarative* (QML) KWin script can actually reach in the installed build (tag `v6.7.5`, [environment](ENVIRONMENT.md)). Plain-JS scripts use a different wrapper (`QtScriptWorkspaceWrapper`), and this profile does not cover them.

**Evidence labels:**
- **R** — runtime introspection or behaviour from [`probes/capability`](../../probes/capability), run in nested KWin 6.7.5. Raw results: [evidence/capabilities-a.json](evidence/capabilities-a.json) and [evidence/capabilities-b.json](evidence/capabilities-b.json).
- **S** — observed source at tag `ab7df7cc`.
- **M** — measured by the timing, lifecycle or constraints probes ([M0 probe report](M0_PROBE_REPORT.md)).

## Required adapter operations

| Need | Real surface | Evidence | Semantics and caveats |
|---|---|---|---|
| Enumerate windows | `Workspace.windows` (QQmlListProperty) | R | **`Workspace.windowList()` does not exist in declarative scripts.** It belongs to the plain-JS wrapper and throws `TypeError`. `windows` is not a JS `Array` (`Array.isArray` is false); index it or use `Array.from`. |
| Window lifecycle | `Workspace.windowAdded(w)`, `windowRemoved(w)`; `w.closed` | R/S | Fires when the window is managed (mapped). Connections must be disconnected explicitly; see "Lifetime" below. |
| Stable window ID | `w.internalId` (QUuid) | R | `String(w.internalId)` gives a stable 38-character `{uuid}` across reads. It is session-local, not durable. |
| Classification | `normalWindow, dialog, utility, specialWindow, transient, transientFor, modal, popupWindow, windowType, resourceClass, resourceName, desktopFileName, windowRole, managed, deleted`, plus the type booleans | R | For Wayland clients, `resourceClass == resourceName == desktopFileName ==` the xdg app_id (Qt apps: `org.qt-project.qml6`, `qml`). |
| Focus | `Workspace.activeWindow` (R/W), `windowActivated(w)`, `w.active`, `w.activeChanged` | R | Assigning `activeWindow` is used to target the quick-tile slots. |
| Outputs | `Workspace.screens`, `screenOrder`, `activeScreen`, `screenAt(point)`, `screensChanged`, `screenOrderChanged`, `w.output`, `w.outputChanged` | R | Output object exposes `name, geometry, devicePixelRatio, manufacturer, model, serialNumber`, plus `geometryChanged, scaleChanged, aboutToChange, changed`. It has **no UUID property** (KScreen UUIDs are not script-visible). Output identity must use connector name + manufacturer/model/serial; the virtual backend leaves the last three empty. |
| Move window to output | `Workspace.sendClientToScreen(w, output)` | R (present) | **`w.output` is read-only:** assignment throws `TypeError: Cannot assign to read-only property "output"`. Transfer behaviour itself is not yet measured (T24). |
| Desktops | `Workspace.desktops`, `currentDesktop`, `desktopsChanged`, `currentDesktopChanged(prev, cur, output)`; `w.desktops` (R/W list), `w.onAllDesktops`, `w.desktopsChanged` | R/S | `VirtualDesktop.id` is a 36-character UUID string, a stable ID. It also has `name` and `x11DesktopNumber`. |
| Per-output desktop | `Workspace.currentDesktopForScreen(o)`, `setCurrentDesktopForScreen(d, o)` | R | Present and working; returns the global desktop when per-output desktops are off. The live session has `perOutputVirtualDesktops=false`. |
| Activities | `Workspace.activities`, `currentActivity`, `activityAdded/Removed`, `currentActivityChanged`; `w.activities` | R | Nested session without the Activities service: list length 1 and `currentActivity === ""`. The all-activities representation is unverified (E08 open). |
| Usable area | `Workspace.clientArea(option, output, desktop)`, `clientArea(option, window)` | R | Enum values: `Workspace.PlacementArea=0`, `MaximizeArea=2`, `FullScreenArea=4`, `WorkArea=5`. They are **not** on the `KWin` context object. Returns a rect with `x/y/width/height`. No panels exist in the nested session, so panel-reservation behaviour is untested. |
| Direct frame request | `w.frameGeometry = Qt.rect(...)`; plain `{x,y,width,height}` objects are also accepted | R, M | A **position-only** write emits `frameGeometryChanged` **synchronously inside the setter**, and the readback is updated at once. A **resize** write emits nothing synchronously; readback keeps the old size until the client commits (configure, ack, commit). KWin geometry is **floating point**: values such as `466.666…` and `400.00000000000006` were observed at scale 1. |
| Frame vs client | `w.frameGeometry`, `w.clientGeometry`, `w.bufferGeometry` | R | With Breeze SSD the frame is the client plus a 28 px titlebar and no side borders. With CSD (or no decoration plugin) frame == client. |
| Constraints | `w.minSize`, `w.maxSize` (no NOTIFY), `w.resizeable`, `w.moveable`, `w.fullScreenable`, `w.maximizable` | R, M | `minSize`/`maxSize` are in **client** coordinates. Unconstrained max is reported as `2147483647`. **KWin does not clamp script frame requests to `minSize`** (see E07 in the report). |
| Maximize / fullscreen / minimize | `w.setMaximize(v, h)`, `w.maximizeMode` (R), `maximizedChanged`; `w.fullScreen` (R/W), `fullScreenChanged`; `w.minimized` (R/W), `minimizedChanged` | R/S | Present. State-transition behaviour is untested (T17). |
| Interactive move/resize | `w.move`, `w.resize` (R), `moveResizedChanged`, `interactiveMoveResizeStarted/Stepped/Finished` | R | Present. Not yet exercised: there is no input device in the virtual backend, so testing needs EIS/fake input or a physical session. |
| Native tile root | `Workspace.rootTile(output, desktop)`; `Workspace.tilingForScreen(output).rootTile` | R | Present. The nested default root has 3 children (0.25/0.5/0.25), `padding 4`, `minimumSize {0.15, 0.15}`, `layoutDirection 1`, `canBeRemoved false`. `tilingForScreen(o).rootTile === rootTile(o, currentDesktopForScreen(o))`. |
| Native tile members | `relativeGeometry` (R/W), `absoluteGeometry`, `absoluteGeometryInScreen`, `padding`, `minimumSize`, `layoutDirection`, `tiles`, `windows`, `parent`, `isLayout`, `canBeRemoved`, `positionInLayout`; `split(dir)`, `remove()`, `resizeByPixels`, `moveByPixels`, `manage(w)`, `unmanage(w)`, `pick()` (root only); `TileManager.bestTileForPosition` | R | Present. The mutation cost of `split`/`remove` is not yet measured (T06). |
| Native association | `tile.manage(w)` → bool, `tile.unmanage(w)` → bool; `w.tile` (R/W, deprecated setter), `tileChanged`, `requestedTileChanged` | R, M | `manage` returned `true` and `w.tile` became the leaf, but **no `tileChanged` was emitted synchronously**; `requestedTileChanged` also exists. **A native quick-tile is a `Tile` association (`w.tile !== null`).** A direct `frameGeometry` write does **not** clear it; `w.tile.unmanage(w)` does, and returns true. |
| Native quick tile | `Workspace.slotWindowQuickTile{Left,Right,Top,Bottom,TopLeft,…}()` act on the active window | R, M, S | Repeating the current mode is a no-op (or shifts to the adjacent output if one exists). Left from top-left was also a no-op. |
| Shortcuts | `ShortcutHandler { name; text; sequence; onActivated }` | R, S | Registers a `QAction` in kglobalaccel component **`kwin`**. Invocable over D-Bus with `org.kde.kglobalaccel /component/kwin invokeShortcut(name)`. **Registration persists in `kglobalshortcutsrc`** after unload, so a probe in the live session would leave entries in the user's file. |
| Script config | `KWin.readConfig(key, default)` reads `kwinrc [Script-<pluginName>]` | R | Values arrive as strings or bools; compare with `String(v) === "true"`. |
| Deferred work | `Qt.callLater(fn, ...args)` | R, M | Coalesces by **function identity**: 1000 calls with one stable function ran once; 1000 fresh closures ran 1000 times. |
| Timers | QML `Timer` (`interval`, `repeat`, `restart`, `stop`) | M | Not quantized to a 16 ms animation tick in this configuration (see the report). |
| Timestamps | `Date.now()` only (1 ms steps) | R | **No `performance.now()`, `setTimeout`, `queueMicrotask` or `globalThis`.** Sub-millisecond timing needs the measurement-only `Plastile.Measure` module (nested sessions only). |
| Loading | `org.kde.kwin.Scripting.loadDeclarativeScript(path, plugin)` then `/Scripting/Script<N> run`; `unloadScript(plugin)`; `isScriptLoaded`; `start()` | R, S | Package entry is **hard-coded** to `contents/ui/main.qml` for declarative scripts. Autoload at startup and disable/re-enable via `[Plugins] <id>Enabled` + `Scripting.start()` work. A package installed **after** KWin started was not found by `start()`; the suspected cause is a cached package listing (**inference**). |

## JavaScript language level in KWin's QV4 (Qt 6.12)

Measured by compiling each snippet with `new Function` inside the declarative script engine.

**Supported:** `let`/`const`; arrows; classes (constructor, accessors, static methods, `extends`/`super`); template literals; default parameters; `**` and `**=`; basic and array-rest destructuring; call/array spread; computed keys; shorthand methods; generators; `for…of` (including `Map` entries); labeled break; `Map`, `Set`, `WeakMap`, `Symbol`, `Promise`, `Proxy`, `Reflect`, typed arrays; `?.` and `??`; numeric separators; `Array.prototype.includes/find/findIndex`, `Array.from`, `Object.assign/values/entries`, `String.prototype.includes/startsWith/padStart`; `console.time`.

**Not supported (parse or type errors):** class fields (public and `#private`); object rest/spread (`{...o}`); `async`/`await`; logical assignment (`??=`, `||=`); BigInt; optional catch binding (`catch {}`); `Array.prototype.flat/flatMap/at`; `Object.fromEntries`; `WeakRef`; `structuredClone`; `globalThis`.

**Consequence for the TypeScript core (T09):** emit a conservative target (ES2017-level syntax) and downlevel object spread/rest, class fields, `async` and logical assignment. Forbid `flat`, `at`, `fromEntries` and `globalThis` with lint or type-lib settings rather than polyfilling in the hot path. Run the compiled bundle through this probe's parser in nested KWin as a build gate.

## Lifetime facts that constrain the adapter

- Unload (`unloadScript`, or disabling via config) calls `deleteLater()` on the script object (S), and `Component.onDestruction` runs (R).
- All declarative scripts share **one `QQmlEngine`** (S).
- **A plain JS closure connected to a `Workspace` signal survives script unload and keeps firing** (M: the leak-control run). Each reload adds another live dead-instance closure. Every connection must therefore go through an owned registry and be disconnected in teardown. This is mandatory, not defensive.
- A `Qt.callLater` queued during `Component.onDestruction`, and a running QML `Timer` at unload, did **not** fire after teardown (M).
- After unload, kglobalaccel still accepts `invokeShortcut` for the destroyed action, and no handler runs (M).

## Unresolved capability items (with the task that resolves each)

| Item | Status | Resolving task |
|---|---|---|
| Output transfer via `sendClientToScreen`, output hot-unplug callbacks | not exercised | T24/T30, needs multi-output nested runs |
| All-activity window representation, Activities service present | not exercised (no service in nested) | E08, physical or nested with `kactivitymanagerd` |
| Panel-aware `clientArea` | no panels in nested | E-physical or nested `plasmashell` |
| Interactive move/resize signals | no input device in virtual backend | EIS/fake-input experiment or physical session |
| XWayland constraint visibility (increments, aspect) | not exercised | E07/T18 |
| Native split/remove mutation counts, native-editor interplay | not measured | T06 |
| Fractional scale / mixed scale | not exercised (reference machine is scale 1) | T30, nested `kscreen-doctor` scale changes |
| Post-start package discovery | inference only | T32 packaging |
