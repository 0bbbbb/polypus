export const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const PREFIXES = ["polyview1", "poly1", "cm_", "nf_", "ct_"] as const;

export function prefixOf(text: string) {
  return PREFIXES.find(p => text.startsWith(p)) ?? "";
}

export function charsetFor(text: string) {
  return text.startsWith("poly") && prefixOf(text) ? BECH32 : B58;
}

export function truncate(value: string) {
  const p = prefixOf(value), body = value.slice(p.length);
  return body.length <= 13 ? value : `${p}${body.slice(0, 6)}…${body.slice(-6)}`;
}

export function hashString(str: string) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
