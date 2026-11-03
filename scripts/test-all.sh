#!/usr/bin/env bash
# Run every off-chain check: Rust reference, vector reproducibility, Noir tests,
# proving pipeline (INSECURE dev keys) and a short differential run.
# Usage: scripts/test-all.sh [DIFF_CASES]   (default 500; M1 acceptance uses 10000)
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
cases=${1:-500}

echo "== polypus-crypto tests"
cargo test -q --release -p polypus-crypto

echo "== vectors are reproducible"
cargo run -q --release -p polypus-crypto --bin gen-vectors
git diff --exit-code -- spec/vectors circuits/polypus_notes/src/vectors.nr circuits/kernel/src/fixtures.nr

echo "== nargo test"
(cd circuits && nargo test --workspace --silence-warnings 2>&1 | grep -E "tests? (passed|failed)")

echo "== proving pipeline"
[ -f artifacts/dev/kernel.pk ] || scripts/dev-setup.sh
cargo build -q --release -p polypus-prover
./target/release/polypus-prove scenarios
./target/release/polypus-prove tamper
./target/release/polypus-prove diff "$cases" 8
