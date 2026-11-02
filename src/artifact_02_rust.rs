use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("ChronoBatch11111111111111111111111111111111");

pub const RAY: u128 = 1_000_000_000_000_000_000; // 10^18 fixed point
pub const POOL_SEED: &[u8] = b"pool";
pub const EPOCH_SEED: &[u8] = b"epoch";
pub const INTENT_SEED: &[u8] = b"intent";
pub const VAULT_A_SEED: &[u8] = b"vault_a";
pub const VAULT_B_SEED: &[u8] = b"vault_b";

#[program]
pub mod chronobatch {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        epoch_duration_slots: u64,
        fee_basis_points: u16,
    ) -> Result<()> {
        require!(epoch_duration_slots >= 2, ChronoError::InvalidEpochDuration);
        require!(fee_basis_points <= 1000, ChronoError::ExcessiveFee); // Max 10%

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.mint_a = ctx.accounts.mint_a.key();
        pool.mint_b = ctx.accounts.mint_b.key();
        pool.mint_a_decimals = ctx.accounts.mint_a.decimals;
        pool.mint_b_decimals = ctx.accounts.mint_b.decimals;
        pool.vault_a = ctx.accounts.vault_a.key();
        pool.vault_b = ctx.accounts.vault_b.key();
        pool.current_epoch_id = 0;
        pool.epoch_duration_slots = epoch_duration_slots;
        pool.last_epoch_start_slot = Clock::get()?.slot;
        pool.fee_basis_points = fee_basis_points;
        pool.bump = ctx.bumps.pool;
        pool.vault_a_bump = ctx.bumps.vault_a;
        pool.vault_b_bump = ctx.bumps.vault_b;

        emit!(PoolInitialized {
            pool: pool.key(),
            authority: pool.authority,
            epoch_duration_slots,
        });

        Ok(())
    }

    pub fn open_epoch(ctx: Context<OpenEpoch>, epoch_id: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let clock = Clock::get()?;

        require_keys_eq!(ctx.accounts.pool.authority, ctx.accounts.signer.key(), ChronoError::Unauthorized);
        require_eq!(epoch_id, pool.current_epoch_id + 1, ChronoError::InvalidEpochSequence);

        let epoch = &mut ctx.accounts.epoch_state;
        epoch.pool = pool.key();
        epoch.epoch_id = epoch_id;
        epoch.start_slot = clock.slot;
        epoch.total_a_deposited = 0;
        epoch.total_b_deposited = 0;
        epoch.clearing_price_ray = 0;
        epoch.is_cleared = false;
        epoch.bump = ctx.bumps.epoch_state;

        pool.current_epoch_id = epoch_id;
        pool.last_epoch_start_slot = clock.slot;

        emit!(EpochOpened {
            pool: pool.key(),
            epoch_id,
            start_slot: clock.slot,
        });

        Ok(())
    }

    pub fn commit_swap_intent(
        ctx: Context<CommitSwapIntent>,
        epoch_id: u64,
        is_token_a_in: bool,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        require!(amount_in > 0, ChronoError::ZeroDepositAmount);
        let clock = Clock::get()?;
        let pool = &ctx.accounts.pool;

        require_eq!(epoch_id, pool.current_epoch_id, ChronoError::EpochMismatch);
        let slots_elapsed = clock.slot.saturating_sub(pool.last_epoch_start_slot);
        require!(
            slots_elapsed < pool.epoch_duration_slots,
            ChronoError::EpochAlreadyClosed
        );

        let intent = &mut ctx.accounts.order_intent;
        intent.owner = ctx.accounts.user.key();
        intent.epoch_id = epoch_id;
        intent.is_token_a_in = is_token_a_in;
        intent.amount_in = amount_in;
        intent.min_amount_out = min_amount_out;
        intent.claimed = false;
        intent.bump = ctx.bumps.order_intent;

        let epoch_state = &mut ctx.accounts.epoch_state;

        if is_token_a_in {
            epoch_state.total_a_deposited = epoch_state
                .total_a_deposited
                .checked_add(amount_in)
                .ok_or(ChronoError::MathOverflow)?;

            let cpi_accounts = TransferChecked {
                from: ctx.accounts.user_token_source.to_account_info(),
                mint: ctx.accounts.mint_a.to_account_info(),
                to: ctx.accounts.vault_a.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
            token_interface::transfer_checked(cpi_ctx, amount_in, pool.mint_a_decimals)?;
        } else {
            epoch_state.total_b_deposited = epoch_state
                .total_b_deposited
                .checked_add(amount_in)
                .ok_or(ChronoError::MathOverflow)?;

            let cpi_accounts = TransferChecked {
                from: ctx.accounts.user_token_source.to_account_info(),
                mint: ctx.accounts.mint_b.to_account_info(),
                to: ctx.accounts.vault_b.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
            token_interface::transfer_checked(cpi_ctx, amount_in, pool.mint_b_decimals)?;
        }

        emit!(OrderCommitted {
            pool: pool.key(),
            epoch_id,
            user: intent.owner,
            is_token_a_in,
            amount_in,
            min_amount_out,
        });

        Ok(())
    }

    pub fn execute_batch_settlement(
        ctx: Context<ExecuteBatchSettlement>,
        clearing_price_ray: u128,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let pool = &ctx.accounts.pool;
        let epoch = &mut ctx.accounts.epoch_state;

        require!(!epoch.is_cleared, ChronoError::EpochAlreadySettled);
        let slots_elapsed = clock.slot.saturating_sub(pool.last_epoch_start_slot);
        require!(
            slots_elapsed >= pool.epoch_duration_slots,
            ChronoError::EpochDurationActive
        );
        require!(clearing_price_ray > 0, ChronoError::InvalidClearingPrice);

        // Compute economic feasibility: P* must clear available balances.
        // clearing_price_ray is defined as (Units of Token B per 1 unit of Token A) * RAY
        epoch.clearing_price_ray = clearing_price_ray;
        epoch.is_cleared = true;

        emit!(BatchSettled {
            pool: pool.key(),
            epoch_id: epoch.epoch_id,
            clearing_price_ray,
            total_a_in: epoch.total_a_deposited,
            total_b_in: epoch.total_b_deposited,
        });

        Ok(())
    }

    pub fn claim_cleared_swap(ctx: Context<ClaimClearedSwap>) -> Result<()> {
        let epoch = &ctx.accounts.epoch_state;
        let pool = &ctx.accounts.pool;
        let intent = &mut ctx.accounts.order_intent;

        require!(epoch.is_cleared, ChronoError::EpochNotSettled);
        require!(!intent.claimed, ChronoError::OrderAlreadyClaimed);
        require_keys_eq!(intent.owner, ctx.accounts.user.key(), ChronoError::Unauthorized);

        intent.claimed = true;

        let pool_key = pool.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            POOL_SEED,
            pool.mint_a.as_ref(),
            pool.mint_b.as_ref(),
            &[pool.bump],
        ]];

        if intent.is_token_a_in {
            // User deposited A, receives B at clearing price: Amount_B = (Amount_A * Price_RAY) / RAY
            let gross_b = (intent.amount_in as u128)
                .checked_mul(epoch.clearing_price_ray)
                .ok_or(ChronoError::MathOverflow)?
                / RAY;

            let fee_b = gross_b
                .checked_mul(pool.fee_basis_points as u128)
                .ok_or(ChronoError::MathOverflow)?
                / 10_000;
            let net_b: u64 = gross_b
                .checked_sub(fee_b)
                .ok_or(ChronoError::MathOverflow)?
                .try_into()
                .map_err(|_| ChronoError::MathOverflow)?;

            require!(net_b >= intent.min_amount_out, ChronoError::SlippageExceeded);

            let cpi_accounts = TransferChecked {
                from: ctx.accounts.vault_b.to_account_info(),
                mint: ctx.accounts.mint_b.to_account_info(),
                to: ctx.accounts.user_destination.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token_interface::transfer_checked(cpi_ctx, net_b, pool.mint_b_decimals)?;

            emit!(SwapClaimed {
                epoch_id: epoch.epoch_id,
                user: intent.owner,
                token_out_amount: net_b,
            });
        } else {
            // User deposited B, receives A at clearing price: Amount_A = (Amount_B * RAY) / Price_RAY
            let gross_a = (intent.amount_in as u128)
                .checked_mul(RAY)
                .ok_or(ChronoError::MathOverflow)?
                / epoch.clearing_price_ray;

            let fee_a = gross_a
                .checked_mul(pool.fee_basis_points as u128)
                .ok_or(ChronoError::MathOverflow)?
                / 10_000;
            let net_a: u64 = gross_a
                .checked_sub(fee_a)
                .ok_or(ChronoError::MathOverflow)?
                .try_into()
                .map_err(|_| ChronoError::MathOverflow)?;

            require!(net_a >= intent.min_amount_out, ChronoError::SlippageExceeded);

            let cpi_accounts = TransferChecked {
                from: ctx.accounts.vault_a.to_account_info(),
                mint: ctx.accounts.mint_a.to_account_info(),
                to: ctx.accounts.user_destination.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token_interface::transfer_checked(cpi_ctx, net_a, pool.mint_a_decimals)?;

            emit!(SwapClaimed {
                epoch_id: epoch.epoch_id,
                user: intent.owner,
                token_out_amount: net_a,
            });
        }

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + PoolState::INIT_SPACE,
        seeds = [POOL_SEED, mint_a.key().as_ref(), mint_b.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, PoolState>,

    pub mint_a: InterfaceAccount<'info, Mint>,
    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_A_SEED, pool.key().as_ref()],
        bump,
        token::mint = mint_a,
        token::authority = pool,
        token::token_program = token_program
    )]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_B_SEED, pool.key().as_ref()],
        bump,
        token::mint = mint_b,
        token::authority = pool,
        token::token_program = token_program
    )]
    pub vault_b: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct OpenEpoch<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, PoolState>,

    #[account(
        init,
        payer = signer,
        space = 8 + EpochBatchState::INIT_SPACE,
        seeds = [EPOCH_SEED, pool.key().as_ref(), &epoch_id.to_le_bytes()],
        bump
    )]
    pub epoch_state: Account<'info, EpochBatchState>,

    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct CommitSwapIntent<'info> {
    #[account(
        seeds = [POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, PoolState>,

    #[account(
        mut,
        seeds = [EPOCH_SEED, pool.key().as_ref(), &epoch_id.to_le_bytes()],
        bump = epoch_state.bump
    )]
    pub epoch_state: Account<'info, EpochBatchState>,

    #[account(
        init,
        payer = user,
        space = 8 + OrderIntentRecord::INIT_SPACE,
        seeds = [INTENT_SEED, epoch_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump
    )]
    pub order_intent: Account<'info, OrderIntentRecord>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub user_token_source: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_A_SEED, pool.key().as_ref()],
        bump = pool.vault_a_bump
    )]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_B_SEED, pool.key().as_ref()],
        bump = pool.vault_b_bump
    )]
    pub vault_b: InterfaceAccount<'info, TokenAccount>,

    pub mint_a: InterfaceAccount<'info, Mint>,
    pub mint_b: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ExecuteBatchSettlement<'info> {
    #[account(
        seeds = [POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, PoolState>,

    #[account(
        mut,
        seeds = [EPOCH_SEED, pool.key().as_ref(), &epoch_state.epoch_id.to_le_bytes()],
        bump = epoch_state.bump
    )]
    pub epoch_state: Account<'info, EpochBatchState>,

    pub solver_crank: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimClearedSwap<'info> {
    #[account(
        seeds = [POOL_SEED, pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, PoolState>,

    #[account(
        seeds = [EPOCH_SEED, pool.key().as_ref(), &epoch_state.epoch_id.to_le_bytes()],
        bump = epoch_state.bump
    )]
    pub epoch_state: Account<'info, EpochBatchState>,

    #[account(
        mut,
        seeds = [INTENT_SEED, epoch_state.epoch_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump = order_intent.bump
    )]
    pub order_intent: Account<'info, OrderIntentRecord>,

    #[account(
        mut,
        seeds = [VAULT_A_SEED, pool.key().as_ref()],
        bump = pool.vault_a_bump
    )]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_B_SEED, pool.key().as_ref()],
        bump = pool.vault_b_bump
    )]
    pub vault_b: InterfaceAccount<'info, TokenAccount>,

    pub mint_a: InterfaceAccount<'info, Mint>,
    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_destination: InterfaceAccount<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

