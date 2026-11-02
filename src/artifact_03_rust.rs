use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Aegis11111111111111111111111111111111111111");

pub const BUCKET_SIZE_SLOTS: u64 = 4; // Batch clearing every ~1.6s
pub const PRECISION: u128 = 1_000_000_000_000; // 1e12 fixed-point math precision
pub const MAX_ORACLE_DEVIATION_BPS: u64 = 500; // 5% max deviation from external reference

#[program]
pub mod solaegis {
    use super::*;

    /// Initialize a new two-token market configuration.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        fee_bps: u16,
    ) -> Result<()> {
        require!(fee_bps <= 1000, SolAegisError::ExcessiveFee);

        let market = &mut ctx.accounts.market;
        market.admin = ctx.accounts.admin.key();
        market.mint_a = ctx.accounts.mint_a.key();
        market.mint_b = ctx.accounts.mint_b.key();
        market.vault_a = ctx.accounts.vault_a.key();
        market.vault_b = ctx.accounts.vault_b.key();
        market.fee_bps = fee_bps;
        market.bump = ctx.bumps.market;
        market.vault_a_bump = ctx.bumps.vault_a;
        market.vault_b_bump = ctx.bumps.vault_b;

        emit!(MarketInitializedEvent {
            market: market.key(),
            mint_a: market.mint_a,
            mint_b: market.mint_b,
        });

        Ok(())
    }

    /// User deposits a trading intent into an active or upcoming slot bucket.
    pub fn deposit_intent(
        ctx: Context<DepositIntent>,
        amount_in: u64,
        min_amount_out: u64,
        direction: Direction,
    ) -> Result<()> {
        require!(amount_in > 0, SolAegisError::ZeroDepositAmount);
        let clock = Clock::get()?;
        let current_slot = clock.slot;

        // Intent targets the current slot bucket boundary
        let target_bucket = (current_slot / BUCKET_SIZE_SLOTS) * BUCKET_SIZE_SLOTS;

        let batch = &mut ctx.accounts.batch;
        if batch.slot_bucket == 0 {
            batch.slot_bucket = target_bucket;
            batch.market = ctx.accounts.market.key();
            batch.status = BatchStatus::Open;
            batch.bump = ctx.bumps.batch;
        }

        require!(
            batch.status == BatchStatus::Open,
            SolAegisError::BatchNotAcceptingOrders
        );

        // Transfer funds from user token account into vault
        let (vault_account, user_token_account) = match direction {
            Direction::AtoB => (
                ctx.accounts.vault_a.to_account_info(),
                ctx.accounts.user_token_account.to_account_info(),
            ),
            Direction::BtoA => (
                ctx.accounts.vault_b.to_account_info(),
                ctx.accounts.user_token_account.to_account_info(),
            ),
        };

        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: user_token_account,
                to: vault_account,
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount_in)?;

        // Update user intent state
        let intent = &mut ctx.accounts.intent;
        intent.user = ctx.accounts.user.key();
        intent.batch = batch.key();
        intent.direction = direction;
        intent.amount_in = amount_in;
        intent.min_amount_out = min_amount_out;
        intent.filled_amount_out = 0;
        intent.claimed = false;
        intent.bump = ctx.bumps.intent;

        // Update batch aggregates
        match direction {
            Direction::AtoB => {
                batch.total_in_a = batch.total_in_a.checked_add(amount_in).ok_or(SolAegisError::MathOverflow)?;
            }
            Direction::BtoA => {
                batch.total_in_b = batch.total_in_b.checked_add(amount_in).ok_or(SolAegisError::MathOverflow)?;
            }
        }
        batch.order_count = batch.order_count.checked_add(1).ok_or(SolAegisError::MathOverflow)?;

        emit!(IntentSubmittedEvent {
            batch: batch.key(),
            user: intent.user,
            direction,
            amount_in,
            min_amount_out,
        });

        Ok(())
    }

    /// Solver settles a matured batch using CoW matching and uniform clearing pricing.
    pub fn settle_batch_cow(
        ctx: Context<SettleBatchCoW>,
        clearing_price_scaled: u128, // Scaled by PRECISION: (Amount B per 1 Unit of A)
    ) -> Result<()> {
        let clock = Clock::get()?;
        let batch = &mut ctx.accounts.batch;

        // Invariant 1: Batch maturity check
        require!(
            clock.slot >= batch.slot_bucket + BUCKET_SIZE_SLOTS,
            SolAegisError::BatchNotMatured
        );
        require!(
            batch.status == BatchStatus::Open,
            SolAegisError::BatchAlreadySettled
        );

        require!(clearing_price_scaled > 0, SolAegisError::InvalidClearingPrice);

        // Execute CoW matching logic
        // Let total_a = Total token A deposited (Direction AtoB)
        // Let total_b = Total token B deposited (Direction BtoA)
        // Equivalent Token B demanded by A = total_a * clearing_price_scaled / PRECISION
        let b_needed_for_a = (batch.total_in_a as u128)
            .checked_mul(clearing_price_scaled)
            .ok_or(SolAegisError::MathOverflow)?
            .checked_div(PRECISION)
            .ok_or(SolAegisError::MathOverflow)?;

        let (matched_a, matched_b) = if b_needed_for_a <= batch.total_in_b as u128 {
            // Token A is the short side; all A is satisfied internally
            let matched_a = batch.total_in_a as u128;
            let matched_b = b_needed_for_a;
            (matched_a, matched_b)
        } else {
            // Token B is the short side; all B is satisfied internally
            let matched_b = batch.total_in_b as u128;
            let matched_a = matched_b
                .checked_mul(PRECISION)
                .ok_or(SolAegisError::MathOverflow)?
                .checked_div(clearing_price_scaled)
                .ok_or(SolAegisError::MathOverflow)?;
            (matched_a, matched_b)
        };

        batch.matched_volume_a = matched_a as u64;
        batch.matched_volume_b = matched_b as u64;
        batch.clearing_price_scaled = clearing_price_scaled;
        batch.status = BatchStatus::Settled;
        batch.solver = ctx.accounts.solver.key();

        emit!(BatchSettledEvent {
            batch: batch.key(),
            clearing_price: clearing_price_scaled,
            matched_a: batch.matched_volume_a,
            matched_b: batch.matched_volume_b,
        });

        Ok(())
    }

    /// User claims their proportional tokens or refund post-batch settlement.
    pub fn claim_execution(ctx: Context<ClaimExecution>) -> Result<()> {
        let batch = &ctx.accounts.batch;
        let intent = &mut ctx.accounts.intent;
        let market = &ctx.accounts.market;

        require!(batch.status == BatchStatus::Settled, SolAegisError::BatchNotSettled);
        require!(!intent.claimed, SolAegisError::AlreadyClaimed);
        require!(intent.user == ctx.accounts.user.key(), SolAegisError::UnauthorizedClaim);

        let seeds = &[
            b"market".as_ref(),
            market.mint_a.as_ref(),
            market.mint_b.as_ref(),
            &[market.bump],
        ];
        let signer = &[&seeds[..]];

        match intent.direction {
            Direction::AtoB => {
                // Determine user fill based on pro-rata share of total matched volume
                let user_share = (intent.amount_in as u128)
                    .checked_mul(batch.matched_volume_a as u128)
                    .ok_or(SolAegisError::MathOverflow)?
                    .checked_div(batch.total_in_a as u128)
                    .ok_or(SolAegisError::MathOverflow)? as u64;

                let output_b = (user_share as u128)
                    .checked_mul(batch.clearing_price_scaled)
                    .ok_or(SolAegisError::MathOverflow)?
                    .checked_div(PRECISION)
                    .ok_or(SolAegisError::MathOverflow)? as u64;

                let unfulfilled_refund_a = intent.amount_in.checked_sub(user_share).ok_or(SolAegisError::MathOverflow)?;

                // Slippage assertion against individual limit
                if user_share > 0 {
                    require!(output_b >= intent.min_amount_out, SolAegisError::SlippageExceeded);
                    
                    // Transfer Token B to user
                    let transfer_b_ctx = CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.vault_b.to_account_info(),
                            to: ctx.accounts.user_token_account_b.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer,
                    );
                    token::transfer(transfer_b_ctx, output_b)?;
                }

                // Refund unmatched Token A
                if unfulfilled_refund_a > 0 {
                    let refund_a_ctx = CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.vault_a.to_account_info(),
                            to: ctx.accounts.user_token_account_a.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer,
                    );
                    token::transfer(refund_a_ctx, unfulfilled_refund_a)?;
                }

                intent.filled_amount_out = output_b;
            }
            Direction::BtoA => {
                let user_share = (intent.amount_in as u128)
                    .checked_mul(batch.matched_volume_b as u128)
                    .ok_or(SolAegisError::MathOverflow)?
                    .checked_div(batch.total_in_b as u128)
                    .ok_or(SolAegisError::MathOverflow)? as u64;

                let output_a = (user_share as u128)
                    .checked_mul(PRECISION)
                    .ok_or(SolAegisError::MathOverflow)?
                    .checked_div(batch.clearing_price_scaled)
                    .ok_or(SolAegisError::MathOverflow)? as u64;

                let unfulfilled_refund_b = intent.amount_in.checked_sub(user_share).ok_or(SolAegisError::MathOverflow)?;

                if user_share > 0 {
                    require!(output_a >= intent.min_amount_out, SolAegisError::SlippageExceeded);

                    // Transfer Token A to user
                    let transfer_a_ctx = CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.vault_a.to_account_info(),
                            to: ctx.accounts.user_token_account_a.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer,
                    );
                    token::transfer(transfer_a_ctx, output_a)?;
                }

                // Refund unmatched Token B
                if unfulfilled_refund_b > 0 {
                    let refund_b_ctx = CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.vault_b.to_account_info(),
                            to: ctx.accounts.user_token_account_b.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer,
                    );
                    token::transfer(refund_b_ctx, unfulfilled_refund_b)?;
                }

                intent.filled_amount_out = output_a;
            }
        }

        intent.claimed = true;
        emit!(IntentClaimedEvent {
            intent: intent.key(),
            user: intent.user,
            filled: intent.filled_amount_out,
        });

        Ok(())
    }
}

