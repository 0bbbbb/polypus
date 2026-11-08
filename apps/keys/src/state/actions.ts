import { api, ApiError } from "../api/client";
import type { Guardrails, StepKey, Timeline, TimelineStep, TxRef } from "../api/types";
import * as wallet from "../wallet/wallet";
import { DEMO_ACCOUNT, getState, notify, refreshPortfolio, refreshTimeline, setIdentity, setState, tlKey } from "./store";

export const DEFAULT_GUARDRAILS: Guardrails = {
  maxTradeQuote: "250000000",
  allowedTokens: ["SOL", "JUP"],
  dailyLossLimitBps: 500,
  copyRatioBps: 8000,
};
export const TOKENS = ["SOL", "JUP", "BONK"] as const;

const PENDING_KEY = "polypus.pending";
type Pending = { kind: "subscribe" | "guardrails"; follower: string; trader: string; at: number };

function savePending(p: Pending) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch {}
}
function takePending(): Pending | null {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as Pending | null;
    localStorage.removeItem(PENDING_KEY);
    return v && Date.now() - v.at < 30 * 60_000 ? v : null;
  } catch {
    return null;
  }
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return `Demo is busy. Try again in ${e.retryAfterSec ?? 30}s.`;
    if (e.offline) return "Local API offline. Run npm run dev:all.";
    if (!/rate limit|^\s*\{/i.test(e.message)) return e.message;
  }
  let m = e instanceof Error ? e.message : String(e);
  if (m.trimStart().startsWith("{")) {
    try { m = JSON.parse(m).error?.message ?? m; } catch {}
  }
  if (/rate limit/i.test(m)) return "NEAR RPC is rate limiting right now. Try again in a minute.";
  if (/reject|cancel|denied|closed/i.test(m)) return "Request cancelled in wallet.";
  return m || "Something went wrong.";
}

export function openWalletModal() { setState({ walletModal: true }); }
export function closeWalletModal() { setState({ walletModal: false }); }

let pendingAfterConnect: (() => void) | null = null;

export async function connectWallet(id: string): Promise<void> {
  const account = await wallet.connect(id);
  if (account) onWalletAccount(account);
  closeWalletModal();
  const next = pendingAfterConnect;
  pendingAfterConnect = null;
  next?.();
}

export async function signOutWallet() {
  try { await wallet.signOut(); } catch (e) { console.warn(e); }
  setState({ wallet: null });
  if (getState().identity?.kind === "wallet") setIdentity(null);
}

export function exitDemo() {
  if (getState().identity?.kind === "demo") setIdentity(getState().wallet ? { kind: "wallet", account: getState().wallet! } : null);
}

function onWalletAccount(account: string | null) {
  setState({ wallet: account });
  if (account) setIdentity({ kind: "wallet", account });
  else if (getState().identity?.kind === "wallet") setIdentity(null);
}

export async function initWallet() {
  if (!wallet.hasWalletSession()) return;
  try {
    // the selector consumes ?account_id= itself, so read our params only after it's ready
    const account = await wallet.currentAccount();
    if (account) onWalletAccount(account);
    wallet.onAccountChange(onWalletAccount);
  } catch (e) {
    console.warn("wallet init failed", e);
  }
  const res = wallet.takeRedirectResult();
  const pending = takePending();
  if (!res || !pending) return;
  if (res.error) { notify(res.error === "userRejected" ? "Transaction cancelled in wallet." : `Wallet: ${res.error}`, "error"); return; }
  if (!res.txHash) return;
  if (pending.kind === "subscribe") await finishSubscribe(pending.follower, pending.trader, res.txHash);
  else { notify("Guardrails update sent."); refreshPortfolio(); }
}

function startTimeline(follower: string, trader: string, tx: TxRef) {
  const labels: [StepKey, string][] = [["subscribed", "Subscribed"], ["sealed", "Key sealed to agent"], ["decrypted", "Trades decrypted"], ["copied", "Copied on Solana"]];
  const steps: TimelineStep[] = labels.map(([key, label], i) =>
    i === 0
      ? { key, label, status: "active", detail: "Waiting for the registry to confirm", txs: [tx], at: Date.now() }
      : { key, label, status: "waiting", detail: "", txs: [] },
  );
  const t: Timeline = { follower, trader, agentPubkey: "", complete: false, steps };
  setState(s => ({ timelines: { ...s.timelines, [tlKey(follower, trader)]: t } }));
}

async function finishSubscribe(follower: string, trader: string, txHash: string): Promise<TxRef | undefined> {
  setIdentity({ kind: "wallet", account: follower });
  try {
    const r = await api.notify({ follower, trader, txHash });
    startTimeline(follower, trader, r.tx);
    notify("Key bought. Sealing it to your agent.", "ok", r.tx);
    return r.tx;
  } catch (e) {
    notify(errText(e), "error");
  } finally {
    refreshTimeline(follower, trader);
    refreshPortfolio();
  }
}

export async function buyWithWallet(trader: string, guardrails: Guardrails): Promise<void> {
  const account = getState().wallet;
  if (!account) {
    pendingAfterConnect = () => { buyWithWallet(trader, guardrails).catch(e => notify(errText(e), "error")); };
    openWalletModal();
    return;
  }
  const prov = await api.provision({ follower: account, trader, guardrails });
  savePending({ kind: "subscribe", follower: account, trader, at: Date.now() });
  const hash = await wallet.signAndSend(prov.call, location.href);
  if (!hash) return;
  takePending();
  await finishSubscribe(account, trader, hash);
}

export async function buyWithDemo(trader: string, guardrails: Guardrails): Promise<TxRef> {
  const r = await api.demoSubscribe({ trader, guardrails });
  setIdentity({ kind: "demo", account: r.follower || DEMO_ACCOUNT });
  startTimeline(r.follower || DEMO_ACCOUNT, trader, r.tx);
  refreshTimeline(r.follower || DEMO_ACCOUNT, trader);
  refreshPortfolio();
  return r.tx;
}

export async function renewKey(trader: string, guardrails: Guardrails): Promise<void> {
  if (getState().identity?.kind === "demo") await buyWithDemo(trader, guardrails);
  else await buyWithWallet(trader, guardrails);
}

export async function saveGuardrails(trader: string, guardrails: Guardrails): Promise<{ hash: string; tx?: TxRef }> {
  const id = getState().identity;
  if (!id) throw new Error("No active account.");
  const r = await api.guardrails({ follower: id.account, trader, guardrails });
  if (r.tx || !r.call) { refreshPortfolio(); return { hash: r.guardrailsHash, tx: r.tx }; }
  if (getState().wallet !== id.account) throw new Error(`Connect ${id.account} to sign this update.`);
  savePending({ kind: "guardrails", follower: id.account, trader, at: Date.now() });
  const h = await wallet.signAndSend(r.call, location.href);
  takePending();
  refreshPortfolio();
  return { hash: r.guardrailsHash, tx: h ? { chain: "near", hash: h, url: `https://testnet.nearblocks.io/txns/${h}`, label: "update_guardrails" } : undefined };
}
