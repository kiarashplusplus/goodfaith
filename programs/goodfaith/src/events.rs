use anchor_lang::prelude::*;

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct PoolUpdated {
    pub pool: Pubkey,
    pub params: crate::state::PoolParams,
}

#[event]
pub struct PoolFrozen {
    pub pool: Pubkey,
}

#[event]
pub struct AuthorityProposed {
    pub pool: Pubkey,
    pub current: Pubkey,
    pub proposed: Pubkey,
}

#[event]
pub struct AuthorityProposalCancelled {
    pub pool: Pubkey,
    pub cancelled: Pubkey,
}

#[event]
pub struct AuthorityChanged {
    pub pool: Pubkey,
    pub old: Pubkey,
    pub new: Pubkey,
}

#[event]
pub struct Donated {
    pub pool: Pubkey,
    pub donor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MemberRegistered {
    pub pool: Pubkey,
    pub wallet: Pubkey,
}

#[event]
pub struct LoanOpened {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub loan_id: u64,
    pub borrower: Pubkey,
    pub cosigner: Pubkey,
    pub principal: u64,
    pub escrowed: u64,
    pub due_at: i64,
}

#[event]
pub struct Repaid {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub loan_id: u64,
    pub borrower: Pubkey,
    pub cosigner: Pubkey,
    pub payer: Pubkey,
    pub amount: u64,
    pub total_repaid: u64,
    pub fully_repaid: bool,
}

#[event]
pub struct LoanDefaulted {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub loan_id: u64,
    pub borrower: Pubkey,
    pub cosigner: Pubkey,
    pub recovered: u64,
    pub lost: u64,
    pub escrow_returned: u64,
}

#[event]
pub struct LoanRequested {
    pub pool: Pubkey,
    pub borrower: Pubkey,
    pub cosigner: Pubkey,
    pub amount: u64,
    pub term_days: u16,
}

#[event]
pub struct RequestCancelled {
    pub pool: Pubkey,
    pub borrower: Pubkey,
    pub cancelled_by: Pubkey,
}
