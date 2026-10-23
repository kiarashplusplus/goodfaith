# Scripts

End-to-end checks against a local Surfpool fork of devnet. Run `npm install` here first (uses its own `node_modules`),
and `npm install` in `app/` as well: `lib.ts` imports the generated client from `app/src/generated` at runtime.

## Toolchain
`bash scripts/toolchain.sh` installs, for the current user and without sudo: Solana CLI 4.3.2 (`~/.local/share/solana`),
Anchor CLI 1.2.1 (prebuilt binary in `~/.local/bin`, `cargo install` fallback) and Surfpool 1.6.1 (`~/.local/bin`). It is
idempotent and prints the PATH line to add. platform-tools (the SBF compiler, ~500 MB) is fetched by the first
`anchor build`. Flags: `--no-surfpool` (CI), `--with-kora` (compiles `kora-cli` 2.0.5, 10-20 min). To pin another Solana
release set `SOLANA_VERSION` (only tarballs that exist on release.anza.xyz work; 4.3.1 does not, 4.3.0 and 4.3.2 do).

## Setup
1. Build and fork devnet (from the repo root):
   ```
   anchor build --arch v2
   surfpool start --network devnet --no-tui --no-deploy -a $(solana address) -q 100000000000
   ```
2. Plant the program on the fork: `npm run deploy-fork`. This writes `target/deploy/goodfaith.so` at the program id
   declared in `programs/goodfaith/src/lib.rs` with the `surfnet_writeProgram` cheatcode, so the original program keypair
   is not needed (a fresh `anchor build` generates a new, unrelated `target/deploy/goodfaith-keypair.json`; ignore it).
   The upgrade authority is your `~/.config/solana/id.json`.
3. The mint is hard-coded in `lib.ts` (`MINT`, devnet USDC) and the pool is derived from it. `e2e.ts` writes the
   resulting pool, vault, authority and gatekeeper network to `e2e-result.json`; copy them into `app/.env.local`.

Program id note: LiteSVM (the Rust tests and `cd app && npm run test:svm`) registers the `.so` under the declared id
directly, so neither needs a keypair or a running fork.

## Run
- `npm run e2e` - full loan cycle with users paying fees: register, request, co-sign, partial and full repay,
  cancel (borrower, co-signer, stranger rejected), `update_pool` (an open loan keeps its own grace period),
  default after time travel, `freeze_pool` (irreversible; re-runs on the same fork skip the update/freeze rows,
  restart Surfpool for a fresh one).
- `npm run kora-e2e` - request, co-sign and repay with Kora as fee and rent payer; asserts user SOL is unchanged.
  Optional: needs Kora running (below) and a pool created by `e2e`.
- `npm run smoke` - Playwright page load check of all 7 routes; fails on any console or page error (including hydration
  errors). Needs `cd app && npm run build && PORT=3100 npm start`. Override the URL with `APP_URL`; set `CHROMIUM_PATH` if no
  Playwright browser is installed (`playwright-core` doesn't download one).

## Kora
```
export KORA_PRIVATE_KEY="$(cat some-throwaway-keypair.json)"
kora --config scripts/kora/kora.toml --rpc-url http://127.0.0.1:8899 rpc start --signers-config scripts/kora/signers.toml
```
Config notes (`kora/kora.toml`):
- `[kora.cache]` needs `default_ttl` and `account_ttl` set even when `enabled = false`.
- Fee payer policy must allow system `create_account`, `assign` and `allocate` (account rent and ATA creation).
- `[validation.price] type = "free"` so users pay nothing.
- Allow the program id, token programs, and the pool mint.
- Private key only via `KORA_PRIVATE_KEY`; never commit it.
