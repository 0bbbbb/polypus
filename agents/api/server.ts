import type http from "node:http";
import type {
  ActivityItem,
  CopyRecord,
  DecryptedTrade,
  FeedRow,
  Guardrails,
  HealthView,
  IntentsQuote,
  IntentsStatus,
  KeyHolding,
  PnlView,
  Portfolio,
  ProofView,
  StreamEvent,
  TeeView,
  Timeline,
  TimelineStep,
  TraderDetail,
  TraderSummary,
  TxRef,
} from "../../apps/keys/src/api/types.js";
import {
  AGENT_OPERATOR,
  COPY_PATH_PREFIX,
  DEMO_ACCOUNT,
  MPC_CONTRACT,
  NEAR_RPC,
  PORTS,
  REGISTRY,
  REGISTRY_DEPLOY_TX,
  SOLANA_PROGRAM,
  SOLANA_RPC,
  nearTxUrl,
  solTxUrl,
} from "../shared/config.js";
import {
  balanceNear,
  call,
  getFeed,
  nsToMs,
  txStatus,
  view,
  type FeedOnChain,
  type SubscriptionOnChain,
  type TraderOnChain,
} from "../shared/near.js";
import { HttpError, getJson, logger, postJson, readBody, readJson, runFile, serve, writeJson } from "../shared/run.js";
import { STYLES, fromUnits, type TradeRecord } from "../shared/book.js";
import { getPrices } from "../shared/prices.js";
import { verifyStatement } from "../shared/pnl.js";
import { PAY_OPTIONS, dryQuote } from "../shared/oneclick.js";

const log = logger("api");
const svc = (port: number, p: string) => `http://127.0.0.1:${port}${p}`;
const ACCOUNT_RE = /^[a-z0-9_.-]{2,64}$/;

type Store = { subscribeTx: Record<string, TxRef>; activity: ActivityItem[] };
const storeFile = runFile("api-state.json");
const store = readJson<Store>(storeFile, { subscribeTx: {}, activity: [] });
const saveStore = () => writeJson(storeFile, store);

const nearRef = (hash: string, label: string, at?: number): TxRef => ({ chain: "near", hash, url: nearTxUrl(hash), label, at });
const solRef = (sig: string, label: string, at?: number): TxRef => ({ chain: "solana", hash: sig, url: solTxUrl(sig), label, at });

function cached<T>(ttl: number, fn: () => Promise<T>): () => Promise<T> {
  let at = 0;
  let p: Promise<T> | null = null;
  return () => {
    if (!p || Date.now() - at > ttl) {
      at = Date.now();
      p = fn().catch(e => {
        at = 0;
        throw e;
      });
    }
    return p;
  };
}

type TraderStatus = {
  traders: Record<
    string,
    {
      handle: string;
      epoch: number;
      feedTx: Record<string, string>;
      seals: { follower: string; agentPubkey: string; epoch: number; tx: string; at: number }[];
      lastTradeAt: number | null;
      nextTradeAt: number | null;
      lastTickAt: number;
    }
  >;
  activity: ActivityItem[];
};
type AttestorStatus = {
  published: Record<string, { feedSeq: number; at: number; tx: string }>;
  lastTickAt: number;
  pubkey: string;
  gateway: { quoteDigest: string; signingAddress?: string; ok: boolean; at: number } | null;
  activity: ActivityItem[];
  errors: Record<string, string>;
};
type FollowerTee = { kind: "nearai-gateway" | "simulated"; digest: string; quoteDigest: string; checkedAt: number; signingAddress?: string };
type FollowerStatus = { lastTickAt: number; tee: FollowerTee; operator: string; activity: ActivityItem[] };
type AgentRec = {
  agentPubkey: string;
  follower: string;
  trader: string;
  createdAt: number;
  guardrails: Record<string, Guardrails>;
  subscribeTx?: string;
  activatedAt?: number;
  superseded?: boolean;
  onChainGuardrailsHash?: string;
  sealedEpoch?: number;
  sealedAt?: number;
  firstDecryptAt?: number;
  decrypted: { seq: number; epoch: number; postedAt: number; record: TradeRecord }[];
  copies: (Omit<CopyRecord, "solanaTx" | "mpcTx"> & { solanaSig?: string; mpcTx?: string })[];
  fundTx?: string;
  lastError?: string;
};
type FollowerPortfolio = { follower: string; tee: FollowerTee; wallet: { address: string; sol: number | null; path: string }; agents: AgentRec[] };

