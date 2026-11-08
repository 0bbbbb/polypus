import { truncate } from "../fx/formats";

export const short = truncate;

const groupThousands = (w: string) => w.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function account(id: string): string {
  if (/^[a-z0-9._-]+\.(testnet|near)$/i.test(id) && id.length <= 32) return id;
  return truncate(id.replace(/^0x/i, ""));
}

export function pct(bps: number, signed = true, digits = 2): string {
  const v = bps / 100;
  const s = Math.abs(v).toFixed(digits);
  if (!signed) return `${s}%`;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${s}%`;
}

export function usd(n: number, digits = 0): string {
  const [w, f] = Math.abs(n).toFixed(digits).split(".");
  return `${n < 0 ? "−" : ""}$${groupThousands(w!)}${f ? `.${f}` : ""}`;
}

export function compactUsd(n: number): string {
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e4) return `$${(n / 1e3).toFixed(1)}k`;
  return usd(n, n < 100 ? 2 : 0);
}

export function num(s: string | number, digits?: number): string {
  const v = typeof s === "number" ? s : Number(s);
  if (!Number.isFinite(v)) return String(s);
  const d = digits ?? (Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : 4);
  const [w, f] = Math.abs(v).toFixed(d).split(".");
  return `${v < 0 ? "−" : ""}${groupThousands(w!)}${f ? `.${f}` : ""}`;
}

export function near(priceNear: string): string {
  const v = Number(priceNear);
  if (!Number.isFinite(v)) return priceNear;
  return v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2).replace(/\.?0+$/, "") : String(+v.toFixed(3));
}

export const fromBase6 = (s: string) => Number(BigInt(s.replace(/\D/g, "") || "0")) / 1e6;
export const toBase6 = (n: number) => String(Math.round(n * 1e6));

export function ago(t: number | null | undefined, now = Date.now()): string {
  if (!t) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

export function clock(t: number, seconds = false): string {
  const d = new Date(t);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}${seconds ? `:${p2(d.getSeconds())}` : ""}`;
}

export function date(t: number): string {
  const d = new Date(t);
  return `${MON[d.getMonth()]} ${d.getDate()}`;
}

export function dateTime(t: number): string {
  const sameDay = new Date(t).toDateString() === new Date().toDateString();
  return sameDay ? clock(t, true) : `${date(t)} · ${clock(t)}`;
}

export function daysLeft(t: number, now = Date.now()): string {
  const d = Math.ceil((t - now) / 86_400_000);
  if (d <= 0) return "expired";
  return d === 1 ? "1 day left" : `${d} days left`;
}

export const nearAccountUrl = (a: string) => `https://testnet.nearblocks.io/address/${a}`;
export const solAddressUrl = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