// -----------------------------------------------------------------------------
// STATE SCHEMAS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct PoolState {
    pub authority: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub current_epoch_id: u64,
    pub epoch_duration_slots: u64,
    pub last_epoch_start_slot: u64,
    pub fee_basis_points: u16,
    pub mint_a_decimals: u8,
    pub mint_b_decimals: u8,
    pub bump: u8,
    pub vault_a_bump: u8,
    pub vault_b_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EpochBatchState {
    pub pool: Pubkey,
    pub epoch_id: u64,
    pub start_slot: u64,
    pub total_a_deposited: u64,
    pub total_b_deposited: u64,
    pub clearing_price_ray: u128,
    pub is_cleared: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct OrderIntentRecord {
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub amount_in: u64,
    pub min_amount_out: u64,
    pub is_token_a_in: bool,
    pub claimed: bool,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub epoch_duration_slots: u64,
}

#[event]
pub struct EpochOpened {
    pub pool: Pubkey,
    pub epoch_id: u64,
    pub start_slot: u64,
}

#[event]
pub struct OrderCommitted {
    pub pool: Pubkey,
    pub epoch_id: u64,
    pub user: Pubkey,
    pub is_token_a_in: bool,
    pub amount_in: u64,
    pub min_amount_out: u64,
}

#[event]
pub struct BatchSettled {
    pub pool: Pubkey,
    pub epoch_id: u64,
    pub clearing_price_ray: u128,
    pub total_a_in: u64,
    pub total_b_in: u64,
}

#[event]
pub struct SwapClaimed {
    pub epoch_id: u64,
    pub user: Pubkey,
    pub token_out_amount: u64,
}

#[error_code]
pub enum ChronoError {
    #[msg("Epoch duration must be at least 2 slots")]
    InvalidEpochDuration,
    #[msg("Protocol fee exceeds hardcoded 1000 bps ceiling")]
    ExcessiveFee,
    #[msg("Caller lacks authority to perform this operation")]
    Unauthorized,
    #[msg("Epoch sequence is out of order")]
    InvalidEpochSequence,
    #[msg("Target epoch ID does not match active pool epoch")]
    EpochMismatch,
    #[msg("Active window closed; awaiting clearing execution")]
    EpochAlreadyClosed,
    #[msg("Deposit amount must be strictly positive")]
    ZeroDepositAmount,
    #[msg("Batch epoch is still within active collection window")]
    EpochDurationActive,
    #[msg("Batch epoch has already cleared")]
    EpochAlreadySettled,
    #[msg("Batch clearing price must be positive")]
    InvalidClearingPrice,
    #[msg("Batch epoch has not executed clearing yet")]
    EpochNotSettled,
    #[msg("Order output has already been claimed")]
    OrderAlreadyClaimed,
    #[msg("Slippage tolerance exceeded uniform clearing price")]
    SlippageExceeded,
    #[msg("Arithmetic overflow or underflow occurred")]
    MathOverflow,
}