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
    /// Key that vouches for a person at registration and wallet replacement. The zero key means suspended.
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
}

impl Pool {
    pub fn winding_down(&self, now: i64) -> bool {
        self.wind_down_at.is_some_and(|t| now >= t)
    }
}

/// One verified human. Eligibility lives here, so it follows the person across wallets.
#[account]
#[derive(InitSpace)]
pub struct Person {
    pub person_hash: [u8; 32],
    /// The wallet currently bound to this person.
    pub wallet: Pubkey,
    pub active_loan: Option<Pubkey>,
    pub active_guarantees: u8,
    pub ineligible: bool,
    pub bump: u8,
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
    Repaid,
    Defaulted,
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
}

impl PoolParams {
    pub fn validate(&self) -> Result<()> {
        require!(
            u64::from(self.cosigner_escrow_bps) <= crate::BPS_DENOMINATOR,
            crate::error::GoodFaithError::InvalidBps
        );
        require!(
            self.max_loan > 0 && self.max_term_days > 0 && self.max_guarantees_per_member > 0,
            crate::error::GoodFaithError::InvalidParams
        );
        require!(
            self.max_term_days <= crate::MAX_TERM_DAYS && self.grace_days <= crate::MAX_GRACE_DAYS,
            crate::error::GoodFaithError::InvalidParams
        );
        require!(
            (0..=crate::MAX_TIMELOCK_SECONDS).contains(&self.timelock_seconds),
            crate::error::GoodFaithError::InvalidParams
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
}
