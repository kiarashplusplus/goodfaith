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
    pub person: Pubkey,
}

#[event]
pub struct RebindProposed {
    pub pool: Pubkey,
    pub person: Pubkey,
    pub old_wallet: Pubkey,
    pub new_wallet: Pubkey,
    pub effective_at: i64,
}

#[event]
pub struct RebindVetoed {
    pub pool: Pubkey,
    pub person: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct WalletRebound {
    pub pool: Pubkey,
    pub person: Pubkey,
    pub old_wallet: Pubkey,
    pub new_wallet: Pubkey,
}

#[event]
pub struct LendingPaused {
    pub pool: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct LendingResumed {
    pub pool: Pubkey,
}

#[event]
pub struct EscrowClaimed {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub loan_id: u64,
    pub to_wallet: Pubkey,
    pub amount: u64,
    /// Escrow refund paid from the escrow account.
    pub from_escrow: u64,
    /// Reimbursement paid from the vault.
    pub from_vault: u64,
}

#[event]
pub struct RecoveryCollected {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub loan_id: u64,
    pub amount: u64,
    pub by: Pubkey,
}

#[event]
pub struct Restituted {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub loan_id: u64,
    pub payer: Pubkey,
    pub amount: u64,
    /// Part of `amount` that made the fund's loss good.
    pub to_fund: u64,
    /// Part of `amount` now owed to the co-signer out of the vault.
    pub to_cosigner: u64,
    pub restituted: u64,
    pub shortfall: u64,
    /// The whole shortfall is paid back: the loan is Restituted and its bars relaxed.
    pub complete: bool,
    pub borrower_ineligible_until: i64,
    pub cosigner_ineligible_until: i64,
}

#[event]
pub struct BarLifted {
    pub pool: Pubkey,
    pub person: Pubkey,
    pub by: Pubkey,
    /// Hash of the operator's written reason; the log it points to is public.
    pub reason: [u8; 32],
    pub previous_until: i64,
}

#[event]
pub struct RequestExpiredClosed {
    pub pool: Pubkey,
    pub borrower: Pubkey,
    pub closed_by: Pubkey,
}

#[event]
pub struct ParamsScheduled {
    pub pool: Pubkey,
    pub params: crate::state::PoolParams,
    pub effective_at: i64,
}

#[event]
pub struct ParamsCancelled {
    pub pool: Pubkey,
}

#[event]
pub struct IssuerSuspended {
    pub pool: Pubkey,
}

#[event]
pub struct WindDownAnnounced {
    pub pool: Pubkey,
    pub successor: Pubkey,
    pub effective_at: i64,
}

#[event]
pub struct WindDownCancelled {
    pub pool: Pubkey,
}

#[event]
pub struct SweptToSuccessor {
    pub pool: Pubkey,
    pub successor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct LoanOpened {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub loan_id: u64,
    pub borrower: Pubkey,
    pub cosigner: Pubkey,
    pub borrower_person: Pubkey,
    pub cosigner_person: Pubkey,
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
    /// The closing payment raised the borrower's cap (seasoned and spaced out enough).
    pub cap_credited: bool,
    /// Escrow now waiting for the co-signer to claim (closing payment only).
    pub refund_pending: u64,
}

#[event]
pub struct LoanSettled {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub loan_id: u64,
    pub borrower: Pubkey,
    pub cosigner: Pubkey,
    pub shortfall: u64,
    /// Escrow applied to the shortfall, waiting in the escrow account for `collect_recovery`.
    pub recovered: u64,
    /// Escrow left over, waiting in the escrow account for `claim_escrow`.
    pub escrow_returned: u64,
    pub lost: u64,
    /// False when the escrow covered the whole shortfall: the co-signer keeps their eligibility.
    pub cosigner_barred: bool,
    pub borrower_ineligible_until: i64,
    pub cosigner_ineligible_until: i64,
    /// The escrow was empty and could be closed at once.
    pub escrow_closed: bool,
}

#[event]
pub struct LoanRequested {
    pub pool: Pubkey,
    pub borrower: Pubkey,
    pub cosigner: Pubkey,
    pub amount: u64,
    pub term_days: u16,
    pub expires_at: i64,
}

#[event]
pub struct RequestCancelled {
    pub pool: Pubkey,
    pub borrower: Pubkey,
    pub cancelled_by: Pubkey,
}
