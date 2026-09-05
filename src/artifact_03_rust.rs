use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use solana_program::hash::hash;

declare_id!("AeTH111111111111111111111111111111111111111");

pub const EPOCH_SLOT_DURATION: u64 = 20; // 20 slots ~ 8 seconds
pub const PROTOCOL_FEE_BPS: u64 = 15;    // 0.15% fee
pub const MAX_ORDERS_PER_BATCH: usize = 32;

#[program]
pub mod aetheris {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        min_deposit: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.base_mint = ctx.accounts.base_mint.key();
        pool.quote_mint = ctx.accounts.quote_mint.key();
        pool.vault_base = ctx.accounts.vault_base.key();
        pool.vault_quote = ctx.accounts.vault_quote.key();
        pool.current_epoch = 1;
        pool.min_deposit = min_deposit;
        pool.bump = ctx.bumps.pool;

        // Initialize first Epoch State
        let epoch = &mut ctx.accounts.epoch_state;
        epoch.epoch_id = 1;
        epoch.pool = pool.key();
        epoch.start_slot = Clock::get()?.slot;
        epoch.commit_end_slot = epoch.start_slot.checked_add(EPOCH_SLOT_DURATION).unwrap();
        epoch.reveal_end_slot = epoch.commit_end_slot.checked_add(EPOCH_SLOT_DURATION).unwrap();
        epoch.is_settled = false;
        epoch.clearing_price = 0;
        epoch.total_buy_volume = 0;
        epoch.total_sell_volume = 0;
        epoch.revealed_order_count = 0;
        epoch.bump = ctx.bumps.epoch_state;

        emit!(PoolInitialized {
            pool: pool.key(),
            base_mint: pool.base_mint,
            quote_mint: pool.quote_mint,
            epoch_id: 1,
        });

