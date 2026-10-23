#!/usr/bin/env bash
# Installs the Good Faith toolchain for one user (no sudo): Solana CLI, Anchor CLI, Surfpool, optionally Kora.
# Idempotent: each step is skipped when the pinned version is already installed. Linux x86_64 only.
#
#   bash scripts/toolchain.sh                 # Solana + Anchor + Surfpool
#   bash scripts/toolchain.sh --no-surfpool   # CI: build and LiteSVM tests only
#   bash scripts/toolchain.sh --with-kora     # also `cargo install kora-cli` (10-20 min)
#
# platform-tools (the SBF compiler, ~500 MB) is fetched by `cargo build-sbf` on the first `anchor build`.
set -euo pipefail

SOLANA_VERSION="${SOLANA_VERSION:-4.3.2}"
ANCHOR_VERSION="${ANCHOR_VERSION:-1.2.1}"
SURFPOOL_VERSION="${SURFPOOL_VERSION:-1.6.1}"
KORA_VERSION="${KORA_VERSION:-2.0.5}"

WITH_SURFPOOL=1
WITH_KORA=0
for arg in "$@"; do
  case "$arg" in
    --no-surfpool) WITH_SURFPOOL=0 ;;
    --with-kora) WITH_KORA=1 ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "This script targets Linux x86_64. On macOS follow docs/next-steps.md (brew install libusb, agave-install, avm)." >&2
  exit 1
fi

BIN="$HOME/.local/bin"
SOLANA_HOME="$HOME/.local/share/solana/install"
mkdir -p "$BIN"
export PATH="$SOLANA_HOME/active_release/bin:$HOME/.cargo/bin:$BIN:$PATH"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
log() { printf '\n==> %s\n' "$*"; }
fetch() { curl -fsSL --retry 3 --retry-delay 2 "$1" -o "$2"; }

log "Solana CLI $SOLANA_VERSION"
if solana --version 2>/dev/null | grep -q "solana-cli $SOLANA_VERSION "; then
  echo "already installed"
else
  # The official installer: downloads the release tarball from release.anza.xyz and sets active_release.
  fetch "https://release.anza.xyz/v$SOLANA_VERSION/install" "$TMP/solana-install.sh"
  sh "$TMP/solana-install.sh"
fi
solana --version

log "Anchor CLI $ANCHOR_VERSION"
if anchor --version 2>/dev/null | grep -q "anchor-cli $ANCHOR_VERSION"; then
  echo "already installed"
else
  if fetch "https://github.com/coral-xyz/anchor/releases/download/v$ANCHOR_VERSION/anchor-$ANCHOR_VERSION-x86_64-unknown-linux-gnu" "$TMP/anchor"; then
    install -m 755 "$TMP/anchor" "$BIN/anchor"
  else
    echo "prebuilt binary unavailable; compiling (10-15 min)"
    cargo install "anchor-cli@$ANCHOR_VERSION" --locked
  fi
fi
anchor --version

if [ "$WITH_SURFPOOL" = 1 ]; then
  log "Surfpool $SURFPOOL_VERSION"
  if surfpool --version 2>/dev/null | grep -q "surfpool $SURFPOOL_VERSION"; then
    echo "already installed"
  else
    fetch "https://github.com/txtx/surfpool/releases/download/v$SURFPOOL_VERSION/surfpool-linux-x64.tar.gz" "$TMP/surfpool.tar.gz"
    tar -xzf "$TMP/surfpool.tar.gz" -C "$BIN"
    chmod +x "$BIN/surfpool"
  fi
  surfpool --version
fi

if [ "$WITH_KORA" = 1 ]; then
  log "Kora $KORA_VERSION"
  if kora --version 2>/dev/null | grep -q "$KORA_VERSION"; then
    echo "already installed"
  else
    cargo install "kora-cli@$KORA_VERSION" --locked
  fi
  kora --version
fi

log "Local keypair"
if [ ! -f "$HOME/.config/solana/id.json" ]; then
  solana-keygen new --no-bip39-passphrase --silent -o "$HOME/.config/solana/id.json"
fi
echo "wallet: $(solana address)"

log "Done. Put this on your PATH:"
echo "export PATH=\"$SOLANA_HOME/active_release/bin:\$HOME/.cargo/bin:$BIN:\$PATH\""
