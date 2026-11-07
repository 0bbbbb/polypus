import { truncate } from "./formats.js";

const NEAR_ACCOUNT = /^[a-z0-9._-]+\.testnet$/i;

export function displayNearAccount(id: string): string {
  return NEAR_ACCOUNT.test(id) ? id : truncate(id);
}

export function displayEvmAddress(addr: string): string {
  const raw = addr.replace(/^0x/i, "");
  if (raw.length <= 13) return raw;
  return `${raw.slice(0, 6)}…${raw.slice(-6)}`;
}

export function isPlaceholderKey(k: string): boolean {
  return /1111|Simulated|simulated-signature|AttestorSim|AgentPubkey|local-runner|pending$/i.test(k) || k.length < 20;
}

export function displayAttestorRef(signingKey: string, measurement: string, kind: string): string {
  if (kind === "near-ai-cloud" || measurement.startsWith("nearai")) return "NEAR AI gateway";
  if (!isPlaceholderKey(signingKey)) return truncate(signingKey);
  if (measurement && !/local|simulated|pending/i.test(measurement)) return truncate(measurement);
  return "Attestor (simulated scan)";
}

export function formatAgentNote(d: {
  action: string;
  side: string;
  symbol: string;
  quoteHuman: string;
  inferenceSimulated?: boolean;
}): { line: string; inferenceChip: "live" | "simulated" } {
  const line = `${capitalize(d.action)} ${d.side} ${d.symbol} · ${d.quoteHuman} — within max notional and allowlist.`;
  return { line, inferenceChip: d.inferenceSimulated ? "simulated" : "live" };
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
