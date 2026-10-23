use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{error::GoodFaithError, events::Donated, state::*, POOL_SEED};

#[derive(Accounts)]
pub struct Donate<'info> {
    pub donor: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
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
        token::mint = mint,
        token::authority = donor,
    )]
    pub donor_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn donate_handler(ctx: Context<Donate>, amount: u64) -> Result<()> {
    require!(amount > 0, GoodFaithError::AmountZero);
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.donor_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.donor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    let pool = &mut ctx.accounts.pool;
    pool.total_donated = pool
        .total_donated
        .checked_add(amount)
        .ok_or(GoodFaithError::MathOverflow)?;
    emit!(Donated {
        pool: pool.key(),
        donor: ctx.accounts.donor.key(),
        amount,
    });
    Ok(())
}
