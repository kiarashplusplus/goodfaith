use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Option<Pubkey>,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub gatekeeper_network: Pubkey,
    pub max_loan: u64,
    pub max_term_days: u16,
    pub grace_days: u16,
    pub max_guarantees_per_member: u8,
    pub cosigner_escrow_bps: u16,
    pub loan_count: u64,
    pub total_donated: u64,
    pub total_lent: u64,
    pub total_repaid: u64,
    pub total_recovered: u64,
    pub total_lost: u64,
    pub bump: u8,
    pub vault_bump: u8,
    /// Key named by `propose_authority`; becomes the authority once it calls `accept_authority`.
    pub pending_authority: Option<Pubkey>,
    /// Key that vouches for a person at registration and co-signs a wallet recovery. The zero key means suspended.
    pub issuer: Pubkey,
    /// Delay between scheduling a settings change (or a wind-down) and it taking effect.
    pub timelock_seconds: i64,
    /// Settings scheduled by `schedule_params`, applied by anyone with `apply_params` after `params_effective_at`.
    pub pending_params: Option<PoolParams>,
    pub params_effective_at: i64,
    /// Once set and reached, no new loans or donations; repayments and defaults continue.
    pub wind_down_at: Option<i64>,
    /// Token account of the pool mint that receives the vault balance once every loan is closed.
    pub successor: Option<Pubkey>,
    /// Loans currently Active.
    pub active_loans: u64,
    pub total_swept: u64,
    /// Second key, besides the issuer, that must sign a wallet recovery.
    pub recovery_authority: Pubkey,
    /// Key that may stop new lending at once (the authority can too).
    pub pause_authority: Pubkey,
    pub paused: bool,
    /// Rolling disbursement window: principal lent since `window_start`.
    pub window_start: i64,
    pub window_disbursed: u64,
    /// Escrow owed to co-signers of closed loans, waiting in escrow accounts to be claimed.
    pub pending_claims: u64,
    pub recovery_delay_seconds: i64,
    pub request_ttl_seconds: i64,
    pub first_loan_cap: u64,
    pub loan_cap_step: u64,
    pub cooldown_seconds: i64,
    pub max_exposure_per_person: u64,
    pub disbursement_window_seconds: i64,
    pub disbursement_cap_per_window: u64,
    pub default_ban_seconds: i64,
    pub late_ban_seconds: i64,
    pub cosigner_ban_seconds: i64,
    /// Principal still owed on Active loans (the fund's open credit).
    pub outstanding_principal: u64,
    /// Escrow owed to the fund by settled loans, still in escrow accounts until `collect_recovery`.
    pub recoveries_pending: u64,
    /// Reimbursements owed to co-signers out of the vault (restitution of escrow that was used).
    pub vault_claims: u64,
    /// Everything paid back after a settlement, by or for borrowers.
    pub total_restituted: u64,
    /// Reimbursements paid out of the vault to co-signers.
    pub total_reimbursed: u64,
    /// A loan counts towards the personal cap only when it ran at least this long.
    pub seasoning_seconds: i64,
    /// At most one cap step per person per this many seconds.
    pub cap_step_interval_seconds: i64,
    /// Ceiling on `outstanding_principal` (0 = none).
    pub max_outstanding_principal: u64,
    /// When `apply_params` last replaced the issuer, the recovery key or the gatekeeper network;
    /// wallet recoveries are refused for `KEY_QUARANTINE_SECONDS` after it.
    pub keys_changed_at: i64,
    /// Second key that must sign a wind-down announcement beside the authority's.
    pub successor_authority: Pubkey,
}

impl Pool {
    pub fn winding_down(&self, now: i64) -> bool {
        self.wind_down_at.is_some_and(|t| now >= t)
    }

    /// New loans are possible: not paused, not winding down.
    pub fn lending_open(&self, now: i64) -> bool {
        !self.paused && !self.winding_down(now)
    }
}