const status = {
  trader: cached(1500, () => getJson<TraderStatus>(svc(PORTS.trader, "/status"))),
  attestor: cached(1500, () => getJson<AttestorStatus>(svc(PORTS.attestor, "/status"))),
  follower: cached(1500, () => getJson<FollowerStatus>(svc(PORTS.follower, "/status"))),
};
const soft = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

const tradersOnChain = cached(5000, () => view<TraderOnChain[]>("get_traders", { from_index: 0, limit: 50 }));
const feeds = new Map<string, () => Promise<FeedOnChain[]>>();
const feedOf = (trader: string) => {
  let f = feeds.get(trader);
  if (!f) {
    f = cached(5000, () => getFeed(trader));
    feeds.set(trader, f);
  }
  return f();
};

function parsePnl(t: TraderOnChain, att: AttestorStatus | null): PnlView | null {
  if (!t.latest_pnl_statement) return null;
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(t.latest_pnl_statement);
  } catch {
    return null;
  }
  if (s.v !== 2) return null;
  const pub = att?.published[t.account];
  return {
    pnlBps: Number(s.pnl_bps),
    tradeCount: Number(s.trade_count),
    volumeUsd: Number(s.volume_usd),
    winRateBps: Number(s.win_rate_bps),
    equity: ((s.equity as [number, number][]) ?? []).map(([t, bps]) => ({ t: t * 1000, bps })),
    windowStart: Date.parse(String(s.window_start)),
    windowEnd: Date.parse(String(s.window_end)),
    feedSeq: Number(s.feed_seq),
    attestationKind: String(s.attestation_kind),
    codeHash: String(s.code_hash),
    signature: t.latest_pnl_signature,
    statement: t.latest_pnl_statement,
    publishedAt: nsToMs(t.latest_pnl_at),
    tx: pub ? nearRef(pub.tx, "publish_pnl", pub.at) : undefined,
  };
}

function epochsOf(t: TraderOnChain): number[] {
  try {
    const e = JSON.parse(t.latest_pnl_statement || "{}").epochs as number[] | undefined;
    if (e?.length) return e;
  } catch {}
  return [t.current_epoch];
}

async function summarize(t: TraderOnChain, ts: TraderStatus | null, att: AttestorStatus | null): Promise<TraderDetail> {
  const epochs = new Set([...epochsOf(t), t.current_epoch]);
  const feed = (await feedOf(t.account)).filter(f => epochs.has(f.epoch));
  const node = ts?.traders[t.account];
  const feedTx = node?.feedTx ?? {};
  const rows: FeedRow[] = feed
    .slice(-60)
    .reverse()
    .map(f => ({
      seq: f.seq,
      epoch: f.epoch,
      postedAt: nsToMs(f.posted_at),
      ciphertextPreview: f.ciphertext.slice(0, 48),
      ciphertextLen: f.ciphertext.length,
      tx: feedTx[String(f.seq)] ? nearRef(feedTx[String(f.seq)]!, "post_feed") : undefined,
    }));
  return {
    account: t.account,
    handle: t.handle,
    bio: t.bio,
    style: STYLES[t.handle]?.tokens.join(" · ") ?? "",
    priceYocto: t.price,
    priceNear: (Number(BigInt(t.price) / 10n ** 18n) / 1e6).toString(),
    periodDays: t.period_days,
    subscriberCount: t.subscriber_count,
    currentEpoch: t.current_epoch,
    solanaAddress: t.solana_address,
    shieldedAddress: t.shielded_address,
    attestorPubkey: t.attestor_pubkey,
    attestorDigest: t.attestor_attestation_digest,
    feedLen: feed.length,
    lastTradeAt: rows[0]?.postedAt ?? null,
    live: !!node && Date.now() - node.lastTickAt < 20_000,
    pnl: parsePnl(t, att),
    feed: rows,
  };
}

async function traderDetails(): Promise<TraderDetail[]> {
  const [list, ts, att] = await Promise.all([tradersOnChain(), soft(status.trader()), soft(status.attestor())]);
  return Promise.all(list.map(t => summarize(t, ts, att)));
}

