#!/usr/bin/env bash
# Encrypts a keypair file to keys/<name>.json.enc with the same scheme as unlock-key.sh (AES-256-CBC, PBKDF2,
# 2,000,000 iterations) and checks that it decrypts back to the same bytes. The passphrase comes from
# GF_KEY_PASSPHRASE, never from the command line.
#
#   GF_KEY_PASSPHRASE='...' bash scripts/lock-key.sh <keypair.json> <name>
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
in="${1:?keypair file}"
name="${2:?name, e.g. devnet-program}"
out="$here/keys/$name.json.enc"
: "${GF_KEY_PASSPHRASE:?set GF_KEY_PASSPHRASE}"
if [ -e "$out" ]; then echo "refusing to overwrite $out" >&2; exit 1; fi
openssl enc -aes-256-cbc -pbkdf2 -iter 2000000 -salt -pass env:GF_KEY_PASSPHRASE -in "$in" -out "$out"
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 2000000 -pass env:GF_KEY_PASSPHRASE -in "$out" | cmp -s - "$in"; then
  rm -f "$out"; echo "round trip failed; nothing written" >&2; exit 1
fi
echo "locked $in to $out"
if command -v solana-keygen >/dev/null; then solana-keygen pubkey "$in"; fi
