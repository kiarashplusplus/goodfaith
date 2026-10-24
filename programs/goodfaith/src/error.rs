use anchor_lang::prelude::*;

#[error_code]
pub enum GoodFaithError {
    #[msg("Amount must be greater than zero")]
    AmountZero,
    #[msg("Amount is above the per-loan cap")]
    OverLoanCap,
    #[msg("Term is zero or longer than the maximum")]
    TermTooLong,
    #[msg("Borrower and co-signer must be different people")]
    SelfCosign,
    #[msg("Borrower already has an active loan")]
    BorrowerHasLoan,
    #[msg("Co-signer is already at the guarantee limit")]
    CosignerLimit,
    #[msg("Member is not eligible")]
    Ineligible,
    #[msg("Missing or invalid gateway token")]
    InvalidGatewayToken,
    #[msg("The loan fund does not hold enough")]
    InsufficientFund,
    #[msg("Payment is more than the amount still owed")]
    OverRepay,
    #[msg("Loan is not active")]
    LoanNotActive,
    #[msg("Loan cannot be settled yet")]
    NotYetDefaultable,
    #[msg("Not authorized")]
    Unauthorized,
    #[msg("Escrow basis points must be at most 10000")]
    InvalidBps,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("The request no longer matches what was approved")]
    RequestMismatch,
    #[msg("Escrow is above the maximum the co-signer approved")]
    EscrowTooHigh,
    #[msg("Invalid pool parameters")]
    InvalidParams,
    #[msg("Wallet is not the current wallet of this person")]
    WalletNotBound,
    #[msg("This wallet was replaced and can no longer be used")]
    WalletRetired,
    #[msg("The fund is winding down; no new loans or donations")]
    WindingDown,
    #[msg("No wind-down is in effect")]
    NotWindingDown,
    #[msg("The change is not yet effective")]
    TimelockNotElapsed,
    #[msg("No change is scheduled")]
    NothingPending,
    #[msg("Loans are still active")]
    LoansOutstanding,
    #[msg("Successor must be a token account of the pool mint not controlled by the pool")]
    InvalidSuccessor,
    #[msg("New lending is paused")]
    Paused,
    #[msg("The request has expired")]
    RequestExpired,
    #[msg("The request has not expired yet")]
    RequestNotExpired,
    #[msg("Amount is above this person's current loan cap")]
    OverPersonalCap,
    #[msg("This would exceed the person's exposure limit")]
    OverExposure,
    #[msg("The fund's lending limit for this period is reached")]
    OverDisbursementCap,
    #[msg("Borrower and co-signer already guarantee each other")]
    ReciprocalGuarantee,
    #[msg("A wallet recovery is already pending")]
    RecoveryPending,
    #[msg("No wallet recovery is pending")]
    RecoveryNotPending,
    #[msg("The recovery delay has not elapsed")]
    RecoveryDelayNotElapsed,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("The notice period cannot be set below the minimum")]
    TimelockBelowMinimum,
    #[msg("The co-signer's open loan must be passed to check for a reciprocal guarantee")]
    MissingCosignerLoan,
    #[msg("The deadline has passed; settle the loan and pay back what is owed")]
    LoanPastDeadline,
    #[msg("Nothing is owed on this loan")]
    NothingOwed,
    #[msg("Nothing to collect")]
    NothingToCollect,
    #[msg("This would exceed the fund's outstanding-principal ceiling")]
    OverOutstandingCeiling,
    #[msg("Loan has not been settled as defaulted")]
    LoanNotSettled,
    #[msg("The person is not barred")]
    NotBarred,
    #[msg("The recovery delay cannot be set below the minimum")]
    RecoveryDelayBelowMinimum,
    #[msg("The identity keys changed recently; wallet recoveries wait out the quarantine")]
    KeysRecentlyChanged,
    #[msg("This would exceed the fund's lending budget")]
    LendingBudgetReached,
    #[msg("The co-signer has nothing left to waive on this loan")]
    NothingToWaive,
}
