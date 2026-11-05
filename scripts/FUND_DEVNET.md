# Funding Solana devnet (agent blocker log)

Deployer pubkey: `87EzYr9mfpT5fEm7qYZDqSq63VQabxFkZi7RcPkMTRQG`  
Keypair path (local, gitignored): `~/.config/solana/polypus-devnet.json`

As of 2026-11-05 in this environment:

- `solana airdrop` on `https://api.devnet.solana.com` → rate limited / faucet closed
- `devnet-pow mine` → fails when payer balance &lt; 5000 lamports (it tries RPC airdrop first)

**Human step (fastest):** open [faucet.solana.com](https://faucet.solana.com), sign in with GitHub, airdrop **2 SOL** to the deployer address above, then:

```bash
bash scripts/devnet-deploy.sh
```

Target: ≥3 SOL for program deploy + e2e mint/pool actions.
