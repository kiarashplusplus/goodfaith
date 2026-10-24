use anchor_lang::prelude::*;

use crate::{
    error::GoodFaithError,
    events::{
        AuthorityChanged, AuthorityProposalCancelled, AuthorityProposed, IssuerSuspended,
        LendingPaused, LendingResumed, ParamsCancelled, ParamsScheduled, PoolFrozen, PoolUpdated,
    },
    state::*,
    MIN_TIMELOCK_SECONDS,
};

#[derive(Accounts)]
pub struct UpdatePool<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = pool.authority == Some(authority.key()) @ GoodFaithError::Unauthorized,
    )]
    pub pool: Account<'info, Pool>,
}

/// The key named by `propose_authority` takes over the pool.
#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub new_authority: Signer<'info>,
    #[account(
        mut,
        constraint = pool.pending_authority == Some(new_authority.key()) @ GoodFaithError::Unauthorized,
    )]
    pub pool: Account<'info, Pool>,
}

/// Anyone may apply settings once their timelock has elapsed.
#[derive(Accounts)]
pub struct ApplyParams<'info> {
    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

/// The pause authority or the authority stops new lending at once.
#[derive(Accounts)]
pub struct PauseLending<'info> {
    #[account(
        constraint = signer.key() == pool.pause_authority || pool.authority == Some(signer.key())
            @ GoodFaithError::Unauthorized,
    )]
    pub signer: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

/// Emergency brake on new loans and guarantees. Repayments, defaults, claims and donations continue.
pub fn pause_lending_handler(ctx: Context<PauseLending>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.paused = true;
    emit!(LendingPaused {
        pool: pool.key(),
        by: ctx.accounts.signer.key(),
    });
    Ok(())
}

/// Only the authority lifts a pause (the pause authority can stop lending, not restart it).
pub fn resume_lending_handler(ctx: Context<UpdatePool>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.paused = false;
    emit!(LendingResumed { pool: pool.key() });
    Ok(())
}

/// Step one of a settings change: announce it. It takes effect only after `pool.timelock_seconds`,
/// measured with the timelock in force now (so lowering the timelock itself waits the old delay).
pub fn schedule_params_handler(ctx: Context<UpdatePool>, params: PoolParams) -> Result<()> {
    params.validate()?;
    let pool = &mut ctx.accounts.pool;
    // A pool that runs with at least the minimum notice period can never schedule its way below it.
    require!(
        params.timelock_seconds >= MIN_TIMELOCK_SECONDS.min(pool.timelock_seconds),
        GoodFaithError::TimelockBelowMinimum
    );
    let effective_at = Clock::get()?
        .unix_timestamp
        .checked_add(pool.timelock_seconds)
        .ok_or(GoodFaithError::MathOverflow)?;
    pool.pending_params = Some(params);
    pool.params_effective_at = effective_at;
    emit!(ParamsScheduled {
        pool: pool.key(),
        params,
        effective_at,
    });
    Ok(())
}

/// The authority withdraws a scheduled change before (or after) its time, as long as nobody applied it.
pub fn cancel_params_handler(ctx: Context<UpdatePool>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(
        pool.pending_params.is_some(),
        GoodFaithError::NothingPending
    );
    pool.pending_params = None;
    pool.params_effective_at = 0;
    emit!(ParamsCancelled { pool: pool.key() });
    Ok(())
}

/// Step two: once the delay has passed, anyone (typically the operator's cranker) applies the change.
pub fn apply_params_handler(ctx: Context<ApplyParams>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let params = pool.pending_params.ok_or(GoodFaithError::NothingPending)?;
    require!(
        Clock::get()?.unix_timestamp >= pool.params_effective_at,
        GoodFaithError::TimelockNotElapsed
    );
    params.validate()?;
    params.apply_to(pool);
    pool.pending_params = None;
    pool.params_effective_at = 0;
    emit!(PoolUpdated {
        pool: pool.key(),
        params,
    });
    Ok(())
}

/// Irreversible: clears the authority, any pending handover and any scheduled settings change.
/// An announced wind-down stays, so a frozen fund can still be retired.
pub fn freeze_handler(ctx: Context<UpdatePool>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.authority = None;
    pool.pending_authority = None;
    pool.pending_params = None;
    pool.params_effective_at = 0;
    emit!(PoolFrozen { pool: pool.key() });
    Ok(())
}

/// Instant brake on the identity issuer: no registrations or wallet replacements until a new issuer
/// is set through the timelock. Existing members are unaffected.
pub fn suspend_issuer_handler(ctx: Context<UpdatePool>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.issuer = Pubkey::default();
    emit!(IssuerSuspended { pool: pool.key() });
    Ok(())
}

/// Step one of the handover: name the next authority. Nothing changes until it accepts.
pub fn propose_authority_handler(ctx: Context<UpdatePool>, new_authority: Pubkey) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(
        new_authority != Pubkey::default() && Some(new_authority) != pool.authority,
        GoodFaithError::InvalidParams
    );
    pool.pending_authority = Some(new_authority);
    emit!(AuthorityProposed {
        pool: pool.key(),
        current: ctx.accounts.authority.key(),
        proposed: new_authority,
    });
    Ok(())
}

/// The current authority withdraws a pending handover.
pub fn cancel_authority_proposal_handler(ctx: Context<UpdatePool>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let cancelled = pool
        .pending_authority
        .take()
        .ok_or(GoodFaithError::InvalidParams)?;
    emit!(AuthorityProposalCancelled {
        pool: pool.key(),
        cancelled,
    });
    Ok(())
}

/// Step two of the handover: the proposed key signs and becomes the authority.
pub fn accept_authority_handler(ctx: Context<AcceptAuthority>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let new = ctx.accounts.new_authority.key();
    let old = pool.authority.unwrap_or_default();
    pool.authority = Some(new);
    pool.pending_authority = None;
    emit!(AuthorityChanged {
        pool: pool.key(),
        old,
        new,
    });
    Ok(())
}
