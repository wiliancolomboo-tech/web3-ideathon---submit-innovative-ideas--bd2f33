use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("AethER1111111111111111111111111111111111111");

#[program]
pub mod aetherflow {
    use super::*;

    /// Initializes global protocol configuration.
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_basis_points: u16,
        user_surplus_share_bps: u16,
    ) -> Result<()> {
        require!(
            user_surplus_share_bps <= 10_000,
            AetherError::InvalidSurplusShare
        );
        require!(fee_basis_points <= 1_000, AetherError::FeeTooHigh);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = ctx.accounts.treasury.key();
        config.protocol_fee_bps = fee_basis_points;
        config.user_surplus_share_bps = user_surplus_share_bps;
        config.bump = ctx.bumps.config;
        config.paused = false;

        emit!(ConfigInitializedEvent {
            authority: config.authority,
            treasury: config.treasury,
            user_surplus_share_bps,
        });

        Ok(())
    }

    /// Registers a solver with minimum bond requirements.
    pub fn register_solver(ctx: Context<RegisterSolver>, bond_amount: u64) -> Result<()> {
        require!(bond_amount >= 1_000_000_000, AetherError::InsufficientBond); // 1 SOL min

        let solver_account = &mut ctx.accounts.solver_record;
        solver_account.solver = ctx.accounts.solver.key();
        solver_account.bonded_amount = bond_amount;
        solver_account.is_active = true;
        solver_account.bump = ctx.bumps.solver_record;

        // Escrow solver bond
        anchor_lang::solana_program::program::invoke(
            &anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.solver.key(),
                &solver_account.key(),
                bond_amount,
            ),
            &[
                ctx.accounts.solver.to_account_info(),
                solver_account.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        Ok(())
    }

    /// Trader commits a swap intent and locks input tokens into the escrow vault PDA.
    pub fn create_intent(
        ctx: Context<CreateIntent>,
        nonce: u64,
        amount_in: u64,
        min_amount_out: u64,
        expiry_slot: u64,
    ) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        require!(expiry_slot > current_slot, AetherError::InvalidExpiry);
        require!(amount_in > 0, AetherError::ZeroDeposit);
        require!(min_amount_out > 0, AetherError::ZeroMinOut);

        let intent = &mut ctx.accounts.intent;
        intent.maker = ctx.accounts.maker.key();
        intent.input_mint = ctx.accounts.input_mint.key();
        intent.output_mint = ctx.accounts.output_mint.key();
        intent.amount_in = amount_in;
        intent.min_amount_out = min_amount_out;
        intent.expiry_slot = expiry_slot;
        intent.nonce = nonce;
        intent.status = IntentStatus::Active;
        intent.bump = ctx.bumps.intent;
        intent.vault_bump = ctx.bumps.escrow_vault;

        // Transfer tokens from User ATA to Program Escrow Vault PDA
        let cpi_accounts = Transfer {
            from: ctx.accounts.maker_input_ata.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.maker.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount_in)?;

        emit!(IntentCreatedEvent {
            intent: intent.key(),
            maker: intent.maker,
            input_mint: intent.input_mint,
            output_mint: intent.output_mint,
            amount_in,
            min_amount_out,
            expiry_slot,
        });

        Ok(())
    }

    /// Solver fills the intent, satisfying the minimum output constraint + distributing surplus.
    pub fn execute_intent(
        ctx: Context<ExecuteIntent>,
        amount_out_provided: u64,
    ) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let intent = &mut ctx.accounts.intent;

        require!(intent.status == IntentStatus::Active, AetherError::IntentNotActive);
        require!(current_slot <= intent.expiry_slot, AetherError::IntentExpired);
        require!(
            amount_out_provided >= intent.min_amount_out,
            AetherError::SlippageExceeded
        );

        let surplus = amount_out_provided.saturating_sub(intent.min_amount_out);
        let user_share_bps = ctx.accounts.config.user_surplus_share_bps as u64;
        
        // Mathematical Surplus Partitioning:
        // Surplus User Rebate = 80%, Protocol Treasury = 5%, Solver retains = 15%
        let user_rebate = (surplus as u128 * user_share_bps as u128 / 10_000u128) as u64;
        let protocol_cut = (surplus as u128 * 500u128 / 10_000u128) as u64;
        let total_user_receive = intent.min_amount_out.checked_add(user_rebate).ok_or(AetherError::MathOverflow)?;

        // 1. Solver transfers output tokens to Maker ATA
        let solver_to_user_cpi = Transfer {
            from: ctx.accounts.solver_output_ata.to_account_info(),
            to: ctx.accounts.maker_output_ata.to_account_info(),
            authority: ctx.accounts.solver.to_account_info(),
        };
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), solver_to_user_cpi),
            total_user_receive,
        )?;

        // 2. Solver transfers protocol surplus share to treasury (if any)
        if protocol_cut > 0 {
            let solver_to_treasury = Transfer {
                from: ctx.accounts.solver_output_ata.to_account_info(),
                to: ctx.accounts.treasury_output_ata.to_account_info(),
                authority: ctx.accounts.solver.to_account_info(),
            };
            token::transfer(
                CpiContext::new(ctx.accounts.token_program.to_account_info(), solver_to_treasury),
                protocol_cut,
            )?;
        }

        // 3. Vault releases input tokens to Solver ATA via PDA Signer Seeds
        let maker_key = intent.maker;
        let nonce_bytes = intent.nonce.to_le_bytes();
        let seeds: &[&[u8]] = &[
            b"vault",
            intent.to_account_info().key.as_ref(),
            &[intent.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let vault_to_solver_cpi = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.solver_input_ata.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                vault_to_solver_cpi,
                signer_seeds,
            ),
            intent.amount_in,
        )?;

        // Update state to prevent reentrancy / double settlement
        intent.status = IntentStatus::Filled;

        emit!(IntentFilledEvent {
            intent: intent.key(),
            solver: ctx.accounts.solver.key(),
            amount_in_cleared: intent.amount_in,
            amount_out_delivered: total_user_receive,
            surplus_rebated: user_rebate,
        });

        Ok(())
    }

    /// User cancels an expired or unfulfilled intent, reclaiming 100% of escrowed funds.
    pub fn cancel_intent(ctx: Context<CancelIntent>) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let intent = &mut ctx.accounts.intent;

        require!(intent.status == IntentStatus::Active, AetherError::IntentNotActive);
        require!(
            current_slot > intent.expiry_slot || ctx.accounts.maker.key() == intent.maker,
            AetherError::IntentNotExpired
        );

        let intent_key = intent.key();
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            intent_key.as_ref(),
            &[intent.vault_bump],
        ];
        let signer_seeds = &[&vault_seeds[..]];

        let refund_cpi = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.maker_input_ata.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                refund_cpi,
                signer_seeds,
            ),
            intent.amount_in,
        )?;

        intent.status = IntentStatus::Cancelled;

        emit!(IntentCancelledEvent {
            intent: intent.key(),
            maker: intent.maker,
            refunded_amount: intent.amount_in,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------------
// Account Structures & Contexts
// ---------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Protocol Treasury payout account verified in instruction
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterSolver<'info> {
    #[account(
        init,
        payer = solver,
        space = 8 + SolverRecord::INIT_SPACE,
        seeds = [b"solver", solver.key().as_ref()],
        bump
    )]
    pub solver_record: Account<'info, SolverRecord>,
    #[account(mut)]
    pub solver: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateIntent<'info> {
    #[account(
        init,
        payer = maker,
        space = 8 + IntentAccount::INIT_SPACE,
        seeds = [b"intent", maker.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub intent: Account<'info, IntentAccount>,

    #[account(mut)]
    pub maker: Signer<'info>,

    pub input_mint: Account<'info, Mint>,
    pub output_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = maker_input_ata.owner == maker.key(),
        constraint = maker_input_ata.mint == input_mint.key()
    )]
    pub maker_input_ata: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = maker,
        seeds = [b"vault", intent.key().as_ref()],
        bump,
        token::mint = input_mint,
        token::authority = escrow_vault
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ExecuteIntent<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"intent", intent.maker.as_ref(), intent.nonce.to_le_bytes().as_ref()],
        bump = intent.bump
    )]
    pub intent: Account<'info, IntentAccount>,

    #[account(
        seeds = [b"solver", solver.key().as_ref()],
        bump = solver_record.bump,
        constraint = solver_record.is_active @ AetherError::SolverNotActive
    )]
    pub solver_record: Account<'info, SolverRecord>,

    #[account(mut)]
    pub solver: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", intent.key().as_ref()],
        bump = intent.vault_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = solver_input_ata.owner == solver.key(),
        constraint = solver_input_ata.mint == intent.input_mint
    )]
    pub solver_input_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = solver_output_ata.owner == solver.key(),
        constraint = solver_output_ata.mint == intent.output_mint
    )]
    pub solver_output_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = maker_output_ata.owner == intent.maker,
        constraint = maker_output_ata.mint == intent.output_mint
    )]
    pub maker_output_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_output_ata.owner == config.treasury,
        constraint = treasury_output_ata.mint == intent.output_mint
    )]
    pub treasury_output_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelIntent<'info> {
    #[account(
        mut,
        seeds = [b"intent", intent.maker.as_ref(), intent.nonce.to_le_bytes().as_ref()],
        bump = intent.bump
    )]
    pub intent: Account<'info, IntentAccount>,

    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", intent.key().as_ref()],
        bump = intent.vault_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = maker_input_ata.owner == maker.key(),
        constraint = maker_input_ata.mint == intent.input_mint
    )]
    pub maker_input_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------------