async function traders(): Promise<TraderSummary[]> {
  return (await traderDetails()).map(({ feed: _f, ...s }) => s);
}

function teeView(f: FollowerTee | undefined): TeeView {
  return {
    kind: f?.kind ?? "simulated",
    digest: f?.digest ?? "simulated-tee-v0",
    quoteDigest: f?.quoteDigest ?? "",
    signingAddress: f?.signingAddress,
    checkedAt: f?.checkedAt ?? 0,
    inference: process.env.NEARAI_API_KEY ? "near-ai-cloud" : "template",
  };
}

function humanQty(units: string, decimals: number): string {
  const v = fromUnits(units, decimals);
  return v >= 1000 ? v.toFixed(0) : v >= 1 ? v.toFixed(4) : v.toPrecision(4);
}

function decryptedView(a: AgentRec, feedTx: Record<string, string>): DecryptedTrade[] {
  return [...a.decrypted]
    .sort((x, y) => y.seq - x.seq)
    .map(d => ({
      seq: d.seq,
      id: d.record.id,
      side: d.record.side,
      symbol: d.record.base.symbol,
      baseAmount: humanQty(d.record.baseAmount, d.record.base.decimals),
      quoteAmount: fromUnits(d.record.quoteAmount, 6).toFixed(2),
      price: d.record.price,
      executedAt: Date.parse(d.record.executedAt),
      postedAt: d.postedAt,
      backfilled: !!d.record.backfilled,
      feedTx: feedTx[String(d.seq)] ? nearRef(feedTx[String(d.seq)]!, "post_feed") : undefined,
    }));
}

function copiesView(a: AgentRec): CopyRecord[] {
  return [...a.copies]
    .sort((x, y) => y.seq - x.seq)
    .map(({ solanaSig, mpcTx, ...c }) => ({
      ...c,
      solanaTx: solanaSig ? solRef(solanaSig, "copy on Solana") : undefined,
      mpcTx: mpcTx ? nearRef(mpcTx, "MPC sign") : undefined,
    }));
}

function buildTimeline(
  follower: string,
  trader: string,
  handle: string,
  sub: SubscriptionOnChain | null,
  a: AgentRec | undefined,
  ts: TraderStatus | null,
): Timeline {
  const pubkey = a?.agentPubkey ?? sub?.agent_pubkey ?? "";
  const subTx = store.subscribeTx[`${follower}|${trader}|${pubkey}`] ?? (a?.subscribeTx ? nearRef(a.subscribeTx, "subscribe") : undefined);
  const node = ts?.traders[trader];
  const seal = node?.seals.filter(s => s.follower === follower && s.agentPubkey === pubkey).sort((x, y) => y.at - x.at)[0];
  const onChain = !!sub && sub.agent_pubkey === pubkey && sub.status === "active";
  const subscribed: TimelineStep = {
    key: "subscribed",
    label: "Subscribed",
    status: onChain ? "done" : subTx ? "active" : "waiting",
    detail: onChain ? `Key bought from ${handle}; agent ${pubkey.slice(0, 6)}…${pubkey.slice(-6)} registered` : "Waiting for the subscribe transaction",
    at: a?.activatedAt ?? subTx?.at,
    txs: subTx ? [subTx] : [],
  };
  const sealedDone = !!a?.sealedAt;
  const sealed: TimelineStep = {
    key: "sealed",
    label: "Key sealed to agent",
    status: sealedDone ? "done" : onChain ? "active" : "waiting",
    detail: sealedDone
      ? `${handle} sealed the epoch ${a!.sealedEpoch} key to your agent's X25519 key`
      : onChain
        ? `Waiting for ${handle}'s node to seal the epoch key`
        : "",
    at: seal?.at ?? a?.sealedAt,
    txs: seal ? [nearRef(seal.tx, "rotate_epoch", seal.at)] : [],
  };
  const n = a?.decrypted.length ?? 0;
  const lastSeq = a?.decrypted.reduce((m, d) => Math.max(m, d.seq), 0) ?? 0;
  const lastFeedTx = node?.feedTx[String(lastSeq)];
  const decrypted: TimelineStep = {
    key: "decrypted",
    label: "Trades decrypted",
    status: n ? "done" : sealedDone ? "active" : "waiting",
    detail: n ? `${n} trades decrypted inside the agent; latest #${lastSeq}` : sealedDone ? "Reading the encrypted feed" : "",
    at: a?.firstDecryptAt,
    txs: lastFeedTx ? [nearRef(lastFeedTx, `post_feed #${lastSeq}`)] : [],
  };
  const copies = a ? [...a.copies].sort((x, y) => x.seq - y.seq) : [];
  const firstDone = copies.find(c => c.status === "confirmed");
  const inflight = copies.find(c => c.status === "signing" || c.status === "pending");
  const skipped = copies.filter(c => c.status === "skipped");
  const failed = copies.filter(c => c.status === "failed");
  let copied: TimelineStep;
  if (firstDone) {
    copied = {
      key: "copied",
      label: "Copied on Solana",
      status: "done",
      detail: `${firstDone.action === "resize" ? "Resized copy" : "Copied"} ${firstDone.side} ${firstDone.symbol} for ${firstDone.copiedQuote} pUSD (trader ${firstDone.traderQuote})`,
      at: firstDone.at,
      txs: [
        ...(firstDone.mpcTx ? [nearRef(firstDone.mpcTx, "MPC sign")] : []),
        ...(firstDone.solanaSig ? [solRef(firstDone.solanaSig, "Solana devnet")] : []),
      ],
    };
  } else if (!n) {
    copied = { key: "copied", label: "Copied on Solana", status: "waiting", detail: "", txs: [] };
  } else {
    const fundTx = a?.fundTx ? [solRef(a.fundTx, "fund copy wallet")] : [];
    const detail = inflight
      ? `Signing ${inflight.side} ${inflight.symbol} ${inflight.copiedQuote} pUSD with Chain Signatures`
      : failed.length
        ? `Copy failed: ${failed[failed.length - 1]!.error ?? "unknown error"}`
        : a?.lastError
          ? a.lastError
          : skipped.length
            ? `Skipped #${skipped[skipped.length - 1]!.seq} (${skipped[skipped.length - 1]!.reason}); waiting for the next trade`
            : `Waiting for ${handle}'s next trade`;
    copied = {
      key: "copied",
      label: "Copied on Solana",
      status: failed.length && !inflight ? "error" : "active",
      detail,
      txs: fundTx,
    };
  }
  const steps = [subscribed, sealed, decrypted, copied];
  return { follower, trader, agentPubkey: pubkey, steps, complete: steps.every(s => s.status === "done") };
}

