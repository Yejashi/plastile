# Troubleshooting Plastile

Plastile's diagnostics are shortcuts that write to KWin's log, one inspector window (*Explain active window*), and the ordinary KWin Scripts page. Unless noted otherwise, the behaviour below was exercised in nested KWin 6.7.5 sessions, not in a live desktop.

## Reading the log

Plastile prints single lines prefixed with `plastile <level>`, where the level is `error`, `warn`, `info` or `debug`. The `diagnostics` setting (default `warn`) filters them, except the counters and trace dumps, which are printed at every level.

```sh
journalctl --user -f | grep plastile
```

**Where the lines go.** Plastile writes through QML `console.info` inside KWin. Without `QT_FORCE_STDERR_LOGGING`, Qt sends that output to the user journal (observed during environment discovery, [ENVIRONMENT](../status/ENVIRONMENT.md)). The nested tests read the compositor's captured stderr instead; reading the journal in a physical Plasma session is untested.

If nothing appears although the script is enabled:

- Check that `QT_LOGGING_RULES` in KWin's environment does not disable the `js` or `qml` categories.
- Check that `diagnostics` is not `off`.
- Search the whole boot: `journalctl --user -b | grep -i plastile`.

**What each level adds.**

- **`warn` (the default):** configuration warnings, `shortcut conflicts: ...` ([details](SHORTCUTS.md#conflict-report)), and errors such as `configuration rejected; keeping previous revision [...]`.
- **`info`:** also `started 0.1.0 {...}`, `stopped`, `configuration reload requested`, `configuration activated {"revision": N}`, `shortcut check: no conflicts {...}` and the `explain` lines.
- **`debug`:** also one line per command, with its result (`accepted`, `rejected` or `noop`), reason, targets, model revision and whether a placement request was issued.

## Inspect commands

All three are unbound by default. Bind them in System Settings > Keyboard > Shortcuts > KWin ([SHORTCUTS](SHORTCUTS.md#rebinding)), or trigger them from a terminal in the same session:

```sh
qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut plastile.inspect.counters
qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut plastile.inspect.explain-window
qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut plastile.inspect.dump-trace
```

### Log counters

**Log counters** prints `plastile counters {...}` at every log level. The counters accumulate from script load.

| Field | Meaning |
|---|---|
| `counters.solves` | Layout computations. One per lifecycle pass or command on a visible context; none while idle. |
| `counters.writes` | Frame geometry requests issued to KWin. |
| `counters.liveSolves` | Solves made while a tile was being resized with the mouse and `liveResize` is on (also counted in `solves`): at most one per update of the resized window. Always 0 with `liveResize` off. |
| `counters.corrections` | Re-requests after a client settled somewhere other than requested. At most 2 per window per target. |
| `counters.skipNoop`, `skipOutstanding`, `skipDiverged` | Writes avoided because the window was already at the target, a request was still in flight, or Plastile had given up on that window. |
| `counters.activations`, `raises` | Focus and raise calls. Focus commands produce these, never `writes`. |
| `counters.commands`, `commandsQueued` | Commands run, and commands deferred because they arrived while geometry was being applied. |
| `counters.flushes`, `deadlines` | Coalesced passes, and bounded-wait deadlines that fired because a client did not answer in time (750 ms). Both stay flat while idle. |
| `counters.observations`, `observationsDuringApply` | Geometry change reports from KWin, and the subset that arrived while Plastile was applying geometry. |
| `counters.settled`, `partial`, `external`, `diverged` | How each report was classified: the request settled, settled only in part, was changed by someone else (you or the application), or was given up on after bounded corrections. |
| `counters.stale`, `superseded` | Reports of a size Plastile had requested earlier, arriving after a newer request. `superseded`: the newer request is still on its way to the application (an intermediate size during a burst of changes), so nothing is re-sent. `stale`: KWin did not pass the newer request on because it equalled the size the window had at that moment, so it is re-sent once (counted in `corrections`). |
| `counters.learned` | Times a client's accepted size taught Plastile a tighter minimum or maximum than the client advertised. A client that has not answered at all teaches nothing. |
| `counters.accepted` | Times a client settled at most 32 px short of its slot (for example a terminal sizing itself in whole character cells) and Plastile accepted that size instead of learning a maximum. |
| `counters.overflow` | Windows floated because the layout could not fit them. |
| `counters.reclassified` | Window classifications: when a window appears, when its identity, transience, membership or size constraints change, and on a configuration activation that changed rules (a gap or ratio change adds none). |
| `counters.adopted`, `removed`, `staleEvents` | Windows adopted and dropped, and events ignored because they referred to a window generation that no longer exists. |
| `counters.errors` | Caught exceptions in commands, flushes or restores. Should stay 0. |
| `outstanding` | Windows with a geometry request not yet settled. Should return to 0 shortly after any action. |
| `connections` | Signal connections Plastile owns. Stable across reloads (measured over 20 reloads). |
| `windows` | Windows the adapter tracks. |
| `contexts` | One entry per screen, desktop and activity: layout, member count, model revision and applied revision. |
| `configRevision` | Increases with every configuration attempt that differs from the previous input. |
| `shortcuts` | The startup shortcut check: `state` (`pending`, `done` or `unavailable`) and the number of `conflicts` ([details](SHORTCUTS.md#conflict-report)). |
| `inspectorOpen` | Whether the *Explain active window* inspector is open. |
| `counters.restored`, `restoreAmbiguous` | Saved float positions given to the one open window of their application, and ones withheld because several windows of the application were open. |
| `persistence` | Saved state: `state` (`loading` until the helper answered; `active`; `memory` when the persistence helper is not installed or did not answer; `read-only` when a newer Plastile's file is present; `off`), the `generation` last loaded or saved, this load's confirmed `writes`, `issued` and `failed` saves, `skipped` (unchanged) saves, and whether a save is pending (`dirty`, `armed`, `inflight`: a request the helper has not answered yet). |

A healthy idle session shows no change between two dumps taken a few seconds apart. Measured: 3 s of idle produced no flushes, deadlines or writes.

### Explain active window

**Explain active window** opens the inspector for the focused window: how Plastile treats it and why, in plain words, with internal values under *Show details*. Escape, a click elsewhere, activating another window, or the command again closes it. It also prints the classification and placement record to the log, which requires `diagnostics` at `info` or `debug`. Both are described in [CONFIGURATION](CONFIGURATION.md#seeing-why-a-window-was-classified).

### Log trace

**Log trace** prints `plastile trace [...]` at every level. That is the last `traceCapacity` events (commands, lifecycle events, settles, deadlines, reconciles), each with a millisecond timestamp. When `diagnostics` is `off`, nothing is recorded.

## Suspend and resume

*Suspend/resume tiling* toggles between two states. Its default is `Meta+Ctrl+S` (earlier versions used `Meta+Shift+S`, which Spectacle also claims; [details](SHORTCUTS.md#default-bindings-measured-with-real-key-presses)).

- **Suspended:** Plastile cancels outstanding requests, restores any borders it removed, stops issuing geometry and rejects commands with `tiling suspended`. The exceptions are this toggle, *Reconcile*, *Reload configuration* and the inspect commands. Windows stay exactly where they are, so move and resize them freely. Measured: a window moved by hand while suspended was not moved back.
- **Resumed:** every context is re-solved once, and your float choices are kept. Measured: the layout was valid again after resume.

Use it when an application insists on its own geometry for a while (a game launcher, a presentation), or before experimenting with KWin's own tile editor.

## Reconcile

**Plastile: Reconcile with live windows** (unbound) re-reads KWin's window list. It drops windows that are gone, adds any the adapter missed and re-solves every context. On an unchanged session it writes nothing (measured). It is a recovery command, not a background task: Plastile never polls.

Try it if a window seems stuck outside the layout after an unusual sequence. If you need it regularly, that is a bug worth reporting, with a trace dump.

## Configuration does not change

1. **Make KWin re-read the file.** Apply in the settings dialog does not notify the script (observed source and measured, [details](INSTALL.md#applying-settings-changes)). Press *Reload configuration*, which asks KWin to re-read `kwinrc`, or run `qdbus6 org.kde.KWin /KWin reconfigure`. At `info`, `configuration reload requested` confirms the request was made; `KWin reconfigure request failed` (a warning) means KWin could not be asked, and only its cached copy was re-read.
2. **Look for a rejection.** Search the log for `plastile error configuration rejected; keeping previous revision [...]`. The list gives each problem with its path. Fix all of them: one error rejects the whole revision.
3. **Check for typos.** A mistyped flat key in `[Script-plastile]` is ignored without any message: KWin lets a script read keys only by name, so Plastile cannot see keys it does not know. Compare the names with the table in [CONFIGURATION](CONFIGURATION.md#flat-keys). Unknown keys inside the JSON are errors, logged with their path.
4. **Confirm activation.** At `info`, `configuration activated {"revision": N}` confirms a change was taken. An unchanged configuration deliberately produces no new revision and no log line.

## A window is not tiled

Run *Explain active window* and read `mode`, `userMode`, `nativeTile`, `decision.source` and `decision.reason`:

- **`decision.source` `type` with `mode: excluded`:** panels, menus, popups and other non-application surfaces. Nothing can tile these.
- **`decision.source` `type` with `mode: floating`:** a dialog, utility, transient or modal window, or another non-normal type. A rule with `mode: tiled`, or *Toggle floating*, can tile it if it is resizable.
- **`decision.source` `builtin`:** a shell surface (never tiled) or a helper application such as a portal or polkit dialog (a rule can tile it).
- **`decision.source` `constraint`, reason `fixed size`:** the client reports equal minimum and maximum sizes, or is not resizable. Rules cannot change this.
- **`decision.source` `membership`:** the window is on all or several desktops or activities. Put it on one desktop to tile it.
- **`decision.source` `rule`:** one of your rules matched; `ruleIds` lists every matching rule.
- **`mode: native` / `nativeTile: true`:** the window is in a KWin quick tile. *Adopt natively tiled window* or *Toggle floating* adopts it back.
- **`userMode: floating`:** you floated it. Use *Toggle floating* again.
- **`exception` not null:**
  - **Gave up:** the window was tiled but did not reach its slot after two corrections. It stays where the client put it.
  - **Overflow (`overflow: ...`):** the layout could not fit it, so it floats.

  The exception gets one new attempt when its inputs change: the usable area of the screen (outputs, panels), the configuration (layout parameters, gaps), the window's own constraints or desktop/screen membership, or a tile leaving its context. If it still does not fit, it floats again. Focus changes and layout shortcuts do not retry it (observed source, `src/core/engine.ts`). Toggling the window back to tiled with *Toggle floating* clears the exception and retries.
- **`mode: pending`:** the window has not reported an application id yet. Plastile waits up to 300 ms before classifying it.

## A window keeps resizing or flickers

Plastile corrects a window at most **twice** per target, then gives up on it and records an explanation. This was measured with clients that ignore and clamp sizes: writes stayed bounded, and there was no further work after convergence. If you see continuous resizing, something else is writing geometry:

- a KWin window rule with a forced size or position
- another tiling script
- the application itself, in a loop

Check KWin's Window Rules and disable other tiling scripts. Then compare two counter dumps: if `counters.writes` grows, the writes are Plastile's; `external` and `skipDiverged` growing points to the other writer.

## Shortcuts do nothing

- **Script not running:** shortcuts work only while the script is enabled. Check KWin Scripts and look for `plastile info started` in the log.
- **Old defaults:** earlier versions bound *Suspend/resume* to `Meta+Shift+S` (taken by Spectacle) and *Grow*/*Shrink* to `Meta+Shift+=` / `Meta+Shift+-`, which never arrive as registered on a US keymap. The defaults are now `Meta+Ctrl+S`, `Meta+Ctrl+=` and `Meta+Ctrl+-` (measured to reach Plastile; [details](SHORTCUTS.md#default-bindings-measured-with-real-key-presses)). A binding you set yourself is kept by KGlobalAccel.
- **Your own bindings:** a key you had already bound to something else goes to that other action (measured for a KWin action bound to `Meta+Shift+H`). Look for `plastile warn shortcut conflicts:` in the log, or open *Explain active window*: both name the key and the other action ([conflict report](SHORTCUTS.md#conflict-report)). Pick another key for one of them.
- **Script disabled:** KGlobalAccel still accepts the shortcut and nothing runs (measured). That is expected.
- **Suspended:** layout commands are rejected with `tiling suspended` (visible at `debug`).

## Saved state

- **Preferences not restored:** look for `plastile warn saved state rejected` (a damaged file, or one from a newer Plastile) or `plastile warn persistence unavailable` (the persistence helper is not installed or did not answer: run `tools/install.sh status`, install it with `tools/install.sh install-helper` ([guide](INSTALL.md#persistence-helper)), then disable and re-enable Plastile). At `info`, `plastile info saved state loaded` reports what was read. A floated window's position is restored only when exactly one window of that application is open. *Log counters* shows `counters.restored` and `counters.restoreAmbiguous`, and `persistence.state`.
- **`plastile warn saving state failed`:** the helper could not store a file (a full disk, a read-only `~/.local/state`); its own warning (program `plastile-state`, category `plastile.state`) says why, in the session's log, for example `journalctl --user -t plastile-state` (not checked on a physical session). Preferences stay in memory and are saved with your next change. This warning appears once until a save succeeds again.
- **Is the helper running?** `busctl --user status org.kde.plastile.State` shows it while it is; it exits after a minute without requests, and the session bus starts it again when Plastile asks. A stopped or hung helper delays only saving: KWin and Plastile's commands do not wait for it (measured in nested sessions with the helper stopped).
- **Start over:** disable Plastile, delete `~/.local/state/plastile/`, enable it again.
- **Files `state-0.ini`, `state-1.ini` or `*.lock` in `~/.local/state/plastile/`:** left by an earlier development build, which saved inside KWin. They are not read any more and can be deleted.

## Known limitations

| Limitation | Detail | Status |
|---|---|---|
| Only some session changes are saved | A layout chosen by command, master ratio and count, and floated windows' positions per application are saved ([saved layout preferences](README.md#saved-layout-preferences)). Window order, BSP structure and per-window choices for applications with several open windows are not. Put lasting choices in the configuration as `defaults` or `overrides`. | By design for now |
| A save is a synchronous file write in KWin | About 2 to 8 ms per save, up to 20 ms observed, about 2 s after the last change and never during a command or drag (nested measurement). On a slow disk it is longer. | Measured (nested); accepted in ADR-013 |
| Apply in the settings dialog alone does not reach the running script | `ScriptingConfig::reload()` is a TODO in kwin v6.7.5. Press *Reload configuration* after Apply: it asks KWin to re-read `kwinrc`, which also re-reads KWin's other settings. | Observed source; measured |
| Default shortcuts tested on one keymap | All 20 defaults reach Plastile with real key presses on the default (US) keymap in a nested session; other layouts and installed software (Spectacle is not installed in the test sandbox) are not covered. | Measured (nested, libei) |
| Activities untested | The matcher and context key include the activity, but every test ran with the single default activity (no Activities service in nested sessions). Switching activities with tiled windows on each is unverified. | Untested |
| Physical session unvalidated | All measurements come from nested `kwin_wayland --virtual` sessions: no plasmashell panels, real monitors or everyday applications, and no mixed refresh rates. | Untested |
| Escape does not cancel a pointer Meta+drag | In KWin 6.7.5, Escape cancels a keyboard-initiated move (the *Move Window* action), and Plastile then keeps the original layout. A drag started with Meta+left-button cannot be cancelled with Escape, and releasing the button commits the drop (swap or snap back). | Measured; KWin behaviour |
| Windows that ignore sizes are corrected at most twice | A client that refuses or alters the requested size is re-requested at most twice. It is then left alone with `exception` set and the reason shown in *Explain*. A client that accepts a larger size than requested has that size learned as its minimum, and the layout re-solves around it. A client that settles up to 32 px smaller is accepted as it is, and one that never answers is not learned from (unit-tested with mock clients). | Measured; by design |
| Only `float-new` overflow | When windows cannot fit above their minimum sizes, the newer ones that do not fit float (and a window too large for the area on its own floats by itself). There is no stack-in-leaf or new-desktop alternative. | By design for now |
| One `ratioStep` in the dialog | The dialog's grow/shrink step drives both master/stack and BSP. Use the JSON document for different steps. | By design |
| Rules cannot move windows | Rules match the screen, desktop and activity a window is on, but cannot send it elsewhere, set a layout or choose another overflow policy; these actions are rejected with the alternative named ([CONFIGURATION](CONFIGURATION.md#rules)). Overrides cannot change rules. | By design for now |
| Rule `insert` action | `border`, `mode`, `minSize` and the context matchers are covered by nested scenarios; `insert` only by validation. | Partly untested |
| The inspector takes the keyboard while open | It is a popup window, like a menu: keys go to it until it closes (Escape, a click elsewhere, another window activated). Global shortcuts still work: a Plastile focus key pressed while it was open moved the focus and closed it. | Measured (nested, libei); KWin popup behaviour |
| Shortcut conflict report is a snapshot | It runs at load and on *Reload configuration*, not when you rebind a key in System Settings. | By design |
| Three or more outputs | Two virtual outputs were tested, not more. | Untested |
| Package discovery after install | A package installed while KWin was running was found by `Scripting.start` only after about 20 s (one nested run). Retry, or log out and in, if Plastile does not appear. | Measured (n=1) |
| Shortcut entries outlive the script | `kglobalshortcutsrc` keeps the `plastile.*` entries after unload or removal. | Measured; KWin behaviour |

## Reporting a problem

Include:

- the KWin version (`kwin_wayland --version`)
- the `plastile info started` line
- the `[Script-plastile]` section of `kwinrc`, with any window titles removed from the JSON
- a *Log counters* dump
- an *Explain active window* dump for the affected window
- a *Log trace* dump taken right after the problem

Say whether it happened in a real session or a nested one. So far, Plastile has been tested only in nested sessions.
