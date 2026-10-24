use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface};

use crate::{
    error::GoodFaithError, events::LoanSettled, state::*, ESCROW_SEED, LOAN_SEED, POOL_SEED,
};

#[derive(Accounts)]
pub struct Settle<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [LOAN_SEED, pool.key().as_ref(), loan.id.to_le_bytes().as_ref()],
        bump = loan.bump,
        constraint = loan.status == LoanStatus::Active @ GoodFaithError::LoanNotActive,
    )]
    pub loan: Box<Account<'info, Loan>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, loan.key().as_ref()],
        bump = loan.escrow_bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = loan.borrower_person)]
    pub borrower_person: Box<Account<'info, Person>>,
    #[account(mut, address = loan.cosigner_person)]
    pub cosigner_person: Box<Account<'info, Person>>,
    /// CHECK: receives the escrow account rent when the escrow is empty; must match `loan.rent_payer`.
    #[account(mut, address = loan.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// After the deadline, anyone settles the loan. Settlement is bookkeeping only: it fixes what the fund
/// recovers from the escrow and what the co-signer gets back, and records both as entitlements. The
/// tokens move later, by `collect_recovery` and `claim_escrow`, so a frozen escrow can never block a
/// settlement, and nothing is written off because an account could not be touched.
pub fn settle_handler(mut ctx: Context<Settle>) -> Result<()> {
    let a = &mut ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    let deadline = a.loan.deadline().ok_or(GoodFaithError::MathOverflow)?;
    require!(now > deadline, GoodFaithError::NotYetDefaultable);

    let shortfall = a
        .loan
        .principal
        .checked_sub(a.loan.repaid)
        .ok_or(GoodFaithError::MathOverflow)?;
    let held = a.escrow.amount;
    let recovered = held.min(shortfall);
    let returned = held
        .checked_sub(recovered)
        .ok_or(GoodFaithError::MathOverflow)?;
    let lost = shortfall
        .checked_sub(recovered)
        .ok_or(GoodFaithError::MathOverflow)?;

    // Empty escrow: nothing is owed to anyone from it, so give the rent back now (unless it is frozen,
    // in which case the token program would refuse; it then simply stays).
    let mut escrow_closed = false;
    if held == 0 && !a.escrow.is_frozen() {
        let mint_key = a.mint.key();
        let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[a.pool.bump]];
        token_interface::close_account(CpiContext::new_with_signer(
            a.token_program.key(),
            CloseAccount {
                account: a.escrow.to_account_info(),
                destination: a.rent_payer.to_account_info(),
                authority: a.pool.to_account_info(),
            },
            &[seeds],
        ))?;
        escrow_closed = true;
    }

    a.pool.recoveries_pending = a
        .pool
        .recoveries_pending
        .checked_add(recovered)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.pending_claims = a
        .pool
        .pending_claims
        .checked_add(returned)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.total_lost = a
        .pool
        .total_lost
        .checked_add(lost)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.outstanding_principal = a
        .pool
        .outstanding_principal
        .checked_sub(shortfall)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.active_loans = a
        .pool
        .active_loans
        .checked_sub(1)
        .ok_or(GoodFaithError::MathOverflow)?;

    let borrower_bar_until = a.borrower_person.bar(now, a.loan.default_ban_seconds);
    a.borrower_person.active_loan = None;
    // The co-signer's deposit did its job: if the fund was made whole, they keep their standing.
    let cosigner_barred = lost > 0;
    let cosigner_bar_until = if cosigner_barred {
        a.cosigner_person.unrestituted_losses =
            a.cosigner_person.unrestituted_losses.saturating_add(1);
        a.cosigner_person.bar(now, a.loan.cosigner_ban_seconds)
    } else {
        0
    };
    a.cosigner_person.active_guarantees = a
        .cosigner_person
        .active_guarantees
        .checked_sub(1)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.cosigner_person.active_guarantee_amount = a
        .cosigner_person
        .active_guarantee_amount
        .checked_sub(a.loan.principal)
        .ok_or(GoodFaithError::MathOverflow)?;

    let loan = &mut a.loan;
    loan.status = LoanStatus::Defaulted;
    loan.closed_at = now;
    loan.shortfall = shortfall;
    loan.recovered = recovered;
    loan.recovery_pending = recovered;
    loan.refund_pending = returned;
    loan.restituted = 0;
    loan.reimbursement_pending = 0;
    loan.borrower_bar_until = borrower_bar_until;
    loan.cosigner_bar_until = cosigner_bar_until;

    emit!(LoanSettled {
        pool: a.pool.key(),
        loan: a.loan.key(),
        loan_id: a.loan.id,
        borrower: a.loan.borrower,
        cosigner: a.loan.cosigner,
        shortfall,
        recovered,
        escrow_returned: returned,
        lost,
        cosigner_barred: cosigner_bar_until != 0,
        borrower_ineligible_until: a.borrower_person.ineligible_until,
        cosigner_ineligible_until: a.cosigner_person.ineligible_until,
        escrow_closed,
    });
    Ok(())
}
