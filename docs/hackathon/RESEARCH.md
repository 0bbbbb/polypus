# Polypus Keys — NEAR integration research

Verification date for everything below: **2026-11-05 (UTC)**, unless noted.
Tags: **VERIFIED** = I ran it (curl / RPC / tx / npm) or read it in the source code. **DOCS-ONLY** = taken from official docs and not exercised.
No secrets in this file. Keys for the testnet accounts live in `~/.near-credentials/testnet/` (outside the repo).

---

## 0. TL;DR feasibility (by Nov 12)

| Piece | Real or simulated | Why |
|---|---|---|
| 1Click checkout (any chain → NEAR/Solana), `dry:true` quotes | **REAL** | Public, no JWT, CORS `*`. Live (non-dry) swaps are mainnet only, so use about $1–5. |
| Confidential (private) swap via 1Click `confidentiality` | **REAL only with a Partner JWT** (plus probably a user session); otherwise **show it as a request flag** | Without a JWT, 401 "User authentication is required for confidential intent quotes". |
| Chain Signatures: NEAR account controls a Solana address (Ed25519) | **REAL on testnet** | Sign + verify done end to end with `carol-18e5.testnet`. |
| Attested PnL computed in a TEE | **REAL via OutLayer on testnet** (WASM in Intel TDX, attested hashes of input/output). Alternative: Phala CVM, about $0.06/h. | Shade Agents are deprecated. NEAR AI Cloud runs inference only (no custom code, apart from an OpenClaw beta). |
| Copy-trade agent "in a TEE" using NEAR AI Cloud | **REAL for the LLM decision step** (TEE model + attestation + per-response signature). The agent process itself runs in OutLayer/Phala or is simulated. | Inference needs a NEAR AI API key. |
| Guardrailed agent wallet on Intents (Agent API) | **REAL but mainnet only**, needs a `naa_` partner key and about 10 USDC on Base | No testnet. |
| Key delivered only to the follower's agent TEE | **REAL-ish with OutLayer secrets/CKD** (decrypted only inside the enclave); otherwise simulated (encrypt to a TEE-attested pubkey) | |
| Solana side of the copy trades | **devnet**; the public RPC faucet is closed, so use the PoW faucet or a local validator | |

---

## 1. Confidential trading / Confidential Intents

**It exists and is public** (B2B launch 2026, after the July 2026 `confidentiality` parameter). Name: **Confidential Intents**.

- Docs: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps , https://docs.near-intents.org/integration/market-makers/confidential-intents , changelog https://docs.near-intents.org/changelog/overview — DOCS-ONLY.
- Architecture (DOCS-ONLY): a two-chain model. Public NEAR has `intents.near`. **FAR** is a permissioned private NEAR fork (small validator set, private RPC) running `intents.far`. Assets are "shielded" by sending them to a Treasury on NEAR, and the Private PoA Bridge mints IMT tokens on FAR. Swaps settle on FAR via `token_diff`. "Unshielding" burns the IMT and releases the backing. Quotes for confidential swaps go through a separate **Private Relay** that only whitelisted solvers can use (WebSocket only).
- **What is hidden from whom** (DOCS-ONLY): public observers and indexers cannot match deposits to withdrawals. Balances and swap details on FAR are invisible to the public. The Intents operator and the FAR validators still see everything (this is privacy from the public, not trustless privacy). Since **2026-10-27, ALL 1Click swaps settle on the "NEAR Private Shard"**: `nearTxHashes` holds only the shield/unshield hashes, while the swap data stays visible on the Intents Explorer.
- **API/SDK** (VERIFIED in the source of `@defuse-protocol/one-click-sdk-typescript@0.1.26`):
  - `QuoteRequest.confidentiality`: `"public"` (default; echoed back in every quote) | `"basic"` | `"advanced"`.
  - `depositType` / `recipientType` / `refundType` each add `CONFIDENTIAL_INTENTS`. The embedded-balance path needs signed-intent execution: `POST /v0/generate-intent` then `POST /v0/submit-intent`.
  - User session: `POST /v0/auth/authenticate {signedData}` (an empty intent signed by the wallet, using a versioned nonce) returns `{accessToken (900 s), refreshToken (604800 s)}`. Refresh with `POST /v0/auth/refresh`. Private balances are at `GET /v0/account/balances` (Bearer user token). `GET /v0/account/history` is **403 "History is invite-only for now"** (VERIFIED).
  - Confidential limit orders: `POST/GET /v0/orders`, `/v0/orders/{id}`, `/v0/orders/{id}/cancel`.
