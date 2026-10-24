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

    pub fn register_member(ctx: Context<RegisterMember>, person_id: [u8; 32]) -> Result<()> {
        instructions::register_member::register_member_handler(ctx, person_id)
    }

    pub fn propose_rebind(ctx: Context<ProposeRebind>) -> Result<()> {
        instructions::recovery::propose_rebind_handler(ctx)
    }

    pub fn veto_rebind(ctx: Context<VetoRebind>) -> Result<()> {
        instructions::recovery::veto_rebind_handler(ctx)
    }

    pub fn finalize_rebind(ctx: Context<FinalizeRebind>) -> Result<()> {
        instructions::recovery::finalize_rebind_handler(ctx)
    }

    pub fn close_expired_request(ctx: Context<CloseExpiredRequest>) -> Result<()> {
        instructions::cancel_request::close_expired_request_handler(ctx)
    }

    pub fn claim_escrow(ctx: Context<ClaimEscrow>) -> Result<()> {
        instructions::claim::claim_escrow_handler(ctx)
    }

    pub fn pause_lending(ctx: Context<PauseLending>) -> Result<()> {
        instructions::update_pool::pause_lending_handler(ctx)
    }

    pub fn resume_lending(ctx: Context<UpdatePool>) -> Result<()> {
        instructions::update_pool::resume_lending_handler(ctx)
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
        expected_grace_days: u16,
        expected_cosigner_ban_seconds: i64,
    ) -> Result<()> {
        instructions::cosign_loan::cosign_loan_handler(
            ctx,
            expected_amount,
            expected_term_days,
            max_escrow,
            expected_grace_days,
            expected_cosigner_ban_seconds,
        )
    }

    pub fn cancel_request(ctx: Context<CancelRequest>) -> Result<()> {
        instructions::cancel_request::cancel_request_handler(ctx)
    }

    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        instructions::repay::repay_handler(ctx, amount)
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::settle::settle_handler(ctx)
    }

    pub fn collect_recovery(ctx: Context<CollectRecovery>) -> Result<()> {
        instructions::claim::collect_recovery_handler(ctx)
    }

    pub fn restitute(ctx: Context<Restitute>, amount: u64) -> Result<()> {
        instructions::restitute::restitute_handler(ctx, amount)
    }

    pub fn lift_bar(ctx: Context<LiftBar>, reason: [u8; 32]) -> Result<()> {
        instructions::update_pool::lift_bar_handler(ctx, reason)
    }

    pub fn forgive(ctx: Context<Forgive>) -> Result<()> {
        instructions::forgive::forgive_handler(ctx)
    }
}
