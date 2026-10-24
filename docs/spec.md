# Good Faith — Program Spec (v6, devnet)

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
| total_donated, total_lent, total_repaid, total_recovered, total_lost | u64 | stats; `total_lost` is the recognised loss: Σ over settled loans of the fund's loss not yet paid back to it (a forgiven claim stays in it) |
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
| recoveries_pending | u64 | Σ `recovery_pending` over settled loans: escrow owed to the fund, waiting in escrow accounts for `collect_recovery` |
| vault_claims | u64 | Σ `reimbursement_pending`: owed to co-signers out of the vault after a restitution; a sweep leaves it behind |
| outstanding_principal | u64 | Σ (principal − repaid) over Active loans |
| total_restituted, total_reimbursed | u64 | paid back after settlements; reimbursements paid to co-signers from the vault |
| recovery_delay_seconds | i64 | 0..=30 days; veto window of a wallet recovery |
| request_ttl_seconds | i64 | 1 s..=90 days; a request expires after this |
| first_loan_cap | u64 | the cap for a new or recovered membership during the cooldown, and the base of the graduated cap |
| loan_cap_step | u64 | the cap grows by this per loan repaid on time, up to `max_loan` |
| cooldown_seconds | i64 | 0..=365 days; how long a new or recovered membership stays on `first_loan_cap` |
| max_exposure_per_person | u64 | open principal borrowed plus principal guaranteed, per person |
| disbursement_window_seconds | i64 | 1 s..=30 days |
| disbursement_cap_per_window | u64 | principal the pool lends per window; 0 = no cap |
| default_ban_seconds, late_ban_seconds, cosigner_ban_seconds | i64 | ≥ 0; `i64::MAX` = for good; 0 = no bar; copied onto each loan at opening |
| seasoning_seconds | i64 | 0..=365 days; a repaid loan raises the cap only if it ran at least this long |
| cap_step_interval_seconds | i64 | 0..=365 days; at most one cap step per person per this interval |
| max_outstanding_principal | u64 | ceiling on `outstanding_principal`; 0 = none |
| keys_changed_at | i64 | when `apply_params` last replaced the issuer, the recovery authority or the gatekeeper network; `propose_rebind` is refused for `KEY_QUARANTINE_SECONDS` (7 days) after it |
| successor_authority | Pubkey | second key that must sign `announce_wind_down` beside the authority (the upgrade multisig at launch). It is a setting: the authority alone can replace it with a settings change, after the notice period |
| max_total_lent | u64 | lifetime lending budget: ceiling on `total_lent` (0 = none). Settlements and repayments free none of it; raising it is a settings change, with notice |
| total_forgiven | u64 | fund claims the authority forgave (`forgive_fund_claim`) |

**PoolParams** (argument of `initialize_pool` and `schedule_params`): every settings field above from `gatekeeper_network` to `max_outstanding_principal` plus `successor_authority` and `max_total_lent` (twenty-six fields). `validate()`: bps ≤ 10000; max_loan, max_term_days, max_guarantees_per_member, first_loan_cap, max_exposure_per_person > 0; max_term_days ≤ 3650; grace_days ≤ 365; timelock 0..=90 d; recovery delay 0..=30 d; request TTL 1 s..=90 d; cooldown 0..=365 d; window 1 s..=30 d; the three bans ≥ 0 and `late_ban_seconds ≤ default_ban_seconds` (paying back can only shorten a bar); seasoning and step interval 0..=365 d; `successor_authority` not the zero key.

**Vault equation**: `vault = total_donated + total_repaid + total_recovered + total_restituted − total_lent − total_swept − total_reimbursed`, and `vault ≥ vault_claims` always (`cosign_loan` lends only `vault − vault_claims`; stray tokens swept out of an escrow count as donations).

**Person** — PDA `["person", pool, person_id]`. One verified human. Eligibility, the open loan, the guarantees and the loan cap live here, so they follow the person across wallets.
| person_id | [u8; 32] | opaque id drawn at random by the issuer service; the credential behind it never reaches the chain |
| wallet | Pubkey | the wallet currently bound to this person |
| active_loan | Option<Pubkey> |
| active_guarantees | u8 |
| active_guarantee_amount | u64 | principal of the Active loans this person co-signs |
| completed_loans | u16 | loans repaid by the deadline that ran at least `seasoning_seconds`, counted at most once per `cap_step_interval_seconds`; settled loans never count |
| ineligible_until | i64 | 0 eligible; `i64::MAX` barred for good; else barred until this time. Always `max(borrower_bar_until, cosigner_bar_until)`, recomputed after every change. `eligible(now) = now ≥ ineligible_until` |
| restricted_until | i64 | until this time the person is on `first_loan_cap` |
| pending_wallet | Option<Pubkey> | a recovery in flight: the wallet the person moves to |
| pending_wallet_at | i64 | when `finalize_rebind` may run |
| bump | u8 |
| last_cap_step_at | i64 | when `completed_loans` last went up |
| unrestituted_losses | u16 | settled loans this person co-signed whose fund loss has not been paid back (checked math; a forgiven claim is not paid back, so it stays counted); the co-signer bar ends early only at 0 |
| borrower_bar_until | i64 | the bar from this person's own default (0 none); relaxed only when the loan that set it is paid back (whoever pays), or by `lift_bar` |
| cosigner_bar_until | i64 | the bar from losses on loans they co-signed (0 none): the latest expiry among them; see "Bars, exactly" |
| borrower_bar_loan | Option<Pubkey> | the loan whose settlement set `borrower_bar_until`; only its pay-back relaxes that bar |

