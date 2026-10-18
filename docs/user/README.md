# Plastile user guide

Plastile adds automatic tiling to **KDE Plasma 6 on Wayland**. It is a KWin script: a TypeScript policy core bundled into a declarative (QML) KWin script package. Per screen and virtual desktop, it arranges ordinary application windows into master/stack, binary-split (BSP) or monocle layouts, driven by keyboard shortcuts. KWin stays in charge of everything else: focus policy, decorations, maximize, fullscreen, minimize, native quick tiling and the tile editor.

Pages in this guide:

- [INSTALL](INSTALL.md): build, install, enable, settings dialog, applying settings changes.
- [SHORTCUTS](SHORTCUTS.md): every command, its default key and what it does.
- [CONFIGURATION](CONFIGURATION.md): settings keys, the JSON document (overrides and rules), precedence, classification.
- [TROUBLESHOOTING](TROUBLESHOOTING.md): diagnostics, logs, known limitations.

Labels used in this guide: **measured** (observed in a test run), **observed source** (read in upstream source at a pinned version), **inference** (reasoned, not observed), **untested**.

## Status: read this first

Plastile is a **candidate tested in nested compositors**, not a release.

| What | Where it stands |
|---|---|
| Tested compositor | KWin **6.7.5** (Qt 6.12.0, KF 6.30.0, Arch Linux), see the [environment profile](../status/ENVIRONMENT.md). `metadata.json` declares a minimum Plasma API of 6.7. KWin 6.7.5 is also tested in an Ubuntu 26.10 sandbox; KWin **6.8.0** runs in a provisional CI job that still has open failures (memory growth across repeated script reloads, see [status](../status/STATUS.md)). Other versions are untested. |
| How it was tested | In **disposable nested `kwin_wayland --virtual` sessions** with a controlled Wayland test client and real input injection (libei). Every geometry check reads window frames from KWin itself, never from Plastile's own bookkeeping. |
| Physical session | **Not validated.** Plastile has never run in a live Plasma desktop with plasmashell panels, real monitors and everyday applications. Treat everything in this guide as unverified in that setting. |
| Performance | Engine timings exist only from nested sessions and measurement builds ([status](../status/STATUS.md), [M0 probe report](../status/M0_PROBE_REPORT.md)). None of them is an input-to-photon latency claim. |

### What works (measured in nested KWin 6.7.5)

The 23 core integration scenarios in `tests/integration/scenarios.py` passed: 102 of 102 checks, run on 2026-10-17 against commit `819a91c` with an uncommitted working tree. Each item below is covered by one or more of them.

