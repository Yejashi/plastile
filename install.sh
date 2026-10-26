#!/bin/sh
# Plastile installer: downloads a release from GitHub, verifies it and installs it for the current user.
#
#   curl -fsSL https://raw.githubusercontent.com/Yejashi/plastile/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/Yejashi/plastile/main/install.sh | sh -s -- --with-helper
#
# Options:
#   --version TAG    install that release (default: the newest one, pre-releases included)
#   --local DIR      install the files in DIR (built by tools/release.py) instead of downloading
#   --with-helper    also build and install plastile-state, which keeps layout preferences across
#                    logins (needs cmake, a C++17 compiler and the Qt 6 Core/DBus development files)
#   --no-enable      install only; do not turn the script on
#   --uninstall      disable and remove Plastile, the Motion effect and the helper
#   --force          skip the KWin version check
#   -h, --help       show this help
#
# What it does: installs the KWin script and the optional Plastile Motion effect (left disabled) with
# kpackagetool6 into ~/.local/share/kwin, upgrading them in place when already installed. On a first
# install it turns the script on (kwinrc [Plugins] plastileEnabled=true plus KWin's Scripting.start),
# the same as ticking it in System Settings. It never restarts KWin or touches other settings.
# Every downloaded file is checked against the release's SHA256SUMS.
#
# Plastile is free software under GPL-3.0-or-later: https://github.com/Yejashi/plastile
set -eu

REPO=Yejashi/plastile
PLUGIN=plastile
EFFECT=plastile_motion
SERVICE_NAME=org.kde.plastile.State
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
SCRIPT_TARGET=$DATA_HOME/kwin/scripts/$PLUGIN
EFFECT_TARGET=$DATA_HOME/kwin/effects/$EFFECT
SERVICE_FILE=$DATA_HOME/dbus-1/services/$SERVICE_NAME.service
HELPER_PREFIX=${PLASTILE_HELPER_PREFIX:-$HOME/.local}
KPT=${KPACKAGETOOL6:-kpackagetool6}
MIN_KWIN=6.7

TAG=
LOCAL=
WITH_HELPER=0
ENABLE=1
UNINSTALL=0
FORCE=0
WORK=

if [ -t 1 ]; then B=$(printf '\033[1m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m'); R=$(printf '\033[31m'); N=$(printf '\033[0m')
else B=; G=; Y=; R=; N=; fi

say()  { printf '%s==>%s %s\n' "$B$G" "$N" "$*"; }
warn() { printf '%swarning:%s %s\n' "$B$Y" "$N" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$B$R" "$N" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
    if [ -f "$0" ] && head -n 3 "$0" | grep -q 'Plastile installer'; then sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
    else echo "Usage: install.sh [--version TAG] [--local DIR] [--with-helper] [--no-enable] [--uninstall] [--force]"
         echo "Details: https://github.com/$REPO/blob/main/install.sh"; fi
}

cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

while [ $# -gt 0 ]; do
    case $1 in
        --version) [ $# -ge 2 ] || die "--version needs a release tag"; TAG=$2; shift ;;
        --version=*) TAG=${1#*=} ;;
        --local) [ $# -ge 2 ] || die "--local needs a directory"; LOCAL=$2; shift ;;
        --local=*) LOCAL=${1#*=} ;;
        --with-helper) WITH_HELPER=1 ;;
        --no-enable) ENABLE=0 ;;
        --uninstall) UNINSTALL=1 ;;
        --force) FORCE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option $1 (see --help)" ;;
    esac
    shift
done

# kwinrc [Plugins] key, through kwriteconfig6/kreadconfig6 so KWin's own file locking applies.
plugin_enabled() { kreadconfig6 --file kwinrc --group Plugins --key "${PLUGIN}Enabled" 2>/dev/null || true; }
set_plugin_enabled() { kwriteconfig6 --file kwinrc --group Plugins --key "${PLUGIN}Enabled" "$1"; }