`loan_cap(pool, now) = min(max_loan, first_loan_cap)` while `now < restricted_until`, else `min(max_loan, first_loan_cap + completed_loans × loan_cap_step)`. The two bars are kept per role, so a person who is both a defaulted borrower and a co-signer with a loss carries both and paying back one never frees the other: `bar_as_borrower(now, seconds, loan)` sets `borrower_bar_until = max(borrower_bar_until, now + seconds)` and records the loan; `bar_as_cosigner(now, seconds)` likewise for `cosigner_bar_until`; both are no-ops for 0 and never shorten a bar. `relax_borrower_bar(loan, to)` lowers `borrower_bar_until` to `to` only when `loan` is the loan that set it and `to` is sooner; `lift_cosigner_bar()` zeroes the co-signer bar; `clear_bars()` (used by `lift_bar`) zeroes both and forgets the loan, keeping `unrestituted_losses`. `ineligible_until` is recomputed as the larger of the two after each of these.

**Member** — PDA `["member", pool, wallet]`. Wallet → person link. Never closed, so a wallet can never be bound to a second person.
| wallet | Pubkey |
| person | Pubkey |
| retired | bool | true once the wallet was replaced |
| bump | u8 |

**Loan** — PDA `["loan", pool, loan_id.to_le_bytes()]`, 389 bytes
| id | u64 |
| borrower, cosigner | Pubkey | the wallets at opening |
| rent_payer | Pubkey (gets rent back when escrow closes) |
| principal, repaid, escrowed | u64 |
| opened_at, due_at | i64 (unix seconds) |
| grace_days | u16 | fixed at opening |
| status | enum { Active, Repaid, Defaulted, Restituted } |
| bump, escrow_bump | u8 |
| borrower_person, cosigner_person | Pubkey | the people behind the wallets (memcmp offsets 157 and 189) |
| closed_at | i64 | when the loan left Active (0 while open) |
| refund_pending | u64 | escrow owed to the co-signer, still in the escrow account until `claim_escrow` |
| shortfall | u64 | principal unpaid at settlement |
| recovered | u64 | escrow applied to the shortfall at settlement (fixed then); `lost = shortfall − recovered` |
| recovery_pending | u64 | of `recovered`, still in the escrow account until `collect_recovery` |
| restituted | u64 | paid back after settlement, by or for the borrower, to both claims |
| restituted_to_fund | u64 | of `restituted`, what paid the fund's claim; `restituted − restituted_to_fund` paid the co-signer's |
| reimbursement_pending | u64 | owed to the co-signer out of the vault (their used escrow, paid back by restitution) |
| borrower_bar_until, cosigner_bar_until | i64 | the bars this loan set at settlement (0 none), for the record; updated when the loan's pay-back relaxes or lifts them |
| default_ban_seconds, late_ban_seconds, cosigner_ban_seconds | i64 | copied from the pool at opening; later settings changes do not apply |
| seasoning_seconds, cap_step_interval_seconds | i64 | the cap-credit rules, copied from the pool at opening |
| cosigner_waived_at | i64 | when the co-signer waived the rest of their own claim (0 = not waived) |
| fund_forgiven_at, fund_forgiveness_reason | i64, [u8; 32] | when the authority forgave the rest of the fund's claim, and the hash of the written reason |

**The two claims of a settled loan.** `lost = shortfall − recovered`.
- `owed_to_fund() = 0` once forgiven, else `lost − restituted_to_fund`.
- `owed_to_cosigner() = 0` once waived, else `recovered − (restituted − restituted_to_fund)`.
- `owed_after_settlement() = owed_to_fund() + owed_to_cosigner()`: what the borrower still owes.
- `paid_back()`: the fund was paid in full (`restituted_to_fund ≥ lost`, not forgiven) and `owed_to_cosigner() == 0` (paid or waived). This, not who signed, is what earns the borrower the late bar.

`deadline = due_at + grace_days × 86400`: the last second at which a repayment is accepted. The state machine is `Active → Repaid` (repaid in full by the deadline) or `Active → Defaulted` (settled after it) `→ Restituted` (neither claim is owed any more: each paid back, waived by the co-signer or forgiven by the authority). While the escrow account exists it holds at least `refund_pending + recovery_pending` for a settled loan (`escrowed` for an open one, `refund_pending` for a repaid one): anyone can send tokens to it, and anything beyond the opening deposit goes back to the co-signer at a claim, or to the vault as a donation at a collection that empties the account, so a stray deposit never keeps the account open. It is closed to `rent_payer` the moment nothing waits in it.

