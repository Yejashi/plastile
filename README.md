# Plastile

**Automatic tiling for KDE Plasma 6 that keeps KWin as your window manager.**

[![CI](https://github.com/Yejashi/plastile/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Yejashi/plastile/actions/workflows/ci.yml)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
![KWin 6.7 | 6.8](https://img.shields.io/badge/KWin-6.7%20%7C%206.8-1d99f3.svg)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)

Plastile is a KWin script that arranges your windows into tiles as they open and close. You drive it from the
keyboard. It decides where windows go and asks KWin to put them there; everything else stays standard Plasma:
decorations, Alt+Tab, the task manager, maximize, fullscreen, native quick tiling and your existing shortcuts.

> [!WARNING]
> **Plastile is alpha software (0.1.0).** It is tested heavily in disposable nested KWin sessions and has been
> used on a real multi-monitor desktop, but a few physical-session checks are still open (see
> [Project status](#project-status)). Expect rough edges and please [report them](#reporting-bugs).

## Features

- **Layouts:** master/stack (default), BSP (binary space partitioning), monocle and floating, chosen per
  screen, virtual desktop and activity. Switch layouts without losing the window order.
- **Keyboard first:** focus, swap, move, grow/shrink, master count, rotate/mirror, send to another desktop or
  screen, float/tile. 68 commands, 20 bound by default, all rebindable in System Settings.
- **Mouse too:** drop a tile onto another to swap them; `Meta`+right-drag moves the shared divider.
- **Cooperates with KWin:** maximize, fullscreen, minimize, native quick tiling (`Meta+arrows`) and windows you
  float are respected rather than fought. A window that refuses a size is corrected at most twice, then left
  alone with an explanation.
- **Sensible defaults:** dialogs, utilities, fixed-size and transient windows float. Windows that open
  maximized are tiled once.
- **Multi-monitor aware:** mixed refresh rates, fractional scaling, panels, per-screen virtual desktops,
  activities, monitor hot-plug.
- **Validated configuration:** a settings dialog for the common options, plus a JSON document for per-screen,
  per-desktop and per-activity overrides and ordered window rules. Invalid configuration is rejected and the
  previous one kept. No user code runs inside KWin.
- **Remembers your choices** (layout, master ratio, floating positions) across logins, through a small
  optional D-Bus helper.
- **Explains itself:** *Explain active window* tells you why a window is tiled, floating or left alone.
- **Instant by default:** windows move in one step with no animation. **Plastile Motion**, a separate optional
  KWin effect (off by default), animates how windows slide into place without slowing down commands.
- **Experimental, opt-in:** a scrolling (niri/PaperWM-style) layout and manual zones.
- **No idle work:** no timers or polling while nothing happens.

## Requirements

- KDE Plasma 6 in a **Wayland** session with **KWin 6.7 or 6.8**. XWayland applications are tiled; a Plasma X11
  session is not supported. Other KWin versions are untested.
- To build: Node.js 26 and npm.
- Optional, to keep preferences across logins: CMake, a C++17 compiler and Qt 6 Core/DBus development files
  (Arch `qt6-base`, Debian/Ubuntu `qt6-base-dev`).

## Installation

### Quick install

```sh
curl -fsSL https://raw.githubusercontent.com/Yejashi/plastile/main/install.sh | sh
```

That downloads the newest [release](https://github.com/Yejashi/plastile/releases), checks it against the
release's `SHA256SUMS`, installs it for your user with `kpackagetool6`, and turns it on. Open two or three
windows: they tile side by side. Nothing needs `sudo`, and KWin is not restarted.

Add options after `sh -s --`:

| Option | What it does |
|---|---|
| `--with-helper` | Also builds the small helper that remembers layouts across logins (needs `cmake` and the Qt 6 development files: Arch `qt6-base`, Debian/Ubuntu `qt6-base-dev`, Fedora `qt6-qtbase-devel`) |
| `--version v0.1.0-alpha` | Installs a specific release |
| `--no-enable` | Installs without turning it on |
| `--uninstall` | Turns Plastile off and removes it |

For example: `curl -fsSL https://raw.githubusercontent.com/Yejashi/plastile/main/install.sh | sh -s -- --with-helper`.
If you prefer to read the script first, download it and run `sh install.sh --help`.

**Updating:** run the same command again, then **log out and back in**. KWin keeps running the old version of a
script until it restarts. Do not run `kwin_wayland --replace` on Wayland: it ends your session.

> Before the first release is published, the quick install has nothing to download and says so; use
> [From source](#from-source) until then.

### NixOS

The repository is a flake with a package, an overlay and a NixOS module:

```nix
# flake.nix
inputs.plastile.url = "github:Yejashi/plastile";

# in your NixOS configuration
imports = [ inputs.plastile.nixosModules.default ];
programs.plastile.enable = true;
```

Then turn it on in System Settings (below), or set `kwinrc` `[Plugins] plastileEnabled=true` with
plasma-manager. It needs a nixpkgs with Plasma 6.7 or newer (nixos-unstable). Details:
[INSTALL](docs/user/INSTALL.md#nixos).

### From source

You need Node.js 26 and npm.

```sh
git clone https://github.com/Yejashi/plastile.git
cd plastile
npm ci
npm run build

tools/install.sh install          # installs the KWin script (and the optional, disabled Motion effect)
tools/install.sh install-helper   # optional: remembers layouts across logins
```

Then turn it on in **System Settings → Window Management → KWin Scripts**: tick **Plastile** and click
**Apply**. Update with `git pull && npm ci && npm run build && tools/install.sh upgrade` and a re-login;
remove with `tools/install.sh remove` (and `remove-helper`).

### Is it running?

`journalctl --user -b | grep plastile` should show `plastile notice started 0.1.0: ...`. The full guide, with
the settings dialog, uninstalling and recovery, is [docs/user/INSTALL.md](docs/user/INSTALL.md).

## Default shortcuts

| Keys | Action |
|---|---|
| `Meta+Shift+H` / `J` / `K` / `L` | Focus left / down / up / right |
| `Meta+Shift+N` / `P` | Focus next / previous window |
| `Meta+Ctrl+H` / `J` / `K` / `L` | Swap with the window left / below / above / right |
| `Meta+Shift+Return` | Swap with master |
| `Meta+Ctrl+=` / `Meta+Ctrl+-` | Grow / shrink the focused tile |
| `Meta+Shift+I` / `D` | More / fewer master windows |
| `Meta+Shift+Space` | Next layout (master/stack → BSP → monocle → floating) |
| `Meta+Shift+M` | Monocle layout |
| `Meta+Shift+F` | Toggle floating for the active window |
| `Meta+Shift+O` | Send the window to the next screen |
| `Meta+Ctrl+S` | Suspend / resume tiling |

The keys avoid KWin's own defaults (`Meta+arrows`, `Meta+T`, `Meta+W`, `Meta+L` and others). Every command and
what it does exactly is in [docs/user/SHORTCUTS.md](docs/user/SHORTCUTS.md); rebind any of them under
**System Settings → Keyboard → Shortcuts**, component *KWin*, searching for "Plastile".

> **Nothing seems to happen?** Monocle, the floating layout and a maximized window all look like no tiling.
> Press `Meta+Shift+Space` to cycle layouts; each change shows an on-screen message. See
> [Is it working?](docs/user/README.md#is-it-working)

## Configuration

Common options (gaps, default layout, master ratio and count, insert position, focus wrapping, …) are in the
settings dialog: the configure button next to Plastile under *KWin Scripts*. Per-screen/desktop/activity
overrides and window rules go in a JSON document (the text box under *Advanced* in the same dialog). This one
sets 6 px gaps, puts a desktop named "Writing" in monocle, turns tiling off on desktops whose name starts with
"Chat", and floats KCalc:

```json
{
  "schemaVersion": 1,
  "defaults": { "gaps": { "inner": 6 } },
  "overrides": [
    { "id": "writing", "match": { "desktopName": "Writing" }, "set": { "layout": "monocle" } },
    { "id": "chat", "match": { "desktopName": { "glob": "Chat*" } }, "set": { "enabled": false } }
  ],
  "rules": [
    { "id": "float-calc", "match": { "appId": "org.kde.kcalc" }, "actions": { "mode": "floating" } }
  ]
}
```

Unknown keys are errors, so a typo is reported instead of silently ignored. Every key, matcher and the
precedence rules are in [docs/user/CONFIGURATION.md](docs/user/CONFIGURATION.md).

## How it works

Plastile is a declarative KWin script with a TypeScript core, bundled to plain JavaScript that runs inside
KWin's own QML engine. There is no daemon on the hot path and no native plugin to rebuild for each KWin release.

- A pure **policy core** (`src/core`) holds the layout model and computes target rectangles. It knows nothing
  about KWin, which keeps it unit-testable and replayable.
- A single **adapter** (`src/adapters/kwin`) is the only code that touches KWin objects and the only writer
  of window geometry. It keeps the geometry it wants, the geometry it requested and the geometry KWin reports
  separate, so slow or stubborn applications never cause resize loops.
- Commands run immediately with one coalesced solve per change; nothing waits on a fixed timer, disk or
  network.
- Saved preferences go through an asynchronous D-Bus helper (`helper/`), so KWin's thread never does file I/O.

The design is written up in [docs/design/ARCHITECTURE.md](docs/design/ARCHITECTURE.md), with the reasoning
behind each choice in the [decision records](docs/design/DECISIONS.md).

## Project status

Plastile 0.1.0 is an **alpha**. What has been tested, and how:

| Layer | Result |
|---|---|
| Unit and replay tests | 604 tests (Node) |
| Nested KWin (disposable `kwin_wayland --virtual` sessions, real input, frames read back from KWin) | Full suite passes on KWin 6.7.5 and 6.8.1; CI runs it on 6.7.5 and 6.8.0 |
| Physical desktop (3 monitors at 60/100/144 Hz) | Install, multiple outputs, fractional scaling, panels, activities, real applications, shortcuts and idle behaviour pass; in daily use on KWin 6.8.1 |

Known gaps before the first stable release:

- **Latency at high refresh rates.** At 60 Hz every measured action was as fast as KWin's own equivalent. At
  144 Hz, grow/shrink became visible about 11 ms later (median) than KWin's quick tile, and focus about 10 ms
  later than KWin's window switch (mostly the window decoration redrawing). Plastile itself answers in under
  1 ms; where the rest goes is under investigation.
- **Not yet checked on real hardware:** unplugging a monitor and system suspend (both pass in nested
  sessions), VRR, two identical monitors, and the scrolling and zones layouts.

All numbers name the environment they were measured in; nested results are never presented as physical ones.
The full, evidence-linked picture is in the [user guide's status section](docs/user/README.md#status-read-this-first),
the [release checklist](docs/status/G3_CHECKLIST.md) and the
[performance report](docs/status/G2_REPORT.md).

## Troubleshooting

- `journalctl --user -b | grep plastile` shows what Plastile did and why.
- *Explain active window* (unbound by default; bind it or run it over D-Bus) shows why a window is where it is.
- *Suspend/resume tiling* (`Meta+Ctrl+S`) gets Plastile out of your way instantly; *Reconcile* re-applies the
  layout.

More in [docs/user/TROUBLESHOOTING.md](docs/user/TROUBLESHOOTING.md), including the
[known limitations](docs/user/TROUBLESHOOTING.md#known-limitations).

## Reporting bugs

Please [open an issue](https://github.com/Yejashi/plastile/issues/new/choose) and include your KWin version
(`kwin_wayland --version`), distribution, monitor setup and the output of
`journalctl --user -b | grep plastile`. The [troubleshooting guide](docs/user/TROUBLESHOOTING.md#reporting-a-problem)
explains how to capture a trace. Security issues: see [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, the test layers
(unit, nested KWin, physical) and the few hard rules, such as a single geometry writer and no timers on the
command path. In short:

```sh
npm ci
npm run check                     # type check, unit tests, bundle
python3 tests/integration/run.py  # nested KWin suite; never touches your running desktop
```

The documentation map is in [docs/README.md](docs/README.md).

## Acknowledgements

Plastile was designed after studying the source of existing tilers, including
[Krohnkite](https://github.com/anametologin/krohnkite), [Bismuth](https://github.com/Bismuth-Forge/bismuth),
[Polonium](https://github.com/zeroxoneafour/polonium), [Karousel](https://github.com/peterfajdiga/karousel),
[KZones](https://github.com/gerritdevriese/kzones), [bspwm](https://github.com/baskerville/bspwm),
[i3](https://github.com/i3/i3) and of course [KWin](https://invent.kde.org/plasma/kwin). Plastile's code is
its own; the analysis is in [docs/research/STATE_OF_THE_ART.md](docs/research/STATE_OF_THE_ART.md).

## License

Plastile is free software, licensed under the [GNU General Public License v3.0 or later](LICENSE)
(`GPL-3.0-or-later`).
