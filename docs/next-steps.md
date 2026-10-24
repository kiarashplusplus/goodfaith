# Next steps (handoff)

State as of 2026-10-24. Read `README.md`, `docs/spec.md` (incl. "Launch parameters (decided)"), `docs/audit.md`, `docs/identity.md` first.

## Completed: version 3 (bounded trust, precise defaults, resilient settlement)
- Program: opaque person ids (no credential hash on chain); two-step wallet recovery (`propose_rebind` by the new wallet + issuer + recovery authority, `veto_rebind` by the old wallet or the authority during `recovery_delay_seconds`, `finalize_rebind` by anyone); deadline-based lateness (`RepaidLate`, `late_ban_seconds`) so repayment and default give the same money in either order; pull-based escrow claims (`refund_pending`, `pending_claims`, `claim_escrow`) so a frozen or closed token account never blocks settlement or a sweep; request expiry and `close_expired_request`; first-loan cap with cooldown and a graduated cap; per-person exposure limit; no reciprocal guarantees; disbursement window cap; `pause_lending`/`resume_lending`; `MIN_TIMELOCK_SECONDS`; configurable ban durations. 70 LiteSVM tests + property test; `docs/spec.md` v3; `docs/audit.md` GF-14..20.
- Identity service: async store with persons, versioned credential fingerprints (`PERSON_HASH_SECRETS` rotation re-links people), credential linking (`/api/identity/link`), reviewed recovery (`RECOVERY_REVIEW_SECONDS`), bans that revoke every wallet of a person. `docs/identity.md`.
- Sponsor proxy policy (`sponsor-policy.ts`): transactions decoded and checked before Kora; per-wallet caps. `scripts/member.ts` fallback CLI. Cranker: claims, expired requests, due recoveries, `--dry-run`.
- Economics model with cost split, balance sheet, trajectory, subsidy per completed loan and bounded stress cases; `docs/economics.md` regenerated. Licence switched to Apache-2.0 with a name notice. White paper v3.
- Launch readiness: `scripts/program-id.sh` (own program keypair, `anchor keys sync`, build, codegen; the app's default id comes from the generated client), `scripts/launch.json` + `launch.ts` (idempotent gatekeeper network and pool with the decided settings; CI creates the fork pool with it), `scripts/admin.ts` (the authority's CLI; e2e drives pause, schedule, apply, suspend-issuer and freeze through it), `/api/health` + `server-env.ts`, `app/Dockerfile` (standalone), `deploy/cranker.Dockerfile`, `deploy/kora.Dockerfile`, `deploy/docker-compose.yml` (+ Postgres profile), a CI `docker` job that builds the app and cranker images and reads the health route, `PgStore` selected by `IDENTITY_DB_URL` with the store tests on Postgres in CI, `docs/launch.md`, `docs/operations.md`.

## Done
- Program (Anchor 1.2.1): two-step loans (`request_loan` → `cosign_loan`, `cancel_request`), co-signer escrow, repay, default. 39 LiteSVM + property tests, clippy clean. Internal audit in `docs/audit.md`.
- Build with `anchor build --arch v2` — devnet does not enable SBPF v3.
- Web app (`app/`): checking, borrow, co-sign, repay, donate, fund stats; Kora fee payer; canonical pool pinning.
- End-to-end on a Surfpool devnet fork (`scripts/`): full loan cycle passes; real Civic gateway token bytes parse correctly (`scripts/civic-token.json`); Kora sponsorship works (users pay $0, including `register_member`).
- White paper (`docs/whitepaper.md`). License: proprietary, Kiarash Adl.

- `register_member` has a separate `payer` signer (Kora covers member rent). Hydration error #418 fixed (`useMounted` in `app/src/lib/hooks.ts`). `scripts/` reproducible with its own `package.json`; re-deploying to a fork may need `solana program extend <id> 10240` first.
- CI (`.github/workflows/ci.yml`): cargo fmt + clippy on the program crate; lint, typecheck, Prettier, vitest and `next build` on the app. Program tests still run locally only (they need the Anchor-built `.so`).

