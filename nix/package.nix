# Plastile for Nix: the KWin script, the optional Plastile Motion effect and the persistence helper
# under one prefix:
#   share/kwin/scripts/plastile                    the KWin script
#   share/kwin/effects/plastile_motion             the optional effect (off until enabled)
#   libexec/plastile-state
#   share/dbus-1/services/org.kde.plastile.State.service   the helper, D-Bus activated
# Needs KWin >= 6.7 and nodejs_26 at build time, so use a nixpkgs with Plasma 6.7 (nixos-unstable).
{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_26,
  cmake,
  kdePackages,
}:

let
  version = (lib.importJSON ../package/metadata.json).KPlugin.Version;
  root = ../.;
  # Only what the build reads, so documentation changes do not rebuild the package.
  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.runtime.json
      ../LICENSE
      ../src
      ../tools/build.mjs
      ../tools/bundle-options.ts
      ../tools/itercheck.ts
      ../tools/qv4check.ts
      ../package
      ../effect
      ../helper
    ];
  };

  helper = stdenv.mkDerivation {
    pname = "plastile-state";
    inherit version;
    src = lib.fileset.toSource {
      root = ../helper;
      fileset = ../helper;
    };
    nativeBuildInputs = [ cmake ];
    buildInputs = [ kdePackages.qtbase ];
    # A console Qt Core/DBus program: no platform plugins to wrap.
    dontWrapQtApps = true;
    meta.license = lib.licenses.gpl3Plus;
  };
in
buildNpmPackage {
  pname = "plastile";
  inherit version src;

  nodejs = nodejs_26;
  npmDepsHash = "sha256-vvaJ3N8+9vtT28N4bpsr9jeZeayXeRBnWRL2YytfrnA=";

  # `npm run build` writes package/contents/code/plastile.mjs.
  npmBuildScript = "build";

  installPhase = ''
    runHook preInstall
    test -f package/contents/code/plastile.mjs
    mkdir -p $out/share/kwin/scripts $out/share/kwin/effects $out/share/licenses/plastile
    cp -r package $out/share/kwin/scripts/plastile
    cp -r effect $out/share/kwin/effects/plastile_motion
    cp LICENSE $out/share/licenses/plastile/
    cp -r ${helper}/. $out/
    runHook postInstall
  '';

  passthru = { inherit helper; };

  meta = {
    description = "Automatic tiling for KDE Plasma 6 that keeps KWin as the window manager";
    homepage = "https://github.com/Yejashi/plastile";
    license = lib.licenses.gpl3Plus;
    platforms = lib.platforms.linux;
  };
}
