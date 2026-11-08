import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { attestationQuoteDigest, fetchAttestationReport, randomNonceHex, attestationNonceOk } from "./nearai.js";

export type TeeKind = "simulated" | "nearai-gateway";

export async function agentAttestationBinding(agentPublicKeyB58: string): Promise<{
  digest: string;
  kind: TeeKind;
  quoteDigest: string;
  checks: { label: string; ok: boolean; detail?: string }[];
}> {
  const nonce = randomNonceHex();
  try {
    const report = await fetchAttestationReport(nonce);
    const ok = attestationNonceOk(report, nonce);
    const quoteDigest = attestationQuoteDigest(report);
    const digestBytes = sha256(
      new TextEncoder().encode(`polypus-keys-agent|${agentPublicKeyB58}|${quoteDigest}|${nonce}`),
    );
    const digest = `nearai-gw-${bytesToHex(digestBytes).slice(0, 24)}`;
    return {
      digest,
      kind: ok ? "nearai-gateway" : "simulated",
      quoteDigest,
      checks: [
        { label: "NEAR AI gateway attestation", ok, detail: report.gateway_attestation?.signing_address },
        { label: "Agent pubkey bound", ok: true, detail: agentPublicKeyB58.slice(0, 12) + "…" },
      ],
    };
  } catch (e) {
    return {
      digest: "simulated-tee-v0",
      kind: "simulated",
      quoteDigest: "",
      checks: [{ label: "NEAR AI gateway attestation", ok: false, detail: String(e) }],
    };
  }
}
