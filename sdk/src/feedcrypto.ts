/** Feed encryption for Polypus Keys (INTERFACES.md). UNAUDITED hackathon demo. */
import { x25519 } from "@noble/curves/ed25519";
import { ed25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { base64, base58 } from "@scure/base";

export type TradeRecordWire = Record<string, unknown>;

export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

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

export function randomEpochKey(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

export function encryptFeedRecord(
  trader: string,
  epoch: number,
  epochKey: Uint8Array,
  record: TradeRecordWire,
): string {
  const pt = new TextEncoder().encode(canonicalJson(record));
  const nonce = randomNonce24();
  const aad = new TextEncoder().encode(`polypus-keys/feed/v1|${trader}|${epoch}`);
  const cipher = xchacha20poly1305(epochKey, nonce, aad);
  const ct = cipher.encrypt(pt);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return base64.encode(out);
}

export function decryptFeedRecord(
  trader: string,
  epoch: number,
  epochKey: Uint8Array,
  b64: string,
): TradeRecordWire {
  const raw = base64.decode(b64);
  const nonce = raw.slice(0, 24);
  const ct = raw.slice(24);
  const aad = new TextEncoder().encode(`polypus-keys/feed/v1|${trader}|${epoch}`);
  const cipher = xchacha20poly1305(epochKey, nonce, aad);
  const pt = cipher.decrypt(ct);
  return JSON.parse(new TextDecoder().decode(pt)) as TradeRecordWire;
}

export function sealEpochKey(
  trader: string,
  follower: string,
  epoch: number,
  agentPublicKeyB58: string,
  epochKey: Uint8Array,
): string {
  const agentPk = base58.decode(agentPublicKeyB58);
  const esk = x25519.utils.randomSecretKey();
  const epk = x25519.getPublicKey(esk);
  const shared = x25519.getSharedSecret(esk, agentPk);
  const salt = concat(epk, agentPk);
  const k = hkdf(sha256, shared, salt, "polypus-keys/seal/v1", 32);
  const nonce = randomNonce24();
  const aad = new TextEncoder().encode(`polypus-keys/seal/v1|${trader}|${follower}|${epoch}`);
  const cipher = xchacha20poly1305(k, nonce, aad);
  const ct = cipher.encrypt(epochKey);
  const out = new Uint8Array(epk.length + nonce.length + ct.length);
  out.set(epk, 0);
  out.set(nonce, epk.length);
  out.set(ct, epk.length + nonce.length);
  return base64.encode(out);
}

export function unsealEpochKey(
  trader: string,
  follower: string,
  epoch: number,
  agentSecretKey: Uint8Array,
  sealedB64: string,
): Uint8Array {
  const raw = base64.decode(sealedB64);
  const epk = raw.slice(0, 32);
  const nonce = raw.slice(32, 56);
  const ct = raw.slice(56);
  const agentPk = x25519.getPublicKey(agentSecretKey);
  const shared = x25519.getSharedSecret(agentSecretKey, epk);
  const salt = concat(epk, agentPk);
  const k = hkdf(sha256, shared, salt, "polypus-keys/seal/v1", 32);
  const aad = new TextEncoder().encode(`polypus-keys/seal/v1|${trader}|${follower}|${epoch}`);
  const cipher = xchacha20poly1305(k, nonce, aad);
  return cipher.decrypt(ct);
}

export function generateAgentKeypair(): { publicKey: string; secretKey: Uint8Array } {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = base58.encode(x25519.getPublicKey(secretKey));
  return { publicKey, secretKey };
}

export function signPnlStatement(attestorSecret: Uint8Array, statement: string): string {
  const hash = sha256(new TextEncoder().encode(statement));
  const sig = ed25519.sign(hash, attestorSecret.slice(0, 32));
  return base58.encode(sig);
}

export function pnlStatementHash(statement: string): string {
  const h = sha256(new TextEncoder().encode(statement));
  return [...h].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomNonce24(): Uint8Array {
  const n = new Uint8Array(24);
  crypto.getRandomValues(n);
  return n;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.length + b.length);
  o.set(a, 0);
  o.set(b, a.length);
  return o;
}
