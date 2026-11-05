import type { AgentStatus, AttestedPnl, RedactedSettlement, Subscription, Trader, TradeRecord } from "./types.js";

/** Demo fixtures — used when live RPC is off or as fallback. Labelled RECORDED in UI. */
export const REGISTRY_ID = "polypus-keys-18e5.testnet";

const ALICE_SHIELD =
  "poly1q8rln83648xzns23vxms90m53dlr07dthdeuctlfvy0fn6huhc58ee5t4erm7cf9r3knvqsxxmymqzunyf5t28636nv3e7eh7fw9scec6pxwcacz869hh9e8jygl4lkl";
const BOB_SHIELD =
  "poly1q8e6vz3ydskm09f4p46tsxw3k6t7ze8z32pgy2zfar87zfw6lws84lhzq5nr3v855y62yje8trq6qx775n53c3lqwyrcsqcva2raws6mlcjpvevckdsczrpyf5s2umyr";

const attSim = (signer: string) => ({
  kind: "simulated" as const,
  signerPublicKey: signer,
  nonce: "a".repeat(64),
  measurement: "local-runner-v0",
  quoteDigest: "b".repeat(64),
  checks: [{ label: "TEE vendor", ok: false, detail: "Running locally — OutLayer path documented in README" }],
  fetchedAt: new Date().toISOString(),
  provenance: { kind: "simulated" as const, reason: "NEAR AI / OutLayer credentials not set in this browser session" },
});

export const RECORDED_TRADERS: Trader[] = [
  {
    account: "alice-18e5.testnet",
    handle: "kestrel",
    shieldedAddress: ALICE_SHIELD,
    solanaAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    derivationPath: "solana-1",
    currentEpoch: 3,
    price: { amount: "500000000000000000000000", token: { symbol: "NEAR", decimals: 24 }, periodDays: 30 },
    subscribers: 2,
    bio: "Devnet RFQ desk · pUSD/pSOL shielded swaps",
    pnl: {
      trader: "alice-18e5.testnet",
      pnlBps: 3842,
      windowStart: "2026-11-01T00:00:00Z",
      windowEnd: "2026-11-05T20:00:00Z",
      tradeCount: 14,
      statementHash: "c3d4e5f6".padEnd(64, "0"),
      signature: "simulated-signature-not-on-chain",
      attestation: attSim("AttestorSimKey111111111111111111111111111"),
      provenance: { kind: "recorded", network: "near-testnet", recordedAt: "2026-11-05T20:00:00Z" },
    },
  },
  {
    account: "bob-18e5.testnet",
    handle: "heron",
    shieldedAddress: BOB_SHIELD,
    solanaAddress: "7EqQdE8Z9V1K2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2g3h4",
    derivationPath: "solana-1",
    currentEpoch: 1,
    price: { amount: "300000000000000000000000", token: { symbol: "NEAR", decimals: 24 }, periodDays: 30 },
    subscribers: 0,
    pnl: {
      trader: "bob-18e5.testnet",
      pnlBps: 1205,
      windowStart: "2026-11-01T00:00:00Z",
      windowEnd: "2026-11-05T20:00:00Z",
      tradeCount: 6,
      statementHash: "d4e5f6a7".padEnd(64, "0"),
      signature: "simulated",
      attestation: attSim("AttestorSimKey222222222222222222222222222"),
      provenance: { kind: "recorded", network: "near-testnet", recordedAt: "2026-11-05T20:00:00Z" },
    },
  },
];

