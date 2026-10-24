use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{error::GoodFaithError, events::Restituted, state::*, LOAN_SEED, POOL_SEED};

#[derive(Accounts)]
pub struct Restitute<'info> {
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
        constraint = loan.status == LoanStatus::Defaulted @ GoodFaithError::LoanNotSettled,
    )]
    pub loan: Box<Account<'info, Loan>>,
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
    pub token_program: Interface<'info, TokenInterface>,
}

/// Anyone pays back part or all of a settled loan's shortfall. The fund's loss is made good first; the
/// rest reimburses the co-signer for the escrow that was used (claimable from the vault). Once the
/// whole shortfall is back, the loan is Restituted and the bars it set are relaxed: the borrower to a
/// late-repayment bar from the settlement, the co-signer's lifted once none of their guaranteed losses
/// is outstanding, each only where that bar is the one the person is under now.
pub fn restitute_handler(mut ctx: Context<Restitute>, amount: u64) -> Result<()> {
    let a = &mut ctx.accounts;
    require!(amount > 0, GoodFaithError::AmountZero);
    let owed = a.loan.owed_after_settlement();
    require!(owed > 0, GoodFaithError::NothingOwed);
    require!(amount <= owed, GoodFaithError::OverRepay);

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
        a.mint.decimals,
    )?;

    let lost = a.loan.lost();
    let fund_had_back = a.loan.restituted.min(lost);
    let to_fund = amount.min(lost.saturating_sub(fund_had_back));
    let to_cosigner = amount
        .checked_sub(to_fund)
        .ok_or(GoodFaithError::MathOverflow)?;

    a.loan.restituted = a
        .loan
        .restituted
        .checked_add(amount)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.total_restituted = a
        .pool
        .total_restituted
        .checked_add(amount)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.total_lost = a
        .pool
        .total_lost
        .checked_sub(to_fund)
        .ok_or(GoodFaithError::MathOverflow)?;
    if to_cosigner > 0 {
        a.loan.reimbursement_pending = a
            .loan
            .reimbursement_pending
            .checked_add(to_cosigner)
            .ok_or(GoodFaithError::MathOverflow)?;
        a.pool.vault_claims = a
            .pool
            .vault_claims
            .checked_add(to_cosigner)
            .ok_or(GoodFaithError::MathOverflow)?;
    }

    let complete = a.loan.restituted == a.loan.shortfall;
    if complete {
        a.loan.status = LoanStatus::Restituted;
        let relaxed_to = if a.loan.late_ban_seconds > 0 {
            a.loan.closed_at.saturating_add(a.loan.late_ban_seconds)
        } else {
            0
        };
        if a.borrower_person
            .relax_bar(a.loan.borrower_bar_until, relaxed_to)
        {
            a.loan.borrower_bar_until = relaxed_to;
        }
        if a.loan.lost() > 0 {
            a.cosigner_person.unrestituted_losses =
                a.cosigner_person.unrestituted_losses.saturating_sub(1);
            // Lifted only once every loss this person guaranteed is paid back, and only where this
            // bar is the one they are under.
            if a.cosigner_person.unrestituted_losses == 0
                && a.cosigner_person.relax_bar(a.loan.cosigner_bar_until, 0)
            {
                a.loan.cosigner_bar_until = 0;
            }
        }
    }

    emit!(Restituted {
        pool: a.pool.key(),
        loan: a.loan.key(),
        loan_id: a.loan.id,
        payer: a.payer.key(),
        amount,
        to_fund,
        to_cosigner,
        restituted: a.loan.restituted,
        shortfall: a.loan.shortfall,
        complete,
        borrower_ineligible_until: a.borrower_person.ineligible_until,
        cosigner_ineligible_until: a.cosigner_person.ineligible_until,
    });
    Ok(())
}
