#!/bin/bash
# Run a command inside the disposable KWin sandbox created by tools/sandbox/create.sh.
#
#   sudo tools/sandbox/run.sh [--root DIR] [--no-bind] -- COMMAND [ARGS...]
#   sudo tools/sandbox/run.sh [--root DIR] --umount
#
# The repository containing the current directory is bind-mounted at the same
# absolute path, so build outputs, artifacts and report paths are identical inside
# and outside. Commands run in that same directory. Example:
#
#   sudo tools/sandbox/run.sh -- python3 tests/integration/run.py --only adopt-open-close
#
# Nothing here touches a running desktop session: tests start their own
# `kwin_wayland --virtual` on a private D-Bus (tools/nested.py).
set -euo pipefail
ROOT=${PLASTILE_SANDBOX:-/opt/plastile-kwin-sandbox}
BIND=1
UMOUNT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT=$2; shift 2 ;;
    --no-bind) BIND=0; shift ;;
    --umount) UMOUNT=1; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run.sh: must run as root (chroot)" >&2; exit 2; }
[ -d "$ROOT/usr" ] || { echo "run.sh: no sandbox at $ROOT (run tools/sandbox/create.sh)" >&2; exit 2; }

if [ "$UMOUNT" = 1 ]; then
  # Unmount in reverse depth order; tolerate already-unmounted paths.
  findmnt -rn -o TARGET | grep -F "$ROOT/" | sort -r | while read -r m; do umount "$m" || umount -l "$m"; done
  exit 0
fi

mounted() { mountpoint -q "$1"; }
for d in proc sys dev dev/pts dev/shm; do
  mkdir -p "$ROOT/$d"
  mounted "$ROOT/$d" || mount --bind "/$d" "$ROOT/$d"
done

WORK=$PWD
if [ "$BIND" = 1 ]; then
  REPO=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
  case "$REPO" in /|/proc*|/sys*|/dev*) echo "run.sh: refusing to bind $REPO" >&2; exit 2 ;; esac
  # A worktree inside an already bound repository is visible through that mount;
  # binding it again would only keep its directory busy after the worktree is removed.
  if [ ! -e "$ROOT$REPO/.git" ] && ! mounted "$ROOT$REPO"; then
    mkdir -p "$ROOT$REPO"
    mount --bind "$REPO" "$ROOT$REPO"
  fi
else
  WORK=/
fi

# Start from an empty environment: inheriting the caller's would leak session
# variables (DBUS_SESSION_BUS_ADDRESS, WAYLAND_DISPLAY, ...) into the sandbox.
# Only proxy settings, and CA bundles they need (bind-mounted read-only), pass.
pass=()
for v in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy KWIN_COMPOSE; do
  [ -z "${!v:-}" ] || pass+=("$v=${!v}")
done
for v in NODE_EXTRA_CA_CERTS SSL_CERT_FILE REQUESTS_CA_BUNDLE; do
  f=${!v:-}
  [ -n "$f" ] && [ -f "$f" ] || continue
  if ! findmnt -rn "$ROOT$f" >/dev/null; then
    mkdir -p "$ROOT$(dirname "$f")"
    [ -e "$ROOT$f" ] || touch "$ROOT$f"
    mount --bind -o ro "$f" "$ROOT$f"
  fi
  pass+=("$v=$f")
done

[ $# -gt 0 ] || set -- bash
# KWIN_COMPOSE is left to the caller: KWin falls back to QPainter when no render
# node exists, which disables GL-only effects (e.g. the tile editor).
exec chroot "$ROOT" /usr/bin/env -i -C "$WORK" \
  LANG=C.UTF-8 HOME=/root TERM="${TERM:-dumb}" \
  PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  "${pass[@]}" \
  "$@"
