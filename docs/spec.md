# Good Faith — Program Spec (v2, devnet)

Interest-free, fee-free loans from a donated loan fund. Borrowers repay exactly what they borrowed. Each loan needs a co-signer who puts part of the loan amount in escrow. Texas residents only, verified by the fund's own identity issuer, which vouches for one person per wallet on chain.

Plain English everywhere: no religious or non-English finance terms in code, UI or docs.

## Program `goodfaith` (Anchor 1.x, SPL Token via `token_interface`)

### Accounts

**Pool** — PDA `["pool", mint]`
| field | type | notes |
|---|---|---|
| authority | Option<Pubkey> | schedules settings changes, handovers and the wind-down; None once frozen |
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
| issuer | Pubkey | key that co-signs `register_member` and `rebind_wallet`; the zero key means suspended |
| timelock_seconds | i64 | 0..=90 days; delay between scheduling a change (or a wind-down) and its effect |
| pending_params | Option<PoolParams> | scheduled by `schedule_params`, applied by anyone with `apply_params` |
| params_effective_at | i64 | |
| wind_down_at | Option<i64> | once set and reached: no new loans or donations |
| successor | Option<Pubkey> | token account of the pool mint that receives the vault balance |
| active_loans | u64 | loans currently Active |
| total_swept | u64 | moved to the successor |

**PoolParams** (argument of `initialize_pool` and `schedule_params`): gatekeeper_network, max_loan, max_term_days, grace_days, max_guarantees_per_member, cosigner_escrow_bps, issuer, timelock_seconds.

**Person** — PDA `["person", pool, person_hash]`. One verified human. Eligibility lives here, so it follows the person across wallets.
| person_hash | [u8; 32] | HMAC of normalised government-ID fields, computed by the issuer service; never name or selfie |
| wallet | Pubkey | the wallet currently bound to this person |
| active_loan | Option<Pubkey> |
| active_guarantees | u8 |
| ineligible | bool |
| bump | u8 |

**Member** — PDA `["member", pool, wallet]`. Wallet → person link. Never closed, so a wallet can never be bound to a second person.
| wallet | Pubkey |
| person | Pubkey |
| retired | bool | true once the wallet was replaced |
| bump | u8 |

**Loan** — PDA `["loan", pool, loan_id.to_le_bytes()]`
| id | u64 |
| borrower, cosigner | Pubkey | the wallets at opening |
| rent_payer | Pubkey (gets rent back when escrow closes) |
| principal, repaid, escrowed | u64 |
| opened_at, due_at | i64 (unix seconds) |
| grace_days | u16 | fixed at opening |
| status | enum { Active, Repaid, Defaulted } |
| bump, escrow_bump | u8 |
| borrower_person, cosigner_person | Pubkey | appended; the people behind the wallets (memcmp offsets 157 and 189) |

**LoanRequest** — PDA `["request", pool, borrower]`
| borrower, cosigner | Pubkey |
| amount | u64 |
| term_days | u16 |
| created_at | i64 |
| rent_payer | Pubkey |
| bump | u8 |

**Escrow** — token account PDA `["escrow", loan]`, authority = pool.

### Instructions