- **Live test** (VERIFIED):
  - `dry:true` + `confidentiality:"basic"|"advanced"` with no auth → **401** "User authentication is required for confidential intent quotes".
  - `/v0/auth/authenticate` with a throwaway viem EVM key (`erc191`) → **200**, tokens issued. **No registration and no funds needed.**
  - Sending that user token as `Authorization: Bearer` or `X-API-Key` on `/v0/quote` → 401 "Invalid token". Other header names → the same 401 as without auth.
  - Conclusion: confidential quotes most likely need a **Partner JWT** (and possibly a user session alongside it). This is unresolved without a JWT; get one at https://partners.near-intents.org and re-test.
- Verifier contract `intents.near`: there is no "shielded mode" in the contract itself. Confidentiality is FAR + bridge + relay, and `intents.near` is still used to verify signatures (DOCS-ONLY).
- Agent API (below) also exposes `shield` / `unshield` and private balances for agents (DOCS-ONLY; `/v1/network` lists the `shield` and `unshield` components, VERIFIED).

## 2. 1-Click Swap API

- Base URL: `https://1click.chaindefuser.com` (VERIFIED). Docs: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request
- SDK: **`@defuse-protocol/one-click-sdk-typescript@0.1.26`** (published 2026-09-22; VERIFIED via npm). Set `OpenAPI.BASE` and `OpenAPI.TOKEN` (the JWT, sent as `Authorization: Bearer`; `X-API-Key` is also accepted per the docs).
- Endpoints (VERIFIED in the SDK source): `GET /v0/tokens`, `POST /v0/quote`, `GET /v0/status?depositAddress=&depositMemo=`, `POST /v0/deposit/submit {txHash, depositAddress, nearSenderAccount?, memo?}`, `GET /v0/any-input/withdrawals`, `POST /v0/generate-intent`, `POST /v0/submit-intent`, `/v0/orders*`, `/v0/auth/*`, `/v0/account/*`.
- **No JWT needed** (VERIFIED): `GET /v0/tokens` → 200 (215 tokens). `POST /v0/quote` with `dry:true` → **201**.
  - Docs say unauthenticated quotes add **+0.25% (25 bps)** on non-ANY_INPUT quotes, while partner rates are about 20 bps, or 1 bp for stable/same-asset routes (DOCS-ONLY, https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication).
  - Unauthenticated quotes echoed `appFees:[{recipient:"5880ad…47dd", fee:1}]` for USDC→USDC and `fee:20` for wNEAR→SOL (VERIFIED).
- **CORS** (VERIFIED): `OPTIONS /v0/quote` → 204 with `access-control-allow-origin: *` and `allow-headers: content-type,authorization`, so it can be called from the browser. Don't ship a JWT to the browser; proxy it instead.
- Quote request fields (VERIFIED): `dry, swapType (EXACT_INPUT|EXACT_OUTPUT|FLEX_INPUT|ANY_INPUT), slippageTolerance (bps), originAsset, depositType (ORIGIN_CHAIN|INTENTS|CONFIDENTIAL_INTENTS), destinationAsset, amount (base units string), refundTo, refundType, recipient, recipientType (DESTINATION_CHAIN|INTENTS|CONFIDENTIAL_INTENTS), deadline (ISO), confidentiality?, referral?, appFees?, rebates?, quoteWaitingTimeMs?, connectedWallets?, sessionId?`. The server also echoes `depositMode:"SIMPLE"` and `insured:false`.
  - `refundTo` is validated: the address `0x…dEaD` → 400 "refundTo is not valid".
