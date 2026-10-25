#!/bin/sh
# Plastile package installer: a thin, non-invasive wrapper around kpackagetool6, plus the
# persistence helper (helper/, ADR-020), which is built from source with CMake.
#
#   tools/install.sh install [SOURCE]   install the package (default SOURCE: package/) and
#                                       the Plastile Motion effect, which stays disabled
#   tools/install.sh upgrade [SOURCE]   replace an installed package (and the effect) in place
#   tools/install.sh remove             uninstall the package and the effect
#   tools/install.sh install-effect     install or replace only the effect
#   tools/install.sh remove-effect      uninstall only the effect
#   tools/install.sh install-helper     build and install the persistence helper and its
#                                       D-Bus activation file (also replaces an older one)
#   tools/install.sh remove-helper      uninstall the persistence helper
#   tools/install.sh status             show what is installed and whether it is enabled
#
# SOURCE is the repository's package/ directory or a dist/plastile-<version>.kwinscript
# zip built by tools/release.py. install/upgrade refuse to run unless the runtime
# bundle (contents/code/plastile.mjs) is present in SOURCE. Without the helper Plastile
# works and keeps its layout preferences in memory only.
#
# The effect (effect/, a KWin/Effect package with id plastile_motion) animates how windows
# look while they move to a new frame; Plastile itself never animates. It is installed
# disabled: KWin loads it only after it is turned on in System Settings > Desktop Effects.
# Its source is $PLASTILE_EFFECT_SOURCE (a directory or a dist/plastile_motion-<version>.zip),
# default the repository's effect/ directory.
#
# The helper goes to $PLASTILE_HELPER_PREFIX/libexec/plastile-state (default ~/.local)
# and its activation file to $XDG_DATA_HOME/dbus-1/services (default ~/.local/share),
# where the session bus finds it. Building needs cmake, a C++17 compiler and the Qt 6
# Core and DBus development files; the build directory is $PLASTILE_HELPER_BUILD
# (default build/helper-install).
#
# This script never starts, stops, restarts, reloads or reconfigures the compositor
# and never writes kwinrc. It only prints how to enable the script afterwards.
# It honours XDG_DATA_HOME (and the rest of the XDG environment) so a test can
# target a nested session's private data directory instead of the user's home.
set -eu

PLUGIN=plastile
TYPE=KWin/Script
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
DEFAULT_SOURCE=$ROOT/package
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
TARGET=$DATA_HOME/kwin/scripts/$PLUGIN
KPT=${KPACKAGETOOL6:-kpackagetool6}
HELPER_SOURCE=$ROOT/helper
HELPER_PREFIX=${PLASTILE_HELPER_PREFIX:-$HOME/.local}
HELPER_BUILD=${PLASTILE_HELPER_BUILD:-$ROOT/build/helper-install}
SERVICE_NAME=org.kde.plastile.State
SERVICE_FILE=$DATA_HOME/dbus-1/services/$SERVICE_NAME.service
STATE_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/plastile
EFFECT=plastile_motion
EFFECT_TYPE=KWin/Effect
EFFECT_TARGET=$DATA_HOME/kwin/effects/$EFFECT
EFFECT_SOURCE=${PLASTILE_EFFECT_SOURCE:-$ROOT/effect}

usage() {
    sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
    printf 'install.sh: %s\n' "$1" >&2
    exit "${2:-1}"
}

need_tool() {
    command -v "$KPT" >/dev/null 2>&1 || die "$KPT not found in PATH (install the KDE Frameworks 'kpackage' tools)" 127
}

# Refuse to ship a package without the compiled runtime bundle.
check_bundle() {
    src=$1
    if [ -d "$src" ]; then
        [ -f "$src/metadata.json" ] || die "$src has no metadata.json; not a KWin script package"
        [ -f "$src/contents/code/plastile.mjs" ] || die "$src/contents/code/plastile.mjs is missing: run npm run build"
    elif [ -f "$src" ]; then
        if command -v unzip >/dev/null 2>&1; then
            listing=$(unzip -Z1 "$src" 2>/dev/null) || die "$src is not a readable zip archive"
        elif command -v python3 >/dev/null 2>&1; then
            listing=$(python3 -I -c 'import sys, zipfile; print("\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))' "$src") \
                || die "$src is not a readable zip archive"
        else
            die "cannot inspect $src: neither unzip nor python3 is available"
        fi
        printf '%s\n' "$listing" | grep -qx 'metadata.json' || die "$src has no metadata.json at the zip root"
        printf '%s\n' "$listing" | grep -qx 'contents/code/plastile.mjs' || die "$src lacks contents/code/plastile.mjs: run npm run build, then tools/release.py"
    else
        die "source $src does not exist"
    fi
}

