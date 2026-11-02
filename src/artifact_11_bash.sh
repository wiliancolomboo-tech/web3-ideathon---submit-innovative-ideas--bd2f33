# Set network to Devnet
solana config set --url https://api.devnet.solana.com

# Fund deployer authority (requires ~5 SOL)
solana airdrop 2

# Deploy the binary
anchor deploy --provider.cluster devnet

# Verify deployment
solana program show Chrono1111111111111111111111111111111111111