- Quote response (VERIFIED): `{quote:{amountIn, amountInFormatted, amountInUsd, minAmountIn, amountOut, amountOutFormatted, amountOutUsd, minAmountOut, timeEstimate, refundFee, withdrawFee, [depositAddress, depositMemo, deadline, timeWhenInactive, chainDepositAddresses] (non-dry only)}, quoteRequest:{…}, signature:"ed25519:…", timestamp, correlationId}`.
  - Example dry quote: 1 USDC Base → USDC NEAR gave `amountOut 999798`, `timeEstimate 35` s. 1 wNEAR → SOL gave `40892878` lamports (about $3.68).
- Status values (VERIFIED in source): `KNOWN_DEPOSIT_TX | PENDING_DEPOSIT | INCOMPLETE_DEPOSIT | PROCESSING | SUCCESS | REFUNDED | FAILED`. An unknown `depositAddress` → 404 (VERIFIED).
- Asset ids (VERIFIED from `/v0/tokens`):
  - `nep141:wrap.near` (wNEAR, 24 decimals)
  - `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (USDC on NEAR, 6 decimals)
  - `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` (USDC on Base)
  - `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near` (USDC on Solana, mint EPjF…Dt1v)
  - `nep141:sol.omft.near` (native SOL, 9 decimals)
  - newer form `1cs_v1:sol:spl:<mint>` (e.g. wNEAR on Solana)
  - Pattern: `nep141:<chain>-<token>.omft.near` for PoA-bridged assets, `nep141:<near-contract>` for NEAR-native.
  - Address formats: `refundTo`/`recipient` are native addresses on the origin/destination chain (EVM `0x…` 20-byte hex, Solana base58, NEAR account id).
- Widget (DOCS-ONLY): **`@aurora-is-near/intents-swap-widget@7.29.0`** (version VERIFIED on npm), plus `@aurora-is-near/intents-swap-widget-standalone` (built-in wallet connect). Components: `WidgetConfigProvider` with `Widget` / `WidgetSwap` / `WidgetTransfer` / `WidgetWithdraw`. Studio: https://intents.aurora.dev/ . Docs: https://docs.near-intents.org/integration/devkit/react-widget
- Related SDK: `@defuse-protocol/intents-sdk@0.95.0` (VERIFIED). Gotcha: its **ESM build fails on Node 22** (`near-api-js/lib/utils/serialize` import without the `.js` extension), so use `require()` (CJS), which works (VERIFIED).

## 3. NEAR AI Cloud

- Base: `https://cloud-api.near.ai/v1`. Keys: https://cloud.near.ai . Docs index: https://docs.near.ai/llms.txt
- `GET /v1/models` → **200 without a key** (VERIFIED, 64 models, CORS reflects the Origin).
  - NEAR-operated TEE models (`owned_by:"nearai"`, `is_ready:true`): e.g. `Qwen/Qwen3.8-27B`, `Qwen/Qwen3.6-35B-A3B-FP8`, `z-ai/glm-5.3-flash`, `Qwen/Qwen3-VL-30B-A3B-Instruct`.
  - `owned_by:"attested 3p"` models (e.g. `moonshotai/kimi-k3`, `qwen/qwen3.5-397b-a17b`) are attested by another provider (chutes).
  - anthropic/openai/google/x-ai models are proxied and **not** TEE-hosted.
- `GET /v1/attestation/report?model=<id>&signing_algo=ecdsa|ed25519&nonce=<64 hex>` (optional `include_tls_fingerprint=true`, `provider=near`) → **200 without a key** (VERIFIED). The docs' API reference says it "Requires an API key", but it worked keyless today.
  - Defaults: gateway `ed25519`, model `ecdsa`.
  - Shape (VERIFIED):
    - `gateway_attestation{signing_address, signing_algo, intel_quote (TDX), event_log, report_data, request_nonce, info{app_id, instance_id, app_cert, tcb_info{mrtd, rtmr0-3, os_image_hash, compose_hash, app_compose, event_log}, mr_aggregated, key_provider_info, vm_config}, vpc}`
    - `model_attestations[]{model_name, signing_address, signing_algo, signing_public_key, request_nonce, intel_quote, nvidia_payload (NVIDIA GPU evidence JSON), event_log, info, ohttp_attestation, compose_manager_attestation}` (third-party models have `provider, verified, gpu_evidence[], tcb_status, gpu_verdict, e2e_pubkey`)
    - `ohttp_key_config`, `ohttp_attestation`
    - Gateway runs on `dstack-0.5.12`. The nonce is echoed back (VERIFIED).
