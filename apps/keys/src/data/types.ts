// Shared data contract for Polypus Keys. The app, the NEAR registry contract
// (contracts/keys-registry), the PnL attestor and the copy-trade agent (agents/)
// all produce or consume these shapes. Change them here first.
//
// Value formats (never mix them up in the UI):
//   SolanaAddress  base58, 32 bytes (32–44 chars)
//   SolanaSig      base58, 64 bytes (87–88 chars)
//   NearAccountId  named (alice.testnet, keys.polypus.testnet) or 64-hex implicit
//   NearTxHash     base58, 32 bytes (43–44 chars)
//   PolyAddress    bech32m "poly1q…" v1 payload, 133 chars (ADR-0003)
//   PolyViewKey    bech32m "polyview1q…", 170 chars; never leaves the holder/TEE
//   FieldB58       "cm_" | "nf_" | "ct_" + base58 of a 32-byte value
//   EvmAddress     0x-hex; ONLY for EVM payment sources in checkout
// Amounts are decimal strings in base units plus `decimals`, never floats on the wire.

export type SolanaAddress = string;
export type SolanaSig = string;
export type NearAccountId = string;
export type NearTxHash = string;
export type PolyAddress = string;
export type FieldB58 = string;
export type Hex = string;

/** Where a fact comes from. Every value rendered in the UI carries one, so mocks are always labelled. */
export type Provenance =
  | { kind: "live"; network: "near-testnet" | "near-mainnet" | "solana-devnet"; ref?: string }
  | { kind: "recorded"; network: "near-testnet" | "near-mainnet" | "solana-devnet"; recordedAt: string; ref?: string }
  | { kind: "simulated"; reason: string };

export interface TokenRef {
  symbol: string;          // "USDC", "SOL"
  decimals: number;
  /** Polypus devnet test mint (base58) the shielded pool is keyed by. */
  mint?: SolanaAddress;
  /** NEAR Intents asset id, e.g. "nep141:wrap.near" (for 1Click quotes/pricing). */
  intentsAssetId?: string;
}

/** TEE attestation as shown in the UI "Verified" panel. */
export interface AttestationReport {
  kind: "near-ai-cloud" | "dstack-tdx" | "simulated";
  /** Public key (ed25519, base58) the enclave signs reports with; bound into report_data. */
  signerPublicKey: string;
  /** Nonce we sent, hex. */
  nonce: Hex;
  /** Measurement / compose hash / model id, depending on kind. */
  measurement: string;
  /** Raw quote or a hash of it, for "view raw". */
  quoteDigest: Hex;
  checks: { label: string; ok: boolean; detail?: string }[];
  fetchedAt: string;       // ISO
  provenance: Provenance;
}

/** PnL published by the attestor. Computed from the trader's viewing key inside the TEE. */
export interface AttestedPnl {
  trader: NearAccountId;
  /** Realized + marked PnL in basis points over the window, signed integer. */
  pnlBps: number;
  windowStart: string;     // ISO
  windowEnd: string;
  tradeCount: number;
  /** sha256 over canonical JSON of the statement, hex. */
  statementHash: Hex;
  /** ed25519 signature by attestation.signerPublicKey over statementHash, base58. */
  signature: string;
  attestation: AttestationReport;
  /** NEAR tx that recorded it on the registry. */
  nearTx?: NearTxHash;
  provenance: Provenance;
}

export interface Trader {
  account: NearAccountId;          // "alice.testnet"
  handle: string;                  // display name
  shieldedAddress: PolyAddress;
  /** Solana address derived for this NEAR account via Chain Signatures (ed25519 domain). */
  solanaAddress: SolanaAddress;
  derivationPath: string;
  /** Epoch-key feed public metadata. */
  currentEpoch: number;
  price: { amount: string; token: TokenRef; periodDays: number };
  subscribers: number;
  pnl: AttestedPnl;
  bio?: string;
}

