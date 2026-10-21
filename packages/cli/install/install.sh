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

# Sorted-key compact JSON: {"arch":..,"os":..,"sha256":..,"url":..}
LINE="$(sed -n 's/.*{"arch":"'"$ARCH"'","os":"'"$OS"'","sha256":"\([0-9a-f]\{64\}\)","url":"\(https:\/\/[^"]*\)"}.*/\1 \2/p' "$TMP/manifest.canonical.json" | head -n 1)"
[ -n "$LINE" ] || fail "no release for $OS-$ARCH"
SHA="${LINE% *}"
URL="${LINE#* }"

curl -fsSL "$URL" -o "$TMP/hawl"
[ "$(sha256 "$TMP/hawl")" = "$SHA" ] || fail "sha256 mismatch; nothing installed"

mkdir -p "$DEST"
chmod 755 "$TMP/hawl"
mv "$TMP/hawl" "$DEST/hawl"

echo "hawl installed to $DEST/hawl"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "add to PATH: export PATH=\"$DEST:\$PATH\"" ;;
esac

# `sh -s -- join <site>`: hand the arguments to the fresh binary (full path, PATH may not be set).
if [ "$#" -gt 0 ]; then
  exec "$DEST/hawl" "$@"
fi
