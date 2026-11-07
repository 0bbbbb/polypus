/** NEAR AI Cloud: keyless gateway attestation + optional private inference (NEARAI_API_KEY). */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export const NEARAI_BASE = process.env.NEARAI_BASE ?? "https://cloud-api.near.ai/v1";
export const NEARAI_MODEL = process.env.NEARAI_MODEL ?? "Qwen/Qwen3-8B";

export function randomNonceHex(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

export type GatewayAttestation = {
  signing_address?: string;
  request_nonce?: string;
  intel_quote?: string;
};

export async function fetchAttestationReport(nonce: string, model?: string): Promise<{
  gateway_attestation?: GatewayAttestation;
  model_attestations?: unknown[];
}> {
  const url = new URL(`${NEARAI_BASE}/attestation/report`);
  url.searchParams.set("signing_algo", "ecdsa");
  url.searchParams.set("nonce", nonce);
  if (model) {
    url.searchParams.set("model", model);
    url.searchParams.set("provider", "near");
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`attestation HTTP ${res.status}`);
  return (await res.json()) as {
    gateway_attestation?: GatewayAttestation;
    model_attestations?: unknown[];
  };
}

/** Freshness check: client nonce echoed in the gateway report. */
export function attestationNonceOk(report: { gateway_attestation?: GatewayAttestation }, nonce: string): boolean {
  const echoed = report.gateway_attestation?.request_nonce;
  if (!echoed) return false;
  return echoed.toLowerCase() === nonce.toLowerCase();
}

export function attestationQuoteDigest(report: { gateway_attestation?: GatewayAttestation }): string {
  const ga = report.gateway_attestation;
  const blob = JSON.stringify({
    signing: ga?.signing_address ?? "",
    nonce: ga?.request_nonce ?? "",
    quote_len: ga?.intel_quote?.length ?? 0,
  });
  return bytesToHex(sha256(new TextEncoder().encode(blob))).slice(0, 32);
}

export type InferenceResult = {
  text: string;
  kind: "near-ai-cloud" | "simulated";
  chatId?: string;
  quoteDigest?: string;
  checks: { label: string; ok: boolean; detail?: string }[];
};

export async function explainCopyDecision(input: {
  side: string;
  symbol: string;
  quoteAmount: string;
  action: string;
  reason: string;
}): Promise<InferenceResult> {
  const key = process.env.NEARAI_API_KEY;
  const template = `Decision: ${input.action} ${input.side} ${input.symbol} (${input.quoteAmount} quote units). ${input.reason} (SIMULATED inference — set NEARAI_API_KEY for NEAR AI Cloud TEE model).`;
  if (!key) {
    return {
      text: template,
      kind: "simulated",
      checks: [{ label: "NEARAI_API_KEY", ok: false, detail: "using template" }],
    };
  }

  const nonce = randomNonceHex();
  const checks: InferenceResult["checks"] = [];
  let quoteDigest = "";
  try {
    const report = await fetchAttestationReport(nonce, NEARAI_MODEL);
    const ok = attestationNonceOk(report, nonce);
    checks.push({ label: "Gateway nonce echoed", ok, detail: report.gateway_attestation?.signing_address });
    quoteDigest = attestationQuoteDigest(report);
    checks.push({ label: "Quote digest", ok: !!quoteDigest, detail: quoteDigest });
  } catch (e) {
    checks.push({ label: "Gateway attestation fetch", ok: false, detail: String(e) });
    return { text: template, kind: "simulated", checks };
  }

  const prompt = `You are a copy-trade agent inside a TEE. In one short sentence, explain why you ${input.action} a ${input.side} ${input.symbol} trade capped at ${input.quoteAmount} quote units. Mention guardrails only in general terms; never reveal secrets.`;
  const body = {
    model: NEARAI_MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 80,
    temperature: 0.1,
  };
  const res = await fetch(`${NEARAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-no-aliasing": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    checks.push({ label: "Chat completion", ok: false, detail: `HTTP ${res.status}` });
    return { text: template, kind: "simulated", quoteDigest, checks };
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; id?: string };
  const text = data.choices?.[0]?.message?.content?.trim() || template;
  checks.push({ label: "Chat completion", ok: true, detail: data.id });
  return { text, kind: "near-ai-cloud", chatId: data.id, quoteDigest, checks };
}
