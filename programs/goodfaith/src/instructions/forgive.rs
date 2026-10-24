use anchor_lang::prelude::*;

use crate::{
    error::GoodFaithError,
    events::{FundClaimForgiven, ReimbursementWaived},
    instructions::restitute::close_if_settled_up,
    state::*,
    LOAN_SEED, POOL_SEED,
};

/// A settled loan carries two claims: the fund's loss and the co-signer's used deposit. Each party can
/// give up only its own: the co-signer waives their reimbursement, the fund's authority forgives the
/// fund's claim in public with a written reason.
#[derive(Accounts)]
pub struct WaiveReimbursement<'info> {
    #[account(constraint = cosigner.key() == cosigner_person.wallet @ GoodFaithError::Unauthorized)]
    pub cosigner: Signer<'info>,
    #[account(
        seeds = [POOL_SEED, pool.mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut,
        seeds = [LOAN_SEED, pool.key().as_ref(), loan.id.to_le_bytes().as_ref()],
        bump = loan.bump,
        constraint = loan.status == LoanStatus::Defaulted @ GoodFaithError::LoanNotSettled,
    )]
    pub loan: Box<Account<'info, Loan>>,
    #[account(mut, address = loan.borrower_person)]
    pub borrower_person: Box<Account<'info, Person>>,
    #[account(address = loan.cosigner_person)]
    pub cosigner_person: Box<Account<'info, Person>>,
}

/// The co-signer gives up what pay-backs would still return to them. The fund's claim is untouched and
/// stays payable; the co-signer's bar answers to it as before. If the fund was already paid back in full,
/// the loan is settled up and the borrower's late bar applies.
pub fn waive_reimbursement_handler(mut ctx: Context<WaiveReimbursement>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    let waived = a.loan.owed_to_cosigner();
    require!(waived > 0, GoodFaithError::NothingToWaive);
    a.loan.cosigner_waived_at = now;
    let (complete, borrower_relaxed) =
        close_if_settled_up(&mut a.loan, &mut a.borrower_person, now);
    emit!(ReimbursementWaived {
        pool: a.pool.key(),
        loan: a.loan.key(),
        loan_id: a.loan.id,
        cosigner_person: a.cosigner_person.key(),
        by: a.cosigner.key(),
        waived,
        fund_owed: a.loan.owed_to_fund(),
        complete,
        borrower_relaxed,
        borrower_ineligible_until: a.borrower_person.ineligible_until,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ForgiveFundClaim<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_SEED, pool.mint.as_ref()],
        bump = pool.bump,
        constraint = pool.authority == Some(authority.key()) @ GoodFaithError::Unauthorized,
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut,
        seeds = [LOAN_SEED, pool.key().as_ref(), loan.id.to_le_bytes().as_ref()],
        bump = loan.bump,
        constraint = loan.status == LoanStatus::Defaulted @ GoodFaithError::LoanNotSettled,
    )]
    pub loan: Box<Account<'info, Loan>>,
    #[account(mut, address = loan.borrower_person)]
    pub borrower_person: Box<Account<'info, Person>>,
}

/// The authority forgives what the fund is still owed, in public, with the hash of a written reason.
/// It is not a recovery: the loss stays recognised, the co-signer's claim stays payable, and no bar
/// changes (the co-signer's runs to its expiry; `lift_bar` is the separate remedy).
pub fn forgive_fund_claim_handler(
    mut ctx: Context<ForgiveFundClaim>,
    reason: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    let forgiven = a.loan.owed_to_fund();
    require!(forgiven > 0, GoodFaithError::NothingOwed);
    a.loan.fund_forgiven_at = now;
    a.loan.fund_forgiveness_reason = reason;
    a.pool.total_forgiven = a
        .pool
        .total_forgiven
        .checked_add(forgiven)
        .ok_or(GoodFaithError::MathOverflow)?;
    let (complete, _) = close_if_settled_up(&mut a.loan, &mut a.borrower_person, now);
    emit!(FundClaimForgiven {
        pool: a.pool.key(),
        loan: a.loan.key(),
        loan_id: a.loan.id,
        by: a.authority.key(),
        reason,
        forgiven,
        cosigner_owed: a.loan.owed_to_cosigner(),
        complete,
    });
    Ok(())
}
