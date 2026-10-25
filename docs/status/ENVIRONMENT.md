# Environment profile (T00)

Collected 2026-10-17 with `python3 tools/collect_environment.py --publish docs/status/evidence/environment.json`. The collector is read-only: package database, `/proc`, `kscreen-doctor -j`, KWin D-Bus getters, and config-file reads. It loads nothing into the live compositor. The redacted machine-readable profile is [evidence/environment.json](evidence/environment.json). Raw output stays in `artifacts/environment/` (gitignored).

## Reference machine

| Item | Value |
|---|---|
| OS / kernel | Arch Linux (rolling), Linux 7.2.9-arch1-1 |
| CPU / RAM | AMD Ryzen 5 5600X (12 logical CPUs), 31.2 GiB; governor `powersave`, EPP `balance_performance` |
| GPU / driver | AMD Radeon RX 9070 XT (Navi 48, radeonsi gfx1201), Mesa 26.2.4, OpenGL 4.6 core, EGL |
| Session | Plasma 6 **Wayland** (`XDG_SESSION_TYPE=wayland`), KWin compositing type OpenGL |
| KWin / Plasma | `kwin 6.7.5-3`, `plasma-workspace 6.7.5-3`, `breeze 6.7.5-1`, `kdecoration 6.7.5-1`. **Updated 2026-10-25** to `kwin 6.8.1`, `plasma-workspace 6.8.1-1`, KF 6.31.0 (Qt 6.12.0): results from that date on are 6.8.1 and say so |
| Qt / KF | Qt 6.12.0 (`qt6-base 6.12.0-2`, `qt6-declarative 6.12.0-1`, `qt6-wayland 6.12.0-1`); KF 6.30.0 |
| XWayland | `xorg-xwayland 24.1.14-1` (live session runs KWin with `--xwayland`) |
| Wayland | `wayland 1.26.0`, `wayland-protocols 1.49` |
| Build/test tools | Node 26.11.1, npm 12.2.0, CMake 4.4.4, GCC 16.2.1, Clang 23.1.1, Python 3.14.8 with `python-dbus` 1.5.0. No system TypeScript; the repository pins `typescript` 6.0.3, `esbuild` 0.28.2 and `@types/node` 26.6.5 as dev dependencies (`package.json`, `package-lock.json`), installed with `npm ci` |
| Test-only helpers | `libei 1.6.0-1` (input injector [tools/input](../../tools/input)), `kactivitymanagerd 6.7.5-1` (activities scenarios); versions from `pacman -Q`, 2026-10-18 |
| Not installed | weston, cage, gamescope, wlr-randr, perf, valgrind, Nix |

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

The Codeberg refresh (E02) was done on 2026-10-17. Its results are recorded in [CODEBERG_ADDENDUM.md](../research/CODEBERG_ADDENDUM.md), and the original pins are retained.

## Test layers available on this machine