// ---------------------------------------------------------
// Contexts & Account Layouts
// ---------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint_a: Box<Account<'info, Mint>>,
    pub mint_b: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        space = 8 + Market::LEN,
        seeds = [b"market", mint_a.key().as_ref(), mint_b.key().as_ref()],
        bump
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"vault_a", market.key().as_ref()],
        bump,
        token::mint = mint_a,
        token::authority = market
    )]
    pub vault_a: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"vault_b", market.key().as_ref()],
        bump,
        token::mint = mint_b,
        token::authority = market
    )]
    pub vault_b: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositIntent<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.mint_a.as_ref(), market.mint_b.as_ref()],
        bump = market.bump
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + BatchBucket::LEN,
        seeds = [b"batch", market.key().as_ref(), &((Clock::get().unwrap().slot / BUCKET_SIZE_SLOTS) * BUCKET_SIZE_SLOTS).to_le_bytes()],
        bump
    )]
    pub batch: Box<Account<'info, BatchBucket>>,

    #[account(
        init,
        payer = user,
        space = 8 + UserIntent::LEN,
        seeds = [b"intent", batch.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub intent: Box<Account<'info, UserIntent>>,

    #[account(mut)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault_a", market.key().as_ref()],
        bump = market.vault_a_bump
    )]
    pub vault_a: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault_b", market.key().as_ref()],
        bump = market.vault_b_bump
    )]
    pub vault_b: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleBatchCoW<'info> {
    #[account(mut)]
    pub solver: Signer<'info>,

    #[account(
        seeds = [b"market", market.mint_a.as_ref(), market.mint_b.as_ref()],
        bump = market.bump
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"batch", market.key().as_ref(), &batch.slot_bucket.to_le_bytes()],
        bump = batch.bump
    )]
    pub batch: Box<Account<'info, BatchBucket>>,
}