# Ask the running KWin to (un)load scripts according to kwinrc. Harmless when KWin is not reachable.
kwin_start_scripts() {
    for q in qdbus6 qdbus-qt6 qdbus; do
        if have "$q"; then "$q" org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null 2>&1 && return 0; fi
    done
    if have dbus-send; then
        dbus-send --session --dest=org.kde.KWin --type=method_call /Scripting org.kde.kwin.Scripting.start >/dev/null 2>&1 && return 0
    fi
    return 1
}

reload_bus() {
    have dbus-send && [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] && \
        dbus-send --session --dest=org.freedesktop.DBus --type=method_call /org/freedesktop/DBus \
            org.freedesktop.DBus.ReloadConfig >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------------------------- uninstall
if [ "$UNINSTALL" = 1 ]; then
    have "$KPT" || die "$KPT not found (it comes with KDE Frameworks, package 'kpackage')"
    if [ "$(plugin_enabled)" = true ]; then
        say "Turning Plastile off"
        set_plugin_enabled false
        kwin_start_scripts || true
    fi
    if [ -e "$SCRIPT_TARGET" ]; then say "Removing the KWin script"; "$KPT" --type KWin/Script --remove "$PLUGIN" >/dev/null; fi
    if [ -e "$EFFECT_TARGET" ]; then say "Removing the Plastile Motion effect"; "$KPT" --type KWin/Effect --remove "$EFFECT" >/dev/null; fi
    if [ -f "$SERVICE_FILE" ]; then
        exe=$(sed -n 's/^Exec=//p' "$SERVICE_FILE" | head -n 1 | sed 's/^"\(.*\)"$/\1/')
        say "Removing the persistence helper"
        rm -f "$SERVICE_FILE"
        case $exe in */plastile-state) rm -f "$exe" ;; esac
        reload_bus
    fi
    cat <<EOF

Plastile is uninstalled. Windows stay where they are. Left in place, in case you come back:
  - your settings: the [Script-plastile] group in $CONFIG_HOME/kwinrc
  - saved layouts: ${XDG_STATE_HOME:-$HOME/.local/state}/plastile/ (delete it to forget them)
  - shortcut entries: to drop them, after logging out and back in run
      qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.cleanUp
    (this also clears leftovers of other removed KWin scripts)
EOF
    exit 0
fi

# ---------------------------------------------------------------------------------------------- checks
have "$KPT" || die "$KPT not found. Install KDE Frameworks' kpackage tools (Arch: kpackage, Debian/Ubuntu: kpackagetool6, Fedora: kf6-kpackage)."
have unzip || have python3 || die "unzip or python3 is needed to inspect the packages"

if [ "${XDG_SESSION_TYPE:-}" != wayland ]; then
    warn "this does not look like a Wayland session (XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-unset}); Plastile supports Plasma 6 on Wayland only"
fi

if have kwin_wayland; then
    kwin_version=$(kwin_wayland --version 2>/dev/null | sed -n 's/^kwin[^0-9]*\([0-9][0-9.]*\).*/\1/p' | head -n 1)
else
    kwin_version=
fi
if [ -z "$kwin_version" ]; then
    [ "$FORCE" = 1 ] || die "could not find KWin (kwin_wayland --version). Plastile needs KDE Plasma 6.7 or newer; --force skips this check."
    warn "KWin version unknown; continuing because of --force"
