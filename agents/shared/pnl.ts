import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58 } from "@scure/base";
import fs from "node:fs";
import path from "node:path";

export type PnlStatement = {
  v: 2;
  trader: string;
  pnl_bps: number;
  trade_count: number;
  volume_usd: number;
  win_rate_bps: number;
  equity: [number, number][];
  epochs: number[];
  feed_seq: number;
  marks: Record<string, number>;
  book_usd: number;
  window_start: string;
  window_end: string;
  pool: string;
  code_hash: string;
  gateway_quote_digest: string;
  attestation_kind: "simulated" | "outlayer-tdx";
};

export function canonicalStatement(s: Record<string, unknown>): string {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(s).sort()) o[k] = s[k];
  return JSON.stringify(o);
}

export function signStatement(secretKey: Uint8Array, statement: string): string {
  const hash = sha256(new TextEncoder().encode(statement));
  return base58.encode(ed25519.sign(hash, secretKey.slice(0, 32)));
}

export function verifyStatement(pubkeyB58: string, statement: string, sigB58: string): boolean {
  try {
    return ed25519.verify(base58.decode(sigB58), sha256(new TextEncoder().encode(statement)), base58.decode(pubkeyB58));
  } catch {
    return false;
  }
}

export function loadOrCreateAttestorSecret(file: string): Uint8Array {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    return Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")).secretKey);
  }
  const sk = ed25519.utils.randomSecretKey();
  fs.writeFileSync(file, JSON.stringify({ secretKey: [...sk] }), { mode: 0o600 });
  return sk;
}

export function attestorPublicKey(sk: Uint8Array): string {
  return base58.encode(ed25519.getPublicKey(sk.slice(0, 32)));
}
