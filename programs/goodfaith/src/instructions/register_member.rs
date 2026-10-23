use anchor_lang::prelude::*;

use crate::{
    error::GoodFaithError, events::MemberRegistered, gateway::verify_gateway_token, state::*,
    MEMBER_SEED, PERSON_SEED,
};

/// Joins the fund: the issuer vouches that `person_hash` is one verified human and that
/// `wallet` belongs to them; the wallet proves control; the payer covers rent.
#[derive(Accounts)]
#[instruction(person_hash: [u8; 32])]
pub struct RegisterMember<'info> {
    pub wallet: Signer<'info>,
    /// Pays account rent (fee sponsor, may equal wallet).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = issuer.key() == pool.issuer @ GoodFaithError::Unauthorized)]
    pub issuer: Signer<'info>,
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = payer,
        space = 8 + Person::INIT_SPACE,
        seeds = [PERSON_SEED, pool.key().as_ref(), person_hash.as_ref()],
        bump,
    )]
    pub person: Account<'info, Person>,
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

pub fn register_member_handler(ctx: Context<RegisterMember>, person_hash: [u8; 32]) -> Result<()> {
    verify_gateway_token(
        &ctx.accounts.gateway_token,
        &ctx.accounts.wallet.key(),
        &ctx.accounts.pool.gatekeeper_network,
        Clock::get()?.unix_timestamp,
    )?;
    let person = &mut ctx.accounts.person;
    person.person_hash = person_hash;
    person.wallet = ctx.accounts.wallet.key();
    person.active_loan = None;
    person.active_guarantees = 0;
    person.ineligible = false;
    person.bump = ctx.bumps.person;
    let member = &mut ctx.accounts.member;
    member.wallet = ctx.accounts.wallet.key();
    member.person = person.key();
    member.retired = false;
    member.bump = ctx.bumps.member;
    emit!(MemberRegistered {
        pool: ctx.accounts.pool.key(),
        wallet: member.wallet,
        person: person.key(),
    });
    Ok(())
}