/// One verified human. Eligibility lives here, so it follows the person across wallets.
#[account]
#[derive(InitSpace)]
pub struct Person {
    /// Opaque id assigned by the issuer; the mapping to a credential lives off chain.
    pub person_id: [u8; 32],
    /// The wallet currently bound to this person.
    pub wallet: Pubkey,
    pub active_loan: Option<Pubkey>,
    pub active_guarantees: u8,
    /// Principal of the Active loans this person co-signs.
    pub active_guarantee_amount: u64,
    /// Loans repaid on time; raises the personal cap.
    pub completed_loans: u16,
    /// 0: eligible; i64::MAX: barred for good; otherwise barred until this time. Always the larger of
    /// `borrower_bar_until` and `cosigner_bar_until`; kept so every eligibility check reads one field.
    pub ineligible_until: i64,
    /// Until this time the person is on the first-loan cap (new or recovered membership).
    pub restricted_until: i64,
    /// Wallet a recovery would move the person to, once `pending_wallet_at` has passed and nobody vetoed.
    pub pending_wallet: Option<Pubkey>,
    pub pending_wallet_at: i64,
    pub bump: u8,
    /// When `completed_loans` last went up; spaces cap steps out in time.
    pub last_cap_step_at: i64,
    /// Settled loans this person co-signed whose loss is not yet paid back; the co-signer bar lifts at 0.
    pub unrestituted_losses: u16,
    /// Bar from this person's own default (0 when none). Relaxed only by their own pay-back of the loan
    /// that set it, or by `lift_bar`.
    pub borrower_bar_until: i64,
    /// Bar from a loss on a loan this person co-signed (0 when none). Lifted once every such loss is
    /// paid back, or by `lift_bar`.
    pub cosigner_bar_until: i64,
    /// The loan whose settlement set `borrower_bar_until`; only its pay-back relaxes that bar.
    pub borrower_bar_loan: Option<Pubkey>,
}

impl Person {
    pub fn eligible(&self, now: i64) -> bool {
        now >= self.ineligible_until
    }

    /// `ineligible_until` is derived: the longer of the two role bars.
    pub fn recompute_bar(&mut self) {
        self.ineligible_until = self.borrower_bar_until.max(self.cosigner_bar_until);
    }

    /// Largest loan this person may take now.
    pub fn loan_cap(&self, pool: &Pool, now: i64) -> u64 {
        if now < self.restricted_until {
            return pool.first_loan_cap.min(pool.max_loan);
        }
        pool.first_loan_cap
            .saturating_add(
                pool.loan_cap_step
                    .saturating_mul(u64::from(self.completed_loans)),
            )
            .min(pool.max_loan)
    }

    /// Bars the person as a borrower at least until `now + seconds` (never shortens an existing bar)
    /// and remembers which loan did it. Returns the bar this call stands for (0 when `seconds` is 0).
    pub fn bar_as_borrower(&mut self, now: i64, seconds: i64, loan: Pubkey) -> i64 {
        if seconds <= 0 {
            return 0;
        }
        let until = now.saturating_add(seconds);
        if until >= self.borrower_bar_until {
            self.borrower_bar_until = until;
            self.borrower_bar_loan = Some(loan);
        }
        self.recompute_bar();
        until
    }

    /// Bars the person as a co-signer at least until `now + seconds` (never shortens an existing bar).
    /// Returns the bar this call stands for (0 when `seconds` is 0).
    pub fn bar_as_cosigner(&mut self, now: i64, seconds: i64) -> i64 {
        if seconds <= 0 {
            return 0;
        }
        let until = now.saturating_add(seconds);
        if until > self.cosigner_bar_until {
            self.cosigner_bar_until = until;
        }
        self.recompute_bar();
        until
    }

    /// Shortens the borrower bar to `to` when `loan` is the loan that set it (a later default's bar
    /// stays). Returns true when the bar changed.
    pub fn relax_borrower_bar(&mut self, loan: Pubkey, to: i64) -> bool {
        if self.borrower_bar_loan != Some(loan) || to >= self.borrower_bar_until {
            return false;
        }
        self.borrower_bar_until = to;
        self.recompute_bar();
        true
    }

    /// Ends the co-signer bar. Returns true when there was one.
    pub fn lift_cosigner_bar(&mut self) -> bool {
        let had = self.cosigner_bar_until != 0;
        self.cosigner_bar_until = 0;
        self.recompute_bar();
        had
    }

    /// Clears every bar (the authority's remedy). `unrestituted_losses` is kept, so a later loss still bars.
    pub fn clear_bars(&mut self) {
        self.borrower_bar_until = 0;
        self.cosigner_bar_until = 0;
        self.borrower_bar_loan = None;
        self.recompute_bar();
    }
}

