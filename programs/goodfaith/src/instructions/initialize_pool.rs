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
    pool.mint = ctx.accounts.mint.key();
    pool.vault = ctx.accounts.vault.key();
    pool.gatekeeper_network = params.gatekeeper_network;
    pool.max_loan = params.max_loan;
    pool.max_term_days = params.max_term_days;
    pool.grace_days = params.grace_days;
    pool.max_guarantees_per_member = params.max_guarantees_per_member;
    pool.cosigner_escrow_bps = params.cosigner_escrow_bps;
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.vault;
    emit!(PoolInitialized {
        pool: pool.key(),
        authority: ctx.accounts.payer.key(),
        mint: pool.mint,
    });
    Ok(())
}
