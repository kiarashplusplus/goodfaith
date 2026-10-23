pub mod constants;
pub mod error;
pub mod events;
pub mod gateway;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("BM71D4Kdnq3Mtc2cqDuMBLyYguFihDqsjk9btdTWtoRd");

#[program]
pub mod goodfaith {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, params: PoolParams) -> Result<()> {
        instructions::initialize_pool::initialize_pool_handler(ctx, params)
    }

    pub fn schedule_params(ctx: Context<UpdatePool>, params: PoolParams) -> Result<()> {
        instructions::update_pool::schedule_params_handler(ctx, params)
    }

    pub fn cancel_params(ctx: Context<UpdatePool>) -> Result<()> {
        instructions::update_pool::cancel_params_handler(ctx)
    }

    pub fn apply_params(ctx: Context<ApplyParams>) -> Result<()> {
        instructions::update_pool::apply_params_handler(ctx)
    }

    pub fn suspend_issuer(ctx: Context<UpdatePool>) -> Result<()> {
        instructions::update_pool::suspend_issuer_handler(ctx)
    }

    pub fn announce_wind_down(ctx: Context<AnnounceWindDown>) -> Result<()> {
        instructions::wind_down::announce_wind_down_handler(ctx)
    }

    pub fn cancel_wind_down(ctx: Context<CancelWindDown>) -> Result<()> {
        instructions::wind_down::cancel_wind_down_handler(ctx)
    }

    pub fn sweep_to_successor(ctx: Context<SweepToSuccessor>) -> Result<()> {
        instructions::wind_down::sweep_to_successor_handler(ctx)
    }

    pub fn freeze_pool(ctx: Context<UpdatePool>) -> Result<()> {
        instructions::update_pool::freeze_handler(ctx)
    }

    pub fn propose_authority(ctx: Context<UpdatePool>, new_authority: Pubkey) -> Result<()> {
        instructions::update_pool::propose_authority_handler(ctx, new_authority)
    }

    pub fn cancel_authority_proposal(ctx: Context<UpdatePool>) -> Result<()> {
        instructions::update_pool::cancel_authority_proposal_handler(ctx)
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        instructions::update_pool::accept_authority_handler(ctx)
    }

    pub fn donate(ctx: Context<Donate>, amount: u64) -> Result<()> {
        instructions::donate::donate_handler(ctx, amount)
    }

    pub fn register_member(ctx: Context<RegisterMember>, person_hash: [u8; 32]) -> Result<()> {
        instructions::register_member::register_member_handler(ctx, person_hash)
    }

    pub fn rebind_wallet(ctx: Context<RebindWallet>) -> Result<()> {
        instructions::rebind_wallet::rebind_wallet_handler(ctx)
    }

    pub fn request_loan(
        ctx: Context<RequestLoan>,
        amount: u64,
        term_days: u16,
        cosigner: Pubkey,
    ) -> Result<()> {
        instructions::request_loan::request_loan_handler(ctx, amount, term_days, cosigner)
    }

    pub fn cosign_loan(
        ctx: Context<CosignLoan>,
        expected_amount: u64,
        expected_term_days: u16,
        max_escrow: u64,
    ) -> Result<()> {
        instructions::cosign_loan::cosign_loan_handler(
            ctx,
            expected_amount,
            expected_term_days,
            max_escrow,
        )
    }

    pub fn cancel_request(ctx: Context<CancelRequest>) -> Result<()> {
        instructions::cancel_request::cancel_request_handler(ctx)
    }

    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        instructions::repay::repay_handler(ctx, amount)
    }

    pub fn mark_default(ctx: Context<MarkDefault>) -> Result<()> {
        instructions::mark_default::mark_default_handler(ctx)
    }
}
