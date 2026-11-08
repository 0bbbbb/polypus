/**
 * Wire types for the local Polypus Keys API (agents/api, http://127.0.0.1:8787, proxied by Vite at /api).
 * Shared by the server (agents/api/server.ts) and the app. All times are unix milliseconds.
 */

export type Chain = "near" | "solana";

export type TxRef = {
  chain: Chain;
  hash: string;
  url: string;
  label: string;
  at?: number;
};

export type Guardrails = {
  /** max copied notional per trade, pUSD base units (6 decimals) */
  maxTradeQuote: string;
  allowedTokens: string[];
  dailyLossLimitBps: number;
  /** copy size as bps of the trader's notional (10000 = 1:1) */
  copyRatioBps: number;
};

export type EquityPoint = { t: number; bps: number };

/** Parsed attested PnL statement (signed by the attestor, verified on-chain by publish_pnl). */
export type PnlView = {
  pnlBps: number;
  tradeCount: number;
  volumeUsd: number;
  winRateBps: number;
  equity: EquityPoint[];
  windowStart: number;
  windowEnd: number;
  feedSeq: number;
  attestationKind: string;
  codeHash: string;
  signature: string;
  statement: string;
  publishedAt: number;
  tx?: TxRef;
};

export type TraderSummary = {
  account: string;
  handle: string;
  bio: string;
  style: string;
  priceYocto: string;
  priceNear: string;
  periodDays: number;
  subscriberCount: number;
  currentEpoch: number;
  solanaAddress: string;
  shieldedAddress: string;
  attestorPubkey: string;
  attestorDigest: string;
  feedLen: number;
  /** posted_at of the newest feed entry */
  lastTradeAt: number | null;
  /** trader-node is running and posting */
  live: boolean;
  pnl: PnlView | null;
};

/** One on-chain feed entry. Ciphertext only; plaintext comes from the follower agent after unlock. */
export type FeedRow = {
  seq: number;
  epoch: number;
  postedAt: number;
  ciphertextPreview: string;
  ciphertextLen: number;
  tx?: TxRef;
};

export type TraderDetail = TraderSummary & {
  feed: FeedRow[]; // newest first, up to 60
};

export type DecryptedTrade = {
  seq: number;
  id: string;
  side: "buy" | "sell";
  symbol: string;
  baseAmount: string; // human, e.g. "1.25"
  quoteAmount: string; // human pUSD, e.g. "112.40"
  price: string; // human USD
  executedAt: number;
  postedAt: number;
  backfilled: boolean;
  feedTx?: TxRef;
};

/** NEAR AI Cloud per-request proof: gateway ECDSA signature over sha256(request):sha256(response). */
export type InferenceProof = {
  chatId: string;
  model: string;
  signingAddress: string;
  signature: string;
  signedText: string;
  signatureValid: boolean;
  requestHashOk: boolean;
  responseHashOk: boolean;
  gatewayNonceOk: boolean;
  gatewaySigningAddress: string;
  quoteDigest: string;
};

export type CopyAction = "copy" | "resize" | "skip";

export type CopyRecord = {
  seq: number;
  tradeId: string;
  side: "buy" | "sell";
  symbol: string;
  traderQuote: string; // human pUSD
  copiedQuote: string; // human pUSD, "0" when skipped
  action: CopyAction;
  reason: string;
  explanation: string;
  explanationKind: "near-ai-cloud" | "template";
  inference?: InferenceProof;
  status: "pending" | "signing" | "submitted" | "confirmed" | "skipped" | "failed";
  at: number;
  solanaTx?: TxRef;
  mpcTx?: TxRef;
  error?: string;
};

export type TeeView = {
  kind: "nearai-gateway" | "simulated";
  digest: string;
  quoteDigest: string;
  signingAddress?: string;
  checkedAt: number;
  inference: "near-ai-cloud" | "template";
};

export type StepKey = "subscribed" | "sealed" | "decrypted" | "copied";
export type StepStatus = "waiting" | "active" | "done" | "error";

export type TimelineStep = {
  key: StepKey;
  label: string;
  status: StepStatus;
  detail: string;
  at?: number;
  txs: TxRef[];
};

export type Timeline = {
  follower: string;
  trader: string;
  agentPubkey: string;
  steps: TimelineStep[];
  complete: boolean;
};

export type KeyHolding = {
  trader: string;
  handle: string;
  status: "active" | "cancelled" | "expired";
  expiresAt: number;
  agentPubkey: string;
  /** the local follower agent holds the secret for this pubkey */
  agentManaged: boolean;
  guardrails: Guardrails | null;
  guardrailsHashOnChain: string;
  /** agent's guardrails hash matches the on-chain commitment */
  guardrailsActive: boolean;
  /** Solana devnet address the agent copies from (Chain Signatures derived) */
  copyWallet: string;
  copyWalletSol: number | null;
  mpcPath: string;
  decrypted: DecryptedTrade[]; // newest first
  copies: CopyRecord[]; // newest first
  timeline: Timeline;
};

