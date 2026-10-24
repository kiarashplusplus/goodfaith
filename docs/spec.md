# Good Faith — Program Spec (v3, devnet)

Interest-free, fee-free loans from a donated loan fund. Borrowers repay exactly what they borrowed. Each loan needs a co-signer who puts part of the loan amount in escrow. Texas residents only, verified by the fund's own identity issuer, which vouches for one person per wallet on chain.

Plain English everywhere: no religious or non-English finance terms in code, UI or docs.

## Program `goodfaith` (Anchor 1.x, SPL Token via `token_interface`)

### Accounts

**Pool** — PDA `["pool", mint]`
| field | type | notes |
|---|---|---|
| authority | Option<Pubkey> | schedules settings changes, handovers and the wind-down; resumes lending; None once frozen |
| mint | Pubkey | loan token (devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) |
| vault | Pubkey | token account, PDA `["vault", pool]`, authority = pool |
| gatekeeper_network | Pubkey | the fund's own gatekeeper network on the Identity.com gateway program |
| max_loan | u64 | per-loan cap, base units |
| max_term_days | u16 | ≤ 3650 |
| grace_days | u16 | ≤ 365 |
| max_guarantees_per_member | u8 | per person |
| cosigner_escrow_bps | u16 | 0..=10000, default 2500 |
| loan_count | u64 | next loan id |
| total_donated, total_lent, total_repaid, total_recovered, total_lost | u64 | stats |
| bump, vault_bump | u8 | |
| pending_authority | Option<Pubkey> | key named by `propose_authority`, cleared on accept, cancel or freeze |
| issuer | Pubkey | key that co-signs `register_member` and `propose_rebind`; the zero key means suspended |
| timelock_seconds | i64 | 0..=90 days; delay between scheduling a change (or a wind-down) and its effect |
| pending_params | Option<PoolParams> | scheduled by `schedule_params`, applied by anyone with `apply_params` |
| params_effective_at | i64 | |
| wind_down_at | Option<i64> | once set and reached: no new loans or donations |
| successor | Option<Pubkey> | token account of the pool mint that receives the vault balance |
| active_loans | u64 | loans currently Active |
| total_swept | u64 | moved to the successor |
| recovery_authority | Pubkey | second signer of `propose_rebind`, beside the issuer |
| pause_authority | Pubkey | may `pause_lending` at once (the authority may too) |
| paused | bool | no new requests or co-signs while true |
| window_start, window_disbursed | i64, u64 | the current disbursement window and what was lent in it |
| pending_claims | u64 | Σ `refund_pending` over closed loans: escrow owed to co-signers, waiting in escrow accounts |
| recovery_delay_seconds | i64 | 0..=30 days; veto window of a wallet recovery |
| request_ttl_seconds | i64 | 1 s..=90 days; a request expires after this |
| first_loan_cap | u64 | the cap for a new or recovered membership during the cooldown, and the base of the graduated cap |
| loan_cap_step | u64 | the cap grows by this per loan repaid on time, up to `max_loan` |
| cooldown_seconds | i64 | 0..=365 days; how long a new or recovered membership stays on `first_loan_cap` |
| max_exposure_per_person | u64 | open principal borrowed plus principal guaranteed, per person |
| disbursement_window_seconds | i64 | 1 s..=30 days |
| disbursement_cap_per_window | u64 | principal the pool lends per window; 0 = no cap |
| default_ban_seconds, late_ban_seconds, cosigner_ban_seconds | i64 | ≥ 0; `i64::MAX` = for good; 0 = no bar |

**PoolParams** (argument of `initialize_pool` and `schedule_params`): every settings field above from `gatekeeper_network` to `cosigner_ban_seconds` (twenty-one fields). `validate()`: bps ≤ 10000; max_loan, max_term_days, max_guarantees_per_member, first_loan_cap, max_exposure_per_person > 0; max_term_days ≤ 3650; grace_days ≤ 365; timelock 0..=90 d; recovery delay 0..=30 d; request TTL 1 s..=90 d; cooldown 0..=365 d; window 1 s..=30 d; the three bans ≥ 0.

