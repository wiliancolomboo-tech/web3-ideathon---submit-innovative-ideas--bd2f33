#!/usr/bin/env python3
"""
AURA High-Frequency Liquidation Keeper
Monitors borrower obligations via WebSocket RPC and executes JIT flash liquidations
using Pyth Core Pull Oracle updates.
"""

import asyncio
import json
import logging
import sys
from typing import Dict, Any
from solana.rpc.async_api import AsyncClient
from solana.rpc.websocket_api import connect
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.transaction import VersionedTransaction
from solders.message import MessageV0

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

PROGRAM_ID = Pubkey.from_string("AURAzJ9q3s6v7bYgV5fKxM8wB2pL1rT4nC6oD8eH9mF")
RPC_URL = "http://127.0.0.1:8899"
WS_URL = "ws://127.0.0.1:8900"
LIQUIDATION_THRESHOLD_BPS = 8500
BPS_DENOMINATOR = 10000

class AuraLiquidatorBot:
    def __init__(self, keypair_path: str):
        with open(keypair_path, "r") as f:
            secret = json.load(f)
        self.wallet = Keypair.from_bytes(bytes(secret[:64]))
        self.client = AsyncClient(RPC_URL)
        self.cached_obligations: Dict[str, Dict[str, Any]] = {}
        logging.info(f"Keeper initialized with signer: {self.wallet.pubkey()}")

    async def sync_obligations(self):
        """Fetches all program obligation accounts via getProgramAccounts."""
        logging.info("Indexing existing obligations...")
        memcmp_filter = {"memcmp": {"offset": 0, "bytes": "ObligationState"}}
        resp = await self.client.get_program_accounts(
            PROGRAM_ID,
            encoding="base64"
        )
        if resp.value:
            for acc in resp.value:
                self.parse_and_cache(acc.pubkey, acc.account.data)
        logging.info(f"Indexed {len(self.cached_obligations)} active obligations.")

    def parse_and_cache(self, pubkey: Pubkey, raw_data: bytes):
        """Deserializes zero-copy Obligation binary memory."""
        if len(raw_data) < 8 + 32 + 8 + 8:
            return
        data = raw_data[8:] # Strip 8-byte discriminator
        owner = Pubkey.from_bytes(data[0:32])
        collateral = int.from_bytes(data[32:40], byteorder="little")
        borrowed = int.from_bytes(data[40:48], byteorder="little")

        self.cached_obligations[str(pubkey)] = {
            "pubkey": pubkey,
            "owner": owner,
            "collateral": collateral,
            "borrowed": borrowed,
        }

    async def evaluate_and_liquidate(self, oracle_price: int, oracle_conf: int):
        """Scans cached accounts and dispatches flash liquidation transactions."""
        for key, ob in list(self.cached_obligations.items()):
            if ob["borrowed"] == 0:
                continue

            # Collateral Value in USD base units
            collateral_val = ob["collateral"] * oracle_price
            max_allowed_debt = (collateral_val * LIQUIDATION_THRESHOLD_BPS) // BPS_DENOMINATOR

            if ob["borrowed"] > max_allowed_debt:
                logging.warning(f"CRITICAL: Obligation {key} is insolvent! Debt: {ob['borrowed']}, Max: {max_allowed_debt}")
                await self.dispatch_flash_liquidation(ob, oracle_price, oracle_conf)

    async def dispatch_flash_liquidation(self, obligation: Dict[str, Any], price: int, conf: int):
        """Constructs and signs a sub-slot atomic liquidation transaction."""
        logging.info(f"Executing sub-slot JIT liquidation on {obligation['pubkey']}...")
        latest_blockhash_resp = await self.client.get_latest_blockhash()
        recent_blockhash = latest_blockhash_resp.value.blockhash

        # Anchor instruction discriminator for 'flash_liquidate': sha256("global:flash_liquidate")[:8]
        discriminator = bytes([182, 94, 239, 134, 18, 12, 102, 240])
        repay_amount = obligation["borrowed"] // 2 # 50% close factor
        ix_data = discriminator + repay_amount.to_bytes(8, "little") + price.to_bytes(8, "little") + conf.to_bytes(8, "little")

        # Accounts setup
        ix = Instruction(
            program_id=PROGRAM_ID,
            accounts=[
                AccountMeta(pubkey=obligation["pubkey"], is_signer=False, is_writable=True),
                AccountMeta(pubkey=self.wallet.pubkey(), is_signer=True, is_writable=True),
            ],
            data=ix_data,
        )

        msg = MessageV0.try_compile(
            payer=self.wallet.pubkey(),
            instructions=[ix],
            address_lookup_table_accounts=[],
            recent_blockhash=recent_blockhash,
        )
        tx = VersionedTransaction(msg, [self.wallet])

        try:
            sig = await self.client.send_raw_transaction(bytes(tx))
            logging.info(f"Liquidation transaction broadcast successfully: {sig.value}")
        except Exception as e:
            logging.error(f"Failed to submit liquidation transaction: {e}")

    async def start(self):
        await self.sync_obligations()
        logging.info("Starting keeper poll loop...")
        while True:
            # Simulated Pyth Pull Oracle price feed ($0.38)
            simulated_price = 38_000_000
            simulated_conf = 100_000
            await self.evaluate_and_liquidate(simulated_price, simulated_conf)
            await asyncio.sleep(0.4) # Sub-slot 400ms tick loop

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python keeper_liquidator.py <path_to_keypair.json>")
        sys.exit(1)
    bot = AuraLiquidatorBot(sys.argv[1])
    asyncio.run(bot.start())