        Ok(())
    }

    pub fn commit_order(
        ctx: Context<CommitOrder>,
        commitment_hash: [u8; 32],
        escrow_amount: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let epoch = &ctx.accounts.epoch_state;
        let pool = &ctx.accounts.pool;

        require!(clock.slot < epoch.commit_end_slot, AetherisError::CommitPhaseClosed);
        require!(escrow_amount >= pool.min_deposit, AetherisError::DepositBelowMinimum);

        let commitment = &mut ctx.accounts.commitment_record;
        commitment.user = ctx.accounts.user.key();
        commitment.epoch = epoch.key();
        commitment.hash = commitment_hash;
        commitment.escrow_amount = escrow_amount;
        commitment.is_revealed = false;
        commitment.bump = ctx.bumps.commitment_record;

        // Escrow funds safely into the pool vault
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.deposit_mint.to_account_info(),
            to: ctx.accounts.pool_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token_interface::transfer_checked(cpi_ctx, escrow_amount, ctx.accounts.deposit_mint.decimals)?;

        emit!(OrderCommitted {
            user: ctx.accounts.user.key(),
            epoch_id: epoch.epoch_id,
            commitment_hash,
            escrow_amount,
        });

        Ok(())
    }

    pub fn reveal_order(
        ctx: Context<RevealOrder>,
        side: u8,         // 0: Buy (Quote -> Base), 1: Sell (Base -> Quote)
        limit_price: u64,  // Fixed-point scaled by 1e6
        amount: u64,      // Token amount
        salt: [u8; 16],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let epoch = &mut ctx.accounts.epoch_state;
        let commitment = &mut ctx.accounts.commitment_record;

        require!(clock.slot >= epoch.commit_end_slot, AetherisError::CommitPhaseStillActive);
        require!(clock.slot < epoch.reveal_end_slot, AetherisError::RevealPhaseClosed);
        require!(!commitment.is_revealed, AetherisError::OrderAlreadyRevealed);

        // Verify cryptographically: SHA256(user, side, limit_price, amount, salt) == commitment_hash
        let mut preimage = Vec::with_capacity(32 + 1 + 8 + 8 + 16);
        preimage.extend_from_slice(commitment.user.as_ref());
        preimage.push(side);
        preimage.extend_from_slice(&limit_price.to_le_bytes());
        preimage.extend_from_slice(&amount.to_le_bytes());
        preimage.extend_from_slice(&salt);

        let computed_hash = hash(&preimage).to_bytes();
        require!(computed_hash == commitment.hash, AetherisError::HashMismatch);
        require!(commitment.escrow_amount >= amount, AetherisError::InsufficientEscrow);

        commitment.is_revealed = true;
        commitment.side = side;
        commitment.limit_price = limit_price;
        commitment.amount = amount;

        // Populate the bounded order cache in epoch state
        let idx = epoch.revealed_order_count as usize;
        require!(idx < MAX_ORDERS_PER_BATCH, AetherisError::BatchCapacityExceeded);

        epoch.orders[idx] = OrderSummary {
            user: commitment.user,
            side,
            limit_price,
            amount,
            claimed: false,
        };
        epoch.revealed_order_count = epoch.revealed_order_count.checked_add(1).unwrap();

        if side == 0 {
            epoch.total_buy_volume = epoch.total_buy_volume.checked_add(amount).unwrap();
        } else {
            epoch.total_sell_volume = epoch.total_sell_volume.checked_add(amount).unwrap();
        }

        emit!(OrderRevealed {
            user: commitment.user,
            epoch_id: epoch.epoch_id,
            side,
            limit_price,
            amount,
        });

        Ok(())
    }

    pub fn settle_batch_auction(ctx: Context<SettleBatchAuction>) -> Result<()> {
        let clock = Clock::get()?;
        let epoch = &mut ctx.accounts.epoch_state;
        let pool = &mut ctx.accounts.pool;

        require!(clock.slot >= epoch.reveal_end_slot, AetherisError::RevealPhaseStillActive);
        require!(!epoch.is_settled, AetherisError::EpochAlreadySettled);

        let count = epoch.revealed_order_count as usize;
        require!(count > 0, AetherisError::EmptyBatch);

        // Uniform Clearing Price Computation:
        // Aggregate supply/demand curves from revealed orders
        let mut best_clearing_price: u64 = 0;
        let mut max_matched_volume: u64 = 0;

        // Iterate over candidate prices present in batch limit prices
        for i in 0..count {
            let candidate_price = epoch.orders[i].limit_price;
            let mut cumulative_bids: u64 = 0;
            let mut cumulative_asks: u64 = 0;

            for j in 0..count {
                let order = &epoch.orders[j];
                if order.side == 0 && order.limit_price >= candidate_price {
                    // Buy orders willing to pay >= candidate_price
                    cumulative_bids = cumulative_bids.checked_add(order.amount).unwrap();
                } else if order.side == 1 && order.limit_price <= candidate_price {
                    // Sell orders willing to sell <= candidate_price
                    cumulative_asks = cumulative_asks.checked_add(order.amount).unwrap();
                }
            }

            let executable_volume = std::cmp::min(cumulative_bids, cumulative_asks);
            if executable_volume > max_matched_volume {
                max_matched_volume = executable_volume;
                best_clearing_price = candidate_price;
            }
        }

        epoch.clearing_price = best_clearing_price;
        epoch.matched_volume = max_matched_volume;
        epoch.is_settled = true;

        // Crank incentive distribution (transfer fixed protocol rebate to keeper)
        let keeper_reward = max_matched_volume
            .checked_mul(PROTOCOL_FEE_BPS).unwrap()
            .checked_div(10_000).unwrap();

        pool.current_epoch = pool.current_epoch.checked_add(1).unwrap();

        emit!(BatchSettled {
            epoch_id: epoch.epoch_id,
            clearing_price: best_clearing_price,
            matched_volume: max_matched_volume,
            crank_keeper: ctx.accounts.crank_keeper.key(),
            keeper_reward,
        });

        Ok(())
    }

    pub fn claim_proceeds(ctx: Context<ClaimProceeds>, order_index: u8) -> Result<()> {
        let epoch = &mut ctx.accounts.epoch_state;
        let pool = &ctx.accounts.pool;
        let idx = order_index as usize;

        require!(epoch.is_settled, AetherisError::EpochNotSettled);
        require!(idx < epoch.revealed_order_count as usize, AetherisError::InvalidOrderIndex);

        let order = &mut epoch.orders[idx];
        require!(order.user == ctx.accounts.user.key(), AetherisError::UnauthorizedClaim);
        require!(!order.claimed, AetherisError::AlreadyClaimed);

        order.claimed = true;

        let clearing_price = epoch.clearing_price;
        let pool_bump = pool.bump;
        let seeds: &[&[u8]] = &[
            b"pool",
            pool.base_mint.as_ref(),
            pool.quote_mint.as_ref(),
            &[pool_bump],
        ];
        let signer = &[&seeds[..]];

        if order.side == 0 {
            // Buyer: Limit price must be >= clearing price to match
            if order.limit_price >= clearing_price && clearing_price > 0 {
                // Matched Buy: Pay quote, receive base
                // Amount of base received = (quote_amount * 1e6) / clearing_price
                let base_to_receive = (order.amount as u128)
                    .checked_mul(1_000_000).unwrap()
                    .checked_div(clearing_price as u128).unwrap() as u64;

                let cpi_accounts = TransferChecked {
                    from: ctx.accounts.vault_base.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.user_base_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                };
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer),
                    base_to_receive,
                    ctx.accounts.base_mint.decimals,
                )?;
            } else {
                // Refund unexecuted quote tokens in full
                let cpi_accounts = TransferChecked {
                    from: ctx.accounts.vault_quote.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.user_quote_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                };
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer),
                    order.amount,
                    ctx.accounts.quote_mint.decimals,
                )?;
            }
        } else {
            // Seller: Limit price must be <= clearing price to match
            if order.limit_price <= clearing_price && clearing_price > 0 {
                // Matched Sell: Pay base, receive quote
                // Amount of quote received = (base_amount * clearing_price) / 1e6
                let quote_to_receive = (order.amount as u128)
                    .checked_mul(clearing_price as u128).unwrap()
                    .checked_div(1_000_000).unwrap() as u64;

                let cpi_accounts = TransferChecked {
                    from: ctx.accounts.vault_quote.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.user_quote_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                };
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer),
                    quote_to_receive,
                    ctx.accounts.quote_mint.decimals,
                )?;
            } else {
                // Refund unexecuted base tokens in full
                let cpi_accounts = TransferChecked {
                    from: ctx.accounts.vault_base.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.user_base_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                };
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer),
                    order.amount,
                    ctx.accounts.base_mint.decimals,
                )?;
            }
        }

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub mod initialize_pool_context {
    use super::*;

    #[derive(Accounts)]
    pub struct InitializePool<'info> {
        #[account(mut)]
        pub authority: Signer<'info>,

        pub base_mint: InterfaceAccount<'info, Mint>,
        pub quote_mint: InterfaceAccount<'info, Mint>,

        #[account(
            init,
            payer = authority,
            space = 8 + AuctionPool::LEN,
            seeds = [b"pool", base_mint.key().as_ref(), quote_mint.key().as_ref()],
            bump
        )]
        pub pool: Box<Account<'info, AuctionPool>>,

        #[account(
            init,
            payer = authority,
            space = 8 + EpochState::LEN,
            seeds = [b"epoch", pool.key().as_ref(), &1u64.to_le_bytes()],
            bump
        )]
        pub epoch_state: Box<Account<'info, EpochState>>,

        #[account(
            init,
            payer = authority,
            token::mint = base_mint,
            token::authority = pool,
            seeds = [b"vault_base", pool.key().as_ref()],
            bump
        )]
        pub vault_base: InterfaceAccount<'info, TokenAccount>,

        #[account(
            init,
            payer = authority,
            token::mint = quote_mint,
            token::authority = pool,
            seeds = [b"vault_quote", pool.key().as_ref()],
            bump
        )]
        pub vault_quote: InterfaceAccount<'info, TokenAccount>,

        pub system_program: Program<'info, System>,
        pub token_program: Interface<'info, TokenInterface>,
        pub rent: Sysvar<'info, Rent>,
    }
}
pub use initialize_pool_context::*;