## Completed this pass (app, CI, hygiene; no program change)
- Config is validated at startup (`app/src/lib/config.ts`): bad `NEXT_PUBLIC_*` values show the red banner instead of crashing, and a wrong cluster no longer silently means mainnet.
- Co-sign inbox is scoped to the pinned pool (request PDA check); co-sign links with a bad key or another pool are refused instead of crashing.
- `friendlyError` no longer reports a failed `cancel_request` simulation as "You cancelled".
- Repay page shows every loan (borrowed or co-signed, including repaid and defaulted) with due/overdue/grace status, and lets anyone mark a loan past its grace period as defaulted (`markDefaultIx`; confirmation explains the consequences). Loans load with `getProgramAccounts` instead of scanning ids.
- Success notices survive the request account closing (co-sign, decline, cancel). "Pay all" is bigint only.
- Client-side checks before signing: co-signer membership/hold/guarantee limit on Borrow; hold, limit and escrow balance on Co-sign; balance and self-send on Checking.
- Accessibility: field errors linked to inputs, live regions for notices, keyboard-safe wallet menu, `aria-current` nav, Join and Co-sign in the nav.
- Next 16 conventions: per-route titles, `error.tsx` (`retry`), `not-found.tsx`, `loading.tsx`, app icon.
- `@civic/solana-gateway-ts` declared (it was only a transitive dependency). Prettier config and format check. 27 unit tests.
- Smoke passes 7/7 on a production build.

## Verified end to end (this session)
- Toolchain installed in a clean Linux container with `scripts/toolchain.sh` (Solana 4.3.2, Anchor 1.2.1 prebuilt, Surfpool 1.6.1); `anchor build --arch v2` works with the declared program id even though the original keypair is absent.
- Program: 39 Rust LiteSVM + property tests pass; `cargo clippy --all-targets` clean.
- App: `cd app && npm run test:svm` runs 14 scenarios that send the app's own instruction builders through `tx.ts` into LiteSVM (`app/src/lib/onchain.svm.test.ts`): pool pinning, donate, register (incl. sponsored payer), pool-scoped co-sign inbox across two pools, co-sign term binding, repay, loan history, cancel, mark-default and the exact grace boundary against `loanTiming`.
- Surfpool fork: `npm run deploy-fork` plants the `.so` at the declared id (`surfnet_writeProgram`); `npm run gatekeeper-setup` creates the fund's gatekeeper network; `npm run e2e` passes with the cancel, wallet-replacement, timelock, issuer-suspension, wind-down and `freeze_pool` rows on tokens issued by the real gateway program; `identity-e2e` and `cranker-e2e` cover the issuer service and the operator job against the running app.
- CI: `program-tests` (Anchor build, Rust suite, clippy, `test:svm`), `app` (lint, types, Prettier, unit tests, build, audit, Playwright smoke) on every push and PR; `e2e` (Surfpool fork, loan cycle, Kora direct and through the sponsor proxy with auth, smoke) on `main` and manual dispatch. Toolchain and Kora cached.

