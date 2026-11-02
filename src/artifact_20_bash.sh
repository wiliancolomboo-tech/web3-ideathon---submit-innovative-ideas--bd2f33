# Configure Solana CLI for Devnet
solana config set --url https://api.devnet.solana.com

# Fund deployer account
solana airdrop 2

# Deploy BPF program to Devnet
anchor deploy --provider.cluster devnet

# Verify deployment
solana program show <PROGRAM_ID>