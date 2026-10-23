use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    error::GoodFaithError,
    events::{SweptToSuccessor, WindDownAnnounced, WindDownCancelled},
    state::*,
    POOL_SEED,
};

/// The authority announces the fund's retirement and names where the remaining balance goes.
#[derive(Accounts)]
pub struct AnnounceWindDown<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = pool.authority == Some(authority.key()) @ GoodFaithError::Unauthorized,
    )]
    pub pool: Account<'info, Pool>,
    /// Must hold the pool's mint and must not be controlled by the pool itself (the vault, an escrow).
    #[account(
        constraint = successor_vault.mint == pool.mint @ GoodFaithError::InvalidSuccessor,
        constraint = successor_vault.owner != pool.key() @ GoodFaithError::InvalidSuccessor,
    )]
    pub successor_vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct CancelWindDown<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = pool.authority == Some(authority.key()) @ GoodFaithError::Unauthorized,
    )]
    pub pool: Account<'info, Pool>,
}

/// Anyone may move the balance to the successor once the wind-down is in effect and no loan is open.
#[derive(Accounts)]
pub struct SweepToSuccessor<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        address = pool.vault,
        token::mint = mint,
        token::authority = pool,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = pool.successor == Some(successor_vault.key()) @ GoodFaithError::InvalidSuccessor,
    )]
    pub successor_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn announce_wind_down_handler(ctx: Context<AnnounceWindDown>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.wind_down_at.is_none(), GoodFaithError::InvalidParams);
    let effective_at = Clock::get()?
        .unix_timestamp
        .checked_add(pool.timelock_seconds)
        .ok_or(GoodFaithError::MathOverflow)?;
    let successor = ctx.accounts.successor_vault.key();
    pool.wind_down_at = Some(effective_at);
    pool.successor = Some(successor);
    emit!(WindDownAnnounced {
        pool: pool.key(),
        successor,
        effective_at,
    });
    Ok(())
}

/// Only before the wind-down takes effect; after that the decision is final.
pub fn cancel_wind_down_handler(ctx: Context<CancelWindDown>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let at = pool.wind_down_at.ok_or(GoodFaithError::NotWindingDown)?;
    require!(
        Clock::get()?.unix_timestamp < at,
        GoodFaithError::WindingDown
    );
    pool.wind_down_at = None;
    pool.successor = None;
    emit!(WindDownCancelled { pool: pool.key() });
    Ok(())
}

pub fn sweep_to_successor_handler(ctx: Context<SweepToSuccessor>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &ctx.accounts.pool;
    require!(pool.winding_down(now), GoodFaithError::NotWindingDown);
    require!(pool.active_loans == 0, GoodFaithError::LoansOutstanding);
    let amount = ctx.accounts.vault.amount;
    require!(amount > 0, GoodFaithError::AmountZero);

    let mint_key = ctx.accounts.mint.key();
    let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[pool.bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.successor_vault.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.total_swept = pool
        .total_swept
        .checked_add(amount)
        .ok_or(GoodFaithError::MathOverflow)?;
    emit!(SweptToSuccessor {
        pool: pool.key(),
        successor: ctx.accounts.successor_vault.key(),
        amount,
    });
    Ok(())
}
