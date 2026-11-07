import type { CheckoutQuote } from "../data/types.js";

const BASE = "https://1click.chaindefuser.com";

/** Confidential quote probe (requires ONECLICK_PARTNER_JWT server-side; browser stays dry-only). */
export async function confidentialQuoteProbe(params: {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  partnerJwt: string;
}): Promise<{ ok: boolean; detail: string }> {
  const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: params.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: params.destinationAsset,
    amount: params.amount,
    refundTo: params.recipient,
    refundType: "DESTINATION_CHAIN",
    recipient: params.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline,
    confidentiality: "basic",
  };
  const res = await fetch(`${BASE}/v0/quote`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.partnerJwt}`,
    },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true, detail: "Partner JWT accepted for confidential dry quote" };
  const err = await res.text();
  return { ok: false, detail: err.slice(0, 120) || `HTTP ${res.status}` };
}

/** Real mainnet 1Click dry quote (no wallet spend). */
export async function dryQuote(params: {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
}): Promise<CheckoutQuote | null> {
  const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: params.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: params.destinationAsset,
    amount: params.amount,
    refundTo: "alice.near",
    refundType: "DESTINATION_CHAIN",
    recipient: params.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline,
    confidentiality: "public",
  };
  const res = await fetch(`${BASE}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = await res.json() as { quote?: Record<string, string>; quoteRequest?: { dry?: boolean } };
  const q = data.quote;
  if (!q) return null;
  const timeEstimate = Number(q.timeEstimate ?? q.time_estimate ?? 0);
  return {
    originAsset: params.originAsset,
    originChain: params.originAsset.includes("eth") ? "eth" : params.originAsset.includes("sol") ? "sol" : "near",
    amountIn: q.amountIn ?? params.amount,
    amountInFormatted: q.amountInFormatted ?? "",
    destinationAsset: params.destinationAsset,
    amountOut: q.amountOut ?? "",
    amountOutFormatted: q.amountOutFormatted ?? "",
    timeEstimateSec: Number.isFinite(timeEstimate) ? timeEstimate : undefined,
    dry: true,
    raw: data,
  };
}
