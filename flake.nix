{
  description = "Patch native app and TypeScript development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.pnpm
              pkgs.zig_0_16
            ];

            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
            ''
            + pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              # Native Node addons need the C++ runtime on NixOS.
              export LD_LIBRARY_PATH="${
                pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]
              }''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
