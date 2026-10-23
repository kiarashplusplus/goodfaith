use anchor_lang::prelude::*;

use crate::{
    error::GoodFaithError,
    events::{PoolFrozen, PoolUpdated},
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

pub fn update_handler(ctx: Context<UpdatePool>, params: PoolParams) -> Result<()> {
    params.validate()?;
    let pool = &mut ctx.accounts.pool;
    pool.gatekeeper_network = params.gatekeeper_network;
    pool.max_loan = params.max_loan;
    pool.max_term_days = params.max_term_days;
    pool.grace_days = params.grace_days;
    pool.max_guarantees_per_member = params.max_guarantees_per_member;
    pool.cosigner_escrow_bps = params.cosigner_escrow_bps;
    emit!(PoolUpdated { pool: pool.key() });
    Ok(())
}

pub fn freeze_handler(ctx: Context<UpdatePool>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.authority = None;
    emit!(PoolFrozen { pool: pool.key() });
    Ok(())
}
