# Polypus Keys · integration status (2026-11-07)

Judge summary: **NEAR testnet registry + encrypted feed + Solana devnet Polypus settlements + Chain Signatures are live.** TEE agent/attestor and Confidential Intents stay **simulated or partner-gated** without env keys.

## Done (live on testnet / devnet)

| Flow step | Evidence |
|---|---|
| Registry `polypus-keys-18e5.testnet` | `contracts/keys-registry`, `scripts/seed-registry.sh` |
| Subscribe → `rotate_epoch` → `post_feed` → decrypt | `node scripts/keys-e2e.mjs` |
| Attested PnL `publish_pnl` + on-chain ed25519 check | `npm run attestor -w agents` |
| Polypus pool Groth16 deposits/transfers (devnet) | `deployments/devnet.json`, program `PoLYdUX…` |
| Trader/follower agent settlements | `keys-agent-settle` binary, explorer sigs in `devnet.json` |
| Chain Signatures → Solana devnet transfer | `scripts/chainsig-devnet.mjs`, `chain_signatures` block in `devnet.json` |
| 1Click dry quotes (mainnet API, no spend) | `apps/keys` checkout, `dry: true` |
| App build + live registry (`VITE_LIVE=1`) | `apps/keys/src/data/live.ts` |
| Protocol CI | `bash scripts/test-all.sh` |

## Simulated (honest labels in UI + agents)

| Piece | Fallback | Enable live |
|---|---|---|
| Copy-trade agent TEE | Local X25519 + `simulated-tee-v0` digest | OutLayer deploy (optional); gateway attestation fetch is live keyless |
| PnL attestor TEE | Local ed25519, `attestation_kind: simulated` | OutLayer + viewing key secret |
| NEAR AI copy explanation | Template text | `NEARAI_API_KEY` → `agents/shared/nearai.ts` |
| Confidential Intents checkout | UI disabled | `ONECLICK_PARTNER_JWT` (server-side; never in browser build) |
| ZK `copy_guardrail` proof on-chain | TypeScript + Noir reference circuit | Full Sunspot prove path (future) |

## Missing / human-only

| Item | Owner action |
|---|---|
| Public git repo + X post + form POST | User before **2026-11-14 23:59 UTC** |
| Mainnet 1Click payment demo | User wallet, tiny amount |
| OutLayer WASM attestor on `outlayer.testnet` | OutLayer project + payment key |
| NEAR AI organization API key | https://cloud.near.ai |
| 1Click Partner JWT | https://partners.near-intents.org |
| More devnet SOL for deployer/MPC | PoW faucet / `scripts/FUND_DEVNET.md` |

## Commands (verified in this workspace)

```bash
cd polypus
npm install
npm run demo              # test-all + build + keys-e2e
bash scripts/demo-live.sh # full agent loop + explorer links
VITE_LIVE=1 npm run app   # http://127.0.0.1:5174
```
