# Next steps (handoff)

State as of 2026-10-23. Read `README.md`, `docs/spec.md` (incl. "Launch parameters (decided)"), `docs/audit.md` first.

## Done
- Program (Anchor 1.2.1): two-step loans (`request_loan` → `cosign_loan`, `cancel_request`), co-signer escrow, repay, default. 39 LiteSVM + property tests, clippy clean. Internal audit in `docs/audit.md`.
- Build with `anchor build --arch v2` — devnet does not enable SBPF v3.
- Web app (`app/`): checking, borrow, co-sign, repay, donate, fund stats; Kora fee payer; canonical pool pinning.
- End-to-end on a Surfpool devnet fork (`scripts/`): full loan cycle passes; real Civic gateway token bytes parse correctly (`scripts/civic-token.json`); Kora sponsorship works (users pay $0, including `register_member`).
- White paper (`docs/whitepaper.md`). License: proprietary, Kiarash Adl.

## Completed last session
1. `register_member` has a separate `payer` signer (Kora covers member rent); app and scripts updated; 39 tests, clippy clean.
2. Hydration error #418 fixed: wallet state (a client singleton that may already be ready at hydration) is now hidden until after mount (`useMounted` in `app/src/lib/hooks.ts`, used by `useApp` and the connect gate). Smoke passes 5/5.
3. `scripts/` reproducible: own `package.json` (`tsx`, `playwright-core`, `@solana/kit`), `npm run e2e|kora-e2e|smoke`, `scripts/README.md`.
Re-deploying to a fork may need `solana program extend <id> 10240` first.

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
- Toolchain: Solana CLI 4.3.1 (needs `brew install libusb` on macOS), Anchor 1.2.1 via avm, Surfpool 1.6.1, kora-cli 2.0.5.
- Local fork: `surfpool start --network devnet --no-tui --no-deploy -a $(solana address) -q 100000000000`.
- Kora config needs `[kora.cache]` TTLs and system create/assign/allocate allowed (see `scripts/kora/`). Private key via `KORA_PRIVATE_KEY` env only.
