use crate::errors::AetherisError;
use crate::state::PRICE_PRECISION;
use anchor_lang::prelude::*;

pub struct MathEngine;

impl MathEngine {
    /// Converts a Quote amount to Base amount given a fixed-point price (1e9).
    /// Base = (Quote * 1e9) / Price
    pub fn quote_to_base(quote_amount: u64, price: u64) -> Result<u64> {
        require!(price > 0, AetherisError::ZeroClearingPrice);
        let quote_u128 = quote_amount as u128;
        let price_u128 = price as u128;
        
        let base_u128 = quote_u128
            .checked_mul(PRICE_PRECISION)
            .ok_or(AetherisError::MathOverflow)?
            .checked_div(price_u128)
            .ok_or(AetherisError::MathOverflow)?;

        u64::try_from(base_u128).map_err(|_| AetherisError::MathOverflow.into())
    }

    /// Converts a Base amount to Quote amount given a fixed-point price (1e9).
    /// Quote = (Base * Price) / 1e9
    pub fn base_to_quote(base_amount: u64, price: u64) -> Result<u64> {
        let base_u128 = base_amount as u128;
        let price_u128 = price as u128;

        let quote_u128 = base_u128
            .checked_mul(price_u128)
            .ok_or(AetherisError::MathOverflow)?
            .checked_div(PRICE_PRECISION)
            .ok_or(AetherisError::MathOverflow)?;

        u64::try_from(quote_u128).map_err(|_| AetherisError::MathOverflow.into())
    }

    /// Validates if an executed price respects the order's limit price.
    pub fn is_limit_satisfied(side: u8, limit_price: u64, clearing_price: u64) -> bool {
        if side == 0 {
            // Buy order: Cleared price must be <= user's maximum willing buy price
            clearing_price <= limit_price
        } else {
            // Sell order: Cleared price must be >= user's minimum willing sell price
            clearing_price >= limit_price
        }
    }
}