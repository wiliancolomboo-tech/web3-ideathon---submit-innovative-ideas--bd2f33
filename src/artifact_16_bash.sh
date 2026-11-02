# 1. Install Rust and Solana CLI
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
sh -c "$(curl -sSfL https://release.solana.com/v1.18.26/install)"

# 2. Install Anchor Framework (v0.30.1)
cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked

# 3. Verify toolchain versions
solana --version    # Must be >= 1.18.26
anchor --version    # Must be 0.30.1
node -v             # Must be >= v18.16.0