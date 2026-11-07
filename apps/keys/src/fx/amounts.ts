/** Human-readable token amounts from base-unit strings (no floats on wire). */
export function formatUnits(amount: string, decimals: number, symbol: string): string {
  const raw = amount.replace(/\D/g, "") || "0";
  const n = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = n / scale;
  const frac = n % scale;
  if (frac === 0n) return `${whole} ${symbol}`;
  let fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fracStr.length > 4) fracStr = fracStr.slice(0, 4).replace(/0+$/, "");
  return `${whole}.${fracStr} ${symbol}`;
}

export function formatNearYocto(amount: string): string {
  const n = BigInt(amount);
  const near = Number(n) / 1e24;
  return `${near < 1 ? near.toFixed(3) : near.toFixed(2)} NEAR`;
}
