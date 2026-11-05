# Polypus Keys: interfaces shared by contract, agents and app

Types: `apps/keys/src/data/types.ts`. Architecture: `SCOPE.md`.

## Accounts (NEAR testnet; keys in ~/.near-credentials, never in git)

| Role | Account |
|---|---|
| Registry contract | `polypus-keys-18e5.testnet` |
| Trader 1 | `alice-18e5.testnet` |
| Trader 2 | `bob-18e5.testnet` |
| Follower | `carol-18e5.testnet` |
| MPC signer | `v1.signer-prod.testnet`, Ed25519 `domain_id: 1`, path `solana-1` |

## keys-registry contract (near-sdk 5.30.x)

All amounts are yoctoNEAR strings (`U128`). Timestamps are nanoseconds (`U64`). Keys are base58 strings without a prefix.

Owner and roles:
- `new({owner})`
- `set_operator({account, enabled})` (owner). An operator may record mainnet 1Click receipts via `record_external_subscription`; this is a trusted role, stated in the README.

Traders:
- `register_trader({handle, shielded_address, solana_address, derivation_path, price: U128, period_days: u32, attestor_pubkey: String /*ed25519 base58*/, attestor_attestation_digest: String /*hex*/, bio?: String})`. The caller becomes the trader. Re-registering updates the profile. Validate formats: `shielded_address` starts with `poly1q` and is 133 chars; `solana_address` is 32-byte base58.
- `set_attestor({attestor_pubkey, attestor_attestation_digest})` (trader)

Subscriptions:
- `subscribe({trader, agent_pubkey: String /*x25519 base58*/, agent_attestation_digest: String, guardrails_hash: String})`, **payable**. It requires `attached >= price`, forwards `price` to the trader, refunds the excess, and sets `expires_at = now + period`. One active subscription per (follower, trader); calling again renews. Emits `subscribe`.
- `record_external_subscription({follower, trader, agent_pubkey, agent_attestation_digest, guardrails_hash, receipt: String /*1Click depositAddress or quote id*/})` (operator)
- `unsubscribe({trader})` (follower). Sets status `cancelled` and emits `unsubscribe`.
- `get_subscription({follower, trader}) -> Option<SubscriptionView>`, `get_subscriptions_for_trader({trader}) -> Vec<SubscriptionView>`, `get_subscriptions_for_follower({follower})`

Epoch keys and feed (trader only):
- `rotate_epoch({epoch: u32, sealed: Vec<{follower, agent_pubkey, sealed_key: String /*base64*/}>})`. `epoch` must be `current_epoch + 1` or equal to it (re-seal for new subscribers). Emits `epoch`.
- `post_feed({epoch: u32, ciphertext: String /*base64, max 2 KB*/})`. `seq` is assigned by the contract. Emits `feed`.
- `get_sealed_key({trader, follower, epoch}) -> Option<String>`
- `get_feed({trader, from_seq: u64, limit: u32}) -> Vec<FeedEntryView{seq, epoch, ciphertext, posted_at}>`

PnL:
- `publish_pnl({trader, statement: String /*canonical JSON*/, signature: String /*ed25519 base58 of sha256(statement)*/})`. Anyone may relay. The contract computes `sha256(statement)` and checks it with `env::ed25519_verify` against the trader's registered `attestor_pubkey`. It rejects mismatches and stores the result with a block timestamp. Emits `pnl`.
- `get_trader({account}) -> Option<TraderView>`, `get_traders({from_index, limit}) -> Vec<TraderView>` (`TraderView` includes the latest PnL statement + signature, `current_epoch`, `subscriber_count`).

Events: NEP-297 `EVENT_JSON:{"standard":"polypus_keys","version":"1.0.0","event":...,"data":[...]}`.

Function-call keys: the trader node uses a function-call key on the trader account, limited to `rotate_epoch`, `post_feed` and `publish_pnl`. The follower agent's key is limited to `unsubscribe`, so the agent can cut itself off, and it can't spend.

## PnL statement (canonical JSON: keys sorted, no whitespace)

```json
{"v":1,"trader":"alice-18e5.testnet","pnl_bps":1234,"trade_count":7,"window_start":"2026-11-08T00:00:00Z","window_end":"2026-11-10T00:00:00Z","pool":"<base58>","scanned_to_slot":123,"notes_scanned":42,"code_hash":"<hex sha256 of attestor wasm/js>","attestation_kind":"outlayer-tdx|simulated"}
```

## Feed encryption (agents/shared/feedcrypto.ts; must be byte-exact between trader node and agent)

- Epoch key `K_e`: 32 random bytes per (trader, epoch).
- Trade record: `nonce(24) || XChaCha20-Poly1305(K_e, nonce, canonical_json(TradeRecord), aad = utf8("polypus-keys/feed/v1|" + trader + "|" + epoch))`, base64.
- Seal to agent: `epk(32) || nonce(24) || XChaCha20-Poly1305(k, nonce, K_e, aad = utf8("polypus-keys/seal/v1|" + trader + "|" + follower + "|" + epoch))`, where `k = HKDF-SHA256(ikm = X25519(esk, agent_pk), salt = epk || agent_pk, info = "polypus-keys/seal/v1", 32)`. Base64.
- Libraries: `@noble/curves` (x25519, ed25519), `@noble/hashes` (sha256, hkdf), `@noble/ciphers` (xchacha20poly1305), `@scure/base` (base58, base64).
