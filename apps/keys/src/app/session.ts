/**
 * Per-trader story state. In memory only: every fresh visit starts LOCKED.
 * LOCKED -> KEY_BOUGHT (buy / demo unlock) -> DECRYPTED (decode finished) -> COPIED (agent copy shown).
 */
export type Stage = "locked" | "key_bought" | "decrypted" | "copied";

const ORDER: Stage[] = ["locked", "key_bought", "decrypted", "copied"];
const stages = new Map<string, Stage>();
const payIds = new Map<string, string>();

export function stageOf(trader: string): Stage {
  return stages.get(trader) ?? "locked";
}

/** Only moves forward; returns false if `next` is not after the current stage. */
export function advance(trader: string, next: Stage): boolean {
  if (ORDER.indexOf(next) <= ORDER.indexOf(stageOf(trader))) return false;
  stages.set(trader, next);
  return true;
}

export function isUnlocked(stage: Stage): boolean {
  return stage !== "locked";
}

export function anyUnlocked(): string | null {
  for (const [trader, s] of stages) if (isUnlocked(s)) return trader;
  return null;
}

/** `?demo=1` in the query string or inside the hash route. */
export function demoRequested(): boolean {
  const hashQuery = location.hash.split("?")[1] ?? "";
  return new URLSearchParams(location.search).get("demo") === "1" || new URLSearchParams(hashQuery).get("demo") === "1";
}

export function getPayOptionId(trader: string): string | null {
  return payIds.get(trader) ?? null;
}

export function setPayOptionId(trader: string, id: string): void {
  payIds.set(trader, id);
}
