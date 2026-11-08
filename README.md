# Polypus Keys

Private copy-trading on NEAR. Traders post their trades encrypted on-chain and sell keys. A buyer never sees the trades; their copy agent does. The trader's node seals the epoch key to the agent's X25519 key, the agent decrypts the feed, applies the buyer's guardrails (committed on-chain as a hash), and copies on Solana through NEAR Chain Signatures. Trader returns are computed from the same encrypted feed by an attestor and published with a signature the registry verifies.

> Unaudited hackathon code. NEAR testnet and Solana devnet only.

## Run it

```bash
npm install
npm run setup:agent   # once: creates the agent operator account (polypus-agent-18e5.testnet)
npm run setup:live    # once: attestor registration + trader history at real historical prices
npm run dev:all       # api + trader node + follower agent + attestor + app
```

Open http://127.0.0.1:5174, pick a trader, and either connect a testnet wallet (MyNearWallet, Meteor, Intear, HERE) or use **Try with a demo account**. The timeline on the trader page links every transaction as it lands:

1. `subscribe` on `polypus-keys-18e5.testnet`, paying the key price
2. `rotate_epoch`: the trader node seals the epoch key to your agent
3. `post_feed`: the encrypted trades your agent decrypted
4. MPC `sign` on `v1.signer-prod.testnet` plus the resulting Solana devnet transaction

`npm run demo:live` runs the same purchase headless and checks every transaction on NEAR RPC and Solana devnet (finalized). With the services running, `node scripts/verify-txs.mjs [follower] [trader]` checks the transactions in the app's timeline the same way.

Views: Discover (traders with attested equity curves), Trader (equity, encrypted or decrypted trade history, buy panel with a live Intents quote), Portfolio (guardrails editor, copied trades, agent attestation) and Proof (contract, statements, transactions). A key you already hold shows a Renew action, so the demo account can be bought repeatedly.

`npm run screenshots -w apps/keys` rebuilds the app and drives it with playwright-core against the running services (includes a real demo purchase); images land in `apps/keys/screenshots`.

Secrets stay out of the repo: NEAR keys are read from `~/.near-credentials/testnet`, agent and epoch keys live in `~/.polypus-keys`, and `.env` (optional `NEARAI_API_KEY`, `ONECLICK_PARTNER_JWT`) is loaded only by the Node services. The browser talks to the local API and never receives a key.

## What is live

| Piece | State | Code |
|---|---|---|
| Registry contract | Live on testnet | [contracts/keys-registry](contracts/keys-registry) |
| Wallet purchase | Live: NEAR Wallet Selector, `subscribe` with the real deposit | [apps/keys](apps/keys) |
| Demo purchase | Live: API signs as `carol-18e5.testnet`, rate limited | [agents/api](agents/api) |
| Encrypted feed | Live: XChaCha20-Poly1305, epoch keys sealed with X25519 | [sdk/src/feedcrypto.ts](sdk/src/feedcrypto.ts), [agents/trader-node](agents/trader-node) |
| Trades | Paper trades at live Jupiter/CoinGecko prices, posted every 60-90 s; history backfilled at real historical prices | [agents/shared/book.ts](agents/shared/book.ts) |
| Attested PnL | Live: attestor decrypts the on-chain feed, marks to market, `publish_pnl` verifies ed25519 on-chain | [agents/attestor](agents/attestor) |
| Guardrails | Live: max per trade, copy size, token allowlist enforced by the agent; hash on-chain via `update_guardrails` | [agents/follower](agents/follower) |
| Copy execution | Live: Chain Signatures signs a Solana devnet transaction from an MPC-derived address per follower; the memo carries a commitment, not the trade | [agents/shared/chainsig.ts](agents/shared/chainsig.ts) |
| NEAR AI Cloud | Live when `NEARAI_API_KEY` is set: each copy decision is explained by a model on NEAR AI Cloud and the gateway's signature over request and response hashes is verified locally | [agents/shared/nearai.ts](agents/shared/nearai.ts) |
| NEAR Intents | Live when `ONECLICK_PARTNER_JWT` is set: confidential dry quotes for paying the key from other chains (mainnet quote only, no funds move) | [agents/shared/oneclick.ts](agents/shared/oneclick.ts) |
| Agent and attestor TEE | Simulated: local processes bound to a fresh NEAR AI gateway attestation, not running inside an enclave | [agents/shared/tee.ts](agents/shared/tee.ts) |
| Swap venue | Simulated: devnet has no JUP/BONK liquidity, so copies are signed receipts, not swaps | |

## Layout

```
contracts/keys-registry   NEAR registry (Rust, near-sdk 5)
agents/api                local HTTP + SSE API the app talks to (127.0.0.1:8787)
agents/trader-node        seals epoch keys to subscribers, posts encrypted trades
agents/follower           per-subscription copy agent
agents/attestor           PnL from the decrypted feed, publish_pnl
apps/keys                 the app (Preact + Vite)
sdk                       feed crypto shared by agents and app
programs, circuits, crates  Polypus shielded pool on Solana (pre-hackathon work)
```

## Tests

```bash
npm test -w agents
(cd contracts/keys-registry && cargo test --lib)
npm run build
bash scripts/test-all.sh   # Polypus protocol suite
```

The Polypus protocol (shielded SPL transfers on Solana, Groth16 pool `PoLYdUXuf78YC6aqE4qkmyFkfJi3mm773ZqJNECDYtj` on devnet) predates the hackathon; see [docs/hackathon/HACKATHON-RULES.md](docs/hackathon/HACKATHON-RULES.md).