#[derive(Accounts)]
pub struct CommitOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"pool", pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, AuctionPool>>,

    #[account(
        mut,
        seeds = [b"epoch", pool.key().as_ref(), &epoch_state.epoch_id.to_le_bytes()],
        bump = epoch_state.bump
    )]
    pub epoch_state: Box<Account<'info, EpochState>>,

    #[account(
        init,
        payer = user,
        space = 8 + OrderCommitment::LEN,
        seeds = [b"commit", epoch_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub commitment_record: Box<Account<'info, OrderCommitment>>,

    #[account(mut)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    pub deposit_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub pool_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealOrder<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"epoch", epoch_state.pool.as_ref(), &epoch_state.epoch_id.to_le_bytes()],
        bump = epoch_state.bump
    )]
    pub epoch_state: Box<Account<'info, EpochState>>,

    #[account(
        mut,
        seeds = [b"commit", epoch_state.key().as_ref(), user.key().as_ref()],
        bump = commitment_record.bump,
        has_one = user
    )]
    pub commitment_record: Box<Account<'info, OrderCommitment>>,
}

#[derive(Accounts)]
pub struct SettleBatchAuction<'info> {
    #[account(mut)]
    pub crank_keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, AuctionPool>>,

    #[account(
        mut,
        seeds = [b"epoch", pool.key().as_ref(), &epoch_state.epoch_id.to_le_bytes()],
        bump = epoch_state.bump
    )]
    pub epoch_state: Box<Account<'info, EpochState>>,
}