# The entries of a zip archive, one per line.
zip_listing() {
    if command -v unzip >/dev/null 2>&1; then
        unzip -Z1 "$1" 2>/dev/null
    elif command -v python3 >/dev/null 2>&1; then
        python3 -I -c 'import sys, zipfile; print("\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))' "$1"
    else
        return 1
    fi
}

# Whether $EFFECT_SOURCE holds the effect package (metadata.json and contents/code/main.js).
check_effect_source() {
    esrc=$EFFECT_SOURCE
    if [ -d "$esrc" ]; then
        [ -f "$esrc/metadata.json" ] && [ -f "$esrc/contents/code/main.js" ] \
            || die "$esrc is not the Plastile Motion effect package (metadata.json, contents/code/main.js)"
    elif [ -f "$esrc" ]; then
        elisting=$(zip_listing "$esrc") || die "$esrc is not a readable zip archive"
        printf '%s\n' "$elisting" | grep -qx 'metadata.json' || die "$esrc has no metadata.json at the zip root"
        printf '%s\n' "$elisting" | grep -qx 'contents/code/main.js' || die "$esrc lacks contents/code/main.js"
    else
        die "effect source $esrc does not exist (set PLASTILE_EFFECT_SOURCE)"
    fi
}

# Install the effect; an installed one is replaced ($1 = upgrade) or left as it is ($1 = keep).
put_effect() {
    check_effect_source
    if [ -e "$EFFECT_TARGET" ]; then
        if [ "$1" = keep ]; then
            printf '\nEffect: %s is already installed and was left as it is (upgrade replaces it).\n' "$EFFECT_TARGET"
            return 0
        fi
        "$KPT" --type "$EFFECT_TYPE" --upgrade "$EFFECT_SOURCE" || die "upgrading the effect failed"
    else
        "$KPT" --type "$EFFECT_TYPE" --install "$EFFECT_SOURCE" || die "installing the effect failed"
    fi
    cat <<EOF

Effect installed to: $EFFECT_TARGET (disabled: nothing was enabled or loaded)
Plastile Motion animates how a window looks while it slides or resizes to the place Plastile
(or any program) gave it; the window itself is already there. To turn it on:

  System Settings > Window Management > Desktop Effects > tick "Plastile Motion" > Apply

or, from a terminal in the same session (KWin loads it when it sees the change):

  kwriteconfig6 --file kwinrc --group Plugins --key ${EFFECT}Enabled --notify true

To turn it off, untick it or run the same command with false. Animation speed "Instant"
(System Settings > General Behavior) also turns it off. This script prints these commands;
it does not execute them. A running KWin keeps an already loaded older version of the effect
until it is turned off and on again.
EOF
}

print_enable_help() {
    cat <<EOF

Installed to: $TARGET
Nothing was enabled, reloaded or restarted. KWin discovers packages when it (re)scans
kwin/scripts; a package installed while KWin is running may not be visible until the
script list is refreshed (log out and in). To enable Plastile, either:

  System Settings > Window Management > KWin Scripts > tick "Plastile" > Apply

or, from a terminal in the same session:

  kwriteconfig6 --file kwinrc --group Plugins --key ${PLUGIN}Enabled true
  qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start

To disable later, set the same key to false and run the same Scripting.start command.
This script prints these commands; it does not execute them.

Layout preferences (layouts, ratios, floated windows) are kept across restarts only with
the persistence helper: tools/install.sh install-helper. Without it they last until
KWin restarts or the script reloads.
EOF
}

# The executable a D-Bus activation file starts (empty when there is no file).
service_exec() {
    [ -f "$1" ] && sed -n 's/^Exec=//p' "$1" | head -n 1 || true
}

# Ask the session bus to re-read its service files (org.freedesktop.DBus.ReloadConfig), for a
# bus that does not notice a new file by itself. Only the bus is asked; nothing is restarted.
reload_bus() {
    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
        printf 'No session bus in this environment: the activation file is read at the next login.\n'
    elif command -v dbus-send >/dev/null 2>&1 \
        && dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
            org.freedesktop.DBus.ReloadConfig >/dev/null 2>&1; then
        printf 'The session bus re-read its service files.\n'
    else
        printf 'Could not ask the session bus to re-read its service files: log out and in if Plastile\nreports the helper as unavailable.\n'
    fi
}

