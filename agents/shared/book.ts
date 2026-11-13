import { TOKENS, type Sym, type PriceSnapshot } from "./prices.js";

export const QUOTE = { symbol: "pUSD", decimals: 6 } as const;
export const BOOK_USD = 2000;

export type TradeRecord = {
  v: 2;
  id: string;
  trader: string;
  epoch: number;
  side: "buy" | "sell";
  base: { symbol: Sym; decimals: number };
  quote: { symbol: "pUSD"; decimals: 6 };
  baseAmount: string;
  quoteAmount: string;
  price: string;
  executedAt: string;
  backfilled?: boolean;
  provenance: { kind: "paper"; priceSource: string };
};

export function toUnits(amount: number, decimals: number): string {
  return BigInt(Math.round(amount * 10 ** decimals)).toString();
}

export function fromUnits(units: string, decimals: number): number {
  return Number(BigInt(units)) / 10 ** decimals;
}

export type Position = { qty: number; cost: number; openedAt?: number };
export type BookState = { positions: Partial<Record<Sym, Position>>; cash: number };

export function replay(trades: TradeRecord[]): BookState {
  const st: BookState = { positions: {}, cash: BOOK_USD };
  for (const t of trades) applyTrade(st, t);
  return st;
}

function applyTrade(st: BookState, t: TradeRecord): number {
  const sym = t.base.symbol;
  const qty = fromUnits(t.baseAmount, t.base.decimals);
  const usd = fromUnits(t.quoteAmount, QUOTE.decimals);
  const p = st.positions[sym] ?? { qty: 0, cost: 0 };
  let realized = 0;
  if (t.side === "buy") {
    if (p.qty === 0) p.openedAt = Date.parse(t.executedAt);
    p.qty += qty;
    p.cost += usd;
    st.cash -= usd;
  } else {
    const sold = Math.min(qty, p.qty);
    const avg = p.qty > 0 ? p.cost / p.qty : 0;
    realized = usd - avg * sold;
    p.cost -= avg * sold;
    p.qty -= sold;
    st.cash += usd;
    if (p.qty < 1e-12) {
      p.qty = 0;
      p.cost = 0;
      p.openedAt = undefined;
    }
  }
  st.positions[sym] = p;
  return realized;
}

export function makeRecord(
  trader: string,
  epoch: number,
  d: { side: "buy" | "sell"; sym: Sym; usd: number; qty: number; price: number },
  executedAt: Date,
  priceSource: string,
  backfilled = false,
): TradeRecord {
  const dec = TOKENS[d.sym].decimals;
  const rec: TradeRecord = {
    v: 2,
    id: `${trader.split("-")[0]}-${executedAt.getTime().toString(36)}`,
    trader,
    epoch,
    side: d.side,
    base: { symbol: d.sym, decimals: dec },
    quote: { symbol: "pUSD", decimals: 6 },
    baseAmount: toUnits(d.qty, dec),
    quoteAmount: toUnits(d.usd, 6),
    price: d.price < 0.01 ? d.price.toPrecision(4) : d.price.toFixed(d.price < 1 ? 5 : 2),
    executedAt: executedAt.toISOString(),
    provenance: { kind: "paper", priceSource },
  };
  if (backfilled) rec.backfilled = true;
  return rec;
}

export type PnlResult = {
  pnlUsd: number;
  pnlBps: number;
  tradeCount: number;
  volumeUsd: number;
  winRateBps: number;
  equity: { t: number; bps: number }[];
  windowStart: number;
  windowEnd: number;
};

export function computePnl(trades: TradeRecord[], marks: Partial<PriceSnapshot>, now = Date.now()): PnlResult {
  const sorted = [...trades].sort((a, b) => Date.parse(a.executedAt) - Date.parse(b.executedAt));
  const st: BookState = { positions: {}, cash: BOOK_USD };
  const last: Partial<Record<Sym, number>> = {};
  let realized = 0;
  let wins = 0;
  let sells = 0;
  let volume = 0;
  const equity: { t: number; bps: number }[] = [];
  const mtm = (px: Partial<Record<Sym, number>>) => {
    let u = 0;
    for (const [s, p] of Object.entries(st.positions) as [Sym, Position][]) {
      if (p.qty > 0) u += p.qty * (px[s] ?? last[s] ?? 0) - p.cost;
    }
    return realized + u;
  };
  const t0 = sorted.length ? Date.parse(sorted[0]!.executedAt) : now;
  equity.push({ t: t0 - 60_000, bps: 0 });
  for (const t of sorted) {
    last[t.base.symbol] = Number(t.price);
    volume += fromUnits(t.quoteAmount, 6);
    const r = applyTrade(st, t);
    if (t.side === "sell") {
      sells++;
      if (r > 0) wins++;
      realized += r;
    }
    equity.push({ t: Date.parse(t.executedAt), bps: Math.round((mtm({}) / BOOK_USD) * 1e4) });
  }
  const finalPnl = mtm(marks as Partial<Record<Sym, number>>);
  equity.push({ t: now, bps: Math.round((finalPnl / BOOK_USD) * 1e4) });
  return {
    pnlUsd: finalPnl,
    pnlBps: Math.round((finalPnl / BOOK_USD) * 1e4),
    tradeCount: sorted.length,
    volumeUsd: Math.round(volume * 100) / 100,
    winRateBps: sells ? Math.round((wins / sells) * 1e4) : 0,
    equity: downsample(equity, 64),
    windowStart: t0,
    windowEnd: now,
  };
}

function downsample<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (n - 1))]!);
  return out;
}
