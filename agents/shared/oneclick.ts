const BASE = "https://1click.chaindefuser.com";

export const PAY_OPTIONS = [
  { id: "usdc-base", label: "USDC", chain: "Base", originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6 },
  { id: "eth", label: "ETH", chain: "Ethereum", originAsset: "nep141:eth.omft.near", decimals: 18 },
  { id: "sol", label: "SOL", chain: "Solana", originAsset: "nep141:sol.omft.near", decimals: 9 },
  { id: "btc", label: "BTC", chain: "Bitcoin", originAsset: "nep141:btc.omft.near", decimals: 8 },
];

type Raw = {
  quote?: { amountIn: string; amountInFormatted: string; amountInUsd?: string; amountOutFormatted: string; timeEstimate?: number };
  message?: string;
};

export async function dryQuote(originAsset: string, wnearYocto: string, confidential: boolean): Promise<Raw & { status: number }> {
  const jwt = process.env.ONECLICK_PARTNER_JWT;
  const body = {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:wrap.near",
    amount: wnearYocto,
    refundTo: "polypus.near",
    refundType: "INTENTS",
    recipient: "polypus.near",
    recipientType: "INTENTS",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    confidentiality: confidential ? "basic" : "public",
  };
  const r = await fetch(`${BASE}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { ...((await r.json().catch(() => ({}))) as Raw), status: r.status };
}
