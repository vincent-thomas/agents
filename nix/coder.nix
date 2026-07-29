{
  bun,
  bun2nix,
  writeShellApplication,
  ...
}:
# bun2nix.mkDerivation {
#   pname = "workspace-test-app";
#   version = "1.0.0";
#
#   src = ./.;
#
#   bunDeps = bun2nix.fetchBunDeps {
#     bunNix = ./bun.nix;
#   };
#
#   module = "packages/coder/src/index.ts";
# }
#
let
  application = bun2nix.writeBunApplication {
    pname = "coder";
    version = "1.0.0";

    src = ./..;

    startScript = ''
      bun run ./packages/coder/src/index.ts
    '';

    buildPhase = ":";

    bunDeps = bun2nix.fetchBunDeps {
      bunNix = ../bun.nix;
    };
  };
in
writeShellApplication {
  name = "coder";
  runtimeInputs = [ bun ];
  text = ''
    exec bun run ${application}/share/coder/packages/coder/src/index.ts "$@"
  '';
}
