/** Human-readable token amounts from base-unit strings (no floats on wire). */
export function groupThousands(whole: bigint | number | string): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatUnits(amount: string, decimals: number, symbol: string): string {
  const raw = amount.replace(/\D/g, "") || "0";
  const n = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = groupThousands(n / scale);
  const frac = n % scale;
  if (frac === 0n) return `${whole} ${symbol}`;
  let fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fracStr.length > 4) fracStr = fracStr.slice(0, 4).replace(/0+$/, "");
  return `${whole}.${fracStr} ${symbol}`;
}

/** "182.4817518" -> "$182.48" */
export function formatUsdPrice(price: string): string {
  const v = Number(price);
  if (!Number.isFinite(v)) return price;
  const [whole, frac] = v.toFixed(2).split(".");
  return `$${groupThousands(whole!)}.${frac}`;
}

/** "2026-11-05T18:22:11Z" -> "18:22 UTC" */
export function formatUtcTime(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

export function formatNearYocto(amount: string): string {
  const n = BigInt(amount);
  const near = Number(n) / 1e24;
  return `${near < 1 ? near.toFixed(3) : near.toFixed(2)} NEAR`;
}
