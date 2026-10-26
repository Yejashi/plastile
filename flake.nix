{
  description = "Plastile: automatic tiling for KDE Plasma 6 that keeps KWin as the window manager";

  # Plastile needs KWin >= 6.7 and builds with Node 26, both in nixos-unstable.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        plastile = pkgs.callPackage ./nix/package.nix { };
        default = plastile;
      });

      # Builds Plastile with the nixpkgs it is applied to, so it matches that system's Plasma.
      overlays.default = final: prev: {
        plastile = final.callPackage ./nix/package.nix { };
      };

      nixosModules.default = import ./nix/module.nix;
      nixosModules.plastile = self.nixosModules.default;

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_26 pkgs.python3 pkgs.cmake pkgs.kdePackages.qtbase pkgs.pkg-config pkgs.wayland pkgs.wayland-protocols pkgs.wayland-scanner ];
        };
      });
    };
}
