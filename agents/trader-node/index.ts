#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { decryptFeedRecord, encryptFeedRecord, randomEpochKey, sealEpochKey } from "@polypus/sdk";
import { ATTESTOR_ID, KEYS_DIR, PORTS, REGISTRY, TRADERS, nearTxUrl } from "../shared/config.js";
import { call, getFeed, sleep, view, type SubscriptionOnChain, type TraderOnChain } from "../shared/near.js";
import { logger, readJson, runFile, serve, writeJson } from "../shared/run.js";
import { getPrices } from "../shared/prices.js";
import { makeRecord, nextTrade, replay, type TradeRecord } from "../shared/book.js";

const log = logger("trader");
const MIN_S = Number(process.env.POLYPUS_TRADE_MIN_S ?? 60);
const MAX_S = Number(process.env.POLYPUS_TRADE_MAX_S ?? 90);
const MAX_TRADES = Number(process.env.POLYPUS_MAX_TRADES ?? 80);
const NO_TRADES = process.env.POLYPUS_NO_TRADES === "1";

type EpochSecrets = { keys: Record<string, number[]> };
type SealRecord = { follower: string; agentPubkey: string; epoch: number; tx: string; at: number };
type TraderState = {
  account: string;
  handle: string;
  epoch: number;
  feedTx: Record<string, string>;
  seals: SealRecord[];
  lastTradeAt: number | null;
  nextTradeAt: number | null;
  postedThisRun: number;
  lastTickAt: number;
  error?: string;
};
type Activity = { id: string; at: number; kind: string; trader?: string; follower?: string; text: string; tx?: { chain: "near"; hash: string; url: string; label: string } };

const stateFile = runFile("trader-state.json");
const persisted = readJson<{ traders: Record<string, Partial<TraderState>>; activity: Activity[] }>(stateFile, { traders: {}, activity: [] });
const states = new Map<string, TraderState>();
const activity: Activity[] = persisted.activity ?? [];

function secretFile(account: string) {
  return path.join(KEYS_DIR, "trader-epochs", `${account}.json`);
}
function loadSecrets(account: string): EpochSecrets {
  return readJson<EpochSecrets>(secretFile(account), { keys: {} });
}
function saveSecrets(account: string, s: EpochSecrets) {
  writeJson(secretFile(account), s, 0o600);
}

function push(a: Omit<Activity, "id">) {
  activity.unshift({ id: `${a.kind}-${a.at}-${Math.random().toString(36).slice(2, 7)}`, ...a });
  activity.length = Math.min(activity.length, 120);
}

function persist() {
  writeJson(stateFile, { traders: Object.fromEntries(states), activity });
}

function attestorPub(): string | null {
  return readJson<{ x25519: string } | null>(runFile("attestor-pub.json"), null)?.x25519 ?? null;
}

async function ownTrades(account: string, secrets: EpochSecrets): Promise<TradeRecord[]> {
  const feed = await getFeed(account);
  const out: TradeRecord[] = [];
  for (const row of feed) {
    const k = secrets.keys[String(row.epoch)];
    if (!k) continue;
    try {
      out.push(decryptFeedRecord(account, row.epoch, Uint8Array.from(k), row.ciphertext) as unknown as TradeRecord);
    } catch {}
  }
  return out;
}

async function ensureEpoch(account: string): Promise<{ epoch: number; key: Uint8Array }> {
  const profile = await view<TraderOnChain | null>("get_trader", { account });
  if (!profile) throw new Error(`${account} is not a registered trader`);
  const secrets = loadSecrets(account);
  const cur = profile.current_epoch;
  const have = secrets.keys[String(cur)];
  if (cur > 0 && have) return { epoch: cur, key: Uint8Array.from(have) };
  const epoch = cur + 1;
  const key = randomEpochKey();
  secrets.keys[String(epoch)] = [...key];
  saveSecrets(account, secrets);
  const r = await call(account, REGISTRY, "rotate_epoch", { epoch, sealed: [] }, { gas: 60 });
  log.info(`${profile.handle}: started epoch ${epoch} (no key held for epoch ${cur}) ${r.url}`);
  const st = states.get(account);
  if (st) st.seals = [];
  return { epoch, key };
}