- report_data binding (DOCS-ONLY, https://docs.near.ai/cloud/verification/reference/quote-nonce-signer):
  - 64 bytes = [signing identity, zero-padded to 32 B **or** `SHA256(identity‖tls_spki_fingerprint)`] ‖ [32-byte client nonce]. VERIFIED by eye: the first 20 bytes equal `signing_address` and the tail equals the nonce.
  - MRCONFIGID = `01‖sha256(app_compose)‖0×15`.
  - Replay the RTMR3 event log as `SHA384(type_le32‖":"‖event‖":"‖payload)`.
  - Send `nvidia_payload` to `https://nras.attestation.nvidia.com/v3/attest/gpu` and require `x-nvidia-overall-att-result == true`.
  - Verify the TDX quote with `dcap-qvl`.
- Per-response signatures: `GET /v1/signature/{chat_id}?signing_algo=ecdsa` (Bearer key; without a key → **401** `missing_auth_header`, VERIFIED). Chat without a key → 401 (VERIFIED).
  - The signature covers `text = "<MODEL_ID>:<sha256(req bytes)>:<sha256(resp bytes)>"` (`signature_kind:"provider_tee"`) or `"<req_hash>:<resp_hash>"` (`"gateway"`, used for streaming, aliases, and the Responses API).
  - ECDSA is EIP-191 recover, then compare with the attested `signing_address`.
  - Send `x-no-aliasing: true` and the canonical model id, and hash the exact bytes (DOCS-ONLY, https://docs.near.ai/cloud/verification/cloud-api/response-signatures).
- Example repo: https://github.com/near-examples/nearai-cloud-verification-example (HEAD 12098c3, 2026-09-16). It fetches the report with a nonce, calls NVIDIA NRAS, sends the chat, fetches the signature, and checks the signer. Needs `NEARAI_CLOUD_API_KEY` and Node 22+ (VERIFIED README).
- SDKs: `@nearai/inference-sdk@0.2.1` (2026-10-29, VERIFIED npm), plus Python/Rust/Go (https://docs.near.ai/cloud/inference-sdk). Verifier: `nearai-cloud-verifier`.
- **Own code in a NEAR AI TEE?** The NEAR AI Cloud docs cover inference only. The exception is **OpenClaw hosting beta** (request access; deploys an OpenClaw agent into a private TEE instance; https://www.near.ai/blog/openclaw-now-available-on-near-ai-cloud), which is not arbitrary code (DOCS-ONLY). IronClaw (`nearai/ironclaw`) is an agent OS you self-host. Options for custom TEE code:
  - **OutLayer** (FastNEAR): Rust → WASM (`wasm32-wasip1/2`) runs in Intel TDX. The attestation binds the WASM sha256, input hash, output hash, and worker measurements. It also offers encrypted secrets and Confidential Key Derivation (CKD).
    - Called via `outlayer.testnet` / `outlayer.near` `request_execution` (yield/resume, about 0.1 NEAR deposit with refund) or HTTPS `https://api.outlayer.ai/call/<owner>/<project>` with a `X-Payment-Key` (USDC).
    - CLI crate `outlayer-cli@0.2.1`, SDK crate `outlayer@0.2.1`; npm `outlayer@2.1.1` (versions VERIFIED).
    - Contracts `outlayer.testnet` and `worker.outlayer.testnet` exist on testnet (VERIFIED via view_account).
    - Docs: https://app.outlayer.ai/docs/getting-started , https://docs.near.org/primitives/off-chain-compute/outlayer (DOCS-ONLY).
  - **Phala Cloud CVM** (dstack, docker-compose): `tdx.small` costs $0.058/h, plus $20 free credit for verified accounts (DOCS-ONLY, https://cloud.phala.com/about/pricing).

## 4. Shade Agents

- **Deprecated**: "After April 19th, 2026, the Shade Agent Framework will no longer be maintained" (https://docs.near.org/ai/shade-agents/getting-started/introduction, DOCS-ONLY). Docs moved to https://github.com/NearDeFi/shade-agent-framework/tree/main/docs (repo HEAD 35758f3, 2026-10-14, VERIFIED clone).
- npm: `@neardefi/shade-agent-js@2.2.0`, `@neardefi/shade-agent-cli@2.4.0` (both last published 2026-06-04; VERIFIED).
- Flow (DOCS-ONLY, from repo docs):
  - An agent contract (Rust; uses the `shade-attestation` crate) stores approved measurements and PPIDs.
  - The agent calls `register_agent(attestation)`, and the contract verifies the TDX quote, measurements, and PPID.
  - Agent-gated methods then call the MPC `sign` (`v1.signer-prod.testnet` on testnet, `v1.signer` on mainnet).
  - Local mode uses `whitelist_agent_for_local`.
  - CLI: `shade auth set all testnet create-new`, `shade deploy`, `shade whitelist`.
  - Needs a **Phala Cloud account + API key** plus a Docker Hub image. Testnet is supported.
- Verdict: possible, but risky for 5 days (unmaintained, needs a Phala account, and debugging TDX quotes). Prefer **OutLayer on testnet** for "attested computation on NEAR", or use Shade's pattern (agent contract + MPC) with a local whitelist and label it as such.

## 5. Chain Signatures on testnet (all VERIFIED)

- MPC contract: **`v1.signer-prod.testnet`**, `version` = `"3.18.0"`. (`v1.signer.testnet` does not exist; mainnet is `v1.signer`.)
- Domains (`state`): `0` CaitSith/Secp256k1 (Sign), **`1` Frost/Ed25519 (Sign)**, `2` CKD (BLS12-381), `3` Secp256k1 (ForeignTx). Threshold 11.
  - `public_key {"domain_id":1}` → `ed25519:6vSEtQxrQj6txUMh33WC4ERyCWmNMRTdufDWAaDY3Un2`.
- Derive: view `derived_public_key {"path":"solana-1","predecessor":"alice.testnet","domain_id":1}` → `ed25519:HD1hoD76CvCk77wS9jqfKvcq7VPWUZyY6tthx2axtgyN`. **The Solana address is that base58 key** (no hashing). chainsig.js returns the identical value.
  - Tweak: `TWEAK_DERIVATION_PREFIX = "near-mpc-recovery v0.1.0 epsilon derivation:"` + `predecessor,path` (`crates/near-mpc-crypto-types/src/kdf.rs` in https://github.com/near/mpc, HEAD 626d5b3).
  - **The predecessor is the account that calls `sign`.** If the Polypus contract calls `sign`, derive using the contract id.
- Sign (Ed25519): `sign` with
  - args `{"request":{"path":"solana-1","payload_v2":{"Eddsa":"<hex msg, ≤1232 bytes>"},"domain_id":1}}`
  - deposit **1 yoctoNEAR** (`SIGN_DEPOSIT_YOCTONEAR = 1`), gas 15 Tgas minimum (SDK `SIGN_GAS`); I attached 300 Tgas and 8.6 Tgas was used.
  - Returns `{"scheme":"Ed25519","signature":[64 bytes]}`.
  - ECDSA uses `{"Ecdsa":"<32-byte hex>"}` with `domain_id:0`.
  - Real tx: `8HMx1bHiRmnLQXsDwq3gdN473yogCAXiviRgRdAqKZnB` (signer `carol-18e5.testnet`, about 9 s). **The signature verifies with Ed25519 against carol's derived Solana key `6QWKrdhdQSywsM8xbT5TcJaznaFPM2r4kcN4Dzr2YNxw`.** For Solana, the `Eddsa` payload is the serialized tx message bytes.
- JS: **`chainsig.js@1.1.16`**: `new contracts.ChainSignatureContract({networkId:'testnet', contractId:'v1.signer-prod.testnet'})`, then `new chainAdapters.solana.Solana({solanaConnection, contract}).deriveAddressAndPublicKey(predecessor, path)`.
  - Derived addresses for `solana-1`: `alice-18e5.testnet` → `73EoH9XU8g4GZcru2TRzgdy3YoyDkfX4PyB6YjT9dkHr`, `carol-18e5.testnet` → `6QWKrdhdQSywsM8xbT5TcJaznaFPM2r4kcN4Dzr2YNxw`.
- RPC used: `https://rpc.testnet.near.org` (worked; slow at about 7 s per call). Alternative: `https://rpc.testnet.fastnear.com`.

## 6. Tooling (VERIFIED)

- near-cli-rs **0.31.0** (released 2026-11-05): `~/.local/bin/near`, installed from the GitHub release tarball `near-cli-rs-x86_64-unknown-linux-gnu.tar.gz` (no sudo).
- cargo-near **0.22.0**: `~/.cargo/bin/cargo-near`, from the release tarball.
- Crate `near-sdk` **5.30.1**.
- npm: `near-api-js@7.4.0` (2026-10-23), `@near-js/*@2.5.1` (2025-11; `near-api-js` v7 is the current line), `@hot-labs/near-connect@0.12.0`, `@near-wallet-selector/core@10.1.4`, `@solana/web3.js@3.1.1`, `@solana/kit@8.6.0`.
- Faucet from the CLI: `near account create-account sponsor-by-faucet-service <id>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create` gives **10 NEAR** per account.
- **Created testnet accounts** (each funded with 10 NEAR; keys in `~/.near-credentials/testnet/`):
  - `polypus-keys-18e5.testnet` (project / contract)
  - `alice-18e5.testnet` (trader 1)
  - `bob-18e5.testnet` (trader 2)
  - `carol-18e5.testnet` (follower)

## 7. Solana devnet

- RPC: `https://api.devnet.solana.com` (VERIFIED `getVersion` → solana-core 4.4.0-beta.1).
- **The public RPC faucet is closed**: `requestAirdrop` → `{"code":410,"message":"The RPC faucet is closed on this cluster. Request test SOL at https://faucet.solana.com"}`, and `solana airdrop 1|2|5` fails (VERIFIED).
- Alternatives (DOCS-ONLY, https://faucet.solana.com , https://solana.com/developers/guides/getstarted/solana-token-airdrop-and-faucets):
  - Web faucet: 2 requests per 8 h, more with a GitHub login, and it explicitly asks AI agents not to use it.
  - **PoW faucet for CLI/agents**: `cargo install devnet-pow && devnet-pow mine -d 3 --reward 0.02 --no-infer -t 5000000000`.
  - RPC-provider faucets (Helius/QuickNode/Triton; needs a provider key). QuickNode web faucet: every 12 h, needs a small mainnet balance.
  - `solana-test-validator` (unlimited).
  - Note: MPC-derived Solana addresses must be funded the same way (send from a funded devnet key).

## What the human must provide

1. **NEAR AI Cloud API key** (cloud.near.ai, hackathon credits) for chat completions and `/v1/signature`. Attestation/models work without it.
2. **1Click Partner JWT** (partners.near-intents.org). Optional for public swaps (+25 bps without it), but **needed to test confidential quotes**.
3. **Funded mainnet wallet** for the real checkout demo: about $5 USDC on Base (or any chain) plus gas, or about 1 NEAR on `*.near`. The changelog lists a temporary $100 quote minimum on Tron only.
4. Optional **Agent API**: a `naa_` partner key (Partner Dashboard), a mainnet `*.near` owner account, and about 10 USDC on Base.
5. Optional **Phala Cloud account + API key** (only if going the Shade/dstack route; $20 free credit).
6. Optional OutLayer: nothing beyond testnet NEAR for the on-chain path (we have it). The HTTPS path needs a USDC Payment Key.
7. Devnet SOL: a GitHub login on faucet.solana.com, or let the agent run `devnet-pow`.
