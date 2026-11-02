# Build binary artifacts and export IDL
anchor build

# Confirm Program ID matches declare_id
solana address -k target/deploy/chronobatch-keypair.json