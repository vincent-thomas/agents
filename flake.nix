{
  nixConfig = {
    extra-substituters = [
      "https://nix-community.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    systems.url = "github:nix-systems/default";

    bun2nix.url = "github:nix-community/bun2nix";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      ...
    }@inputs:
    let
      eachSystem = inputs.nixpkgs.lib.genAttrs (import inputs.systems);
      # Access the package set for a given system
      pkgsFor = eachSystem (
        system:
        import inputs.nixpkgs {
          inherit system;
          # Use the bun2nix overlay, which puts `bun2nix` in pkgs
          # You can, of course, still access
          # inputs.bun2nix.packages.${system}.default instead
          # and use that to build your package instead
          overlays = [ inputs.bun2nix.overlays.default ];
        }
      );
    in
    {
      packages = eachSystem (system: {
        # Produce a package for this template with bun2nix in
        # the overlay
        coder = pkgsFor.${system}.callPackage ./nix/coder.nix { };
      });

    };
  # // flake-utils.lib.eachDefaultSystem (
  #   system:
  #   let
  #     pkgs = nixpkgs.legacyPackages.${system};
  #   in
  #   {
  #
  #     # devShells.default = pkgs.mkShell {
  #     #   buildInputs = [
  #     #     pkgs.bun
  #     #     pkgs.gnumake
  #     #   ];
  #     # };
  #   }
  # );
}
