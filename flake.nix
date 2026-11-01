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
          inherit (pkgs) lib;
          isLinux = pkgs.stdenv.hostPlatform.isLinux;
          # The SDK's GTK4 host links gtk4 (and libdl from glibc) and finds it
          # through pkg-config; the GSettings schemas back GtkFileDialog.
          gtk = [
            pkgs.gtk4
            pkgs.gsettings-desktop-schemas
          ];
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.pnpm
              pkgs.zig_0_16
            ]
            ++ lib.optionals isLinux [
              pkgs.pkg-config
              # Headless display for `pnpm test:ui` and `pnpm bench:native`.
              pkgs.xvfb-run
              pkgs.xorg-server
              pkgs.xdpyinfo
              # Read the clipboard in scripts/mouse-smoke.mjs (X11, Wayland).
              pkgs.xclip
              pkgs.wl-clipboard
            ];

            buildInputs = lib.optionals isLinux gtk;

            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
            ''
            + lib.optionalString isLinux ''
              # Native Node addons need the C++ runtime on NixOS.
              export LD_LIBRARY_PATH="${
                lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]
              }''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
              export XDG_DATA_DIRS="${
                lib.concatMapStringsSep ":" (p: "${p}/share/gsettings-schemas/${p.name}") gtk
              }''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