#[derive(Accounts)]
pub struct ClaimProceeds<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"pool", pool.base_mint.as_ref(), pool.quote_mint.as_ref()],
        bump = pool.bump
    )]
    pub pool: Box<Account<'info, AuctionPool>>,

    #[account(
        mut,
        seeds = [b"epoch", pool.key().as_ref(), &epoch_state.epoch_id.to_le_bytes()],
        bump = epoch_state.bump
    )]
    pub epoch_state: Box<Account<'info, EpochState>>,

    #[account(
        mut,
        seeds = [b"vault_base", pool.key().as_ref()],
        bump
    )]
    pub vault_base: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault_quote", pool.key().as_ref()],
        bump
    )]
    pub vault_quote: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user_base_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_quote_account: InterfaceAccount<'info, TokenAccount>,

    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTURES
// -----------------------------------------------------------------------------

#[account]
pub struct AuctionPool {
    pub authority: Pubkey,     // 32
    pub base_mint: Pubkey,     // 32
    pub quote_mint: Pubkey,    // 32
    pub vault_base: Pubkey,    // 32
    pub vault_quote: Pubkey,   // 32
    pub current_epoch: u64,    // 8
    pub min_deposit: u64,      // 8
    pub bump: u8,              // 1
}

impl AuctionPool {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 32 + 8 + 8 + 1;
}

#[account]
pub struct OrderCommitment {
    pub user: Pubkey,          // 32
    pub epoch: Pubkey,         // 32
    pub hash: [u8; 32],        // 32
    pub escrow_amount: u64,    // 8
    pub side: u8,              // 1
    pub limit_price: u64,      // 8
    pub amount: u64,           // 8
    pub is_revealed: bool,     // 1
    pub bump: u8,              // 1
}

impl OrderCommitment {
    pub const LEN: usize = 32 + 32 + 32 + 8 + 1 + 8 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct OrderSummary {
    pub user: Pubkey,          // 32
    pub side: u8,              // 1
    pub limit_price: u64,      // 8
    pub amount: u64,           // 8
    pub claimed: bool,         // 1
}

#[account]
pub struct EpochState {
    pub epoch_id: u64,                             // 8
    pub pool: Pubkey,                              // 32
    pub start_slot: u64,                           // 8
    pub commit_end_slot: u64,                      // 8
    pub reveal_end_slot: u64,                      // 8
    pub is_settled: bool,                          // 1
    pub clearing_price: u64,                       // 8
    pub matched_volume: u64,                       // 8
    pub total_buy_volume: u64,                     // 8
    pub total_sell_volume: u64,                    // 8
    pub revealed_order_count: u16,                 // 2
    pub orders: [OrderSummary; MAX_ORDERS_PER_BATCH], // 50 * 32 = 1600
    pub bump: u8,                                  // 1
}

impl EpochState {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + 8 + 2 + (MAX_ORDERS_PER_BATCH * 50) + 1;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub epoch_id: u64,
}

#[event]
pub struct OrderCommitted {
    pub user: Pubkey,
    pub epoch_id: u64,
    pub commitment_hash: [u8; 32],
    pub escrow_amount: u64,
}

#[event]
pub struct OrderRevealed {
    pub user: Pubkey,
    pub epoch_id: u64,
    pub side: u8,
    pub limit_price: u64,
    pub amount: u64,
}

#[event]
pub struct BatchSettled {
    pub epoch_id: u64,
    pub clearing_price: u64,
    pub matched_volume: u64,
    pub crank_keeper: Pubkey,
    pub keeper_reward: u64,
}

#[error_code]
pub enum AetherisError {
    #[msg("Commitment window for this epoch is closed.")]
    CommitPhaseClosed,
    #[msg("Commitment window is still active; reveals forbidden.")]
    CommitPhaseStillActive,
    #[msg("Reveal phase has concluded.")]
    RevealPhaseClosed,
    #[msg("Reveal phase is still active; auction cannot settle.")]
    RevealPhaseStillActive,
    #[msg("Order already revealed.")]
    OrderAlreadyRevealed,
    #[msg("Order revealed preimage failed SHA256 integrity check.")]
    HashMismatch,
    #[msg("Escrow deposited does not cover order execution limits.")]
    InsufficientEscrow,
    #[msg("Epoch batch capacity exceeded.")]
    BatchCapacityExceeded,
    #[msg("Batch has no revealed orders to settle.")]
    EmptyBatch,
    #[msg("Epoch is already marked settled.")]
    EpochAlreadySettled,
    #[msg("Epoch is not yet settled.")]
    EpochNotSettled,
    #[msg("Invalid order index provided for claim.")]
    InvalidOrderIndex,
    #[msg("Unauthorized claim: caller is not order owner.")]
    UnauthorizedClaim,
    #[msg("Order proceeds have already been claimed.")]
    AlreadyClaimed,
    #[msg("Escrow amount below minimum threshold.")]
    DepositBelowMinimum,
}