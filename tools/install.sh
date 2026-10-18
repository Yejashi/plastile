#!/bin/sh
# Plastile package installer: a thin, non-invasive wrapper around kpackagetool6.
#
#   tools/install.sh install [SOURCE]   install the package (default SOURCE: package/)
#   tools/install.sh upgrade [SOURCE]   replace an installed package in place
#   tools/install.sh remove             uninstall the package
#   tools/install.sh status             show what is installed and whether it is enabled
#
# SOURCE is the repository's package/ directory or a dist/plastile-<version>.kwinscript
# zip built by tools/release.py. install/upgrade refuse to run unless the runtime
# bundle (contents/code/plastile.mjs) is present in SOURCE.
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

usage() {
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
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
EOF
}

cmd_install() {
    src=${1:-$DEFAULT_SOURCE}
    need_tool
    check_bundle "$src"
    if [ -e "$TARGET" ]; then
        die "$TARGET already exists; use 'upgrade' to replace it" 4
    fi
    "$KPT" --type "$TYPE" --install "$src"
    print_enable_help
}

cmd_upgrade() {
    src=${1:-$DEFAULT_SOURCE}
    need_tool
    check_bundle "$src"
    "$KPT" --type "$TYPE" --upgrade "$src"
    cat <<EOF

Upgraded: $TARGET
A running KWin keeps executing the previously loaded version until KWin itself restarts:
log out and back in. Disabling and re-enabling the script (System Settings > Window
Management > KWin Scripts, or kwriteconfig6 + Scripting.start) is not enough: KWin 6.7.5
starts the older version again from its QML cache (measured in a nested session).
Settings in kwinrc and your shortcut bindings are kept. This script restarts nothing.
EOF
}

cmd_remove() {
    need_tool
    if [ ! -e "$TARGET" ]; then
        die "$TARGET is not installed" 2
    fi
    "$KPT" --type "$TYPE" --remove "$PLUGIN"
    cat <<EOF

Removed: $TARGET
The kwinrc [Plugins] ${PLUGIN}Enabled key and the [Script-${PLUGIN}] settings group were left
untouched (this script never writes kwinrc). A running KWin keeps the loaded script
until the session ends or the script is disabled.
EOF
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
    printf 'kpackagetool6 --type %s --show %s:\n' "$TYPE" "$PLUGIN"
    "$KPT" --type "$TYPE" --show "$PLUGIN" 2>&1 | sed 's/^/  /' || true
}

case "${1:-}" in
    install) shift; cmd_install "$@" ;;
    upgrade) shift; cmd_upgrade "$@" ;;
    remove)  shift; cmd_remove ;;
    status)  shift; cmd_status ;;
    -h|--help|help) usage ;;
    "") usage >&2; exit 64 ;;
    *) die "unknown subcommand '$1' (install|upgrade|remove|status)" 64 ;;
esac
