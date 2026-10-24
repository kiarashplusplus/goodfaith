use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    error::GoodFaithError, events::LoanOpened, gateway::verify_gateway_token, state::*,
    BPS_DENOMINATOR, ESCROW_SEED, LOAN_SEED, PERSON_SEED, POOL_SEED, REQUEST_SEED, SECONDS_PER_DAY,
};

#[derive(Accounts)]
pub struct CosignLoan<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = cosigner.key() == request.cosigner @ GoodFaithError::Unauthorized)]
    pub cosigner: Signer<'info>,
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
        close = request_rent_payer,
        seeds = [REQUEST_SEED, pool.key().as_ref(), request.borrower.as_ref()],
        bump = request.bump,
    )]
    pub request: Box<Account<'info, LoanRequest>>,
    /// CHECK: receives the request account rent; must match `request.rent_payer`.
    #[account(mut, address = request.rent_payer)]
    pub request_rent_payer: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [PERSON_SEED, pool.key().as_ref(), borrower_person.person_id.as_ref()],
        bump = borrower_person.bump,
        constraint = borrower_person.wallet == request.borrower @ GoodFaithError::WalletNotBound,
    )]
    pub borrower_person: Box<Account<'info, Person>>,
    #[account(
        mut,
        seeds = [PERSON_SEED, pool.key().as_ref(), cosigner_person.person_id.as_ref()],
        bump = cosigner_person.bump,
        constraint = cosigner_person.wallet == cosigner.key() @ GoodFaithError::WalletNotBound,
    )]
    pub cosigner_person: Box<Account<'info, Person>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = request.borrower,
    )]
    pub borrower_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = cosigner,
    )]
    pub cosigner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Loan::INIT_SPACE,
        seeds = [LOAN_SEED, pool.key().as_ref(), pool.loan_count.to_le_bytes().as_ref()],
        bump,
    )]
    pub loan: Box<Account<'info, Loan>>,
    #[account(
        init,
        payer = payer,
        seeds = [ESCROW_SEED, loan.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: parsed and validated in `verify_gateway_token`.
    pub borrower_gateway_token: UncheckedAccount<'info>,
    /// CHECK: parsed and validated in `verify_gateway_token`.
    pub cosigner_gateway_token: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    /// The co-signer's own open loan, when they have one: its co-signer must not be this borrower.
    pub cosigner_active_loan: Option<Box<Account<'info, Loan>>>,
}

