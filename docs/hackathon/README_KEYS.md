# Polypus Keys — judge quickstart

**One line:** private copy-trading with attested PnL, NEAR Intents checkout, and viewing keys delivered only to a TEE agent.

## Try in 5 minutes

```bash
cd polypus
source scripts/env.sh          # optional: pinned toolchain
npm install
npm run demo                   # protocol tests + app build
npm run app                    # http://127.0.0.1:5174
```

| Do | See |
|---|---|
| Open `#/leaderboard` | Traders with attested PnL (recorded fixtures; live with `VITE_LIVE=1`) |
| Open `#/trader/alice-18e5.testnet` | Redacted activity feed (glitch bars) |
| Checkout → **Refresh dry quote** | Live **1Click** mainnet quote (`dry: true`, no spend) |
| `#/follower` | Copy agent, guardrails, SIMULATED TEE label |
| `#/explorer/...` | Redacted settlement vs decrypted holder view |

## NEAR tech (real vs mocked)

| Tech | Status | Code / proof |
|---|---|---|
| **keys-registry** contract | **Real testnet** `polypus-keys-18e5.testnet` | `contracts/keys-registry/` |
| **Chain Signatures** → Solana | **Real** `v1.signer-prod.testnet` sign tx `8HMx1bHi…` | `docs/hackathon/RESEARCH.md`, `/tmp/nr/sign.log` |
| **1Click / Intents** quotes | **Real** mainnet API, dry quotes | `apps/keys/src/near/oneclick.ts` |
| Confidential Intents checkout | **Not wired** (Partner JWT) | UI label |
| **NEAR AI Cloud** inference | **Mocked** without `NEARAI_API_KEY` | `agents/` stub, UI SIMULATED |
| OutLayer TEE agents | **Mocked** locally; path documented | `docs/hackathon/SCOPE.md` |
| Polypus pool on Solana | **Localnet proofs**; devnet deploy **in progress** | `programs/` |

## Live testnet commands

```bash
# Traders on registry
NEAR_ENV=testnet near contract call-function as-read-only polypus-keys-18e5.testnet \
  get_traders json-args '{"from_index":0,"limit":10}' network-config testnet now

# Re-seed demo traders
bash scripts/seed-registry.sh

# Chain Signatures (already verified for carol-18e5.testnet, path solana-1)
# See docs/hackathon/RESEARCH.md
```

## Accounts

- Registry: `polypus-keys-18e5.testnet` (not `polypus-keys.near` — that name was used only in early dry-quote experiments; live quotes used `polypus.near` / Solana recipients)
- Trader: `alice-18e5.testnet`, Follower: `carol-18e5.testnet`

See also: [`SCOPE.md`](SCOPE.md), [`SUBMISSION.md`](SUBMISSION.md).