async function portfolio(follower: string): Promise<Portfolio> {
  if (!ACCOUNT_RE.test(follower)) throw new HttpError(400, "bad account id");
  const [subs, fp, ts, list] = await Promise.all([
    view<SubscriptionOnChain[]>("get_subscriptions_of", { follower }),
    soft(getJson<FollowerPortfolio>(svc(PORTS.follower, `/portfolio?follower=${encodeURIComponent(follower)}`), 8000)),
    soft(status.trader()),
    tradersOnChain(),
  ]);
  const keys: KeyHolding[] = subs.map(sub => {
    const handle = list.find(t => t.account === sub.trader)?.handle ?? sub.trader;
    const agents = (fp?.agents ?? []).filter(a => a.trader === sub.trader);
    const a = agents.find(x => x.agentPubkey === sub.agent_pubkey);
    const pending = agents.filter(x => !x.activatedAt && !x.superseded).sort((x, y) => y.createdAt - x.createdAt)[0];
    const shown = pending && pending.createdAt > (a?.activatedAt ?? 0) ? pending : a;
    const g = a?.guardrails[sub.guardrails_hash] ?? (a ? Object.values(a.guardrails).at(-1) ?? null : null);
    const expires = nsToMs(sub.expires_at);
    return {
      trader: sub.trader,
      handle,
      status: sub.status === "active" && expires < Date.now() ? "expired" : sub.status,
      expiresAt: expires,
      agentPubkey: sub.agent_pubkey,
      agentManaged: !!a,
      guardrails: g,
      guardrailsHashOnChain: sub.guardrails_hash,
      guardrailsActive: !!a?.guardrails[sub.guardrails_hash],
      copyWallet: fp?.wallet.address ?? "",
      copyWalletSol: fp?.wallet.sol ?? null,
      mpcPath: fp?.wallet.path ?? `${COPY_PATH_PREFIX}/${follower}`,
      decrypted: a ? decryptedView(a, ts?.traders[sub.trader]?.feedTx ?? {}) : [],
      copies: a ? copiesView(a) : [],
      timeline: buildTimeline(follower, sub.trader, handle, sub, shown, ts),
    };
  });
  return { follower, isDemo: follower === DEMO_ACCOUNT, tee: teeView(fp?.tee), keys };
}

