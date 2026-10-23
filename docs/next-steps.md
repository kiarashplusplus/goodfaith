# Next steps (handoff)

State as of 2026-10-23. Read `README.md`, `docs/spec.md` (incl. "Launch parameters (decided)"), `docs/audit.md` first.

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
- Surfpool fork: `npm run deploy-fork` plants the `.so` at the declared id (`surfnet_writeProgram`); `npm run e2e` passes with the cancel, wallet-replacement, timelock, issuer-suspension, wind-down and `freeze_pool` rows.
- CI: `program-tests` (Anchor build, Rust suite, clippy, `test:svm`), `app` (lint, types, Prettier, unit tests, build, audit, Playwright smoke) on every push and PR; `e2e` (Surfpool fork, loan cycle, Kora direct and through the sponsor proxy with auth, smoke) on `main` and manual dispatch. Toolchain and Kora cached.

## Completed: program additions and Kora hardening
- Program: two-step authority handover (`propose_authority` / `accept_authority` / `cancel_authority_proposal`; freeze clears it), richer events, parameter bounds, 48 tests (the review's missing error paths), `docs/audit.md` GF-08/GF-09, client regenerated. Hand the pool to the Squads vault with propose (owner key) + accept (vault transaction), then update `NEXT_PUBLIC_POOL_AUTHORITY`.
- Kora: `app/api/sponsor` proxy (credentials server-side, three methods, per-client rate limit), hardened client (timeouts, typed errors, `signer_key`, cached payer with backoff), "Fees covered" badge, rent copy when unsponsored, Checking send never sponsors a stranger's token account, `kora.toml` sized for a first co-sign (7,000,000 lamports) and validated with `kora config validate`, `kora-e2e` rewritten on the app's real path.
- Hosting plan for the sponsor: Kora behind the proxy only (its CORS is allow-any), HMAC secret in both environments, Turnkey/Privy signer, metrics on port 8081 with the fee-payer balance gauge, alert when the payer drops below ~0.5 SOL. Permanent cost per loan is the Loan rent (~0.002 SOL) plus ~0.0014 SOL per new member; request and escrow rents come back.

## Re-evaluated (this session)
- Flipped: Surfpool + Kora e2e in CI (main + dispatch), the sponsor proxy exercised live with HMAC and an API key, Playwright smoke in CI, a public "Recent loans" list on `/fund`, `npm audit` gate at high severity with `overrides` for `jayson`/`uuid`.
- Kept: no request expiry, no `close_loan`, ineligibility permanent, no component tests, devnet deploy on hold until the deploy key is funded.

## Next: replace Civic with our own identity issuer (decided)
- Keep the on-chain gateway check as is (`programs/goodfaith/src/gateway.rs`); no program change.
- Create our own gatekeeper network on the Identity.com gateway program (`gatem74V238djXdzWnJf94Wo1DcnuGkfijbf3AuBhfs`); add our gatekeeper key. Set `pool.gatekeeper_network` to it.
- Small backend (e.g. Next.js route handlers or a separate service): user completes ID + selfie with **Persona** (free Starter: 500 gov ID checks/month; fallback **Didit**, 500/month free). On the provider's verified webhook, require ID issuing state = TX and age ≥ 18, then issue a gateway token to the user's wallet (expiry e.g. 1 year), Kora-paid.
- Store only: wallet, provider inquiry id, verified yes/no, state, timestamp. No document data.
- Replace the Civic React flow in the app (`app/src/components/civic-gate.tsx`, `verify-join.tsx`) with the Persona/Didit flow.
- Tests: gatekeeper issuance on the Surfpool fork; register_member with our network's token; webhook signature verification; non-TX ID rejected.

## Then
- Devnet deploy: needs ~3 devnet SOL in `2agNDw6soEttnATLgkhxup22GGoeCa7KVNfxyeeuHbve` (airdrops were rate-limited; owner to send from faucet.solana.com via GitHub login). Init pool with launch params ($500, 180 days, 30-day grace, 25% escrow, devnet USDC).
- Squads 2-of-3 multisig (three owner devices) as pool authority before mainnet; `freeze_pool` when rules settle.
- Host the app (goodfaith.fi, register the domain) and Kora.
- Independent audit before mainnet.

## Environment notes
- PATH: `$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin`.
- Toolchain: `bash scripts/toolchain.sh` on Linux (Solana CLI 4.3.2 tarball, Anchor 1.2.1 prebuilt binary, Surfpool 1.6.1; `--with-kora` for kora-cli 2.0.5). On macOS: Solana CLI (needs `brew install libusb`), Anchor 1.2.1 via avm, Surfpool 1.6.1.
- Local fork: `surfpool start --network devnet --no-tui --no-deploy -a $(solana address) -q 100000000000`, then `cd scripts && npm run deploy-fork` (no program keypair needed).
- Kora config needs `[kora.cache]` TTLs and system create/assign/allocate allowed (see `scripts/kora/`). Private key via `KORA_PRIVATE_KEY` env only.
