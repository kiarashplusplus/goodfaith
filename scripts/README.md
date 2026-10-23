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
  cancel (borrower, co-signer, stranger rejected), `rebind_wallet`, `schedule_params` + `apply_params` after the timelock (an open loan keeps its own grace period), `suspend_issuer`, a wind-down with `sweep_to_successor` on a second pool,
  default after time travel, `freeze_pool` (irreversible; re-runs on the same fork skip the update/freeze rows,
  restart Surfpool for a fresh one).
- `npm run kora-e2e` - request, co-sign and repay with Kora as fee and rent payer; asserts user SOL is unchanged.
  Optional: needs Kora running (below) and a pool created by `e2e`.
- `npm run smoke` - Playwright page load check of all 7 routes; fails on any console or page error (including hydration
  errors). Needs `cd app && npm run build && PORT=3100 npm start`. Override the URL with `APP_URL`; set `CHROMIUM_PATH` if no
  Playwright browser is installed (`playwright-core` doesn't download one).

## In CI
`.github/workflows/ci.yml` runs the smoke check in the `app` job on every push and pull request, and the long `e2e`
job (Surfpool fork, `deploy-fork`, `e2e`, Kora direct, Kora through the proxy with auth, smoke against that app) on
pushes to `main` and on manual dispatch (Actions > CI > Run workflow). The e2e job needs public devnet RPC from the
runner; if it fails on a rate limit, re-run it. Toolchain, platform-tools and the compiled Kora are cached between runs
(about 20 minutes cold, 6 minutes cached); logs are uploaded as an artifact on failure.

## Kora (fee sponsor)
Install with `bash scripts/toolchain.sh --with-kora` (compiles `kora-cli` 2.0.5, 10-20 min). Run against the fork:
```
export KORA_PRIVATE_KEY="$(cat some-throwaway-keypair.json)"
kora --config scripts/kora/kora.toml config validate          # offline policy check; read its warnings
kora --config scripts/kora/kora.toml --rpc-url http://127.0.0.1:8899 rpc start --signers-config scripts/kora/signers.toml
```
- `npm run kora-e2e` drives the web app's own sponsored path (`app/src/lib/tx.ts`, `kora.ts`, `program.ts`) through a
  running Kora: register, request, co-sign for a borrower with no token account, repay, donate, cancel, mark default,
  the Checking-page send (sender pays when the recipient has no token account), a Memo instruction refused by Kora,
  and a check that users paid nothing while Kora's spend matches the rent it should have paid. Set
  `KORA_URL=http://localhost:3000/api/sponsor` to go through the app's proxy instead (start the app with `KORA_URL`
  and `KORA_API_KEY`/`KORA_HMAC_SECRET` in its environment).
- Through the app's proxy (what hosting looks like): start Kora with `KORA_HMAC_SECRET` and `KORA_API_KEY` in its
  environment, build and start the app with `NEXT_PUBLIC_KORA_URL=/api/sponsor`, `KORA_URL=http://127.0.0.1:8080` and
  the same two secrets, then `KORA_URL=http://127.0.0.1:3100/api/sponsor KORA_DIRECT_URL=http://127.0.0.1:8080 npm run
  kora-e2e`. That run also checks the boundary: Kora refuses an unsigned direct call (401), the proxy refuses
  `getConfig` (-32601) and a burst of requests gets 429.
- `kora/kora.toml` is the deployable policy; its header lists what to change for mainnet. Kora 2.0.5 answers any
  origin, so never expose its port: the app's `/api/sponsor` route is the origin and auth boundary.
- `max_allowed_lamports` is the fee payer's outflow per transaction, CPI-created rent included. A first co-sign costs
  6,062,160 lamports (borrower token account + Loan + escrow), hence 7,000,000.
- `[kora.usage_limit]` counts transactions per wallet for ever (no window); keep it off.
- Auth: Kora reads `KORA_API_KEY` / `KORA_HMAC_SECRET` from its environment; the proxy sends them. `config validate`
  warns about missing auth because it only looks at the file.
- Private key only via `KORA_PRIVATE_KEY`; never commit it. Use Turnkey or Privy signers for hosting.
