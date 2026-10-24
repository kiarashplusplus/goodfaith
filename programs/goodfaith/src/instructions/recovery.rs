use anchor_lang::prelude::*;

use crate::{
    error::GoodFaithError,
    events::{RebindProposed, RebindVetoed, WalletRebound},
    gateway::verify_gateway_token,
    state::*,
    KEY_QUARANTINE_SECONDS, MEMBER_SEED, PERSON_SEED,
};

/// Step one of a wallet recovery (lost keys): the issuer and the recovery authority both vouch for
/// the new wallet, which holds a valid pass of its own. The new wallet need not sign, so the recovery
/// key can live with an operator rather than in the web service. Nothing moves until the delay passes
/// without a veto.
#[derive(Accounts)]
pub struct ProposeRebind<'info> {
    /// CHECK: the wallet the person moves to; its gateway token is verified in the handler.
    pub new_wallet: UncheckedAccount<'info>,
    #[account(constraint = issuer.key() == pool.issuer @ GoodFaithError::Unauthorized)]
    pub issuer: Signer<'info>,
    #[account(constraint = recovery_authority.key() == pool.recovery_authority @ GoodFaithError::Unauthorized)]
    pub recovery_authority: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [PERSON_SEED, pool.key().as_ref(), person.person_id.as_ref()],
        bump = person.bump,
        constraint = person.pending_wallet.is_none() @ GoodFaithError::RecoveryPending,
        constraint = person.wallet != new_wallet.key() @ GoodFaithError::InvalidParams,
    )]
    pub person: Account<'info, Person>,
    /// CHECK: parsed and validated in `verify_gateway_token` for `new_wallet`.
    pub gateway_token: UncheckedAccount<'info>,
}

/// The old wallet (the one being replaced) or the authority stops a pending recovery.
#[derive(Accounts)]
pub struct VetoRebind<'info> {
    #[account(
        constraint = signer.key() == person.wallet || pool.authority == Some(signer.key())
            @ GoodFaithError::Unauthorized,
    )]
    pub signer: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [PERSON_SEED, pool.key().as_ref(), person.person_id.as_ref()],
        bump = person.bump,
        constraint = person.pending_wallet.is_some() @ GoodFaithError::RecoveryNotPending,
    )]
    pub person: Account<'info, Person>,
}

/// Step two, by anyone, once the delay has passed: the old wallet's link is retired for good and the
/// new wallet takes over. Eligibility, open loans and guarantees stay with the person.
#[derive(Accounts)]
pub struct FinalizeRebind<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [PERSON_SEED, pool.key().as_ref(), person.person_id.as_ref()],
        bump = person.bump,
        constraint = person.pending_wallet.is_some() @ GoodFaithError::RecoveryNotPending,
    )]
    pub person: Account<'info, Person>,
    /// CHECK: must be the wallet named in the pending recovery.
    #[account(constraint = Some(new_wallet.key()) == person.pending_wallet @ GoodFaithError::RecoveryNotPending)]
    pub new_wallet: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [MEMBER_SEED, pool.key().as_ref(), person.wallet.as_ref()],
        bump = old_member.bump,
        constraint = !old_member.retired @ GoodFaithError::WalletRetired,
        constraint = old_member.person == person.key() @ GoodFaithError::WalletNotBound,
    )]
    pub old_member: Account<'info, Member>,
    #[account(
        init,
        payer = payer,
        space = 8 + Member::INIT_SPACE,
        seeds = [MEMBER_SEED, pool.key().as_ref(), new_wallet.key().as_ref()],
        bump,
    )]
    pub new_member: Account<'info, Member>,
    pub system_program: Program<'info, System>,
}

pub fn propose_rebind_handler(ctx: Context<ProposeRebind>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    // A freshly installed issuer, recovery key or gatekeeper network cannot move anyone yet.
    require!(
        now >= ctx
            .accounts
            .pool
            .keys_changed_at
            .saturating_add(KEY_QUARANTINE_SECONDS),
        GoodFaithError::KeysRecentlyChanged
    );
    verify_gateway_token(
        &ctx.accounts.gateway_token,
        &ctx.accounts.new_wallet.key(),
        &ctx.accounts.pool.gatekeeper_network,
        now,
    )?;
    let effective_at = now
        .checked_add(ctx.accounts.pool.recovery_delay_seconds)
        .ok_or(GoodFaithError::MathOverflow)?;
    let person = &mut ctx.accounts.person;
    person.pending_wallet = Some(ctx.accounts.new_wallet.key());
    person.pending_wallet_at = effective_at;
    emit!(RebindProposed {
        pool: ctx.accounts.pool.key(),
        person: person.key(),
        old_wallet: person.wallet,
        new_wallet: ctx.accounts.new_wallet.key(),
        effective_at,
    });
    Ok(())
}

pub fn veto_rebind_handler(ctx: Context<VetoRebind>) -> Result<()> {
    let person = &mut ctx.accounts.person;
    person.pending_wallet = None;
    person.pending_wallet_at = 0;
    emit!(RebindVetoed {
        pool: ctx.accounts.pool.key(),
        person: person.key(),
        by: ctx.accounts.signer.key(),
    });
    Ok(())
}

pub fn finalize_rebind_handler(ctx: Context<FinalizeRebind>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.person.pending_wallet_at,
        GoodFaithError::RecoveryDelayNotElapsed
    );
    let old_wallet = ctx.accounts.person.wallet;
    let new_wallet = ctx.accounts.new_wallet.key();
    ctx.accounts.old_member.retired = true;
    let person = &mut ctx.accounts.person;
    person.wallet = new_wallet;
    person.pending_wallet = None;
    person.pending_wallet_at = 0;
    person.restricted_until = now
        .checked_add(ctx.accounts.pool.cooldown_seconds)
        .ok_or(GoodFaithError::MathOverflow)?;
    let member = &mut ctx.accounts.new_member;
    member.wallet = new_wallet;
    member.person = person.key();
    member.retired = false;
    member.bump = ctx.bumps.new_member;
    emit!(WalletRebound {
        pool: ctx.accounts.pool.key(),
        person: person.key(),
        old_wallet,
        new_wallet,
    });
    Ok(())
}