**LoanRequest** — PDA `["request", pool, borrower]`
| borrower, cosigner | Pubkey |
| amount | u64 |
| term_days | u16 |
| created_at | i64 |
| rent_payer | Pubkey |
| bump | u8 |
| expires_at | i64 | `created_at + request_ttl_seconds`; not co-signable after, closable by anyone |

**Escrow** — token account PDA `["escrow", loan]`, authority = pool.

**Bars, exactly.** A person is eligible at time `t` iff `t ≥ max(borrower_bar_until, cosigner_bar_until)`.
- Borrower bar: a settlement sets it to at least `settled_at + loan.default_ban_seconds` and records the loan. When that loan becomes `paid_back()`, it is lowered to `paid_back_at + loan.late_ban_seconds` if that is sooner. A later settlement is never shortened by an earlier loan's pay-back.
- Co-signer bar: each settlement with `lost > 0` raises it to at least `settled_at + loan.cosigner_ban_seconds` and adds one to `unrestituted_losses`. Each loan whose fund claim is then paid in full subtracts one. At 0 the bar is cleared. So the co-signer is barred until the **earlier** of the latest expiry among their unpaid losses' settlements and the moment **every** such loss is paid back. Aggregation is one number per person: a paid-back loan with the latest expiry does not shorten the bar while an earlier loss is unpaid (the bar runs to that latest expiry). A permanent bar (`i64::MAX`) ends only by full pay-back or a lift. Fund forgiveness is not pay-back and leaves the count as it was.
- `lift_bar` clears both bars at once, keeps `unrestituted_losses`, and does not stop a later settlement from barring again.

### Instructions

Fund setup and governance
1. `initialize_pool(params)` — payer becomes authority; creates Pool + vault; applies `params` at once (the only instant settings change, and the only way to run with a notice period below the minimum: such a pool is a test pool). Classic SPL Token mints only. `paused = false`, `window_start = now`.
2. `schedule_params(params)` — authority only; validates; `params.timelock_seconds ≥ min(MIN_TIMELOCK_SECONDS (2 days), pool.timelock_seconds)` else `TimelockBelowMinimum`, so a pool that runs with at least two days of notice can never schedule less; likewise `params.recovery_delay_seconds ≥ min(MIN_RECOVERY_DELAY_SECONDS (1 day), pool.recovery_delay_seconds)` else `RecoveryDelayBelowMinimum`, so the veto window can never be scheduled away; records `pending_params` with `params_effective_at = now + timelock_seconds` (the timelock in force now, so lowering the timelock waits the old delay). Rescheduling replaces the pending change. `cancel_params()` — authority only; `NothingPending` if none. `apply_params()` — anyone, once `now ≥ params_effective_at` (`TimelockNotElapsed` before); re-validates and applies; when the change replaces the issuer, the recovery authority or the gatekeeper network it sets `keys_changed_at = now`, which refuses every `propose_rebind` for `KEY_QUARANTINE_SECONDS` (7 days) (`KeysRecentlyChanged`): an administrator who installs its own identity keys is visible for the notice period, the quarantine and the recovery delay before any membership can move; emits `PoolUpdated`.
3. `freeze_pool()` — authority only, irreversible: authority = None, clears `pending_authority` and `pending_params`. An announced wind-down stays. A frozen pool can still be paused by the pause authority but never resumed.
4. `propose_authority(new)` / `cancel_authority_proposal()` / `accept_authority()` — two-step handover; `new` may not be the zero key or the current authority.
5. `suspend_issuer()` — authority only, instant: `issuer = zero key`. No registrations or recovery proposals until a new issuer is applied through `schedule_params`. Existing members are unaffected.
6. `pause_lending()` — `pause_authority` or authority, instant: `paused = true`; `request_loan` and `cosign_loan` refuse with `Paused`; everything else (repay, default, claims, cancel, expiry, recovery, donate, governance) continues. `resume_lending()` — authority only.
7. `announce_wind_down()` — signers: the authority and `pool.successor_authority` (`Unauthorized` without either), so where the money goes at the end is a two-key decision; account `successor_vault` must hold the pool mint and must not be owned by the pool PDA (so not the vault or an escrow). Sets `wind_down_at = now + timelock_seconds`, `successor`. Refused while one is already announced. `cancel_wind_down()` — authority only, only before `wind_down_at`.
8. `sweep_to_successor()` — anyone; requires the wind-down to be in effect (`NotWindingDown`), `active_loans == 0` (`LoansOutstanding`), `vault balance − vault_claims > 0` and `successor_vault == pool.successor`. Moves `vault − vault_claims`; `total_swept += amount`; repeatable: a recovery collected after a sweep lands in the vault and a further sweep moves it. Entitlements never hold a wind-down up: escrow claims and recoveries sit in escrow accounts, and reimbursements owed from the vault are left behind for their co-signers.

Once a wind-down is in effect: `donate`, `request_loan` and `cosign_loan` refuse with `WindingDown`; everything else continues.

