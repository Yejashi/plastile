# Disposable KWin sandbox

A reproducible second test environment: an Ubuntu chroot with distribution KWin packages, used to run
the nested integration suite (`tests/integration/run.py`) on machines without Plasma, including the
GitHub-hosted runner (`integration-nested` job in [ci.yml](../../.github/workflows/ci.yml)).

Every test still starts its own `kwin_wayland --virtual` on a private D-Bus through
[nested.py](../nested.py). The sandbox never connects to, replaces or restarts a running desktop
session, and `run.sh` starts commands with an empty environment (only proxy settings and the CA
bundles they reference are passed in), so session variables such as `DBUS_SESSION_BUS_ADDRESS` or
`WAYLAND_DISPLAY` cannot leak into it.

## Use

```sh
sudo apt-get install debootstrap curl          # host requirements (Debian/Ubuntu host)
sudo tools/sandbox/create.sh                   # /opt/plastile-kwin-sandbox, Ubuntu 26.10 "stonking"
sudo tools/sandbox/run.sh -- bash -euc 'npm ci && npm run build && make -C fixtures/client &&
  make -C fixtures/xclient && make -C tools/input'
sudo tools/sandbox/run.sh -- python3 tests/integration/run.py
sudo tools/sandbox/run.sh --umount             # release the bind mounts
```

`run.sh` bind-mounts the repository at the same absolute path and runs the command in the current
directory, so build outputs and `artifacts/` paths are identical inside and outside. Builds made inside
the sandbox link against the sandbox's libraries; rebuild on the host before running fixtures there.

| Variable | Default | Effect |
|---|---|---|
| `PLASTILE_SANDBOX` | `/opt/plastile-kwin-sandbox` | Sandbox root used by `run.sh` |
| `PLASTILE_SANDBOX_MIRROR` | `http://archive.ubuntu.com/ubuntu` | Ubuntu mirror for `create.sh` |
| `PLASTILE_SANDBOX_NODE` / `_NPM` | `26.11.1` / `12.2.0` | Node and npm from the npm registry (`node-linux-x64`, `npm`) |
| `PLASTILE_SANDBOX_APPS` | `1` | `0` skips the optional real applications in [packages-apps.txt](packages-apps.txt) |
| `KWIN_COMPOSE` | unset | Passed through; KWin falls back to QPainter when there is no DRM render node |

Package list: [packages.txt](packages.txt). It installs `kwin-common` explicitly: it carries KWin's
`KWin/Script` kpackage structure, without which `kpackagetool6` rejects the package as
`Invalid metadata for package structure "KWin/Script"`.

## What this environment can and cannot show

- Real KWin script-API behavior, signal ordering, window lifecycle, xdg configure/commit timing with the
  controlled fixture clients, XWayland clients, kscreen-doctor output changes, and package install.
- Without a GPU there is no DRM render node, so KWin composites with QPainter and GL-only effects
  (the tile editor, blur) never load. Scenarios that need them report `SKIP` with the reason.
- Nothing here is a physical-session result: no real outputs, no input-to-photon latency, and the
  virtual output's 60 Hz presentation timeline is synthetic.