cmd_install_helper() {
    for tool in cmake; do
        command -v "$tool" >/dev/null 2>&1 || die "$tool not found (building the helper needs cmake, a C++17 compiler and the Qt 6 Core and DBus development files)" 127
    done
    [ -f "$HELPER_SOURCE/CMakeLists.txt" ] || die "$HELPER_SOURCE/CMakeLists.txt is missing"
    cmake -S "$HELPER_SOURCE" -B "$HELPER_BUILD" -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$HELPER_PREFIX" -DCMAKE_INSTALL_LIBEXECDIR=libexec \
        -DPLASTILE_DBUS_SERVICE_DIR="$DATA_HOME/dbus-1/services" >/dev/null \
        || die "configuring the helper failed (are the Qt 6 Core and DBus development files installed?)"
    cmake --build "$HELPER_BUILD" >/dev/null || die "building the helper failed"
    cmake --install "$HELPER_BUILD" >/dev/null || die "installing the helper failed"
    exe=$(service_exec "$SERVICE_FILE")
    [ -x "$exe" ] || die "installed, but $SERVICE_FILE does not name an executable helper ($exe)"
    reload_bus
    cat <<EOF

Installed: $exe
Activation file: $SERVICE_FILE
The session bus starts the helper when Plastile first asks for it (when the script starts
or reloads); nothing is running now. A Plastile that already runs without it keeps its
preferences in memory until the script is reloaded or KWin restarts.
Saved state: $STATE_DIR
EOF
}

cmd_remove_helper() {
    [ -f "$SERVICE_FILE" ] || die "$SERVICE_FILE is not installed" 2
    exe=$(service_exec "$SERVICE_FILE")
    rm -f "$SERVICE_FILE"
    case "$exe" in
        */plastile-state) rm -f "$exe" ;;
        *) printf 'install.sh: %s named %s, which was left alone\n' "$SERVICE_FILE" "$exe" >&2; exe= ;;
    esac
    reload_bus
    cat <<EOF

Removed: $SERVICE_FILE${exe:+ and $exe}
A helper that is running keeps serving this session until KWin exits (a logout). Plastile
then keeps its preferences in memory from its next start. The saved state in $STATE_DIR was left as it
is; delete that directory to forget it.
EOF
}

cmd_install() {
    src=${1:-$DEFAULT_SOURCE}
    need_tool
    check_bundle "$src"
    check_effect_source
    if [ -e "$TARGET" ]; then
        die "$TARGET already exists; use 'upgrade' to replace it" 4
    fi
    "$KPT" --type "$TYPE" --install "$src"
    print_enable_help
    put_effect keep
}

cmd_upgrade() {
    src=${1:-$DEFAULT_SOURCE}
    need_tool
    check_bundle "$src"
    check_effect_source
    "$KPT" --type "$TYPE" --upgrade "$src"
    cat <<EOF

Upgraded: $TARGET
A running KWin keeps executing the previously loaded version until KWin itself restarts:
log out and back in. Disabling and re-enabling the script (System Settings > Window
Management > KWin Scripts, or kwriteconfig6 + Scripting.start) is not enough: KWin 6.7.5
starts the older version again from its QML cache (measured in a nested session).
Settings in kwinrc and your shortcut bindings are kept. This script restarts nothing.
EOF
    put_effect upgrade
}

cmd_remove() {
    need_tool
    if [ ! -e "$TARGET" ] && [ ! -e "$EFFECT_TARGET" ]; then
        die "$TARGET is not installed" 2
    fi
    if [ -e "$TARGET" ]; then
        "$KPT" --type "$TYPE" --remove "$PLUGIN"
        cat <<EOF

Removed: $TARGET
The kwinrc [Plugins] ${PLUGIN}Enabled key and the [Script-${PLUGIN}] settings group were left
untouched (this script never writes kwinrc). A running KWin keeps the loaded script
until the session ends or the script is disabled.
EOF
    fi
    if [ -e "$EFFECT_TARGET" ]; then
        remove_effect
    fi
}

