# Environment profile (T00)

Collected 2026-10-17 with `python3 tools/collect_environment.py --publish docs/status/evidence/environment.json`. The collector is read-only: package database, `/proc`, `kscreen-doctor -j`, KWin D-Bus getters, and config-file reads. It loads nothing into the live compositor. The redacted machine-readable profile is [evidence/environment.json](evidence/environment.json). Raw output stays in `artifacts/environment/` (gitignored).

## Reference machine

| Item | Value |
|---|---|
| OS / kernel | Arch Linux (rolling), Linux 7.2.9-arch1-1 |
| CPU / RAM | AMD Ryzen 5 5600X (12 logical CPUs), 31.2 GiB; governor `powersave`, EPP `balance_performance` |
| GPU / driver | AMD Radeon RX 9070 XT (Navi 48, radeonsi gfx1201), Mesa 26.2.4, OpenGL 4.6 core, EGL |
| Session | Plasma 6 **Wayland** (`XDG_SESSION_TYPE=wayland`), KWin compositing type OpenGL |
| KWin / Plasma | `kwin 6.7.5-3`, `plasma-workspace 6.7.5-3`, `breeze 6.7.5-1`, `kdecoration 6.7.5-1` |
| Qt / KF | Qt 6.12.0 (`qt6-base 6.12.0-2`, `qt6-declarative 6.12.0-1`, `qt6-wayland 6.12.0-1`); KF 6.30.0 |
| XWayland | `xorg-xwayland 24.1.14-1` (live session runs KWin with `--xwayland`) |
| Wayland | `wayland 1.26.0`, `wayland-protocols 1.49` |
| Build/test tools | Node 26.11.1, npm 12.2.0, **no TypeScript compiler installed**, CMake 4.4.4, GCC 16.2.1, Clang 23.1.1, Python 3.14.8 with `python-dbus` 1.5.0 |
| Not installed | weston, cage, gamescope, wlr-randr, perf, valgrind |

### Live outputs (physical session; read-only)

| Connector | Position | Mode | Scale | VRR | Notes |
|---|---|---|---|---|---|
| DP-1 | 0,0 | 1920×1080 @ 60 Hz | 1 | incapable | priority 3 |
| HDMI-A-1 | 1920,0 | 2560×1440 @ 144 Hz | 1 | incapable | priority 1 (primary) |
| DP-2 | 4480,0 | 1920×1080 @ 100 Hz | 1 | incapable | priority 2 |

Mixed refresh rates (60/100/144 Hz) on one session; no fractional scaling and no VRR on this machine. Mixed-scale and VRR validation therefore require nested scale settings or another machine.

### Live KWin configuration relevant to tiling

- 6 virtual desktops in 1 row; `perOutputVirtualDesktops=false`; `separateScreenFocus=true`; focus policy click-to-focus.
- One activity, with the Activities service available.
- 63 native `[Tiling]` sections in `kwinrc`, each padding 4 with the default three-column layout. KWin's native tile editor is bound to **Meta+T**. The `kwin` component has 33 Meta-based bindings.
- Decoration: `org.kde.kwin.aurorae.v2`.
- Installed KWin scripts are only the distribution defaults. No third-party tiler is installed or enabled, and there are no window rules.
- Loaded effects (30) include `slide`, `overview`, `windowview`, `tileseditor`, `maximize`, `squash`, `fullscreen` and `blur`; the full list is in the JSON profile.
- `/usr/bin/kwin_wayland` has file capability `cap_sys_nice=ep`. The process is therefore non-dumpable, and its `/proc/<pid>/fd` cannot be read by the same user. Probes report fd counts as unavailable.

## Source and version references