pub fn cosign_loan_handler(
    mut ctx: Context<CosignLoan>,
    expected_amount: u64,
    expected_term_days: u16,
    max_escrow: u64,
    expected_grace_days: u16,
    expected_cosigner_ban_seconds: i64,
) -> Result<()> {
    let a = &mut ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    let borrower = a.request.borrower;
    let amount = a.request.amount;
    let term_days = a.request.term_days;

    require!(!a.pool.paused, GoodFaithError::Paused);
    require!(!a.pool.winding_down(now), GoodFaithError::WindingDown);
    require!(now <= a.request.expires_at, GoodFaithError::RequestExpired);
    // The co-signer only commits to what they saw; the request may have been
    // replaced (cancel + new request) since.
    require!(
        amount == expected_amount && term_days == expected_term_days,
        GoodFaithError::RequestMismatch
    );
    // Nor to terms the pool changed under them: the grace period and their own ban are fixed on the
    // loan from what they saw.
    require!(
        a.pool.grace_days == expected_grace_days
            && a.pool.cosigner_ban_seconds == expected_cosigner_ban_seconds,
        GoodFaithError::RequestMismatch
    );
    require!(amount > 0, GoodFaithError::AmountZero);
    require!(amount <= a.pool.max_loan, GoodFaithError::OverLoanCap);
    require!(
        amount <= a.borrower_person.loan_cap(&a.pool, now),
        GoodFaithError::OverPersonalCap
    );
    require!(
        term_days > 0 && term_days <= a.pool.max_term_days,
        GoodFaithError::TermTooLong
    );
    require_keys_neq!(
        a.borrower_person.key(),
        a.cosigner_person.key(),
        GoodFaithError::SelfCosign
    );
    require!(
        a.borrower_person.eligible(now) && a.cosigner_person.eligible(now),
        GoodFaithError::Ineligible
    );
    // Exposure: open principal borrowed plus guaranteed, per person.
    let borrower_exposure = amount
        .checked_add(a.borrower_person.active_guarantee_amount)
        .ok_or(GoodFaithError::MathOverflow)?;
    require!(
        borrower_exposure <= a.pool.max_exposure_per_person,
        GoodFaithError::OverExposure
    );
    let cosigner_borrowed = match (&a.cosigner_person.active_loan, &a.cosigner_active_loan) {
        (None, _) => 0,
        (Some(key), Some(loan)) => {
            require_keys_eq!(loan.key(), *key, GoodFaithError::MissingCosignerLoan);
            // No pair may guarantee each other at the same time.
            require_keys_neq!(
                loan.cosigner_person,
                a.borrower_person.key(),
                GoodFaithError::ReciprocalGuarantee
            );
            loan.principal
                .checked_sub(loan.repaid)
                .ok_or(GoodFaithError::MathOverflow)?
        }
        (Some(_), None) => return err!(GoodFaithError::MissingCosignerLoan),
    };
    let cosigner_exposure = cosigner_borrowed
        .checked_add(a.cosigner_person.active_guarantee_amount)
        .and_then(|v| v.checked_add(amount))
        .ok_or(GoodFaithError::MathOverflow)?;
    require!(
        cosigner_exposure <= a.pool.max_exposure_per_person,
        GoodFaithError::OverExposure
    );
    // The fund's own limits: on open credit, and on how fast money goes out.
    let outstanding = a
        .pool
        .outstanding_principal
        .checked_add(amount)
        .ok_or(GoodFaithError::MathOverflow)?;
    require!(
        a.pool.max_outstanding_principal == 0 || outstanding <= a.pool.max_outstanding_principal,
        GoodFaithError::OverOutstandingCeiling
    );
    a.pool.outstanding_principal = outstanding;
    if a.pool.disbursement_cap_per_window > 0 {
        let window_end = a
            .pool
            .window_start
            .checked_add(a.pool.disbursement_window_seconds)
            .ok_or(GoodFaithError::MathOverflow)?;
        if now >= window_end {
            a.pool.window_start = now;
            a.pool.window_disbursed = 0;
        }
        let disbursed = a
            .pool
            .window_disbursed
            .checked_add(amount)
            .ok_or(GoodFaithError::MathOverflow)?;
        require!(
            disbursed <= a.pool.disbursement_cap_per_window,
            GoodFaithError::OverDisbursementCap
        );
        a.pool.window_disbursed = disbursed;
    }
    verify_gateway_token(
        &a.borrower_gateway_token,
        &borrower,
        &a.pool.gatekeeper_network,
        now,
    )?;
    verify_gateway_token(
        &a.cosigner_gateway_token,
        &a.cosigner.key(),
        &a.pool.gatekeeper_network,
        now,
    )?;
    require!(
        a.borrower_person.active_loan.is_none(),
        GoodFaithError::BorrowerHasLoan
    );
    require!(
        a.cosigner_person.active_guarantees < a.pool.max_guarantees_per_member,
        GoodFaithError::CosignerLimit
    );
    // Reimbursements owed to co-signers sit in the vault and are not the fund's to lend.
    require!(
        a.vault.amount.saturating_sub(a.pool.vault_claims) >= amount,
        GoodFaithError::InsufficientFund
    );

    let escrowed = u64::try_from(
        u128::from(amount)
            .checked_mul(u128::from(a.pool.cosigner_escrow_bps))
            .and_then(|v| v.checked_add(u128::from(BPS_DENOMINATOR) - 1))
            .ok_or(GoodFaithError::MathOverflow)?
            / u128::from(BPS_DENOMINATOR),
    )
    .map_err(|_| GoodFaithError::MathOverflow)?;

    require!(escrowed <= max_escrow, GoodFaithError::EscrowTooHigh);

    let due_at = i64::from(term_days)
        .checked_mul(SECONDS_PER_DAY)
        .and_then(|d| now.checked_add(d))
        .ok_or(GoodFaithError::MathOverflow)?;

    let loan_id = a.pool.loan_count;
    a.pool.loan_count = loan_id.checked_add(1).ok_or(GoodFaithError::MathOverflow)?;
    a.pool.active_loans = a
        .pool
        .active_loans
        .checked_add(1)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.pool.total_lent = a
        .pool
        .total_lent
        .checked_add(amount)
        .ok_or(GoodFaithError::MathOverflow)?;

    a.loan.set_inner(Loan {
        id: loan_id,
        borrower,
        cosigner: a.cosigner.key(),
        rent_payer: a.payer.key(),
        principal: amount,
        repaid: 0,
        escrowed,
        opened_at: now,
        due_at,
        grace_days: a.pool.grace_days,
        status: LoanStatus::Active,
        bump: ctx.bumps.loan,
        escrow_bump: ctx.bumps.escrow,
        borrower_person: a.borrower_person.key(),
        cosigner_person: a.cosigner_person.key(),
        closed_at: 0,
        refund_pending: 0,
        shortfall: 0,
        recovered: 0,
        recovery_pending: 0,
        restituted: 0,
        reimbursement_pending: 0,
        borrower_bar_until: 0,
        cosigner_bar_until: 0,
        default_ban_seconds: a.pool.default_ban_seconds,
        late_ban_seconds: a.pool.late_ban_seconds,
        cosigner_ban_seconds: a.pool.cosigner_ban_seconds,
        seasoning_seconds: a.pool.seasoning_seconds,
        cap_step_interval_seconds: a.pool.cap_step_interval_seconds,
        forgiven_at: 0,
    });
    a.borrower_person.active_loan = Some(a.loan.key());
    a.cosigner_person.active_guarantees = a
        .cosigner_person
        .active_guarantees
        .checked_add(1)
        .ok_or(GoodFaithError::MathOverflow)?;
    a.cosigner_person.active_guarantee_amount = a
        .cosigner_person
        .active_guarantee_amount
        .checked_add(amount)
        .ok_or(GoodFaithError::MathOverflow)?;

    let decimals = a.mint.decimals;
    if escrowed > 0 {
        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program.key(),
                TransferChecked {
                    from: a.cosigner_token.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.escrow.to_account_info(),
                    authority: a.cosigner.to_account_info(),
                },
            ),
            escrowed,
            decimals,
        )?;
    }

    let mint_key = a.mint.key();
    let seeds: &[&[u8]] = &[POOL_SEED, mint_key.as_ref(), &[a.pool.bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.vault.to_account_info(),
                mint: a.mint.to_account_info(),
                to: a.borrower_token.to_account_info(),
                authority: a.pool.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        decimals,
    )?;

    emit!(LoanOpened {
        pool: a.pool.key(),
        loan: a.loan.key(),
        loan_id,
        borrower,
        cosigner: a.cosigner.key(),
        borrower_person: a.borrower_person.key(),
        cosigner_person: a.cosigner_person.key(),
        principal: amount,
        escrowed,
        due_at,
    });
    Ok(())
}
