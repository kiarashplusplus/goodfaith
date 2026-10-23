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
    // The escrow goes back to the co-signer's *current* wallet, so a replaced wallet is not paid.
    // May equal `payer_token` when the co-signer repays; the two transfers run in order.
    #[account(
        mut,
        dup,
        token::mint = mint,
        token::authority = cosigner_person.wallet,
    )]
    pub cosigner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives the escrow account rent; must match `loan.rent_payer`.
    #[account(mut, address = loan.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn repay_handler(mut ctx: Context<Repay>, amount: u64) -> Result<()> {
    let a = &mut ctx.accounts;
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
    let fully_repaid = a.loan.repaid == a.loan.principal;

    if fully_repaid {
        a.loan.status = LoanStatus::Repaid;
        a.borrower_person.active_loan = None;
        a.cosigner_person.active_guarantees = a
            .cosigner_person
            .active_guarantees
            .checked_sub(1)
            .ok_or(GoodFaithError::MathOverflow)?;
        a.pool.active_loans = a
            .pool
            .active_loans
            .checked_sub(1)
            .ok_or(GoodFaithError::MathOverflow)?;

        let mint_key = a.mint.key();
        let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[a.pool.bump]];
        if a.escrow.amount > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    a.token_program.key(),
                    TransferChecked {
                        from: a.escrow.to_account_info(),
                        mint: a.mint.to_account_info(),
                        to: a.cosigner_token.to_account_info(),
                        authority: a.pool.to_account_info(),
                    },
                    &[seeds],
                ),
                a.escrow.amount,
                decimals,
            )?;
        }
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
    });
    Ok(())
}