/** What anyone sees on-chain for one settlement: no amounts, no tokens, no counterparties. */
export interface RedactedSettlement {
  signature: SolanaSig;
  slot: number;
  blockTime: string;
  pool: SolanaAddress;
  feePayer: SolanaAddress;
  nullifiers: [FieldB58, FieldB58];
  commitments: [FieldB58, FieldB58];
  ciphertexts: [FieldB58, FieldB58];   // ct_ digests
  computeUnits?: number;
  provenance: Provenance;
}

export type Side = "buy" | "sell";

/** A trade record after decryption (by the trader, a key-holding agent, or the attestor). */
export interface TradeRecord {
  id: string;
  trader: NearAccountId;
  epoch: number;
  side: Side;
  base: TokenRef;
  quote: TokenRef;
  baseAmount: string;
  quoteAmount: string;
  /** Price in quote per base, decimal string. */
  price: string;
  executedAt: string;
  /** Polypus settlement(s) on Solana devnet that carried this trade. */
  settlements: SolanaSig[];
  /** 1Click quote used for pricing/execution, if any. */
  intentsQuote?: { quoteId?: string; depositAddress?: string; dry: boolean; amountOut: string };
  provenance: Provenance;
}

/** Feed entry as published on the NEAR registry: opaque to everyone without the epoch key. */
export interface EncryptedFeedEntry {
  trader: NearAccountId;
  epoch: number;
  seq: number;
  /** base64 of nonce(24) || XChaCha20-Poly1305 ciphertext of canonical JSON TradeRecord. */
  ciphertext: string;
  postedAt: string;
  nearTx?: NearTxHash;
}

export interface Guardrails {
  maxTradeQuote: string;           // max quote-token amount per copied trade (base units)
  allowedTokens: string[];         // symbols
  dailyLossLimitBps: number;
  copyRatioBps: number;            // 10000 = 1:1 relative sizing
}

export interface Subscription {
  id: string;
  follower: NearAccountId;
  trader: NearAccountId;
  /** X25519 public key (base58) generated inside the follower agent's TEE; epoch keys are sealed to it. */
  agentPublicKey: string;
  agentAttestation: AttestationReport;
  startsAt: string;
  expiresAt: string;
  status: "active" | "cancelled" | "expired";
  payment: CheckoutReceipt;
  guardrails: Guardrails;
  /** Last epoch whose key was sealed to this agent. Unsubscribing stops this from advancing. */
  lastSealedEpoch: number;
  nearTx?: NearTxHash;
}

export interface CheckoutQuote {
  originAsset: string;             // intents asset id, e.g. "nep141:eth.omft.near"
  originChain: string;             // "eth", "sol", "near", "base", ...
  amountIn: string;
  amountInFormatted: string;
  destinationAsset: string;
  amountOut: string;
  amountOutFormatted: string;
  depositAddress?: string;         // chain-native format of originChain (0x only for EVM)
  deadline?: string;
  timeEstimateSec?: number;
  dry: boolean;
  raw?: unknown;
}

export interface CheckoutReceipt {
  method: "near-testnet-deposit" | "intents-1click";
  quote?: CheckoutQuote;
  /** Intents status if 1Click was used. */
  intentsStatus?: "PENDING_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED" | "DRY";
  nearTx?: NearTxHash;
  provenance: Provenance;
}

export interface AgentDecision {
  at: string;
  sourceTradeId: string;
  action: "copied" | "resized" | "skipped";
  reason: string;                  // guardrail that fired, deterministic
  /** Natural-language explanation from NEAR AI Cloud private inference (or labelled simulated). */
  explanation?: { text: string; model: string; attested: boolean; provenance: Provenance };
  copiedTrade?: TradeRecord;
}

export interface AgentStatus {
  follower: NearAccountId;
  agentPublicKey: string;
  attestation: AttestationReport;
  online: boolean;
  heldEpochs: number[];
  dailyPnlBps: number;
  decisions: AgentDecision[];
  provenance: Provenance;
}
