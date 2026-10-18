#!/bin/bash
# Run a command with the pinned KWin 6.8 environment from tools/sandbox/nix/env.nix.
#
#   tools/sandbox/nix/run.sh [--apps] [--] COMMAND [ARGS...]
#
# Builds (or reuses) the environment with nix-build, then runs COMMAND in the current
# directory with an empty environment plus only what that environment needs: PATH holds
# the environment's bin/ and libexec/ and nothing from the host, Qt plugins, QML modules,
# XDG data/config directories, fontconfig and the graphics loaders point into it, and only
# proxy settings, CA bundle paths, KWIN_COMPOSE and PLASTILE_* variables pass in.
# Session variables such as DBUS_SESSION_BUS_ADDRESS or
# WAYLAND_DISPLAY cannot reach the command. Example:
#
#   tools/sandbox/nix/run.sh -- python3 tests/integration/run.py --only adopt-open-close
#
# Nothing here touches a running desktop session: tests start their own
# `kwin_wayland --virtual` on a private D-Bus (tools/nested.py).
#
# PLASTILE_NIX_ENV=/nix/store/...-plastile-kwin68-env skips nix-build and uses that path.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
APPS=false
while [ $# -gt 0 ]; do
  case "$1" in
    --apps) APPS=true; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done

ENV_PATH=${PLASTILE_NIX_ENV:-}
if [ -z "$ENV_PATH" ]; then
  NIX_BUILD=$(command -v nix-build || echo /nix/var/nix/profiles/default/bin/nix-build)
  [ -x "$NIX_BUILD" ] || { echo "run.sh: nix-build not found (see tools/sandbox/nix/README.md)" >&2; exit 2; }
  LINK="$REPO/build/nix/kwin68-env"
  [ "$APPS" = false ] || LINK="$LINK-apps"
  mkdir -p "$(dirname "$LINK")"
  # The out-link is a GC root, so the environment survives nix-collect-garbage.
  NIX_SSL_CERT_FILE=${NIX_SSL_CERT_FILE:-${SSL_CERT_FILE:-}} \
    "$NIX_BUILD" "$HERE/env.nix" --arg withApps "$APPS" -o "$LINK" >/dev/null
  ENV_PATH=$(readlink -f "$LINK")
fi
[ -x "$ENV_PATH/bin/kwin_wayland" ] || { echo "run.sh: $ENV_PATH has no bin/kwin_wayland" >&2; exit 2; }

# Start from an empty environment; pass proxy settings, CA bundles, Plastile's own test
# knobs (PLASTILE_*, e.g. PLASTILE_UDMABUF_SHIM) and KWIN_COMPOSE (KWin 6.8 has no
# QPainter compositor, so only OpenGL values make sense; see README.md).
pass=()
for v in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy KWIN_COMPOSE \
         SSL_CERT_FILE NIX_SSL_CERT_FILE NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE; do
  [ -z "${!v:-}" ] || pass+=("$v=${!v}")
done
while IFS= read -r v; do
  [ "$v" = PLASTILE_NIX_ENV ] || pass+=("$v=${!v}")
done < <(compgen -e | grep '^PLASTILE_' || true)

# KWin's XWayland support needs the system X socket directory and does not create it
# ("/tmp/.X11-unix does not exist"); systemd-tmpfiles or x11-common normally do.
if [ ! -d /tmp/.X11-unix ]; then
  if [ "$(id -u)" = 0 ]; then
    mkdir -p -m 1777 /tmp/.X11-unix
  else
    echo "run.sh: /tmp/.X11-unix is missing; XWayland scenarios will fail (create it as root, mode 1777)" >&2
  fi
fi

# Graphics loaders: Nix-built programs find no driver on non-NixOS hosts unless told where
# the environment's Mesa is (EGL via glvnd, DRI/GBM backends, Vulkan ICDs).
vk=$(printf '%s:' "$ENV_PATH"/share/vulkan/icd.d/*.json)
pass+=("VK_DRIVER_FILES=${vk%:}")

[ $# -gt 0 ] || set -- bash
exec /usr/bin/env -i \
  LANG=C.UTF-8 HOME="${HOME:-/root}" TERM="${TERM:-dumb}" \
  PATH="$ENV_PATH/bin:$ENV_PATH/libexec" \
  PLASTILE_NIX_ENV="$ENV_PATH" \
  QT_PLUGIN_PATH="$ENV_PATH/lib/qt-6/plugins" \
  QML_IMPORT_PATH="$ENV_PATH/lib/qt-6/qml" \
  QML2_IMPORT_PATH="$ENV_PATH/lib/qt-6/qml" \
  XDG_DATA_DIRS="$ENV_PATH/share" \
  XDG_CONFIG_DIRS="$ENV_PATH/etc/xdg" \
  FONTCONFIG_FILE="$ENV_PATH/plastile/fonts.conf" \
  __EGL_VENDOR_LIBRARY_DIRS="$ENV_PATH/share/glvnd/egl_vendor.d" \
  LIBGL_DRIVERS_PATH="$ENV_PATH/lib/dri" \
  GBM_BACKENDS_PATH="$ENV_PATH/lib/gbm" \
  "${pass[@]}" \
  "$@"
