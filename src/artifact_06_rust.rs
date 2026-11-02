use anchor_lang::prelude::*;

pub const MAX_ORDERS_PER_BATCH: usize = 32;
pub const PRICE_PRECISION: u128 = 1_000_000_000; // 1e9 Fixed-Point Math

#[account]
#[derive(Default)]
pub struct MarketConfig {
    pub admin: Pubkey,
    pub market_index: u64,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub min_order_quote_size: u64,
    pub bump: u8,
    pub is_frozen: bool,
}

impl MarketConfig {
    pub const LEN: usize = 8 + 32 + 8 + 32 + 32 + 32 + 32 + 1 + 1 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum OrderSide {
    Buy = 0,
    Sell = 1,
}

#[zero_copy]
#[derive(Default, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct PackedOrder {
    pub user: Pubkey,          // 32 bytes
    pub amount_in: u64,         // 8 bytes
    pub limit_price: u64,       // 8 bytes (1e9 precision)
    pub expiry_slot: u64,       // 8 bytes
    pub filled_out_amount: u64, // 8 bytes
    pub side: u8,               // 1 byte (0 = Buy, 1 = Sell)
    pub is_settled: u8,         // 1 byte
    pub _padding: [u8; 6],      // 6 bytes aligned to 8-byte boundary
}

#[account(zero_copy)]
#[repr(C)]
pub struct SlotBatchBuffer {
    pub market: Pubkey,                     // 32 bytes
    pub slot_number: u64,                   // 8 bytes
    pub order_count: u32,                   // 4 bytes
    pub is_cleared: u8,                     // 1 byte
    pub _padding: [u8; 3],                  // 3 bytes
    pub total_buy_quote: u64,               // 8 bytes
    pub total_sell_base: u64,               // 8 bytes
    pub orders: [PackedOrder; MAX_ORDERS_PER_BATCH], // 64 * 32 = 2048 bytes
}

impl SlotBatchBuffer {
    pub const LEN: usize = 8 + 32 + 8 + 4 + 1 + 3 + 8 + 8 + (64 * MAX_ORDERS_PER_BATCH);
}