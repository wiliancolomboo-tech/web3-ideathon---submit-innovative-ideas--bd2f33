# Generate program ID keypair if not already created
solana-keygen new -o target/deploy/khora-keypair.json --no-bip39-passphrase --force

# Sync program ID across lib.rs and Anchor.toml
anchor keys sync

# Build and deploy to Devnet
anchor build
anchor deploy --provider.cluster devnet