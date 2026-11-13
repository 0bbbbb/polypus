# NEAR HACKATHON submission draft: Polypus Keys

Not sent. Contract and rules: https://nearhackathon.com/HACKATHON.md. Send once, after the repository is public and the demo post is up. Do not commit the final payload; it contains personal data.

## Payload

```json
{
  "requestId": "TODO: generate at send time with `node -e 'console.log(crypto.randomUUID())'` and reuse on retries",
  "projectName": "Polypus Keys",
  "leadName": "TODO",
  "email": "TODO",
  "size": "TODO: one of 1, 2 - 4, 4 - 6, 6 - 8, 8+",
  "tracks": ["privacy", "defi", "agents", "security"],
  "nearAddress": "TODO: confirm. Suggested: c597687cf596d624770c55380b4fa25c68da74a3f9995ba9311b709f702d1e3b",
  "projectUrl": "https://github.com/0bbbbb/polypus",
  "demoUrl": "TODO: link to the X demo post",
  "idea": "Copy-trading either leaks a trader's strategy to anyone who can read the chain or asks followers to hand a bot unlimited control. Polypus Keys lets a trader post every trade to a NEAR contract as ciphertext and sell time-limited keys; a buyer's agent receives the epoch key sealed to its own key, applies the buyer's guardrails, and copies the trade on Solana devnet through NEAR Chain Signatures, so no Solana key exists. An attestor signs the trader's PnL from the same feed and the contract verifies the signature on-chain; copy decisions are explained by NEAR AI Cloud with the gateway signature verified, and NEAR Intents 1Click gives dry quotes for paying from other chains. Trades are paper trades on live prices, the agent and attestor TEEs are simulated, and everything runs on NEAR testnet and Solana devnet.",
  "consent": true
}
```

Before sending:

- Replace every TODO. `nearAddress` must be an account you control; the wallet used in earlier drafts is compromised and must not be used.
- `consent` is `true` only after you agree to: "I agree that the organizers may use these details to review our submission and contact us about this hackathon."
- `idea` must stay between 20 and 2000 characters (the text above is about 900).
- Print the final JSON and confirm it before the POST to https://nearhackathon.com/api/applications. A second submission of the same repository is rejected with 409; fix mistakes at https://nearhackathon.com/request-changes.

## Checklist

- [ ] Repository public before 2026-11-14T23:59Z
- [ ] Demo video recorded and the X post published
- [ ] Payload filled and confirmed
- [ ] Keep the repository public through judging (2026-11-16 to 2026-11-18)

## X demo post (draft)

```
Copy-trading today either leaks the trader's strategy or hands a bot your keys.

We built Polypus Keys at NEAR HACKATHON: traders post every trade to a NEAR contract as ciphertext and sell keys. Your agent gets the key sealed to it, applies your guardrails, and copies the trade on Solana through NEAR Chain Signatures. No Solana key exists anywhere.

Video: one purchase, from "Buy key" to a finalized devnet tx.

NEAR does the work: contract-held encrypted feed and on-chain PnL check, Chain Signatures for signing, NEAR AI Cloud for attested explanations, Intents for pay-from-any-chain quotes.

Paper trades on testnet/devnet. Repo: https://github.com/0bbbbb/polypus  Site: https://polypus.fi

Where would you want a hard limit on what a copy agent can do?

@NEARProtocol #NEARHackathon
```

Attach the demo video. Add @NearLegion or @NearBuilders if you want more reach.
