# Launch: from a clone to a running fund

What it takes to put Good Faith on a network, in order. Each step is a script in this repository and is the same on
a local fork, on devnet and on mainnet; only the keys, the RPC and the care change. `docs/operations.md` covers what
happens after.

## 0. Toolchain

```sh
bash scripts/toolchain.sh --with-kora          # Solana CLI 4.3.2, Anchor 1.2.1, Surfpool 1.6.1, Kora 2.0.5 (Linux, no sudo)
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
(cd app && npm ci) && (cd scripts && npm ci)
```

## 1. Keys

Several keys with separate jobs. Generate each with `solana-keygen new -o <file>` and keep them apart (different
machines or custodians where the deployment allows). The fork and CI use one key for everything; a real deployment
must not, and the CLIs refuse to run without their own variable (`ADMIN_KEYPAIR`, `CRANKER_KEYPAIR`,
`RECOVERY_KEYPAIR`, `SUCCESSOR_KEYPAIR` for the wind-down) so no two jobs share a key by accident.

| key | holds | used by |
|---|---|---|
| deploy / upgrade | the program keypair (`target/deploy/goodfaith-keypair.json`) and the upgrade authority | `anchor deploy`; later a multisig with a timelock, then removed |
| pool authority | the administrator | `scripts/launch.ts` (payer, first authority), `scripts/admin.ts` (`ADMIN_KEYPAIR`); hand to a multisig with `propose-authority` |
| successor authority | the second signer of a wind-down announcement (`successor_authority` setting; the upgrade multisig at launch) | `npm run launch -- --successor-authority <pubkey>`; `scripts/admin.ts announce-wind-down` with `SUCCESSOR_KEYPAIR` |
| issuer | `ISSUER_SECRET` in the identity service | co-signs registrations and recovery proposals |
| recovery | `RECOVERY_KEYPAIR` on the operator's machine for `npm run recovery` (required); never the web service | verifies and co-signs recovery proposals the service prepared |
| pause | `pause_authority` | the one person who can stop new lending at once |
| gatekeeper | `GATEKEEPER_SECRET` in the identity service | issues, renews, freezes and thaws passes on the fund's network |
| sponsor | `KORA_PRIVATE_KEY` for Kora | pays fees and rent; a Turnkey or Privy signer in hosting |
| cranker | `CRANKER_KEYPAIR` | pays the cranker's own fees (or Kora does) |

Fund the deploy key (about 3 SOL for the program), the sponsor (ongoing) and the cranker (a little).

## 2. Program id and build

```sh
bash scripts/program-id.sh      # new program keypair if missing, `anchor keys sync`, build, codegen
```

The declared id in `programs/goodfaith/src/lib.rs`, `Anchor.toml`, the generated client and the app's default now
agree. Update the id by hand where it is text: `scripts/kora/kora.toml` (`allowed_programs`), `app/.env.example`,
the CI env, and the white paper's appendix. Commit; tag the release; record the SHA-256 of
`target/deploy/goodfaith.so`.

## 3. Deploy

```sh
solana config set --url devnet            # or your RPC
anchor deploy --provider.cluster devnet --program-keypair target/deploy/goodfaith-keypair.json
solana program show <program id>          # note the upgrade authority; move it to the upgrade multisig
```

On a local fork there is no deploy: `cd scripts && npm run deploy-fork` plants the built program at the declared id.

## 4. Gatekeeper network and fund

```sh
cd scripts
npm run gatekeeper-setup                                   # creates the fund's network; writes gatekeeper.json (+ the network keypair, keep it)
npm run launch -- --issuer <issuer pubkey> --recovery <recovery pubkey> --pause <pause pubkey> --successor-authority <upgrade multisig>
```