Membership and recovery
9. `register_member(person_id)` — signers: wallet, payer (rent; fee sponsor, may equal wallet), issuer (`== pool.issuer`, else `Unauthorized`). Requires a valid gateway token for the wallet. Creates Person (`init`, so a second wallet for the same id fails) and Member (`init`, so a second person for the same wallet fails). `restricted_until = now + cooldown_seconds`.
10. `propose_rebind()` — signers: issuer, recovery_authority (`== pool.recovery_authority`). Refused while `now < keys_changed_at + KEY_QUARANTINE_SECONDS` (`KeysRecentlyChanged`). Neither the old wallet (lost keys) nor the new one signs; the new wallet must hold a valid gateway token, which only the issuer service grants after a fresh check. `person` is self-seeded; `pending_wallet` must be None (`RecoveryPending`); `new_wallet ≠ person.wallet`. Records `pending_wallet = new_wallet`, `pending_wallet_at = now + recovery_delay_seconds`. Nothing else changes: the old wallet keeps working. Because the new wallet need not sign, the recovery key can be held by an operator away from the web service (`scripts/recovery.ts`).
11. `veto_rebind()` — signer: `person.wallet` (the old wallet) or the authority; requires a pending recovery (`RecoveryNotPending`). Clears it.
12. `finalize_rebind()` — anyone (payer covers the new Member's rent), once `now ≥ pending_wallet_at` (`RecoveryDelayNotElapsed`). `old_member` is the Member of `person.wallet` and must not be retired; `new_member` is created for `pending_wallet` (`init`: a wallet that already belongs to anyone, retired or not, is refused). Retires the old Member, `person.wallet = pending_wallet`, clears the pending fields, `restricted_until = now + cooldown_seconds`. Open loans, guarantees and eligibility stay with the person; escrow claims go to the person's current wallet.

Money
13. `donate(amount)` — any signer; donor token account → vault. Non-refundable. amount > 0. Refused while winding down.
14. `request_loan(amount, term_days, cosigner)` — signers: borrower, payer. Refused when `paused` or winding down. `borrower_person` (self-seeded, `wallet == borrower`, else `WalletNotBound`) eligible now (`Ineligible`), no active loan, gateway token valid. `cosigner_member` (PDA of `cosigner`) must exist, not be retired (`WalletRetired`) and belong to a different person (`SelfCosign`). 0 < amount ≤ `loan_cap` (`OverPersonalCap`) ≤ max_loan; `amount + active_guarantee_amount ≤ max_exposure_per_person` (`OverExposure`); 0 < term_days ≤ max_term_days. Creates LoanRequest with `expires_at` (one open request per borrower). No funds move.
15. `cosign_loan(expected_amount, expected_term_days, max_escrow, expected_grace_days, expected_cosigner_ban_seconds)` — signers: the named co-signer, payer. Refused when paused, winding down or `now > expires_at` (`RequestExpired`). The co-signer commits to the pool's grace period and their own ban as they saw them: a mismatch with `pool.grace_days` or `pool.cosigner_ban_seconds` is `RequestMismatch`. Both Persons (self-seeded; `wallet` must match the request's borrower and the signing co-signer), distinct, eligible now, gateway tokens valid, borrower has no active loan and is within `loan_cap` and exposure, co-signer below `max_guarantees_per_member` and within exposure (`active loan principal + active_guarantee_amount + amount ≤ max_exposure_per_person`); no direct reciprocity: when `cosigner_person.active_loan` is Some, that loan must be passed as `cosigner_active_loan` (`MissingCosignerLoan`) and its `cosigner_person` must not be this borrower (`ReciprocalGuarantee`); request must still match the approved terms (`RequestMismatch`) and the escrow may not exceed `max_escrow` (`EscrowTooHigh`); amount/term within current limits; `vault − vault_claims ≥ amount` (`InsufficientFund`: reimbursements owed to co-signers are not the fund's to lend); disbursement window: when `now ≥ window_start + disbursement_window_seconds` the window rolls (`window_start = now`, `window_disbursed = 0`), then `window_disbursed + amount ≤ disbursement_cap_per_window` unless the cap is 0 (`OverDisbursementCap`).
   - The fund's ceiling: `outstanding_principal + amount ≤ max_outstanding_principal` unless that is 0 (`OverOutstandingCeiling`).
   - The lifetime budget: `total_lent + amount ≤ max_total_lent` unless that is 0 (`LendingBudgetReached`). The ceiling bounds what is out at once; settlements free ceiling room, so only the budget bounds what a run of bad loans can take in total.
   - escrow = ceil(amount × bps / 10000) moved co-signer → escrow; vault → borrower `amount`. Loan created with id = loan_count (grace_days, the three ban durations, `seasoning_seconds` and `cap_step_interval_seconds` copied from the pool, persons recorded, `closed_at = 0`, every entitlement field 0), loan_count += 1, `active_loans += 1`, `outstanding_principal += amount`, `window_disbursed += amount`, co-signer `active_guarantees += 1`, `active_guarantee_amount += amount`. LoanRequest closed to its rent_payer. Exposure counts the full guaranteed principal (a concentration limit); the escrow is the collateral.
16. `cancel_request()` — borrower or the named co-signer signs; closes LoanRequest to its rent_payer. `close_expired_request()` — anyone, once `now > expires_at` (`RequestNotExpired`); closes it to its rent_payer.
17. `repay(amount)` — any signer pays from own token account → vault; only while `now ≤ deadline` (`LoanPastDeadline` after it, whole or in part); 0 < amount ≤ principal − repaid; loan Active. Persons pinned by `loan.borrower_person` / `loan.cosigner_person`. No co-signer token account is touched. `outstanding_principal −= amount`. When fully repaid: status `Repaid`; `closed_at = now`; `active_loan = None`; the borrower's `completed_loans += 1` and `last_cap_step_at = now` only if `now − opened_at ≥ loan.seasoning_seconds` and `now − last_cap_step_at ≥ loan.cap_step_interval_seconds` (the loan's own snapshot; `Repaid.cap_credited`); co-signer `active_guarantees −= 1`, `active_guarantee_amount −= principal`; `active_loans −= 1`; the whole escrow balance becomes `refund_pending` (`pending_claims += it`); when the escrow is empty it is closed to `rent_payer` at once (the token program closes an empty account even when it is frozen).
18. `settle()` — anyone, only when Active and `now > deadline` (`NotYetDefaultable` before). **Moves no tokens.**
    - shortfall = principal − repaid; applied = min(escrow balance, `escrowed`); recovered = min(applied, shortfall); returned = escrow balance − recovered; lost = shortfall − recovered. Only the opening deposit counts towards the shortfall: a top-up after the deadline or a stray deposit goes back to the co-signer and never turns a loss into a recovery (so a co-signer cannot buy their way out of the bar after the fact). Records `shortfall`, `recovered`, `recovery_pending = recovered`, `refund_pending = returned`, `restituted = 0`, `closed_at = now`; pool `recoveries_pending += recovered`, `pending_claims += returned`, `total_lost += lost`, `outstanding_principal −= shortfall`, `active_loans −= 1`. An empty escrow is closed to `rent_payer` at once (frozen or not).
    - Defaulted; the borrower is barred as a borrower for the loan's own `default_ban_seconds` (`bar_as_borrower`, recorded in `borrower_bar_until` and `Person.borrower_bar_loan`), their `completed_loans` reset to 0 and `restricted_until = now + cooldown_seconds` (a defaulter starts over on the first-loan cap); the co-signer is barred as a co-signer for the loan's `cosigner_ban_seconds` only if `lost > 0` (`cosigner_bar_until`, `unrestituted_losses += 1`, checked); guarantees and amount decremented. `LoanSettled` carries the amounts, the person keys, both `ineligible_until` values, `cosigner_barred` and `escrow_closed`.
    - Whoever moves first after the deadline, the outcome is the same: a borrower who wants to pay sends `settle` + `restitute` in one transaction and lands exactly where the cranker's settlement followed by a later restitution lands (same money to the fund and the co-signer, same bars, same relaxation). There is no path that closes a loan after the deadline with a lighter consequence.
