#!/usr/bin/env bash
# Install the pinned Polypus toolchain into $HOME (no sudo). Linux x86_64.
# Versions are recorded in docs/adr/0001-toolchain.md; change them there first.
set -euo pipefail

NOIR_VERSION=1.0.0-beta.22      # Sunspot v1.0.0 requires exactly this
SUNSPOT_VERSION=1.0.0
SUNSPOT_SHA256=d50a9cd80730e6633051fe4571a00d2a6c6c16d8499a8135cbaf09e401ea7746
GO_VERSION=1.27.3
AGAVE_VERSION=4.4.0
ANCHOR_VERSION=1.2.2

mkdir -p "$HOME/.local/bin" "$HOME/.nargo/bin"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

have() { command -v "$1" >/dev/null 2>&1; }

if ! have rustup; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi

if ! "$HOME/.nargo/bin/nargo" --version 2>/dev/null | grep -q "$NOIR_VERSION"; then
  curl -sSL -o "$tmp/nargo.tgz" "https://github.com/noir-lang/noir/releases/download/v$NOIR_VERSION/nargo-x86_64-unknown-linux-gnu.tar.gz"
  tar -C "$HOME/.nargo/bin" -xzf "$tmp/nargo.tgz"
fi

if ! have sunspot; then
  curl -sSL -o "$tmp/sunspot.tgz" "https://github.com/reilabs/sunspot/releases/download/v$SUNSPOT_VERSION/sunspot_${SUNSPOT_VERSION}_linux_amd64.tar.gz"
  echo "$SUNSPOT_SHA256  $tmp/sunspot.tgz" | sha256sum -c -
  tar -C "$tmp" -xzf "$tmp/sunspot.tgz" && install -m755 "$tmp/sunspot" "$HOME/.local/bin/sunspot"
fi

if [ ! -x "$HOME/.local/go/bin/go" ]; then
  curl -sSL -o "$tmp/go.tgz" "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz"
  rm -rf "$HOME/.local/go" && tar -C "$HOME/.local" -xzf "$tmp/go.tgz"
fi

if ! have solana || ! solana --version | grep -q "$AGAVE_VERSION"; then
  sh -c "$(curl -sSfL https://release.anza.xyz/v$AGAVE_VERSION/install)"
fi

if ! have anchor || ! anchor --version | grep -q "$ANCHOR_VERSION"; then
  cargo install anchor-cli --version "$ANCHOR_VERSION" --locked
fi

# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
rustc --version; nargo --version | head -1; sunspot --help >/dev/null && echo "sunspot $SUNSPOT_VERSION"
go version; solana --version; anchor --version || true; node --version || true
