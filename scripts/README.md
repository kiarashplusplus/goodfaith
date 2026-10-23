# Scripts

End-to-end checks against a local Surfpool fork of devnet. Run `npm install` here first (uses its own `node_modules`),
and `npm install` in `app/` as well: `lib.ts` imports the generated client from `app/src/generated` at runtime.

## Setup
1. Fork devnet and deploy the program (from the repo root):
   ```
   anchor build --arch v2
   surfpool start --network devnet --no-tui --no-deploy -a $(solana address) -q 100000000000
   solana program deploy target/deploy/goodfaith.so --program-id target/deploy/goodfaith-keypair.json --url http://127.0.0.1:8899
   ```
   If the new build is larger than the deployed program, run `solana program extend <program id> 10240 --url http://127.0.0.1:8899` first.
2. The mint is hard-coded in `lib.ts` (`MINT`, devnet USDC) and the pool is derived from it. `e2e.ts` writes the
   resulting pool, vault, authority and gatekeeper network to `e2e-result.json`; copy them into `app/.env.local`.

## Run
- `npm run e2e` - full loan cycle (register, request, co-sign, repay, default) with users paying fees.
- `npm run kora-e2e` - same flow with Kora as fee and rent payer; asserts user SOL is unchanged. Needs Kora running (below) and a pool created by `e2e`.
- `npm run smoke` - Playwright page load check of all 7 routes; fails on any console or page error (including hydration errors). Needs `cd app && npm run build && PORT=3100 npm start`. Override the URL with `APP_URL`; set `CHROMIUM_PATH` if no Playwright browser is installed (`playwright-core` doesn't download one).

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
