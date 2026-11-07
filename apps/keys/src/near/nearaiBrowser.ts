/** Keyless NEAR AI gateway attestation for the browser attestation panel. */
export type GatewaySlice = {
  ok: boolean;
  signingAddress: string;
  quoteDigest: string;
  nonce: string;
  fetchedAt: string;
};

export async function fetchGatewaySlice(): Promise<GatewaySlice> {
  const nonce = [...crypto.getRandomValues(new Uint8Array(32))]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  const url = `https://cloud-api.near.ai/v1/attestation/report?signing_algo=ecdsa&nonce=${nonce}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { gateway_attestation?: { signing_address?: string; request_nonce?: string } };
    const ga = data.gateway_attestation;
    const ok = (ga?.request_nonce ?? "").toLowerCase() === nonce.toLowerCase();
    const signingAddress = ga?.signing_address ?? "";
    const quoteDigest = await digestText(JSON.stringify({ signingAddress, nonce }));
    return { ok, signingAddress, quoteDigest, nonce, fetchedAt: new Date().toISOString() };
  } catch {
    return { ok: false, signingAddress: "", quoteDigest: "", nonce, fetchedAt: new Date().toISOString() };
  }
}

async function digestText(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
