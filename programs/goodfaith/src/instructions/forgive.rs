use anchor_lang::prelude::*;

use crate::{error::GoodFaithError, events::Forgiven, state::*, LOAN_SEED, POOL_SEED};

/// The co-signer of a settled loan lets the borrower off the rest of the shortfall.
#[derive(Accounts)]
pub struct Forgive<'info> {
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
    #[account(address = loan.cosigner_person)]
    pub cosigner_person: Box<Account<'info, Person>>,
}

/// Forgiveness ends the debt, nothing else: the fund's loss stays a loss, the co-signer's bar runs its
/// course (it lifts only when the fund is made whole), and the borrower's bar is untouched. What it
/// changes is that nobody can pay this loan back any more and the books show it as closed.
pub fn forgive_handler(ctx: Context<Forgive>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let loan = &mut ctx.accounts.loan;
    let unpaid = loan.owed_after_settlement();
    require!(unpaid > 0, GoodFaithError::NothingOwed);
    loan.forgiven_at = now;
    loan.status = LoanStatus::Restituted;
    emit!(Forgiven {
        pool: ctx.accounts.pool.key(),
        loan: loan.key(),
        loan_id: loan.id,
        cosigner_person: ctx.accounts.cosigner_person.key(),
        by: ctx.accounts.cosigner.key(),
        unpaid,
    });
    Ok(())
}