**Person** — PDA `["person", pool, person_id]`. One verified human. Eligibility, the open loan, the guarantees and the loan cap live here, so they follow the person across wallets.
| person_id | [u8; 32] | opaque id drawn at random by the issuer service; the credential behind it never reaches the chain |
| wallet | Pubkey | the wallet currently bound to this person |
| active_loan | Option<Pubkey> |
| active_guarantees | u8 |
| active_guarantee_amount | u64 | principal of the Active loans this person co-signs |
| completed_loans | u16 | loans repaid on time (RepaidLate does not count) |
| ineligible_until | i64 | 0 eligible; `i64::MAX` barred for good; else barred until this time. `eligible(now) = now ≥ ineligible_until` |
| restricted_until | i64 | until this time the person is on `first_loan_cap` |
| pending_wallet | Option<Pubkey> | a recovery in flight: the wallet the person moves to |
| pending_wallet_at | i64 | when `finalize_rebind` may run |
| bump | u8 |

`loan_cap(pool, now) = min(max_loan, first_loan_cap)` while `now < restricted_until`, else `min(max_loan, first_loan_cap + completed_loans × loan_cap_step)`. `bar(now, seconds)` sets `ineligible_until = max(ineligible_until, now + seconds)` and is a no-op for 0: a bar is never shortened by a later, lighter one.

**Member** — PDA `["member", pool, wallet]`. Wallet → person link. Never closed, so a wallet can never be bound to a second person.
| wallet | Pubkey |
| person | Pubkey |
| retired | bool | true once the wallet was replaced |
| bump | u8 |

**Loan** — PDA `["loan", pool, loan_id.to_le_bytes()]`, 237 bytes
| id | u64 |
| borrower, cosigner | Pubkey | the wallets at opening |
| rent_payer | Pubkey (gets rent back when escrow closes) |
| principal, repaid, escrowed | u64 |
| opened_at, due_at | i64 (unix seconds) |
| grace_days | u16 | fixed at opening |
| status | enum { Active, Repaid, Defaulted, RepaidLate } |
| bump, escrow_bump | u8 |
| borrower_person, cosigner_person | Pubkey | the people behind the wallets (memcmp offsets 157 and 189) |
| closed_at | i64 | when the loan left Active (0 while open) |
| refund_pending | u64 | escrow owed to the co-signer, still in the escrow account until `claim_escrow` |

`deadline = due_at + grace_days × 86400`: the last second at which a repayment is on time.

**LoanRequest** — PDA `["request", pool, borrower]`
| borrower, cosigner | Pubkey |
| amount | u64 |
| term_days | u16 |
| created_at | i64 |
| rent_payer | Pubkey |
| bump | u8 |
| expires_at | i64 | `created_at + request_ttl_seconds`; not co-signable after, closable by anyone |

**Escrow** — token account PDA `["escrow", loan]`, authority = pool.

### Instructions

Fund setup and governance
1. `initialize_pool(params)` — payer becomes authority; creates Pool + vault; applies `params` at once (the only instant settings change, and the only way to run with a notice period below the minimum: such a pool is a test pool). Classic SPL Token mints only. `paused = false`, `window_start = now`.
2. `schedule_params(params)` — authority only; validates; `params.timelock_seconds ≥ min(MIN_TIMELOCK_SECONDS (2 days), pool.timelock_seconds)` else `TimelockBelowMinimum`, so a pool that runs with at least two days of notice can never schedule less; records `pending_params` with `params_effective_at = now + timelock_seconds` (the timelock in force now, so lowering the timelock waits the old delay). Rescheduling replaces the pending change. `cancel_params()` — authority only; `NothingPending` if none. `apply_params()` — anyone, once `now ≥ params_effective_at` (`TimelockNotElapsed` before); re-validates and applies; emits `PoolUpdated`.
3. `freeze_pool()` — authority only, irreversible: authority = None, clears `pending_authority` and `pending_params`. An announced wind-down stays. A frozen pool can still be paused by the pause authority but never resumed.
4. `propose_authority(new)` / `cancel_authority_proposal()` / `accept_authority()` — two-step handover; `new` may not be the zero key or the current authority.
5. `suspend_issuer()` — authority only, instant: `issuer = zero key`. No registrations or recovery proposals until a new issuer is applied through `schedule_params`. Existing members are unaffected.
6. `pause_lending()` — `pause_authority` or authority, instant: `paused = true`; `request_loan` and `cosign_loan` refuse with `Paused`; everything else (repay, default, claims, cancel, expiry, recovery, donate, governance) continues. `resume_lending()` — authority only.
7. `announce_wind_down()` — authority only; account `successor_vault` must hold the pool mint and must not be owned by the pool PDA (so not the vault or an escrow). Sets `wind_down_at = now + timelock_seconds`, `successor`. Refused while one is already announced. `cancel_wind_down()` — authority only, only before `wind_down_at`.
8. `sweep_to_successor()` — anyone; requires the wind-down to be in effect (`NotWindingDown`), `active_loans == 0` (`LoansOutstanding`), a vault balance > 0 and `successor_vault == pool.successor`. Moves the whole vault balance; `total_swept += amount`; repeatable. Pending claims sit in escrow accounts, not the vault, so they never hold a sweep up and stay claimable afterwards.

