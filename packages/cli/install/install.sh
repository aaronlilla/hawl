#!/bin/sh
# hawl installer: curl -fsSL https://hawl.ai/install.sh | sh
# Join a site in one line: curl -fsSL https://hawl.ai/install.sh | sh -s -- join <site>
# Downloads the release manifest, checks its Ed25519 signature against the pinned key,
# downloads the binary from GitHub Releases and checks its sha256. Nothing is installed
# if any check fails.
set -eu

BASE="${HAWL_BASE_URL:-https://hawl.ai/cli}"
DEST="${HAWL_INSTALL_DIR:-$HOME/.hawl/bin}"

# Release public key (Ed25519, PEM): the same key as packages/cli/build/update-pubkey.json.
PUBKEY_PEM='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA9X1NIr4Eioq5+9n8kR1iFjGzcRNXocmJE40Im73vzPI=
-----END PUBLIC KEY-----'

# Plain words and a tick per step. Colour only on a terminal, never with NO_COLOR.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then GRN="$(printf '[32m')"; DIM="$(printf '[2m')"; RST="$(printf '[0m')"; else GRN=""; DIM=""; RST=""; fi
BAR="########################"
# tick "label" [bar]: a finished step, label padded to 38 columns.
tick() { printf '%s✓%s %-37s%s
' "$GRN" "$RST" "$1" "${2:+$GRN$BAR$RST}"; }
fail() { echo "hawl install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"; }

need curl
need openssl
need sed
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "missing required tool: sha256sum or shasum"
fi

case "$PUBKEY_PEM" in
  *BEGIN\ PUBLIC\ KEY*) ;;
  *) fail "no pinned release key in this installer; refusing to install" ;;
esac

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) fail "unsupported OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) fail "unsupported CPU: $(uname -m)" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

# manifest.canonical.json is the exact signed bytes (JCS of the manifest without "sig");
# manifest.sig is the raw 64-byte signature.
curl -fsSL "$BASE/manifest.canonical.json" -o "$TMP/manifest.canonical.json"
curl -fsSL "$BASE/manifest.sig" -o "$TMP/manifest.sig"
printf '%s\n' "$PUBKEY_PEM" > "$TMP/pub.pem"

openssl pkeyutl -verify -pubin -inkey "$TMP/pub.pem" -rawin \
  -in "$TMP/manifest.canonical.json" -sigfile "$TMP/manifest.sig" >/dev/null 2>&1 \
  || fail "manifest signature check failed; nothing installed"
tick "Checking the release signature"

# Sorted-key compact JSON: {"arch":..,"os":..,"sha256":..,"url":..}
LINE="$(sed -n 's/.*{"arch":"'"$ARCH"'","os":"'"$OS"'","sha256":"\([0-9a-f]\{64\}\)","url":"\(https:\/\/[^"]*\)"}.*/\1 \2/p' "$TMP/manifest.canonical.json" | head -n 1)"
[ -n "$LINE" ] || fail "no release for $OS-$ARCH"
SHA="${LINE% *}"
URL="${LINE#* }"

curl -fsSL "$URL" -o "$TMP/hawl"
tick "Downloading hawl for $OS-$ARCH" bar
[ "$(sha256 "$TMP/hawl")" = "$SHA" ] || fail "sha256 mismatch; nothing installed"
tick "Checking the sha256"

mkdir -p "$DEST"
chmod 755 "$TMP/hawl"
mv "$TMP/hawl" "$DEST/hawl"

echo "hawl installed to $DEST/hawl"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "add to PATH: export PATH=\"$DEST:\$PATH\"" ;;
esac

# `sh -s -- join <site>`: hand the arguments to the fresh binary (full path, PATH may not be set).
# HAWL_INSTALL_TOOLS=claude,codex,git (or all) installs Claude Code, Codex and git without asking.
# Without it join asks at a keyboard (stdin is the script here, so read the terminal) or only lists.
if [ "$#" -gt 0 ]; then
  if [ "${1:-}" = join ] && [ -n "${HAWL_INSTALL_TOOLS:-}" ]; then set -- "$@" --install-tools "$HAWL_INSTALL_TOOLS"; fi
  if ( : </dev/tty ) 2>/dev/null; then exec "$DEST/hawl" "$@" </dev/tty; fi
  exec "$DEST/hawl" "$@"
fi
# The helper starts at login (turn off: hawl autostart off). A failure here never fails the install.
"$DEST/hawl" autostart on >/dev/null 2>&1 || true
echo "Hawl starts when you log in. Turn that off with \`hawl autostart off\`."
echo "Sign in: hawl login"
echo "${DIM}Then connect a folder: hawl join <site>${RST}"
