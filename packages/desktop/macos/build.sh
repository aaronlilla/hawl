#!/bin/sh
# Builds Hawl.app (menu bar app + bundled hawl CLI) and hawl-desktop-darwin-arm64.dmg.
# Needs packages/cli/dist/hawl-darwin-arm64 first: pnpm --filter @hawl/cli run build:sea -- --target darwin-arm64
# Usage: sh packages/desktop/macos/build.sh 0.1.2
# Ad-hoc signed only (no Apple Developer ID), so Gatekeeper asks once (see ../README.md).
set -eu
version="${1:-0.0.0}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
dist="$repo/packages/cli/dist"
out="$here/out"
app="$out/Hawl.app"

[ -f "$dist/hawl-darwin-arm64" ] || { echo "missing $dist/hawl-darwin-arm64; run build:sea --target darwin-arm64 first" >&2; exit 1; }
rm -rf "$out"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

swiftc -O -target arm64-apple-macos13.0 -o "$app/Contents/MacOS/Hawl" "$here/HawlMenu.swift"
cp "$dist/hawl-darwin-arm64" "$app/Contents/Resources/hawl"
chmod 755 "$app/Contents/Resources/hawl"

# App icon (.icns) and an 18 pt menu bar template image from the brand PNG.
iconset="$out/hawl.iconset"
mkdir -p "$iconset"
for s in 16 32 64 128 256 512; do
  sips -z "$s" "$s" "$here/../assets/hawl.png" --out "$iconset/icon_${s}x${s}.png" >/dev/null
done
cp "$iconset/icon_32x32.png" "$iconset/icon_16x16@2x.png"
cp "$iconset/icon_64x64.png" "$iconset/icon_32x32@2x.png"
cp "$iconset/icon_256x256.png" "$iconset/icon_128x128@2x.png"
cp "$iconset/icon_512x512.png" "$iconset/icon_256x256@2x.png"
rm "$iconset/icon_64x64.png"
iconutil -c icns "$iconset" -o "$app/Contents/Resources/Hawl.icns"
sips -z 36 36 "$here/../assets/hawl.png" --out "$app/Contents/Resources/menubar.png" >/dev/null

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Hawl</string>
  <key>CFBundleDisplayName</key><string>Hawl</string>
  <key>CFBundleIdentifier</key><string>ai.hawl.desktop</string>
  <key>CFBundleExecutable</key><string>Hawl</string>
  <key>CFBundleIconFile</key><string>Hawl</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

# Apple Silicon refuses unsigned code, so sign ad-hoc: the CLI first, then the bundle.
codesign --force --sign - "$app/Contents/Resources/hawl"
codesign --force --sign - "$app"
codesign --verify --strict "$app"

stage="$out/dmg"
mkdir -p "$stage"
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -volname Hawl -srcfolder "$stage" -ov -format UDZO "$dist/hawl-desktop-darwin-arm64.dmg"
echo "built $dist/hawl-desktop-darwin-arm64.dmg"
