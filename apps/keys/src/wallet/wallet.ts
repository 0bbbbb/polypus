import type { ModuleState, WalletSelector, WalletModuleFactory } from "@near-wallet-selector/core";

export const REGISTRY = "polypus-keys-18e5.testnet";

export type WalletCall = {
  receiverId: string;
  methodName: string;
  args: object;
  gas: string;
  deposit: string;
};

export type WalletOption = {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  type: string;
  available: boolean;
};

const BLURB: Record<string, string> = {
  "my-near-wallet": "Web wallet. Opens a new page to approve.",
  "meteor-wallet": "Browser extension or web app.",
  "intear-wallet": "Lightweight web wallet for NEAR.",
  "here-wallet": "Mobile wallet. Approve with a QR code.",
};

let selectorP: Promise<WalletSelector> | null = null;

export function getSelector(): Promise<WalletSelector> {
  selectorP ??= (async () => {
    const [{ setupWalletSelector }, mods] = await Promise.all([
      import("@near-wallet-selector/core"),
      Promise.all([
        load(() => import("@near-wallet-selector/my-near-wallet").then(m => m.setupMyNearWallet())),
        load(() => import("@near-wallet-selector/meteor-wallet").then(m => m.setupMeteorWallet())),
        load(() => import("@near-wallet-selector/intear-wallet").then(m => m.setupIntearWallet())),
        load(() => import("@near-wallet-selector/here-wallet").then(m => m.setupHereWallet())),
      ]),
    ]);
    return setupWalletSelector({ network: "testnet", modules: mods.filter((m): m is WalletModuleFactory => !!m) });
  })();
  selectorP.catch(() => { selectorP = null; });
  return selectorP;
}

async function load(f: () => Promise<WalletModuleFactory>): Promise<WalletModuleFactory | null> {
  try {
    return await f();
  } catch (e) {
    console.warn("wallet module failed to load", e);
    return null;
  }
}

export function hasWalletSession(): boolean {
  try {
    return !!localStorage.getItem("near-wallet-selector:selectedWalletId") || /[?&](account_id|transactionHashes|errorCode)=/.test(location.search);
  } catch {
    return false;
  }
}

export async function listWallets(): Promise<WalletOption[]> {
  const s = await getSelector();
  return s.store.getState().modules.map((m: ModuleState) => ({
    id: m.id,
    name: m.metadata.name,
    description: BLURB[m.id] ?? m.metadata.description ?? "",
    iconUrl: m.metadata.iconUrl,
    type: m.type,
    available: m.metadata.available,
  }));
}

export async function connect(id: string): Promise<string | null> {
  const s = await getSelector();
  const wallet = await s.wallet(id);
  // browser wallets take { contractId, methodNames }; injected/hardware variants also accept `accounts`
  const params = { contractId: REGISTRY, methodNames: [] as string[], accounts: [] as never[] };
  const accounts = await (wallet.signIn as (p: typeof params) => Promise<{ accountId: string }[] | void>)(params);
  return (accounts && accounts[0]?.accountId) ?? activeAccount(s);
}

export async function signOut(): Promise<void> {
  const s = await getSelector();
  if (!s.isSignedIn()) return;
  const wallet = await s.wallet();
  await wallet.signOut();
}

function activeAccount(s: WalletSelector): string | null {
  const acc = s.store.getState().accounts.find(a => a.active) ?? s.store.getState().accounts[0];
  return acc?.accountId ?? null;
}

export async function currentAccount(): Promise<string | null> {
  return activeAccount(await getSelector());
}

export async function onAccountChange(cb: (account: string | null) => void): Promise<() => void> {
  const s = await getSelector();
  let last = activeAccount(s);
  const sub = s.store.observable.subscribe(() => {
    const now = activeAccount(s);
    if (now !== last) { last = now; cb(now); }
  });
  return () => sub.unsubscribe();
}

export async function signAndSend(call: WalletCall, callbackUrl?: string): Promise<string | null> {
  const [s, { actionCreators }] = await Promise.all([getSelector(), import("@near-wallet-selector/core")]);
  const wallet = await s.wallet();
  const action = actionCreators.functionCall(call.methodName, call.args, BigInt(call.gas), BigInt(call.deposit));
  const outcome = await (wallet.signAndSendTransaction as (p: object) => Promise<unknown>)({
    receiverId: call.receiverId,
    actions: [action],
    callbackUrl,
  });
  return txHashOf(outcome);
}

function txHashOf(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== "object") return null;
  const o = outcome as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
  return o.transaction?.hash ?? o.transaction_outcome?.id ?? null;
}

export function takeRedirectResult(): { txHash?: string; error?: string } | null {
  const q = new URLSearchParams(location.search);
  const tx = q.get("transactionHashes"), err = q.get("errorCode"), msg = q.get("errorMessage");
  const had = tx || err || q.has("account_id") || q.has("all_keys") || q.has("public_key");
  if (!had) return null;
  for (const k of ["transactionHashes", "errorCode", "errorMessage", "account_id", "all_keys", "public_key"]) q.delete(k);
  const qs = q.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
  return { txHash: tx?.split(",").pop() || undefined, error: err ? (msg ?? err) : undefined };
}
