# Good Faith program: internal security review

This is an internal review. An independent audit is recommended before any mainnet deployment.

## Scope
`programs/goodfaith` (Anchor 1.2.1), all ten instructions, `gateway.rs`, checked against `docs/spec.md`. The `app/` directory is out of scope.

## Method and tools
- `cargo clippy --all-targets -- -D warnings` (clippy 0.1.99): clean.
- `cargo audit` 0.22.2: no vulnerabilities. Five "unmaintained" warnings in transitive dependencies (ansi_term, bincode 1.3.3, derivative, libsecp256k1, paste), all pulled in by the Solana and Anchor stacks.
- Manual line-by-line review of every instruction: signers, owners, PDA seeds and stored bumps, account substitution, duplicate mutable accounts, arithmetic, close handling, permissionless paths, stale state.
- Civic gateway layout re-checked against `identity-com/on-chain-identity-gateway` (`solana/program/src/state.rs`).
- Property tests: Trident (stable 0.12.0, 0.13.0-rc.4 pre-release) was not attempted. It needs its own harness and fuzz workspace and its Anchor 1.2.1 support is unconfirmed, so I wrote proptest 1.x property tests over LiteSVM 0.18.1 instead (`props::invariants_hold`, 24 random sequences of up to 40 operations, including pool updates and clock jumps). Run more cases with `PROPTEST_CASES=...`.

## Findings
| ID | Severity | Description | Status | Test |
|---|---|---|---|---|
| GF-01 | Medium | `cosign_loan` did not bind the co-signer's signature to the terms they saw. The borrower could cancel and re-request a larger amount or term before the co-signer's transaction landed, and the pool authority could raise the escrow rate in the same window. | Fixed: `cosign_loan(expected_amount, expected_term_days, max_escrow)`; new errors `RequestMismatch`, `EscrowTooHigh` | `audit_cosign_binds_to_approved_terms` |
| GF-02 | Medium | `update_pool` changed `grace_days` retroactively. The authority could set it to 0 and make open loans defaultable at once, seizing co-signer escrow. | Fixed: grace period is stored on the loan at open (`Loan.grace_days`) and `mark_default` uses it | `audit_grace_period_is_fixed_at_open` |
| GF-03 | Medium | Token-2022 mints (transfer fee, transfer hook, permanent delegate, pausable, etc.) were accepted and would break vault and escrow accounting. | Fixed: `initialize_pool` accepts only a classic SPL Token mint and the classic token program | `audit_pool_rejects_token_2022_mints` |
| GF-04 | Low | `repay` failed with a duplicate-mutable-account error when the co-signer repaid from the same token account that receives the escrow refund. | Fixed: `dup` on `cosigner_token` (the two transfers run in order, so it is safe) | `audit_lowering_limits_mid_loan_keeps_loan_repayable`, `audit_escrow_topup_and_prefunded_pdas_do_not_block` |
| GF-05 | Low | Pool PDA is `["pool", mint]`, so the first caller of `initialize_pool` for a mint becomes its authority and fixes the gatekeeper network. A squatter could pre-empt the official pool. | Accepted (spec-mandated seeds). Mitigation: initialize in the deployment transaction batch; the app must pin the canonical pool address and check `authority` and `gatekeeper_network`. | none |
| GF-06 | Info | Mints with a freeze authority (e.g. devnet and mainnet USDC) let the issuer freeze the vault or an escrow, blocking loans, repayments or defaults. | Accepted, residual risk | none |
| GF-07 | Info | The authority can change `gatekeeper_network`, `max_loan`, `max_term_days`, `max_guarantees_per_member` and `cosigner_escrow_bps` for future loans until `freeze_pool`. It cannot move funds. Lowered limits never block repayment of an open loan. | By design | `audit_lowering_limits_mid_loan_keeps_loan_repayable`, `audit_frozen_pool_cannot_be_updated_or_refrozen` |

