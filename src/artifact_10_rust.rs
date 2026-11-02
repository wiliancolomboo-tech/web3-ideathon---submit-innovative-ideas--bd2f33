use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{MarketConfig, SlotBatchBuffer, PackedOrder, MAX_ORDERS_PER_BATCH};
use crate::errors::AetherisError;
use crate::math::MathEngine;

#[derive(Accounts)]
pub struct DepositOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        has_one = base_vault,
        has_one = quote_vault,
        constraint = !market.is_frozen @ AetherisError::MarketFrozen
    )]
    pub market: Account<'info, MarketConfig>,

    #[account(
        init_if_needed,
        payer = user,
        space = SlotBatchBuffer::LEN,
        seeds = [b"batch", market.key().as_ref(), Clock::get()?.slot.to_le_bytes().as_ref()],
        bump
    )]
    pub batch_buffer: AccountLoader<'info, SlotBatchBuffer>,

    #[account(mut)]
    pub user_token_source: Account<'info, TokenAccount>,

    #[account(mut)]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub quote_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(
    ctx: Context<DepositOrder>,
    side: u8,
    amount_in: u64,
    limit_price: u64,
    expiry_slot: u64,
) -> Result<()> {
    require!(side <= 1, AetherisError::InvalidOrderSide);
    let current_slot = ctx.accounts.clock.slot;
    require!(expiry_slot >= current_slot, AetherisError::OrderExpired);

    // Minimum size check (normalized to Quote equivalent)
    if side == 0 {
        require!(amount_in >= ctx.accounts.market.min_order_quote_size, AetherisError::OrderTooSmall);
    } else {
        let estimated_quote = MathEngine::base_to_quote(amount_in, limit_price)?;
        require!(estimated_quote >= ctx.accounts.market.min_order_quote_size, AetherisError::OrderTooSmall);
    }

    // Transfer user tokens into market vault escrow
    let destination = if side == 0 {
        ctx.accounts.quote_vault.to_account_info()
    } else {
        ctx.accounts.base_vault.to_account_info()
    };

    let cpi_accounts = Transfer {
        from: ctx.accounts.user_token_source.to_account_info(),
        to: destination,
        authority: ctx.accounts.user.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, amount_in)?;

    // Append order to Zero-Copy Buffer
    let mut batch = ctx.accounts.batch_buffer.load_init()?;
    if batch.slot_number == 0 {
        batch.market = ctx.accounts.market.key();
        batch.slot_number = current_slot;
        batch.order_count = 0;
        batch.is_cleared = 0;
        batch.total_buy_quote = 0;
        batch.total_sell_base = 0;
    }

    require!(batch.is_cleared == 0, AetherisError::BatchAlreadyCleared);
    let idx = batch.order_count as usize;
    require!(idx < MAX_ORDERS_PER_BATCH, AetherisError::BatchBufferFull);

    batch.orders[idx] = PackedOrder {
        user: ctx.accounts.user.key(),
        amount_in,
        limit_price,
        expiry_slot,
        filled_out_amount: 0,
        side,
        is_settled: 0,
        _padding: [0u8; 6],
    };

    if side == 0 {
        batch.total_buy_quote = batch.total_buy_quote.checked_add(amount_in).ok_or(AetherisError::MathOverflow)?;
    } else {
        batch.total_sell_base = batch.total_sell_base.checked_add(amount_in).ok_or(AetherisError::MathOverflow)?;
    }

    batch.order_count += 1;

    emit!(OrderDepositedEvent {
        market: ctx.accounts.market.key(),
        slot: current_slot,
        user: ctx.accounts.user.key(),
        side,
        amount_in,
        limit_price,
        order_index: idx as u32,
    });

    Ok(())
}

#[event]
pub struct OrderDepositedEvent {
    pub market: Pubkey,
    pub slot: u64,
    pub user: Pubkey,
    pub side: u8,
    pub amount_in: u64,
    pub limit_price: u64,
    pub order_index: u32,
}