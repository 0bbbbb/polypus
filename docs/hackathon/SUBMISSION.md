# NEAR HACKATHON submission draft (Polypus Keys)

**Track:** Privacy & Private AI (`privacy`)  
**Payout account (user):** `<old-wallet-redacted>` (mainnet implicit — confirm before POST)

## Description (20–2000 chars)

Polypus Keys is private copy-trading for the NEAR ecosystem: traders keep positions shielded on Solana devnet and via NEAR Intents pricing, publish one attested PnL number from a TEE, and sell viewing keys that only a follower’s copy-trade agent (in a TEE) can use—never the human. Followers pay through NEAR Intents 1-Click (dry quotes in the demo; testnet NEAR subscription on-chain). NEAR Chain Signatures tie each trader’s NEAR account to a Solana depositor. Built for NEAR HACKATHON.

## Checklist (human)

- [ ] Make `polypus` repo **public** (GitHub or Origin) before **2026-11-14 23:59 UTC**
- [ ] Post public **X demo** (video or screenshots) mentioning NEAR HACKATHON
- [ ] POST `/api/applications` once (no resubmit — use request-changes for fixes)
- [ ] LICENSE file in repo root (Apache-2.0 matches crates)
- [ ] Confirm payout NEAR account in submission form
- [ ] Optional: tiny mainnet Intents payment demo (~$1) — **requires explicit wallet approval**

## Demo assets

- App: `npm run app` → http://127.0.0.1:5174
- End-to-end script: `npm run demo`
- Screenshots: `apps/keys/screenshots/` (after `npm run screenshots -w apps/keys`)

## Prior work disclosure

Solana Polypus pool, circuits, and SDK predate the hackathon window; **only NEAR integration** (registry contract, Intents checkout, Chain Signatures, TEE agents) is judged. See `docs/hackathon/HACKATHON-RULES.md` and tag `pre-hackathon-baseline` (if applied).
