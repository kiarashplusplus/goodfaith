use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::{
    error::GoodFaithError, events::LoanRequested, gateway::verify_gateway_token, state::*,
    MEMBER_SEED, PERSON_SEED, POOL_SEED, REQUEST_SEED,
};

#[derive(Accounts)]
#[instruction(amount: u64, term_days: u16, cosigner: Pubkey)]
pub struct RequestLoan<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub borrower: Signer<'info>,
    #[account(
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        seeds = [PERSON_SEED, pool.key().as_ref(), borrower_person.person_hash.as_ref()],
        bump = borrower_person.bump,
        constraint = borrower_person.wallet == borrower.key() @ GoodFaithError::WalletNotBound,
    )]
    pub borrower_person: Box<Account<'info, Person>>,
    /// The named co-signer must be a current member of a different person.
    #[account(
        seeds = [MEMBER_SEED, pool.key().as_ref(), cosigner.as_ref()],
        bump = cosigner_member.bump,
        constraint = !cosigner_member.retired @ GoodFaithError::WalletRetired,
        constraint = cosigner_member.person != borrower_person.key() @ GoodFaithError::SelfCosign,
    )]
    pub cosigner_member: Box<Account<'info, Member>>,
    /// CHECK: parsed and validated in `verify_gateway_token`.
    pub borrower_gateway_token: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + LoanRequest::INIT_SPACE,
        seeds = [REQUEST_SEED, pool.key().as_ref(), borrower.key().as_ref()],
        bump,
    )]
    pub request: Box<Account<'info, LoanRequest>>,
    pub system_program: Program<'info, System>,
}

pub fn request_loan_handler(
    ctx: Context<RequestLoan>,
    amount: u64,
    term_days: u16,
    cosigner: Pubkey,
) -> Result<()> {
    let a = ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    require!(!a.pool.winding_down(now), GoodFaithError::WindingDown);
    require!(amount > 0, GoodFaithError::AmountZero);
    require!(amount <= a.pool.max_loan, GoodFaithError::OverLoanCap);
    require!(
        term_days > 0 && term_days <= a.pool.max_term_days,
        GoodFaithError::TermTooLong
    );
    require_keys_neq!(cosigner, a.borrower.key(), GoodFaithError::SelfCosign);
    require!(!a.borrower_person.ineligible, GoodFaithError::Ineligible);
    require!(
        a.borrower_person.active_loan.is_none(),
        GoodFaithError::BorrowerHasLoan
    );
    verify_gateway_token(
        &a.borrower_gateway_token,
        &a.borrower.key(),
        &a.pool.gatekeeper_network,
        now,
    )?;

    a.request.set_inner(LoanRequest {
        borrower: a.borrower.key(),
        cosigner,
        amount,
        term_days,
        created_at: now,
        rent_payer: a.payer.key(),
        bump: ctx.bumps.request,
    });
    emit!(LoanRequested {
        pool: a.pool.key(),
        borrower: a.borrower.key(),
        cosigner,
        amount,
        term_days,
    });
    Ok(())
}
