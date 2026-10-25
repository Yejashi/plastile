# Plastile shortcuts

Every Plastile command is one KWin global shortcut. All of them are registered under the **KWin** component, and their labels start with `Plastile:`. The table below is derived from [`src/core/commands.ts`](../../src/core/commands.ts): 68 commands, 20 of them bound by default. The five scrolling commands and the fifteen zones commands are experimental (see [Scrolling layout](#scrolling-layout-experimental) and [Zones layout](#zones-layout-experimental)).

**Context.** Window commands (focus, swap, move, send, *Toggle floating*, *Adopt*) act on the **active window** and its context: the screen, virtual desktop and activity it is on. Layout commands (the `layout.*` commands, *Grow*/*Shrink*/*Equalize*, *More*/*Fewer masters*, *Reset this layout*) act on the context **on screen**: the active window's when it is visible, otherwise the visible desktop of the active window's screen (a window left active on another desktop, or a window on all desktops), otherwise the active screen's. When there is no active window, every command uses the active screen's visible desktop. A command that changes a layout, and *Suspend/resume tiling*, log one `plastile notice` line and show Plasma's on-screen display ([Is it working?](README.md#is-it-working)).

**Results.** "Accepted" means Plastile issued the geometry requests. It does not mean every client has committed its new size, or that a frame was presented. A command with nothing to do (already in that layout, nothing in that direction) is a no-op and writes nothing.

## Table

| Command id | Label in System Settings (after `Plastile:`) | Default | Behaviour |
|---|---|---|---|
| `plastile.focus.left` | Focus left | `Meta+Shift+H` | Activates the tiled neighbour to the left of the focused tile, on the same screen and desktop. Candidates lying fully beyond the facing edge win over others. Among them, one that overlaps vertically wins, then the nearest facing edge, then the larger overlap, then stable order. When nothing lies fully beyond the edge (irregular or overlapping frames, such as a size-limited window centred in its tile), a tile that reaches past the edge with its centre on that side is used; a tile beside the focused one never is. No wrap-around by default (with `focusWrap`, [CONFIGURATION](CONFIGURATION.md#settings-patch), it continues from the opposite end of the same row or column on the same screen), no screen change, no geometry change. If the active window is not tiled here, the most recently focused tile of the context is activated instead. |
| `plastile.focus.down` | Focus down | `Meta+Shift+J` | Same as *Focus left*, downwards. |
| `plastile.focus.up` | Focus up | `Meta+Shift+K` | Same as *Focus left*, upwards. |
| `plastile.focus.right` | Focus right | `Meta+Shift+L` | Same as *Focus left*, to the right. |
| `plastile.focus.next` | Focus next | `Meta+Shift+N` | Activates the next tiled window in the context's stable order (wraps around). In monocle, it also raises that window. |
| `plastile.focus.previous` | Focus previous | `Meta+Shift+P` | Activates the previous tiled window in stable order (wraps around). |
| `plastile.focus.master` | Focus master | *unbound* | Activates the first window in the order (the master in master/stack). |
| `plastile.focus.output-next` | Focus next output | *unbound* | Activates a window on the next screen. Screens are ordered by position (left edge, then top edge), not by how KWin enumerates them, and the order wraps around. On that screen it activates the window focused there most recently (tiled or floating, not minimized, on the desktop that screen shows), else that screen's first tile. No-op with one screen or when the next screen shows no window. No geometry change. |
| `plastile.focus.output-previous` | Focus previous output | *unbound* | Same as *Focus next output*, towards the previous screen. |
| `plastile.swap.left` | Swap with window to the left | `Meta+Ctrl+H` | Exchanges the focused tile with its left neighbour: their order positions in master/stack, their leaves in BSP. One re-solve. No-op when nothing lies in that direction or the active window is not tiled here. In monocle every tile has the same rectangle, so nothing lies in any direction and directional swap is a no-op; *Swap with next/previous window* and *Swap with master* reorder monocle windows. |
| `plastile.swap.down` | Swap with window below | `Meta+Ctrl+J` | Same as *Swap with window to the left*, downwards. |
| `plastile.swap.up` | Swap with window above | `Meta+Ctrl+K` | Same as *Swap with window to the left*, upwards. |
| `plastile.swap.right` | Swap with window to the right | `Meta+Ctrl+L` | Same as *Swap with window to the left*, to the right. |
| `plastile.swap.next` | Swap with next window | *unbound* | Exchanges positions with the next window in stable order (wraps). |
| `plastile.swap.previous` | Swap with previous window | *unbound* | Exchanges positions with the previous window in stable order (wraps). |
| `plastile.swap.master` | Swap with master | `Meta+Shift+Return` | Exchanges positions with the first window in the order. From the master slot, it swaps with the second window. |
| `plastile.move.left` | Move tile left (reinsert) | *unbound* | Structural reinsert. In BSP, it splits the left neighbour's tile and places the focused window on its left side. In master/stack, it moves the window to just before that neighbour in the order. Unlike *Swap*, the neighbour keeps its slot shape. A no-op in monocle, where no tile lies in any direction (see *Swap with window to the left*). |
| `plastile.move.down` | Move tile down (reinsert) | *unbound* | Same as *Move tile left*, downwards (BSP: below the neighbour; order layouts: just after it). |
| `plastile.move.up` | Move tile up (reinsert) | *unbound* | Same as *Move tile left*, upwards (BSP: above; order layouts: just before). |
| `plastile.move.right` | Move tile right (reinsert) | *unbound* | Same as *Move tile left*, to the right (BSP: right side; order layouts: just after). |
| `plastile.move.output-next` | Send window to next output | `Meta+Shift+O` | Sends the active window to the next screen by position (left edge, then top edge, cyclic; the order *Focus next output* uses), where it is tiled. KWin puts it on that screen's current desktop and keeps it active, so no desktop changes; the source screen is re-solved. No-op with one output. Tested with two virtual outputs, with and without per-screen desktops. |
| `plastile.move.output-previous` | Send window to previous output | *unbound* | Sends the active window to the previous screen. |
| `plastile.move.desktop-next` | Send window to next desktop | *unbound* | Sends the active window to the next virtual desktop (cyclic). The current desktop does not change, and the window is tiled when that desktop is shown. With `followOnSend` ([CONFIGURATION](CONFIGURATION.md#settings-patch)) that desktop is shown on the window's screen and the window activated. No-op for a window on several or all desktops. |
| `plastile.move.desktop-previous` | Send window to previous desktop | *unbound* | Sends the active window to the previous virtual desktop. |
| `plastile.resize.grow` | Grow focused tile | `Meta+Ctrl+=` | Master/stack: moves the divider by `ratioStep` so the focused tile grows. Growing a stack window shrinks the master column. BSP: moves the divider of the nearest split that contains the focused tile and has tiles on both sides. Steps start from the divider as shown, clamped to 0.05–0.95 and to window minimum sizes. A no-op when nothing would move, including with a single tile. Does nothing in monocle or floating. |
| `plastile.resize.shrink` | Shrink focused tile | `Meta+Ctrl+-` | Opposite of *Grow*. |
| `plastile.resize.equalize` | Equalize sizes | *unbound* | Master/stack: resets the per-window row weights to equal, keeping the master ratio. BSP: sets every split to 0.5. |
| `plastile.master.increase` | More master windows | `Meta+Shift+I` | Master/stack only: one more window in the master column (maximum 8). |
| `plastile.master.decrease` | Fewer master windows | `Meta+Shift+D` | Master/stack only: one fewer window in the master column. The minimum is 0, which stacks everything. |
| `plastile.layout.next` | Next layout | `Meta+Shift+Space` | Switches the current context to the next layout in the cycle master/stack → BSP → monocle → floating. Two presses from the default reach monocle, three floating; both look like no tiling. The choice is remembered for that screen and desktop across logins ([saved preferences](README.md#saved-layout-preferences)). |
| `plastile.layout.previous` | Previous layout | *unbound* | The previous layout in the same cycle. |
| `plastile.layout.master-stack` | Master/stack layout | *unbound* | Sets master/stack for the current context. No-op if it is already active. |
| `plastile.layout.bsp` | BSP layout | *unbound* | Sets BSP for the current context. |
| `plastile.layout.monocle` | Monocle layout | `Meta+Shift+M` | Sets monocle for the current context. |
| `plastile.layout.floating` | Floating layout (no tiling here) | *unbound* | Stops tiling the current context. Windows that have a remembered floating rectangle are restored to it once, then Plastile leaves them alone. |
| `plastile.layout.scrolling` | Scrolling layout (experimental) | *unbound* | Sets the experimental scrolling layout for the current context. *Next layout* and *Previous layout* never select it; from scrolling, *Next layout* goes to master/stack and *Previous layout* to floating. See [Scrolling layout](#scrolling-layout-experimental). |
| `plastile.layout.zones` | Zones layout (experimental) | *unbound* | Sets the experimental zones layout for the current context. Nothing moves until you assign windows to zones. *Next layout* and *Previous layout* never select it. See [Zones layout](#zones-layout-experimental). |
| `plastile.layout.rotate-clockwise` | Rotate layout clockwise | *unbound* | BSP only: rotates every split. Side-by-side splits become stacked and vice versa, with children reordered clockwise. In other layouts it reports a no-op. |
| `plastile.layout.rotate-counterclockwise` | Rotate layout counterclockwise | *unbound* | BSP only: rotates every split counterclockwise. |
| `plastile.layout.mirror-horizontal` | Mirror layout horizontally | *unbound* | BSP only: flips every side-by-side split (the children exchange places and the ratio is inverted). |
| `plastile.layout.mirror-vertical` | Mirror layout vertically | *unbound* | BSP only: flips every stacked split. |
| `plastile.scroll.consume` | Scrolling: move window into the column on the left | *unbound* | Scrolling layout only: the focused window leaves its column and joins the bottom of the column on its left. An emptied column is removed. No-op in the first column or in other layouts. |
| `plastile.scroll.expel` | Scrolling: move window out into its own column | *unbound* | Scrolling layout only: the focused window leaves a shared column and gets its own column just right of it, with the same width. No-op when it is already alone. |
| `plastile.scroll.width-cycle` | Scrolling: cycle column width | *unbound* | Scrolling layout only: the focused column steps to the next wider width preset (default ⅓, ½, ⅔, full), wrapping to the narrowest. A column is never narrower than the minimum width of a window in it. |
| `plastile.scroll.center` | Scrolling: centre focused column | *unbound* | Scrolling layout only: scrolls so the focused column is centred. With the default `lazy` policy the strip does not scroll past its first or last column, so an end column is centred only as far as that allows. |
| `plastile.zone.assign-1` … `plastile.zone.assign-9` | Zones: assign window to zone 1 … 9 | *unbound* | Zones layout only: places the active window in that zone of the context's zone layout (one write). No-op when it is already there or the zone layout has fewer zones. |
| `plastile.zone.next` | Zones: move window to the next zone | *unbound* | Zones layout only: moves the active window to the next zone, wrapping to zone 1. A window in no zone goes to zone 1. |
| `plastile.zone.previous` | Zones: move window to the previous zone | *unbound* | The same in the other direction; a window in no zone goes to zone 1. |
| `plastile.zone.unassign` | Zones: release window from its zone | *unbound* | Zones layout only: the active window leaves its zone and stays where it is, as an ordinary floating window. |
| `plastile.zone.layout-next` | Zones: next zone layout | *unbound* | Zones layout only: switches the context to the next zone layout (built-ins first, then your own). Windows keep their zone number when the new layout has it; the others are released where they are. |
| `plastile.zone.show` | Zones: show or hide the zone overlay | *unbound* | Zones layout only: shows the zones of the active screen with their numbers; the same command, Escape or a click hides it. Never needed for keyboard placement. |
| `plastile.window.toggle-float` | Toggle floating | `Meta+Shift+F` | **Tiled window:** floats it and restores its last floating rectangle, if one is remembered; peers re-solve once. **Floating or natively quick-tiled window:** remembers its current rectangle, releases any native tile and tiles it. This also works for a resizable dialog, utility or transient window. A window that cannot be tiled (fixed size, or on several desktops) stays floating and the reason is reported. Excluded windows (panels, menus, shell surfaces, rule-excluded windows) are not affected. |
| `plastile.window.adopt-native` | Adopt natively tiled window | *unbound* | A window you quick-tiled with KWin's own actions (`Meta+arrow`, edge drag) is left to KWin. This command releases that native tile and adopts the window back into the layout. No-op for other windows. |
| `plastile.context.reset` | Reset this layout | *unbound* | Drops the on-screen context's layout choice (also the saved one) and its structure (master ratio and count, BSP tree and ratios, row weights), then re-solves from the configured settings. Global settings are untouched. |
| `plastile.runtime.toggle-suspend` | Suspend/resume tiling | `Meta+Ctrl+S` | Where the Wacom tablet settings are installed, the same key is also their *Toggle stylus mode* ([known conflicts](#known-conflicts-on-real-desktops)). **Suspend:** cancels every outstanding request, restores borders Plastile changed and leaves windows where they are. While suspended, every command except this one, *Reconcile*, *Reload configuration* and the three inspect commands is rejected with `tiling suspended`. **Resume:** re-solves every context. |
| `plastile.runtime.reconcile` | Reconcile with live windows | *unbound* | Compares the model with KWin's live window list: drops windows that are gone, adds missing ones and re-solves every context. On an unchanged session it writes nothing (measured). It is a manual recovery command, not a background task. |
| `plastile.runtime.reload-config` | Reload configuration | *unbound* | Asks KWin to re-read `kwinrc` (an asynchronous D-Bus call to KWin's `reconfigure`, as KDE settings pages make on Apply). About 200 ms later KWin reports the re-read settings; if `[Script-plastile]` changed and is valid it is activated, otherwise the errors are logged and the previous configuration is kept. Use it after Apply in the settings dialog. Requests in quick succession become one re-read (measured: 20 requests, one activation, one engine; see [INSTALL](INSTALL.md#applying-settings-changes)). It also re-runs the [conflict report](#conflict-report). |
| `plastile.inspect.explain-window` | Explain active window (log) | *unbound* | Opens the inspector: a window stating in plain words how Plastile treats the active window and why, with internal values under *Show details*. Running the command again, Escape, or a click elsewhere closes it. Also logs the active window's classification, mode, decision source, rule ids, context, layout, constraints, ledger state, planned slot and exception, as a `notice` line shown at the default level (see [CONFIGURATION](CONFIGURATION.md#seeing-why-a-window-was-classified)). |
| `plastile.inspect.counters` | Log counters | *unbound* | Logs the work counters (solves, writes, corrections and others), outstanding requests, connection and window counts, a per-context summary and the configuration revision. Logged at every level. |
| `plastile.inspect.dump-trace` | Log trace | *unbound* | Logs the bounded event trace (the `traceCapacity` most recent events). Empty when `diagnostics` is `off`. |

## Default bindings measured with real key presses

Every default binding is pressed with real key events, injected with libei into a nested KWin 6.7.5 session, by the scenario `shortcuts-defaults-real-input` (`tests/integration/scenarios_shortcuts.py`). The session uses the default keymap (no `kxkbrc`, so US by inference) and only the shortcuts that KWin and the nested session register. All 20 defaults reached Plastile (measured, Ubuntu 26.10 sandbox, KWin 6.7.5). The same run read the session's `kglobalshortcutsrc` (206 entries) and found no other action registered with a Plastile default.

**In a physical session** (the reference desktop, KWin 6.7.5, build `97fec4a`, physical runbook P7, [evidence](../status/evidence/physical-runbook-20261018.json)): 19 of 19 injected default chords reached Plastile through a virtual keyboard on the owner's keymap. *Suspend/resume tiling* is not injected (it would pause the run); pressed by hand, `Meta+Ctrl+S` paused and resumed tiling, although the Wacom tablet settings hold the same key there ([known conflicts](#known-conflicts-on-real-desktops)). The chord-to-keycode step of the injector assumes a US layout.

**Changed defaults.** Earlier versions shipped three defaults that did not work on a stock setup. They were replaced:

| Command | Old default | What happened (measured) | New default |
|---|---|---|---|
| Suspend/resume tiling | `Meta+Shift+S` | Did not reach Plastile in a nested session on the reference Arch machine: Spectacle 6.7.5 registers the same key (`X-KDE-Shortcuts=Print,Meta+Shift+S` in `org.kde.spectacle.desktop`), and KGlobalAccel accepted both registrations without reporting a conflict. | `Meta+Ctrl+S` |
| Grow focused tile | `Meta+Shift+=` | Never reached Plastile (nested sessions in both environments). On a US layout, Shift+`=` produces `+`, so the registered sequence is not what the keyboard sends; KWin's Zoom effect binds `Meta++` and `Meta+=` (observed source: `src/plugins/zoom/zoom.cpp`). | `Meta+Ctrl+=` |
| Shrink focused tile | `Meta+Shift+-` | Never reached Plastile (nested sessions in both environments). Shift+`-` produces `_`. | `Meta+Ctrl+-` |

**If you upgraded from a version with the old defaults, you still have them.** KGlobalAccel keeps the key stored for a command, whether you chose it or the older version registered it, and Plastile registers its keys without marking them as defaults (KWin's `ShortcutHandler` calls `KGlobalAccel::setShortcut` only; observed source: kwin `src/scripting/shortcuthandler.cpp`). Measured in nested KWin 6.7.5 (`package-upgrade-bindings-T26-T32`): after an upgrade from a package built before the change and a KWin restart, the three commands were still bound to `Meta+Shift+S`, `Meta+Shift+=` and `Meta+Shift+-`. Where Spectacle is installed, the [conflict report](#conflict-report) then names `Meta+Shift+S` (observed on the reference host). Rebind the three commands to the new defaults, or to keys of your choice, in the shortcut settings. Plastile does not change them for you ([it never changes a binding](#conflict-report)). For the same reason, *Reset to default* in the shortcut settings may clear a Plastile command instead of restoring the key in this table (inference: KGlobalAccel reports no default key for Plastile's commands, measured).

A unit test (`tests/core/package.test.ts`) rejects defaults that combine Shift with punctuation, and the sequences known to be taken by stock software.

Not measured: Spectacle is not installed in the Ubuntu sandbox, so its absence of conflicts with the new defaults comes from its published shortcut list, not from a run. On the physical reference desktop, where Spectacle is installed, the conflict report named no Spectacle key for the new defaults; `Meta+Shift+S` itself was not pressed there. Other keyboard layouts may produce different symbols for `=` and `-` with Ctrl held (untested).

Pressed and confirmed to reach Plastile:

- `Meta+Shift+` H, J, K, L, N, P, I, D, O, M, F, Space and Return
- `Meta+Ctrl+` H, J, K, L, S, `=` and `-`

## Rebinding

1. Open **System Settings > Keyboard > Shortcuts**.
2. Choose the **KWin** component and search for "Plastile". Each row of the table appears under its label.
3. Assign, change or clear bindings there.

KGlobalAccel stores your choice in `~/.config/kglobalshortcutsrc`, and your bindings survive script reloads and upgrades. Measured in nested KWin 6.7.5 (scenario `package-upgrade-bindings-T26-T32`, the bindings set over D-Bus with `setForeignShortcutKeys`, the call the shortcut settings page makes by inference, not clicked through): *Focus next* rebound to `Meta+Alt+N`, *Focus previous* to `Meta+Alt+P`, *Log counters* (unbound by default) bound to `Meta+Alt+C` and *Swap with master* cleared all stayed so after a package upgrade, a script restart and a KWin restart. Each rebound key, pressed with real key events, ran its command exactly once; `Meta+Shift+N` and `Meta+Shift+Return` ran nothing. A user binding of another action on a Plastile default key is kept as well ([conflict report](#conflict-report)). An upgrade also keeps keys you never touched, including [replaced old defaults](#default-bindings-measured-with-real-key-presses).

Unbound commands (*unbound* in the table) appear in the same list and only need a binding.

**Shift with a digit or punctuation:** register the character the keys type. Measured in nested KWin 6.8.1 with real key presses (libei, US layout): a binding stored as `Meta+Shift+1` never fired when `Meta+Shift+1` was pressed, and neither did `Meta+Shift+!`; a binding stored as `Meta+!` did. Not checked: which form System Settings stores when you press the keys there; if a Shift+digit binding set there does nothing, set it again as the character. Letters are not affected: `Meta+Shift+H` works as written. For example, i3-style "move window to desktop N" on a US layout is KWin's *Window to Desktop N* bound to `Meta+!`, `Meta+@`, `Meta+#` and so on.

You can also trigger any command without a key. The test harness does this throughout (measured in nested KWin 6.7.5):

```sh
qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut plastile.layout.bsp
```

## Default binding policy and conflicts

The defaults use `Meta+Shift+<letter>`, `Meta+Shift+Space` and `Meta+Shift+Return`, plus `Meta+Ctrl+<letter>` (the four swaps and suspend) and `Meta+Ctrl+=` / `Meta+Ctrl+-` (grow and shrink). According to the comment block in `commands.ts` (observed source), they were chosen to avoid the bindings found on the reference Plasma 6.7 machine:

- KWin's `Meta+arrows` quick tiling
- `Meta+PgUp/PgDn`
- `Meta+T` (native tile editor)
- `Meta+W` (overview)
- `Meta+L` (lock)
- `Meta+Ctrl+arrows` (desktop switching)
- `Meta+Alt+arrows` (window focus)
- `Meta+1..9` (task manager)
- `Meta+Shift+S` (Spectacle) and `Meta+=` / `Meta+-` (KWin Zoom)

The full list of that machine's bindings was not committed. The nested scenario above checks the registry of the nested session on every run; unit tests check that no two Plastile commands share a default and that no default combines Shift with punctuation. On your machine, the [conflict report](#conflict-report) checks the bindings that are actually registered.

**Your own bindings.** If you have already bound one of these sequences to something else, expect Plastile's key press not to work, as happened with Spectacle above. Pick another key for the Plastile command. The conflict report below tells you which ones.

### Conflict report

When Plastile starts, it asks KGlobalAccel (over D-Bus, on a later event-loop turn than the start, one request at a time) for every registered shortcut of every component, and compares the keys with Plastile's commands. A Plastile command's keys are its current binding, so a key you moved is checked where you put it. Each key that a Plastile command shares with another action is reported:

- in the log, as one warning: `plastile warn shortcut conflicts: Meta+Shift+H: "Plastile: Focus left" and "Maximize Window" (KWin) (change one in System Settings, Keyboard, Shortcuts)`;
- in *Explain active window*: the inspector's *Shortcut conflicts* row and the log line's `shortcutConflicts` field;
- in *Log counters*: `shortcuts: {"state": "done", "conflicts": N}`.

Without conflicts the log says `plastile info shortcut check: no conflicts`. *Reload configuration* runs the check again, for example after you rebound something.

**Plastile never changes a binding.** It only reads them. Measured in nested KWin 6.7.5 and 6.8.0 (scenario `shortcuts-conflict-Q08`): with KWin's *Maximize Window* bound to `Meta+Shift+H` by the user before Plastile loaded, KGlobalAccel still gave *Focus left* the same key (it accepts duplicates without complaint), the report named both, the user's binding stayed in `kglobalshortcutsrc`, and pressing `Meta+Shift+H` maximized the window without reaching Plastile.

Limits:

- The check sees the components KGlobalAccel knows at that moment. In the nested session that was KWin, Konsole, Dolphin and the keyboard layout switcher, although only KWin was running (measured), so installed applications that declare global shortcuts are included. An application KGlobalAccel has never heard of is not.
- Keys are compared as single key combinations; multi-key sequences are not checked.
- A KWin script can only call D-Bus methods without arguments of KDE's own types: KWin's `DBusCall` passes arguments as plain values, so methods taking a key sequence (`globalShortcutsByKey`, `isGlobalShortcutAvailable`) cannot be called. The check therefore lists every shortcut (`allComponents` and each component's `allShortcutInfos`) and compares locally; the work is bounded (at most 64 components and 2048 entries each) and happens once per load or reload.
- If KGlobalAccel cannot be reached, the log says `shortcut check unavailable: ...` and nothing else changes.

### Known conflicts on real desktops

| Key | Plastile command | Also bound by | Seen where | What happened |
|---|---|---|---|---|
| `Meta+Ctrl+S` | *Suspend/resume tiling* | *Toggle stylus mode* of the Wacom tablet settings | Physical reference desktop, KWin 6.7.5 (runbook P1 and P7, [evidence](../status/evidence/physical-runbook-20261018.json)) | Plastile's conflict report and the runbook's session check both named it. Plastile still received the key there: pressing it logged `tiling paused`, pressing it again `tiling resumed`. Whether the stylus mode toggled too was not checked. Which of two actions on one key receives it is not guaranteed in general: in the nested `shortcuts-conflict-Q08` the other action got the key and Plastile did not |

To clear a conflict, give one of the two actions another key:

1. Open **System Settings > Keyboard > Shortcuts**.
2. Search for "Plastile: Suspend" (component **KWin**), select *Plastile: Suspend/resume tiling*, and set a key that nothing else uses, or clear it and run the command from a terminal when you need it:
   `qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut plastile.runtime.toggle-suspend`
3. Or rebind the tablet's *Toggle stylus mode* instead, if you use it more: search for "stylus" on the same page. (It is a KGlobalAccel registration like Plastile's, which is how the conflict report found it, so the page lists it; this was not clicked through.)
4. Run *Reload configuration* (or disable and re-enable Plastile) so the conflict report checks the new key. It does not re-run on its own when you rebind.

Plastile does not override `Meta+T` and does not take over KWin's own quick-tile keys. A window you quick-tile with `Meta+Left` is released to KWin (see [README](README.md#floating-windows-and-native-quick-tiling)).

## Things to know

- **Leftover entries:** shortcut registrations are KWin-wide and **persist in `kglobalshortcutsrc` after the script is disabled or uninstalled** (measured in nested KWin). They are harmless entries without a handler, and they keep your bindings for a reinstall. To drop them, see [INSTALL](INSTALL.md#6-uninstall-cleanly) step 4 (editing the file while you are logged in does not work).
- **Screens:** directional focus, swap and move never cross screens. Use *Send window to next output* to change screens.
- **Unbound diagnostics:** *Reload configuration*, *Explain active window*, *Log counters* and *Log trace* are unbound by default. Bind them if you change settings or need to debug ([TROUBLESHOOTING](TROUBLESHOOTING.md)).

## Scrolling layout (experimental)

In a context using the experimental scrolling layout ([README](README.md#scrolling-experimental)), the ordinary commands act on the strip of columns:

| Command | In a scrolling context |
|---|---|
| *Focus left/right* | Focuses the nearest window in the previous or next column, even when that column is off screen, and scrolls it into view. No wrap-around. |
| *Focus up/down* | Moves within the focused column only; never scrolls. |
| *Focus next/previous* | Steps through the strip's order (columns left to right, windows top to bottom), scrolling as needed. |
| *Swap left/right*, *Move tile left/right* | Moves the focused column one place left or right. |
| *Swap up/down*, *Move tile up/down* | Moves the focused window up or down within its column. |
| *Swap next/previous/master* | Exchanges the focused window with the next or previous window in strip order, or with the first one. |
| *Grow/Shrink focused tile* | Widens or narrows the focused column by `ratioStep` (as a fraction of the usable width, between 0.1 and 1). |
| *Equalize sizes* | Resets the row heights inside every column; column widths stay. |
| *Rotate*, *Mirror*, *More/Fewer master windows* | No-op. |

Focus changes in a scrolling context move windows: scrolling is a position-only change (no window is resized). Focusing a column that is already fully visible scrolls nothing with the default `lazy` policy.

## Zones layout (experimental)

In a context using the experimental zones layout ([README](README.md#zones-experimental)), only windows you assigned to a zone (or a rule's `zone` assigned) are placed. Every other window there is an ordinary floating window.

| Command | In a zones context |
|---|---|
| *Toggle floating* on a window in a zone | Releases it from its zone and puts it back where it floated before it was assigned. Toggling again makes it an ordinary window of the context again, in no zone. |
| Moving or resizing a window in a zone with the mouse | Releases it from its zone where you put it; it does not snap back. |
| *Focus left/right/up/down* | Moves between windows in zones, by their zone rectangles. |
| *Swap left/right/up/down* | Exchanges the zones of the active window and its neighbour. |
| *Grow/Shrink*, *Equalize*, *Rotate*, *Mirror*, *More/Fewer master windows* | No-op: zones have fixed sizes. |
| *Next layout*, another layout, *Reset this layout*, *Suspend* | Releases every window from its zone; no window moves because of it (a tiling layout you switch to then places the windows as usual). |
