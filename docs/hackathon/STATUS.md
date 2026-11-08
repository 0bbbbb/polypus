# Polypus Keys status (2026-11-08)

The app runs end to end on NEAR testnet and Solana devnet with `npm run dev:all`. A purchase, from the wallet or the demo account, produces real transactions at every step, and the UI links each one as it lands.

## Live

| Step | Evidence |
|---|---|
| Wallet purchase | NEAR Wallet Selector (MyNearWallet, Meteor, Intear, HERE) signs `subscribe` on `polypus-keys-18e5.testnet` with the key price attached. Not exercised in a browser run here: no wallet extension in the test browser; the call shape is the same one the demo path signs server-side. |
| Demo purchase | `POST /api/demo/subscribe` signs as `carol-18e5.testnet`, rate limited. Driven by `apps/keys/tools/screenshots.mjs`. |
| Key delivery | The trader node sees the subscription and calls `rotate_epoch`, sealing the epoch key to the agent's X25519 key. |
| Encrypted feed | Trader node posts a paper trade every 60-90 s at live prices (`post_feed`). The agent decrypts it. |
| Attested PnL | Attestor decrypts the same feed and calls `publish_pnl`; the contract verifies the ed25519 signature. Return, trade count and win rate in the app come from that statement. |
| Guardrails | Max per trade, copy size and token allowlist are editable, enforced by the agent, committed on-chain with `update_guardrails`. Heron's BONK trades are skipped under the default allowlist. |
| Copy on Solana | Chain Signatures (`v1.signer-prod.testnet`) signs a Solana devnet transaction from an MPC-derived address. |
| NEAR AI Cloud | Each copy decision is explained by `zai-org/GLM-5.1-FP8`; the gateway signature over request and response hashes is verified. Server-side only. |
| Intents | Partner JWT is accepted for confidential dry quotes ("Pay from any chain"). Quote only, nothing is paid. |

Run of 2026-11-08 (demo account, kestrel, all finalized; `node scripts/verify-txs.mjs`):

- subscribe: https://testnet.nearblocks.io/txns/Agw69nwMXP2G1fnZyQfX4PRfE3tUbFm1obKo7wkRCbK
- rotate_epoch: https://testnet.nearblocks.io/txns/DYZ2uoWdJriKzYsMhQCs3jeRMF4vnf2RkbJiwmFEmM2
- post_feed #50: https://testnet.nearblocks.io/txns/DEcHwsM26ma2CuAwN89WuFayuaGnggk2R5bUmvf4m4m
- MPC sign: https://testnet.nearblocks.io/txns/92BtG3hzhaz3fdHWuNmhbaNXNZQHSMkxuoiFMeAnpRaS
- Solana devnet copy: https://explorer.solana.com/tx/2YLLxqk4BdfWyjn9FU26SatSFzcijEtCiFL522PTXapKdJy81Lv1k86b9naqxzEECz6HSMduvRAQXHPsTfBKdtdw?cluster=devnet

## Simulated or limited

| Piece | State |
|---|---|
| Agent and attestor TEE | Local processes. The agent binds to a fresh NEAR AI gateway attestation; neither runs inside an enclave. The attestor's statements say `attestation_kind: simulated`. |
| Trades | Paper trades at live prices from a seeded random book, not a real strategy. Returns are small and can be negative. |
| Swap venue | Devnet has no JUP or BONK liquidity, so a copy is a signed receipt transaction (memo commitment), not a swap. |
| ZK `copy_guardrail` | Noir circuit and reference checks exist; no on-chain proof verification in the copy path. |
| Testnet RPC | FastNEAR rate limits under load; the services fail over and retry copies up to three times. |

## Left for the submitter

| Item | Owner |
|---|---|
| Public repo, X post, submission form before 2026-11-14 23:59 UTC | user |
| Mainnet 1Click payment demo | user wallet, small amount |
| More devnet SOL for the deployer and MPC address | `scripts/FUND_DEVNET.md` |

## Commands

```bash
npm install
npm run setup:agent && npm run setup:live   # once
npm run dev:all                             # http://127.0.0.1:5174
node scripts/verify-txs.mjs                 # check the latest timeline on-chain
npm run build
bash scripts/test-all.sh
```