## Completed: program additions and Kora hardening
- Program: two-step authority handover (`propose_authority` / `accept_authority` / `cancel_authority_proposal`; freeze clears it), richer events, parameter bounds, 48 tests (the review's missing error paths), `docs/audit.md` GF-08/GF-09, client regenerated. Hand the pool to the Squads vault with propose (owner key) + accept (vault transaction), then update `NEXT_PUBLIC_POOL_AUTHORITY`.
- Kora: `app/api/sponsor` proxy (credentials server-side, three methods, per-client rate limit), hardened client (timeouts, typed errors, `signer_key`, cached payer with backoff), "Fees covered" badge, rent copy when unsponsored, Checking send never sponsors a stranger's token account, `kora.toml` sized for a first co-sign (7,000,000 lamports) and validated with `kora config validate`, `kora-e2e` rewritten on the app's real path.
- Hosting plan for the sponsor: Kora behind the proxy only (its CORS is allow-any), HMAC secret in both environments, Turnkey/Privy signer, metrics on port 8081 with the fee-payer balance gauge, alert when the payer drops below ~0.5 SOL. Permanent cost per loan is the Loan rent (~0.002 SOL) plus ~0.0014 SOL per new member; request and escrow rents come back.

## Re-evaluated (this session)
- Flipped: Surfpool + Kora e2e in CI (main + dispatch), the sponsor proxy exercised live with HMAC and an API key, Playwright smoke in CI, a public "Recent loans" list on `/fund`, `npm audit` gate at high severity with `overrides` for `jayson`/`uuid`.
- Kept: no request expiry, no `close_loan`, no component tests, devnet deploy on hold until the deploy key is funded. Ineligibility stays permanent for a borrower; a co-signer whose escrow covered the loss keeps their standing (v2).

## Completed: version 2 (people not wallets, own identity issuer, timelocked governance, operations)
- Program: `Person` accounts carry eligibility; `register_member(person_hash)` and `rebind_wallet` are issuer-signed; settings change through `schedule_params` → `apply_params` after `timelock_seconds`; `suspend_issuer`; wind-down with a successor and `sweep_to_successor`; the co-signer is barred only when the fund lost money. 59 LiteSVM tests + property test; `docs/spec.md` rewritten; `docs/audit.md` GF-10..13.
- Identity issuer (`app/src/lib/identity`, `/api/identity/*`): Persona behind a provider interface (mock for tests), keyed person hash, SQLite/memory store, gatekeeper issuance on our own network, issuer-signed join and wallet replacement, ban route. Civic React client removed. `scripts/gatekeeper-setup`, `identity-e2e`.
- Operations: `scripts/cranker.ts` (defaults, apply, sweep, bans), `scripts/model.ts` + `docs/economics.md`, `cranker-e2e`. White paper v2 (`docs/whitepaper.md`).

## Then
- Persona production mode: create the inquiry template (government ID + address), confirm the field keys in `app/src/lib/identity/persona.ts` against a sandbox inquiry, set `PERSONA_*`, `PERSON_HASH_SECRET`, `ISSUER_SECRET` and `GATEKEEPER_SECRET` (separate keys from the pool authority), point the webhook at `/api/identity/webhook`.
- Devnet deploy: needs ~3 devnet SOL in `2agNDw6soEttnATLgkhxup22GGoeCa7KVNfxyeeuHbve` (airdrops were rate-limited; owner to send from faucet.solana.com via GitHub login). Then `gatekeeper-setup` on devnet, init the pool with the launch params in `docs/spec.md` (v3: $500 max, $150 first-loan cap, $100 step, 30-day cooldown, $1,000 exposure, $5,000/day disbursement cap, 7-day notice, 3-day recovery delay, 7-day request TTL, bans 2 years / 90 days / 1 year, separate issuer, recovery and pause keys, devnet USDC), host the app with the identity env and run the cranker on a schedule (`npm run cranker -- --once` from cron, or `--interval`).
- A multisig of independent people as pool authority and a separate one as program upgrade authority (behind its own timelock) before mainnet; the pilot is upgradeable and capped, immutability comes later.
- Host the app (goodfaith.fi, register the domain) and Kora; Postgres instead of SQLite if the identity service runs on more than one instance.
- Fill the white paper's verification appendix at each deploy (program id, tag, build hash, upgrade authority, keys).
- Independent audit before mainnet; legal review of the open questions listed in the white paper.

## Environment notes
- PATH: `$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin`.
- Toolchain: `bash scripts/toolchain.sh` on Linux (Solana CLI 4.3.2 tarball, Anchor 1.2.1 prebuilt binary, Surfpool 1.6.1; `--with-kora` for kora-cli 2.0.5). On macOS: Solana CLI (needs `brew install libusb`), Anchor 1.2.1 via avm, Surfpool 1.6.1.
- Local fork: `surfpool start --network devnet --no-tui --no-deploy -a $(solana address) -q 100000000000`, then `cd scripts && npm run deploy-fork` (no program keypair needed).
- Kora config needs `[kora.cache]` TTLs and system create/assign/allocate allowed (see `scripts/kora/`). Private key via `KORA_PRIVATE_KEY` env only.
