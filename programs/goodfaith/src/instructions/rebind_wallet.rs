use anchor_lang::prelude::*;

use crate::{
    error::GoodFaithError, events::WalletRebound, gateway::verify_gateway_token, state::*,
    MEMBER_SEED, PERSON_SEED,
};

/// Moves a person to a new wallet (lost keys). The old wallet does not sign; the issuer and the
/// new wallet do. The old wallet's link is retired for good; eligibility, open loans and
/// guarantees stay with the person.
#[derive(Accounts)]
pub struct RebindWallet<'info> {
    pub new_wallet: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = issuer.key() == pool.issuer @ GoodFaithError::Unauthorized)]
    pub issuer: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [PERSON_SEED, pool.key().as_ref(), person.person_hash.as_ref()],
        bump = person.bump,
    )]
    pub person: Account<'info, Person>,
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
    /// CHECK: parsed and validated in `verify_gateway_token` for `new_wallet`.
    pub gateway_token: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn rebind_wallet_handler(ctx: Context<RebindWallet>) -> Result<()> {
    verify_gateway_token(
        &ctx.accounts.gateway_token,
        &ctx.accounts.new_wallet.key(),
        &ctx.accounts.pool.gatekeeper_network,
        Clock::get()?.unix_timestamp,
    )?;
    let old_wallet = ctx.accounts.person.wallet;
    ctx.accounts.old_member.retired = true;
    let person = &mut ctx.accounts.person;
    person.wallet = ctx.accounts.new_wallet.key();
    let member = &mut ctx.accounts.new_member;
    member.wallet = ctx.accounts.new_wallet.key();
    member.person = person.key();
    member.retired = false;
    member.bump = ctx.bumps.new_member;
    emit!(WalletRebound {
        pool: ctx.accounts.pool.key(),
        person: person.key(),
        old_wallet,
        new_wallet: member.wallet,
    });
    Ok(())
}
