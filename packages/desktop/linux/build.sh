#!/bin/sh
# Packs hawl-desktop-linux-x64.tar.gz: the hawl binary, the tray and setup.sh.
# Needs packages/cli/dist/hawl-linux-x64 first: pnpm --filter @hawl/cli run build:sea -- --target linux-x64
# Usage: sh packages/desktop/linux/build.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
dist="$(cd "$here/../../cli/dist" && pwd)"
[ -f "$dist/hawl-linux-x64" ] || { echo "missing $dist/hawl-linux-x64; run build:sea --target linux-x64 first" >&2; exit 1; }
stage="$here/out/hawl"
rm -rf "$here/out"
mkdir -p "$stage"
cp "$dist/hawl-linux-x64" "$stage/hawl"
cp "$here/hawl-tray" "$here/setup.sh" "$stage/"
cp "$here/../assets/hawl.png" "$stage/hawl.png"
chmod 755 "$stage/hawl" "$stage/hawl-tray" "$stage/setup.sh"
tar -C "$here/out" -czf "$dist/hawl-desktop-linux-x64.tar.gz" hawl
echo "built $dist/hawl-desktop-linux-x64.tar.gz"
