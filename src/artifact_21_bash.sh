solana config set --url https://api.devnet.solana.com
solana airdrop 2

# Sync program keys
anchor keys sync

# Build with updated keys and deploy
anchor build
anchor deploy --provider.cluster devnet