Fund setup and governance
1. `initialize_pool(params)` — payer becomes authority; creates Pool + vault; applies `params` at once (the only instant settings change). Classic SPL Token mints only. `PoolParams::validate`: bps ≤ 10000, max_loan > 0, terms > 0, max_term_days ≤ 3650, grace_days ≤ 365, 0 ≤ timelock_seconds ≤ 90 days.
2. `schedule_params(params)` — authority only; validates and records `pending_params` with `params_effective_at = now + timelock_seconds` (the timelock in force now, so lowering the timelock itself waits the old delay). Rescheduling replaces the pending change. `cancel_params()` — authority only; `NothingPending` if none. `apply_params()` — anyone, once `now ≥ params_effective_at` (`TimelockNotElapsed` before); re-validates and applies; emits `PoolUpdated`.
3. `freeze_pool()` — authority only, irreversible: authority = None, clears `pending_authority` and `pending_params`. An announced wind-down stays, so a frozen fund can still be retired.
4. `propose_authority(new)` / `cancel_authority_proposal()` / `accept_authority()` — two-step handover; `new` may not be the zero key or the current authority.
5. `suspend_issuer()` — authority only, instant: `issuer = zero key`. No registrations or wallet replacements until a new issuer is applied through `schedule_params`. Existing members are unaffected.
6. `announce_wind_down()` — authority only; account `successor_vault` must hold the pool mint and must not be owned by the pool PDA (so not the vault or an escrow). Sets `wind_down_at = now + timelock_seconds`, `successor`. Refused while one is already announced. `cancel_wind_down()` — authority only, only before `wind_down_at` (`WindingDown` after; `NotWindingDown` if none).
7. `sweep_to_successor()` — anyone; requires the wind-down to be in effect (`NotWindingDown`), `active_loans == 0` (`LoansOutstanding`), a vault balance > 0 (`AmountZero`) and `successor_vault == pool.successor` (`InvalidSuccessor`). Moves the whole vault balance; `total_swept += amount`; repeatable.

Once a wind-down is in effect: `donate`, `request_loan` and `cosign_loan` refuse with `WindingDown`; `repay`, `mark_default`, `cancel_request`, `register_member` and `rebind_wallet` continue.

Membership
8. `register_member(person_hash)` — signers: wallet, payer (rent; fee sponsor, may equal wallet), issuer (`== pool.issuer`, else `Unauthorized`). Requires a valid gateway token for the wallet. Creates Person (`init`, so a second wallet for the same hash fails) and Member (`init`, so a second person for the same wallet fails).
9. `rebind_wallet()` — signers: new_wallet, payer, issuer. The old wallet does not sign (lost keys). `person` is self-seeded; `old_member` is the Member of `person.wallet` and must not be retired; `new_member` is created (`init`: a wallet that already belongs to anyone, retired or not, is refused). Requires a valid gateway token for the new wallet. Retires the old Member, sets `person.wallet = new_wallet`. Open loans, guarantees and eligibility stay with the person; escrow refunds go to the person's current wallet.

