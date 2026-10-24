use anchor_lang::prelude::*;

use crate::{
    error::GoodFaithError,
    events::{RequestCancelled, RequestExpiredClosed},
    state::*,
    REQUEST_SEED,
};

#[derive(Accounts)]
pub struct CancelRequest<'info> {
    #[account(
        constraint = canceller.key() == request.borrower || canceller.key() == request.cosigner
            @ GoodFaithError::Unauthorized,
    )]
    pub canceller: Signer<'info>,
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [REQUEST_SEED, pool.key().as_ref(), request.borrower.as_ref()],
        bump = request.bump,
    )]
    pub request: Box<Account<'info, LoanRequest>>,
    /// CHECK: receives the request account rent; must match `request.rent_payer`.
    #[account(mut, address = request.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
}

/// Anyone closes a request past its expiry; the rent goes back to whoever paid it (the sponsor, usually).
#[derive(Accounts)]
pub struct CloseExpiredRequest<'info> {
    pub closer: Signer<'info>,
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [REQUEST_SEED, pool.key().as_ref(), request.borrower.as_ref()],
        bump = request.bump,
    )]
    pub request: Box<Account<'info, LoanRequest>>,
    /// CHECK: receives the request account rent; must match `request.rent_payer`.
    #[account(mut, address = request.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn cancel_request_handler(ctx: Context<CancelRequest>) -> Result<()> {
    emit!(RequestCancelled {
        pool: ctx.accounts.pool.key(),
        borrower: ctx.accounts.request.borrower,
        cancelled_by: ctx.accounts.canceller.key(),
    });
    Ok(())
}

pub fn close_expired_request_handler(ctx: Context<CloseExpiredRequest>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now > ctx.accounts.request.expires_at,
        GoodFaithError::RequestNotExpired
    );
    emit!(RequestExpiredClosed {
        pool: ctx.accounts.pool.key(),
        borrower: ctx.accounts.request.borrower,
        closed_by: ctx.accounts.closer.key(),
    });
    Ok(())
}
