# Set Solana configuration to Devnet
solana config set --url https://api.devnet.solana.com

# Ensure deployer wallet has sufficient Devnet SOL
solana airdrop 2

# Deploy the compiled program binary
anchor deploy --provider.cluster devnet

# Verify deployment
solana program show <PROGRAM_ID>