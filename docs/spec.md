# Good Faith — Program Spec (v0, devnet)

Interest-free, fee-free loans from a donated loan fund. Borrowers repay exactly what they borrowed. Each loan needs a co-signer who puts part of the loan amount in escrow. Texas residents only, verified with a Civic Pass.

Plain English everywhere: no religious or non-English finance terms in code, UI or docs.

## Program `goodfaith` (Anchor 1.x, SPL Token via `token_interface`)

### Accounts

**Pool** — PDA `["pool", mint]`
| field | type | notes |
|---|---|---|
| authority | Option<Pubkey> | can update params on devnet; set to None to freeze |
| mint | Pubkey | loan token (devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) |
| vault | Pubkey | token account, PDA `["vault", pool]`, authority = pool |
| gatekeeper_network | Pubkey | Civic gatekeeper network required for members |
| max_loan | u64 | per-loan cap, base units |
| max_term_days | u16 | |
| grace_days | u16 | |
| max_guarantees_per_member | u8 | |
| cosigner_escrow_bps | u16 | 0..=10000, default 2500 |
| loan_count | u64 | next loan id |
| total_donated, total_lent, total_repaid, total_recovered, total_lost | u64 | stats |
| bump, vault_bump | u8 | |

**Member** — PDA `["member", pool, wallet]`
| wallet | Pubkey |
| active_loan | Option<Pubkey> |
| active_guarantees | u8 |
| ineligible | bool |
| bump | u8 |

**Loan** — PDA `["loan", pool, loan_id.to_le_bytes()]`
| id | u64 |
| borrower, cosigner | Pubkey |
| rent_payer | Pubkey (gets rent back when escrow closes) |
| principal, repaid, escrowed | u64 |
| opened_at, due_at | i64 (unix seconds) |
| status | enum { Active, Repaid, Defaulted } |
| bump, escrow_bump | u8 |

**LoanRequest** — PDA `["request", pool, borrower]`
| borrower, cosigner | Pubkey |
| amount | u64 |
| term_days | u16 |
| created_at | i64 |
| rent_payer | Pubkey |
| bump | u8 |

**Escrow** — token account PDA `["escrow", loan]`, authority = pool.

### Instructions
1. `initialize_pool(params)` — payer becomes authority; creates Pool + vault. Validate bps ≤ 10000, max_loan > 0, terms > 0.
2. `update_pool(params)` — authority only. `freeze_pool()` — sets authority None (irreversible).
3. `donate(amount)` — any signer; donor token account → vault. Non-refundable. amount > 0.
4. `register_member()` — signers: wallet, payer (pays Member rent; fee sponsor, may equal wallet); requires a valid Civic gateway token (see below); creates Member.
5. `request_loan(amount, term_days, cosigner)` — signers: borrower, payer (fee sponsor, may equal borrower).
   - Borrower Member exists, not ineligible, gateway token valid, active_loan is None.
   - borrower ≠ cosigner; 0 < amount ≤ max_loan; 0 < term_days ≤ max_term_days.
   - Creates LoanRequest (one open request per borrower, enforced by the PDA). No funds move.
6. `cosign_loan()` — signers: the named co-signer, payer (fee sponsor).
   - Re-checks both Members (exist, not ineligible, gateway tokens valid), borrower.active_loan is None, cosigner.active_guarantees < max, amount/term within current limits, vault balance ≥ amount.
   - escrow = ceil(amount × bps / 10000) moved cosigner → escrow account.
   - vault → borrower `amount`. Loan created with id = loan_count (opened_at = now, due_at = now + term_days), then loan_count += 1. Loan.rent_payer = payer.
   - LoanRequest closed to its rent_payer.
7. `cancel_request()` — borrower or the named co-signer signs; closes LoanRequest to its rent_payer.
8. `repay(amount)` — any signer pays from own token account → vault. amount ≤ principal − repaid (reject over-payment). Loan must be Active. When fully repaid: status Repaid; escrow → cosigner; close escrow account to rent_payer; borrower.active_loan = None; cosigner.active_guarantees −= 1.
9. `mark_default()` — anyone, only when Active and now > due_at + grace_days×86400.
   - shortfall = principal − repaid; recovered = min(escrowed, shortfall) → vault; escrowed − recovered → cosigner; close escrow.
   - status Defaulted; borrower and cosigner Members ineligible = true; clear active_loan / decrement guarantees.
   - total_recovered += recovered; total_lost += shortfall − recovered.

Rules: checked math only (no `+`/`-`/`*` on u64 without checked_*); every token account constrained by mint and owner; no fee, interest or penalty fields anywhere. Emit an event per instruction.

### Civic gateway token check
Implement in `gateway.rs` without the `solana-gateway` crate unless it builds cleanly with Anchor 1.x. Parse the gateway token account per Civic's on-chain layout (verify against github.com/identity-com/on-chain-identity-gateway source): owner program = Civic gateway program id, `owner_wallet` = member wallet, `gatekeeper_network` = pool.gatekeeper_network, state Active, expiry None or > now. Tests may plant fake accounts owned by the gateway program id in LiteSVM.

### Errors (minimum)
AmountZero, OverLoanCap, TermTooLong, SelfCosign, BorrowerHasLoan, CosignerLimit, Ineligible, InvalidGatewayToken, InsufficientFund, OverRepay, LoanNotActive, NotYetDefaultable, Unauthorized, InvalidBps, MathOverflow.

## Web app `app/` (Next.js, TypeScript)
Uses the generated IDL from `target/idl/goodfaith.json` + `target/types/goodfaith.ts`.
Pages: Checking (balance, send/receive with Solana Pay QR, history), Borrow (Civic Pass → register → request → co-signer link → submit), Co-sign, Repay, Donate, Fund stats. Kora as fee payer so users pay $0.

## Launch parameters (decided)
- Loan token: USDC (6 decimals).
- `max_loan` = 500_000_000 ($500), `max_term_days` = 180, `grace_days` = 30, `cosigner_escrow_bps` = 2500 (25%).
- Pool authority: a Squads multisig vault, 2 of 3, all three keys held by the owner on separate devices (phone, hardware wallet, laptop). Single wallet on devnet. `freeze_pool` once rules are settled.
- Presentation: neutral. No audience, community or religious positioning in UI, docs or marketing.
- Defaults: no collections, no credit reporting, no legal action. Loss of co-signer escrow and both members barred is the only consequence.
- Identity: Civic Pass with government ID + Texas location check (paid Civic plan; pricing to confirm with Civic).
- Funding: owner seeds the fund.
