use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use crate::errors::AetherisError;
use crate::math::fixed_point::FixedPoint;
use crate::state::{BatchState, MarketConfig, OrderReceipt, OrderSide};

#[derive(Accounts)]
pub struct ClaimSettlement<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        seeds = [b"market_config", market_config.base_mint.as_ref(), market_config.quote_mint.as_ref()],
        bump = market_config.bump
    )]
    pub market_config: Account<'info, MarketConfig>,

    #[account(
        mut,
        seeds = [b"batch_state", market_config.key().as_ref(), &batch_state.epoch_index.to_le_bytes()],
        bump = batch_state.bump
    )]
    pub batch_state: Account<'info, BatchState>,

    #[account(
        mut,
        seeds = [b"order_receipt", batch_state.key().as_ref(), trader.key().as_ref()],
        bump = order_receipt.bump,
        has_one = trader,
        has_one = batch
    )]
    pub order_receipt: Account<'info, OrderReceipt>,

    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"vault_base", batch_state.key().as_ref()],
        bump = batch_state.vault_base_bump
    )]
    pub vault_base: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault_quote", batch_state.key().as_ref()],
        bump = batch_state.vault_quote_bump
    )]
    pub vault_quote: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub trader_base_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub trader_quote_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<ClaimSettlement>) -> Result<()> {
    let receipt = &mut ctx.accounts.order_receipt;
    let batch = &ctx.accounts.batch_state;

    require!(batch.is_settled, AetherisError::BatchNotSettled);
    require!(!receipt.claimed, AetherisError::OrderAlreadyClaimed);

    let price = FixedPoint::from_raw(batch.clearing_price_scaled);
    let epoch_bytes = batch.epoch_index.to_le_bytes();
    let market_key = ctx.accounts.market_config.key();
    let seeds = &[
        b"batch_state",
        market_key.as_ref(),
        epoch_bytes.as_ref(),
        &[batch.bump],
    ];
    let signer_seeds = &[&seeds[..]];

    match receipt.side {
        OrderSide::Buy => {
            // Buyer deposited Quote tokens -> Receives Base tokens at UCP
            // Validate Limit Price: Buyer expects price <= limit_price
            require!(
                batch.clearing_price_scaled <= receipt.limit_price_scaled,
                AetherisError::LimitPriceViolated
            );

            // Output Base tokens = Deposited Quote / UCP
            let base_to_receive = price.div_u64(receipt.deposited_amount)?;

            // Transfer Base tokens from batch vault to trader
            let cpi_accounts = TransferChecked {
                from: ctx.accounts.vault_base.to_account_info(),
                to: ctx.accounts.trader_base_account.to_account_info(),
                authority: ctx.accounts.batch_state.to_account_info(),
                mint: ctx.accounts.base_mint.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token_interface::transfer_checked(cpi_ctx, base_to_receive, ctx.accounts.base_mint.decimals)?;
        }
        OrderSide::Sell => {
            // Seller deposited Base tokens -> Receives Quote tokens at UCP
            // Validate Limit Price: Seller expects price >= limit_price
            require!(
                batch.clearing_price_scaled >= receipt.limit_price_scaled,
                AetherisError::LimitPriceViolated
            );

            // Output Quote tokens = Deposited Base * UCP
            let quote_to_receive = price.mul_u64(receipt.deposited_amount)?;

            // Transfer Quote tokens from batch vault to trader
            let cpi_accounts = TransferChecked {
                from: ctx.accounts.vault_quote.to_account_info(),
                to: ctx.accounts.trader_quote_account.to_account_info(),
                authority: ctx.accounts.batch_state.to_account_info(),
                mint: ctx.accounts.quote_mint.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token_interface::transfer_checked(cpi_ctx, quote_to_receive, ctx.accounts.quote_mint.decimals)?;
        }
    }

    receipt.claimed = true;
    Ok(())
}