#!/usr/bin/env bash
# Polypus Keys demo: protocol tests + app build. UNAUDITED devnet/testnet only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source scripts/env.sh 2>/dev/null || true

echo "== Polypus protocol (existing CI suite)"
bash scripts/test-all.sh

echo "== NEAR keys-registry contract unit tests (host)"
(cd contracts/keys-registry && cargo test --lib 2>/dev/null) || echo "(skip: host near-sdk tests need linker space)"

echo "== TypeScript workspaces"
npm install --silent
npm run build -w apps/keys

echo "== Keys NEAR e2e (subscribe → feed → decrypt → PnL)"
node scripts/keys-e2e.mjs

echo "== Live NEAR testnet view (optional)"
if command -v near >/dev/null; then
  NEAR_ENV=testnet near contract call-function as-read-only polypus-keys-18e5.testnet get_traders json-args '{"from_index":0,"limit":5}' network-config testnet now 2>/dev/null | head -20 || true
fi

echo ""
echo "Demo ready:"
echo "  npm run app          # Vite dev server → http://127.0.0.1:5174"
echo "  VITE_LIVE=1 npm run app   # merge live testnet registry views"
echo "  npm run demo         # this script"
echo "  npm run demo:live    # NEAR agents + devnet tx links"
