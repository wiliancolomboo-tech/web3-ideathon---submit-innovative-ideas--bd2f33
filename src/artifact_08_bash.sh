# Terminal 1: Start test validator
solana-test-validator --reset

# Terminal 2: Deploy program
solana program deploy \
    --program-id target/deploy/chronobatch-keypair.json \
    target/deploy/chronobatch.so

# Log streaming for program diagnostics
solana logs ChronoBatch11111111111111111111111111111111