async function timeline(follower: string, trader: string): Promise<Timeline> {
  if (!ACCOUNT_RE.test(follower) || !ACCOUNT_RE.test(trader)) throw new HttpError(400, "bad account id");
  const [sub, fp, ts, list] = await Promise.all([
    view<SubscriptionOnChain | null>("get_subscription", { follower, trader }),
    soft(getJson<FollowerPortfolio>(svc(PORTS.follower, `/portfolio?follower=${encodeURIComponent(follower)}`), 8000)),
    soft(status.trader()),
    tradersOnChain(),
  ]);
  const agents = (fp?.agents ?? []).filter(a => a.trader === trader && !a.superseded).sort((x, y) => y.createdAt - x.createdAt);
  const handle = list.find(t => t.account === trader)?.handle ?? trader;
  return buildTimeline(follower, trader, handle, sub, agents[0], ts);
}

async function activity(): Promise<ActivityItem[]> {
  const [t, a, f] = await Promise.all([soft(status.trader()), soft(status.attestor()), soft(status.follower())]);
  return [...(t?.activity ?? []), ...(a?.activity ?? []), ...(f?.activity ?? []), ...store.activity]
    .sort((x, y) => y.at - x.at)
    .slice(0, 40);
}

function pushActivity(item: Omit<ActivityItem, "id">) {
  store.activity.unshift({ id: `${item.kind}-${item.at}-${Math.random().toString(36).slice(2, 7)}`, ...item });
  store.activity.length = Math.min(store.activity.length, 80);
  saveStore();
}

const demoBalance = cached(15_000, () => balanceNear(DEMO_ACCOUNT));

async function health(): Promise<HealthView> {
  const [t, a, f, bal] = await Promise.all([soft(status.trader()), soft(status.attestor()), soft(status.follower()), soft(demoBalance())]);
  const up = (s: { lastTickAt: number } | null) => ({ up: !!s && Date.now() - s.lastTickAt < 30_000, lastTickAt: s?.lastTickAt ?? null });
  const traderUp = t ? Object.values(t.traders).reduce((m, x) => Math.max(m, x.lastTickAt), 0) : 0;
  return {
    ok: true,
    network: "testnet",
    registry: REGISTRY,
    rpc: NEAR_RPC,
    services: {
      trader: { up: !!t && Date.now() - traderUp < 30_000, lastTickAt: traderUp || null },
      follower: up(f),
      attestor: { ...up(a), note: a && Object.keys(a.errors).length ? Object.values(a.errors)[0] : undefined },
    },
    demo: {
      account: DEMO_ACCOUNT,
      available: (bal ?? 0) > 1 && !!f,
      balanceNear: bal ?? 0,
      reason: !f ? "follower agent offline" : (bal ?? 0) <= 1 ? "demo account low on testnet NEAR" : undefined,
    },
    agentOperator: AGENT_OPERATOR,
    mpcContract: MPC_CONTRACT,
  };
}

async function proof(): Promise<ProofView> {
  const [list, att, f, acts] = await Promise.all([tradersOnChain(), soft(status.attestor()), soft(status.follower()), activity()]);
  return {
    registry: {
      account: REGISTRY,
      deployTx: nearRef(REGISTRY_DEPLOY_TX, "deploy"),
      methods: ["subscribe", "update_guardrails", "rotate_epoch", "post_feed", "publish_pnl", "get_followers", "get_subscriptions_of", "get_sealed_key", "get_feed"],
    },
    network: { near: "testnet", solana: "devnet", rpc: NEAR_RPC },
    traders: list.map(t => ({
      account: t.account,
      handle: t.handle,
      attestorPubkey: t.attestor_pubkey,
      attestorDigest: t.attestor_attestation_digest,
      pnlStatement: t.latest_pnl_statement,
      pnlSignature: t.latest_pnl_signature,
      pnlSignatureValid: t.latest_pnl_statement ? verifyStatement(t.attestor_pubkey, t.latest_pnl_statement, t.latest_pnl_signature) : false,
      pnlTx: att?.published[t.account] ? nearRef(att.published[t.account]!.tx, "publish_pnl", att.published[t.account]!.at) : undefined,
    })),
    chainSignatures: { mpcContract: MPC_CONTRACT, operator: AGENT_OPERATOR, domainId: 1, pathPrefix: `${COPY_PATH_PREFIX}/<follower>` },
    solanaProgram: { id: SOLANA_PROGRAM, url: `https://explorer.solana.com/address/${SOLANA_PROGRAM}?cluster=devnet` },
    tee: teeView(f?.tee),
    recent: acts.filter(x => x.tx).map(x => ({ ...x.tx!, at: x.at, label: `${x.tx!.label} · ${x.text}` })).slice(0, 30),
  };
}

