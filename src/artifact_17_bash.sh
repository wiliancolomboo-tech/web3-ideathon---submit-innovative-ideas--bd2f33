# Clone and enter workspace
git clone https://github.com/aetheris-protocol/aetheris
cd aetheris

# Install Node dependencies
yarn install

# Synchronize program keypair with Anchor.toml
anchor keys sync

# Compile the zero-warning BPF bytecode
anchor build