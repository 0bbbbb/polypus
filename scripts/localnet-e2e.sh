#!/usr/bin/env bash
# LOCALNET ONLY. Start solana-test-validator, deploy the pool (with the INSECURE
# dev kernel VK from artifacts/dev), run deposit → transfer → withdraw with real
# kernel proofs, report compute units, and stop the validator.
#
# Needs: scripts/dev-setup.sh artifacts, the program keypair at
# programs/keys/polypus_pool-keypair.json (gitignored; its pubkey must match
# declare_id! in programs/polypus-pool/src/lib.rs).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

[ -f artifacts/dev/kernel.vk ] || scripts/dev-setup.sh
program_kp=programs/keys/polypus_pool-keypair.json
[ -f "$program_kp" ] || { echo "missing $program_kp (gitignored program keypair)"; exit 1; }

(cd programs && anchor build >/dev/null 2>&1 || cargo build-sbf --manifest-path polypus-pool/Cargo.toml)
(cd programs && cargo build -q --release -p polypus-tests --bin localnet-e2e)

work=$(mktemp -d /tmp/polypus-localnet.XXXXXX)   # ledger + throwaway deployer key, outside the repo
cleanup() { [ -n "${validator:-}" ] && kill "$validator" 2>/dev/null; wait 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

solana-test-validator --reset --quiet --ledger "$work/ledger" --rpc-port 8899 >"$work/validator.log" 2>&1 &
validator=$!
for _ in $(seq 60); do solana --url http://127.0.0.1:8899 cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana --url http://127.0.0.1:8899 cluster-version

solana-keygen new --no-bip39-passphrase --silent -o "$work/deployer.json"
solana-keygen new --no-bip39-passphrase --silent -o "$work/buffer.json"
solana --url http://127.0.0.1:8899 airdrop 100 "$work/deployer.json" >/dev/null
solana --url http://127.0.0.1:8899 program deploy --keypair "$work/deployer.json" \
  --buffer "$work/buffer.json" --program-id "$program_kp" programs/target/deploy/polypus_pool.so

POLYPUS_RPC=http://127.0.0.1:8899 programs/target/release/localnet-e2e