else
    major=${kwin_version%%.*}; rest=${kwin_version#*.}; minor=${rest%%.*}
    if [ "$major" -lt 6 ] || { [ "$major" -eq 6 ] && [ "$minor" -lt 7 ]; }; then
        [ "$FORCE" = 1 ] || die "KWin $kwin_version found; Plastile needs KWin $MIN_KWIN or newer (--force to try anyway)"
        warn "KWin $kwin_version is older than $MIN_KWIN; continuing because of --force"
    elif [ "$major" -gt 6 ] || [ "$minor" -gt 8 ]; then
        warn "KWin $kwin_version has not been tested with Plastile (tested: 6.7 and 6.8); please report how it goes"
    fi
    say "Found KWin $kwin_version"
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/plastile-install.XXXXXX")

fetch() {  # fetch URL FILE
    if have curl; then curl -fsSL --retry 2 -o "$2" "$1"
    elif have wget; then wget -q -O "$2" "$1"
    else die "curl or wget is needed to download Plastile"; fi
}

sha256() {
    if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
    elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
    else die "sha256sum or shasum is needed to verify the download"; fi
}

# ---------------------------------------------------------------------------------------------- get files
if [ -n "$LOCAL" ]; then
    [ -d "$LOCAL" ] || die "$LOCAL is not a directory"
    SRC=$(cd "$LOCAL" && pwd)
    say "Using the files in $SRC"
    if [ ! -f "$SRC/SHA256SUMS" ]; then
        (cd "$SRC" && for f in *.kwinscript *.zip *.tar.gz; do [ -f "$f" ] && printf '%s  %s\n' "$(sha256 "$f")" "$f"; done) > "$WORK/SHA256SUMS"
    else
        cp "$SRC/SHA256SUMS" "$WORK/SHA256SUMS"
    fi
else
    if [ -z "$TAG" ]; then
        say "Looking up the newest release"
        fetch "https://api.github.com/repos/$REPO/releases?per_page=10" "$WORK/releases.json" \
            || die "could not reach GitHub to find the newest release (use --version TAG, or --local DIR)"
        TAG=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WORK/releases.json" | head -n 1)
        [ -n "$TAG" ] || die "no published release found yet. Until there is one, install from source: https://github.com/$REPO/blob/main/docs/user/INSTALL.md"
    fi
    SRC=$WORK
    base="https://github.com/$REPO/releases/download/$TAG"
    say "Downloading Plastile $TAG"
    fetch "$base/SHA256SUMS" "$WORK/SHA256SUMS" || die "release $TAG has no SHA256SUMS (does the tag exist? see https://github.com/$REPO/releases)"
fi

asset() {  # the name in SHA256SUMS matching a glob
    sed -n 's/^[0-9a-f]\{64\}[[:space:]]\{1,\}\*\{0,1\}//p' "$WORK/SHA256SUMS" | while read -r name; do
        # shellcheck disable=SC2254 # $1 is a glob on purpose
        case $name in $1) printf '%s\n' "$name"; break ;; esac
    done
}

get() {  # get NAME: make $SRC/NAME present and verified
    name=$1
    if [ -z "$LOCAL" ]; then fetch "$base/$name" "$WORK/$name" || die "could not download $name"; fi
    [ -f "$SRC/$name" ] || die "$name is missing"
    want=$(sed -n "s/^\([0-9a-f]\{64\}\)[[:space:]]\{1,\}\*\{0,1\}$name\$/\1/p" "$WORK/SHA256SUMS" | head -n 1)
    got=$(sha256 "$SRC/$name")
    [ "$want" = "$got" ] || die "$name does not match its checksum (expected $want, got $got); not installing"
}

SCRIPT_FILE=$(asset 'plastile-*.kwinscript')
EFFECT_FILE=$(asset 'plastile_motion-*.zip')
HELPER_FILE=$(asset 'plastile-state-*.tar.gz')
[ -n "$SCRIPT_FILE" ] || die "no plastile-*.kwinscript in this release"

get "$SCRIPT_FILE"
[ -z "$EFFECT_FILE" ] || get "$EFFECT_FILE"
[ "$WITH_HELPER" = 0 ] || { [ -n "$HELPER_FILE" ] || die "this release has no helper sources"; get "$HELPER_FILE"; }
say "Checksums verified"

# ---------------------------------------------------------------------------------------------- install
upgraded=0
if [ -e "$SCRIPT_TARGET" ]; then
    say "Upgrading the KWin script"
    "$KPT" --type KWin/Script --upgrade "$SRC/$SCRIPT_FILE" >/dev/null || die "kpackagetool6 could not upgrade the script"
    upgraded=1
else
    say "Installing the KWin script"
    "$KPT" --type KWin/Script --install "$SRC/$SCRIPT_FILE" >/dev/null || die "kpackagetool6 could not install the script"
fi

if [ -n "$EFFECT_FILE" ]; then
    if [ -e "$EFFECT_TARGET" ]; then action=--upgrade; else action=--install; fi
    if "$KPT" --type KWin/Effect "$action" "$SRC/$EFFECT_FILE" >/dev/null; then
        say "Installed the optional Plastile Motion effect (off until you enable it)"
    else
        warn "the Plastile Motion effect could not be installed; Plastile works without it"
    fi
