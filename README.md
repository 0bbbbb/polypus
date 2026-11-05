# Polypus Keys · private copy-trading (NEAR HACKATHON)

**One line:** traders keep trades shielded, publish **one attested PnL**, and sell viewing keys that only a **follower agent in a TEE** can use—never the human. Followers pay via **NEAR Intents**; settlements use **Polypus** on Solana; **Chain Signatures** link NEAR accounts to Solana signers.

> **UNAUDITED research code — testnet/devnet only.** See [LICENSE](LICENSE). Never use real funds in Polypus contracts.

## Try Polypus Keys in 5 minutes

```bash
cd polypus
source scripts/env.sh          # optional pinned toolchain
npm install
npm run demo                   # protocol tests + app build + NEAR keys e2e
VITE_LIVE=1 npm run app         # http://127.0.0.1:5174
```

| Do | See |
|---|---|
| `node scripts/keys-e2e.mjs` | **Live testnet:** subscribe → seal epoch key → encrypted feed → decrypt → **publish_pnl** (checkpoints printed) |
| Open `#/leaderboard` with `VITE_LIVE=1` | Traders from **`polypus-keys-18e5.testnet`** with on-chain PnL statements |
| Checkout → **Refresh dry quote** | Real **1Click** mainnet quote (`dry: true`) |
| `bash scripts/devnet-deploy.sh` | **Solana devnet** pool deploy + real-proof deposit/transfer/withdraw → `deployments/devnet.json` (needs ≥3 SOL — [FUND_DEVNET.md](scripts/FUND_DEVNET.md)) |

Judge quickstart: [docs/hackathon/README_KEYS.md](docs/hackathon/README_KEYS.md) · Scope: [docs/hackathon/SCOPE.md](docs/hackathon/SCOPE.md) · Submission draft: [docs/hackathon/SUBMISSION.md](docs/hackathon/SUBMISSION.md)

## NEAR technology (real vs mocked)

| Tech | Status | Where |
|---|---|---|
| **keys-registry** (testnet) | **Real** | [contracts/keys-registry/](contracts/keys-registry/) · `polypus-keys-18e5.testnet` |
| **Chain Signatures** → Solana ed25519 | **Real** (testnet `sign` verified) | [docs/hackathon/RESEARCH.md](docs/hackathon/RESEARCH.md) |
| **1Click / Intents** dry quotes | **Real** (mainnet API) | [apps/keys/src/near/oneclick.ts](apps/keys/src/near/oneclick.ts) |
| Encrypted feed + epoch keys | **Real** on registry | [sdk/src/feedcrypto.ts](sdk/src/feedcrypto.ts), [agents/](agents/) |
| PnL attestor + follower agent TEE | **SIMULATED** locally | [agents/attestor/](agents/attestor/), [agents/follower/](agents/follower/) — needs `NEARAI_API_KEY` / OutLayer for live TEE |
| Confidential Intents checkout | **Not wired** (Partner JWT) | UI label |
| Polypus pool on Solana devnet | **Pipeline ready** — blocked on devnet SOL | [scripts/devnet-deploy.sh](scripts/devnet-deploy.sh) |

## Polypus protocol (Solana privacy)

Private SPL transfers and private programs on Solana. Design: [`../docs/POLYPUS_DESIGN.md`](../docs/POLYPUS_DESIGN.md).

### Status (Milestone 1 + M2 + Keys NEAR integration)

| Area | State |
|---|---|
| `spec/SPEC.md`, `crates/polypus-crypto`, Noir kernel | Reference impl + vectors |
| `programs/polypus-pool` | Anchor pool, real Groth16 proofs, ~220k CU (localnet e2e) |
| `apps/keys/` | Hackathon product UI |
| `agents/` | Trader node, attestor, follower (local SIMULATED TEE) |

### Build and test (protocol)

```bash
source scripts/env.sh
bash scripts/test-all.sh
scripts/localnet-e2e.sh          # real proofs on local validator
```

Full layout and toolchain pins remain in git history below this section.

## Security

- Unaudited. Dev/test keys only. Do not deploy Polypus to mainnet with real funds.
- Hackathon NEAR integration is judged separately from pre-Oct-19 Solana protocol work ([HACKATHON-RULES.md](docs/hackathon/HACKATHON-RULES.md)).
