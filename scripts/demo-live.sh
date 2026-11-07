#!/usr/bin/env bash
# Live Polypus Keys loop: NEAR agents + Solana devnet settlements + explorer links.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== Polypus Keys LIVE demo (testnet + devnet)"
echo "   Registry: polypus-keys-18e5.testnet"
echo ""

node scripts/keys-e2e.mjs

DEP="${ROOT}/deployments/devnet.json"
if [[ -f "$DEP" ]]; then
  echo ""
  echo "== Latest Solana devnet txs"
  node -e "
    const d = require('${DEP}');
    const base = d.explorer_base || 'https://explorer.solana.com/tx/{sig}?cluster=devnet';
    for (const s of (d.signatures || []).slice(-4)) {
      console.log('  ', s.label, base.replace('{sig}', s.sig));
    }
    if (d.chain_signatures?.explorer_solana) {
      console.log('   MPC transfer', d.chain_signatures.explorer_solana);
    }
  "
fi

echo ""
echo "== UI"
echo "   VITE_LIVE=1 npm run app   → http://127.0.0.1:5174"
echo "   Optional: NEARAI_API_KEY=… npm run follower -w agents  (TEE inference labels)"
