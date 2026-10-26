# NixOS module: `programs.plastile.enable = true;` installs Plastile system-wide and registers its
# persistence helper with the session bus. Each user then turns the script on once, in System Settings >
# Window Management > KWin Scripts (or kwinrc [Plugins] plastileEnabled=true, e.g. with plasma-manager).
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.plastile;
in
{
  options.programs.plastile = {
    enable = lib.mkEnableOption "Plastile, automatic tiling for KDE Plasma 6 (a KWin script)";
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "The Plastile package. It must be built against the same KDE/Qt as the system's Plasma.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
    services.dbus.packages = [ cfg.package ];
  };
}