fi

if [ "$WITH_HELPER" = 1 ]; then
    say "Building the persistence helper"
    have cmake || die "cmake is needed for --with-helper (plus a C++17 compiler and the Qt 6 Core/DBus development files: Arch qt6-base, Debian/Ubuntu qt6-base-dev, Fedora qt6-qtbase-devel)"
    case $HELPER_PREFIX in *[\"\\\$\`]*) die "PLASTILE_HELPER_PREFIX may not contain a double quote, backslash, \$ or backquote" ;; esac
    tar -xzf "$SRC/$HELPER_FILE" -C "$WORK"
    hsrc=$(find "$WORK" -maxdepth 2 -name CMakeLists.txt -path '*plastile-state-*' | head -n 1)
    [ -n "$hsrc" ] || die "the helper archive has no CMakeLists.txt"
    hsrc=$(dirname "$hsrc")
    cmake -S "$hsrc" -B "$WORK/helper-build" -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$HELPER_PREFIX" -DCMAKE_INSTALL_LIBEXECDIR=libexec \
        -DPLASTILE_DBUS_SERVICE_DIR="$DATA_HOME/dbus-1/services" >"$WORK/helper.log" 2>&1 \
        || { cat "$WORK/helper.log" >&2; die "configuring the helper failed (are the Qt 6 development files installed?)"; }
    cmake --build "$WORK/helper-build" >>"$WORK/helper.log" 2>&1 || { cat "$WORK/helper.log" >&2; die "building the helper failed"; }
    cmake --install "$WORK/helper-build" >>"$WORK/helper.log" 2>&1 || { cat "$WORK/helper.log" >&2; die "installing the helper failed"; }
    reload_bus
    say "Installed the persistence helper to $HELPER_PREFIX/libexec/plastile-state"
fi

# ---------------------------------------------------------------------------------------------- enable
enabled_now=0
if [ "$upgraded" = 0 ] && [ "$ENABLE" = 1 ]; then
    if have kwriteconfig6; then
        set_plugin_enabled true
        if kwin_start_scripts; then enabled_now=1; say "Plastile is on"
        else warn "turned on in kwinrc, but KWin could not be reached; it starts at your next login"; fi
    else
        warn "kwriteconfig6 not found: turn Plastile on in System Settings > Window Management > KWin Scripts"
    fi
fi

printf '\n%sPlastile is installed.%s\n\n' "$B" "$N"
if [ "$upgraded" = 1 ]; then
    cat <<EOF
This was an upgrade: ${B}log out and back in${N} to run the new version (KWin keeps the old one
loaded until it restarts). Your settings and shortcuts are kept.
EOF
elif [ "$enabled_now" = 1 ]; then
    cat <<EOF
Open two or three windows: they tile side by side. A few keys to start with:
  Meta+Shift+H/J/K/L   focus left/down/up/right     Meta+Ctrl+H/J/K/L   swap
  Meta+Shift+Space     next layout                  Meta+Shift+F        float/tile window
  Meta+Ctrl+= / -      grow / shrink                Meta+Ctrl+S         pause tiling
If a key does not work, it may already be taken in Plasma (that conflict is logged): rebind it in
System Settings > Keyboard > Shortcuts, searching for "Plastile". If Plastile does not start right
away, KWin may not have noticed the new package yet: log out and back in.
EOF
else
    cat <<EOF
Turn it on in System Settings > Window Management > KWin Scripts > tick "Plastile" > Apply.
EOF
fi
cat <<EOF

Settings: System Settings > Window Management > KWin Scripts > Plastile > configure button.
Is it running?  journalctl --user -b | grep plastile
Shortcuts and docs: https://github.com/$REPO#default-shortcuts
EOF
if [ "$WITH_HELPER" = 0 ] && [ ! -f "$SERVICE_FILE" ]; then
    cat <<EOF
Tip: to remember layouts across logins, run the installer again with --with-helper.
EOF
fi