19. `collect_recovery()` — anyone; `recovery_pending > 0` (`NothingToCollect`); escrow → vault for `recovery_pending`; `total_recovered += it`; `recoveries_pending −= it`; `recovery_pending = 0`. When `refund_pending == 0` the co-signer is owed nothing from the account, so whatever else is in it (a stray deposit) comes along as a donation (`total_donated += extra`, `RecoveryCollected.donated`) and the empty escrow is closed to `rent_payer`. A frozen escrow makes this fail until it thaws; the entitlement stays recorded and nothing is written off.
20. `restitute(amount)` — anyone pays from own token account → vault; loan Defaulted (`LoanNotSettled`); 0 < amount ≤ `owed_after_settlement()` (`NothingOwed` when nothing is left, `OverRepay` above it). **Who signs makes no difference**: the program sees a wallet, not whose money it was.
    - The fund's claim is paid first: `to_fund = min(amount, owed_to_fund())`; `restituted_to_fund += to_fund`, `total_lost −= to_fund`.
    - The rest pays the co-signer's claim. Escrow the fund has not collected yet is released to them where it is (`converted = min(rest, recovery_pending)`: `recovery_pending −= converted`, `refund_pending += converted`, pool `recoveries_pending −= converted`, `pending_claims += converted`). The vault keeps the payment in its place, so a frozen escrow never leaves the vault owing money it has not received. Only escrow already collected is owed from the vault (`reimbursement_pending += rest − converted`, `vault_claims += the same`).
    - `restituted += amount`, `total_restituted += amount`.
    - Co-signer bar: when this payment completes the fund's claim (`lost > 0`), `unrestituted_losses −= 1` (checked), and at 0 the co-signer bar is cleared (`Restituted.cosigner_lifted`).
    - When nothing is owed any more the loan is `Restituted` (`completed_loans` unchanged). If it is also `paid_back()`, the borrower's bar is relaxed to `now + late_ban_seconds` where this loan is the one that set it (`Restituted.borrower_relaxed`). A bar set by another loan, or already lifted, is never touched.
