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
| Tested compositor | KWin **6.7.5** (Qt 6.12.0, KF 6.30.0, Arch Linux), see the [environment profile](../status/ENVIRONMENT.md). `metadata.json` declares a minimum Plasma API of 6.7. Other versions are untested. |
| How it was tested | In **disposable nested `kwin_wayland --virtual` sessions** with a controlled Wayland test client and real input injection (libei). Every geometry check reads window frames from KWin itself, never from Plastile's own bookkeeping. |
| Physical session | **Not validated.** Plastile has never run in a live Plasma desktop with plasmashell panels, real monitors and everyday applications. Treat everything in this guide as unverified in that setting. |
| Performance | Engine timings exist only from nested sessions and measurement builds ([status](../status/STATUS.md), [M0 probe report](../status/M0_PROBE_REPORT.md)). None of them is an input-to-photon latency claim. |

### What works (measured in nested KWin 6.7.5)

The 23 core integration scenarios in `tests/integration/scenarios.py` passed: 102 of 102 checks, run on 2026-10-17 against commit `819a91c` with an uncommitted working tree. Each item below is covered by one or more of them.

- Adopting existing windows at load, tiling new windows and reflowing on close, with bounded work for a burst of nine windows.
- Master/stack, BSP and monocle layouts, and switching between them with window order preserved. BSP rotate, mirror, reinsert and equalize. The floating layout does not fight user geometry.
- Focus, swap and grow/shrink commands. Focus commands never write geometry. Commands with nothing to do write nothing.
- Clients that resize themselves, ignore requested sizes or clamp them. Plastile corrects such a client at most twice per target, then leaves it alone with an explanation. A slow client (300 ms) that reverses a grow/shrink still ends where the model says.
- Fullscreen, maximize and minimize are respected: KWin keeps ownership while the state lasts, peers reflow, and the window returns to its slot afterwards. Overlapping states are handled.
- Native quick tiling (`Meta+arrow`) is kept and not snapped back. *Adopt natively tiled window* brings the window back into the layout.
- Toggling a window floating and back to tiled; the last floating rectangle is restored.
- Transient dialogs float; main windows tile.
- Two outputs: send a window to the other output, output scale changes from 1.25 to 2, portrait rotation, unplugging an output with requests in flight, and replugging it.
- Sending a window to another desktop without following it; that desktop is tiled when it is first shown.
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

The full logic, and how to see why a window was classified, are in [CONFIGURATION](CONFIGURATION.md#how-windows-are-classified).

## Floating windows and native quick tiling

Plastile does not fight you or the application indefinitely:

- **Toggle floating** (`Meta+Shift+F`, measured to work as a real key press) takes a window out of the layout and gives it back its last floating rectangle. Plastile then leaves it to you until you tile it again. Floating windows are ordinary KDE windows: move, resize and maximize them as usual.
- **Native quick tiling** (`Meta+Left/Right/Up/Down`, or dragging to a screen edge) is respected. The window is released to KWin's tile, the remaining windows re-solve without it, and nothing snaps back. *Adopt natively tiled window* or *Toggle floating* puts it back in the layout. KWin's tile editor (`Meta+T`) is untouched.
- **Maximize and fullscreen** suspend Plastile's placement for that window. Leaving the state returns the window to its slot.
- **Interactive move:** dragging a tile re-tiles nothing while you drag. Dropping it on another tile swaps the two; dropping it anywhere else snaps it back. Meta+right-drag resizing moves the shared divider.
- **Applications that resize themselves** or refuse the requested size are corrected at most twice per target. Plastile then leaves them alone and records why (see *Explain active window*). A client that settles at a larger size than requested has that size learned as its minimum, and the layout is re-solved around it. A client that settles up to 32 px smaller (a terminal sizing itself in character cells) is accepted as it is.

Plastile never sets a window maximized, minimized, fullscreen or kept-above to make a layout fit. It never changes KWin's focus policy and never moves the cursor. The window state it writes is limited to: frame geometry, activation and raising (focus commands, monocle), the output and desktop (send commands), releasing a native quick tile (adopt), and the border, when a rule asks for `border` (measured in nested KWin).

## Where this project is going

The user-visible scope today is the automatic tiler described above. Scrolling layouts, manual zones, drag previews, animations and persistence of session layout changes are later milestones ([roadmap](../implementation/ROADMAP.md)). Nothing in this guide is a promise about them. Design intent beyond what is implemented lives in the [behaviour specification](../design/BEHAVIOR_SPEC.md). Where that document and this guide disagree, this guide describes the code.