Once a wind-down is in effect: `donate`, `request_loan` and `cosign_loan` refuse with `WindingDown`; everything else continues.

Membership and recovery
9. `register_member(person_id)` — signers: wallet, payer (rent; fee sponsor, may equal wallet), issuer (`== pool.issuer`, else `Unauthorized`). Requires a valid gateway token for the wallet. Creates Person (`init`, so a second wallet for the same id fails) and Member (`init`, so a second person for the same wallet fails). `restricted_until = now + cooldown_seconds`.
10. `propose_rebind()` — signers: new_wallet, issuer, recovery_authority (`== pool.recovery_authority`). The old wallet does not sign (lost keys). `person` is self-seeded; `pending_wallet` must be None (`RecoveryPending`); `new_wallet ≠ person.wallet`; a valid gateway token for the new wallet. Records `pending_wallet = new_wallet`, `pending_wallet_at = now + recovery_delay_seconds`. Nothing else changes: the old wallet keeps working.
11. `veto_rebind()` — signer: `person.wallet` (the old wallet) or the authority; requires a pending recovery (`RecoveryNotPending`). Clears it.
12. `finalize_rebind()` — anyone (payer covers the new Member's rent), once `now ≥ pending_wallet_at` (`RecoveryDelayNotElapsed`). `old_member` is the Member of `person.wallet` and must not be retired; `new_member` is created for `pending_wallet` (`init`: a wallet that already belongs to anyone, retired or not, is refused). Retires the old Member, `person.wallet = pending_wallet`, clears the pending fields, `restricted_until = now + cooldown_seconds`. Open loans, guarantees and eligibility stay with the person; escrow claims go to the person's current wallet.

Money
13. `donate(amount)` — any signer; donor token account → vault. Non-refundable. amount > 0. Refused while winding down.
14. `request_loan(amount, term_days, cosigner)` — signers: borrower, payer. Refused when `paused` or winding down. `borrower_person` (self-seeded, `wallet == borrower`, else `WalletNotBound`) eligible now (`Ineligible`), no active loan, gateway token valid. `cosigner_member` (PDA of `cosigner`) must exist, not be retired (`WalletRetired`) and belong to a different person (`SelfCosign`). 0 < amount ≤ `loan_cap` (`OverPersonalCap`) ≤ max_loan; `amount + active_guarantee_amount ≤ max_exposure_per_person` (`OverExposure`); 0 < term_days ≤ max_term_days. Creates LoanRequest with `expires_at` (one open request per borrower). No funds move.
15. `cosign_loan(expected_amount, expected_term_days, max_escrow)` — signers: the named co-signer, payer. Refused when paused, winding down or `now > expires_at` (`RequestExpired`). Both Persons (self-seeded; `wallet` must match the request's borrower and the signing co-signer), distinct, eligible now, gateway tokens valid, borrower has no active loan and is within `loan_cap` and exposure, co-signer below `max_guarantees_per_member` and within exposure (`active loan principal + active_guarantee_amount + amount ≤ max_exposure_per_person`); no direct reciprocity: when `cosigner_person.active_loan` is Some, that loan must be passed as `cosigner_active_loan` (`MissingCosignerLoan`) and its `cosigner_person` must not be this borrower (`ReciprocalGuarantee`); request must still match the approved terms (`RequestMismatch`) and the escrow may not exceed `max_escrow` (`EscrowTooHigh`); amount/term within current limits; vault ≥ amount; disbursement window: when `now ≥ window_start + disbursement_window_seconds` the window rolls (`window_start = now`, `window_disbursed = 0`), then `window_disbursed + amount ≤ disbursement_cap_per_window` unless the cap is 0 (`OverDisbursementCap`).
   - escrow = ceil(amount × bps / 10000) moved co-signer → escrow; vault → borrower `amount`. Loan created with id = loan_count (grace_days copied from the pool, persons recorded, `closed_at = 0`, `refund_pending = 0`), loan_count += 1, `active_loans += 1`, `window_disbursed += amount`, co-signer `active_guarantees += 1`, `active_guarantee_amount += amount`. LoanRequest closed to its rent_payer.
16. `cancel_request()` — borrower or the named co-signer signs; closes LoanRequest to its rent_payer. `close_expired_request()` — anyone, once `now > expires_at` (`RequestNotExpired`); closes it to its rent_payer.
17. `repay(amount)` — any signer pays from own token account → vault; 0 < amount ≤ principal − repaid; loan Active. Persons pinned by `loan.borrower_person` / `loan.cosigner_person`. No co-signer token account is touched. When fully repaid: `late = now > deadline`; status `Repaid` (and borrower `completed_loans += 1`) or `RepaidLate` (and borrower barred for `late_ban_seconds`); `closed_at = now`; `active_loan = None`; co-signer `active_guarantees −= 1`, `active_guarantee_amount −= principal`; `active_loans −= 1`; the whole escrow balance becomes `refund_pending` (`pending_claims += it`); when the escrow is empty it is closed to `rent_payer` at once.
18. `mark_default()` — anyone, only when Active and `now > deadline`.
    - shortfall = principal − repaid; recovered = min(escrow balance, shortfall) → vault; the rest stays in the escrow as `refund_pending` (`pending_claims += it`), or the escrow is closed to `rent_payer` when nothing is left.
    - Defaulted; `closed_at = now`; borrower barred for `default_ban_seconds`; co-signer barred for `cosigner_ban_seconds` only if `lost = shortfall − recovered > 0`; guarantees and amount decremented; `active_loans −= 1`; `total_recovered += recovered`; `total_lost += lost`. `LoanDefaulted` carries both `ineligible_until` values and `cosigner_barred`.
    - A late repayment and a default give the same financial result whichever lands first: the fund gets what is owed either way, the escrow leftover is owed to the co-signer either way; the only difference is the borrower's bar (late versus default) and the `completed_loans` count.
19. `claim_escrow()` — anyone; loan not Active (`LoanNotActive`), `refund_pending > 0` (`NothingToClaim`); `cosigner_token` must be owned by `cosigner_person.wallet` (the current wallet) and hold the pool mint. Transfers `refund_pending`, closes the escrow to `rent_payer`, `pending_claims −= it`, `refund_pending = 0`. A frozen or closed co-signer token account therefore never blocks a loan from closing; the claim simply waits until an account exists.

Rules: checked math only; every token account constrained by mint and owner; no fee, interest or penalty fields anywhere. One event per instruction: `PoolInitialized`, `ParamsScheduled`, `ParamsCancelled`, `PoolUpdated`, `PoolFrozen`, `AuthorityProposed`, `AuthorityProposalCancelled`, `AuthorityChanged`, `IssuerSuspended`, `LendingPaused`, `LendingResumed`, `WindDownAnnounced`, `WindDownCancelled`, `SweptToSuccessor`, `Donated`, `MemberRegistered` (wallet, person), `RebindProposed` (old wallet, new wallet, effective_at), `RebindVetoed` (by), `WalletRebound`, `LoanRequested` (expires_at), `RequestCancelled`, `RequestExpiredClosed`, `LoanOpened` (wallets and persons), `Repaid` (late, refund_pending), `LoanDefaulted` (both bars), `EscrowClaimed`.

Who pays rent and who gets it back: the request's rent to whoever made it (borrower, or the sponsor when sponsored), returned on co-sign, cancel or expiry close; the Loan account's rent to the co-sign payer, never returned (loans are permanent records); the escrow's rent to the co-sign payer, returned when the escrow closes (at settlement if nothing is owed, else at the claim); Person and Member rent to the registration payer, never returned; a token account created for a borrower or co-signer by a sponsored transaction belongs to its owner, who can close it.

### Gateway token check (`gateway.rs`)
The fund runs its own gatekeeper network on the Identity.com gateway program (`gatem74V238djXdzWnJf94Wo1DcnuGkfijbf3AuBhfs`); the issuer service is the gatekeeper and issues a token to a wallet after a successful identity check. The program parses the token account (Borsh: version, parent, owner_wallet, owner_identity, gatekeeper_network, issuing_gatekeeper, state, expire_time): owner program = gateway program, `owner_wallet` = the wallet, `gatekeeper_network` = `pool.gatekeeper_network`, state Active, expiry None or > now. Tests plant such accounts in LiteSVM and on the fork.

### Errors (in order, Anchor codes from 6000)
AmountZero, OverLoanCap, TermTooLong, SelfCosign, BorrowerHasLoan, CosignerLimit, Ineligible, InvalidGatewayToken, InsufficientFund, OverRepay, LoanNotActive, NotYetDefaultable, Unauthorized, InvalidBps, MathOverflow, RequestMismatch, EscrowTooHigh, InvalidParams, WalletNotBound, WalletRetired, WindingDown, NotWindingDown, TimelockNotElapsed, NothingPending, LoansOutstanding, InvalidSuccessor (6025), Paused (6026), RequestExpired, RequestNotExpired, OverPersonalCap, OverExposure, OverDisbursementCap, ReciprocalGuarantee, RecoveryPending, RecoveryNotPending, RecoveryDelayNotElapsed, NothingToClaim, TimelockBelowMinimum, MissingCosignerLoan (6038).

### Authority table
| key | may | delay | cannot |
|---|---|---|---|
| authority (operator multisig) | schedule, cancel and (anyone) apply settings; propose a handover; suspend the issuer; pause and resume lending; announce or cancel a wind-down; veto a recovery; freeze | settings and wind-down: `timelock_seconds` (≥ 2 days once above it); the rest instant | move funds (except the vault to the announced successor after the notice period with no open loan); touch an open loan; shorten a notice period below the minimum |
| pause_authority | pause lending | instant | resume; anything else |
| issuer | co-sign registrations and recovery proposals | none, but a proposal waits `recovery_delay_seconds` and needs the recovery authority too | move funds; move a membership alone; skip the veto window |
| recovery_authority | co-sign recovery proposals | as above | anything alone |
| upgrade authority (program) | replace the program code | none on chain during the pilot; to be a separate multisig behind its own timelock; removed later | — |
| anyone | apply a due change; finalize a due recovery; close an expired request; repay; mark a default; claim an escrow; sweep after a wind-down | by the rules above | — |

## Web app `app/` (Next.js, TypeScript)
Uses the Codama client generated from `target/idl/goodfaith.json` (`npm run codegen`). Pages: wallet (balance, send/receive with Solana Pay QR, history), Borrow (identity check → join → request → co-signer link → submit), Co-sign, Repay (with "Release escrow" for closed loans), Donate, Fund stats. Kora as fee payer behind the app's own proxy and policy so users pay $0. Registration and recovery are prepared server-side by the identity issuer (`docs/identity.md`) and finished by the wallet. `scripts/member.ts` is the fallback client; `scripts/cranker.ts` the operator's scheduled job (defaults, claims, expired requests, due recoveries, due settings, sweep, bans).

## Launch parameters (decided; owner may change at review)
- Loan token: USDC (6 decimals).
- `max_loan` $500, `max_term_days` 180, `grace_days` 30, `cosigner_escrow_bps` 2500, `max_guarantees_per_member` 2.
- `timelock_seconds` 7 days; `recovery_delay_seconds` 3 days; `request_ttl_seconds` 7 days.
- `first_loan_cap` $150, `loan_cap_step` $100, `cooldown_seconds` 30 days, `max_exposure_per_person` $1,000.
- `disbursement_window_seconds` 1 day, `disbursement_cap_per_window` $5,000.
- `default_ban_seconds` 2 years, `late_ban_seconds` 90 days, `cosigner_ban_seconds` 1 year.
- Keys: authority = a multisig of independent people; `pause_authority`, `issuer`, `recovery_authority`, the gatekeeper and the program upgrade authority are separate keys held by different people where the deployment allows.
- Release: a capped pilot, upgradeable under the multisig with a timelock; immutability later, once the pilot has run.
- Presentation: neutral. Defaults: no collections, no credit reporting, no legal action. Identity: the fund's own gatekeeper network; government ID and Texas residency checked by the issuer service's provider (Persona).
- Funding: owner seeds the fund.
