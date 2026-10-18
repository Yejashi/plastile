#!/bin/bash
# Create a disposable Ubuntu chroot with KWin for nested Plastile tests.
#
#   sudo tools/sandbox/create.sh [TARGET_DIR] [SUITE]
#
# Defaults: TARGET_DIR=/opt/plastile-kwin-sandbox, SUITE=stonking (Ubuntu 26.10:
# KWin 6.7.5, Qt 6.11.2 on 2026-10-18). The chroot is only used to run
# `kwin_wayland --virtual` under a private D-Bus through tools/nested.py; it never
# connects to, replaces or restarts a running desktop session. Requires root,
# debootstrap, curl, and network access to archive.ubuntu.com and registry.npmjs.org.
# PLASTILE_SANDBOX_APPS=0 skips the optional real applications (packages-apps.txt).
set -euo pipefail
TARGET=${1:-/opt/plastile-kwin-sandbox}
SUITE=${2:-stonking}
MIRROR=${PLASTILE_SANDBOX_MIRROR:-http://archive.ubuntu.com/ubuntu}
NODE_VERSION=${PLASTILE_SANDBOX_NODE:-26.11.1}
NPM_VERSION=${PLASTILE_SANDBOX_NPM:-12.2.0}
HERE=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" = 0 ] || { echo "create.sh: must run as root (debootstrap/chroot)" >&2; exit 2; }
for tool in debootstrap curl; do
  command -v "$tool" >/dev/null || { echo "create.sh: $tool is required" >&2; exit 2; }
done

# Older debootstrap releases do not know newer Ubuntu codenames; every Ubuntu
# suite script is a symlink to "gutsy".
SCRIPTS=/usr/share/debootstrap/scripts
[ -e "$SCRIPTS/$SUITE" ] || ln -s gutsy "$SCRIPTS/$SUITE"

if [ ! -x "$TARGET/usr/bin/apt-get" ]; then
  debootstrap --variant=minbase --components=main,universe --include=ca-certificates \
    "$SUITE" "$TARGET" "$MIRROR"
fi
echo "deb $MIRROR $SUITE main universe" > "$TARGET/etc/apt/sources.list"
cp /etc/resolv.conf "$TARGET/etc/resolv.conf"
lists=("$HERE/packages.txt")
[ "${PLASTILE_SANDBOX_APPS:-1}" = 0 ] || lists+=("$HERE/packages-apps.txt")
cat "${lists[@]}" | grep -vE '^[[:space:]]*(#|$)' > "$TARGET/tmp/plastile-packages"

"$HERE/run.sh" --root "$TARGET" --no-bind -- bash -euc '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  xargs -a /tmp/plastile-packages apt-get install -y -qq --no-install-recommends
  git config --system --add safe.directory "*"
'

# Node is a build/test dependency only (ADR-002). The npm registry publishes the
# official Linux x64 binary as the node-linux-x64 package.
if [ "$("$TARGET/opt/node/bin/node" --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://registry.npmjs.org/node-linux-x64/-/node-linux-x64-$NODE_VERSION.tgz" -o "$tmp/node.tgz"
  rm -rf "$TARGET/opt/node"
  mkdir -p "$TARGET/opt/node"
  tar -xzf "$tmp/node.tgz" -C "$TARGET/opt/node" --strip-components=1
  rm -rf "$tmp"
fi
# npm from the same registry (the distribution's npm would pull in a second Node).
if [ ! -f "$TARGET/opt/npm/bin/npm-cli.js" ] || \
   [ "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$TARGET/opt/npm/package.json" | head -1)" != "$NPM_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://registry.npmjs.org/npm/-/npm-$NPM_VERSION.tgz" -o "$tmp/npm.tgz"
  rm -rf "$TARGET/opt/npm"
  mkdir -p "$TARGET/opt/npm"
  tar -xzf "$tmp/npm.tgz" -C "$TARGET/opt/npm" --strip-components=1
  rm -rf "$tmp"
fi
printf '#!/bin/sh\nexec /opt/node/bin/node /opt/npm/bin/npm-cli.js "$@"\n' > "$TARGET/usr/local/bin/npm"
chmod +x "$TARGET/usr/local/bin/npm"

"$HERE/run.sh" --root "$TARGET" --no-bind -- sh -c \
  'echo "sandbox ready: $(kwin_wayland --version), node $(node --version)"'
