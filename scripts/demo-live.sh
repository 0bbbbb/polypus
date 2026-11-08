#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/keys-e2e.mjs "${1:-alice-18e5.testnet}"
