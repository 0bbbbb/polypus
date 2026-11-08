export const TOKENS = {
  SOL: { decimals: 9, gecko: "solana", mint: "So11111111111111111111111111111111111111112" },
  JUP: { decimals: 6, gecko: "jupiter-exchange-solana", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  BONK: { decimals: 5, gecko: "bonk", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
} as const;
export type Sym = keyof typeof TOKENS;
export const SYMS = Object.keys(TOKENS) as Sym[];

export type PriceSnapshot = Record<Sym, number> & { at: number; source: string };

let cache: PriceSnapshot | null = null;

async function fromGecko(): Promise<PriceSnapshot> {
  const ids = SYMS.map(s => TOKENS[s].gecko).join(",");
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const j = (await r.json()) as Record<string, { usd: number }>;
  const out = { at: Date.now(), source: "coingecko" } as PriceSnapshot;
  for (const s of SYMS) {
    const v = j[TOKENS[s].gecko]?.usd;
    if (!v) throw new Error(`coingecko missing ${s}`);
    out[s] = v;
  }
  return out;
}

async function fromJupiter(): Promise<PriceSnapshot> {
  const ids = SYMS.map(s => TOKENS[s].mint).join(",");
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`jupiter ${r.status}`);
  const j = (await r.json()) as Record<string, { usdPrice: number }>;
  const out = { at: Date.now(), source: "jupiter" } as PriceSnapshot;
  for (const s of SYMS) {
    const v = j[TOKENS[s].mint]?.usdPrice;
    if (!v) throw new Error(`jupiter missing ${s}`);
    out[s] = v;
  }
  return out;
}

export async function getPrices(maxAgeMs = 30_000): Promise<PriceSnapshot> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache;
  try {
    cache = await fromJupiter();
  } catch {
    try {
      cache = await fromGecko();
    } catch (e) {
      if (cache) return cache;
      throw e;
    }
  }
  return cache;
}

export async function priceHistory(sym: Sym, days: number): Promise<[number, number][]> {
  const r = await fetch(
    `https://api.coingecko.com/api/v3/coins/${TOKENS[sym].gecko}/market_chart?vs_currency=usd&days=${days}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!r.ok) throw new Error(`coingecko history ${sym} ${r.status}`);
  const j = (await r.json()) as { prices: [number, number][] };
  return j.prices;
}

export function priceAt(series: [number, number][], t: number): number {
  let best = series[0]!;
  for (const p of series) {
    if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
  }
  return best[1];
}
