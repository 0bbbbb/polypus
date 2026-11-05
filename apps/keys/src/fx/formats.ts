// Display formats for every address, hash and ID on the site (see docs/POLYPUS_DESIGN.md, "Address formats").
// Solana-side values are base58; Polypus shielded addresses are bech32m with the HRP "poly";
// field elements (commitments, nullifiers) and ciphertext excerpts are base58 with a typed prefix.
export const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const PREFIXES = ["polyview1", "poly1", "cm_", "nf_", "ct_"] as const;

export function prefixOf(text: string) {
  return PREFIXES.find(p => text.startsWith(p)) ?? "";
}

/** Alphabet the scramble effect should draw from so glyph noise never leaves the value's own charset. */
export function charsetFor(text: string) {
  return text.startsWith("poly") && prefixOf(text) ? BECH32 : B58;
}

/** first 6 … last 6 of the payload; a typed prefix is always shown whole. */
export function truncate(value: string) {
  const p = prefixOf(value), body = value.slice(p.length);
  return body.length <= 13 ? value : `${p}${body.slice(0, 6)}…${body.slice(-6)}`;
}

function rng(seed: number) {
  let x = seed >>> 0 || 0x2545f491;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}
const draw = (abc: string, n: number, r: () => number) => Array.from({ length: n }, () => abc[(r() * abc.length) | 0]).join("");

/** 32-byte field element or hash rendered in base58 (43–44 chars). */
export const fieldB58 = (prefix: "cm_" | "nf_" | "ct_", seed: number) => `${prefix}${draw(B58, 44, rng(seed))}`;
/** Solana transaction signature (64 bytes → 87–88 base58 chars). */
export const signature = (seed: number) => draw(B58, 88, rng(seed));
/** Polypus shielded address: "poly1" + 75 bech32 chars (43-byte payload + 6-char checksum). */
export const shielded = (seed: number) => `poly1${draw(BECH32, 75, rng(seed))}`;

export function hashString(str: string) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