### Reviewed with no issue found
- Signer, owner and `has_one`-style checks: every authority path is a `Signer` plus a key constraint (`pool.authority`, `request.cosigner`, `request.borrower`, `loan.*`). `freeze_pool` sets `authority = None`, and no instruction can set it again, so it is irreversible.
- PDA seeds use the canonical bump stored at creation (`pool.bump`, `loan.bump`, `loan.escrow_bump`, `member.bump`, `request.bump`).
- Account substitution: vault is pinned to `pool.vault`; escrow is a PDA of the loan; every token account is constrained by mint and authority; rent recipients are pinned to the stored `rent_payer`; the mint account must match the pool PDA seeds; token program is `Interface<TokenInterface>` (only the two real token programs).
- Duplicate accounts: borrower and co-signer differ (checked at request, preserved at cosign); `payer_token` cannot be the vault or escrow (their authority is the pool PDA, which cannot sign).
- Arithmetic: checked everywhere; the escrow ceiling is computed in u128 and is at most the loan amount because bps <= 10000.
- Close handling: loan accounts are never closed, loan ids never repeat, so escrows cannot be revived. Request accounts use Anchor `close`. Pre-funding a loan or escrow PDA with lamports, or sending extra tokens to an escrow, does not block cosign, repay or default (extra tokens go to the co-signer or the vault by the live balance).
- Permissionless calls: third-party repay and `mark_default` only move funds along the spec'd paths. Tiny repayments cost the caller only.
- Stale `LoanRequest`: eligibility, gateway tokens, limits, vault balance and active-loan state are re-checked at cosign time.

### Civic gateway (`gateway.rs`)
Verified against upstream: `GatewayToken` is Borsh with no discriminator, in this order: `version u8`, `parent_gateway_token Option<Pubkey>`, `owner_wallet`, `owner_identity Option<Pubkey>`, `gatekeeper_network`, `issuing_gatekeeper`, `state` (1 byte: Active=0, Frozen=1, Revoked=2), `expire_time Option<i64>`. Options use a 0/1 tag byte. `version` is always 0 and unused upstream. Expiry is only in `expire_time`; there are no other feature flags in the account. Token address derivation upstream is `find_program_address([owner, "gateway", 8-byte additional seed (zeros by default), network], gateway program)`. The program id in `gateway.rs` is the Civic one. The code does not recompute the PDA: it requires the account owner to be the gateway program and checks `owner_wallet` and `gatekeeper_network` from the data, which is equivalent to upstream's check and also accepts tokens issued with a non-zero seed. Trailing bytes are ignored. One small difference: upstream treats a token as valid when `now == expire_time`; this program requires `expiry > now` (stricter by one second, matching the spec). I could not fetch the integration crate source to re-confirm its exact check order, so that part rests on the account layout above.

## Interface changes
- `cosign_loan(expected_amount: u64, expected_term_days: u16, max_escrow: u64)`: new arguments (GF-01).
- `initialize_pool`: `token_program` is now fixed to the classic SPL Token program and `mint` must be a classic mint (GF-03). Account order unchanged.
- `Loan` has a new `grace_days: u16` field (before `status`), 2 bytes larger; regenerate the IDL and client types (GF-02).

## Invariants tested (`props::invariants_hold`, checked after every operation)
1. Vault balance == total_donated + total_repaid + total_recovered - total_lent.
2. Token conservation: vault + escrows + actor accounts equal the starting supply.
3. For every loan, repaid <= principal; Repaid loans have repaid == principal.
4. While a loan is Active its escrow account exists and holds exactly `loan.escrowed`; closed loans have no open escrow.
5. `active_guarantees` equals the number of Active loans the member co-signed (never underflows); `active_loan` matches the single Active loan the member borrowed, and no member has two.

The property test assumes no tokens are sent straight to the vault or an escrow; those are covered by a separate unit test.

## Residual risks
- GF-05 and GF-06 above.
- The authority is trusted until `freeze_pool` (GF-07). Freeze before real funds are accepted.
- Sybil resistance is only as strong as the Civic pass and the chosen gatekeeper network.
- A co-signer and borrower who collude can walk away with escrow-sized losses borne by the fund; the escrow is a deterrent, not full cover.
- Direct token transfers into the vault are not counted in `total_donated`.
- Dependencies carry unmaintained-crate warnings (see above); no known vulnerabilities at review time.
- Not fuzzed with Trident or coverage-guided tools; the property test is bounded.

## Statement
This is an internal review by the development team, not an independent audit. An independent audit is recommended before mainnet.
