#!/bin/sh
# Install the latest cctr release.
#
#   curl -fsSL https://raw.githubusercontent.com/TakashiAihara/cctr/main/scripts/install.sh | sh
#
# CCTR_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
# CCTR_VERSION      tag to install (default: latest); a bare 0.1.0 gets its v prefix added
#
# The checksum is not optional: when SHA256SUMS cannot be fetched, has no line
# for the asset, or no sha256 tool exists, nothing is installed.
set -eu

REPO="TakashiAihara/cctr"
DEST="${CCTR_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${CCTR_VERSION:-latest}"

die() { echo "cctr: $1" >&2; exit 1; }

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS: $os" ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "unsupported architecture: $arch" ;;
esac

case "$VERSION" in
  latest) base="https://github.com/$REPO/releases/latest/download" ;;
  v*) base="https://github.com/$REPO/releases/download/$VERSION" ;;
  *) base="https://github.com/$REPO/releases/download/v$VERSION" ;;
esac

asset="cctr-${os}-${arch}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "cctr: fetching $asset ($VERSION)" >&2
curl -fsSL -o "$tmp/$asset" "$base/$asset" || die "download failed: $base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "SHA256SUMS is missing from the release; refusing to install unverified"

expected=$(grep " $asset\$" "$tmp/SHA256SUMS" | awk '{print $1}')
[ -n "$expected" ] || die "SHA256SUMS has no line for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
else
  die "neither sha256sum nor shasum found; cannot verify"
fi
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset"
echo "cctr: checksum ok" >&2

mkdir -p "$DEST"
install -m 755 "$tmp/$asset" "$DEST/cctr"
echo "cctr: installed to $DEST/cctr" >&2
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "cctr: $DEST is not on PATH" >&2 ;;
esac