/// Wallet to person link. Kept after a wallet is replaced so it can never be bound to another person.
#[account]
#[derive(InitSpace)]
pub struct Member {
    pub wallet: Pubkey,
    pub person: Pubkey,
    pub retired: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum LoanStatus {
    Active,
    /// Repaid in full at or before the deadline.
    Repaid,
    /// Settled after the deadline: the shortfall came out of the escrow, the rest is a loss until restituted.
    Defaulted,
    /// Settled, and the whole shortfall has since been paid back.
    Restituted,
}

#[account]
#[derive(InitSpace)]
pub struct Loan {
    pub id: u64,
    pub borrower: Pubkey,
    pub cosigner: Pubkey,
    pub rent_payer: Pubkey,
    pub principal: u64,
    pub repaid: u64,
    pub escrowed: u64,
    pub opened_at: i64,
    pub due_at: i64,
    /// Grace period fixed when the loan opened; later pool changes do not apply.
    pub grace_days: u16,
    pub status: LoanStatus,
    pub bump: u8,
    pub escrow_bump: u8,
    /// The people behind the wallets at opening; eligibility and escrow returns follow these.
    pub borrower_person: Pubkey,
    pub cosigner_person: Pubkey,
    /// When the loan left Active.
    pub closed_at: i64,
    /// Escrow owed to the co-signer, still in the escrow account until `claim_escrow`.
    pub refund_pending: u64,
    /// Principal unpaid at settlement.
    pub shortfall: u64,
    /// Escrow applied to the shortfall at settlement (fixed then; `lost` is the rest).
    pub recovered: u64,
    /// Of `recovered`, what is still in the escrow account until `collect_recovery`.
    pub recovery_pending: u64,
    /// Paid back after settlement, by or for the borrower.
    pub restituted: u64,
    /// Reimbursement owed to the co-signer out of the vault (their escrow, paid back by restitution).
    pub reimbursement_pending: u64,
    /// Bars this loan set at settlement (0 when none); relaxed when the loan is restituted.
    pub borrower_bar_until: i64,
    pub cosigner_bar_until: i64,
    /// Consequences fixed when the loan opened; later pool changes do not apply.
    pub default_ban_seconds: i64,
    pub late_ban_seconds: i64,
    pub cosigner_ban_seconds: i64,
    /// Cap-credit rules fixed when the loan opened.
    pub seasoning_seconds: i64,
    pub cap_step_interval_seconds: i64,
    /// When the co-signer forgave the unpaid rest of the shortfall (0 = not forgiven).
    pub forgiven_at: i64,
}

impl Loan {
    /// Last second at which a repayment is on time.
    pub fn deadline(&self) -> Option<i64> {
        i64::from(self.grace_days)
            .checked_mul(crate::SECONDS_PER_DAY)
            .and_then(|g| self.due_at.checked_add(g))
    }

    /// What the fund wrote off at settlement and has not had back yet.
    pub fn lost(&self) -> u64 {
        self.shortfall.saturating_sub(self.recovered)
    }