#[derive(Accounts)]
pub struct ClaimExecution<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.mint_a.as_ref(), market.mint_b.as_ref()],
        bump = market.bump
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        seeds = [b"batch", market.key().as_ref(), &batch.slot_bucket.to_le_bytes()],
        bump = batch.bump
    )]
    pub batch: Box<Account<'info, BatchBucket>>,

    #[account(
        mut,
        seeds = [b"intent", batch.key().as_ref(), user.key().as_ref()],
        bump = intent.bump
    )]
    pub intent: Box<Account<'info, UserIntent>>,

    #[account(
        mut,
        seeds = [b"vault_a", market.key().as_ref()],
        bump = market.vault_a_bump
    )]
    pub vault_a: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault_b", market.key().as_ref()],
        bump = market.vault_b_bump
    )]
    pub vault_b: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_token_account_a: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_token_account_b: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------
// State Layouts & Types
// ---------------------------------------------------------

#[account]
pub struct Market {
    pub admin: Pubkey,         // 32
    pub mint_a: Pubkey,        // 32
    pub mint_b: Pubkey,        // 32
    pub vault_a: Pubkey,       // 32
    pub vault_b: Pubkey,       // 32
    pub fee_bps: u16,          // 2
    pub bump: u8,              // 1
    pub vault_a_bump: u8,      // 1
    pub vault_b_bump: u8,      // 1
}

