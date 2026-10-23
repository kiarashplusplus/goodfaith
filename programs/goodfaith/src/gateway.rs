//! Reads Civic gateway tokens without the `solana-gateway` crate.
//!
//! Layout follows `GatewayToken` in identity-com/on-chain-identity-gateway
//! (`solana/program/src/state.rs`), Borsh encoded with no discriminator:
//! version u8, parent_gateway_token Option<Pubkey>, owner_wallet Pubkey,
//! owner_identity Option<Pubkey>, gatekeeper_network Pubkey,
//! issuing_gatekeeper Pubkey, state u8 (0 Active, 1 Frozen, 2 Revoked),
//! expire_time Option<i64>.

use anchor_lang::prelude::*;

use crate::error::GoodFaithError;

pub const GATEWAY_PROGRAM_ID: Pubkey = pubkey!("gatem74V238djXdzWnJf94Wo1DcnuGkfijbf3AuBhfs");

const STATE_ACTIVE: u8 = 0;

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or(GoodFaithError::InvalidGatewayToken)?;
        let out = self
            .data
            .get(self.pos..end)
            .ok_or(GoodFaithError::InvalidGatewayToken)?;
        self.pos = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn pubkey(&mut self) -> Result<Pubkey> {
        let bytes: [u8; 32] = self
            .take(32)?
            .try_into()
            .map_err(|_| GoodFaithError::InvalidGatewayToken)?;
        Ok(Pubkey::new_from_array(bytes))
    }

    fn option_pubkey(&mut self) -> Result<()> {
        match self.u8()? {
            0 => Ok(()),
            1 => self.pubkey().map(|_| ()),
            _ => err!(GoodFaithError::InvalidGatewayToken),
        }
    }
}

/// Checks that `token` is an active, unexpired gateway token for `wallet`
/// issued under `network`.
pub fn verify_gateway_token(
    token: &AccountInfo,
    wallet: &Pubkey,
    network: &Pubkey,
    now: i64,
) -> Result<()> {
    require_keys_eq!(
        *token.owner,
        GATEWAY_PROGRAM_ID,
        GoodFaithError::InvalidGatewayToken
    );
    let data = token.try_borrow_data()?;
    let mut r = Reader {
        data: &data,
        pos: 0,
    };

    r.u8()?; // version
    r.option_pubkey()?; // parent_gateway_token (deprecated)
    let owner_wallet = r.pubkey()?;
    r.option_pubkey()?; // owner_identity (deprecated)
    let gatekeeper_network = r.pubkey()?;
    r.pubkey()?; // issuing_gatekeeper
    let state = r.u8()?;
    let expiry = match r.u8()? {
        0 => None,
        1 => {
            let bytes: [u8; 8] = r
                .take(8)?
                .try_into()
                .map_err(|_| GoodFaithError::InvalidGatewayToken)?;
            Some(i64::from_le_bytes(bytes))
        }
        _ => return err!(GoodFaithError::InvalidGatewayToken),
    };

    require!(
        owner_wallet == *wallet && gatekeeper_network == *network && state == STATE_ACTIVE,
        GoodFaithError::InvalidGatewayToken
    );
    if let Some(expiry) = expiry {
        require!(expiry > now, GoodFaithError::InvalidGatewayToken);
    }
    Ok(())
}