async function sealPending(st: TraderState, epoch: number, key: Uint8Array) {
  const subs = await view<SubscriptionOnChain[]>("get_followers", { trader: st.account });
  const now = Date.now();
  const recipients: { follower: string; agentPubkey: string }[] = subs
    .filter(s => s.status === "active" && Number(BigInt(s.expires_at) / 1_000_000n) > now)
    .map(s => ({ follower: s.follower, agentPubkey: s.agent_pubkey }));
  const ap = attestorPub();
  if (ap) recipients.push({ follower: ATTESTOR_ID, agentPubkey: ap });
  const missing = recipients.filter(
    r => !st.seals.some(s => s.follower === r.follower && s.agentPubkey === r.agentPubkey && s.epoch === epoch),
  );
  if (!missing.length) return;
  const items = missing.map(r => ({
    follower: r.follower,
    agent_pubkey: r.agentPubkey,
    sealed_key: sealEpochKey(st.account, r.follower, epoch, r.agentPubkey, key),
  }));
  const res = await call(st.account, REGISTRY, "rotate_epoch", { epoch, sealed: items }, { gas: 120 });
  for (const r of missing) {
    st.seals.push({ ...r, epoch, tx: res.txHash, at: Date.now() });
    const who = r.follower === ATTESTOR_ID ? "attestor" : r.follower;
    log.info(`${st.handle}: sealed epoch ${epoch} key to ${who} (${r.agentPubkey.slice(0, 6)}…) ${res.url}`);
    push({
      at: Date.now(),
      kind: "seal",
      trader: st.account,
      follower: r.follower,
      text: r.follower === ATTESTOR_ID ? `${st.handle} sealed epoch ${epoch} to the attestor` : `${st.handle} sealed epoch ${epoch} key to ${r.follower}'s agent`,
      tx: { chain: "near", hash: res.txHash, url: res.url, label: "rotate_epoch" },
    });
  }
  persist();
}

async function postTrade(st: TraderState, epoch: number, key: Uint8Array) {
  const secrets = loadSecrets(st.account);
  const book = replay(await ownTrades(st.account, secrets));
  const prices = await getPrices(20_000);
  const d = nextTrade(st.handle, book, prices);
  if (!d) return;
  const rec = makeRecord(st.account, epoch, d, new Date(), prices.source);
  const ct = encryptFeedRecord(st.account, epoch, key, rec as unknown as Record<string, unknown>);
  const res = await call(st.account, REGISTRY, "post_feed", { epoch, ciphertext: ct }, { gas: 50 });
  const ev = res.events.find(e => e.event === "feed") as { data?: { seq?: number }[] } | undefined;
  const seq = ev?.data?.[0]?.seq;
  if (seq != null) st.feedTx[String(seq)] = res.txHash;
  st.lastTradeAt = Date.now();
  st.postedThisRun++;
  log.info(`${st.handle}: post_feed seq ${seq} (encrypted ${d.side} ${d.sym} $${d.usd.toFixed(0)}) ${res.url}`);
  push({
    at: Date.now(),
    kind: "trade",
    trader: st.account,
    text: `${st.handle} posted encrypted trade #${seq}`,
    tx: { chain: "near", hash: res.txHash, url: nearTxUrl(res.txHash), label: "post_feed" },
  });
  persist();
}

const jitter = () => (MIN_S + Math.random() * (MAX_S - MIN_S)) * 1000;

async function runTrader(account: string) {
  const profile = await view<TraderOnChain | null>("get_trader", { account });
  if (!profile) {
    log.warn(`${account} not registered; skipping`);
    return;
  }
  const prev = persisted.traders[account] ?? {};
  const st: TraderState = {
    account,
    handle: profile.handle,
    epoch: profile.current_epoch,
    feedTx: prev.feedTx ?? {},
    seals: prev.seals ?? [],
    lastTradeAt: prev.lastTradeAt ?? null,
    nextTradeAt: null,
    postedThisRun: 0,
    lastTickAt: Date.now(),
  };
  states.set(account, st);
  let { epoch, key } = await ensureEpoch(account);
  st.epoch = epoch;
  st.nextTradeAt = Date.now() + 8000 + Math.random() * 20_000;
  persist();
  for (;;) {
    try {
      st.lastTickAt = Date.now();
      await sealPending(st, epoch, key);
      if (!NO_TRADES && st.postedThisRun < MAX_TRADES && st.nextTradeAt && Date.now() >= st.nextTradeAt) {
        st.nextTradeAt = Date.now() + jitter();
        await postTrade(st, epoch, key);
      }
      st.error = undefined;
    } catch (e) {
      st.error = String((e as Error)?.message ?? e).slice(0, 200);
      log.error(`${st.handle}: ${st.error}`);
      if (/invalid epoch|no key/i.test(st.error)) ({ epoch, key } = await ensureEpoch(account));
    }
    await sleep(3000);
  }
}

serve(PORTS.trader, {
  "GET /status": () => ({ traders: Object.fromEntries(states), activity: activity.slice(0, 60), at: Date.now() }),
});
log.info(`trader-node on 127.0.0.1:${PORTS.trader} · traders ${TRADERS.join(", ")} · trade every ${MIN_S}-${MAX_S}s${NO_TRADES ? " (trading paused)" : ""}`);
if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });
await Promise.all(TRADERS.map(a => runTrader(a).catch(e => log.error(a, e))));
