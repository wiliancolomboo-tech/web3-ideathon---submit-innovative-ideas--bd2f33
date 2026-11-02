use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::MarketConfig;
use crate::errors::AetherisError;

#[derive(Accounts)]
#[instruction(market_index: u64)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = MarketConfig::LEN,
        seeds = [b"market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, MarketConfig>,

    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"vault_base", market.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = market,
    )]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        seeds = [b"vault_quote", market.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = market,
    )]
    pub quote_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeMarket>,
    market_index: u64,
    base_decimals: u8,
    quote_decimals: u8,
    min_order_quote_size: u64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.admin = ctx.accounts.admin.key();
    market.market_index = market_index;
    market.base_mint = ctx.accounts.base_mint.key();
    market.quote_mint = ctx.accounts.quote_mint.key();
    market.base_vault = ctx.accounts.base_vault.key();
    market.quote_vault = ctx.accounts.quote_vault.key();
    market.base_decimals = base_decimals;
    market.quote_decimals = quote_decimals;
    market.min_order_quote_size = min_order_quote_size;
    market.bump = ctx.bumps.market;
    market.is_frozen = false;

    Ok(())
}