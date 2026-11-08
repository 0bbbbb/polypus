import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export const NEARAI_BASE = process.env.NEARAI_BASE ?? "https://cloud-api.near.ai/v1";
export const NEARAI_MODEL = process.env.NEARAI_MODEL ?? "zai-org/GLM-5.1-FP8";

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

type Report = {
  gateway_attestation?: GatewayAttestation;
  model_attestations?: { model_name?: string; signing_address?: string; request_nonce?: string }[];
};

export async function fetchAttestationReport(nonce: string, model?: string): Promise<Report> {
  const url = new URL(`${NEARAI_BASE}/attestation/report`);
  url.searchParams.set("signing_algo", "ecdsa");
  url.searchParams.set("nonce", nonce);
  if (model) url.searchParams.set("model", model);
  const headers: Record<string, string> = {};
  if (process.env.NEARAI_API_KEY) headers.authorization = `Bearer ${process.env.NEARAI_API_KEY}`;
  const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`attestation HTTP ${res.status}`);
  return (await res.json()) as Report;
}

export function attestationNonceOk(report: Report, nonce: string): boolean {
  return report.gateway_attestation?.request_nonce?.toLowerCase() === nonce.toLowerCase();
}

export function attestationQuoteDigest(report: Report): string {
  const ga = report.gateway_attestation;
  const blob = JSON.stringify({
    signing: ga?.signing_address ?? "",
    nonce: ga?.request_nonce ?? "",
    quote_len: ga?.intel_quote?.length ?? 0,
  });
  return bytesToHex(sha256(new TextEncoder().encode(blob))).slice(0, 32);
}

// EIP-191 personal_sign recovery, which is how the gateway signs "<sha256(request)>:<sha256(response)>"
function recoverAddress(text: string, sigHex: string): string | null {
  try {
    const sig = hexToBytes(sigHex.replace(/^0x/, ""));
    const msg = new TextEncoder().encode(text);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
    const digest = keccak_256(new Uint8Array([...prefix, ...msg]));
    const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
    const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
    return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;
  } catch {
    return null;
  }
}

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

export type InferenceResult = {
  text: string;
  kind: "near-ai-cloud" | "template";
  proof?: InferenceProof;
  error?: string;
};

function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export async function explainCopyDecision(input: {
  side: string;
  symbol: string;
  quoteAmount: string;
  action: string;
  reason: string;
}): Promise<InferenceResult> {
  const verb = input.action === "skip" ? "Skipped" : input.action === "resize" ? "Copied (resized)" : "Copied";
  const template = `${verb} ${input.side} ${input.symbol} at ${input.quoteAmount}: ${input.reason}.`;
  const key = process.env.NEARAI_API_KEY;
  if (!key) return { text: template, kind: "template" };

  const nonce = randomNonceHex();
  const body = JSON.stringify({
    model: NEARAI_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a copy-trading agent. Hard guardrails already decided the action; you cannot change it. Reply with one plain sentence (max 25 words) explaining the decision to the follower. No markdown, no emoji.",
      },
      {
        role: "user",
        content: `Trader ${input.side} ${input.symbol}. Action: ${input.action}. Size: ${input.quoteAmount}. Guardrail result: ${input.reason}.`,
      },
    ],
    max_tokens: 600,
    temperature: 0.2,
  });
  try {
    const [res, report] = await Promise.all([
      fetch(`${NEARAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(60_000),
      }),
      fetchAttestationReport(nonce, NEARAI_MODEL).catch(() => null),
    ]);
    const raw = await res.text();
    if (!res.ok) return { text: template, kind: "template", error: `chat HTTP ${res.status}` };
    const data = JSON.parse(raw) as { id: string; model?: string; choices?: { message?: { content?: string } }[] };
    const text = stripThinking(data.choices?.[0]?.message?.content ?? "");
    if (!text) return { text: template, kind: "template", error: "empty completion" };
    const sres = await fetch(`${NEARAI_BASE}/signature/${data.id}?model=${encodeURIComponent(NEARAI_MODEL)}&signing_algo=ecdsa`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    const sig = (await sres.json()) as { text?: string; signature?: string; signing_address?: string };
    const [reqHash, respHash] = (sig.text ?? ":").split(":");
    const recovered = sig.signature && sig.text ? recoverAddress(sig.text, sig.signature) : null;
    const gatewayAddr = report?.gateway_attestation?.signing_address ?? "";
    const signingAddress = sig.signing_address ?? "";
    return {
      text,
      kind: "near-ai-cloud",
      proof: {
        chatId: data.id,
        model: data.model ?? NEARAI_MODEL,
        signingAddress,
        signature: sig.signature ?? "",
        signedText: sig.text ?? "",
        signatureValid:
          !!recovered &&
          recovered.toLowerCase() === signingAddress.toLowerCase() &&
          (!gatewayAddr || gatewayAddr.toLowerCase() === signingAddress.toLowerCase()),
        requestHashOk: reqHash === bytesToHex(sha256(new TextEncoder().encode(body))),
        responseHashOk: respHash === bytesToHex(sha256(new TextEncoder().encode(raw))),
        gatewayNonceOk: report ? attestationNonceOk(report, nonce) : false,
        gatewaySigningAddress: gatewayAddr,
        quoteDigest: report ? attestationQuoteDigest(report) : "",
      },
    };
  } catch (e) {
    return { text: template, kind: "template", error: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}
