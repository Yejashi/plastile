# Plastile user guide

Plastile adds automatic tiling to **KDE Plasma 6 on Wayland**. It is a KWin script: a TypeScript policy core bundled into a declarative (QML) KWin script package. Per screen and virtual desktop, it arranges ordinary application windows into master/stack, binary-split (BSP) or monocle layouts, driven by keyboard shortcuts. KWin stays in charge of everything else: focus policy, decorations, maximize, fullscreen, minimize, native quick tiling and the tile editor.

Pages in this guide:

- [INSTALL](INSTALL.md): build, install, enable, settings dialog, applying settings changes.
- [SHORTCUTS](SHORTCUTS.md): every command, its default key and what it does.
- [CONFIGURATION](CONFIGURATION.md): settings keys, the JSON document (overrides and rules), precedence, classification.
- [TROUBLESHOOTING](TROUBLESHOOTING.md): diagnostics, logs, known limitations.

New here? Read [Is it working?](#is-it-working) first: some layouts look like no tiling at all.

Labels used in this guide: **measured** (observed in a test run), **observed source** (read in upstream source at a pinned version), **inference** (reasoned, not observed), **untested**.

## Status: read this first

Plastile 0.1.0 is a **release candidate**, not a qualified release. The gates still open are listed in the [G3 checklist](../status/G3_CHECKLIST.md). It has no licence yet ([ADR-012](../design/DECISIONS.md#adr-012-license-and-upstream-reuse-are-deliberate)).

| What | Where it stands |
|---|---|
| Tested compositor | KWin **6.7.5** (Qt 6.12.0, KF 6.30.0, Arch Linux), see the [environment profile](../status/ENVIRONMENT.md). `metadata.json` declares a minimum Plasma API of 6.7. KWin 6.7.5 is also tested in an Ubuntu 26.10 sandbox; KWin **6.8.0** runs in a provisional CI job that still has open failures (memory growth across repeated script reloads, attributed to KWin 6.8 itself, see [status](../status/STATUS.md)). Other versions are untested. |
| How it was tested | Unit and replay tests, and **disposable nested `kwin_wayland --virtual` sessions** with a controlled Wayland test client and real input injection (libei). Every geometry check reads window frames from KWin itself, never from Plastile's own bookkeeping. |
| Physical session | **Partly validated.** The physical runbook ran on one desktop (KWin 6.7.5, three outputs at 60, 100 and 144 Hz, scale 1, plasmashell panels, the owner's applications) with build `97fec4a`. Install, outputs and fractional scale, panels, activities, real applications, shortcuts and idle passed. Latency failed at 144 Hz for two workloads and is incomplete at 100 Hz; cable unplug and system suspend were skipped; the soak is still running ([evidence](../status/evidence/physical-runbook-20261018.json)). Changes after `97fec4a` (the hidden-desktop work-area fix, windows that open maximized) have not run physically. |
| Performance | See [Performance: what was measured](#performance-what-was-measured). Every number there names its layer: nested or physical. |

### What works (measured in nested KWin 6.7.5)

The last full nested suite on the reference host passed: 141 scenarios, 1897 of 1897 checks, one expected SKIP (`output-negative-origin-G02`: KWin normalizes output origins), at commit `5773b61` ([evidence](../status/evidence/integration-host-5773b61.json)). Each item below is covered by one or more of its scenarios, except where it says otherwise.

- Adopting existing windows at load, tiling new windows and reflowing on close, with bounded work for a burst of nine windows.
- Master/stack, BSP and monocle layouts, and switching between them with window order preserved. BSP rotate, mirror, reinsert and equalize. The floating layout does not fight user geometry.
- Focus, swap and grow/shrink commands. Focus commands never write geometry (except in the experimental scrolling layout, where focus scrolls). Commands with nothing to do write nothing.
- Clients that resize themselves, ignore requested sizes or clamp them. Plastile corrects such a client at most twice per target, then leaves it alone with an explanation. A slow client (300 ms) that reverses a grow/shrink still ends where the model says.
- Fullscreen, maximize and minimize are respected: KWin keeps ownership while the state lasts, peers reflow, and the window returns to its slot afterwards. Overlapping states are handled.
- Native quick tiling (`Meta+arrow`) is kept and not snapped back. *Adopt natively tiled window* brings the window back into the layout.
- Toggling a window floating and back to tiled; the last floating rectangle is restored, on the window's current screen when it moved to another one (two screens).
- Saved layout preferences (a master ratio, a floated window's position) survive script reloads and a KWin restart when the persistence helper is installed ([below](#saved-layout-preferences)); a damaged state file falls back to defaults with one log line (scenario files `scenarios_persist.py`, run separately from the 23 scenarios counted above).
- Transient dialogs float; main windows tile.
- Two outputs: send a window to the other output, output scale changes from 1.25 to 2, portrait rotation, unplugging an output with requests in flight, and replugging it. A layout chosen for a screen comes back when the screen is replugged. Screens are identified by the monitor's manufacturer, model and serial number when KWin reports them, so that also holds on another connector (unit-tested only: the nested virtual outputs report none and are identified by connector name). Two identical monitors are told apart by connector.
- Sending a window to another desktop without following it; that desktop is tiled when it is first shown. With `followOnSend`, the desktop is shown on the window's screen and the window activated (two screens, per-screen desktops).
- 100 unload/reload cycles with pending work (`reload-Q09`): stable connection and window counts, one shortcut per command, no errors. On KWin 6.7.5 KWin's RSS grew 0.5 MiB over the 100 cycles.
- Configuration: invalid values are rejected with a message and the previous configuration is kept. Values are re-read live when KWin reconfigures (see [applying settings](INSTALL.md#applying-settings-changes) for which paths do that).
- Idle: no timers, polling or writes while nothing happens (3 s window). Suspend and resume.
- Pointer drags. Dropping a tile onto another tile swaps them on release, with no re-tiling during the drag. Dropping it into a gap snaps it back. Meta+right-drag resizing moves the shared divider. Closing the window or unloading the script mid-drag leaves no errors.
- Real keyboard input: all 20 default bindings reach Plastile when pressed through libei in a nested session (US keymap). Three earlier defaults that did not were replaced; see [SHORTCUTS](SHORTCUTS.md#default-bindings-measured-with-real-key-presses).
- Activities (the Activities service started late, a second activity added, windows on two activities float), plasmashell panels and work-area changes, per-screen virtual desktops, XWayland applications, and real applications (Dolphin, System Settings, GNOME Calculator, Alacritty, Firefox, Chromium, xmessage, zenity).
- Windows that open maximized are un-maximized once and tiled (`maximizedOnOpen`, [ADR-021](../design/DECISIONS.md#adr-021-a-window-that-arrives-maximized-is-un-maximized-and-tiled)). This and the hidden-desktop work-area fix pass nested (`maximized-open-*-T17`, `workarea-hidden-desktop-O07`) but came after the physical build `97fec4a`, so they have not run physically yet.

### What is not covered

- **Physical latency:** grow/shrink and focus fail their latency comparison at 144 Hz, and the 100 Hz run is incomplete ([below](#performance-what-was-measured)).
- **Physical topology:** unplugging a monitor and suspending the machine were not checked in a physical session (the owner skipped them). VRR was not covered (the reference monitors report it as not capable).
- **In-app actions in a physical session:** clicking titlebar buttons and tabs of tiled windows, and turning a window's border off and on (G14, G15). The injector sends only Meta chords.
- **Long sessions:** a 3.83 h physical soak with the desktop left alone showed no growth in KWin's memory or Plastile's connections; a soak with normal use has not run.
- **KWin 6.8:** only a provisional CI job.
- **Scrolling and zones:** experimental, nested only.
- **Uninstall in a physical session.**

The engine is designed for these cases, but designed is not tested.

### Physical checks (reference desktop)

Run with the owner's consent, following the [physical runbook](../validation/PHYSICAL_RUNBOOK.md), on KWin 6.7.5, Qt 6.12.0, OpenGL, outputs HDMI-A-1 2560×1440 @ 144 Hz, DP-2 1920×1080 @ 100 Hz and DP-1 1920×1080 @ 60 Hz, all scale 1, build `97fec4a` ([evidence](../status/evidence/physical-runbook-20261018.json)).

- **Passed:** session check; install and smoke test (started at the default log level, 68 shortcuts, errors 0, the persistence helper activated by the session bus); windows on three outputs at mixed refresh rates and sending a window between them; scales 1.25, 1.5 and 1.75 and back; output priority changes; a test panel added, resized, auto-hidden, made floating, moved and removed; activities created, switched and deleted; Dolphin (Wayland and XWayland), Chromium, GNOME Calculator, System Settings, xmessage and a zenity dialog; 19 of 19 injected default shortcuts and *Suspend/resume* by hand; no Plastile work while idle.
- **Found and fixed after that build:** a tiled window on a desktop not shown was moved by KWin when a panel appeared, and Plastile corrected it toward its old tile; now nothing is written to a window whose desktop is not shown (`a5642dd`). The owner's terminal opens every window maximized, so it was never tiled; now such windows are un-maximized once and tiled (ADR-021). Neither fix has run physically yet.

## Is it working?

Monocle, the floating layout and a maximized window all look exactly like no tiling at all. Before you conclude that Plastile does nothing, check these:

- **The log.** Run `journalctl --user -b | grep plastile`. At the default log level you see a few `plastile notice` lines and nothing per window:
  - `plastile notice started 0.1.0: 3 windows, configuration revision 1; layout master-stack on eDP-1 / Desktop 1` when Plastile loads, with the layout of each screen's visible desktop;
  - `plastile notice restored saved layout monocle for eDP-1 / Desktop 2` once at load, when a layout you chose earlier comes back ([saved layout preferences](#saved-layout-preferences));
  - `plastile notice layout monocle on eDP-1 / Desktop 2 (was bsp)` each time a layout command changes a layout;
  - `plastile notice tiling paused` and `plastile notice tiling resumed` for *Suspend/resume tiling*;
  - `plastile notice stopped` when Plastile unloads.

  No `started` line means the script is not running (KWin Scripts, [INSTALL](INSTALL.md#3-enable-in-system-settings)). Only the `error` and `off` log levels hide these lines ([TROUBLESHOOTING](TROUBLESHOOTING.md#reading-the-log)).
- **The on-screen message.** A layout command and *Suspend/resume tiling* show Plasma's own on-screen display, the one used for volume and brightness: "Monocle layout — Desktop 2", "Floating layout (tiling off) — Desktop 2", "Tiling paused". The desktop is named when you have more than one, and the screen when you have more than one. Turn it off with the `osd` setting ([CONFIGURATION](CONFIGURATION.md#flat-keys)). Without plasmashell there is no message, only the log line; if plasmashell was not running yet (at login) or restarted, the message comes back with your next command 30 s or more after the failed one.
- **Monocle and floating.** Monocle gives every window the whole screen, one in front of the other; floating tiles nothing. `Meta+Shift+Space` (*Next layout*) cycles master/stack → BSP → monocle → floating → master/stack, so two presses from the default lead to monocle and three to floating. *Reset this layout* (`plastile.context.reset`, unbound by default; [bind it](SHORTCUTS.md#rebinding) or run it from a terminal) returns the desktop on screen to your configured layout.
- **Layouts are remembered per desktop across logins.** A layout you chose with a command stays on that screen and desktop after a re-login, until you choose another one or reset it ([saved layout preferences](#saved-layout-preferences)). Each desktop has its own: switching desktops can show another layout.
- **A maximized or full-screen window.** KWin owns it while it is maximized or full screen, so it covers the tiles; Plastile keeps its place and tiles it again when you restore it. *Explain active window* says so in its first line. A new window that opens maximized is tiled by default; with `maximizedOnOpen=keep` it stays maximized.
- **Log counters** (`plastile.inspect.counters`) lists, per screen and desktop, the `layout`, the `members`, how many are `tiled` now and how many are `suspended` (maximized, full screen, minimized), and whether all tiling is suspended ([TROUBLESHOOTING](TROUBLESHOOTING.md#log-counters)).

Layout commands (the layout shortcuts, *Grow*/*Shrink*, *More*/*Fewer masters*, *Reset this layout*) change the desktop you are looking at on the active window's screen, also when they arrive over D-Bus while a window of another desktop is active.

## Layouts

A **context** is one screen, one virtual desktop and one activity. Every context has its own layout, window order and structure. The configured default layout applies everywhere. The layout shortcuts change the context on screen: the active window's when it is visible, otherwise the visible desktop of the active window's screen (or of the active screen when no window is active). That choice is remembered across logins ([saved layout preferences](#saved-layout-preferences)) until another layout command or *Reset this layout*. Per-screen or per-desktop defaults belong in the configuration as [overrides](CONFIGURATION.md#overrides).

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
- **Scrolling follows focus:** focusing a window by command, click, Alt+Tab or an application activating it scrolls the strip so the window's column is fully visible. With `lazy` (default) the strip scrolls only as far as needed and never past its ends; with `centered` the focused column is centred. An activated dialog floats, and its parent's column is scrolled into view. Scrolling moves windows without resizing them and is instantaneous; the optional [Plastile Motion effect](CONFIGURATION.md#window-motion-the-plastile-motion-effect) can animate the columns that stay on screen, while a column scrolled in or out appears or disappears at once.
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
- **Maximize and fullscreen** suspend Plastile's placement for that window. Leaving the state returns the window to its slot. A window that *opens* maximized because the application chose it (some terminals do) or a KWin rule *Maximized: Apply initially* did is un-maximized once and tiled instead, unless `maximizedOnOpen` is `keep` ([CONFIGURATION](CONFIGURATION.md#flat-keys)). A maximize you make afterwards is kept, and so is a maximize the application asks for again. Windows that would not tile anyway (dialogs, floating windows, a KWin rule that *forces* maximize, windows the layout has no room for) and windows open before Plastile started stay maximized. A window that opens maximized on a desktop not shown is decided when you switch to it. *Explain active window* says which happened. A window that opened already fullscreen joins the layout when it leaves fullscreen, like any other window of its kind (KWin reports every window as not resizable while fullscreen is requested, so Plastile reads that again when the state ends).
- **Interactive move:** dragging a tile re-tiles nothing while you drag. Dropping it on another tile swaps the two; dropping it anywhere else snaps it back. Meta+right-drag resizing moves the shared divider.
- **Applications that resize themselves** or refuse the requested size are corrected at most twice per target. Plastile then leaves them alone and records why (see *Explain active window*). A client that settles at a larger size than requested has that size learned as its minimum, and the layout is re-solved around it. A client that settles up to 32 px smaller (a terminal sizing itself in character cells) is accepted as it is.

Plastile never sets a window maximized, minimized, fullscreen or kept-above to make a layout fit; the one maximize state it changes is that of a window that opened maximized, which it un-maximizes once (`maximizedOnOpen`). It never changes KWin's focus policy and never moves the cursor. The window state it writes is limited to: frame geometry, activation and raising (focus commands, monocle), the output and desktop (send commands), releasing a native quick tile (adopt), and the border, when a rule asks for `border` (measured in nested KWin). Its own windows are the inspector and, in the experimental zones layout, the zone overlay and its legend (which holds the keyboard while it is shown); none of them is ever tiled.

## Window motion (optional)

Plastile itself moves and resizes windows at once; there is no animation setting in Plastile. If you want windows
to visibly slide and resize into place, enable the separate **Plastile Motion** desktop effect, installed with
Plastile and off by default ([INSTALL](INSTALL.md#8-window-motion-optional),
[settings](CONFIGURATION.md#window-motion-the-plastile-motion-effect)).

- It changes only how windows are drawn for about 180 ms. The window is already at its new place: clicks go there,
  and the application has its new size.
- Rapid commands redirect the running animation; they never wait for it.
- The global animation speed scales it, and *Instant* turns it off.
- Dragging, maximize, fullscreen, newly opened windows, desktop switches, screen changes (including a scale
  change) and scrolling columns entering or leaving the screen are not animated.
- It animates any program's moves, not only Plastile's, because it cannot tell them apart.
- Measured in nested KWin 6.8.1 only: smoothness on real displays (60/100/144 Hz) is not yet judged.

## Saved layout preferences

Plastile remembers some of what you change with its commands across script reloads, KWin restarts and logins:

- **Per screen, desktop and activity:** a layout you chose with a layout command, and a master ratio or master count you changed with *Grow*/*Shrink*, *More*/*Fewer masters* or by dragging the divider. *Reset this layout* removes them for the screen and desktop on screen. At load, one `plastile notice restored saved layout ...` line names every restored layout that differs from your configuration.
- **Per application:** where you put a window you floated with *Toggle floating*. The application is identified by its application id, resource name and window role, never by its title. If you disable and re-enable Plastile while the window you floated is still open, that window floats again exactly where it is now, even if you moved it in between and even if its application has other windows open. Otherwise, when that application next has exactly one window open, the window floats at the saved position again (placed on its current screen if that is another one). With two or more windows of the application open, none of them gets the saved position, and they tile as usual. Tiling the window again with *Toggle floating* forgets the application's saved position.

Window order, BSP split structure, quick-tile and maximize states, and per-window choices for applications with several windows are not saved. Your configuration (gaps, rules, overrides) is not part of this state either. It stays in `kwinrc`.

**Needs the persistence helper.** Saving and restoring go through `plastile-state`, a small helper program installed beside the script with `tools/install.sh install-helper` ([install guide](INSTALL.md#persistence-helper)). KWin itself never reads or writes the files; it sends the helper asynchronous D-Bus requests and does not wait for them ([ADR-020](../design/DECISIONS.md#adr-020-persistence-goes-through-an-asynchronous-d-bus-helper)). With only the KWin script installed, Plastile tiles normally, logs `plastile warn persistence unavailable` once, and keeps your changes until the script reloads or KWin restarts.

**Where:** `~/.local/state/plastile/state-0.json` and `state-1.json` (or under `$XDG_STATE_HOME`), readable only by you. The two files hold alternate saves, and each save replaces its file atomically, so an interrupted save leaves the previous one usable. A damaged file or a file from a newer Plastile is ignored with one `plastile warn saved state rejected` line in the log. A newer Plastile's file is left untouched.

**When saved:** about 2 seconds after your last change, and when the script stops cleanly, also when KWin itself exits (measured in nested sessions; at a physical logout it is not measured: on the laptop's physical session a chosen layout survived a re-login, but that does not show which save carried it); never while a command runs. Unchanged state is not rewritten. In nested sessions handing a save to the helper took about 0.2 ms of KWin's time for a typical state and about 1.2 ms for the largest one (64 screen/desktop entries and 64 floated applications), and a stopped or slow helper did not slow KWin or its commands.

**When restored:** when Plastile starts, it waits for the helper's answer before laying out any window, for at most 250 ms; in nested sessions the answer came within a few milliseconds. The first layout then already has the saved preferences, and a restored float is not tiled first. If the helper is slow, Plastile starts with its defaults after 250 ms and applies the saved preferences when they arrive, so the layout can change once. Your shortcuts work during the wait: their effect is part of the first layout. A change you make before the answer arrives wins over the saved one.

**Reset:** disable Plastile, delete `~/.local/state/plastile/`, and enable it again. Deleting the files while Plastile runs is not enough: the next change saves the in-memory state again.

## Performance: what was measured

Every number below names its layer. **Nested** numbers come from disposable `kwin_wayland --virtual` sessions on the reference host and say nothing about what reaches a real screen. **Physical** numbers come from the owner's desktop. The budgets they are compared with are [proposed targets](../validation/PERFORMANCE.md#4-proposed-budgets), not guarantees.

**Methods.** Nested: 32 tiled test windows plus three inactive desktops, commands sent through KGlobalAccel's D-Bus `invokeShortcut` in seeded random order, 5 runs × 1000 samples per cell, `CLOCK_MONOTONIC` inside KWin's script engine, every sample kept, p99 only from at least 5000 samples, 95 % intervals from a bootstrap over whole runs ([G2 report](../status/G2_REPORT.md) §1–§2). Physical: a virtual keyboard (uinput) presses the real shortcut; the test windows log the configures they receive and KWin's presentation feedback (`wp_presentation`) on the same clock; 4 windows, 5 runs × 1000 samples per workload, compared with KWin's own action on the same output ([runbook P6](../validation/PHYSICAL_RUNBOOK.md#p6-input-to-visible-latency-p00-p03)). Presentation times are what KWin reports to the client, not photon times.

**Nested (KWin 6.7.5, reference host).**

| Measure | Result | Proposed budget |
|---|---|---|
| Command dispatch → last geometry request, 32 windows, grow/shrink | p95 1.59 ms, p99 1.90 ms | p95 ≤ 2, p99 ≤ 4 ms: met |
| Layout solve, 32 windows | Since `212d86b`: p95 0.14–0.15 ms, p99 0.17 ms ([G2 report §16](../status/G2_REPORT.md#16-follow-up-the-median-slowdown-and-the-pure-solve-p99-nested-virtual-kwin-675-2026-10-19)). Before: p99 1.06–1.07 ms, from the script engine's garbage collection running inside 2–3 % of solves | p95 ≤ 0.5, p99 ≤ 1 ms: met since `212d86b` (nested) |
| Focus commands | 0 layout solves and 0 geometry writes in 50,000 commands | 0: met |
| Idle | no Plastile work, KWin wakeup or log line in 60 s windows after 20 min of churn | none: met |
| Swap, 3 windows, send → first configure, against Polonium 1.2.2 | Plastile p50 0.83 ms, Polonium 11.3 ms | comparison only |

Source: [G2 report §3–§8](../status/G2_REPORT.md#3-4-budgets). The Polonium comparison is one nested workload; it is not a ranking of KDE tilers.

**Physical (reference desktop, build `97fec4a`): key press → first presented frame, median.** The proposed budget is a median difference below one refresh interval and a p95 difference of at most one interval against the matched KWin baseline.

| Output | Plastile workload | Plastile | KWin baseline | Verdict |
|---|---|---|---|---|
| DP-1, 60 Hz | Grow/shrink | 30.7 ms | quick tile 33.2 ms | pass |
| DP-1, 60 Hz | Swap with master | 25.8 ms | quick tile 33.2 ms | pass |
| DP-1, 60 Hz | Focus next | 20.8 ms | window switch 16.7 ms | pass |
| HDMI-A-1, 144 Hz | Grow/shrink | 50.2 ms | quick tile 38.7 ms | **fail** (+11.5 ms; p95 +30.3 ms) |
| HDMI-A-1, 144 Hz | Swap with master | 15.4 ms | quick tile 38.7 ms | pass |
| HDMI-A-1, 144 Hz | Focus next | 25.0 ms | window switch 14.7 ms | **fail** (+10.3 ms) |
| DP-2, 100 Hz | — | — | — | incomplete: the run stopped early, only one run of three workloads finished; re-run pending |

Where the time goes, at 144 Hz: from the key press to the application receiving its new size took 0.6 ms for Plastile's grow/shrink and 0.28 ms for KWin's quick tile. The difference is between the application's commit and KWin presenting it (grow 84.5 ms, shrink 43.2 ms, quick tile 36–53 ms median). That is KWin's presentation of resized windows, consistent with its animation effects (inference, not yet isolated). For focus, the activation reached the application after 9.9 ms against 3.05 ms for KWin's switch. Most of that is the desktop's Aurorae decoration re-rendering both windows' frames, which grows with window area: Plastile's tiles are much larger than KWin's default 400×300 placement ([PERFORMANCE §5.1](../validation/PERFORMANCE.md#51-focus-activation-cost-depends-on-the-decoration-and-window-size)). A 1.2 ms difference at equal window size is still unexplained. In every physical block Plastile did one layout solve per grow/shrink or swap and no corrections, and 0 solves and 0 writes for 10,500 focus commands.

Idle, physical: three 300 s periods each with Plastile loaded and not loaded; Plastile did no work while idle, and KWin's CPU use was 1.54 % in both (median). That is not a claim of 0 % CPU.

## Where this project is going

The user-visible scope today is the automatic tiler described above, plus the experimental scrolling and zones layouts, and the optional Plastile Motion effect. Drag previews and a zone editor are later milestones ([roadmap](../implementation/ROADMAP.md)). Nothing in this guide is a promise about them. Design intent beyond what is implemented lives in the [behaviour specification](../design/BEHAVIOR_SPEC.md). Where that document and this guide disagree, this guide describes the code.
