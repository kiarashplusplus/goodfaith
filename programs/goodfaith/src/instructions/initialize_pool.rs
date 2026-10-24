use anchor_lang::prelude::*;
use anchor_spl::{
    token::{Mint, Token},
    token_interface::TokenAccount,
};

use crate::{events::PoolInitialized, state::*, POOL_SEED, VAULT_SEED};

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Classic SPL Token mints only. Token-2022 is refused so transfer fees,
    /// hooks, permanent delegates and the like cannot break the books.
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, pool.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_pool_handler(ctx: Context<InitializePool>, params: PoolParams) -> Result<()> {
    params.validate()?;
    let pool = &mut ctx.accounts.pool;
    pool.authority = Some(ctx.accounts.payer.key());
    pool.pending_authority = None;
    pool.mint = ctx.accounts.mint.key();
    pool.vault = ctx.accounts.vault.key();
    // The only instant settings change; later ones go through the timelock.
    params.apply_to(pool);
    pool.pending_params = None;
    pool.params_effective_at = 0;
    pool.wind_down_at = None;
    pool.successor = None;
    pool.active_loans = 0;
    pool.total_swept = 0;
    pool.paused = false;
    pool.window_start = Clock::get()?.unix_timestamp;
    pool.window_disbursed = 0;
    pool.pending_claims = 0;
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.vault;
    emit!(PoolInitialized {
        pool: pool.key(),
        authority: ctx.accounts.payer.key(),
        mint: pool.mint,
    });
    Ok(())
}
