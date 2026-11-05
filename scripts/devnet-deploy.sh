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
(cd programs && cargo build -q --release -p polypus-tests --bin devnet-e2e --bin keys-agent-settle)

SOZ=$(stat -c%s programs/target/deploy/polypus_pool.so)
MAX_LEN=$((SOZ + 65536))
echo "Program size ${SOZ} B; deploy --max-len ${MAX_LEN} (rent ~$(solana rent "$MAX_LEN" --url "$RPC" | awk '{print $4}') SOL)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
solana-keygen new --no-bip39-passphrase --silent -o "$work/buffer.json"
deploy_out=$(solana program deploy -k "$KP" --url "$RPC" --max-len "$MAX_LEN" \
  --buffer "$work/buffer.json" --program-id "$PROGRAM_KP" programs/target/deploy/polypus_pool.so 2>&1 | tee /dev/stderr)
deploy_sig=$(echo "$deploy_out" | awk '/^Signature: / {print $2}')
mkdir -p deployments
POLYPUS_RPC="$RPC" POLYPUS_ALLOW_DEVNET=1 POLYPUS_DEVNET_KEYPAIR="$KP" \
  POLYPUS_DEPLOYMENT_OUT="$ROOT/deployments/devnet.json" \
  programs/target/release/devnet-e2e

if [ -n "$deploy_sig" ] && command -v jq >/dev/null 2>&1; then
  tmp=$(mktemp)
  jq --arg s "$deploy_sig" \
    '.program_deploy_sig = $s | .signatures = ([{"label":"program_deploy","sig":$s}] + (.signatures // []))' \
    deployments/devnet.json > "$tmp" && mv "$tmp" deployments/devnet.json
fi
mkdir -p apps/keys/public/deployments
cp deployments/devnet.json apps/keys/public/deployments/devnet.json
echo "Devnet deployment written to deployments/devnet.json (+ apps/keys/public/deployments/)"
