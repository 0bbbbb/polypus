import type { BookState } from "./book.js";
import type { Sym } from "./prices.js";

export type Series = [number, number][];
export type Decision = { side: "buy" | "sell"; sym: Sym; usd: number; qty: number; price: number };

const H = 3_600_000;

type Params = {
  kind: "trend" | "reversion";
  tokens: Sym[];
  sizeUsd: number;
  maxOpen: number;
  entry: Partial<Record<Sym, number>>;
  takeProfit: number;
  stopLoss: number;
  fastH: number;
  slowH: number;
  maxHoldH: number;
};

export const STRATEGIES: Record<string, Params> = {
  kestrel: {
    kind: "trend",
    tokens: ["SOL", "JUP"],
    sizeUsd: 300,
    maxOpen: 2,
    entry: { SOL: 0.015, JUP: 0.03 },
    takeProfit: 0.04,
    stopLoss: 0.025,
    fastH: 3,
    slowH: 24,
    maxHoldH: 48,
  },
  heron: {
    kind: "reversion",
    tokens: ["SOL", "BONK"],
    sizeUsd: 250,
    maxOpen: 2,
    entry: { SOL: 0.02, BONK: 0.035 },
    takeProfit: 0.03,
    stopLoss: 0.05,
    fastH: 3,
    slowH: 24,
    maxHoldH: 36,
  },
};

export const STYLE_BIO: Record<string, string> = {
  kestrel: "Trend-following on SOL and JUP: buys 3h momentum above the 24h average, exits on take-profit, stop-loss or trend break",
  heron: "Mean-reversion on SOL and BONK: buys dips below the 24h average, exits on reversion, take-profit, stop-loss or time stop",
};

export function priceAtOrBefore(series: Series, t: number): number | null {
  let lo = 0;
  let hi = series.length - 1;
  if (hi < 0 || series[0]![0] > t) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid]![0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return series[lo]![1];
}

function mean(series: Series, from: number, to: number): number | null {
  let sum = 0;
  let n = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const [t, p] = series[i]!;
    if (t > to) continue;
    if (t < from) break;
    sum += p;
    n++;
  }
  return n >= 3 ? sum / n : null;
}

export function decide(
  handle: string,
  book: BookState,
  series: Partial<Record<Sym, Series>>,
  now: number,
): Decision | null {
  const cfg = STRATEGIES[handle];
  if (!cfg) return null;
  const worth = (s: Sym) => (book.positions[s]?.qty ?? 0) * (series[s]?.at(-1)?.[1] ?? 0);
  const held = (Object.keys(book.positions) as Sym[]).filter(s => worth(s) >= 1);
  const open = held.filter(s => cfg.tokens.includes(s));

  for (const sym of held) {
    const s = series[sym];
    const pos = book.positions[sym]!;
    if (!s?.length) continue;
    const price = s[s.length - 1]![1];
    if (!cfg.tokens.includes(sym)) return { side: "sell", sym, qty: pos.qty, price, usd: pos.qty * price };
    const avg = pos.cost / pos.qty;
    const ret = price / avg - 1;
    const slow = mean(s, now - cfg.slowH * H, now);
    const heldH = pos.openedAt ? (now - pos.openedAt) / H : 0;
    const trendBroken = cfg.kind === "trend" && slow !== null && price < slow * 0.997;
    const reverted = cfg.kind === "reversion" && slow !== null && price >= slow;
    if (ret >= cfg.takeProfit || ret <= -cfg.stopLoss || trendBroken || reverted || heldH >= cfg.maxHoldH) {
      return { side: "sell", sym, qty: pos.qty, price, usd: pos.qty * price };
    }
  }

  if (open.length >= cfg.maxOpen || book.cash < cfg.sizeUsd) return null;
  for (const sym of cfg.tokens) {
    if (open.includes(sym)) continue;
    const s = series[sym];
    if (!s?.length) continue;
    const price = s[s.length - 1]![1];
    const slow = mean(s, now - cfg.slowH * H, now);
    const before = priceAtOrBefore(s, now - cfg.fastH * H);
    if (slow === null || before === null) continue;
    const threshold = cfg.entry[sym] ?? 0;
    const signal =
      cfg.kind === "trend"
        ? price / before - 1 >= threshold && price > slow
        : price / slow - 1 <= -threshold && price / before - 1 > -0.02;
    if (signal) return { side: "buy", sym, usd: cfg.sizeUsd, qty: cfg.sizeUsd / price, price };
  }
  return null;
}