| Ref | Meaning | Evidence |
|---|---|---|
| KDE/kwin tag `v6.7.5` → commit [`ab7df7cc`](https://github.com/KDE/kwin/commit/ab7df7ccb7c6af20f4b279cd6220f7cd3d2267d7) | **Installed build** | Installed `/usr/include/kwin/window.h`, `workspace.h`, `xdgshellwindow.h`, `virtualdesktops.h`, `core/output.h` are identical (modulo trailing whitespace) to this tag |
| Plasma/6.7 [`717f774e`](https://github.com/KDE/kwin/commit/717f774ec8db995c53a086d334ce89d118d8b80d) | Original research pin (K67) | Same version string `6.7.5`, but it differs from the tag in `src/scripting/scripting.{h,cpp}` (singleton plumbing), `src/window.{h,cpp}` (`takesAsyncFocus` declaration), and `src/xdgshellwindow.cpp` (sandbox app-id override). `src/tiles/` and `src/scripting/workspace_wrapper.*` do not differ. |

**Conclusion:** the K67 research evidence for the script-visible window, workspace and tile surface applies to the installed build. The scripting and xdg differences between the pins do not change script-visible APIs. The original pins are retained; the new tag pin is recorded here rather than replacing them.

Codeberg refresh (E02) has not been attempted in this session.

## Test layers available on this machine

| Layer | Available | How |
|---|---|---|
| Pure core (Node) | yes, once TypeScript is pinned as a dev dependency | `npm` |
| Nested KWin 6.7.5 (virtual backend) | **yes, verified** | `tools/nested.py`: private `dbus-daemon`, private `XDG_RUNTIME_DIR/CONFIG/DATA/CACHE/STATE`, `kwin_wayland --virtual`, 1–N virtual outputs, software 60 Hz timeline, OpenGL on the real GPU |
| Nested XWayland | probably (`--xwayland` flag wired, not yet exercised) | `NestedKwin(xwayland=True)` |
| Physical session | the user's active Wayland session | **Not used by any probe.** Requires an explicit user decision; see [STATUS](STATUS.md) |

The nested session is fully isolated. Its D-Bus, runtime directory and configuration are private, and nothing is written to the user's kwinrc, journal or kglobalshortcutsrc. QML log output is forced to the session's own stderr with `QT_FORCE_STDERR_LOGGING=1`; without it, Qt routes script logs to the user journal. A nested session cannot establish physical scanout or input latency.

## Second environment: Ubuntu 26.10 KWin sandbox (cloud container)

Added 2026-10-18 to validate the implementation on a second, independently packaged KWin build and to
run the nested suite in CI. Profile: [evidence/environment-ubuntu2610-sandbox.json](evidence/environment-ubuntu2610-sandbox.json),
collected with `tools/collect_environment.py` against a nested session's private bus inside the sandbox.

| Item | Value |
|---|---|
| Host | Cloud container (Ubuntu 24.04 userland, Linux 6.18.44), 4 vCPU Intel Xeon @ 2.10 GHz, 15.7 GiB RAM, **no GPU** (no `/dev/dri`) |
| Sandbox | Ubuntu 26.10 "stonking" chroot built by [tools/sandbox/create.sh](../../tools/sandbox/create.sh) |
| KWin | `kwin-wayland 4:6.7.5-0ubuntu1` (same upstream release as the Arch build, tag `v6.7.5`), `kwin-style-breeze 4:6.7.5` |
| Qt / KF | Qt **6.11.2** (Arch: 6.12.0); KF **6.29.0** (Arch: 6.30.0) |
| Other | Xwayland 24.1.14, Wayland 1.26.0, wayland-protocols 1.49, kactivitymanagerd 6.7.5, Node 26.11.1, Python 3.14.7 |
| Compositing | **QPainter**: KWin's virtual backend finds no DRM render node, so GL-only effects (tile editor, blur) never load |
| Layer | Nested KWin virtual backend only (1280×800 virtual outputs, synthetic 60 Hz timeline). No physical session exists here |

What this environment changed in the evidence (details in [STATUS](STATUS.md)):

- It reproduced the same set of known product defects as the Arch runs, and found one new engine defect
  (fractional-scale tolerance, G03) that the GPU machine's timing had hidden. It is now fixed.
- QPainter compositing means scenarios that need GL effects report `SKIP` here (`native-editor-toggle-L14`).
- Timing numbers from this machine (software rendering, shared vCPUs) are not comparable with the Arch
  reference machine and are not used for the performance tables.
