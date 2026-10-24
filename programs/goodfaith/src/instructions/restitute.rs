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
/// rest gives the co-signer back the escrow that was used: escrow the fund has not collected yet is
/// simply released to them (the vault keeps the payment instead), the rest is owed to them out of the
/// vault. Once the fund's loss is covered and it was the last loss this co-signer guaranteed, their bar
/// is lifted, whoever paid. Once the whole shortfall is back and the borrower paid it themselves, their
/// bar is shortened to a late-payment bar counted from now; a third party's payment leaves it alone.
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

    let now = Clock::get()?.unix_timestamp;
    let lost = a.loan.lost();
    let fund_had_back = a.loan.restituted.min(lost);
    let to_fund = amount.min(lost.saturating_sub(fund_had_back));
    let to_cosigner = amount
        .checked_sub(to_fund)
        .ok_or(GoodFaithError::MathOverflow)?;
    let fund_covered_now = lost > 0 && fund_had_back < lost && fund_had_back + to_fund >= lost;

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
    // The co-signer's share: escrow still waiting to be collected is released to them where it is
    // (the fund keeps this payment in its place, so the vault is never short while the escrow is
    // frozen); only escrow the fund already collected is reimbursed from the vault.
    let converted = to_cosigner.min(a.loan.recovery_pending);
    let reimburse = to_cosigner
        .checked_sub(converted)
        .ok_or(GoodFaithError::MathOverflow)?;
    if converted > 0 {
        a.loan.recovery_pending -= converted;
        a.loan.refund_pending = a
            .loan
            .refund_pending
            .checked_add(converted)
            .ok_or(GoodFaithError::MathOverflow)?;
        a.pool.recoveries_pending = a
            .pool
            .recoveries_pending
            .checked_sub(converted)
            .ok_or(GoodFaithError::MathOverflow)?;
        a.pool.pending_claims = a
            .pool
            .pending_claims
            .checked_add(converted)
            .ok_or(GoodFaithError::MathOverflow)?;
    }
    if reimburse > 0 {
        a.loan.reimbursement_pending = a
            .loan
            .reimbursement_pending
            .checked_add(reimburse)
            .ok_or(GoodFaithError::MathOverflow)?;
        a.pool.vault_claims = a
            .pool
            .vault_claims
            .checked_add(reimburse)
            .ok_or(GoodFaithError::MathOverflow)?;
    }

    // The co-signer's bar answers to the fund's loss alone, in any order of pay-backs.
    let mut cosigner_lifted = false;
    if fund_covered_now {
        a.cosigner_person.unrestituted_losses = a
            .cosigner_person
            .unrestituted_losses
            .checked_sub(1)
            .ok_or(GoodFaithError::MathOverflow)?;
        if a.cosigner_person.unrestituted_losses == 0 {
            cosigner_lifted = a.cosigner_person.lift_cosigner_bar();
            a.loan.cosigner_bar_until = 0;
        }
    }

    let complete = a.loan.restituted == a.loan.shortfall;
    let mut borrower_relaxed = false;
    if complete {
        a.loan.status = LoanStatus::Restituted;
        // Only the borrower's own pay-back speaks for them; and the late bar runs from today, so a
        // pay-back years later still carries it.
        if a.payer.key() == a.borrower_person.wallet {
            let relaxed_to = now.saturating_add(a.loan.late_ban_seconds);
            if a.borrower_person
                .relax_borrower_bar(a.loan.key(), relaxed_to)
            {
                a.loan.borrower_bar_until = relaxed_to;
                borrower_relaxed = true;
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
        converted,
        complete,
        borrower_relaxed,
        cosigner_lifted,
        unrestituted_losses: a.cosigner_person.unrestituted_losses,
        borrower_person: a.borrower_person.key(),
        cosigner_person: a.cosigner_person.key(),
        borrower_ineligible_until: a.borrower_person.ineligible_until,
        cosigner_ineligible_until: a.cosigner_person.ineligible_until,
    });
    Ok(())
}
