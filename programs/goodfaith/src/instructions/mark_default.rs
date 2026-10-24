use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    error::GoodFaithError, events::LoanDefaulted, state::*, ESCROW_SEED, LOAN_SEED, POOL_SEED,
};

#[derive(Accounts)]
pub struct MarkDefault<'info> {
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
        address = pool.vault,
        token::mint = mint,
        token::authority = pool,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
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
    /// CHECK: receives the escrow account rent when nothing is left to claim; must match `loan.rent_payer`.
    #[account(mut, address = loan.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// After the term and grace period, anyone settles the loan: the unpaid balance comes out of the escrow
/// into the vault; whatever is left waits for the co-signer to claim.
pub fn mark_default_handler(mut ctx: Context<MarkDefault>) -> Result<()> {
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

    let decimals = a.mint.decimals;
    let mint_key = a.mint.key();
    let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[a.pool.bump]];
    if recovered > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.escrow.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.vault.to_account_info(),
                    authority: a.pool.to_account_info(),
                },
                &[seeds],
            ),
            recovered,
            decimals,
        )?;
    }
    if returned > 0 {
        a.loan.refund_pending = returned;
        a.pool.pending_claims = a
            .pool
            .pending_claims
            .checked_add(returned)
            .ok_or(GoodFaithError::MathOverflow)?;
    } else {
        token_interface::close_account(CpiContext::new_with_signer(
            a.token_program.key(),
            CloseAccount {
                account: a.escrow.to_account_info(),
                destination: a.rent_payer.to_account_info(),
                authority: a.pool.to_account_info(),
            },
            &[seeds],
        ))?;
    }

    a.pool.total_recovered = a
        .pool
        .total_recovered
        .checked_add(recovered)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.total_lost = a
        .pool
        .total_lost
        .checked_add(lost)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.active_loans = a
        .pool
        .active_loans
        .checked_sub(1)
        .ok_or(GoodFaithError::MathOverflow)?;

    a.loan.status = LoanStatus::Defaulted;
    a.loan.closed_at = now;
    let default_ban = a.pool.default_ban_seconds;
    a.borrower_person.bar(now, default_ban);
    a.borrower_person.active_loan = None;
    // The co-signer's deposit did its job: if the fund was made whole, they keep their standing.
    let cosigner_barred = lost > 0;
    if cosigner_barred {
        let cosigner_ban = a.pool.cosigner_ban_seconds;
        a.cosigner_person.bar(now, cosigner_ban);
    }
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

    emit!(LoanDefaulted {
        pool: a.pool.key(),
        loan: a.loan.key(),
        loan_id: a.loan.id,
        borrower: a.loan.borrower,
        cosigner: a.loan.cosigner,
        recovered,
        lost,
        escrow_returned: returned,
        cosigner_barred: cosigner_barred && a.pool.cosigner_ban_seconds > 0,
        borrower_ineligible_until: a.borrower_person.ineligible_until,
        cosigner_ineligible_until: a.cosigner_person.ineligible_until,
    });
    Ok(())
}