const limiter = { byIp: new Map<string, number>(), window: [] as number[] };
const IP_GAP_MS = Number(process.env.POLYPUS_DEMO_GAP_S ?? 45) * 1000;
const HOURLY = Number(process.env.POLYPUS_DEMO_PER_HOUR ?? 20);

function rateLimit(req: http.IncomingMessage) {
  const ip = req.socket.remoteAddress ?? "?";
  const now = Date.now();
  limiter.window = limiter.window.filter(t => now - t < 3600_000);
  const last = limiter.byIp.get(ip) ?? 0;
  if (now - last < IP_GAP_MS) {
    const retryAfterSec = Math.ceil((IP_GAP_MS - (now - last)) / 1000);
    throw new HttpError(429, `Demo account is cooling down; try again in ${retryAfterSec}s`, { retryAfterSec });
  }
  if (limiter.window.length >= HOURLY) throw new HttpError(429, "Demo limit reached for this hour", { retryAfterSec: 600 });
  limiter.byIp.set(ip, now);
  limiter.window.push(now);
}

type Provisioned = {
  agentPubkey: string;
  agentAttestationDigest: string;
  guardrailsHash: string;
  guardrails: Guardrails;
};

async function provision(follower: string, trader: string, guardrails?: Guardrails) {
  if (!ACCOUNT_RE.test(follower) || !ACCOUNT_RE.test(trader)) throw new HttpError(400, "bad account id");
  const t = (await tradersOnChain()).find(x => x.account === trader);
  if (!t) throw new HttpError(404, "unknown trader");
  const p = await postJson<Provisioned>(svc(PORTS.follower, "/provision"), { follower, trader, guardrails });
  return {
    ...p,
    call: {
      receiverId: REGISTRY,
      methodName: "subscribe" as const,
      args: { trader, agent_pubkey: p.agentPubkey, agent_attestation_digest: p.agentAttestationDigest, guardrails_hash: p.guardrailsHash },
      gas: "120000000000000",
      deposit: t.price,
    },
  };
}

async function recordSubscribe(follower: string, trader: string, agentPubkey: string, txHash: string) {
  const ref = nearRef(txHash, "subscribe", Date.now());
  store.subscribeTx[`${follower}|${trader}|${agentPubkey}`] = ref;
  const handle = (await tradersOnChain()).find(x => x.account === trader)?.handle ?? trader;
  pushActivity({ at: Date.now(), kind: "subscribe", trader, follower, text: `${follower} bought a ${handle} key`, tx: ref });
  await soft(postJson(svc(PORTS.follower, "/subscribed"), { agentPubkey, txHash }));
  return ref;
}

const intentsStatus = cached(10 * 60_000, async (): Promise<IntentsStatus> => {
  const partner = !!process.env.ONECLICK_PARTNER_JWT;
  let confidential = false;
  let detail = partner ? "" : "ONECLICK_PARTNER_JWT not set; public quotes only";
  if (partner) {
    const r = await dryQuote(PAY_OPTIONS[0]!.originAsset, "100000000000000000000000", true).catch(e => ({ status: 0, message: String(e), quote: undefined }));
    confidential = r.status >= 200 && r.status < 300 && !!r.quote;
    detail = confidential ? "Partner JWT accepted for confidential (basic) dry quotes" : `Confidential probe failed: ${r.message ?? r.status}`;
  }
  return { options: PAY_OPTIONS, partner, confidential, checkedAt: Date.now(), detail };
});

const quotes = new Map<string, { at: number; q: IntentsQuote }>();

