// Checks must stay in sync with circuits/copy_guardrail.
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export type Guardrails = {
  maxTradeQuote: string;
  allowedTokens: string[];
  dailyLossLimitBps: number;
  copyRatioBps: number;
};

export const DEFAULT_GUARDRAILS: Guardrails = {
  maxTradeQuote: "100000000",
  allowedTokens: ["JUP", "SOL"],
  dailyLossLimitBps: 500,
  copyRatioBps: 5000,
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

export function sizeCopy(
  trade: { quoteAmount?: unknown; base?: { symbol?: string } },
  g: Guardrails,
): { action: "copy" | "skip" | "resize"; reason: string; copiedQuote: bigint } {
  const sym = String(trade.base?.symbol ?? "");
  if (!g.allowedTokens.includes(sym)) {
    return { action: "skip", reason: `${sym} is not in your token allowlist`, copiedQuote: 0n };
  }
  const quote = BigInt(String(trade.quoteAmount ?? "0"));
  const max = BigInt(g.maxTradeQuote);
  const scaled = (quote * BigInt(g.copyRatioBps)) / 10_000n;
  if (scaled > max) {
    return { action: "resize", reason: `capped at your max of ${Number(max) / 1e6} pUSD per trade`, copiedQuote: max };
  }
  if (scaled === 0n) return { action: "skip", reason: "copy size rounds to zero", copiedQuote: 0n };
  return { action: "copy", reason: `${g.copyRatioBps / 100}% of the trader's size, within your limits`, copiedQuote: scaled };
}

export function validGuardrails(g: unknown): g is Guardrails {
  const x = g as Guardrails;
  return (
    !!x &&
    /^\d{1,15}$/.test(String(x.maxTradeQuote)) &&
    Array.isArray(x.allowedTokens) &&
    x.allowedTokens.length <= 8 &&
    x.allowedTokens.every(t => typeof t === "string" && /^[A-Z]{2,8}$/.test(t)) &&
    Number.isInteger(x.dailyLossLimitBps) &&
    x.dailyLossLimitBps >= 0 &&
    x.dailyLossLimitBps <= 10_000 &&
    Number.isInteger(x.copyRatioBps) &&
    x.copyRatioBps >= 100 &&
    x.copyRatioBps <= 20_000
  );
}

export function normalizeGuardrails(g: Guardrails): Guardrails {
  return {
    maxTradeQuote: String(BigInt(g.maxTradeQuote)),
    allowedTokens: [...new Set(g.allowedTokens)].sort(),
    dailyLossLimitBps: g.dailyLossLimitBps,
    copyRatioBps: g.copyRatioBps,
  };
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
