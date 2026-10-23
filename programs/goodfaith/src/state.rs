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
}

#[account]
#[derive(InitSpace)]
pub struct Member {
    pub wallet: Pubkey,
    pub active_loan: Option<Pubkey>,
    pub active_guarantees: u8,
    pub ineligible: bool,
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
}

/// Settings the pool authority can change.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PoolParams {
    pub gatekeeper_network: Pubkey,
    pub max_loan: u64,
    pub max_term_days: u16,
    pub grace_days: u16,
    pub max_guarantees_per_member: u8,
    pub cosigner_escrow_bps: u16,
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
        Ok(())
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
