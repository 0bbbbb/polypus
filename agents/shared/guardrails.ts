/** Follower guardrails (wire hash → registry subscribe; checks mirror Noir copy_guardrail). */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export type Guardrails = {
  maxTradeQuote: string;
  allowedTokens: string[];
  dailyLossLimitBps: number;
  copyRatioBps: number;
};

export const DEFAULT_GUARDRAILS: Guardrails = {
  maxTradeQuote: "250000000",
  allowedTokens: ["SOL", "JUP"],
  dailyLossLimitBps: 500,
  copyRatioBps: 8000,
};

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

export function guardrailsCanonical(g: Guardrails = DEFAULT_GUARDRAILS): string {
  return JSON.stringify(sortKeys(g));
}

export function guardrailsHash(g: Guardrails = DEFAULT_GUARDRAILS): string {
  const h = bytesToHex(sha256(new TextEncoder().encode(guardrailsCanonical(g))));
  return `sha256-${h.slice(0, 32)}`;
}

export function evaluateCopy(
  trade: { quoteAmount?: unknown; base?: { symbol?: string } },
  g: Guardrails = DEFAULT_GUARDRAILS,
): { action: "copy" | "skip" | "resize"; reason: string } {
  const sym = String(trade.base?.symbol ?? "");
  if (!g.allowedTokens.includes(sym)) {
    return { action: "skip", reason: `token ${sym} not in allowlist` };
  }
  const quote = BigInt(String(trade.quoteAmount ?? "0"));
  const max = BigInt(g.maxTradeQuote);
  const scaled = (quote * BigInt(g.copyRatioBps)) / 10_000n;
  if (scaled > max) {
    return { action: "resize", reason: `copy_ratio would exceed max ${g.maxTradeQuote}` };
  }
  if (quote > max) {
    return { action: "resize", reason: `trade quote ${quote} > max ${max}` };
  }
  return { action: "copy", reason: "within max notional and allowlist (copy_guardrail)" };
}