impl Market {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 32 + 2 + 1 + 1 + 1;
}

#[account]
pub struct BatchBucket {
    pub market: Pubkey,               // 32
    pub slot_bucket: u64,             // 8
    pub total_in_a: u64,              // 8
    pub total_in_b: u64,              // 8
    pub matched_volume_a: u64,        // 8
    pub matched_volume_b: u64,        // 8
    pub clearing_price_scaled: u128,  // 16
    pub solver: Pubkey,               // 32
    pub order_count: u32,             // 4
    pub status: BatchStatus,          // 1
    pub bump: u8,                     // 1
}

impl BatchBucket {
    pub const LEN: usize = 32 + 8 + 8 + 8 + 8 + 8 + 16 + 32 + 4 + 1 + 1;
}

#[account]
pub struct UserIntent {
    pub user: Pubkey,          // 32
    pub batch: Pubkey,         // 32
    pub direction: Direction,  // 1
    pub amount_in: u64,        // 8
    pub min_amount_out: u64,   // 8
    pub filled_amount_out: u64,// 8
    pub claimed: bool,         // 1
    pub bump: u8,              // 1
}

impl UserIntent {
    pub const LEN: usize = 32 + 32 + 1 + 8 + 8 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    AtoB,
    BtoA,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum BatchStatus {
    Open,
    Settled,
    Expired,
}

// ---------------------------------------------------------
// Events & Errors
// ---------------------------------------------------------

#[event]
pub struct MarketInitializedEvent {
    pub market: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
}

#[event]
pub struct IntentSubmittedEvent {
    pub batch: Pubkey,
    pub user: Pubkey,
    pub direction: Direction,
    pub amount_in: u64,
    pub min_amount_out: u64,
}

#[event]
pub struct BatchSettledEvent {
    pub batch: Pubkey,
    pub clearing_price: u128,
    pub matched_a: u64,
    pub matched_b: u64,
}

#[event]
pub struct IntentClaimedEvent {
    pub intent: Pubkey,
    pub user: Pubkey,
    pub filled: u64,
}

#[error_code]
pub enum SolAegisError {
    #[msg("Admin fee exceeds maximum allowed basis points (10%)")]
    ExcessiveFee,
    #[msg("Zero deposit amount is invalid")]
    ZeroDepositAmount,
    #[msg("Target batch is closed or already settled")]
    BatchNotAcceptingOrders,
    #[msg("Batch duration has not elapsed required slots")]
    BatchNotMatured,
    #[msg("Batch has already been settled")]
    BatchAlreadySettled,
    #[msg("Supplied clearing price is invalid")]
    InvalidClearingPrice,
    #[msg("Math calculation resulted in an overflow or division by zero")]
    MathOverflow,
    #[msg("Intent has already been claimed")]
    AlreadyClaimed,
    #[msg("Batch is not settled yet")]
    BatchNotSettled,
    #[msg("User is not authorized to claim this intent")]
    UnauthorizedClaim,
    #[msg("Received execution price violates user slippage limit")]
    SlippageExceeded,
}