# Good Faith web app

Next.js (App Router) + Tailwind. Wallet via Wallet Standard (`@solana/kit-plugin-wallet`), RPC via `@solana/kit`,
program client generated with Codama, the fund's own identity issuer (Persona behind an interface, mock for tests),
optional Kora fee sponsorship.

```
cp .env.example .env.local   # then edit
npm install
npm run dev        # http://localhost:3000
npm run codegen    # regenerate src/generated from ../target/idl/goodfaith.json (run after `anchor build`)
npm run build && npm run lint && npm run typecheck && npm run format:check && npm test
npm run format     # Prettier (config in the repo root)
```

## Configuration (`.env.local`)

| Variable                         | Meaning                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_CLUSTER`            | `devnet` (default) or `mainnet-beta`. Anything else is reported as a configuration error.         |
| `NEXT_PUBLIC_RPC_URL`            | JSON-RPC endpoint. Must allow `getProgramAccounts` (used for the co-sign inbox and loan history). |
| `NEXT_PUBLIC_POOL_MINT`          | Loan token mint (defaults to devnet USDC).                                                        |
| `NEXT_PUBLIC_PROGRAM_ID`         | Deployed program id.                                                                              |
| `NEXT_PUBLIC_GATEKEEPER_NETWORK` | The fund's gatekeeper network (from `scripts: npm run gatekeeper-setup`); empty uses the pool's.  |
| `NEXT_PUBLIC_POOL_ADDRESS`       | Pin the canonical pool (defaults to the PDA for the mint).                                        |
| `NEXT_PUBLIC_POOL_AUTHORITY`     | Required: the expected pool authority, or `none` once the pool is frozen.                         |
| `NEXT_PUBLIC_KORA_URL`           | Kora fee sponsor; leave empty to have users pay their own fees.                                   |

The nav shows who pays fees ("Fees covered" / "You pay network fees" / sponsor unavailable). When the sponsor is
configured but unreachable the wallet pays; when the sponsor refuses a transaction the error is shown and nothing is
retried at the user's expense. The Checking page never asks the sponsor to create a token account for a stranger.

Values are validated at startup (`src/lib/config.ts`). A bad value, or a pool on chain that doesn't match the pinned
configuration, shows a red banner and turns off borrowing, co-signing, repaying and donating. Plain wallet transfers on
the Checking page keep working.

## Identity issuer (server side)

Joining needs the fund's issuer to co-sign (`register_member` and `rebind_wallet` require `pool.issuer`). The app's
`/api/identity/*` routes are that issuer:

- `start`: the wallet signs a dated message (proof of control) and a hosted identity check is opened with the provider
  (`IDENTITY_PROVIDER=persona`, or `mock` on test networks: `/api/identity/mock` is the "hosted flow").
- `webhook`: the provider reports the outcome (signature verified over the raw body, event ids de-duplicated). On
  approval the verified ID fields are reduced to a keyed hash (`PERSON_HASH_SECRET`; state, ID number, birthdate,
  never the name), Texas and 18+ are enforced, a banned person is refused, and a gateway token is issued to the wallet
  on our network with `GATEKEEPER_SECRET`. Only the hash, the wallet, the inquiry id and a status are stored
  (`IDENTITY_DB_PATH`, Node's built-in SQLite; `memory` for throwaway runs).
- `status`: where a wallet stands and what comes next (`verify`, `wait`, `join`, `rebind`, `done`, `blocked`).
- `join` / `rebind`: the on-chain transaction, built for the fee sponsor when one is configured and signed with
  `ISSUER_SECRET`; the browser adds the wallet's signature and sends it (`sendPrepared` in `lib/tx.ts`). A person
  who verifies again from a new wallet gets `rebind`: the old wallet is retired on chain and the escrow refunds follow.
- `ban` (operator, `IDENTITY_ADMIN_KEY`): after a default, revokes the person's pass and refuses future checks.

All of it is behind `lib/identity/provider.ts`; `persona.ts` is the production provider (inquiry creation with a
one-time link, `Persona-Signature` HMAC over `t.body`, configurable field keys), `mock.ts` the test one. Unit tests
cover the provider, the hash, both stores, the wallet proof and the service; `scripts/identity-e2e.ts` runs the whole
flow against the app on a Surfpool fork with real gateway tokens.

## Layout

- `src/app/*` — one client page per route plus a server `layout.tsx` for its title; `error.tsx`, `not-found.tsx` and `loading.tsx` at the root.
- `src/components` — UI primitives (`ui.tsx`: `Field` takes an `error` prop wired for screen readers; `Notice` is a live region), wallet connect, nav, verify-and-join, loan list.
- `src/lib/identity` — the identity issuer (provider interface, Persona, mock, person hash, store, gatekeeper, service).
- `src/app/api/sponsor` — the fee-sponsor proxy (method allow-list, per-client rate limit, Kora auth headers; helpers in `src/lib/sponsor-proxy.ts`).
- `src/lib` — config, program access layer (`program.ts`), transaction flow (`tx.ts`), Kora client (`kora.ts`), send planner (`send.ts`), pure helpers (`format.ts`, `escrow.ts`, `loan-status.ts`, `cosign-link.ts`, `clipboard.ts`). All token math is `bigint`.
- `src/generated` — Codama output. Never edit by hand.

Tests (`vitest`) cover the pure helpers, config parsing, PDA derivation against the generated client and the error mapper.

## Dependency advisories

`npm audit` is part of CI (`--omit=dev --audit-level=high` blocks; the full report is informational). The Civic React
client is gone; `@civic/solana-gateway-ts` and `@solana/web3.js` v1 remain as server-only dependencies of the
gatekeeper (token issuance), so `package.json` keeps `jayson` at 5.x and `uuid` at 11.1.1+ through `overrides`.
