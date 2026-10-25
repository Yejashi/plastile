# Installing Plastile

Plastile is a KWin script package (`KWin/Script`, plugin id `plastile`). Nothing is compiled against KWin. The package is a directory holding QML, a generated JavaScript bundle, a KConfig XT schema and a settings form.

**Supported target:** KWin 6.7 on Wayland (a Plasma 6 Wayland session; XWayland applications inside it are tiled, a Plasma X11 session is not supported). The package declares `X-Plasma-API-Minimum-Version: 6.7`. Versions exercised:

- **KWin 6.7.5:** nested sessions on the reference host and in CI; a physical session on the reference desktop (build `97fec4a`; the physical runbook is not complete); and, by hand, a laptop at scale 1.35 (an earlier build).
- **KWin 6.8:** 6.8.1 in nested sessions on the reference host (the full suite passes, 2026-10-25); 6.8.0 in a provisional CI job, whose reload memory checks fail in some runs on KWin 6.8.0's own allocation. The physical checks on 6.8.1 are not finished, so 6.8 is not declared supported yet.
- Any other version: untested.

This is a release candidate, not a release ([status](README.md#status-read-this-first), [G3 checklist](../status/G3_CHECKLIST.md)). Plastile has no licence yet (`"License": "Undecided"` in `metadata.json`, [ADR-012](../design/DECISIONS.md#adr-012-license-and-upstream-reuse-are-deliberate)).

## 1. Build from source

**Requirements:**

- **Node.js:** the repository is developed with Node 26. `npm ci` installs the pinned TypeScript and esbuild versions.
- **Git.**

```sh
git clone https://github.com/Yejashi/plastile.git
cd plastile
npm ci
npm run build          # writes package/contents/code/plastile.mjs
```

Optional checks before installing:

```sh
npm run typecheck      # tsc, strict
npm test               # core unit tests in Node (no KWin involved)
```

The build output is `package/contents/code/plastile.mjs`, which `package/contents/ui/main.qml` imports. The TypeScript is lowered to the language level KWin's QV4 engine accepts ([API profile](../status/API_PROFILE.md#javascript-language-level-in-kwins-qv4-qt-612)).

**Persistence helper** (optional, needed to keep layout preferences across restarts; [section 2a](#persistence-helper)): CMake, a C++17 compiler and the Qt 6 Core and DBus development files (Arch `qt6-base`, Debian/Ubuntu `qt6-base-dev`).

**Nested integration suite** (`python3 tests/integration/run.py`). It also needs:

- the C fixture client (`make -C fixtures/client`)
- the persistence helper (`cmake -S helper -B build/helper && cmake --build build/helper`); each nested session installs it on its private bus
- `python-dbus`
- a KWin installation

The suite starts private `kwin_wayland --virtual` processes and never touches your running desktop.

## 2. Install the package

Use `kpackagetool6` from KDE Frameworks (Arch package `kpackage`). Run these commands in the session you want Plastile in:

```sh
# first install, from the source tree
kpackagetool6 --type KWin/Script --install package

# later updates
kpackagetool6 --type KWin/Script --upgrade package

# show what is installed
kpackagetool6 --type KWin/Script --show plastile

# removal
kpackagetool6 --type KWin/Script --remove plastile
```

This copies the package to `~/.local/share/kwin/scripts/plastile/` (or `$XDG_DATA_HOME/kwin/scripts/plastile/`).

**`tools/install.sh`** wraps exactly these commands (`install`, `upgrade`, `remove`, `status`) and adds `install-helper` and `remove-helper` for the [persistence helper](#persistence-helper). `install`, `upgrade` and `remove` also install, replace and remove the optional [Plastile Motion effect](#8-window-motion-optional), which stays disabled until you turn it on. It refuses to install a package without the built bundle. It never enables, reloads or restarts anything and never writes `kwinrc`. `python3 tools/release.py --out dist` builds a `dist/plastile-<version>.kwinscript` archive, and both `kpackagetool6` and `install.sh` accept that archive instead of the `package` directory. The physical runs installed with `tools/install.sh install` and `install-helper`.

What was measured (nested KWin 6.7.5, kpackagetool6 2.0, package installed into the session's private data directory):

- **Install before KWin starts:** the package installs, is autoloaded when KWin starts with `[Plugins] plastileEnabled=true`, and tiles windows.
- **Disable/enable and upgrade:** disabling and re-enabling through the `Plugins` key plus `org.kde.kwin.Scripting.start` works, as do upgrade and removal. An upgrade takes effect only after KWin restarts ([Updating](#updating)).
- **Install while KWin runs:** the package was not found by `Scripting.start` immediately. In one run, five attempts over the first 16.5 s failed and the attempt at 20.6 s loaded it (a cached package listing is the likely cause, by inference). If Plastile does not appear in System Settings, or does not start after you enable it, wait half a minute and try again, or log out and back in. Do **not** run `kwin_wayland --replace`: on Wayland that ends your session.

### Persistence helper

Plastile keeps your layout preferences (layouts, master ratios, where you floated windows) across script reloads, KWin restarts and logins only when its helper, `plastile-state`, is installed. The KWin script package cannot hold it: it is a separate program that the session bus starts when Plastile first asks for it, and it writes the state files so that KWin never does file I/O for them ([ADR-020](../design/DECISIONS.md#adr-020-persistence-goes-through-an-asynchronous-d-bus-helper), [helper README](../../helper/README.md)).

```sh
tools/install.sh install-helper    # build and install the helper and its D-Bus activation file
tools/install.sh status            # shows "helper    : installed (...)"
tools/install.sh remove-helper     # uninstall it (the saved state is kept)
```

`install-helper` builds `helper/` with CMake in `build/helper-install`, installs the binary as `~/.local/libexec/plastile-state` (`PLASTILE_HELPER_PREFIX` changes `~/.local`), writes `~/.local/share/dbus-1/services/org.kde.plastile.State.service` (under `$XDG_DATA_HOME` if set), and asks the session bus to re-read its service files. Nothing starts until Plastile asks; the helper exits after a minute without requests. A Plastile that is already running without the helper notices it at its next start: disable and re-enable the script, or log out and in. A release also carries the helper's sources as `dist/plastile-state-<version>.tar.gz` (built by `tools/release.py`), which builds the same way with `cmake`.

Without the helper Plastile tiles normally and logs `plastile warn persistence unavailable` once at start-up. Measured in nested sessions: installation into a private prefix and data directory, D-Bus activation and saving (`package-helper-install-T32`). In both physical sessions (KWin 6.7.5) the session bus activated the helper on Plastile's first request (dbus-broker under systemd on the reference desktop), and on the laptop a layout survived a re-login ([first run](../status/evidence/physical-first-run-20261018.json), [runbook](../status/evidence/physical-runbook-20261018.json)). How long that activation takes in a physical session was not measured.

**Leftover shortcut entries.** While the script is loaded, it registers one global shortcut per command in `~/.config/kglobalshortcutsrc`. These entries stay after the script is disabled or removed (measured). They are inert without the script.

### Updating

1. Install the new package over the old one: `kpackagetool6 --type KWin/Script --upgrade package` (or `tools/install.sh upgrade`, or either of them with a `dist/plastile-<version>.kwinscript` archive). This works while KWin runs.
2. **Log out and back in.** The running KWin keeps executing the version it loaded until KWin itself restarts. Unticking and re-ticking Plastile in KWin Scripts is not enough, and neither is disabling it before the upgrade and enabling it after.
3. Check the version: the log line `plastile notice started <version>: ...`, or `kpackagetool6 --type KWin/Script --show plastile` for what is installed.

Measured in nested KWin 6.7.5 (scenario `package-upgrade-bindings-T26-T32`): a package built from an older commit and labelled 0.0.1 was upgraded to 0.1.0 while it ran. After a disable and re-enable through `[Plugins]` plus `Scripting.start`, KWin started 0.0.1 again, although the 0.0.1 files were no longer on disk; the same happened with the script disabled during the upgrade. A KWin restart over the same configuration, data and cache directories started 0.1.0; the cache directory still held the first KWin's QML disk cache (`$XDG_CACHE_HOME/kwin/qmlcache`), as `~/.cache` does after a re-login, and it did not bring the older version back (kpackagetool6 gives the installed files the install time, not the archive's dates, measured). The cause, from KWin's source (observed: v6.7.5 `src/scripting/scripting.cpp`): every declarative script is loaded into one QML engine shared by all scripts, by the same file URL, and KWin never clears that engine's component cache. On Wayland, restarting KWin means ending the session; do **not** run `kwin_wayland --replace`.

What an upgrade keeps (same scenario, after the script restart and after the KWin restart):

- **Settings:** the `[Script-plastile]` group in `kwinrc` is untouched; the new version applied the non-default gaps and master ratio it found there (measured on the windows' frames).
- **Your shortcut bindings:** two rebound commands, a binding given to a command that has none by default, and a cleared default all stayed as you set them, in KGlobalAccel and in `kglobalshortcutsrc`. The rebound keys, pressed for real, ran their command once each; the old keys and the cleared key ran nothing. `Meta+T` stayed KWin's tile editor.
- **Old defaults, too.** A command you never touched keeps the key the older version registered, even when the new version has a different default. See [Changed defaults](SHORTCUTS.md#default-bindings-measured-with-real-key-presses): after upgrading from a version that bound *Suspend/resume tiling* to `Meta+Shift+S`, it is still `Meta+Shift+S`, which collides with Spectacle; rebind it in the shortcut settings.

Not measured: an upgrade in a physical session, and an upgrade between two released versions (there is no release yet).

## 3. Enable in System Settings

1. Open **System Settings > Window Management > KWin Scripts**.
2. Tick **Plastile** and click **Apply**. The page writes `[Plugins] plastileEnabled=true` and calls `org.kde.kwin.Scripting.start` (observed source: kwin v6.7.5 `src/kcms/scripts/module.cpp`). KWin loads the script, which adopts the windows already open and registers its shortcuts.
3. To stop it, untick and Apply. Unloading disconnects every signal, stops Plastile's single timer, restores borders it changed and leaves windows where they are. Plastile's own teardown was measured in nested KWin sessions over 100 disable/enable cycles with pending work (`reload-Q09`: KWin's exported script objects, the shortcut list, idle CPU and RSS stay flat) and 20 unloads with unsaved layout changes (`persist-reload-cycles-Q09`: each saves exactly once). The earlier 300-cycle lifecycle probe measured KWin's script loader before Plastile existed and says nothing about Plastile itself. In the physical runbook the latency and idle runs unloaded and loaded Plastile many times over D-Bus; resource counts across those reloads were not recorded there, and the multi-hour soak is still running.

The script is **not enabled by default** (`EnabledByDefault: false`).

**First run: is it working?** Open two or three windows on one desktop: they should tile side by side (master/stack). Then check the log:

```sh
journalctl --user -b | grep plastile
```

Look for `plastile notice started 0.1.0: N windows, configuration revision 1; layout master-stack on <screen> / <desktop>`. It is shown at the default log level. No such line means the script did not load. A desktop in monocle or floating, or a maximized window, looks like no tiling: `Meta+Shift+Space` cycles the layouts, each change shows an on-screen message and a `plastile notice layout ...` line, and a layout you chose is remembered for that desktop across logins. The [user guide](README.md#is-it-working) has the full checklist. (In the first physical session, KWin 6.7.5, this journal showed KWin's own warnings about the script but none of Plastile's lines: the older default level hid them. On the reference desktop, with the current default level, the `started` line appeared in the user journal and there was no `qt.qml.usedbeforedeclared` warning.)

Equivalent from a terminal in the same session (the path the package scenario measured):

```sh
kwriteconfig6 --file kwinrc --group Plugins --key plastileEnabled true
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start
```

The KWin Scripts page itself has not been clicked through in a physical session: on the reference desktop Plastile was enabled with the two commands above, on the owner's behalf. The nested check covered only the page's D-Bus effect.

## 4. Settings dialog

The configure button next to Plastile in KWin Scripts opens KWin's generic script settings dialog. That dialog is built from `package/contents/config/main.xml` and `package/contents/ui/config.ui`:

- **Layout:** default layout, gap between windows, gap at screen edges, keeping screen-edge gaps around a single window, grow/shrink step.
- **Master and stack:** master area width, windows in the master area, where new windows go.
- **Binary split (BSP):** which tile a new window splits, split direction.
- **Layout** also has the on-screen message switch (`osd`): Plasma's on-screen display when a shortcut changes the layout or pauses tiling.
- **Layout** also has *Windows that open maximized* (`maximizedOnOpen`): *Un-maximize and tile them* (the default) or *Leave them maximized* ([CONFIGURATION](CONFIGURATION.md#flat-keys)).
- **Advanced:** log level (off, errors only, warnings and notices, information, debug), diagnostic trace size, and the JSON text for per-screen overrides and window rules ([CONFIGURATION](CONFIGURATION.md)).

The dialog writes values to `~/.config/kwinrc` under `[Script-plastile]`, using the key names in [CONFIGURATION](CONFIGURATION.md#flat-keys). Choices are stored by name (`layout=bsp`).

The dialog was verified headlessly with `tools/settings-check`, which loads the same schema and form the way KWin's dialog does. It confirmed four things:

- every schema entry is bound to a widget
- defaults reach the widgets
- edits are saved in the vocabulary the runtime expects
- hand-edited values load back

It has been opened and applied in KWin's real dialog in a nested session (`kcmshell6 kcm_kwin_scripts`, driven with real input; scenario `settings-dialog-T28`), but **not** clicked through in a physical session.

## Applying settings changes

**Apply in the settings dialog saves `kwinrc` and does nothing else.** Observed source: in kwin v6.7.5 `src/kcms/common/genericscriptedconfig.cpp`, `ScriptingConfig::reload()` is an empty TODO. The running script is not notified, and KWin does not re-read its own copy of `kwinrc`.

That second point matters. Plastile reads its settings through `KWin.readConfig`, which reads KWin's **cached** `kwinrc` (observed source: `AbstractScript::config()` in `src/scripting/scripting.cpp`). KWin re-reads the file only on a reconfigure (`Workspace::slotReconfigure`), on `Scripting.start`, or when the writer sends a KConfig change notification.

An emulation of the dialog's save path (`tools/settings-check`, the same KConfigLoader save) sent no change notification on the session bus.

**So, after Apply, press Plastile: Reload configuration** (unbound by default; bind it in the shortcut settings, or run it from a terminal with `qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut plastile.runtime.reload-config`). The command asks KWin to reconfigure, through the same asynchronous D-Bus call that `qdbus6 org.kde.KWin /KWin reconfigure` makes. KWin re-reads `kwinrc` about 200 ms later (its own reconfigure timer), and Plastile activates the new values when KWin reports them. Like the other KDE settings pages' Apply, this makes KWin re-read all of its settings, not only Plastile's.

Measured in nested KWin 6.7.5 and 6.8.0 (scenario `reload-config-D9-Q04`; the timings below are from 6.7.5, 6.8.0 gave the same results), with the package installed and enabled, after `kwriteconfig6` changed `gapInner` without a change notification:

| You... | Result |
|---|---|
| press *Reload configuration* once | The new gap was active 0.3 s later. One activation. |
| press it 20 times in a row (70 ms) | One activation. KWin coalesces the requests into one re-read. |
| either of the above | The script was not loaded a second time (KWin's reconfigure also runs `Scripting.start`, which skips loaded scripts): one `started` line, the same connection and window counts, one shortcut per command. |

Earlier versions' *Reload configuration* only re-read KWin's cached copy and changed nothing after Apply. If the D-Bus request fails, the command still re-reads the cached copy and logs a warning.

Other paths that work:

1. Run `qdbus6 org.kde.KWin /KWin reconfigure` in a terminal (measured). Plastile reloads on its own.
2. Untick Plastile in KWin Scripts and Apply, then tick it and Apply again. The re-enabled script reads the file fresh. This is an inference from the measured pieces: `Scripting.start` re-reads `kwinrc`, and a newly loaded script reads its settings at start.

Whichever path you use, the new configuration is validated first. If it is invalid, the previous configuration stays active and the errors are logged ([TROUBLESHOOTING](TROUBLESHOOTING.md#reading-the-log)). An unchanged configuration is not a new revision and changes nothing.

## 5. Editing kwinrc directly

```sh
kwriteconfig6 --file kwinrc --group Script-plastile --key layout bsp
kwriteconfig6 --file kwinrc --group Script-plastile --key gapInner 4
qdbus6 org.kde.KWin /KWin reconfigure
```

Or edit `~/.config/kwinrc` in a text editor and reconfigure:

```ini
[Script-plastile]
layout=bsp
gapInner=4
gapOuter=4
diagnostics=info
```

The `configJson` key holds the JSON document as a single KConfig string. The settings dialog's text box, or `kwriteconfig6 --key configJson '<json>'`, is easier than hand-escaping it.

## 6. Uninstall cleanly

1. Untick Plastile in KWin Scripts and Apply. This releases windows, borders and connections.
2. Run `kpackagetool6 --type KWin/Script --remove plastile`.
3. Optionally, delete the `[Script-plastile]` group and the `plastileEnabled` line from `~/.config/kwinrc`.
4. Optionally, drop the leftover `plastile.*` shortcut entries (under `[kwin]` in `~/.config/kglobalshortcutsrc`). They keep your bindings for a later reinstall, and they do nothing without the script. Do not edit the file while you are logged in: KGlobalAccel runs inside KWin, keeps the registrations in memory and rewrites the file at its next save, which brought all 68 entries back in a nested session (measured). Instead, after step 2, run:

   ```sh
   qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.cleanUp
   ```

   It removes every KWin shortcut registration that has no live action. Measured in nested KWin 6.7.5 (`package-upgrade-bindings-T26-T32`): with Plastile running it removed no Plastile entry; after the removal it removed all of them, from KGlobalAccel and from the file, and nothing else (235 KWin registrations before, 167 after: the 68 of Plastile). It is not limited to Plastile: the leftovers of other removed KWin scripts go too, and so, by inference, would the registrations of any KWin action that is not registered at that moment (a disabled script's shortcuts, for example), with the bindings you gave them. Or edit the file from a session where KWin is not running.
5. Run `tools/install.sh remove-helper` if you installed the persistence helper (or delete `~/.local/libexec/plastile-state` and `~/.local/share/dbus-1/services/org.kde.plastile.State.service`). A helper that is running exits on its own within a minute.
6. Optionally, delete `~/.local/state/plastile/`, which holds saved layout preferences ([details](README.md#saved-layout-preferences)).

Windows keep the geometry they had at unload. Nothing is restored to a pre-Plastile arrangement, because no such arrangement is stored.

Steps 1, 2 and 4 were measured in nested KWin 6.7.5 (`package-install-autoload-T32`, `package-upgrade-bindings-T26-T32`). The uninstall has not been run in a physical session yet (runbook PHY-10).

## 7. Recovery

If tiling misbehaves and you need your desktop back at once, without logging out:

1. **Pause it:** press *Suspend/resume tiling* (`Meta+Ctrl+S`, unless you rebound it). Plastile stops placing windows and leaves them where they are. Press it again to resume.
2. **Turn it off:** untick Plastile in System Settings > Window Management > KWin Scripts and Apply, or run `kwriteconfig6 --file kwinrc --group Plugins --key plastileEnabled false` and then `qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript plastile`. Windows stay where they are.
3. **Start it without saved preferences:** turn it off, delete `~/.local/state/plastile/`, turn it on again.
4. **Start it without your configuration:** turn it off, remove the `[Script-plastile]` group from `~/.config/kwinrc` (keep a copy), turn it on again.

Never use `kwin_wayland --replace` to recover: on Wayland it ends your session. [TROUBLESHOOTING](TROUBLESHOOTING.md) has the diagnostics to collect first if you want to report the problem.

## 8. Window motion (optional)

Plastile moves windows at once. If you want to see them slide and resize into place, enable the separate
**Plastile Motion** desktop effect (KWin effect id `plastile_motion`, package `effect/`). It only changes how
windows are drawn for a moment; Plastile, the applications and the window positions behave exactly as without it
([ADR-023](../design/DECISIONS.md#adr-023-window-motion-is-an-optional-transform-only-kwin-effect-plastile-motion)).

```sh
tools/install.sh install-effect   # also done by tools/install.sh install / upgrade
tools/install.sh status           # "effect" and "effect on" lines
tools/install.sh remove-effect    # also done by tools/install.sh remove
```

`install-effect` runs `kpackagetool6 --type KWin/Effect --install effect` (or `--upgrade`), copying it to
`~/.local/share/kwin/effects/plastile_motion/`. `PLASTILE_EFFECT_SOURCE` selects another source, such as the
`dist/plastile_motion-<version>.zip` that `tools/release.py` builds. Nothing is enabled, and `kwinrc` is not written.

**Turn it on:** *System Settings > Window Management > Desktop Effects*, tick *Plastile Motion*, Apply. Its
*Configure* button sets the duration and easing ([CONFIGURATION](CONFIGURATION.md#window-motion-the-plastile-motion-effect)).
From a terminal in the same session:

```sh
kwriteconfig6 --file kwinrc --group Plugins --key plastile_motionEnabled --notify true
```

KWin loads it as soon as it sees the change (`--notify`; without it the change waits for the next login).
Measured in nested KWin 6.8.1: both this command and an effect installed while KWin was running loaded at once.

**Turn it off:** untick it, or run the same command with `false`; or set the global animation speed to *Instant*
(*System Settings > General Behavior*), which turns off this and KWin's other animations. With each of the three,
windows are drawn at their real place from the next frame, even in the middle of an animation (measured in nested
KWin 6.8.1).

**Where it works:** KWin runs scripted effects only with OpenGL compositing on a hardware renderer. With software
rendering (llvmpipe) or QPainter compositing it is not loaded and nothing is animated. It has not been run in a
physical session yet; smoothness on real displays is unverified.
