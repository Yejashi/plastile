# Pinned KWin 6.8 environment (Nix)

A second KWin API family for the nested integration suite, next to the Ubuntu chroot in
[the parent directory](../README.md) (KWin 6.7.5). [env.nix](env.nix) pins one nixos-unstable
channel release by URL and hash and builds a single `buildEnv`:

| Component | Version (pin `nixos-26.11pre1093333.fe13242281a6`) |
|---|---|
| KWin (`kdePackages.kwin`) | 6.8.0 |
| Qt | 6.11.2 |
| KDE Frameworks | 6.30.0 |
| Mesa (llvmpipe, used for compositing here) | 26.2.5 |
| Xwayland | 24.1.14 |

It also carries Breeze (decoration plugin), kpackagetool6, kwriteconfig6, kscreen-doctor,
kactivitymanagerd, qdbus, dbus-daemon, busctl (systemd-minimal), Python 3 with dbus-python, git and
the coreutils the harness and `tools/install.sh` call. The exact versions of a build are written to
`plastile/versions` inside the environment.

Every test still starts its own `kwin_wayland --virtual` on a private D-Bus through
[nested.py](../../nested.py). Nothing here connects to, replaces or restarts a running desktop
session.

## Use

```sh
# host: Nix with nix-build (flakes not needed); root only to create /tmp/.X11-unix if missing
tools/sandbox/nix/run.sh -- kwin_wayland --version           # builds the environment on first use
npm ci && npm run build                                       # on the host
make -C fixtures/client && make -C fixtures/xclient && make -C tools/input   # on the host
tools/sandbox/nix/run.sh -- python3 tests/integration/run.py --markdown artifacts/kwin68-summary.md
tools/sandbox/nix/run.sh --apps -- python3 tests/integration/run.py --only realapps-kate
```

The fixture clients and the input injector are plain Wayland/X11/libei clients, so host builds work
against this KWin. `--apps` adds Konsole, Kate (with KWrite), Dolphin, foot, kdialog, xmessage and
xprop (mirrors [packages-apps.txt](../packages-apps.txt) plus the Ubuntu sandbox's kdialog and
x11-utils), so the `realapps-*` scenarios for them exist.

[run.sh](run.sh) runs `nix-build` with the out-link `build/nix/kwin68-env` (a GC root; `-apps` with
`--apps`) and then the command in the current directory with an empty environment plus:

| Variable | Value |
|---|---|
| `PATH` | the environment's `bin` and `libexec` only (no host directories) |
| `QT_PLUGIN_PATH`, `QML_IMPORT_PATH`, `QML2_IMPORT_PATH` | the environment's `lib/qt-6` (Breeze, KPackage structures, QML modules) |
| `XDG_DATA_DIRS`, `XDG_CONFIG_DIRS` | the environment's `share` and `etc/xdg` (also D-Bus service activation) |
| `FONTCONFIG_FILE` | DejaVu fonts |
| `__EGL_VENDOR_LIBRARY_DIRS`, `LIBGL_DRIVERS_PATH`, `GBM_BACKENDS_PATH`, `VK_DRIVER_FILES` | the environment's Mesa (Nix programs find no driver on other distributions otherwise) |
| passed through | proxy variables, CA bundle variables, `KWIN_COMPOSE`, every `PLASTILE_*` |

`PLASTILE_NIX_ENV=/nix/store/...-plastile-kwin68-env` skips `nix-build` and uses that environment.

## Host differences the environment absorbs

- **No render device.** KWin 6.8 removed QPainter compositing (`virtual_qpainter_backend.cpp` and the
  QPainter scene are gone in v6.8.0); the virtual backend supports only OpenGL and needs either a DRM
  render node or Mesa's software device, which KWin creates only when `/dev/udmabuf` opens (v6.8.0
  `src/core/gpumanager.cpp`). Without either it logs `Found no render device!` and quits. On such
  kernels the environment's `kwin_wayland` preloads [udmabuf-shim.c](udmabuf-shim.c), which emulates
  the udmabuf ioctls with duplicated sealed memfds, and KWin composites with llvmpipe (OpenGL ES).
  The KWin log then starts with `plastile-env: /dev/udmabuf emulated`. `PLASTILE_UDMABUF_SHIM=1`
  forces the shim, `=0` disables it. KWin's code is unmodified.
- **D-Bus.** nixpkgs' `dbus-daemon --session` reads `/etc/dbus-1/session.conf`, which only NixOS
  provides; the environment's `dbus-daemon` maps `--session` to its own copy of the upstream session
  configuration without host `/etc` includes.
- **`/tmp/.X11-unix`.** KWin does not create it; `run.sh` does (mode 1777) when run as root.

## What this environment can and cannot show

- Real KWin 6.8 script-API behavior, signal ordering, window lifecycle, XWayland, kscreen-doctor
  output changes and package install, with OpenGL compositing (so GL-only effects such as the tile
  editor load, unlike the QPainter runs on 6.7.5).
- The renderer is llvmpipe behind an emulated udmabuf: buffers have no implicit fences and
  `DMA_BUF_IOCTL_SYNC` is a no-op. Rendering and timing are not those of a GPU session.
- Nothing here is a physical-session result: no real outputs, no input-to-photon latency, and the
  virtual output's presentation timeline is synthetic.