remove_effect() {
    "$KPT" --type "$EFFECT_TYPE" --remove "$EFFECT"
    cat <<EOF

Removed: $EFFECT_TARGET
The kwinrc [Plugins] ${EFFECT}Enabled key and the [Effect-${EFFECT}] group were left untouched.
A running KWin keeps a loaded effect until it is turned off or the session ends.
EOF
}

cmd_install_effect() {
    need_tool
    put_effect upgrade
}

cmd_remove_effect() {
    need_tool
    [ -e "$EFFECT_TARGET" ] || die "$EFFECT_TARGET is not installed" 2
    remove_effect
}

cmd_status() {
    need_tool
    printf 'data home : %s\n' "$DATA_HOME"
    printf 'target    : %s\n' "$TARGET"
    if [ -d "$TARGET" ]; then
        printf 'installed : yes\n'
        if [ -f "$TARGET/contents/code/plastile.mjs" ]; then
            printf 'bundle    : present (%s bytes)\n' "$(wc -c <"$TARGET/contents/code/plastile.mjs" | tr -d ' ')"
        else
            printf 'bundle    : MISSING (contents/code/plastile.mjs)\n'
        fi
        version=$(sed -n 's/.*"Version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TARGET/metadata.json" | head -n 1)
        printf 'version   : %s\n' "${version:-unknown}"
    else
        printf 'installed : no\n'
    fi
    kwinrc=${XDG_CONFIG_HOME:-$HOME/.config}/kwinrc
    enabled="unset"
    if [ -f "$kwinrc" ]; then
        # Read-only: print the [Plugins] plastileEnabled value if present.
        enabled=$(awk -v key="${PLUGIN}Enabled" '
            /^\[/ { in_plugins = ($0 == "[Plugins]") ; next }
            in_plugins && index($0, key "=") == 1 { sub(/^[^=]*=/, ""); print; exit }
        ' "$kwinrc")
        [ -n "$enabled" ] || enabled="unset"
    fi
    printf 'enabled   : %s (kwinrc [Plugins] %sEnabled)\n' "$enabled" "$PLUGIN"
    exe=$(service_exec "$SERVICE_FILE")
    if [ -z "$exe" ]; then
        printf 'helper    : not installed (no %s): preferences are kept in memory only\n' "$SERVICE_FILE"
    elif [ -x "$exe" ]; then
        printf 'helper    : installed (%s, started by the session bus)\n' "$exe"
    else
        printf 'helper    : BROKEN (%s names %s, which is not an executable)\n' "$SERVICE_FILE" "$exe"
    fi
    printf 'state     : %s\n' "$STATE_DIR"
    if [ -d "$EFFECT_TARGET" ]; then
        eversion=$(sed -n 's/.*"Version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$EFFECT_TARGET/metadata.json" | head -n 1)
        printf 'effect    : installed (%s, version %s)\n' "$EFFECT_TARGET" "${eversion:-unknown}"
    else
        printf 'effect    : not installed (%s)\n' "$EFFECT_TARGET"
    fi
    eenabled="unset (default: off)"
    if [ -f "$kwinrc" ]; then
        evalue=$(awk -v key="${EFFECT}Enabled" '
            /^\[/ { in_plugins = ($0 == "[Plugins]") ; next }
            in_plugins && index($0, key "=") == 1 { sub(/^[^=]*=/, ""); print; exit }
        ' "$kwinrc")
        [ -z "$evalue" ] || eenabled=$evalue
    fi
    printf 'effect on : %s (kwinrc [Plugins] %sEnabled)\n' "$eenabled" "$EFFECT"
    printf 'kpackagetool6 --type %s --show %s:\n' "$TYPE" "$PLUGIN"
    "$KPT" --type "$TYPE" --show "$PLUGIN" 2>&1 | sed 's/^/  /' || true
}

case "${1:-}" in
    install) shift; cmd_install "$@" ;;
    upgrade) shift; cmd_upgrade "$@" ;;
    remove)  shift; cmd_remove ;;
    status)  shift; cmd_status ;;
    install-effect) shift; cmd_install_effect ;;
    remove-effect)  shift; cmd_remove_effect ;;
    install-helper) shift; cmd_install_helper ;;
    remove-helper)  shift; cmd_remove_helper ;;
    -h|--help|help) usage ;;
    "") usage >&2; exit 64 ;;
    *) die "unknown subcommand '$1' (install|upgrade|remove|install-effect|remove-effect|install-helper|remove-helper|status)" 64 ;;
esac
