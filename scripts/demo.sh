#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh 2>/dev/null || true

echo "== protocol suite"
bash scripts/test-all.sh

echo "== keys-registry contract tests"
(cd contracts/keys-registry && cargo test --lib -q)

echo "== agents"
npm test -w agents
npm run typecheck -w agents

echo "== app build"
npm run build -w apps/keys

echo "== live end-to-end (testnet + devnet)"
node scripts/keys-e2e.mjs