21. `claim_escrow()` — anyone; loan not Active (`LoanNotActive`), `refund_pending + reimbursement_pending > 0` (`NothingToClaim`), `cosigner_person.pending_wallet` None (`RecoveryPending`: a claim waits out a wallet move, so a lost wallet is never paid); `cosigner_token` must be owned by `cosigner_person.wallet` (the current wallet) and hold the pool mint; `escrow` is optional. With the escrow passed: everything in it beyond `recovery_pending` goes escrow → co-signer (the refund owed plus any stray deposit; `pending_claims −= refund_pending`, `refund_pending = 0`), and the escrow is closed to `rent_payer` once `recovery_pending == 0` (it is empty then). Always: `reimbursement_pending` vault → co-signer (`vault_claims −= it`, `total_reimbursed += it`). Leaving a frozen escrow out claims the vault part alone. A frozen or closed co-signer token account never blocks a loan from closing; the claim waits until an account exists. `EscrowClaimed` carries `escrow_closed`.
22. `lift_bar(reason: [u8; 32])` — authority only, instant; `person.ineligible_until > now` (`NotBarred`); clears both role bars (`clear_bars`) and nothing else: `unrestituted_losses` stays, so a later loss on a guaranteed loan bars again and an older loss still counts until it is paid back; `BarLifted` carries the reason hash (the operator publishes the reason), the previous bars and the count. The remedy for an outage across a deadline or an appeal upheld.
23. `waive_reimbursement()` — signer: `cosigner_person.wallet` (the co-signer's current wallet); loan Defaulted (`LoanNotSettled`) with `owed_to_cosigner() > 0` (`NothingToWaive`). Sets `cosigner_waived_at = now`. The co-signer gives up only their own claim: the fund's claim stays payable, and the co-signer's bar still follows the fund's claim. If the fund's claim was already paid, the loan is `Restituted` and the borrower's late bar applies. `ReimbursementWaived` carries the amount waived and the fund's claim left.
24. `forgive_fund_claim(reason: [u8; 32])` — authority only, instant; loan Defaulted with `owed_to_fund() > 0` (`NothingOwed`). Sets `fund_forgiven_at = now`, the reason hash, and `total_forgiven += owed_to_fund()`. `total_lost` is unchanged (the loss stays recognised), and so are `unrestituted_losses` and every bar (the co-signer's bar runs to its expiry; `lift_bar` is the separate remedy). The co-signer's claim stays payable; the loan is `Restituted` once that is also zero, without the borrower's late bar. `FundClaimForgiven` carries the reason hash, the amount and the co-signer's claim left.

Rules: checked math only; every token account constrained by mint and owner; no fee, interest or penalty fields anywhere. One event per instruction: `PoolInitialized`, `ParamsScheduled`, `ParamsCancelled`, `PoolUpdated`, `PoolFrozen`, `AuthorityProposed`, `AuthorityProposalCancelled`, `AuthorityChanged`, `IssuerSuspended`, `LendingPaused`, `LendingResumed`, `WindDownAnnounced`, `WindDownCancelled`, `SweptToSuccessor`, `Donated`, `MemberRegistered` (wallet, person), `RebindProposed` (old wallet, new wallet, effective_at), `RebindVetoed` (by), `WalletRebound`, `LoanRequested` (expires_at), `RequestCancelled`, `RequestExpiredClosed`, `LoanOpened` (wallets and persons), `Repaid` (persons, cap_credited, refund_pending), `LoanSettled` (persons, shortfall, recovered, escrow_returned, lost, both bars, escrow_closed), `RecoveryCollected` (amount, donated, escrow_closed), `Restituted` (persons, to_fund, to_cosigner, fund_owed, cosigner_owed, converted, complete, borrower_relaxed, cosigner_lifted, unrestituted_losses, both bars), `EscrowClaimed` (from_escrow, from_vault, escrow_closed), `BarLifted` (reason hash, previous bars, unrestituted_losses), `ReimbursementWaived` (waived, fund_owed, complete, borrower_relaxed), `FundClaimForgiven` (reason hash, forgiven, cosigner_owed, complete).

Who pays rent and who gets it back: the request's rent to whoever made it (borrower, or the sponsor when sponsored), returned on co-sign, cancel or expiry close; the Loan account's rent to the co-sign payer, never returned (loans are permanent records); the escrow's rent to the co-sign payer, returned when the escrow closes (at settlement if it is empty, else at the last of collect and claim); Person and Member rent to the registration payer, never returned; a token account created for a borrower or co-signer by a sponsored transaction belongs to its owner, who can close it. Because that rent would then go to the owner, the sponsor creates token accounts only for members (a verified person each, with a lifetime per-wallet allowance) and never sponsors a close.

**Frozen accounts.** The mint's freeze authority can freeze any token account. A frozen co-signer wallet delays only that co-signer's claim. A frozen escrow delays `collect_recovery` and the escrow part of `claim_escrow` for that loan; settlement, restitution (which releases the uncollected recovery to the co-signer rather than paying from the vault), the reimbursement from the vault and the wind-down are unaffected, and both entitlements stay recorded until the account thaws; an empty frozen escrow is closed like any other. A frozen vault stops lending, repayment, restitution, reimbursement and sweeps alike; nothing the program does can undo a freeze.

### Accounting, worked through

A $300 loan with a $75 deposit, nothing repaid by the cutoff. `V` is the vault after lending the $300. "Fund claim" is `owed_to_fund()`, "co-signer claim" `owed_to_cosigner()`, "owed to co-signer now" is `refund_pending + reimbursement_pending` (theirs to release, not a claim on the borrower), "escrow → fund" is `recovery_pending`, and "recognised loss" is this loan's part of `total_lost`. The scenario tests walk these paths, and the property test checks the same identities after every step of random sequences that include freezes, thaws, waivers and forgiveness.

| step | vault | escrow | escrow → fund | fund claim | co-signer claim | owed to co-signer now | borrower owes | recognised loss |
|---|---|---|---|---|---|---|---|---|
| open | V | 75 | 0 | — | — | 0 | 300 (repay) | 0 |
| settle (moves nothing) | V | 75 | 75 | 225 | 75 | 0 | 300 | 225 |
| collect | V+75 | 0 (closed) | 0 | 225 | 75 | 0 | 300 | 225 |
| then pay back 100 | V+175 | 0 | 0 | 125 | 75 | 0 | 200 | 125 |
| then pay back 200 | V+375 | 0 | 0 | 0 | 0 | 75 (from vault) | 0 | 0 |
| then claim | V+300 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| *instead:* settle, escrow frozen, pay back 300 | V+300 | 75 (frozen) | 0 | 0 | 0 | 75 (in escrow) | 0 | 0 |
| then thaw and claim | V+300 | 0 (closed) | 0 | 0 | 0 | 0 | 0 | 0 |
| *instead:* settle, co-signer waives | V | 75 | 75 | 225 | 0 | 0 | 225 | 225 |
| then pay back 225, collect | V+300 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| *instead:* settle, authority forgives the fund's claim | V | 75 | 75 | 0 (225 forgiven) | 75 | 0 | 75 | 225 |
| then pay back 75 (escrow uncollected) | V+75 | 75 | 0 | 0 | 0 | 75 (in escrow) | 0 | 225 |

In every row the fund ends with what it lent less the recognised loss, and the co-signer ends with their deposit less what they waived or what the borrower never paid back. A pay-back that lands while the escrow is frozen is kept by the vault in place of the frozen recovery, so the vault never owes money it has not received.

**After a wind-down sweep.** The sweep moves `vault − vault_claims`, so reimbursements owed to co-signers stay in the vault, and escrow refunds never leave their escrow accounts. Collections and pay-backs that arrive later land in the old vault. `sweep_to_successor` is repeatable and the cranker runs it on every pass, so they are forwarded to the successor. A pay-back's co-signer share is booked as `vault_claims` in the same instruction that brings the money in, so a later sweep can never take it.

### Gateway token check (`gateway.rs`)
The fund runs its own gatekeeper network on the Identity.com gateway program (`gatem74V238djXdzWnJf94Wo1DcnuGkfijbf3AuBhfs`); the issuer service is the gatekeeper and issues a token to a wallet after a successful identity check. The program parses the token account (Borsh: version, parent, owner_wallet, owner_identity, gatekeeper_network, issuing_gatekeeper, state, expire_time): owner program = gateway program, `owner_wallet` = the wallet, `gatekeeper_network` = `pool.gatekeeper_network`, state Active, expiry None or > now. Tests plant such accounts in LiteSVM and on the fork.

### Errors (in order, Anchor codes from 6000)
AmountZero, OverLoanCap, TermTooLong, SelfCosign, BorrowerHasLoan, CosignerLimit, Ineligible, InvalidGatewayToken, InsufficientFund, OverRepay, LoanNotActive, NotYetDefaultable, Unauthorized, InvalidBps, MathOverflow, RequestMismatch, EscrowTooHigh, InvalidParams, WalletNotBound, WalletRetired, WindingDown, NotWindingDown, TimelockNotElapsed, NothingPending, LoansOutstanding, InvalidSuccessor (6025), Paused (6026), RequestExpired, RequestNotExpired, OverPersonalCap, OverExposure, OverDisbursementCap, ReciprocalGuarantee, RecoveryPending, RecoveryNotPending, RecoveryDelayNotElapsed, NothingToClaim, TimelockBelowMinimum, MissingCosignerLoan (6038), LoanPastDeadline (6039), NothingOwed, NothingToCollect, OverOutstandingCeiling, LoanNotSettled, NotBarred (6044), RecoveryDelayBelowMinimum (6045), KeysRecentlyChanged (6046), LendingBudgetReached (6047), NothingToWaive (6048).

### Authority table
| key | may | delay | cannot | after the authority renounces (`freeze_pool`) |
|---|---|---|---|---|
| authority (the administrator: a multisig) | schedule, cancel and (anyone) apply settings; propose a handover; suspend the issuer; pause and resume lending; announce (with the successor authority) or cancel a wind-down; veto a recovery; lift a bar (public, with a reason); forgive a fund claim (public, with a reason); freeze | settings and wind-down: `timelock_seconds` (≥ 2 days once above it); the rest instant; a replaced issuer, recovery key or gatekeeper network is followed by a 7-day recovery quarantine | move funds (except the vault, less what co-signers are owed, to the successor two keys announced, after the notice period with no open loan); touch an open loan; set a bar; waive a co-signer's claim; shorten the notice period below 2 days or the recovery delay below 1 day; move a membership within 7 days of changing the identity keys; name a successor alone | gone. Nothing can be resumed, lifted, forgiven, suspended or changed; settings, including every key below, are fixed for good |
| successor_authority (the upgrade multisig at launch) | co-sign a wind-down announcement | with the authority | anything alone; protect its own seat (the authority can replace it with a settings change, after notice: independence lasts only as long as nobody schedules that, and a schedule is public for the whole notice period) | useless unless a wind-down was announced before; that one still takes effect |
| pause_authority | pause lending | instant | resume; anything else | keeps pausing; a pause then lasts for good (only the authority resumes) |
| issuer | co-sign registrations and recovery proposals | none, but a proposal waits `recovery_delay_seconds` and needs the recovery authority too | move funds; move a membership alone; skip the veto window | unchanged (it cannot be suspended or replaced any more) |
| recovery_authority (an operator's key, outside the web service) | co-sign recovery proposals | as above | anything alone | unchanged; a recovery can still be vetoed by the old wallet, no longer by the authority |
| upgrade authority (program) | replace the program code | none on chain during the pilot; a separate multisig behind its own timelock, with the exit criteria published; removed later | — | unchanged: renouncing the administrator does not remove the upgrade key |
| the co-signer of a settled loan | waive their own claim | instant | forgive the fund's claim; lift their own bar (that needs the fund paid back, the expiry, or the authority) | unchanged |
| anyone | apply a due change; finalize a due recovery; close an expired request; repay; settle a loan past its deadline; collect a recovery; pay back a settled loan; claim what a co-signer is owed; sweep after a wind-down | by the rules above | — | unchanged |

## Web app `app/` (Next.js, TypeScript)
Uses the Codama client generated from `target/idl/goodfaith.json` (`npm run codegen`). Pages: wallet (balance, send/receive with Solana Pay QR, history), Borrow (identity check → join → request → co-signer link → submit), Co-sign, Repay (a repayment by the deadline; "Settle and pay back" after it, one transaction; "Pay back" on a settled loan; release, collect and waive buttons, the two claims shown separately and the entitlement lines on each loan), Donate, Fund stats (outstanding principal and the ceiling, restitution, what co-signers are owed), Join (verify, join or recover with a signed request, renew the pass, set a contact). Kora as fee payer behind the app's own proxy and policy so users pay $0. Registration is prepared server-side by the identity issuer (`docs/identity.md`) and finished by the wallet; a recovery is requested in the app (signed by the new wallet), proposed by the operator's recovery CLI after it has aged and been verified, and finalised by the wallet or the cranker. `scripts/member.ts` is the fallback client; `scripts/cranker.ts` the operator's scheduled job (settlements, collections, claims, expired requests, due recoveries, due settings, sweep, and the identity service reconciled with the chain's bars); `scripts/admin.ts` the authority's CLI (settings, brakes, handover, the two-key wind-down, `lift-bar`, `forgive-fund-claim`); `scripts/recovery.ts` the recovery key's CLI.

## Launch parameters (decided; owner may change at review)
- Loan token: USDC (6 decimals).
- `max_loan` $500, `max_term_days` 180, `grace_days` 30, `cosigner_escrow_bps` 2500, `max_guarantees_per_member` 2.
- `timelock_seconds` 7 days; `recovery_delay_seconds` 3 days; `request_ttl_seconds` 7 days.
- `first_loan_cap` $150, `loan_cap_step` $100, `cooldown_seconds` 30 days, `max_exposure_per_person` $1,000.
- `disbursement_window_seconds` 1 day, `disbursement_cap_per_window` $5,000.
- `default_ban_seconds` 2 years, `late_ban_seconds` 90 days, `cosigner_ban_seconds` 1 year (see "Bars, exactly": the co-signer's ends at the earlier of that expiry and the fund being paid back on every loan they guaranteed; the borrower's shortens to the late bar counted from the day the loan is paid back, whoever pays).
- `seasoning_seconds` 30 days, `cap_step_interval_seconds` 30 days, `max_outstanding_principal` $25,000, `max_total_lent` $40,000 for the pilot's first phase (reviewed before it is raised).
- Keys: authority = a multisig of independent people; `successor_authority` = the program upgrade multisig (a wind-down needs both); `pause_authority`, `issuer`, `recovery_authority` (the operator's recovery CLI, never the web service), the gatekeeper and the program upgrade authority are separate keys held by different people where the deployment allows. Floors the program keeps whatever the settings: notice ≥ 2 days, recovery delay ≥ 1 day, a 7-day recovery quarantine after any identity-key change.
- Release: a capped pilot, upgradeable under a separate multisig with a timelock; immutability later, once the pilot has run and the published exit criteria are met (`docs/operations.md`).
- Presentation: neutral. Defaults: no collections, no credit reporting, no legal action. Identity: the fund's own gatekeeper network; government ID and Texas residency checked by the issuer service's provider (Persona).
- Funding: owner seeds the fund.