// State Accounts & Enums
// ---------------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub protocol_fee_bps: u16,
    pub user_surplus_share_bps: u16,
    pub bump: u8,
    pub paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct SolverRecord {
    pub solver: Pubkey,
    pub bonded_amount: u64,
    pub is_active: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct IntentAccount {
    pub maker: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount_in: u64,
    pub min_amount_out: u64,
    pub expiry_slot: u64,
    pub nonce: u64,
    pub status: IntentStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum IntentStatus {
    Active,
    Filled,
    Cancelled,
}

// ---------------------------------------------------------------------------------
// Events & Errors
// ---------------------------------------------------------------------------------

#[event]
pub struct ConfigInitializedEvent {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub user_surplus_share_bps: u16,
}

#[event]
pub struct IntentCreatedEvent {
    pub intent: Pubkey,
    pub maker: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount_in: u64,
    pub min_amount_out: u64,
    pub expiry_slot: u64,
}

#[event]
pub struct IntentFilledEvent {
    pub intent: Pubkey,
    pub solver: Pubkey,
    pub amount_in_cleared: u64,
    pub amount_out_delivered: u64,
    pub surplus_rebated: u64,
}

#[event]
pub struct IntentCancelledEvent {
    pub intent: Pubkey,
    pub maker: Pubkey,
    pub refunded_amount: u64,
}

#[error_code]
pub enum AetherError {
    #[msg("Surplus share basis points must be <= 10000")]
    InvalidSurplusShare,
    #[msg("Protocol fee must be <= 1000 bps (10%)")]
    FeeTooHigh,
    #[msg("Insufficient solver stake bond (min 1 SOL)")]
    InsufficientBond,
    #[msg("Intent expiry slot must be strictly in the future")]
    InvalidExpiry,
    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,
    #[msg("Minimum output amount must be greater than zero")]
    ZeroMinOut,
    #[msg("Intent is not in Active state")]
    IntentNotActive,
    #[msg("Intent has already expired")]
    IntentExpired,
    #[msg("Intent has not yet expired for non-maker cancel")]
    IntentNotExpired,
    #[msg("Executed output amount does not meet minimum expectation")]
    SlippageExceeded,
    #[msg("Solver is not active or bonded")]
    SolverNotActive,
    #[msg("Mathematical overflow in surplus distribution")]
    MathOverflow,
}