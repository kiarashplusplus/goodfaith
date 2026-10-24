use anchor_lang::prelude::*;

#[constant]
pub const POOL_SEED: &[u8] = b"pool";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const MEMBER_SEED: &[u8] = b"member";
#[constant]
pub const LOAN_SEED: &[u8] = b"loan";
#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";

pub const SECONDS_PER_DAY: i64 = 86_400;
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Sanity bounds on pool settings (the due-date math is checked separately).
#[constant]
pub const MAX_TERM_DAYS: u16 = 3650;
#[constant]
pub const MAX_GRACE_DAYS: u16 = 365;

#[constant]
pub const REQUEST_SEED: &[u8] = b"request";
#[constant]
pub const PERSON_SEED: &[u8] = b"person";

/// Longest delay a pool may put on its own settings changes and wind-down (90 days).
#[constant]
pub const MAX_TIMELOCK_SECONDS: i64 = 90 * 86_400;

/// Once a pool runs with at least this notice period, no scheduled change may take it lower (2 days).
/// A pool initialised below it is a test pool.
#[constant]
pub const MIN_TIMELOCK_SECONDS: i64 = 2 * 86_400;
#[constant]
pub const MAX_RECOVERY_DELAY_SECONDS: i64 = 30 * 86_400;
#[constant]
pub const MAX_REQUEST_TTL_SECONDS: i64 = 90 * 86_400;
#[constant]
pub const MAX_COOLDOWN_SECONDS: i64 = 365 * 86_400;
#[constant]
pub const MAX_WINDOW_SECONDS: i64 = 30 * 86_400;
/// Longest seasoning period and cap-step interval a pool may set (365 days).
#[constant]
pub const MAX_SEASONING_SECONDS: i64 = 365 * 86_400;
/// Once a pool runs with at least this recovery delay, no scheduled change may take it lower (1 day).
/// A pool initialised below it is a test pool.
#[constant]
pub const MIN_RECOVERY_DELAY_SECONDS: i64 = 86_400;
/// After the issuer, the recovery key or the gatekeeper network changes, no wallet recovery can be
/// proposed for this long (7 days): a replaced key set is visible before it can move a membership.
#[constant]
pub const KEY_QUARANTINE_SECONDS: i64 = 7 * 86_400;