- Adopting existing windows at load, tiling new windows and reflowing on close, with bounded work for a burst of nine windows.
- Master/stack, BSP and monocle layouts, and switching between them with window order preserved. BSP rotate, mirror, reinsert and equalize. The floating layout does not fight user geometry.
- Focus, swap and grow/shrink commands. Focus commands never write geometry (except in the experimental scrolling layout, where focus scrolls). Commands with nothing to do write nothing.
- Clients that resize themselves, ignore requested sizes or clamp them. Plastile corrects such a client at most twice per target, then leaves it alone with an explanation. A slow client (300 ms) that reverses a grow/shrink still ends where the model says.
- Fullscreen, maximize and minimize are respected: KWin keeps ownership while the state lasts, peers reflow, and the window returns to its slot afterwards. Overlapping states are handled.
- Native quick tiling (`Meta+arrow`) is kept and not snapped back. *Adopt natively tiled window* brings the window back into the layout.
- Toggling a window floating and back to tiled; the last floating rectangle is restored, on the window's current screen when it moved to another one (two screens).
- Saved layout preferences (a master ratio, a floated window's position) survive script reloads and a KWin restart; a damaged state file falls back to defaults with one log line (scenario files `scenarios_persist.py`, run separately from the 23 scenarios counted above).
- Transient dialogs float; main windows tile.
- Two outputs: send a window to the other output, output scale changes from 1.25 to 2, portrait rotation, unplugging an output with requests in flight, and replugging it. A layout chosen for a screen comes back when the screen is replugged. Screens are identified by the monitor's manufacturer, model and serial number when KWin reports them, so that also holds on another connector (unit-tested only: the nested virtual outputs report none and are identified by connector name). Two identical monitors are told apart by connector.
- Sending a window to another desktop without following it; that desktop is tiled when it is first shown. With `followOnSend`, the desktop is shown on the window's screen and the window activated (two screens, per-screen desktops).
- 20 unload/reload cycles with pending work: stable connection and window counts, one shortcut per command, no errors.
- Configuration: invalid values are rejected with a message and the previous configuration is kept. Values are re-read live when KWin reconfigures (see [applying settings](INSTALL.md#applying-settings-changes) for which paths do that).
- Idle: no timers, polling or writes while nothing happens (3 s window). Suspend and resume.
- Pointer drags. Dropping a tile onto another tile swaps them on release, with no re-tiling during the drag. Dropping it into a gap snaps it back. Meta+right-drag resizing moves the shared divider. Closing the window or unloading the script mid-drag leaves no errors.
- Real keyboard input: all 20 default bindings reach Plastile when pressed through libei in a nested session (US keymap). Three earlier defaults that did not were replaced; see [SHORTCUTS](SHORTCUTS.md#default-bindings-measured-with-real-key-presses).

### What is not covered

- **Activities:** only the single default activity was exercised.
- **Panels:** plasmashell panels and other work-area reservations.
- **Outputs:** three or more.
- **Physical sessions:** anything run in one.
- **In progress:** XWayland applications, panel work areas and a few real applications in nested sessions are covered by scenario files being written alongside this guide. They are not counted above; some panel scenarios were failing at the time of writing.

The engine is designed for these cases, but designed is not tested.

## Layouts

A **context** is one screen, one virtual desktop and one activity. Every context has its own layout, window order and structure. The configured default layout applies everywhere. The layout shortcuts change one context for the current KWin session only ([why only the session](TROUBLESHOOTING.md#known-limitations)). Per-screen or per-desktop defaults that survive restarts go in the configuration as [overrides](CONFIGURATION.md#overrides).

All tiling layouts share these rules:

- **Gaps:** an inner gap between tiles and an outer gap at the screen edges (`gapInner`, `gapOuter`, 8 px each by default). A single window keeps the outer gap unless `singleWindowGaps` is off.
- **Area:** the usable area is KWin's work area for that screen and desktop.
- **Edges:** tile edges are shared, so odd sizes leave no uncovered pixels.
- **Minimum sizes:** sizes reported by clients (including decoration margins) are respected by the solver before anything is written.

### Master/stack (default)

- **Master column:** holds `masterCount` windows (default 1, range 0 to 8) and takes `masterRatio` of the width (default 0.55). With `masterCount` 0, everything is stacked.
- **Stack column:** the remaining windows share the other column with equal heights until you resize.
- **New windows:** inserted after the focused window (`masterInsert: after-focus`), at the end, or as the new master.
- **Resizing:** *Grow* and *Shrink* move the divider by `ratioStep` (default 0.05), clamped to 0.05–0.95 and to minimum sizes. Growing a stack window shrinks the master column. Meta+right-drag resizing moves the same divider.
- **Equalize:** resets the row weights.

### BSP

BSP keeps a persistent binary tree of splits.

- **New windows:** split the focused tile (`bspInsert: focused`) or the last tile.
- **Split direction:** alternates, follows the longer side, or is fixed (`bspAxis`). A new split starts at `bsp.initialRatio`, 0.5 by default.
- **Closing:** closing a window collapses its parent split.
- **Focus:** focus changes never alter the tree.
- **Commands:**
  - *Grow* and *Shrink* adjust the split that contains the focused tile.
  - *Rotate* and *Mirror* transform every split.
  - *Move tile* re-inserts the focused tile beside a neighbour.
  - *Swap* exchanges two windows between leaves.
- **Minimum sizes:** aggregated up the tree before solving.

### Monocle

Every tiled window gets the whole area (minus the outer gap), and the focused or selected one is raised. Peers are stacked behind it, never minimized, so the task manager and dialogs behave normally. Resize, rotate, mirror and master-count commands do nothing here.

### Floating

Plastile places nothing in a floating context, and windows keep ordinary KDE behaviour. When a context is switched to floating, each window that has a remembered floating rectangle is restored to it once.

### Scrolling (experimental)

**Off unless you select it**: set `layout` to `scrolling` (flat key or JSON, globally or in an override), or run *Scrolling layout* in a context. It is experimental: tested with mock and nested-KWin scenarios only, and not yet checked on physical monitors (see below).

- **Strip:** each screen and desktop has a horizontal strip of columns. A new window gets a new column right of the focused one. Windows can share a column, stacked vertically (*consume* / *expel*). A column's width is a fraction of the usable width: ½ by default; *width-cycle* steps through ⅓, ½, ⅔ and full width. A column is never narrower than the minimum width of a window in it.
- **Scrolling follows focus:** focusing a window by command, click, Alt+Tab or an application activating it scrolls the strip so the window's column is fully visible. With `lazy` (default) the strip scrolls only as far as needed and never past its ends; with `centered` the focused column is centred. An activated dialog floats, and its parent's column is scrolled into view. Scrolling moves windows without resizing them and is instantaneous (no animation).
- **Columns off screen** (not fully visible) are moved outside every monitor: above their own screen, or below, left or right of it when that place is taken, always nearest their own screen so KWin keeps them there. They keep their size. Plastile never hides windows with transparency, minimizing or taskbar flags. If a screen is surrounded by other screens on all four sides, columns that do not fit are kept at the screen's edge, overlapping, and the explanation says so.
- **Leaving:** suspending, unloading, switching the context to another layout, disabling tiling there, a rule floating a window, or *Reconcile* brings every off-screen window back inside its screen's usable area.

Settings (JSON only): `scrolling.policy` (`lazy` or `centered`), `scrolling.defaultWidth` and `scrolling.widthPresets` ([CONFIGURATION](CONFIGURATION.md#scrolling-layout-settings-experimental)). Commands: [SHORTCUTS](SHORTCUTS.md#scrolling-layout-experimental).

Known limitations:

- **Physical-session checks are open.** That windows moved outside every monitor show no pixels and take no pointer input on neighbouring monitors at mixed scales is an inference from KWin's behaviour; the nested test compositor cannot show where pixels land on real monitors.
- When screens change (a monitor plugged, a scale changed), KWin pulls off-screen windows partly back on screen. Plastile moves them out again in the same update (measured about 5 ms in nested KWin), so they may flash briefly.
- The strip (columns, widths, scroll position) lasts for the KWin session only; it is not saved.
- Unlike the other layouts, focus changes move windows here, so focus is more expensive than in master/stack. No latency comparison with a scrolling baseline has been made.

### Zones (experimental)

**Off unless you select it**: set `layout` to `zones` (flat key or JSON, globally or in an override), or run *Zones layout* in a context. It is experimental: tested with mock and nested-KWin scenarios only, and not yet checked on physical monitors (see below).

- **Manual placement:** a zones context places only the windows you assign to a zone, with *Zones: assign window to zone 1…9*, *next* or *previous zone*, or with a rule's `zone` action for new windows. Every other window there is an ordinary floating window that Plastile does not move. Selecting the layout moves nothing.
- **Zone layouts:** `halves`, `thirds`, `grid-2x2` and `main-side` are built in, and you can define up to 16 more ([CONFIGURATION](CONFIGURATION.md#zones-layout-settings-experimental)). *Zones: next zone layout* steps through them for one context; windows keep their zone number when the new layout has it, and the others stay where they are.
- **Sharing a zone:** windows assigned to the same zone are stacked; the one assigned or activated most recently is on top.
- **Too big for its zone:** a window whose minimum size does not fit gets the zone's top-left corner and its minimum size, and its explanation says so. Plastile does not keep resizing it.
- **Leaving a zone:** *Zones: release window from its zone* leaves the window where it is. *Toggle floating* puts it back where it floated before. Moving or resizing it with the mouse releases it where you put it. Switching the context to another layout, *Reset this layout*, suspending and unloading release every window without moving it.
- **Overlay:** *Zones: show or hide the zone overlay* draws the active screen's zones and their numbers, from the same rectangles windows are placed in. It does not take clicks for itself: windows under it keep receiving pointer motion and scrolling. A small legend at the top holds the keyboard while the overlay is shown, like a menu: Escape closes it, as does a click anywhere (that click only closes it) or the same command. Shortcuts keep working. The overlay is never needed: keyboard placement works without it.

Settings (JSON only): `zoneLayouts` and `zones.layout`; rule action `zone` ([CONFIGURATION](CONFIGURATION.md#zones-layout-settings-experimental)). Commands: [SHORTCUTS](SHORTCUTS.md#zones-layout-experimental).

Known limitations:

- **Physical-session checks are open:** how the overlay looks at mixed scales, whether its numbers are legible, and pointer pass-through on real input devices. Pointer pass-through rests on KWin's source (an input-transparent internal window is skipped by hit testing), not on a measurement.
- Assignments and the context's zone layout choice last for the KWin session only; they are not saved.
- The overlay shows the state when it was opened, refreshed by Plastile's own commands. Other changes (a window closing, a panel appearing) show the next time it is opened.
- Dragging a window into a zone is not implemented.

### Overflow

A context may be unable to fit every window above its minimum size. Plastile then keeps the windows that were there first and floats each newer window that does not fit next to them (`overflow: float-new`, the only policy implemented); a window whose minimum size does not fit the area even on its own floats by itself, without taking newer windows with it. The reason appears in the window's explanation. Existing tiles are never shrunk below their minima, and no desktops are created or removed.

## Which windows are tiled

**Tiled:** normal, resizable application windows on exactly one desktop.

**Floating by default:**

- dialogs, utility windows, transient or modal windows, and other non-normal types
- fixed-size or non-resizable windows
- windows on several or all desktops, or on several activities
- a short list of helper applications: portal and polkit agents, the KDE Connect daemon and the emoji picker

A rule or *Toggle floating* can tile dialogs, utilities, transients and helpers, as long as the window is resizable. Neither can tile fixed-size or multi-desktop windows.

**Never managed:** docks and panels, the desktop, notifications, tooltips, menus, popups, OSDs, splash screens, toolbars and drag icons. Also never managed: Plasma shell, KRunner, the lock screen, the logout greeter, KWin's own surfaces, the XWayland video bridge, and surfaces of 2 px or less. No rule can change this.

The full logic is in [CONFIGURATION](CONFIGURATION.md#how-windows-are-classified). To see why a window is treated the way it is, focus it and run *Explain active window*: a small inspector window states it in plain words ([details](CONFIGURATION.md#seeing-why-a-window-was-classified)).

## Floating windows and native quick tiling

Plastile does not fight you or the application indefinitely:

- **Toggle floating** (`Meta+Shift+F`, measured to work as a real key press) takes a window out of the layout and gives it back its last floating rectangle. A rectangle from another screen, including one that has since been unplugged, is placed at the same relative position on the window's current screen, inside its usable area. A window that never floated gets a centred rectangle of 60% of the screen's usable area, within the window's own size limits. Plastile then leaves it to you until you tile it again. Floating windows are ordinary KDE windows: move, resize and maximize them as usual.
- **Native quick tiling** (`Meta+Left/Right/Up/Down`, or dragging to a screen edge) is respected. The window is released to KWin's tile, the remaining windows re-solve without it, and nothing snaps back. *Adopt natively tiled window* or *Toggle floating* puts it back in the layout. KWin's tile editor (`Meta+T`) is untouched.
- **Maximize and fullscreen** suspend Plastile's placement for that window. Leaving the state returns the window to its slot. A window that opened already fullscreen joins the layout when it leaves fullscreen, like any other window of its kind (KWin reports every window as not resizable while fullscreen is requested, so Plastile reads that again when the state ends).
- **Interactive move:** dragging a tile re-tiles nothing while you drag. Dropping it on another tile swaps the two; dropping it anywhere else snaps it back. Meta+right-drag resizing moves the shared divider.
- **Applications that resize themselves** or refuse the requested size are corrected at most twice per target. Plastile then leaves them alone and records why (see *Explain active window*). A client that settles at a larger size than requested has that size learned as its minimum, and the layout is re-solved around it. A client that settles up to 32 px smaller (a terminal sizing itself in character cells) is accepted as it is.

Plastile never sets a window maximized, minimized, fullscreen or kept-above to make a layout fit. It never changes KWin's focus policy and never moves the cursor. The window state it writes is limited to: frame geometry, activation and raising (focus commands, monocle), the output and desktop (send commands), releasing a native quick tile (adopt), and the border, when a rule asks for `border` (measured in nested KWin). Its only window of its own is the inspector, which is never tiled.

## Saved layout preferences

Plastile remembers some of what you change with its commands across script reloads, KWin restarts and logins:

- **Per screen, desktop and activity:** a layout you chose with a layout command, and a master ratio or master count you changed with *Grow*/*Shrink*, *More*/*Fewer masters* or by dragging the divider. *Reset context* removes them for that screen and desktop.
- **Per application:** where you put a window you floated with *Toggle floating*. The application is identified by its application id, resource name and window role, never by its title. When that application next has exactly one window open, the window floats there again (placed on its current screen if that is another one). With two or more windows of the application open, none of them gets the saved position, and they tile as usual. Tiling the window again with *Toggle floating* forgets the application's saved position.

Window order, BSP split structure, quick-tile and maximize states, and per-window choices for applications with several windows are not saved. Your configuration (gaps, rules, overrides) is not part of this state either. It stays in `kwinrc`.

**Where:** `~/.local/state/plastile/state-0.ini` and `state-1.ini` (or under `$XDG_STATE_HOME`). The two files hold alternate saves, so an interrupted save leaves the previous one usable. A damaged file or a file from a newer Plastile is ignored with one `plastile warn saved state rejected` line in the log. A newer Plastile's file is left untouched.

**When:** about 2 seconds after your last change, and when the script stops cleanly. Never while a command runs or while you drag a window. Each save is a short synchronous file write inside KWin. It measured 2 to 8 ms in nested sessions, and up to 20 ms ([ADR-013](../design/DECISIONS.md#adr-013-persist-session-preferences-through-qtcore-settings)). Unchanged state is not rewritten.

**Reset:** disable Plastile, delete `~/.local/state/plastile/`, and enable it again. Deleting the files while Plastile runs is not enough: the next change saves the in-memory state again.

Saving needs Qt's `QtCore` QML module, which Plasma's own QML depends on. Without it Plastile tiles normally, logs `plastile warn persistence unavailable` once, and forgets your changes at the next reload.

## Where this project is going

The user-visible scope today is the automatic tiler described above, plus the experimental scrolling and zones layouts. Drag previews, a zone editor and animations are later milestones ([roadmap](../implementation/ROADMAP.md)). Nothing in this guide is a promise about them. Design intent beyond what is implemented lives in the [behaviour specification](../design/BEHAVIOR_SPEC.md). Where that document and this guide disagree, this guide describes the code.