Money
10. `donate(amount)` — any signer; donor token account → vault. Non-refundable. amount > 0. Refused while winding down.
11. `request_loan(amount, term_days, cosigner)` — signers: borrower, payer. `borrower_person` (self-seeded, `wallet == borrower`, else `WalletNotBound`) not ineligible, no active loan, gateway token valid. `cosigner_member` (PDA of `cosigner`) must exist, not be retired (`WalletRetired`) and belong to a different person (`SelfCosign`). 0 < amount ≤ max_loan; 0 < term_days ≤ max_term_days. Creates LoanRequest (one open request per borrower). No funds move.
12. `cosign_loan(expected_amount, expected_term_days, max_escrow)` — signers: the named co-signer, payer. Both Persons (self-seeded; `wallet` must match the request's borrower and the signing co-signer), distinct, not ineligible, gateway tokens valid, borrower has no active loan, co-signer below `max_guarantees_per_member`; request must still match the approved terms (`RequestMismatch`) and the escrow may not exceed `max_escrow` (`EscrowTooHigh`); amount/term within current limits; vault ≥ amount.
   - escrow = ceil(amount × bps / 10000) moved co-signer → escrow; vault → borrower `amount`. Loan created with id = loan_count (grace_days copied from the pool, persons recorded), loan_count += 1, `active_loans += 1`. LoanRequest closed to its rent_payer.
13. `cancel_request()` — borrower or the named co-signer signs; closes LoanRequest to its rent_payer.
14. `repay(amount)` — any signer pays from own token account → vault; 0 < amount ≤ principal − repaid; loan Active. Persons pinned by `loan.borrower_person` / `loan.cosigner_person`; `cosigner_token.owner == cosigner_person.wallet` (the current wallet). When fully repaid: Repaid; escrow → co-signer; escrow closed to rent_payer; `active_loan = None`; `active_guarantees −= 1`; `active_loans −= 1`.
15. `mark_default()` — anyone, only when Active and now > due_at + loan.grace_days × 86400.
    - shortfall = principal − repaid; recovered = min(escrow balance, shortfall) → vault; the rest → co-signer's current wallet; escrow closed.
    - Defaulted; borrower person `ineligible = true`; co-signer person `ineligible = true` only if `lost = shortfall − recovered > 0` (the fund was not made whole); `active_loans −= 1`; `total_recovered += recovered`; `total_lost += lost`. `LoanDefaulted.cosigner_barred` reports the decision.

Rules: checked math only; every token account constrained by mint and owner; no fee, interest or penalty fields anywhere. One event per instruction: `PoolInitialized`, `ParamsScheduled`, `ParamsCancelled`, `PoolUpdated` (from apply), `PoolFrozen`, `AuthorityProposed`, `AuthorityProposalCancelled`, `AuthorityChanged`, `IssuerSuspended`, `WindDownAnnounced`, `WindDownCancelled`, `SweptToSuccessor`, `Donated`, `MemberRegistered` (wallet, person), `WalletRebound`, `LoanRequested`, `RequestCancelled`, `LoanOpened` (wallets and persons), `Repaid`, `LoanDefaulted`.

### Gateway token check (`gateway.rs`)
The fund runs its own gatekeeper network on the Identity.com gateway program (`gatem74V238djXdzWnJf94Wo1DcnuGkfijbf3AuBhfs`); the issuer service is the gatekeeper and issues a token to a wallet after a successful identity check. The program parses the token account (Borsh: version, parent, owner_wallet, owner_identity, gatekeeper_network, issuing_gatekeeper, state, expire_time): owner program = gateway program, `owner_wallet` = the wallet, `gatekeeper_network` = `pool.gatekeeper_network`, state Active, expiry None or > now. Tests plant such accounts in LiteSVM and on the fork.

### Errors (in order, Anchor codes from 6000)
AmountZero, OverLoanCap, TermTooLong, SelfCosign, BorrowerHasLoan, CosignerLimit, Ineligible, InvalidGatewayToken, InsufficientFund, OverRepay, LoanNotActive, NotYetDefaultable, Unauthorized, InvalidBps, MathOverflow, RequestMismatch, EscrowTooHigh, InvalidParams, WalletNotBound, WalletRetired, WindingDown, NotWindingDown, TimelockNotElapsed, NothingPending, LoansOutstanding, InvalidSuccessor.

## Web app `app/` (Next.js, TypeScript)
Uses the Codama client generated from `target/idl/goodfaith.json` (`npm run codegen`). Pages: Checking (balance, send/receive with Solana Pay QR, history), Borrow (identity check → join → request → co-signer link → submit), Co-sign, Repay, Donate, Fund stats. Kora as fee payer so users pay $0. Registration and wallet replacement are prepared server-side by the identity issuer (it adds its signature) and finished by the wallet.

## Launch parameters (decided)
- Loan token: USDC (6 decimals).
- `max_loan` = 500_000_000 ($500), `max_term_days` = 180, `grace_days` = 30, `cosigner_escrow_bps` = 2500 (25%), `max_guarantees_per_member` = 2.
- `timelock_seconds` = 604_800 (7 days) for every settings change and for the wind-down announcement.
- Pool authority: a Squads multisig vault, 2 of 3, all three keys held by the owner on separate devices. Single wallet on devnet. Freezing stays optional: a timelocked authority can also simply be kept for the wind-down path.
- Issuer: a separate key held by the identity service, rotated through the timelock; `suspend_issuer` is the instant brake.
- Presentation: neutral. No audience, community or religious positioning in UI, docs or marketing.
- Defaults: no collections, no credit reporting, no legal action. The borrower loses access; the co-signer loses their escrow and, only when the fund was not made whole, their access.
- Identity: the fund's own gatekeeper network; government ID and Texas residency checked by the issuer service's provider (Persona); the person hash keeps a banned person out even with a new wallet.
- Funding: owner seeds the fund.
