use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;
use state::OrderSide;

declare_id!("Aethr11111111111111111111111111111111111111");

#[program]
pub mod aetheris {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        epoch_duration_slots: u64,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::initialize_market::handler(ctx, epoch_duration_slots, fee_bps)
    }

    pub fn commit_order(
        ctx: Context<CommitOrder>,
        side: OrderSide,
        limit_price_scaled: u128,
        deposit_amount: u64,
    ) -> Result<()> {
        instructions::commit_order::handler(ctx, side, limit_price_scaled, deposit_amount)
    }

    pub fn close_epoch(ctx: Context<CloseEpoch>) -> Result<()> {
        instructions::close_epoch::handler(ctx)
    }

    pub fn solve_and_route(
        ctx: Context<SolveAndRoute>,
        external_reference_price_scaled: u128,
    ) -> Result<()> {
        instructions::solve_and_route::handler(ctx, external_reference_price_scaled)
    }

    pub fn claim_settlement(ctx: Context<ClaimSettlement>) -> Result<()> {
        instructions::claim_settlement::handler(ctx)
    }
}