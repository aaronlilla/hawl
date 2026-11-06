#!/bin/sh
# Hawl desktop setup for Linux. Run from the unpacked folder: ./setup.sh [site]
# Per-user, no sudo: installs hawl to ~/.hawl/bin, turns on the helper's login autostart
# (`hawl autostart on`, a systemd --user unit), adds the tray to your desktop's autostart and
# app menu, then, if you give a site, runs `hawl join <site>` in the current folder.
# Uninstall: ./setup.sh --uninstall
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
bin="$HOME/.hawl/bin"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/192x192/apps"
autostart="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"

if [ "${1:-}" = "--uninstall" ]; then
  pkill -f "$bin/hawl-tray" 2>/dev/null || true
  "$bin/hawl" autostart off 2>/dev/null || true
  "$bin/hawl" daemon stop 2>/dev/null || true
  rm -f "$bin/hawl-tray" "$apps/hawl.desktop" "$autostart/hawl-tray.desktop" "$icons/hawl.png"
  echo "Hawl tray and autostart removed. The hawl CLI stays at $bin/hawl; your keys stay in ~/.hawl."
  exit 0
fi

mkdir -p "$bin" "$apps" "$icons" "$autostart"
# Stop a running helper first so the binary can be replaced.
[ -x "$bin/hawl" ] && "$bin/hawl" daemon stop >/dev/null 2>&1 || true
cp "$here/hawl" "$bin/hawl.installing"
chmod 755 "$bin/hawl.installing"
mv -f "$bin/hawl.installing" "$bin/hawl"
cp "$here/hawl-tray" "$bin/hawl-tray"
chmod 755 "$bin/hawl-tray"
cp "$here/hawl.png" "$icons/hawl.png"

desktop() {
  cat <<EOF
[Desktop Entry]
Type=Application
Name=Hawl
Comment=Hawl helper status
Exec=$bin/hawl-tray
Icon=hawl
Terminal=false
Categories=Network;Utility;
X-GNOME-Autostart-enabled=true
EOF
}
desktop > "$apps/hawl.desktop"
desktop > "$autostart/hawl-tray.desktop"

line='export PATH="$HOME/.hawl/bin:$PATH"'
for f in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$f" ] || [ "$f" = "$HOME/.profile" ]; then
    grep -q '# added by hawl' "$f" 2>/dev/null || printf '%s # added by hawl\n' "$line" >> "$f"
  fi
done

"$bin/hawl" autostart on
echo "hawl installed to $bin/hawl and the helper starts at login."

if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  nohup "$bin/hawl-tray" >/dev/null 2>&1 &
fi

if [ -n "${1:-}" ]; then
  "$bin/hawl" join "$1"
else
  echo "Next: open the tray menu and pick \"Connect a project folder\", or run: hawl join <site> in your project folder."
fi
