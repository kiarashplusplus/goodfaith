# Good Faith web app

Next.js (App Router) + Tailwind. Members' wallets are Turnkey sign-in wallets (`@turnkey/react-wallet-kit`), RPC via `@solana/kit`,
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

| Variable                                                                          | Meaning                                                                                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_CLUSTER`                                                             | `devnet` (default) or `mainnet-beta`. Anything else is reported as a configuration error.                           |
| `NEXT_PUBLIC_RPC_URL`                                                             | JSON-RPC endpoint. Must allow `getProgramAccounts` (used for the co-sign inbox and loan history).                   |
| `NEXT_PUBLIC_POOL_MINT`                                                           | Loan token mint (defaults to devnet USDC).                                                                          |
| `NEXT_PUBLIC_PROGRAM_ID`                                                          | Deployed program id.                                                                                                |
| `NEXT_PUBLIC_GATEKEEPER_NETWORK`                                                  | The fund's gatekeeper network (from `scripts: npm run gatekeeper-setup`); empty uses the pool's.                    |
| `NEXT_PUBLIC_POOL_ADDRESS`                                                        | Pin the canonical pool (defaults to the PDA for the mint).                                                          |
| `NEXT_PUBLIC_POOL_AUTHORITY`                                                      | Required: the expected pool authority, or `none` once the pool is frozen.                                           |
| `NEXT_PUBLIC_KORA_URL`                                                            | Kora fee sponsor; leave empty to have users pay their own fees.                                                     |
| `NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID`, `NEXT_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID` | Turnkey sign-in wallets (public IDs). Empty on devnet uses Good Faith's devnet organisation; mainnet must set both. |

The nav shows who pays fees ("Fees covered" / "You pay network fees" / sponsor unavailable). When the sponsor is
configured but unreachable the wallet pays; when the sponsor refuses a transaction the error is shown and nothing is
retried at the user's expense. The Checking page never asks the sponsor to create a token account for a stranger.

The proxy (`/api/sponsor`) decodes every transaction before Kora sees it (`src/lib/sponsor-policy.ts`): Kora must be
the fee payer, exactly one other key signs (the wallet the sponsorship is attributed to), and each instruction is a
Good Faith instruction, a compute-budget instruction, a token-account creation used by a Good Faith instruction in the
same transaction or owned by the wallet, or a token transfer or close signed by the wallet. Each wallet has a daily
transaction allowance and a lifetime token-account allowance (`SPONSOR_DAILY_TX_PER_WALLET`, `SPONSOR_ATA_PER_WALLET`,
counted in the identity store). `scripts/member.ts` is the fallback client for when the app or the sponsor is down.

Values are validated at startup (`src/lib/config.ts`). A bad value, or a pool on chain that doesn't match the pinned
configuration, shows a red banner and turns off borrowing, co-signing, repaying and donating. Plain wallet transfers on
the Checking page keep working.

## Sign-in wallets (Turnkey)

Members never install a wallet app. "Sign in" opens Turnkey's modal (`@turnkey/react-wallet-kit`): the member enters
their email and types the code sent to it. That is the only method: passkeys, social logins and external wallets are
off in the Turnkey dashboard, and off in `providers.tsx` to match. Turnkey's Auth Proxy does sign-up and sign-in with no
backend of ours; each member gets their own Turnkey sub-organisation, and sign-up creates its Solana account
(`src/app/providers.tsx`, which also creates one for a signed-in member who has none).

- **Email is required.** Email-code sign-in gives every new account one. An older passkey-only account (from before
  passkeys were turned off) has none, so `RequireWallet` asks it to add one (Turnkey's `handleAddEmail`, verified by
  an emailed code) before any page but Repay (`essential`), which shows the request above the page instead: repaying
  is never blocked. Join sends that email as the notice contact; `/api/identity/start` and `/api/identity/contact`
  refuse a missing or malformed one.
- **Signing.** `src/lib/turnkey-signer.ts` is a kit `TransactionPartialSigner` and `MessagePartialSigner`: each
  transaction's message bytes, or proof message, goes to Turnkey's raw-payload signing (ed25519, hex, no hash) and
  the 64-byte signature is verified against the wallet before use. So Kora sponsorship, the issuer's co-signed join and
  recovery, the identity proofs and MoneyGram cash-out all work unchanged. `useApp()` (`src/lib/hooks.ts`) returns it.
- **Sessions** are held in the browser (IndexedDB) and refreshed while the app is open; their length is set in the
  Turnkey dashboard. Sign out from the address menu in the nav.
- **Export.** The address menu's "Export my wallet key" opens Turnkey's export flow (Solana format). Saved in a file,
  that key works as `MEMBER_KEYPAIR` for `scripts/member.ts`, which takes a solana-keygen JSON file or an exported key
  in base58 or hex.
- **Custody.** Each member is their own sub-organisation whose only user is the member (created by the Auth Proxy at
  sign-up). The parent organisation can read it but cannot sign, change or delete anything in it, and the app adds no
  delegated user or policy. Keep it that way: Turnkey's delegated access would make Good Faith able to sign for members
  and changes the custody answer in the terms. Spot-check in the dashboard that a member's sub-organisation lists one
  user.
- **Before launch, in the Turnkey dashboard** (Embedded Wallets → Configuration), from Turnkey's docs
  (docs.turnkey.com/llms.txt):
  - **Plan.** The free plan allows 25 signatures a month; every member action is at least one. The pilot needs a paid
    plan (turnkey.com/pricing).
  - **Allowed origins.** They default to `*`. List the exact production URL (no wildcards are supported), plus
    `http://localhost:3000` on the devnet organisation only.
  - **Account lookups.** Turn on "Require verification token for account lookups", or anyone can ask the Auth Proxy
    whether an email has an account.
  - **Captcha.** Turn on Cloudflare Turnstile; the wallet kit (2.3.0 or later) handles it. With it on, the kit loads the widget on every
    signed-out page; `scripts/smoke.ts` ignores `challenges.cloudflare.com` traffic and nothing else. Each sign-up creates a
    sub-organisation, so bots cost money without it.
  - **Email.** Set the application name and logo shown in sign-in emails ("Good Faith").
  - **Sessions.** The default is 15 minutes (900 seconds), which the privacy notice states.
  - **Fee sponsorship.** Leave Turnkey's own gas and rent sponsorship off: Kora pays fees under
    `sponsor-policy.ts`, and the issuer's partly signed transactions name Kora as the fee payer.
  - **Email as the only sign-in.** Anyone who controls a member's email can sign in as them. Before real money,
    decide whether to add a second factor (Turnkey MFA, e.g. a passkey); if passkeys come back, set the passkey domain
    (`passkeyConfig.rpId`, the top-level domain) before the first passkey sign-up, since passkeys are bound to it.
