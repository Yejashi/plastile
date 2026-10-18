# Measurement-only QML module (tools/measure, Plastile.Measure) built against the Qt of the
# pinned KWin 6.8 environment, for the nested perf probes (probes/perf) under run.sh:
#
#   nix-build tools/sandbox/nix/measure.nix -o build/nix/measure68
#   PLASTILE_MEASURE_QML=$PWD/build/nix/measure68/qml tools/sandbox/nix/run.sh -- python3 probes/perf/qualify.py ...
#
# Same nixpkgs pin as env.nix (keep both in step). Never part of the Plastile package.
{
  nixpkgs ? builtins.fetchTarball {
    url = "https://releases.nixos.org/nixos/unstable/nixos-26.11pre1093333.fe13242281a6/nixexprs.tar.xz";
    sha256 = "15xy1m8ylldnxpg1glja84r59zh7yljxvkh2fmn26nwnn1p53w9c";
  },
}:
let
  pkgs = import nixpkgs {
    config = { };
    overlays = [ ];
  };
  kde = pkgs.kdePackages;
in
pkgs.stdenv.mkDerivation {
  pname = "plastile-measure";
  version = "1.0";
  src = ../../measure;
  nativeBuildInputs = [ pkgs.cmake ];
  buildInputs = [ kde.qtbase kde.qtdeclarative ];
  dontWrapQtApps = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r qml $out/
    runHook postInstall
  '';
}
