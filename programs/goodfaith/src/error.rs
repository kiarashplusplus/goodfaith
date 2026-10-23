use anchor_lang::prelude::*;

#[error_code]
pub enum GoodFaithError {
    #[msg("Amount must be greater than zero")]
    AmountZero,
    #[msg("Amount is above the per-loan cap")]
    OverLoanCap,
    #[msg("Term is zero or longer than the maximum")]
    TermTooLong,
    #[msg("Borrower and co-signer must be different wallets")]
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
    #[msg("Loan cannot be marked as defaulted yet")]
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
}
