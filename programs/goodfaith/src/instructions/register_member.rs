use anchor_lang::prelude::*;

use crate::{events::MemberRegistered, gateway::verify_gateway_token, state::*, MEMBER_SEED};

#[derive(Accounts)]
pub struct RegisterMember<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    /// Pays Member account rent (fee sponsor, may equal wallet).
    #[account(mut)]
    pub payer: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = payer,
        space = 8 + Member::INIT_SPACE,
        seeds = [MEMBER_SEED, pool.key().as_ref(), wallet.key().as_ref()],
        bump,
    )]
    pub member: Account<'info, Member>,
    /// CHECK: parsed and validated in `verify_gateway_token`.
    pub gateway_token: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn register_member_handler(ctx: Context<RegisterMember>) -> Result<()> {
    verify_gateway_token(
        &ctx.accounts.gateway_token,
        &ctx.accounts.wallet.key(),
        &ctx.accounts.pool.gatekeeper_network,
        Clock::get()?.unix_timestamp,
    )?;
    let member = &mut ctx.accounts.member;
    member.wallet = ctx.accounts.wallet.key();
    member.active_loan = None;
    member.active_guarantees = 0;
    member.ineligible = false;
    member.bump = ctx.bumps.member;
    emit!(MemberRegistered {
        pool: ctx.accounts.pool.key(),
        wallet: member.wallet,
    });
    Ok(())
}
