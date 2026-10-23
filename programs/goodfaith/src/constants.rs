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

#[constant]
pub const REQUEST_SEED: &[u8] = b"request";
