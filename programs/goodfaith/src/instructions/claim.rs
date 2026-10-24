use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    error::GoodFaithError, events::EscrowClaimed, state::*, ESCROW_SEED, LOAN_SEED, POOL_SEED,
};

/// Anyone moves a closed loan's leftover escrow to the co-signer's current wallet and closes the escrow.
#[derive(Accounts)]
pub struct ClaimEscrow<'info> {
    pub claimer: Signer<'info>,
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
        constraint = loan.status != LoanStatus::Active @ GoodFaithError::LoanNotActive,
        constraint = loan.refund_pending > 0 @ GoodFaithError::NothingToClaim,
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
    #[account(address = loan.cosigner_person)]
    pub cosigner_person: Box<Account<'info, Person>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = cosigner_person.wallet,
    )]
    pub cosigner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives the escrow account rent; must match `loan.rent_payer`.
    #[account(mut, address = loan.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn claim_escrow_handler(mut ctx: Context<ClaimEscrow>) -> Result<()> {
    let a = &mut ctx.accounts;
    let amount = a.escrow.amount;
    let mint_key = a.mint.key();
    let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[a.pool.bump]];
    if amount > 0 {
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
            amount,
            a.mint.decimals,
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
    a.pool.pending_claims = a
        .pool
        .pending_claims
        .checked_sub(a.loan.refund_pending)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.loan.refund_pending = 0;
    emit!(EscrowClaimed {
        pool: a.pool.key(),
        loan: a.loan.key(),
        loan_id: a.loan.id,
        to_wallet: a.cosigner_person.wallet,
        amount,
    });
    Ok(())
}
