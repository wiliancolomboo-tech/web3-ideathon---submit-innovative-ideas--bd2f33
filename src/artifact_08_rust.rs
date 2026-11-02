use anchor_lang::prelude::*;

#[error_code]
pub enum AetherisError {
    #[msg("Arithmetic overflow or underflow detected")]
    MathOverflow,

    #[msg("Clearing price cannot be zero")]
    ZeroClearingPrice,

    #[msg("Order side is invalid (Must be 0 for Buy, 1 for Sell)")]
    InvalidOrderSide,

    #[msg("Batch buffer is at maximum capacity (32 orders)")]
    BatchBufferFull,

    #[msg("Batch for target slot has already been cleared")]
    BatchAlreadyCleared,

    #[msg("Cannot deposit to past or already executed slots")]
    SlotAlreadyClosed,

    #[msg("Order does not satisfy the market minimum quote size")]
    OrderTooSmall,

    #[msg("Limit price was violated during settlement")]
    LimitPriceViolated,

    #[msg("Conservation of value invariant was violated")]
    ConservationOfValueViolated,

    #[msg("Order has expired relative to current slot")]
    OrderExpired,

    #[msg("Market is currently frozen by administrator")]
    MarketFrozen,

    #[msg("Unauthorized solver submission")]
    UnauthorizedSolver,

    #[msg("Supplied remaining accounts count does not match order batch length")]
    InvalidRemainingAccountsLength,
}