- **Devnet check.** A sign-up (with a Chrome virtual passkey, before passkeys were turned off), both identity proofs
  and a USDC send from the Checking page were run against the devnet organisation.

## Health and deployment

`GET /api/health` answers 200 with `ok: true` when the configuration is valid and the RPC answers; the body lists the
pinned pool (paused, winding down, active loans, pending claims, scheduled change), the sponsor (proxied, upstream,
auth kind, liveness), the identity service (provider, recovery enabled, store kind) and configuration problems from
`src/lib/server-env.ts` (a secret under `NEXT_PUBLIC_`, a proxy without upstream, Kora without auth, the mock provider
or a memory store on mainnet). `app/Dockerfile` builds the standalone server (`next.config.ts` `output: "standalone"`);
`deploy/docker-compose.yml` runs it with Kora and the cranker. The identity store is SQLite by default and Postgres
when `IDENTITY_DB_URL` is set (`src/lib/identity/pg-store.ts`; the store tests run on both when `TEST_PG_URL` points
at a database).

## Identity issuer (server side)

Joining needs the fund's issuer to co-sign (`register_member` and `propose_rebind` require `pool.issuer`; a recovery
proposal also needs the pool's recovery authority). The app's `/api/identity/*` routes are that issuer:

- `start`: the wallet signs a dated message (proof of control) and a hosted identity check is opened with the provider
  (`IDENTITY_PROVIDER=persona`, or `mock` on test networks: `/api/identity/mock` is the "hosted flow").
- `webhook`: the provider reports the outcome (signature verified over the raw body, event ids de-duplicated). On
  approval the verified ID fields are reduced to a keyed fingerprint (`PERSON_HASH_SECRET`; state, ID number,
  birthdate, never the name) that resolves to a person: a known fingerprint means the same person, a new one gets a
  random 32-byte person id. Texas and 18+ are enforced, a banned person is refused, and a gateway token is issued to
  the wallet on our network with `GATEKEEPER_SECRET`. Only the opaque id goes on chain; the fingerprint, the wallets,
  the inquiry id and a status stay in the store (`IDENTITY_DB_PATH`, Node's built-in SQLite; `memory` for throwaway
  runs).
- `status`: where a wallet stands and what comes next (`verify`, `wait`, `join`, `recover`, `review`, `pending`,
  `finalize`, `done`, `renew`, `blocked`), with the person's bar and its end when there is one and the pass (expiry,
  active or frozen).
- `renew`: a fresh year on a member's pass without a new check (proof of control as in `start`; refused while the
  person is barred). `contact`: where notices go, changeable only from the wallet linked to the membership; the
  previous contact is told.
- `join`: the `register_member` transaction, built for the fee sponsor when one is configured and signed with
  `ISSUER_SECRET`; the browser adds the wallet's signature and sends it (`sendPrepared` in `lib/tx.ts`).
- `rebind`: wallet recovery, signed by the new wallet (proof of control as in `start`). A person who verifies again
  from a new wallet gets `recover`: the call records a request for the operator (202 with `requestedAt`; DELETE
  withdraws it until it is proposed) and a notice goes to the contact on file from before the request, with its
  delivery recorded. The operator's recovery CLI (`scripts/recovery.ts`, the only holder of the recovery key) reads
  the queue (`GET /api/identity/recoveries`, admin key), asks for the issuer-signed `propose_rebind` built for the
  recovery key as fee payer (`POST /api/identity/recoveries/:personId {feePayer, newWallet, force?}`; refused for a
  wallet other than the recorded one, a request already proposed, one younger than `RECOVERY_MIN_AGE_SECONDS` or one
  whose notice failed), verifies the transaction, signs, sends and reports it (the member is told about the veto
  window), or rejects it (DELETE). The old wallet may veto during `pool.recoveryDelaySeconds`; once the delay has
  passed `rebind` returns `finalize_rebind`, paid by the new wallet (the cranker finalises due recoveries too). The
  old wallet is retired on chain and open loans, guarantees, eligibility and claims follow the person. A barred
  person may recover too.
