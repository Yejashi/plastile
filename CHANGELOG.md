# Changelog

Notable changes to Plastile. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/) (before 1.0, a minor version may change behaviour).

## [Unreleased]

### 0.1.0 alpha (first public release, not yet tagged)

The first public version. Details and known limitations are in the
[release notes](docs/release/0.1.0-alpha.md).

#### Added

- Automatic tiling for KDE Plasma 6 on Wayland as a KWin script (KWin 6.7 and 6.8).
- Layouts: master/stack (default), BSP, monocle and floating, per screen, virtual desktop and activity.
- 68 keyboard commands (20 bound by default) for focus, swap, move, resize, master count, BSP rotate/mirror,
  sending windows to other desktops and screens, floating, suspend/resume and diagnostics.
- Pointer drags: drop a tile on another to swap; `Meta`+right-drag moves the shared divider.
- Cooperation with KWin: maximize, fullscreen, minimize, native quick tiling and user floating are respected;
  windows that open maximized are tiled once.
- Validated configuration: settings dialog, JSON overrides per screen/desktop/activity, ordered window rules.
- Saved layout preferences through the optional `plastile-state` D-Bus helper.
- *Explain active window*, counters and a bounded trace for troubleshooting.
- Plastile Motion: an optional KWin effect, off by default, that animates window movement.
- Experimental, opt-in scrolling and zones layouts.
- Licensed under GPL-3.0-or-later.
