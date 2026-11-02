# 1. Switch CLI target to devnet
solana config set --url https://api.devnet.solana.com

# 2. Airdrop SOL to deployment account
solana airdrop 3

# 3. Deploy the compiled binary
anchor deploy --provider.cluster devnet

# 4. Initialize the Protocol State via Anchor CLI
anchor run initialize-devnet