export type Portfolio = {
  follower: string;
  isDemo: boolean;
  tee: TeeView;
  keys: KeyHolding[];
};

export type HealthView = {
  ok: boolean;
  network: "testnet";
  registry: string;
  rpc: string;
  services: Record<"trader" | "follower" | "attestor", { up: boolean; lastTickAt: number | null; note?: string }>;
  demo: { account: string; available: boolean; balanceNear: number; reason?: string };
  agentOperator: string;
  mpcContract: string;
};

export type ProvisionRequest = { follower: string; trader: string; guardrails?: Guardrails };
export type ProvisionResponse = {
  agentPubkey: string;
  agentAttestationDigest: string;
  guardrailsHash: string;
  guardrails: Guardrails;
  /** exact call for the wallet to sign */
  call: {
    receiverId: string;
    methodName: "subscribe";
    args: { trader: string; agent_pubkey: string; agent_attestation_digest: string; guardrails_hash: string };
    gas: string;
    deposit: string;
  };
};

export type DemoSubscribeRequest = { trader: string; guardrails?: Guardrails };
export type DemoSubscribeResponse = { follower: string; agentPubkey: string; tx: TxRef };

export type NotifyRequest = { follower: string; trader: string; txHash: string };

export type GuardrailsUpdateRequest = { follower: string; trader: string; guardrails: Guardrails };
export type GuardrailsUpdateResponse = {
  guardrailsHash: string;
  /** set when the API signed (demo account); otherwise the wallet must sign `call` */
  tx?: TxRef;
  call?: {
    receiverId: string;
    methodName: "update_guardrails";
    args: { trader: string; guardrails_hash: string };
    gas: string;
    deposit: "0";
  };
};

export type ActivityItem = {
  id: string;
  at: number;
  kind: "trade" | "seal" | "subscribe" | "copy" | "pnl" | "guardrails" | "fund";
  trader?: string;
  follower?: string;
  text: string;
  tx?: TxRef;
};

export type ProofView = {
  registry: { account: string; deployTx: TxRef; methods: string[] };
  network: { near: string; solana: string; rpc: string };
  traders: {
    account: string;
    handle: string;
    attestorPubkey: string;
    attestorDigest: string;
    pnlStatement: string;
    pnlSignature: string;
    pnlSignatureValid?: boolean;
    pnlTx?: TxRef;
  }[];
  chainSignatures: { mpcContract: string; operator: string; domainId: number; pathPrefix: string };
  solanaProgram: { id: string; url: string };
  tee: TeeView;
  recent: TxRef[];
};

export type PayOption = { id: string; label: string; chain: string; originAsset: string; decimals: number };

/** Mainnet 1Click dry quote (no funds move): how much of `payWith` buys the key price in wNEAR. */
export type IntentsQuote = {
  trader: string;
  payWith: PayOption;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  amountOutFormatted: string;
  timeEstimateSec: number;
  confidential: boolean;
  partner: boolean;
  dry: true;
  quotedAt: number;
};

export type IntentsStatus = {
  options: PayOption[];
  partner: boolean;
  confidential: boolean;
  checkedAt: number;
  detail: string;
};

export type Prices = { SOL: number; JUP: number; BONK: number; at: number; source: string };

/** SSE `GET /api/stream` emits `event: <type>` with JSON data. */
export type StreamEvent =
  | { type: "activity"; item: ActivityItem }
  | { type: "traders"; traders: TraderSummary[] }
  | { type: "timeline"; timeline: Timeline }
  | { type: "portfolio"; follower: string };

/**
 * Routes:
 *   GET  /api/health                       HealthView
 *   GET  /api/traders                      TraderSummary[]
 *   GET  /api/traders/:account             TraderDetail
 *   GET  /api/prices                       Prices
 *   GET  /api/portfolio/:follower          Portfolio
 *   GET  /api/timeline?follower=&trader=   Timeline
 *   GET  /api/activity                     ActivityItem[] (newest first, 40)
 *   GET  /api/proof                        ProofView
 *   GET  /api/stream?follower=             SSE of StreamEvent
 *   GET  /api/intents                      IntentsStatus
 *   GET  /api/quote?trader=&pay=<optionId> IntentsQuote
 *   POST /api/agent/provision              ProvisionRequest -> ProvisionResponse
 *   POST /api/subscriptions/notify         NotifyRequest -> { ok: true, tx: TxRef }
 *   POST /api/demo/subscribe               DemoSubscribeRequest -> DemoSubscribeResponse (rate limited, 429 {error, retryAfterSec})
 *   POST /api/guardrails                   GuardrailsUpdateRequest -> GuardrailsUpdateResponse
 * Errors: non-2xx with { error: string }.
 */
export const API_BASE = "/api";