    /// Still owed by the borrower after settlement (nothing once the co-signer forgave the rest).
    pub fn owed_after_settlement(&self) -> u64 {
        if self.forgiven_at != 0 {
            return 0;
        }
        self.shortfall.saturating_sub(self.restituted)
    }
}

/// Settings the pool authority can change (after the timelock).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace, PartialEq, Eq)]
pub struct PoolParams {
    pub gatekeeper_network: Pubkey,
    pub max_loan: u64,
    pub max_term_days: u16,
    pub grace_days: u16,
    pub max_guarantees_per_member: u8,
    pub cosigner_escrow_bps: u16,
    pub issuer: Pubkey,
    pub timelock_seconds: i64,
    pub recovery_authority: Pubkey,
    pub pause_authority: Pubkey,
    pub recovery_delay_seconds: i64,
    pub request_ttl_seconds: i64,
    pub first_loan_cap: u64,
    pub loan_cap_step: u64,
    pub cooldown_seconds: i64,
    pub max_exposure_per_person: u64,
    pub disbursement_window_seconds: i64,
    pub disbursement_cap_per_window: u64,
    pub default_ban_seconds: i64,
    pub late_ban_seconds: i64,
    pub cosigner_ban_seconds: i64,
    pub seasoning_seconds: i64,
    pub cap_step_interval_seconds: i64,
    pub max_outstanding_principal: u64,
    /// Second key for `announce_wind_down`.
    pub successor_authority: Pubkey,
}

impl PoolParams {
    pub fn validate(&self) -> Result<()> {
        use crate::error::GoodFaithError;
        require!(
            u64::from(self.cosigner_escrow_bps) <= crate::BPS_DENOMINATOR,
            GoodFaithError::InvalidBps
        );
        require!(
            self.max_loan > 0 && self.max_term_days > 0 && self.max_guarantees_per_member > 0,
            GoodFaithError::InvalidParams
        );
        require!(
            self.max_term_days <= crate::MAX_TERM_DAYS && self.grace_days <= crate::MAX_GRACE_DAYS,
            GoodFaithError::InvalidParams
        );
        require!(
            (0..=crate::MAX_TIMELOCK_SECONDS).contains(&self.timelock_seconds),
            GoodFaithError::InvalidParams
        );
        require!(
            (0..=crate::MAX_RECOVERY_DELAY_SECONDS).contains(&self.recovery_delay_seconds),
            GoodFaithError::InvalidParams
        );
        require!(
            (1..=crate::MAX_REQUEST_TTL_SECONDS).contains(&self.request_ttl_seconds),
            GoodFaithError::InvalidParams
        );
        require!(self.first_loan_cap > 0, GoodFaithError::InvalidParams);
        require!(
            (0..=crate::MAX_COOLDOWN_SECONDS).contains(&self.cooldown_seconds),
            GoodFaithError::InvalidParams
        );
        require!(
            self.max_exposure_per_person > 0,
            GoodFaithError::InvalidParams
        );
        require!(
            (1..=crate::MAX_WINDOW_SECONDS).contains(&self.disbursement_window_seconds),
            GoodFaithError::InvalidParams
        );
        // Paying back after a default can only ever shorten the bar, never lengthen it.
        require!(
            self.default_ban_seconds >= 0
                && self.late_ban_seconds >= 0
                && self.cosigner_ban_seconds >= 0
                && self.late_ban_seconds <= self.default_ban_seconds,
            GoodFaithError::InvalidParams
        );
        require!(
            self.successor_authority != Pubkey::default(),
            GoodFaithError::InvalidParams
        );
        require!(
            (0..=crate::MAX_SEASONING_SECONDS).contains(&self.seasoning_seconds)
                && (0..=crate::MAX_SEASONING_SECONDS).contains(&self.cap_step_interval_seconds),
            GoodFaithError::InvalidParams
        );
        Ok(())
    }

    pub fn apply_to(&self, pool: &mut Pool) {
        pool.gatekeeper_network = self.gatekeeper_network;
        pool.max_loan = self.max_loan;
        pool.max_term_days = self.max_term_days;
        pool.grace_days = self.grace_days;
        pool.max_guarantees_per_member = self.max_guarantees_per_member;
        pool.cosigner_escrow_bps = self.cosigner_escrow_bps;
        pool.issuer = self.issuer;
        pool.timelock_seconds = self.timelock_seconds;
        pool.recovery_authority = self.recovery_authority;
        pool.pause_authority = self.pause_authority;
        pool.recovery_delay_seconds = self.recovery_delay_seconds;
        pool.request_ttl_seconds = self.request_ttl_seconds;
        pool.first_loan_cap = self.first_loan_cap;
        pool.loan_cap_step = self.loan_cap_step;
        pool.cooldown_seconds = self.cooldown_seconds;
        pool.max_exposure_per_person = self.max_exposure_per_person;
        pool.disbursement_window_seconds = self.disbursement_window_seconds;
        pool.disbursement_cap_per_window = self.disbursement_cap_per_window;
        pool.default_ban_seconds = self.default_ban_seconds;
        pool.late_ban_seconds = self.late_ban_seconds;
        pool.cosigner_ban_seconds = self.cosigner_ban_seconds;
        pool.seasoning_seconds = self.seasoning_seconds;
        pool.cap_step_interval_seconds = self.cap_step_interval_seconds;
        pool.max_outstanding_principal = self.max_outstanding_principal;
        pool.successor_authority = self.successor_authority;
    }

    /// The keys that can move a membership: a change to any of them starts the recovery quarantine.
    pub fn changes_identity_keys(&self, pool: &Pool) -> bool {
        self.issuer != pool.issuer
            || self.recovery_authority != pool.recovery_authority
            || self.gatekeeper_network != pool.gatekeeper_network
    }
}

/// A borrower's pending ask, waiting for the named co-signer.
#[account]
#[derive(InitSpace)]
pub struct LoanRequest {
    pub borrower: Pubkey,
    pub cosigner: Pubkey,
    pub amount: u64,
    pub term_days: u16,
    pub created_at: i64,
    pub rent_payer: Pubkey,
    pub bump: u8,
    /// After this time the request can no longer be co-signed and anyone may close it.
    pub expires_at: i64,
}
