# Source me: `source scripts/env.sh` — puts the pinned toolchain on PATH.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.nargo/bin:$HOME/.local/go/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-6}"
