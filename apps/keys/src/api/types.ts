// Wire types for agents/api (proxied at /api). Times are unix milliseconds.

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
  lastTradeAt: number | null;
  live: boolean;
  pnl: PnlView | null;
};

export type FeedRow = {
  seq: number;
  epoch: number;
  postedAt: number;
  ciphertextPreview: string;
  ciphertextLen: number;
  tx?: TxRef;
};

export type TraderDetail = TraderSummary & {
  feed: FeedRow[];
};

export type DecryptedTrade = {
  seq: number;
  id: string;
  side: "buy" | "sell";
  symbol: string;
  baseAmount: string;
  quoteAmount: string;
  price: string;
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
  traderQuote: string;
  copiedQuote: string; // "0" when skipped
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
  agentManaged: boolean;
  guardrails: Guardrails | null;
  guardrailsHashOnChain: string;
  guardrailsActive: boolean;
  /** Solana devnet address the agent copies from (Chain Signatures derived) */
  copyWallet: string;
  copyWalletSol: number | null;
  mpcPath: string;
  decrypted: DecryptedTrade[];
  copies: CopyRecord[];
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

export type StreamEvent =
  | { type: "activity"; item: ActivityItem }
  | { type: "traders"; traders: TraderSummary[] }
  | { type: "timeline"; timeline: Timeline }
  | { type: "portfolio"; follower: string };

export const API_BASE = "/api";
