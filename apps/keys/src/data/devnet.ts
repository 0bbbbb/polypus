import type { RedactedSettlement } from "./types.js";

export async function loadDevnetSettlements(): Promise<RedactedSettlement[]> {
  try {
    const res = await fetch("./deployments/devnet.json");
    if (!res.ok) return [];
    const d = (await res.json()) as {
      network?: string;
      signatures?: { label: string; sig: string }[];
      explorer_base?: string;
    };
    if (d.network !== "devnet") return [];
    return (d.signatures ?? []).map((s, i) => ({
      signature: s.sig,
      slot: 0,
      blockTime: new Date().toISOString(),
      pool: "PoLYdUXuf78YC6aqE4qkmyFkfJi3mm773ZqJNECDYtj",
      feePayer: "",
      nullifiers: ["nf_devnet_redacted", "nf_devnet_redacted"],
      commitments: ["cm_devnet_redacted", "cm_devnet_redacted"],
      ciphertexts: ["ct_devnet_redacted", "ct_devnet_redacted"],
      provenance: {
        kind: "live",
        network: "solana-devnet",
        ref: (d.explorer_base ?? "").replace("{sig}", s.sig),
      },
    }));
  } catch {
    return [];
  }
}