async function quote(trader: string, pay: string): Promise<IntentsQuote> {
  const opt = PAY_OPTIONS.find(o => o.id === pay);
  const t = (await tradersOnChain()).find(x => x.account === trader);
  if (!opt || !t) throw new HttpError(400, "unknown trader or pay option");
  const hit = quotes.get(`${trader}|${pay}`);
  if (hit && Date.now() - hit.at < 30_000) return hit.q;
  const st = await intentsStatus();
  let r = await dryQuote(opt.originAsset, t.price, st.confidential);
  let confidential = st.confidential;
  if (!r.quote && confidential) {
    r = await dryQuote(opt.originAsset, t.price, false);
    confidential = false;
  }
  if (!r.quote) throw new HttpError(502, `1Click: ${r.message ?? r.status}`);
  const q: IntentsQuote = {
    trader,
    payWith: opt,
    amountIn: r.quote.amountIn,
    amountInFormatted: r.quote.amountInFormatted,
    amountInUsd: r.quote.amountInUsd ?? "",
    amountOutFormatted: r.quote.amountOutFormatted,
    timeEstimateSec: r.quote.timeEstimate ?? 0,
    confidential,
    partner: st.partner,
    dry: true,
    quotedAt: Date.now(),
  };
  quotes.set(`${trader}|${pay}`, { at: Date.now(), q });
  return q;
}

const routes: Record<string, (req: http.IncomingMessage, url: URL) => Promise<unknown>> = {
  "GET /api/health": () => health(),
  "GET /api/traders": () => traders(),
  "GET /api/prices": async () => getPrices(),
  "GET /api/intents": () => intentsStatus(),
  "GET /api/quote": async (_r, u) => quote(u.searchParams.get("trader") ?? "", u.searchParams.get("pay") ?? "usdc-base"),
  "GET /api/activity": () => activity(),
  "GET /api/proof": () => proof(),
  "GET /api/timeline": async (_r, u) => timeline(u.searchParams.get("follower") ?? "", u.searchParams.get("trader") ?? ""),
  "POST /api/agent/provision": async req => {
    const b = await readBody<{ follower?: string; trader?: string; guardrails?: Guardrails }>(req);
    return provision(String(b.follower), String(b.trader), b.guardrails);
  },
  "POST /api/demo/subscribe": async req => {
    const b = await readBody<{ trader?: string; guardrails?: Guardrails }>(req);
    const trader = String(b.trader ?? "");
    const bal = await demoBalance();
    const t = (await tradersOnChain()).find(x => x.account === trader);
    if (!t) throw new HttpError(404, "unknown trader");
    const price = Number(BigInt(t.price) / 10n ** 18n) / 1e6;
    if (bal < price + 0.5) throw new HttpError(503, "Demo account is low on testnet NEAR");
    rateLimit(req);
    const p = await provision(DEMO_ACCOUNT, trader, b.guardrails);
    const res = await call(DEMO_ACCOUNT, REGISTRY, "subscribe", p.call.args, { gas: 120, deposit: BigInt(t.price) });
    log.info(`demo ${DEMO_ACCOUNT} subscribed to ${t.handle}: ${res.url}`);
    const tx = await recordSubscribe(DEMO_ACCOUNT, trader, p.agentPubkey, res.txHash);
    return { follower: DEMO_ACCOUNT, agentPubkey: p.agentPubkey, tx };
  },
  "POST /api/subscriptions/notify": async req => {
    const b = await readBody<{ follower?: string; trader?: string; txHash?: string }>(req);
    const follower = String(b.follower ?? "");
    const trader = String(b.trader ?? "");
    const txHash = String(b.txHash ?? "");
    if (!ACCOUNT_RE.test(follower) || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) throw new HttpError(400, "bad request");
    const st = await txStatus(txHash, follower);
    const i = st.methods.indexOf("subscribe");
    if (!st.ok || st.receiver !== REGISTRY || i < 0 || st.signer !== follower || st.args[i]?.trader !== trader) {
      throw new HttpError(400, "transaction is not a successful subscribe from this account");
    }
    const tx = await recordSubscribe(follower, trader, String(st.args[i]!.agent_pubkey), txHash);
    return { ok: true, tx };
  },
  "POST /api/guardrails": async req => {
    const b = await readBody<{ follower?: string; trader?: string; guardrails?: Guardrails }>(req);
    const follower = String(b.follower ?? "");
    const trader = String(b.trader ?? "");
    const r = await postJson<{ guardrailsHash: string }>(svc(PORTS.follower, "/guardrails"), { follower, trader, guardrails: b.guardrails });
    if (follower !== DEMO_ACCOUNT) {
      return {
        guardrailsHash: r.guardrailsHash,
        call: {
          receiverId: REGISTRY,
          methodName: "update_guardrails",
          args: { trader, guardrails_hash: r.guardrailsHash },
          gas: "30000000000000",
          deposit: "0",
        },
      };
    }
    const res = await call(DEMO_ACCOUNT, REGISTRY, "update_guardrails", { trader, guardrails_hash: r.guardrailsHash }, { gas: 30 });
    const tx = nearRef(res.txHash, "update_guardrails", Date.now());
    pushActivity({ at: Date.now(), kind: "guardrails", trader, follower, text: `${follower} updated guardrails`, tx });
    return { guardrailsHash: r.guardrailsHash, tx };
  },
};

