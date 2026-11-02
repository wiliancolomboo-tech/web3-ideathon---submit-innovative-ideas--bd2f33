# Start local test validator in a dedicated terminal
solana-test-validator --reset

# Deploy binary directly to localnet
solana program deploy \
  --program-id target/deploy/aurastream-keypair.json \
  target/deploy/aurastream.so