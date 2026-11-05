#!/usr/bin/env bash
# Deploy polypus-pool to Solana devnet and run real-proof e2e. Needs ≥3 SOL on deployer key.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source scripts/env.sh

KP="${POLYPUS_DEVNET_KEYPAIR:-$HOME/.config/solana/polypus-devnet.json}"
RPC="${POLYPUS_RPC:-https://api.devnet.solana.com}"
PROGRAM_KP=programs/keys/polypus_pool-keypair.json
MIN_SOL=3

[ -f "$KP" ] || { echo "Missing deployer keypair: $KP"; exit 1; }
[ -f "$PROGRAM_KP" ] || { echo "Missing $PROGRAM_KP"; exit 1; }
[ -f artifacts/dev/kernel.vk ] || scripts/dev-setup.sh

bal=$(solana balance -k "$KP" --url "$RPC" | awk '{print $1}')
echo "Deployer $(solana address -k "$KP") balance: $bal SOL on devnet"
awk -v b="$bal" -v m="$MIN_SOL" 'BEGIN{ exit (b+0 >= m) ? 0 : 1 }' || {
  echo ""
  echo "BLOCKER: need ≥${MIN_SOL} SOL on devnet. Public RPC airdrop is closed; devnet-pow needs ~5000 lamports fee payer."
  echo "Fund $(solana address -k "$KP") via https://faucet.solana.com (GitHub login), then re-run."
  echo "See scripts/FUND_DEVNET.md"
  exit 2
}

(cd programs && anchor build >/dev/null 2>&1 || cargo build-sbf --manifest-path polypus-pool/Cargo.toml)
(cd programs && cargo build -q --release -p polypus-tests --bin devnet-e2e)

buf=$(mktemp)
solana program deploy -k "$KP" --url "$RPC" --buffer "$buf" --program-id "$PROGRAM_KP" programs/target/deploy/polypus_pool.so

mkdir -p deployments
POLYPUS_RPC="$RPC" POLYPUS_ALLOW_DEVNET=1 POLYPUS_DEVNET_KEYPAIR="$KP" \
  POLYPUS_DEPLOYMENT_OUT="$ROOT/deployments/devnet.json" \
  programs/target/release/devnet-e2e

echo "Devnet deployment written to deployments/devnet.json"
