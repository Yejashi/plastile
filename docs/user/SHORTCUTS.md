# Plastile shortcuts

Every Plastile command is one KWin global shortcut. All of them are registered under the **KWin** component, and their labels start with `Plastile:`. The table below is derived from [`src/core/commands.ts`](../../src/core/commands.ts): 46 commands, 20 of them bound by default.

**Context.** Commands act on the **active window** and its context: the screen, virtual desktop and activity it is on. When there is no active window, commands use the active screen's visible desktop.

**Results.** "Accepted" means Plastile issued the geometry requests. It does not mean every client has committed its new size, or that a frame was presented. A command with nothing to do (already in that layout, nothing in that direction) is a no-op and writes nothing.

## Table

| Command id | Label in System Settings (after `Plastile:`) | Default | Behaviour |
|---|---|---|---|
| `plastile.focus.left` | Focus left | `Meta+Shift+H` | Activates the tiled neighbour to the left of the focused tile, on the same screen and desktop. Candidates lying fully beyond the facing edge win over others. Among them, one that overlaps vertically wins, then the nearest facing edge, then the larger overlap, then stable order. When nothing lies fully beyond the edge (irregular or overlapping frames, such as a size-limited window centred in its tile), a tile that reaches past the edge with its centre on that side is used; a tile beside the focused one never is. No wrap-around, no screen change, no geometry change. If the active window is not tiled here, the most recently focused tile of the context is activated instead. |
| `plastile.focus.down` | Focus down | `Meta+Shift+J` | Same as *Focus left*, downwards. |
| `plastile.focus.up` | Focus up | `Meta+Shift+K` | Same as *Focus left*, upwards. |
| `plastile.focus.right` | Focus right | `Meta+Shift+L` | Same as *Focus left*, to the right. |
| `plastile.focus.next` | Focus next | `Meta+Shift+N` | Activates the next tiled window in the context's stable order (wraps around). In monocle, it also raises that window. |
| `plastile.focus.previous` | Focus previous | `Meta+Shift+P` | Activates the previous tiled window in stable order (wraps around). |
| `plastile.focus.master` | Focus master | *unbound* | Activates the first window in the order (the master in master/stack). |
| `plastile.swap.left` | Swap with window to the left | `Meta+Ctrl+H` | Exchanges the focused tile with its left neighbour: their order positions in master/stack and monocle, their leaves in BSP. One re-solve. No-op when nothing lies in that direction or the active window is not tiled here. |
| `plastile.swap.down` | Swap with window below | `Meta+Ctrl+J` | Same as *Swap with window to the left*, downwards. |
| `plastile.swap.up` | Swap with window above | `Meta+Ctrl+K` | Same as *Swap with window to the left*, upwards. |
| `plastile.swap.right` | Swap with window to the right | `Meta+Ctrl+L` | Same as *Swap with window to the left*, to the right. |
| `plastile.swap.next` | Swap with next window | *unbound* | Exchanges positions with the next window in stable order (wraps). |
| `plastile.swap.previous` | Swap with previous window | *unbound* | Exchanges positions with the previous window in stable order (wraps). |
| `plastile.swap.master` | Swap with master | `Meta+Shift+Return` | Exchanges positions with the first window in the order. From the master slot, it swaps with the second window. |
| `plastile.move.left` | Move tile left (reinsert) | *unbound* | Structural reinsert. In BSP, it splits the left neighbour's tile and places the focused window on its left side. In master/stack and monocle, it moves the window to just before that neighbour in the order. Unlike *Swap*, the neighbour keeps its slot shape. |
| `plastile.move.down` | Move tile down (reinsert) | *unbound* | Same as *Move tile left*, downwards (BSP: below the neighbour; order layouts: just after it). |
| `plastile.move.up` | Move tile up (reinsert) | *unbound* | Same as *Move tile left*, upwards (BSP: above; order layouts: just before). |
| `plastile.move.right` | Move tile right (reinsert) | *unbound* | Same as *Move tile left*, to the right (BSP: right side; order layouts: just after). |
| `plastile.move.output-next` | Send window to next output | `Meta+Shift+O` | Sends the active window to the next screen in KWin's output order (cyclic), where it is tiled. The view does not follow, and the source screen is re-solved. No-op with one output. Tested with two virtual outputs. |
| `plastile.move.output-previous` | Send window to previous output | *unbound* | Sends the active window to the previous screen. |
| `plastile.move.desktop-next` | Send window to next desktop | *unbound* | Sends the active window to the next virtual desktop (cyclic). The current desktop does not change, and the window is tiled when that desktop is shown. No-op for a window on several or all desktops. |
| `plastile.move.desktop-previous` | Send window to previous desktop | *unbound* | Sends the active window to the previous virtual desktop. |
| `plastile.resize.grow` | Grow focused tile | `Meta+Ctrl+=` | Master/stack: moves the divider by `ratioStep` so the focused tile grows. Growing a stack window shrinks the master column. BSP: moves the divider of the nearest split that contains the focused tile and has tiles on both sides. Steps start from the divider as shown, clamped to 0.05–0.95 and to window minimum sizes. A no-op when nothing would move, including with a single tile. Does nothing in monocle or floating. |
| `plastile.resize.shrink` | Shrink focused tile | `Meta+Ctrl+-` | Opposite of *Grow*. |
| `plastile.resize.equalize` | Equalize sizes | *unbound* | Master/stack: resets the per-window row weights to equal, keeping the master ratio. BSP: sets every split to 0.5. |
| `plastile.master.increase` | More master windows | `Meta+Shift+I` | Master/stack only: one more window in the master column (maximum 8). |
| `plastile.master.decrease` | Fewer master windows | `Meta+Shift+D` | Master/stack only: one fewer window in the master column. The minimum is 0, which stacks everything. |
| `plastile.layout.next` | Next layout | `Meta+Shift+Space` | Switches the current context to the next layout in the cycle master/stack → BSP → monocle → floating. The choice lasts for this KWin session only (see [limitations](TROUBLESHOOTING.md#known-limitations)). |
| `plastile.layout.previous` | Previous layout | *unbound* | The previous layout in the same cycle. |
| `plastile.layout.master-stack` | Master/stack layout | *unbound* | Sets master/stack for the current context. No-op if it is already active. |
| `plastile.layout.bsp` | BSP layout | *unbound* | Sets BSP for the current context. |
| `plastile.layout.monocle` | Monocle layout | `Meta+Shift+M` | Sets monocle for the current context. |
| `plastile.layout.floating` | Floating layout (no tiling here) | *unbound* | Stops tiling the current context. Windows that have a remembered floating rectangle are restored to it once, then Plastile leaves them alone. |
| `plastile.layout.rotate-clockwise` | Rotate layout clockwise | *unbound* | BSP only: rotates every split. Side-by-side splits become stacked and vice versa, with children reordered clockwise. In other layouts it reports a no-op. |
| `plastile.layout.rotate-counterclockwise` | Rotate layout counterclockwise | *unbound* | BSP only: rotates every split counterclockwise. |
| `plastile.layout.mirror-horizontal` | Mirror layout horizontally | *unbound* | BSP only: flips every side-by-side split (the children exchange places and the ratio is inverted). |
| `plastile.layout.mirror-vertical` | Mirror layout vertically | *unbound* | BSP only: flips every stacked split. |
| `plastile.window.toggle-float` | Toggle floating | `Meta+Shift+F` | **Tiled window:** floats it and restores its last floating rectangle, if one is remembered; peers re-solve once. **Floating or natively quick-tiled window:** remembers its current rectangle, releases any native tile and tiles it. This also works for a resizable dialog, utility or transient window. A window that cannot be tiled (fixed size, or on several desktops) stays floating and the reason is reported. Excluded windows (panels, menus, shell surfaces, rule-excluded windows) are not affected. |
| `plastile.window.adopt-native` | Adopt natively tiled window | *unbound* | A window you quick-tiled with KWin's own actions (`Meta+arrow`, edge drag) is left to KWin. This command releases that native tile and adopts the window back into the layout. No-op for other windows. |
| `plastile.context.reset` | Reset this layout | *unbound* | Drops the current context's session layout choice and its structure (master ratio and count, BSP tree and ratios, row weights), then re-solves from the configured settings. Global settings are untouched. |
| `plastile.runtime.toggle-suspend` | Suspend/resume tiling | `Meta+Ctrl+S` | **Suspend:** cancels every outstanding request, restores borders Plastile changed and leaves windows where they are. While suspended, every command except this one, *Reconcile*, *Reload configuration* and the three inspect commands is rejected with `tiling suspended`. **Resume:** re-solves every context. |
| `plastile.runtime.reconcile` | Reconcile with live windows | *unbound* | Compares the model with KWin's live window list: drops windows that are gone, adds missing ones and re-solves every context. On an unchanged session it writes nothing (measured). It is a manual recovery command, not a background task. |
| `plastile.runtime.reload-config` | Reload configuration | *unbound* | Asks KWin to re-read `kwinrc` (an asynchronous D-Bus call to KWin's `reconfigure`, as KDE settings pages make on Apply). About 200 ms later KWin reports the re-read settings; if `[Script-plastile]` changed and is valid it is activated, otherwise the errors are logged and the previous configuration is kept. Use it after Apply in the settings dialog. Requests in quick succession become one re-read (measured: 20 requests, one activation, one engine; see [INSTALL](INSTALL.md#applying-settings-changes)). It also re-runs the [conflict report](#conflict-report). |
| `plastile.inspect.explain-window` | Explain active window (log) | *unbound* | Opens the inspector: a window stating in plain words how Plastile treats the active window and why, with internal values under *Show details*. Running the command again, Escape, or a click elsewhere closes it. Also logs the active window's classification, mode, decision source, rule ids, context, layout, constraints, ledger state, planned slot and exception, at `info` level (see [CONFIGURATION](CONFIGURATION.md#seeing-why-a-window-was-classified)). |
| `plastile.inspect.counters` | Log counters | *unbound* | Logs the work counters (solves, writes, corrections and others), outstanding requests, connection and window counts, a per-context summary and the configuration revision. Logged at every level. |
| `plastile.inspect.dump-trace` | Log trace | *unbound* | Logs the bounded event trace (the `traceCapacity` most recent events). Empty when `diagnostics` is `off`. |

## Default bindings measured with real key presses

Every default binding is pressed with real key events, injected with libei into a nested KWin 6.7.5 session, by the scenario `shortcuts-defaults-real-input` (`tests/integration/scenarios_shortcuts.py`). The session uses the default keymap (no `kxkbrc`, so US by inference) and only the shortcuts that KWin and the nested session register. All 20 defaults reached Plastile (measured, Ubuntu 26.10 sandbox, KWin 6.7.5). The same run read the session's `kglobalshortcutsrc` (206 entries) and found no other action registered with a Plastile default.

**Changed defaults.** Earlier versions shipped three defaults that did not work on a stock setup. They were replaced:

| Command | Old default | What happened (measured) | New default |
|---|---|---|---|
| Suspend/resume tiling | `Meta+Shift+S` | Did not reach Plastile in a nested session on the reference Arch machine: Spectacle 6.7.5 registers the same key (`X-KDE-Shortcuts=Print,Meta+Shift+S` in `org.kde.spectacle.desktop`), and KGlobalAccel accepted both registrations without reporting a conflict. | `Meta+Ctrl+S` |
| Grow focused tile | `Meta+Shift+=` | Never reached Plastile (nested sessions in both environments). On a US layout, Shift+`=` produces `+`, so the registered sequence is not what the keyboard sends; KWin's Zoom effect binds `Meta++` and `Meta+=` (observed source: `src/plugins/zoom/zoom.cpp`). | `Meta+Ctrl+=` |
| Shrink focused tile | `Meta+Shift+-` | Never reached Plastile (nested sessions in both environments). Shift+`-` produces `_`. | `Meta+Ctrl+-` |

If you had bound the old sequences yourself, KGlobalAccel keeps your binding. A unit test (`tests/core/package.test.ts`) rejects defaults that combine Shift with punctuation, and the sequences known to be taken by stock software.

Not measured: Spectacle is not installed in the Ubuntu sandbox, so its absence of conflicts with the new defaults comes from its published shortcut list, not from a run. Other keyboard layouts may produce different symbols for `=` and `-` with Ctrl held (untested).

Pressed and confirmed to reach Plastile:

- `Meta+Shift+` H, J, K, L, N, P, I, D, O, M, F, Space and Return
- `Meta+Ctrl+` H, J, K, L, S, `=` and `-`

## Rebinding

1. Open **System Settings > Keyboard > Shortcuts**.
2. Choose the **KWin** component and search for "Plastile". Each row of the table appears under its label.
3. Assign, change or clear bindings there.

KGlobalAccel stores your choice in `~/.config/kglobalshortcutsrc`. A stored user binding normally survives script reloads and upgrades; that is KGlobalAccel's behaviour. Plastile's suite measured that a user binding of another action on a Plastile default key is kept ([conflict report](#conflict-report)); a rebound Plastile command surviving an upgrade was not tested.

Unbound commands (*unbound* in the table) appear in the same list and only need a binding.

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

**Plastile never changes a binding.** It only reads them. Measured in nested KWin 6.7.5 (scenario `shortcuts-conflict-Q08`): with KWin's *Maximize Window* bound to `Meta+Shift+H` by the user before Plastile loaded, KGlobalAccel still gave *Focus left* the same key (it accepts duplicates without complaint), the report named both, the user's binding stayed in `kglobalshortcutsrc`, and pressing `Meta+Shift+H` maximized the window without reaching Plastile.

Limits:

- The check sees the components KGlobalAccel knows at that moment. In the nested session that was KWin, Konsole, Dolphin and the keyboard layout switcher, although only KWin was running (measured), so installed applications that declare global shortcuts are included. An application KGlobalAccel has never heard of is not.
- Keys are compared as single key combinations; multi-key sequences are not checked.
- A KWin script can only call D-Bus methods without arguments of KDE's own types: KWin's `DBusCall` passes arguments as plain values, so methods taking a key sequence (`globalShortcutsByKey`, `isGlobalShortcutAvailable`) cannot be called. The check therefore lists every shortcut (`allComponents` and each component's `allShortcutInfos`) and compares locally; the work is bounded (at most 64 components and 2048 entries each) and happens once per load or reload.
- If KGlobalAccel cannot be reached, the log says `shortcut check unavailable: ...` and nothing else changes.

Plastile does not override `Meta+T` and does not take over KWin's own quick-tile keys. A window you quick-tile with `Meta+Left` is released to KWin (see [README](README.md#floating-windows-and-native-quick-tiling)).

## Things to know

- **Leftover entries:** shortcut registrations are KWin-wide and **persist in `kglobalshortcutsrc` after the script is disabled or uninstalled** (measured in nested KWin). They are harmless entries without a handler; remove them in the shortcuts settings if you want a clean file.
- **Screens:** directional focus, swap and move never cross screens. Use *Send window to next output* to change screens.
- **Unbound diagnostics:** *Reload configuration*, *Explain active window*, *Log counters* and *Log trace* are unbound by default. Bind them if you change settings or need to debug ([TROUBLESHOOTING](TROUBLESHOOTING.md)).
