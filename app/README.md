# Good Faith web app

Next.js (App Router) + Tailwind. Wallet via Wallet Standard (`@solana/kit-plugin-wallet`), RPC via `@solana/kit`,
program client generated with Codama, Civic Pass via `@civic/solana-gateway-react`, optional Kora fee sponsorship.

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
| `NEXT_PUBLIC_GATEKEEPER_NETWORK` | Civic gatekeeper network; leave empty to use the value stored in the pool.                        |
| `NEXT_PUBLIC_POOL_ADDRESS`       | Pin the canonical pool (defaults to the PDA for the mint).                                        |
| `NEXT_PUBLIC_POOL_AUTHORITY`     | Required: the expected pool authority, or `none` once the pool is frozen.                         |
| `NEXT_PUBLIC_KORA_URL`           | Kora fee sponsor; leave empty to have users pay their own fees.                                   |

The nav shows who pays fees ("Fees covered" / "You pay network fees" / sponsor unavailable). When the sponsor is
configured but unreachable the wallet pays; when the sponsor refuses a transaction the error is shown and nothing is
retried at the user's expense. The Checking page never asks the sponsor to create a token account for a stranger.

Values are validated at startup (`src/lib/config.ts`). A bad value, or a pool on chain that doesn't match the pinned
configuration, shows a red banner and turns off borrowing, co-signing, repaying and donating. Plain wallet transfers on
the Checking page keep working.

## Layout

- `src/app/*` — one client page per route plus a server `layout.tsx` for its title; `error.tsx`, `not-found.tsx` and `loading.tsx` at the root.
- `src/components` — UI primitives (`ui.tsx`: `Field` takes an `error` prop wired for screen readers; `Notice` is a live region), wallet connect, nav, Civic gate, loan list.
- `src/app/api/sponsor` — the fee-sponsor proxy (method allow-list, per-client rate limit, Kora auth headers; helpers in `src/lib/sponsor-proxy.ts`).
- `src/lib` — config, program access layer (`program.ts`), transaction flow (`tx.ts`), Kora client (`kora.ts`), send planner (`send.ts`), pure helpers (`format.ts`, `escrow.ts`, `loan-status.ts`, `cosign-link.ts`, `clipboard.ts`). All token math is `bigint`.
- `src/generated` — Codama output. Never edit by hand.

Tests (`vitest`) cover the pure helpers, config parsing, PDA derivation against the generated client and the error mapper.