export const RECORDED_TRADES: TradeRecord[] = [
  {
    id: "t-001",
    trader: "alice-18e5.testnet",
    epoch: 3,
    side: "buy",
    base: { symbol: "SOL", decimals: 9, intentsAssetId: "nep141:sol.omft.near" },
    quote: { symbol: "pUSD", decimals: 6 },
    baseAmount: "1370000000",
    quoteAmount: "250000000",
    price: "182.4817518",
    executedAt: "2026-11-05T18:22:11Z",
    settlements: ["5K7x…simulatedSigForDemoPurposesOnlyDoNotUseOnMainnet111111111111111111111111111111111111111"],
    intentsQuote: { dry: true, amountOut: "1370000000" },
    provenance: { kind: "recorded", network: "solana-devnet", recordedAt: "2026-11-05T20:00:00Z" },
  },
  {
    id: "t-002",
    trader: "alice-18e5.testnet",
    epoch: 3,
    side: "sell",
    base: { symbol: "JUP", decimals: 6 },
    quote: { symbol: "pUSD", decimals: 6 },
    baseAmount: "23997000000",
    quoteAmount: "24850000000",
    price: "1.035546",
    executedAt: "2026-11-05T19:01:44Z",
    settlements: ["3mN9…simulatedSigForDemoPurposesOnlyDoNotUseOnMainnet222222222222222222222222222222222222222"],
    provenance: { kind: "recorded", network: "solana-devnet", recordedAt: "2026-11-05T20:00:00Z" },
  },
];

export const RECORDED_SETTLEMENTS: RedactedSettlement[] = [
  {
    signature: "5K7x…redactedSettlementSigDemoOnly333333333333333333333333333333333333333333333333333333333",
    slot: 412_884_221,
    blockTime: "2026-11-05T18:22:08Z",
    pool: "PoLY111111111111111111111111111111111111111",
    feePayer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    nullifiers: ["nf_demo111111111111111111111111111111111111111", "nf_demo222222222222222222222222222222222222222"],
    commitments: ["cm_demo111111111111111111111111111111111111111", "cm_demo222222222222222222222222222222222222222"],
    ciphertexts: ["ct_demo111111111111111111111111111111111111111", "ct_demo222222222222222222222222222222222222222"],
    computeUnits: 224_891,
    provenance: { kind: "recorded", network: "solana-devnet", recordedAt: "2026-11-05T20:00:00Z" },
  },
];

export const RECORDED_SUB: Subscription = {
  id: "sub-carol-alice",
  follower: "carol-18e5.testnet",
  trader: "alice-18e5.testnet",
  agentPublicKey: "AgentPubkeySimulatedForDemoOnly111111111111111111111",
  agentAttestation: attSim("AgentPubkeySimulatedForDemoOnly111111111111111111111"),
  startsAt: "2026-11-04T12:00:00Z",
  expiresAt: "2026-12-04T12:00:00Z",
  status: "active",
  guardrails: { maxTradeQuote: "250000000", allowedTokens: ["SOL", "JUP"], dailyLossLimitBps: 500, copyRatioBps: 8000 },
  lastSealedEpoch: 3,
  payment: {
    method: "near-testnet-deposit",
    provenance: { kind: "recorded", network: "near-testnet", recordedAt: "2026-11-05T20:00:00Z" },
  },
};

export const RECORDED_AGENT: AgentStatus = {
  follower: "carol-18e5.testnet",
  agentPublicKey: RECORDED_SUB.agentPublicKey,
  attestation: RECORDED_SUB.agentAttestation,
  online: true,
  heldEpochs: [2, 3],
  dailyPnlBps: 312,
  decisions: [
    {
      at: "2026-11-05T18:22:15Z",
      sourceTradeId: "t-001",
      action: "resized",
      reason: "maxTradeQuote 250 USDC",
      explanation: {
        text: "Copied buy SOL within your 250 pUSD cap (SIMULATED inference — set NEARAI_API_KEY for TEE model).",
        model: "simulated",
        attested: false,
        provenance: { kind: "simulated", reason: "No NEAR AI API key" },
      },
      copiedTrade: RECORDED_TRADES[0],
    },
  ],
  provenance: { kind: "simulated", reason: "Agent runs locally; OutLayer deployment documented" },
};

export function pnlPercent(bps: number): string {
  const sign = bps >= 0 ? "+" : "";
  return `${sign}${(bps / 100).toFixed(2)}%`;
}
