const DEMO_KEY = "polypus:demo-unlock";
const KEY_BOUGHT = (trader: string) => `polypus:key-bought:${trader}`;
const PAY_ID = (trader: string) => `polypus:pay:${trader}`;

export function isDemoUnlocked(): boolean {
  return sessionStorage.getItem(DEMO_KEY) === "1";
}

export function setDemoUnlocked(on: boolean): void {
  if (on) sessionStorage.setItem(DEMO_KEY, "1");
  else sessionStorage.removeItem(DEMO_KEY);
}

export function isKeyBought(trader: string): boolean {
  return sessionStorage.getItem(KEY_BOUGHT(trader)) === "1";
}

export function setKeyBought(trader: string): void {
  sessionStorage.setItem(KEY_BOUGHT(trader), "1");
}

export function getPayOptionId(trader: string): string | null {
  return sessionStorage.getItem(PAY_ID(trader));
}

export function setPayOptionId(trader: string, id: string): void {
  sessionStorage.setItem(PAY_ID(trader), id);
}
