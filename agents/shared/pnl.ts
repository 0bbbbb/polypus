import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58 } from "@scure/base";

export type PnlStatement = {
  v: 1;
  trader: string;
  pnl_bps: number;
  trade_count: number;
  window_start: string;
  window_end: string;
  pool: string;
  scanned_to_slot: number;
  notes_scanned: number;
  code_hash: string;
  attestation_kind: "simulated" | "outlayer-tdx";
};

export function canonicalStatement(s: PnlStatement): string {
  const keys = Object.keys(s).sort() as (keyof PnlStatement)[];
  const o: Record<string, unknown> = {};
  for (const k of keys) o[k] = s[k];
  return JSON.stringify(o);
}

export function signStatement(secretKey: Uint8Array, statement: string): string {
  const hash = sha256(new TextEncoder().encode(statement));
  const sig = ed25519.sign(hash, secretKey.slice(0, 32));
  return base58.encode(sig);
}

import fs from "node:fs";
import path from "node:path";

export function loadOrCreateAttestorSecret(file: string): Uint8Array {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    return Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")).secretKey);
  }
  const sk = ed25519.utils.randomSecretKey();
  fs.writeFileSync(file, JSON.stringify({ secretKey: [...sk] }));
  return sk;
}
