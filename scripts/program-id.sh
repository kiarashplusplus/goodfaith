#!/usr/bin/env bash
# Gives the program its own id for a real deployment: generates target/deploy/goodfaith-keypair.json when there is
# none (keep it out of git and back it up: it is the deploy key until the upgrade authority is moved), syncs the id
# into programs/goodfaith/src/lib.rs and Anchor.toml (`anchor keys sync`), rebuilds, regenerates the app client, and
# prints the places that still name the old id. Idempotent: run it again and it only rebuilds.
#
#   bash scripts/program-id.sh            # new keypair if missing, sync, build, codegen
#   bash scripts/program-id.sh --check    # print the current ids without changing anything
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

KEYPAIR="target/deploy/goodfaith-keypair.json"
declared() { sed -n 's/^declare_id!("\(.*\)");/\1/p' programs/goodfaith/src/lib.rs; }

if [ "${1:-}" = "--check" ]; then
  echo "declared in lib.rs:   $(declared)"
  echo "Anchor.toml:          $(sed -n 's/^goodfaith = "\(.*\)"/\1/p' Anchor.toml)"
  if [ -f "$KEYPAIR" ]; then echo "keypair ($KEYPAIR): $(solana-keygen pubkey "$KEYPAIR")"; else echo "keypair: none"; fi
  echo "generated client:     $(sed -n "s/.*GOODFAITH_PROGRAM_ADDRESS = '\(.*\)' as.*/\1/p" app/src/generated/programs/goodfaith.ts)"
  exit 0
fi

mkdir -p target/deploy
if [ ! -f "$KEYPAIR" ]; then
  solana-keygen new --no-bip39-passphrase --silent -o "$KEYPAIR"
  echo "new program keypair: $KEYPAIR ($(solana-keygen pubkey "$KEYPAIR")). Back it up; never commit it."
fi
OLD="$(declared)"
anchor keys sync
NEW="$(declared)"
echo "program id: $OLD -> $NEW"
anchor build --arch v2
(cd app && npm run codegen)
echo
echo "Still naming the old id (update by hand where they are not generated):"
grep -rn --exclude-dir=node_modules --exclude-dir=target --exclude-dir=.next --exclude-dir=.git "$OLD" . || echo "  nothing"
echo
echo "Next: scripts/kora/kora.toml allowed_programs, app/.env.example and the CI env carry the id as text; docs/whitepaper.md's appendix too."