`launch.ts` reads `launch.json` (the decided settings in whole tokens and days), converts them with the mint's
decimals, creates the pool with the admin key as authority and prints the pool, the keys and the app's
`NEXT_PUBLIC_*` block; `launch-result.json` keeps them. It is idempotent: on an existing pool it checks the keys and
prints the same summary. For a short-lived test pool pass `--timelock 3600 --recovery-delay 3600` (CI does); a real
pool keeps the seven-day notice period, which the program will never let you schedule below two days again.

`npm run gatekeeper-setup` adds the admin key as the network's gatekeeper. For a real deployment add the gatekeeper
key instead (`GATEKEEPER_KEYPAIR=<file> npm run launch` when creating the network from the launch script, or run the
setup with that key).

## 5. Hand the pool to the multisig

```sh
npm run admin -- propose-authority <multisig vault address>
# from the multisig: accept_authority (a Squads transaction calling the program; the admin CLI's accept-authority signs with ADMIN_KEYPAIR for a plain key)
npm run admin -- show
```

Update `NEXT_PUBLIC_POOL_AUTHORITY` to the multisig address: the app refuses a pool whose authority is not the one it
pins.

## 6. Services

Copy `deploy/.env.example` to `deploy/.env`, paste the `NEXT_PUBLIC_*` block from the launch output and the secrets
(each key as a JSON array; `PERSON_HASH_SECRETS=1:<random 32 bytes hex>`; random `KORA_API_KEY`, `KORA_HMAC_SECRET`,
`IDENTITY_ADMIN_KEY`, `MOCK_WEBHOOK_SECRET` or the Persona settings; `RECOVERY_MIN_AGE_SECONDS` if a day is not the
right wait before a recovery may be proposed; `CRANKER_KEYPAIR_FILE` for the cranker's own key). Then:

```sh
docker compose -f deploy/docker-compose.yml up -d --build            # app + Kora (internal only) + cranker, SQLite volume
docker compose -f deploy/docker-compose.yml --profile postgres up -d --build   # with Postgres (set IDENTITY_DB_URL)
curl -s https://<host>/api/health | jq
```

`/api/health` answers 200 with `ok: true` when the configuration is sound and the RPC answers, and lists the pool,
the sponsor, the identity service and any configuration problem (a secret under `NEXT_PUBLIC_`, a proxy without an
upstream, Kora without auth, the mock provider on mainnet). Point the identity partner's webhook at
`/api/identity/webhook` and set `PERSONA_*` for production.

Without Docker: `cd app && npm run build && npm start` with the same environment; `kora --config scripts/kora/kora.toml
--rpc-url <rpc> rpc start --signers-config scripts/kora/signers.toml` with `KORA_PRIVATE_KEY`, `KORA_API_KEY`,
`KORA_HMAC_SECRET` in its environment and its port not exposed; `cd scripts && npm run cranker -- --interval 300`
(or `--once` from cron) with `APP_URL` and `IDENTITY_ADMIN_KEY`.

## 7. Check

```sh
cd scripts
npm run admin -- show
RPC_URL=<rpc> npm run member -- status <any member wallet>
npm run cranker -- --dry-run
```

Then fill the white paper's appendix: program id, tag, build hash, upgrade authority, pool, keys, notice period.

## Fresh fork, end to end (what CI does)

```sh
surfpool start --network devnet --no-tui --no-deploy -a "$(solana address)" -q 100000000000 &
cd scripts && npm run deploy-fork && npm run gatekeeper-setup && npm run launch -- --timelock 3600 --recovery-delay 3600 && npm run e2e
# Kora direct, then Kora with auth behind the app (see .github/workflows/ci.yml for the exact environment):
KORA_URL=http://127.0.0.1:8080 npm run kora-e2e
APP_URL=http://127.0.0.1:3100 npm run identity-e2e && APP_URL=http://127.0.0.1:3100 npm run cranker-e2e
KORA_URL=http://127.0.0.1:3100/api/sponsor KORA_DIRECT_URL=http://127.0.0.1:8080 npm run kora-e2e
APP_URL=http://127.0.0.1:3100 npm run smoke
```
