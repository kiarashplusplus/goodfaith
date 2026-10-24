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
3. Create the gatekeeper network and the fund: `npm run gatekeeper-setup && npm run launch -- --timelock 3600
   --recovery-delay 3600` (`launch.ts` reads `launch.json`, the decided settings; without the two flags it uses the
   real seven-day notice and three-day recovery delay). It prints the app's `NEXT_PUBLIC_*` block and writes
   `launch-result.json`. The mint is devnet USDC (`lib.ts` `MINT`, `launch.json`); `e2e.ts` reuses the pool and writes
   `e2e-result.json` for CI. `docs/launch.md` has the full sequence for a real network.

Program id note: LiteSVM (the Rust tests and `cd app && npm run test:svm`) registers the `.so` under the declared id
directly, so neither needs a keypair or a running fork.

## Gatekeeper network

`npm run gatekeeper-setup` creates the fund's own gatekeeper network on the current cluster (a new keypair saved to
`gatekeeper-network.json`, kept out of git) and adds the admin key as its gatekeeper through the Identity.com gateway
program; it writes `gatekeeper.json` (public). With that file present, `e2e` and `kora-e2e` issue real gateway tokens
for their wallets instead of planting cloned Civic bytes, and `identity-e2e` drives the app's identity routes
(`IDENTITY_PROVIDER=mock`) from the wallet's proof of control to the issuer-signed join, a wallet recovery through the
operator's recovery CLI, a permanent ban and a temporary bar.

## Operator and member command lines

`npm run admin -- show | schedule --set field=value | cancel-params | apply | propose-authority <key> | cancel-proposal |
accept-authority | suspend-issuer | pause | resume | announce-wind-down <account> | cancel-wind-down | sweep |
lift-bar <personAccount> <reason...> | freeze --yes` is everything the pool authority can do (`ADMIN_KEYPAIR`, default
`~/.config/solana/id.json`; `--mint` for another pool). `lift-bar` puts the hash of the reason on chain, prints it for
publication and tells the identity service. `e2e.ts` drives pause, schedule, apply, suspend-issuer, lift-bar and
freeze through it. `npm run member -- status | request | cancel | cosign | repay | pay-back | settle | collect | claim |
close-expired | veto | finalize | donate` is a member's fallback client (`MEMBER_KEYPAIR`), everything the app offers
from a terminal against the RPC alone (`pay-back` settles first when nobody has); `kora-e2e` runs its `status`.
`npm run recovery -- list | approve <personId> | reject <personId>` is the operator's recovery CLI: it holds the pool's
recovery key (`RECOVERY_KEYPAIR`, default `~/.config/solana/id.json`) and talks to the identity service
(`IDENTITY_URL`, `IDENTITY_ADMIN_KEY`), which never holds that key; `identity-e2e` drives it.

## Cranker and model

`npm run cranker -- --once` (or `--interval 300` to loop, `--dry-run` to only report) is the operator's scheduled
job: it applies settings whose timelock has elapsed, settles loans past the cutoff, collects what settled loans owe
the fund from their escrows, releases what co-signers are owed (from escrows and the vault), closes expired requests,
finalises recoveries whose delay has passed, sweeps the vault (less what co-signers are owed from it) to the
successor once a wind-down is in effect with no loan open, and posts the barred people, with the end of their bar,
to the identity service (`APP_URL`/`IDENTITY_URL` + `IDENTITY_ADMIN_KEY`). It pays with `CRANKER_KEYPAIR`
(default `~/.config/solana/id.json`) or through Kora when `KORA_URL` is set. `cranker-e2e` proves it on the fork with
a one-day loan from the member `identity-e2e` created, a pending recovery and an expiring request. `npm run model`
prints the economic tables behind `docs/economics.md`.

## Run
- `npm run e2e` - full loan cycle with users paying fees: register, request, co-sign, partial and full repay, the
  escrow claim, cancel (borrower, co-signer, stranger rejected), recovery (issuer + recovery signatures, no new-wallet signature) with a veto and a finalisation,
  `schedule_params` + `apply_params` after the timelock (an open loan keeps its own grace period and bans), a refused late repayment, settle + collect + a two-step restitution with the bars relaxing, lift-bar, after time
  travel, pause and resume, request expiry, the authority handover, `suspend_issuer`, a wind-down with
  `sweep_to_successor` on a second pool, `freeze_pool` (irreversible; re-runs on the same fork skip the update/freeze
  rows, restart Surfpool for a fresh one).
- `npm run kora-e2e` - register, request, co-sign, repay, claim, settle, collect and the policy's refusals with Kora as fee
  and rent payer; asserts user SOL is unchanged. Needs Kora running (below) and a pool created by `launch`/`e2e`.
- `npm run smoke` - Playwright page load check of all 7 routes; fails on any console or page error (including hydration
  errors). Needs `cd app && npm run build && PORT=3100 npm start`. Override the URL with `APP_URL`; set `CHROMIUM_PATH` if no
  Playwright browser is installed (`playwright-core` doesn't download one).

## Deployable images
`app/Dockerfile` (web app, identity service and sponsor proxy; Next.js standalone), `deploy/cranker.Dockerfile`
(cranker, admin and member CLIs), `deploy/kora.Dockerfile` (Kora with the fund's policy) and `deploy/docker-compose.yml`
(all of them plus an optional Postgres). `docs/launch.md` walks through a deployment; `/api/health` reports the
configuration, the RPC, the pool, the sponsor and the identity service.

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
  running Kora: register, request, co-sign for a borrower with no token account, repay, donate, cancel, settle and collect,
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
  7,175,760 lamports (borrower token account + Loan + escrow with the v4 Loan), hence 8,000,000. `max_signatures = 4`
  fits a registration (wallet + issuer + Kora) with room; the app's proxy only lets extra signers through on Good
  Faith instructions.
- `[kora.usage_limit]` counts transactions per wallet for ever (no window); keep it off.
- Auth: Kora reads `KORA_API_KEY` / `KORA_HMAC_SECRET` from its environment; the proxy sends them. `config validate`
  warns about missing auth because it only looks at the file.
- Private key only via `KORA_PRIVATE_KEY`; never commit it. Use Turnkey or Privy signers for hosting.
