use anchor_lang::prelude::*;

use crate::{
    error::GoodFaithError,
    events::{
        AuthorityChanged, AuthorityProposalCancelled, AuthorityProposed, PoolFrozen, PoolUpdated,
    },
    state::*,
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

pub fn update_handler(ctx: Context<UpdatePool>, params: PoolParams) -> Result<()> {
    params.validate()?;
    let pool = &mut ctx.accounts.pool;
    pool.gatekeeper_network = params.gatekeeper_network;
    pool.max_loan = params.max_loan;
    pool.max_term_days = params.max_term_days;
    pool.grace_days = params.grace_days;
    pool.max_guarantees_per_member = params.max_guarantees_per_member;
    pool.cosigner_escrow_bps = params.cosigner_escrow_bps;
    emit!(PoolUpdated {
        pool: pool.key(),
        params,
    });
    Ok(())
}

/// Irreversible: clears the authority and any pending handover.
pub fn freeze_handler(ctx: Context<UpdatePool>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.authority = None;
    pool.pending_authority = None;
    emit!(PoolFrozen { pool: pool.key() });
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
