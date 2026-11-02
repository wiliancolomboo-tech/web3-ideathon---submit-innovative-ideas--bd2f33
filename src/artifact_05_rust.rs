pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;
pub use errors::*;
pub use instructions::*;
pub use state::*;

declare_id!("AETH1111111111111111111111111111111111111111");

#[program]
pub mod aetheris_core {
    use super::*;

    /// Initializes a new market instance with Base & Quote token escrow vaults.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_index: u64,
        base_decimals: u8,
        quote_decimals: u8,
        min_order_quote_size: u64,
    ) -> Result<()> {
        instructions::initialize_market::handler(ctx, market_index, base_decimals, quote_decimals, min_order_quote_size)
    }

    /// Deposits a limit order into the active slot's batch buffer PDA.
    pub fn deposit_order(
        ctx: Context<DepositOrder>,
        side: u8,            // 0 = Buy Base with Quote, 1 = Sell Base for Quote
        amount_in: u64,      // Escrowed amount (Quote atomic units if Buy, Base atomic units if Sell)
        limit_price: u64,    // Fixed-point Price (Quote per Base scaled by 1e9)
        expiry_slot: u64,    // Cancellation boundary
    ) -> Result<()> {
        instructions::deposit_order::handler(ctx, side, amount_in, limit_price, expiry_slot)
    }

    /// Solvers submit a uniform clearing solution for the closed slot batch.
    pub fn settle_batch(
        ctx: Context<SettleBatch>,
        target_slot: u64,
        clearing_price: u64, // Scaled by 1e9
        matched_base_volume: u64,
    ) -> Result<()> {
        instructions::settle_batch::handler(ctx, target_slot, clearing_price, matched_base_volume)
    }
}