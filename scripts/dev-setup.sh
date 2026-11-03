#!/usr/bin/env bash
# ┌──────────────────────────────────────────────────────────────────────────┐
# │ INSECURE DEVELOPMENT SETUP — NOT FOR PRODUCTION, NOT FOR REAL FUNDS.      │
# │ `sunspot setup` is a single-party Groth16 setup: whoever ran it could keep │
# │ the toxic waste and forge proofs. Mainnet requires a public MPC ceremony  │
# │ (design doc §4.3).                                                        │
# └──────────────────────────────────────────────────────────────────────────┘
# Compiles circuits/kernel, runs the Sunspot ACIR→gnark translation and a dev
# setup, and writes artifacts/dev/{kernel.json,kernel.ccs,kernel.pk,kernel.vk}.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

out=artifacts/dev
mkdir -p "$out"
(cd circuits && nargo compile --package kernel --silence-warnings)
cp circuits/target/kernel.json "$out/"
sunspot compile "$out/kernel.json" 2>&1 | grep -E "nbConstraints|successful"
sunspot setup "$out/kernel.ccs" >/dev/null
cat > "$out/INSECURE_DEV_SETUP.txt" <<EOF
These keys come from a single-party 'sunspot setup' run on $(hostname) at $(date -u +%FT%TZ).
They are INSECURE. Anyone with access to that machine's memory could forge proofs.
Never deploy a pool with this VK anywhere but localnet/devnet test pools without value.
EOF
sha256sum "$out"/kernel.{json,ccs,vk} | tee "$out/SHA256SUMS"
echo "dev setup written to $out (INSECURE)"
