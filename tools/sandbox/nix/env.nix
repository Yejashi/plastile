# Pinned KWin 6.8 test environment for Plastile's nested integration suite.
#
#   nix-build tools/sandbox/nix/env.nix -o build/nix/kwin68-env
#   nix-build tools/sandbox/nix/env.nix --arg withApps true   # add the optional real applications
#
# One buildEnv with every binary, Qt plugin, QML module and data file that
# tools/nested.py and tests/integration/ use. tools/sandbox/nix/run.sh builds it and
# runs a command with only this environment on PATH (no host directories).
{
  # nixos-unstable channel release nixos-26.11pre1093333.fe13242281a6
  # (nixpkgs commit fe13242281a67641c0102cdb1087f0ebe586c7df): KWin 6.8.0, Qt 6.11.2,
  # KDE Frameworks 6.30.0. sha256 is the unpacked (NAR) hash, as fetchTarball expects.
  nixpkgs ? builtins.fetchTarball {
    url = "https://releases.nixos.org/nixos/unstable/nixos-26.11pre1093333.fe13242281a6/nixexprs.tar.xz";
    sha256 = "15xy1m8ylldnxpg1glja84r59zh7yljxvkh2fmn26nwnn1p53w9c";
  },
  # Real applications for tests/integration/scenarios_realapps.py (scenarios exist only for
  # binaries on PATH); mirrors tools/sandbox/packages-apps.txt.
  withApps ? false,
}:
let
  pkgs = import nixpkgs {
    config = { };
    overlays = [ ];
  };
  kde = pkgs.kdePackages;
  # Breeze decorations draw caption text; without a configured font Qt has no font at all.
  fontsConf = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
  python = pkgs.python3.withPackages (ps: [ ps.dbus-python ]); # drag scenarios (EIS fd over D-Bus)
  # nixpkgs' dbus-daemon reads /etc/dbus-1/session.conf for --session (NixOS generates that
  # file; other hosts have none or their own). tools/nested.py runs `dbus-daemon --session`,
  # so the environment's dbus-daemon maps --session to this copy of the upstream session
  # configuration with the host /etc includes removed.
  sessionConf = pkgs.runCommand "plastile-dbus-session.conf" { } ''
    sed -e '/<include[^>]*>\/etc\/dbus-1\//d' -e '/<includedir>\/etc\/dbus-1\//d' \
      ${pkgs.dbus}/share/dbus-1/session.conf > $out
    if grep -q '/etc/' $out; then echo "host /etc reference left in $out" >&2; exit 1; fi
  '';
  dbusDaemon = pkgs.writeShellScriptBin "dbus-daemon" ''
    args=()
    for a in "$@"; do
      if [ "$a" = --session ]; then args+=("--config-file=${sessionConf}"); else args+=("$a"); fi
    done
    exec ${pkgs.dbus}/bin/dbus-daemon "''${args[@]}"
  '';
  # KWin 6.8 has no QPainter compositor: every backend, the virtual one included, needs a
  # render device, either a DRM render node or Mesa's software device (llvmpipe), which
  # KWin creates only when /dev/udmabuf opens. On kernels with neither (GPU-less containers
  # and microVMs), kwin_wayland preloads a userspace udmabuf stand-in; see udmabuf-shim.c.
  # PLASTILE_UDMABUF_SHIM=1 forces it, =0 disables it, unset/auto decides as below.
  udmabufShim = pkgs.stdenv.mkDerivation {
    name = "plastile-udmabuf-shim";
    src = ./udmabuf-shim.c;
    dontUnpack = true;
    buildPhase = ''
      $CC -O2 -Wall -Wextra -Werror -shared -fPIC -o libplastile-udmabuf-shim.so $src -ldl
    '';
    installPhase = ''
      install -Dm755 libplastile-udmabuf-shim.so $out/lib/libplastile-udmabuf-shim.so
    '';
  };
  kwinWayland = pkgs.writeShellScriptBin "kwin_wayland" ''
    shim=''${PLASTILE_UDMABUF_SHIM:-auto}
    if [ "$shim" = auto ]; then
      shim=1
      # A node that exists but this user cannot open (e.g. /dev/udmabuf root:kvm 0660 on
      # hosted CI runners) is as good as absent: KWin then finds no device and exits.
      { [ -r /dev/udmabuf ] && [ -w /dev/udmabuf ]; } && shim=0
      for node in /dev/dri/renderD*; do { [ -r "$node" ] && [ -w "$node" ]; } && shim=0; done
    fi
    if [ "$shim" = 1 ]; then
      export LD_PRELOAD=${udmabufShim}/lib/libplastile-udmabuf-shim.so''${LD_PRELOAD:+:$LD_PRELOAD}
      case " $* " in
        *" --version "* | *" -v "* | *" --help "* | *" -h "*) ;;
        *) echo "plastile-env: /dev/udmabuf emulated by libplastile-udmabuf-shim (no render node, no kernel udmabuf)" >&2 ;;
      esac
    fi
    # PLASTILE_KWIN_EXEC: run another binary after the decision above (persist-no-qtcore-Q05 runs
    # the one behind nixpkgs' Qt wrapper so its own QML import path can come first).
    exec "''${PLASTILE_KWIN_EXEC:-${kde.kwin}/bin/kwin_wayland}" "$@"
  '';
