use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{MarketConfig, SlotBatchBuffer};
use crate::errors::AetherisError;
use crate::math::MathEngine;

#[derive(Accounts)]
#[instruction(target_slot: u64)]
pub struct SettleBatch<'info> {
    #[account(mut)]
    pub solver: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_index.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = base_vault,
        has_one = quote_vault,
    )]
    pub market: Account<'info, MarketConfig>,

    #[account(
        mut,
        seeds = [b"batch", market.key().as_ref(), target_slot.to_le_bytes().as_ref()],
        bump
    )]
    pub batch_buffer: AccountLoader<'info, SlotBatchBuffer>,

    #[account(mut)]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub quote_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub clock: Sysvar<'info, Clock>,
    // Remaining accounts: destination token accounts for users whose orders were filled
}

pub fn handler<'a, 'b, 'c, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, SettleBatch<'info>>,
    target_slot: u64,
    clearing_price: u64,
    matched_base_volume: u64,
) -> Result<()> {
    require!(clearing_price > 0, AetherisError::ZeroClearingPrice);
    let current_slot = ctx.accounts.clock.slot;
    require!(current_slot > target_slot, AetherisError::SlotAlreadyClosed);

    let market_key = ctx.accounts.market.key();
    let market_bump = ctx.accounts.market.bump;
    let market_index_bytes = ctx.accounts.market.market_index.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"market",
        market_index_bytes.as_ref(),
        &[market_bump],
    ]];

    let mut total_base_disbursed: u64 = 0;
    let mut total_quote_disbursed: u64 = 0;

    {
        let mut batch = ctx.accounts.batch_buffer.load_mut()?;
        require!(batch.is_cleared == 0, AetherisError::BatchAlreadyCleared);

        let order_count = batch.order_count as usize;
        let remaining_accounts = ctx.remaining_accounts;
        require!(remaining_accounts.len() >= order_count, AetherisError::InvalidRemainingAccountsLength);

        // Execute match allocations across all orders at the single uniform clearing price
        for i in 0..order_count {
            let order = &mut batch.orders[i];
            
            // Limit price compliance check
            if !MathEngine::is_limit_satisfied(order.side, order.limit_price, clearing_price) {
                // Limit not satisfied at UCP: Order does not participate in this clear
                continue;
            }

            if order.side == 0 {
                // Buy Order: Escrowed Quote -> Receives Base
                let base_to_receive = MathEngine::quote_to_base(order.amount_in, clearing_price)?;
                order.filled_out_amount = base_to_receive;
                order.is_settled = 1;

                total_base_disbursed = total_base_disbursed
                    .checked_add(base_to_receive)
                    .ok_or(AetherisError::MathOverflow)?;

                // Transfer Base tokens to user's specified token account
                let dest_account_info = &remaining_accounts[i];
                let cpi_accounts = Transfer {
                    from: ctx.accounts.base_vault.to_account_info(),
                    to: dest_account_info.clone(),
                    authority: ctx.accounts.market.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                );
                token::transfer(cpi_ctx, base_to_receive)?;
            } else {
                // Sell Order: Escrowed Base -> Receives Quote
                let quote_to_receive = MathEngine::base_to_quote(order.amount_in, clearing_price)?;
                order.filled_out_amount = quote_to_receive;
                order.is_settled = 1;

                total_quote_disbursed = total_quote_disbursed
                    .checked_add(quote_to_receive)
                    .ok_or(AetherisError::MathOverflow)?;

                // Transfer Quote tokens to user's specified token account
                let dest_account_info = &remaining_accounts[i];
                let cpi_accounts = Transfer {
                    from: ctx.accounts.quote_vault.to_account_info(),
                    to: dest_account_info.clone(),
                    authority: ctx.accounts.market.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                );
                token::transfer(cpi_ctx, quote_to_receive)?;
            }
        }

        // Global Conservation Invariant Check
        let expected_quote_from_base = MathEngine::base_to_quote(total_base_disbursed, clearing_price)?;
        let delta = if expected_quote_from_base > total_quote_disbursed {
            expected_quote_from_base - total_quote_disbursed
        } else {
            total_quote_disbursed - expected_quote_from_base
        };
        // Allow rounding discrepancy within 10 units (micro-wei)
        require!(delta <= 10, AetherisError::ConservationOfValueViolated);

        batch.is_cleared = 1;
    }

    emit!(BatchSettledEvent {
        market: market_key,
        slot: target_slot,
        solver: ctx.accounts.solver.key(),
        clearing_price,
        matched_base_volume,
        total_base_disbursed,
        total_quote_disbursed,
    });

    Ok(())
}

#[event]
pub struct BatchSettledEvent {
    pub market: Pubkey,
    pub slot: u64,
    pub solver: Pubkey,
    pub clearing_price: u64,
    pub matched_base_volume: u64,
    pub total_base_disbursed: u64,
    pub total_quote_disbursed: u64,
}