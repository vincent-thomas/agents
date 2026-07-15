{
  description = "Agent flake using Bun";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "agent";
          version = "0.1.0";
          src = self;

          nativeBuildInputs = [
            pkgs.gnumake
            pkgs.bun
            pkgs.makeWrapper
            pkgs.git
          ];

          dontConfigure = true;
          dontStrip = true;

          buildPhase = ''
            runHook preBuild

            bun install
            make test

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            rm -rf node_modules/.cache

            mkdir -p $out/lib/agent
            cp -a . $out/lib/agent
            cd $out/lib/agent

            makeWrapper ${pkgs.bun}/bin/bun $out/bin/agent \
              --add-flags "run $out/lib/agent/packages/agent/src/index.ts"

            runHook postInstall
          '';
        };

        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/agent";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.bun
            pkgs.gnumake
          ];
        };
      }
    );
}
