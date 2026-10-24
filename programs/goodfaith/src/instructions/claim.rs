use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    error::GoodFaithError,
    events::{EscrowClaimed, RecoveryCollected},
    state::*,
    ESCROW_SEED, LOAN_SEED, POOL_SEED,
};

/// Anyone moves what a closed loan owes its co-signer to the co-signer's current wallet: the escrow
/// refund from the escrow account (when it is passed) and any reimbursement from the vault.
#[derive(Accounts)]
pub struct ClaimEscrow<'info> {
    pub claimer: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        address = pool.vault,
        token::mint = mint,
        token::authority = pool,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [LOAN_SEED, pool.key().as_ref(), loan.id.to_le_bytes().as_ref()],
        bump = loan.bump,
        constraint = loan.status != LoanStatus::Active @ GoodFaithError::LoanNotActive,
        constraint = loan.refund_pending > 0 || loan.reimbursement_pending > 0 @ GoodFaithError::NothingToClaim,
    )]
    pub loan: Box<Account<'info, Loan>>,
    /// The loan's escrow account; left out once it is closed (or while it is frozen) to claim the
    /// vault part alone.
    #[account(
        mut,
        seeds = [ESCROW_SEED, loan.key().as_ref()],
        bump = loan.escrow_bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub escrow: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(address = loan.cosigner_person)]
    pub cosigner_person: Box<Account<'info, Person>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = cosigner_person.wallet,
    )]
    pub cosigner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives the escrow account rent; must match `loan.rent_payer`.
    #[account(mut, address = loan.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn claim_escrow_handler(mut ctx: Context<ClaimEscrow>) -> Result<()> {
    let a = &mut ctx.accounts;
    let mint_key = a.mint.key();
    let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[a.pool.bump]];
    let decimals = a.mint.decimals;

    let mut from_escrow = 0u64;
    if let Some(escrow) = a.escrow.as_ref() {
        from_escrow = a.loan.refund_pending;
        if from_escrow > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    a.token_program.key(),
                    TransferChecked {
                        from: escrow.to_account_info(),
                        mint: a.mint.to_account_info(),
                        to: a.cosigner_token.to_account_info(),
                        authority: a.pool.to_account_info(),
                    },
                    &[seeds],
                ),
                from_escrow,
                decimals,
            )?;
            a.pool.pending_claims = a
                .pool
                .pending_claims
                .checked_sub(from_escrow)
                .ok_or(GoodFaithError::MathOverflow)?;
            a.loan.refund_pending = 0;
        }
        if a.loan.recovery_pending == 0 {
            token_interface::close_account(CpiContext::new_with_signer(
                a.token_program.key(),
                CloseAccount {
                    account: escrow.to_account_info(),
                    destination: a.rent_payer.to_account_info(),
                    authority: a.pool.to_account_info(),
                },
                &[seeds],
            ))?;
        }
    }

    let from_vault = a.loan.reimbursement_pending;
    if from_vault > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.vault.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.cosigner_token.to_account_info(),
                    authority: a.pool.to_account_info(),
                },
                &[seeds],
            ),
            from_vault,
            decimals,
        )?;
        a.pool.vault_claims = a
            .pool
            .vault_claims
            .checked_sub(from_vault)
            .ok_or(GoodFaithError::MathOverflow)?;
        a.pool.total_reimbursed = a
            .pool
            .total_reimbursed
            .checked_add(from_vault)
            .ok_or(GoodFaithError::MathOverflow)?;
        a.loan.reimbursement_pending = 0;
    }

    let amount = from_escrow
        .checked_add(from_vault)
        .ok_or(GoodFaithError::MathOverflow)?;
    require!(amount > 0, GoodFaithError::NothingToClaim);
    emit!(EscrowClaimed {
        pool: a.pool.key(),
        loan: a.loan.key(),
        loan_id: a.loan.id,
        to_wallet: a.cosigner_person.wallet,
        amount,
        from_escrow,
        from_vault,
    });
    Ok(())
}

/// Anyone moves a settled loan's recovery from its escrow into the vault.
#[derive(Accounts)]
pub struct CollectRecovery<'info> {
    pub collector: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        address = pool.vault,
        token::mint = mint,
        token::authority = pool,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [LOAN_SEED, pool.key().as_ref(), loan.id.to_le_bytes().as_ref()],
        bump = loan.bump,
        constraint = loan.recovery_pending > 0 @ GoodFaithError::NothingToCollect,
    )]
    pub loan: Box<Account<'info, Loan>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, loan.key().as_ref()],
        bump = loan.escrow_bump,
        token::mint = mint,
        token::authority = pool,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives the escrow account rent once nothing is left in it; must match `loan.rent_payer`.
    #[account(mut, address = loan.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn collect_recovery_handler(mut ctx: Context<CollectRecovery>) -> Result<()> {
    let a = &mut ctx.accounts;
    let amount = a.loan.recovery_pending;
    let mint_key = a.mint.key();
    let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[a.pool.bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.escrow.to_account_info(),
                mint: a.mint.to_account_info(),
                to: a.vault.to_account_info(),
                authority: a.pool.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        a.mint.decimals,
    )?;
    if a.loan.refund_pending == 0 {
        token_interface::close_account(CpiContext::new_with_signer(
            a.token_program.key(),
            CloseAccount {
                account: a.escrow.to_account_info(),
                destination: a.rent_payer.to_account_info(),
                authority: a.pool.to_account_info(),
            },
            &[seeds],
        ))?;
    }
    a.pool.recoveries_pending = a
        .pool
        .recoveries_pending
        .checked_sub(amount)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.total_recovered = a
        .pool
        .total_recovered
        .checked_add(amount)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.loan.recovery_pending = 0;
    emit!(RecoveryCollected {
        pool: a.pool.key(),
        loan: a.loan.key(),
        loan_id: a.loan.id,
        amount,
        by: a.collector.key(),
    });
    Ok(())
}