- `link`: a verified wallet re-checks with a renewed or second document; the new fingerprint joins the same person
  (refused when it already belongs to another membership). Fingerprint keys are versioned (`PERSON_HASH_SECRETS`)
  so a rotation re-links people on their next check instead of orphaning them. `docs/identity.md` has the details.
- `ban` and `reconcile` (operator, `IDENTITY_ADMIN_KEY`): mirror the chain's bars. `reconcile` takes every person
  the chain bars now with `until` (the cranker sends it each pass), lifts stored bars the chain no longer has, closes
  recovery requests the chain finalised or vetoed and retries failed notices; `ban` does one person. A time-bounded
  bar is recorded and lapses by itself; a permanent one freezes the passes of every wallet the person verified with
  and refuses future checks; `until` in the past lifts the record and thaws the passes (the admin CLI sends it after
  `lift-bar`). Each change notifies the member (`notify.ts`: the log, or `NOTIFY_WEBHOOK_URL`). Eligibility itself is
  on chain (`ineligible_until`).

All of it is behind `lib/identity/provider.ts`; `persona.ts` is the production provider (inquiry creation with a
one-time link, `Persona-Signature` HMAC over `t.body`, configurable field keys), `mock.ts` the test one. Unit tests
cover the provider, the fingerprint, both stores, the wallet proof and the service; `scripts/identity-e2e.ts` runs the
whole flow against the app on a Surfpool fork with real gateway tokens.

## Cash at MoneyGram

The Checking page's cash card opens MoneyGram Ramps' widget for cash-out (USDC to cash at a counter) and cash-in.
`/api/moneygram/session` creates the widget session with `MONEYGRAM_SK`, which stays on the server; the card is hidden
unless `NEXT_PUBLIC_RAMPS_ORIGIN` is set, and `/api/health` reports `ramps`. MoneyGram runs its own ID check and quote.
On a cash-out the widget asks the app to send USDC: `lib/moneygram.ts` checks the request (Solana, USDC of the pool's
mint, the cluster, an exact amount, a recipient other than the wallet) and builds the transfer. MoneyGram names a token
account, which is paid directly, or a wallet, whose associated account is used. The transfer carries MoneyGram's
deposit-matching ID as a memo (a UUID, public on chain; not the pickup reference number, which never goes on chain), which the sponsor pays for (one memo of at most 128 bytes, only next to the wallet's own transfer). Sandbox: origin
`https://playground.xramps.moneygram.com` and a `ramps_sk_sbox_` key, devnet only; the playground needs realistic test
details (an 8-digit, non-sequential Texas licence number) before it asks for the transfer. A cash-in also asks for a
Social Security number and a secondary ID, and the playground rejects numbers outside the issued SSN ranges. A sandbox
cash-out has been run end to end from the test wallet in `keys/devnet-test-member.json.enc`: 10 USDC to MoneyGram's
account, reference number issued for 7.00 USD in Texas.

## Layout

- `src/app/*` — one client page per route plus a server `layout.tsx` for its title; `error.tsx`, `not-found.tsx` and `loading.tsx` at the root.
- `src/components` — UI primitives (`ui.tsx`: `Field` takes an `error` prop wired for screen readers; `Notice` is a live region), sign-in and account menu (`connect-button.tsx`), nav, verify-and-join, loan list.
- `src/lib/identity` — the identity issuer (provider interface, Persona, mock, person hash, store, gatekeeper, service).
- `src/app/api/sponsor` — the fee-sponsor proxy (method allow-list, per-client rate limit, Kora auth headers, the sponsorship policy with atomically reserved per-wallet and fund-wide counters; helpers in `src/lib/sponsor-proxy.ts` and `src/lib/sponsor-policy.ts`).
- `src/lib` — config, program access layer (`program.ts`), transaction flow (`tx.ts`), Kora client (`kora.ts`), send planner (`send.ts`), pure helpers (`format.ts`, `escrow.ts`, `loan-status.ts`, `cosign-link.ts`, `clipboard.ts`). All token math is `bigint`.
- `src/generated` — Codama output. Never edit by hand.

Tests (`vitest`) cover the pure helpers, config parsing, PDA derivation against the generated client and the error mapper.

## Dependency advisories

`npm audit` is part of CI (`--omit=dev --audit-level=high` blocks; the full report is informational). The Civic React
client is gone; `@civic/solana-gateway-ts` and `@solana/web3.js` v1 remain as server-only dependencies of the
gatekeeper (token issuance), so `package.json` keeps `jayson` at 5.x and `uuid` at 11.1.1+ through `overrides`.