const clients = new Set<{ res: http.ServerResponse; follower: string | null }>();

function send(res: http.ServerResponse, ev: StreamEvent) {
  res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

let seenActivity = new Set<string>();
let lastTraders = "";
const lastTimeline = new Map<string, string>();

async function pump() {
  if (!clients.size) return;
  try {
    const [acts, ts] = await Promise.all([activity(), traders()]);
    const fresh = acts.filter(a => !seenActivity.has(a.id)).reverse();
    seenActivity = new Set(acts.map(a => a.id));
    const tsKey = JSON.stringify(ts.map(t => [t.account, t.feedLen, t.pnl?.publishedAt, t.subscriberCount, t.live]));
    const tradersChanged = tsKey !== lastTraders;
    lastTraders = tsKey;
    const followers = new Set([...clients].map(c => c.follower).filter(Boolean) as string[]);
    const timelines = new Map<string, Timeline[]>();
    for (const f of followers) {
      const p = await soft(portfolio(f));
      if (p) timelines.set(f, p.keys.map(k => k.timeline));
    }
    for (const c of clients) {
      for (const item of fresh) send(c.res, { type: "activity", item });
      if (tradersChanged) send(c.res, { type: "traders", traders: ts });
      if (!c.follower) continue;
      let portfolioChanged = false;
      for (const tl of timelines.get(c.follower) ?? []) {
        const k = `${c.follower}|${tl.trader}`;
        const v = JSON.stringify(tl);
        if (lastTimeline.get(k) !== v || fresh.length) {
          send(c.res, { type: "timeline", timeline: tl });
          portfolioChanged ||= lastTimeline.get(k) !== v;
        }
      }
      if (portfolioChanged || fresh.some(a => a.follower === c.follower)) send(c.res, { type: "portfolio", follower: c.follower });
    }
    for (const [f, tls] of timelines) for (const tl of tls) lastTimeline.set(`${f}|${tl.trader}`, JSON.stringify(tl));
  } catch (e) {
    log.warn(`stream: ${String(e)}`);
  }
}
setInterval(() => void pump(), 3000);
setInterval(() => {
  for (const c of clients) c.res.write(": ping\n\n");
}, 15_000);

serve(PORTS.api, routes, async (req, res, url) => {
  if (req.method === "GET" && url.pathname === "/api/stream") {
    const follower = url.searchParams.get("follower");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    const c = { res, follower: follower && ACCOUNT_RE.test(follower) ? follower : null };
    clients.add(c);
    req.on("close", () => clients.delete(c));
    return true;
  }
  const m = url.pathname.match(/^\/api\/(traders|portfolio)\/([a-z0-9_.-]{2,64})$/);
  if (req.method === "GET" && m) {
    const [, kind, id] = m;
    try {
      let body: unknown;
      if (kind === "portfolio") body = await portfolio(id!);
      else {
        const d = (await traderDetails()).find(t => t.account === id);
        if (!d) throw new HttpError(404, "unknown trader");
        body = d;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    } catch (e) {
      const s = e instanceof HttpError ? e.status : 500;
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String((e as Error)?.message ?? e) }));
    }
    return true;
  }
  return false;
});

log.info(`api on http://127.0.0.1:${PORTS.api} · registry ${REGISTRY} · demo ${DEMO_ACCOUNT} · solana ${SOLANA_RPC}`);
