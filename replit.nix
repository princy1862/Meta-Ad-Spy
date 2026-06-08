{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.nodePackages.npm

    # Build toolchain so node-gyp can compile native modules (better-sqlite3)
    # from source when no prebuilt binary matches Replit's Nix environment.
    pkgs.python3
    pkgs.gnumake
    pkgs.gcc
  ];
}
