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

    pub fn update_pool(ctx: Context<UpdatePool>, params: PoolParams) -> Result<()> {
        instructions::update_pool::update_handler(ctx, params)
    }

    pub fn freeze_pool(ctx: Context<UpdatePool>) -> Result<()> {
        instructions::update_pool::freeze_handler(ctx)
    }

    pub fn donate(ctx: Context<Donate>, amount: u64) -> Result<()> {
        instructions::donate::donate_handler(ctx, amount)
    }

    pub fn register_member(ctx: Context<RegisterMember>) -> Result<()> {
        instructions::register_member::register_member_handler(ctx)
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
