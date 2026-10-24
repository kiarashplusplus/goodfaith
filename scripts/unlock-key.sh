#!/usr/bin/env bash
# Decrypts keys/devnet-admin.json.enc (or keys/$2.json.enc) to ~/.config/solana/id.json (or $1). The passphrase comes
# from GF_KEY_PASSPHRASE, never from the command line, so it does not land in the process list or shell history.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$HOME/.config/solana/id.json}"
name="${2:-devnet-admin}"
: "${GF_KEY_PASSPHRASE:?set GF_KEY_PASSPHRASE}"
if [ -e "$out" ]; then echo "refusing to overwrite $out" >&2; exit 1; fi
mkdir -p "$(dirname "$out")"
umask 077
openssl enc -d -aes-256-cbc -pbkdf2 -iter 2000000 -pass env:GF_KEY_PASSPHRASE -in "$here/keys/$name.json.enc" -out "$out"
echo "unlocked to $out"
if command -v solana-keygen >/dev/null; then solana-keygen pubkey "$out"; fi
