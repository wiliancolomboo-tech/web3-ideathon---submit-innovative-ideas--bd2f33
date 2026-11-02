# Start a dedicated test validator
solana-test-validator --reset --quiet &

# Airdrop devnet SOL to CLI payer
solana airdrop 10 -u localhost

# Verify accounts via Solana CLI
solana program show Aegis11111111111111111111111111111111111111 -u localhost