in
pkgs.buildEnv {
  name = "plastile-kwin68-env";
  paths = [
    (pkgs.lib.hiPrio kwinWayland) # kwin_wayland with the udmabuf decision above
    kde.kwin # KWin/Script kpackage structure, org.kde.kwin QML module, helpers
    pkgs.mesa # EGL vendor (glvnd), llvmpipe and lavapipe; run.sh points the loaders here
    kde.breeze # org.kde.breeze KDecoration plugin (tools/nested.py selects it)
    kde.kpackage # kpackagetool6
    kde.kconfig # kwriteconfig6, kreadconfig6
    kde.libkscreen # kscreen-doctor
    kde.kactivitymanagerd # E08 activity scenarios (libexec, located by tools/sysinfo.py)
    kde.qttools # qdbus (also linked as qdbus6 below)
    kde.qtbase
    kde.qtdeclarative # QtQuick/QtQml modules for declarative scripts
    kde.qtwayland # wayland QPA for Qt clients such as kscreen-doctor
    pkgs.xwayland
    (pkgs.lib.hiPrio dbusDaemon) # dbus-daemon --session without host /etc (see above)
    pkgs.dbus # dbus-send, dbus-monitor; service activation directories
    pkgs.systemdMinimal # busctl
    pkgs.dejavu_fonts
    python
    # Generic tools the harness and tools/install.sh call (no host PATH inside run.sh).
    pkgs.bashNonInteractive
    pkgs.coreutils
    pkgs.findutils
    pkgs.gnugrep
    pkgs.gnused
    pkgs.gawk
    pkgs.gitMinimal
    pkgs.unzip
    pkgs.zip
    pkgs.procps
  ]
  ++ pkgs.lib.optionals withApps [
    kde.konsole
    kde.kate
    kde.dolphin
    pkgs.foot
    kde.kdialog # packages.txt in the Ubuntu sandbox
    pkgs.xmessage # x11-utils in the Ubuntu sandbox
    pkgs.xprop # X11 hints oracle in scenarios_realapps.py
  ];
  pathsToLink = [
    "/bin"
    "/libexec"
    "/lib/qt-6"
    "/lib/dri"
    "/lib/gbm"
    "/share"
    "/etc"
  ];
  ignoreCollisions = false;
  postBuild = ''
    # Debian/Arch name it qdbus6; nested.py and collect_environment.py look for that name.
    if [ -e "$out/bin/qdbus" ] && [ ! -e "$out/bin/qdbus6" ]; then
      ln -s qdbus "$out/bin/qdbus6"
    fi
    mkdir -p "$out/plastile"
    ln -s ${fontsConf} "$out/plastile/fonts.conf"
    cat > "$out/plastile/versions" <<EOF
    kwin ${kde.kwin.version}
    qt ${kde.qtbase.version}
    frameworks ${kde.kconfig.version}
    mesa ${pkgs.mesa.version}
    xwayland ${pkgs.xwayland.version}
    nixpkgs ${pkgs.lib.version}
    EOF
  '';
}
