use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{error::GoodFaithError, events::Repaid, state::*, ESCROW_SEED, LOAN_SEED, POOL_SEED};

#[derive(Accounts)]
pub struct Repay<'info> {
    pub payer: Signer<'info>,
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
    #[account(
        mut,
        token::mint = mint,
        token::authority = payer,
    )]
    pub payer_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives the escrow account rent when the escrow is empty; must match `loan.rent_payer`.
    #[account(mut, address = loan.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Repayment is only possible up to the deadline; after it the loan is settled like any other and the
/// borrower pays back through `restitute`, so a late payer and the cranker reach the same state.
/// Repayment never touches a co-signer's token account: on the closing payment the escrow is marked as
/// owed and waits for `claim_escrow`, so a frozen or closed account can never block a loan from closing.
pub fn repay_handler(mut ctx: Context<Repay>, amount: u64) -> Result<()> {
    let a = &mut ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    let deadline = a.loan.deadline().ok_or(GoodFaithError::MathOverflow)?;
    require!(now <= deadline, GoodFaithError::LoanPastDeadline);
    require!(amount > 0, GoodFaithError::AmountZero);
    let owed = a
        .loan
        .principal
        .checked_sub(a.loan.repaid)
        .ok_or(GoodFaithError::MathOverflow)?;
    require!(amount <= owed, GoodFaithError::OverRepay);

    let decimals = a.mint.decimals;
    token_interface::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.payer_token.to_account_info(),
                mint: a.mint.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.payer.to_account_info(),
            },
        ),
        amount,
        decimals,
    )?;

    a.loan.repaid = a
        .loan
        .repaid
        .checked_add(amount)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.total_repaid = a
        .pool
        .total_repaid
        .checked_add(amount)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.outstanding_principal = a
        .pool
        .outstanding_principal
        .checked_sub(amount)
        .ok_or(GoodFaithError::MathOverflow)?;
    let fully_repaid = a.loan.repaid == a.loan.principal;
    let mut cap_credited = false;
    let mut refund_pending = 0;

    if fully_repaid {
        a.loan.status = LoanStatus::Repaid;
        a.loan.closed_at = now;
        a.borrower_person.active_loan = None;
        // The cap grows only on loans that ran their course, and at most once per interval, so
        // borrowing and repaying at once does not buy a larger loan.
        let seasoned = now.saturating_sub(a.loan.opened_at) >= a.pool.seasoning_seconds;
        let spaced = now.saturating_sub(a.borrower_person.last_cap_step_at)
            >= a.pool.cap_step_interval_seconds;
        if seasoned && spaced {
            a.borrower_person.completed_loans = a.borrower_person.completed_loans.saturating_add(1);
            a.borrower_person.last_cap_step_at = now;
            cap_credited = true;
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
        a.pool.active_loans = a
            .pool
            .active_loans
            .checked_sub(1)
            .ok_or(GoodFaithError::MathOverflow)?;

        refund_pending = a.escrow.amount;
        if refund_pending > 0 {
            a.loan.refund_pending = refund_pending;
            a.pool.pending_claims = a
                .pool
                .pending_claims
                .checked_add(refund_pending)
                .ok_or(GoodFaithError::MathOverflow)?;
        } else {
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
        }
    }

    emit!(Repaid {
        pool: a.pool.key(),
        loan: a.loan.key(),
        loan_id: a.loan.id,
        borrower: a.loan.borrower,
        cosigner: a.loan.cosigner,
        payer: a.payer.key(),
        amount,
        total_repaid: a.loan.repaid,
        fully_repaid,
        cap_credited,
        refund_pending,
    });
    Ok(())
}
