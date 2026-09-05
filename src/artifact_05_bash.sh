# 1. Clone repository and install dependencies
git clone https://github.com/aetheris-protocol/aetheris-core.git
cd aetheris-core
yarn install

# 2. Configure Solana to Localnet
solana config set --url localhost

# 3. Build the Anchor Program and Generate IDLs
anchor build

# 4. Synchronize Program ID
# Copy the compiled program key into declare_id! inside programs/aetheris/src/lib.rs
solana address -k target/deploy/aetheris-keypair.json
anchor keys sync

# 5. Run the Local Validator and Execute the E2E Test Suite
anchor test