| Layer | Available | How |
|---|---|---|
| Pure core (Node) | **yes** | `npm ci`, then `npm run typecheck` and `npm test` (Node's built-in test runner over `tests/core/*.test.ts`) |
| Nested KWin 6.7.5 (virtual backend) | **yes, verified** | `tools/nested.py`: private `dbus-daemon`, private `XDG_RUNTIME_DIR/CONFIG/DATA/CACHE/STATE`, `kwin_wayland --virtual`, 1–N virtual outputs, software 60 Hz timeline, OpenGL on the real GPU |
| Nested XWayland | **yes, verified** | `NestedKwin(xwayland=True)`. The six `xwayland-*-G10` scenarios pass nested with `xorg-xwayland 24.1.14-1` and the xcb fixture ([evidence/xwayland-g10.json](evidence/xwayland-g10.json)). The X11 `realapps-*-x11*` scenarios also use it |
| Real input in nested KWin | **yes, verified** | `build/input/plastile-input` (built from [tools/input](../../tools/input) with `make -C tools/input`) is a libei client. It takes the EIS socket from `org.kde.KWin.EIS.RemoteDesktop.connectToEIS` on the nested session's private bus and drives KWin's real pointer and keyboard pipeline (scenarios `drag-*`, `resize-*`, `live-resize-T29`, `shortcuts-defaults-real-input`). It is never connected to the user's session |
| Activities service in nested KWin | **yes, verified** | A private `kactivitymanagerd` on the nested bus only (`activities-*-E08`). Scenarios skip when it is not found |
| Ubuntu 26.10 sandbox (KWin 6.7.5, QPainter) | yes, on hosts with `debootstrap` and root | [tools/sandbox](../../tools/sandbox/README.md); see below. Also the CI `integration-nested` job |
| Nix KWin 6.8.0 environment | **not on this machine** (Nix is not installed) | [tools/sandbox/nix](../../tools/sandbox/nix/README.md), run only in the CI `integration-nested-kwin68` job; see below |
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
| Other | Xwayland 24.1.14, Wayland 1.26.0, wayland-protocols 1.49, kactivitymanagerd 6.7.5, Node 26.11.1, Python 3.14.7; `libei-dev` for the input injector ([packages.txt](../../tools/sandbox/packages.txt); its version is not in the profile) |
| Compositing | **QPainter**: KWin's virtual backend finds no DRM render node, so GL-only effects (tile editor, blur) never load |
| Layer | Nested KWin virtual backend only (1280×800 virtual outputs, synthetic 60 Hz timeline). No physical session exists here |

What this environment changed in the evidence (details in [STATUS](STATUS.md)):

- It reproduced the same set of known product defects as the Arch runs, and found one new engine defect
  (fractional-scale tolerance, G03) that the GPU machine's timing had hidden. It is now fixed.
- QPainter compositing means scenarios that need GL effects report `SKIP` here (`native-editor-toggle-L14`).
- Timing numbers from this machine (software rendering, shared vCPUs) are not comparable with the Arch
  reference machine and are not used for the performance tables.

## Third environment: pinned Nix KWin 6.8.0 (CI only)

Added 2026-10-18 to run the same nested suite against a second KWin API family. [tools/sandbox/nix/env.nix](../../tools/sandbox/nix/env.nix) pins one nixos-unstable channel release by URL and hash, and [run.sh](../../tools/sandbox/nix/run.sh) runs a command with only that environment on `PATH`. Nix is not installed on the reference machine, so this environment has run only in the CI job `integration-nested-kwin68`, which is marked provisional (`continue-on-error: true`). No environment profile JSON has been collected for it.

| Item | Value |
|---|---|
| Pin | `nixos-26.11pre1093333.fe13242281a6` (nixpkgs commit `fe13242281a67641c0102cdb1087f0ebe586c7df`) |
| KWin | `kdePackages.kwin` **6.8.0** |
| Qt / KF | Qt **6.11.2**; KF **6.30.0** |
| Other | Mesa 26.2.5, Xwayland 24.1.14, Breeze, kactivitymanagerd, Python 3 with dbus-python (versions from the [Nix README](../../tools/sandbox/nix/README.md); a build writes its exact versions to `plastile/versions`) |
| Host | GitHub-hosted `ubuntu-latest` runner, Nix 2.33.0 single-user install (`ci.yml`) |
| Compositing | **OpenGL ES via llvmpipe.** KWin 6.8 has no QPainter compositor. Without a DRM render node or `/dev/udmabuf`, `kwin_wayland` preloads [udmabuf-shim.c](../../tools/sandbox/nix/udmabuf-shim.c), which emulates the udmabuf ioctls with sealed memfds. KWin's code is unmodified. Buffers have no implicit fences |
| Layer | Nested KWin virtual backend only. The fixtures and the libei injector are built on the runner host and connect to this KWin |

Timing from this environment (software rendering, emulated udmabuf, shared runner) is not comparable with the reference machine and is not used for performance claims. GL-only effects such as the tile editor do load here, unlike in the QPainter sandbox.
