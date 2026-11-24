{
  description = "Patch: a browser diff review loop for coding agents";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = {
        aarch64-darwin = "darwin-aarch64";
        x86_64-darwin = "darwin-x64";
        aarch64-linux = "linux-aarch64";
        x86_64-linux = "linux-x64";
      };
      # Bun moves faster than nixpkgs; pin the latest release here.
      bunVersion = "1.4.5";
      bunHashes = {
        darwin-aarch64 = "sha256-tda8LhPK8U5XyJZh6J79Bz/xYWW0G/5DiCYWQQYJzRA=";
        darwin-x64 = "sha256-pJcud4zOS2oZTX0onzJqphV21x2At6U+naLzc5Vm5f0=";
        linux-aarch64 = "sha256-GGVqO/DqVkH1eWrkITt1JVV5pwoP3tLzN5M3hVaM34Q=";
        linux-x64 = "sha256-lFWbO1KJlaSUUvnyQEzsdPLv19BuCgAKjNIUsCw2Zus=";
      };
      forAll = f: nixpkgs.lib.genAttrs (builtins.attrNames systems) (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAll (
        system: pkgs:
        let
          target = systems.${system};
          bun = pkgs.bun.overrideAttrs {
            version = bunVersion;
            src = pkgs.fetchurl {
              url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-${target}.zip";
              hash = bunHashes.${target};
            };
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              bun
              pkgs.git
              pkgs.cargo
              pkgs.rustc
            ];
          };
        }
      );
    };
}
