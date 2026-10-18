# Installing Plastile

Plastile is a KWin script package (`KWin/Script`, plugin id `plastile`). Nothing is compiled against KWin. The package is a directory holding QML, a generated JavaScript bundle, a KConfig XT schema and a settings form.

**Supported target:** KWin 6.7.x on Wayland. The package declares `X-Plasma-API-Minimum-Version: 6.7`. Only 6.7.5 has been exercised, and only in nested sessions ([status](README.md#status-read-this-first)).

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

**Nested integration suite** (`python3 tests/integration/run.py`). It also needs:

- the C fixture client (`make -C fixtures/client`)
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

**`tools/install.sh`.** If your checkout has a `tools/install.sh` script, it wraps exactly these commands (`install`, `upgrade`, `remove`, `status`). It refuses to install a package without the built bundle. It never enables, reloads or restarts anything and never writes `kwinrc`. If `tools/release.py` is present, it can build a `dist/plastile-<version>.kwinscript` archive, and both `kpackagetool6` and `install.sh` accept that archive instead of the `package` directory.

What was measured (nested KWin 6.7.5, kpackagetool6 2.0, package installed into the session's private data directory):

- **Install before KWin starts:** the package installs, is autoloaded when KWin starts with `[Plugins] plastileEnabled=true`, and tiles windows.
- **Disable/enable and upgrade:** disabling and re-enabling through the `Plugins` key plus `org.kde.kwin.Scripting.start` works, as do upgrade and removal.
- **Install while KWin runs:** the package was not found by `Scripting.start` immediately. In one run, five attempts over the first 16.5 s failed and the attempt at 20.6 s loaded it (a cached package listing is the likely cause, by inference). If Plastile does not appear in System Settings, or does not start after you enable it, wait half a minute and try again, or log out and back in. Do **not** run `kwin_wayland --replace`: on Wayland that ends your session.

**Leftover shortcut entries.** While the script is loaded, it registers one global shortcut per command in `~/.config/kglobalshortcutsrc`. These entries stay after the script is disabled or removed (measured). They are inert without the script.

## 3. Enable in System Settings

1. Open **System Settings > Window Management > KWin Scripts**.
2. Tick **Plastile** and click **Apply**. The page writes `[Plugins] plastileEnabled=true` and calls `org.kde.kwin.Scripting.start` (observed source: kwin v6.7.5 `src/kcms/scripts/module.cpp`). KWin loads the script, which adopts the windows already open and registers its shortcuts.
3. To stop it, untick and Apply. Unloading disconnects every signal, stops Plastile's single timer, restores borders it changed and leaves windows where they are. This was measured over 300 load/unload cycles in the probes and 20 reloads with pending work in the integration suite.

The script is **not enabled by default** (`EnabledByDefault: false`).

Equivalent from a terminal in the same session (the path the package scenario measured):

```sh
kwriteconfig6 --file kwinrc --group Plugins --key plastileEnabled true
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start
```

The KWin Scripts page itself has not been clicked through in a live System Settings window. The check covered only its D-Bus effect.

## 4. Settings dialog

The configure button next to Plastile in KWin Scripts opens KWin's generic script settings dialog. That dialog is built from `package/contents/config/main.xml` and `package/contents/ui/config.ui`:

- **Layout:** default layout, gap between windows, gap at screen edges, keeping screen-edge gaps around a single window, grow/shrink step.
- **Master and stack:** master area width, windows in the master area, where new windows go.
- **Binary split (BSP):** which tile a new window splits, split direction.
- **Advanced:** log level, diagnostic trace size, and the JSON text for per-screen overrides and window rules ([CONFIGURATION](CONFIGURATION.md)).

The dialog writes values to `~/.config/kwinrc` under `[Script-plastile]`, using the key names in [CONFIGURATION](CONFIGURATION.md#flat-keys). Choices are stored by name (`layout=bsp`).

The dialog was verified headlessly with `tools/settings-check`, which loads the same schema and form the way KWin's dialog does. It confirmed four things:

- every schema entry is bound to a widget
- defaults reach the widgets
- edits are saved in the vocabulary the runtime expects
- hand-edited values load back

It has **not** been clicked through in a live System Settings window.

## Applying settings changes

**Apply in the settings dialog saves `kwinrc` and does nothing else.** Observed source: in kwin v6.7.5 `src/kcms/common/genericscriptedconfig.cpp`, `ScriptingConfig::reload()` is an empty TODO. The running script is not notified, and KWin does not re-read its own copy of `kwinrc`.

That second point matters. Plastile reads its settings through `KWin.readConfig`, which reads KWin's **cached** `kwinrc` (observed source: `AbstractScript::config()` in `src/scripting/scripting.cpp`). KWin re-reads the file only on a reconfigure (`Workspace::slotReconfigure`), on `Scripting.start`, or when the writer sends a KConfig change notification.

An emulation of the dialog's save path (`tools/settings-check`, the same KConfigLoader save) sent no change notification on the session bus.

**So, after Apply, press Plastile: Reload configuration** (unbound by default; bind it in the shortcut settings, or run it from a terminal with `qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut plastile.runtime.reload-config`). The command asks KWin to reconfigure, through the same asynchronous D-Bus call that `qdbus6 org.kde.KWin /KWin reconfigure` makes. KWin re-reads `kwinrc` about 200 ms later (its own reconfigure timer), and Plastile activates the new values when KWin reports them. Like the other KDE settings pages' Apply, this makes KWin re-read all of its settings, not only Plastile's.

Measured in nested KWin 6.7.5 (scenario `reload-config-D9-Q04`), with the package installed and enabled, after `kwriteconfig6` changed `gapInner` without a change notification:

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
3. Optionally, delete the `[Script-plastile]` group and the `plastileEnabled` line from `~/.config/kwinrc`, and the `plastile.*` entries from `~/.config/kglobalshortcutsrc` (they are under the `[kwin]` group).

Windows keep the geometry they had at unload. Nothing is restored to a pre-Plastile arrangement, because no such arrangement is stored.
