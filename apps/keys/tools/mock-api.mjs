// Dev-only mock of the local Polypus Keys API (agents/api) on 127.0.0.1:8787.
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? 8787);
const REGISTRY = "polypus-keys-18e5.testnet";
const DEMO = "carol-18e5.testnet";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const b58 = n => Array.from(crypto.randomBytes(n), b => B58[b % 58]).join("");
const hex = n => crypto.randomBytes(n).toString("hex");
const nearTx = (label, at = Date.now()) => { const hash = b58(44); return { chain: "near", hash, url: `https://testnet.nearblocks.io/txns/${hash}`, label, at }; };
const solTx = (label, at = Date.now()) => { const hash = b58(88); return { chain: "solana", hash, url: `https://explorer.solana.com/tx/${hash}?cluster=devnet`, label, at }; };
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[(Math.random() * a.length) | 0];

const PAY = [
  { id: "usdc-base", label: "USDC", chain: "Base", originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6 },
  { id: "eth", label: "ETH", chain: "Ethereum", originAsset: "nep141:eth.omft.near", decimals: 18 },
  { id: "sol", label: "SOL", chain: "Solana", originAsset: "nep141:sol.omft.near", decimals: 9 },
  { id: "btc", label: "BTC", chain: "Bitcoin", originAsset: "nep141:btc.omft.near", decimals: 8 },
];
let PRICES = { SOL: 182.36, JUP: 0.9214, BONK: 0.0000241 };
const recent = [];
const remember = tx => { recent.unshift(tx); recent.length = Math.min(recent.length, 40); return tx; };

function mkTrader(account, handle, bio, style, priceNear, subs, targetBps, symbols, n) {
  const now = Date.now();
  const windowStart = now - 30 * 86_400_000;
  const equity = [];
  let v = 0;
  for (let i = 0; i <= 60; i++) {
    const t = windowStart + (i / 60) * (now - windowStart);
    const drift = (targetBps - v) / Math.max(1, 60 - i);
    v += drift + rand(-1, 1) * Math.abs(targetBps) * 0.06;
    if (i === 60) v = targetBps;
    equity.push({ t: Math.round(t), bps: Math.round(v) });
  }
  const feed = [];
  for (let i = 0; i < n; i++) {
    const postedAt = now - (n - 1 - i) * rand(9, 40) * 60_000 - rand(25, 90) * 1000;
    feed.push(mkFeed(i + 1, postedAt, symbols));
  }
  const t = {
    account, handle, bio, style,
    priceYocto: (BigInt(Math.round(priceNear * 1000)) * 10n ** 21n).toString(),
    priceNear: String(priceNear), periodDays: 30, subscriberCount: subs, currentEpoch: 3,
    solanaAddress: b58(44), shieldedAddress: `poly1${Array.from(crypto.randomBytes(58), b => "qpzry9x8gf2tvdw0s3jn54khce6mua7l"[b % 32]).join("")}`,
    attestorPubkey: `ed25519:${b58(44)}`, attestorDigest: hex(32),
    feed, symbols, live: true, lastTradeAt: feed.at(-1).postedAt,
  };
  t.pnl = mkPnl(t, equity, windowStart, now);
  remember(t.pnl.tx);
  return t;
}

function mkFeed(seq, postedAt, symbols) {
  const symbol = pick(symbols);
  const side = Math.random() < 0.58 ? "buy" : "sell";
  const price = PRICES[symbol] * rand(0.985, 1.015);
  const quote = rand(60, 420);
  const tx = remember(nearTx("post_feed", postedAt));
  return {
    row: { seq, epoch: 3, postedAt: Math.round(postedAt), ciphertextPreview: `ct_${b58(40)}`, ciphertextLen: 184 + ((Math.random() * 40) | 0), tx },
    trade: {
      seq, id: `t_${b58(10)}`, side, symbol,
      baseAmount: (quote / price).toFixed(symbol === "BONK" ? 0 : symbol === "JUP" ? 2 : 4),
      quoteAmount: quote.toFixed(2), price: price.toPrecision(6), executedAt: Math.round(postedAt - rand(2, 9) * 1000), postedAt: Math.round(postedAt),
    },
  };
}

function mkPnl(t, equity, windowStart, windowEnd) {
  const last = equity.at(-1).bps;
  const tradeCount = t.feed.length;
  const volumeUsd = t.feed.reduce((s, f) => s + Number(f.trade.quoteAmount), 0);
  const winRateBps = last > 0 ? 6200 : 4300;
  const codeHash = hex(32);
  const statement = JSON.stringify({ v: 1, trader: t.account, window: [windowStart, windowEnd], feed_seq: tradeCount, trade_count: tradeCount, pnl_bps: last, volume_usd: Math.round(volumeUsd * 100) / 100, win_rate_bps: winRateBps, equity_root: hex(32), code_hash: codeHash, attestor: t.attestorPubkey });
  return {
    pnlBps: last, tradeCount, volumeUsd, winRateBps, equity, windowStart, windowEnd, feedSeq: tradeCount,
    attestationKind: "ed25519 attestor (local TEE label)", codeHash, signature: b58(88), statement, publishedAt: windowEnd - 120_000,
    tx: nearTx("publish_pnl", windowEnd - 120_000),
  };
}

let traders, holdings, activity, lastDemoAt, deployTx, tee;
function reset() {
  traders = [
    mkTrader("alice-18e5.testnet", "kestrel", "Momentum on SOL and JUP. Small size, quick exits.", "Momentum", 0.5, 3, 1284, ["SOL", "SOL", "JUP"], 26),
    mkTrader("bob-18e5.testnet", "heron", "Mean reversion on JUP and BONK. Patient entries, wide stops.", "Mean reversion", 0.3, 1, -312, ["JUP", "BONK", "SOL"], 17),
  ];
  holdings = new Map();
  activity = [];
  lastDemoAt = 0;
  deployTx = remember(nearTx("deploy", Date.now() - 3 * 86_400_000));
  tee = { kind: "simulated", digest: hex(32), quoteDigest: hex(32), signingAddress: undefined, checkedAt: Date.now() - 60_000, inference: "template" };
  for (const t of traders) for (const f of t.feed.slice(-4)) pushActivity({ kind: "trade", trader: t.account, text: `${t.handle} posted encrypted trade #${f.row.seq}`, tx: f.row.tx, at: f.row.postedAt }, false);
  activity.sort((a, b) => b.at - a.at);
}

function pushActivity(a, emit = true) {
  const item = { id: b58(12), at: Date.now(), ...a };
  activity.unshift(item);
  activity.length = Math.min(activity.length, 40);
  if (emit) broadcast("activity", { type: "activity", item });
}

const summary = t => {
  const { feed, symbols, ...rest } = t;
  return { ...rest, feedLen: feed.length, lastTradeAt: feed.at(-1)?.row.postedAt ?? null };
};

const GR_DEFAULT = { maxTradeQuote: "250000000", allowedTokens: ["SOL", "JUP"], dailyLossLimitBps: 500, copyRatioBps: 8000 };
const grHash = g => crypto.createHash("sha256").update(JSON.stringify(g)).digest("hex");

function subscribe(follower, trader, guardrails, subTx) {
  const t = traders.find(x => x.account === trader);
  const g = guardrails ?? GR_DEFAULT;
  const h = {
    follower, trader, handle: t.handle, status: "active", start: Date.now(), expiresAt: Date.now() + 30 * 86_400_000,
    agentPubkey: b58(44), agentManaged: true, guardrails: g, guardrailsHashOnChain: grHash(g), guardrailsActive: true,
    copyWallet: b58(44), copyWalletSol: 2.4815, mpcPath: `polypus-copy/${follower}`,
    decrypted: [], copies: [], txs: { subscribe: subTx }, done: {}, lastStatus: "",
  };
  if (!holdings.has(follower)) holdings.set(follower, new Map());
  holdings.get(follower).set(trader, h);
  t.subscriberCount++;
  pushActivity({ kind: "subscribe", trader, follower, text: `${follower} bought ${t.handle}'s key`, tx: subTx });
  return h;
}

function advance(h) {
  const t = traders.find(x => x.account === h.trader);
  const el = (Date.now() - h.start) / 1000;
  let changed = false;
  if (el > 3 && !h.done.subscribed) { h.done.subscribed = h.start + 3000; changed = true; }
  if (el > 11 && !h.done.sealed) {
    h.done.sealed = h.start + 11000;
    h.txs.seal = remember(nearTx("seal_key"));
    pushActivity({ kind: "seal", trader: h.trader, follower: h.follower, text: `${t.handle}'s node sealed epoch 3 to ${h.follower}'s agent`, tx: h.txs.seal });
    changed = true;
  }
  if (el > 12 && el < 20) {
    const want = Math.min(t.feed.length, Math.floor((el - 12) * 1.6) + 1);
    const backfill = t.feed.slice(-10).reverse();
    while (h.decrypted.length < Math.min(want, backfill.length)) {
      const f = backfill[h.decrypted.length];
      h.decrypted.push({ ...f.trade, backfilled: true, feedTx: f.row.tx });
      changed = true;
    }
  }
  if (el > 19 && !h.done.decrypted) { h.done.decrypted = h.start + 19000; changed = true; }
  const plan = [
    { at: 21, seqIdx: 0 }, { at: 25, seqIdx: 1 }, { at: 29, seqIdx: 2 },
  ];
  for (const p of plan) {
    if (el > p.at && !h.copies.find(c => c.plan === p.at)) {
      const d = h.decrypted[p.seqIdx];
      if (d) { addCopy(h, d, p.at); changed = true; }
    }
  }
  for (const c of h.copies) changed = stepCopy(h, c) || changed;
  if (el > 38 && !h.done.copied && h.copies.some(c => c.status === "confirmed")) { h.done.copied = Date.now(); changed = true; }
  if (h.pendingGr && Date.now() > h.pendingGr.at) {
    h.guardrailsHashOnChain = h.pendingGr.hash; h.guardrailsActive = true; h.pendingGr = null; changed = true;
  }
  return changed;
}

function addCopy(h, d, plan) {
  const g = h.guardrails;
  const allowed = g.allowedTokens.includes(d.symbol);
  const want = Number(d.quoteAmount) * (g.copyRatioBps / 10000);
  const cap = Number(g.maxTradeQuote) / 1e6;
  const action = !allowed ? "skip" : want > cap ? "resize" : "copy";
  const copied = action === "skip" ? 0 : Math.min(want, cap);
  h.copies.unshift({
    plan, seq: d.seq, tradeId: d.id, side: d.side, symbol: d.symbol, traderQuote: d.quoteAmount, copiedQuote: copied.toFixed(2),
    action, reason: action === "skip" ? `${d.symbol} not in allowlist` : action === "resize" ? `capped at ${cap} pUSD` : `${g.copyRatioBps / 100}% of trader`,
    explanation: action === "skip" ? `Skipped: ${d.symbol} is not in your token allowlist.` : `Copied ${d.side} ${d.symbol} at ${g.copyRatioBps / 100}% size, within max ${cap} pUSD per trade.`,
    explanationKind: "template", status: action === "skip" ? "skipped" : "pending", at: Date.now(), born: Date.now(),
  });
}

function stepCopy(h, c) {
  if (c.status === "skipped" || c.status === "confirmed" || c.status === "failed") return false;
  const age = (Date.now() - c.born) / 1000;
  const next = age > 8 ? "confirmed" : age > 5 ? "submitted" : age > 2 ? "signing" : "pending";
  if (next === c.status) return false;
  c.status = next;
  if (next === "signing") c.mpcTx = remember(nearTx("sign (MPC)"));
  if (next === "submitted") c.solanaTx = remember(solTx("swap"));
  if (next === "confirmed") {
    h.copyWalletSol = Math.max(0, (h.copyWalletSol ?? 0) - 0.000005);
    const t = traders.find(x => x.account === h.trader);
    pushActivity({ kind: "copy", trader: h.trader, follower: h.follower, text: `${h.follower} copied ${t.handle}: ${c.side} ${c.symbol} ${c.copiedQuote} pUSD`, tx: c.solanaTx });
  }
  return true;
}

function timelineOf(h) {
  if (!h) return null;
  const now = Date.now();
  const st = (doneAt, prevDone) => (doneAt ? "done" : prevDone ? "active" : "waiting");
  const confirmed = h.copies.filter(c => c.status === "confirmed");
  const s1 = st(h.done.subscribed, true), s2 = st(h.done.sealed, h.done.subscribed), s3 = st(h.done.decrypted, h.done.sealed), s4 = st(h.done.copied, h.done.decrypted);
  return {
    follower: h.follower, trader: h.trader, agentPubkey: h.agentPubkey, complete: !!h.done.copied,
    steps: [
      { key: "subscribed", label: "Subscribed", status: s1, detail: s1 === "done" ? `Paid ${traders.find(t => t.account === h.trader).priceNear} NEAR · 30 days` : "Waiting for the registry to confirm", at: h.done.subscribed ?? h.start, txs: h.txs.subscribe ? [h.txs.subscribe] : [] },
      { key: "sealed", label: "Key sealed to agent", status: s2, detail: s2 === "done" ? "Epoch 3 key sealed to your agent's X25519 key" : s2 === "active" ? "Trader node is sealing the epoch key" : "", at: h.done.sealed ?? (s2 === "active" ? h.done.subscribed : undefined), txs: h.txs.seal ? [h.txs.seal] : [] },
      { key: "decrypted", label: "Trades decrypted", status: s3, detail: s3 === "waiting" ? "" : `${h.decrypted.length} trades decrypted inside the agent`, at: h.done.decrypted ?? (s3 === "active" ? h.done.sealed : undefined), txs: [] },
      { key: "copied", label: "Copied on Solana", status: s4, detail: s4 === "waiting" ? "" : confirmed.length ? `${confirmed.length} copied · ${h.copies.filter(c => c.status === "skipped").length} skipped by guardrails` : "Signing via Chain Signatures", at: h.done.copied ?? (s4 === "active" ? h.done.decrypted : undefined), txs: confirmed.flatMap(c => [c.solanaTx, c.mpcTx]).filter(Boolean).slice(0, 4) },
    ],
  };
}
const waitingTimeline = (follower, trader) => ({
  follower, trader, agentPubkey: "", complete: false,
  steps: ["subscribed", "sealed", "decrypted", "copied"].map((key, i) => ({ key, label: ["Subscribed", "Key sealed to agent", "Trades decrypted", "Copied on Solana"][i], status: "waiting", detail: "", txs: [] })),
});

function holdingView(h) {
  const { start, txs, done, lastStatus, follower, pendingGr, ...rest } = h;
  return { ...rest, copies: h.copies.map(({ plan, born, ...c }) => c), decrypted: [...h.decrypted].sort((a, b) => b.seq - a.seq), timeline: timelineOf(h) };
}

const clients = new Set();
function broadcast(event, data, follower) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (!follower || !c.follower || c.follower === follower) c.res.write(frame);
}

function newTrade(t) {
  const seq = t.feed.length + 1;
  const f = mkFeed(seq, Date.now(), t.symbols);
  t.feed.push(f);
  pushActivity({ kind: "trade", trader: t.account, text: `${t.handle} posted encrypted trade #${seq}`, tx: f.row.tx });
  broadcast("traders", { type: "traders", traders: traders.map(summary) });
  for (const [, m] of holdings) {
    const h = m.get(t.account);
    if (h && h.done.copied) {
      h.decrypted.push({ ...f.trade, backfilled: false, feedTx: f.row.tx });
      setTimeout(() => { addCopy(h, f.trade, Date.now()); }, 1500);
      broadcast("portfolio", { type: "portfolio", follower: h.follower });
    }
  }
}

setInterval(() => {
  for (const [follower, m] of holdings) for (const h of m.values()) {
    if (advance(h)) {
      broadcast("timeline", { type: "timeline", timeline: timelineOf(h) }, follower);
      broadcast("portfolio", { type: "portfolio", follower }, follower);
    } else if (!h.done.copied) {
      broadcast("timeline", { type: "timeline", timeline: timelineOf(h) }, follower);
    }
  }
}, 500);
setInterval(() => { for (const c of clients) c.res.write(`: ping\n\n`); }, 15000);
setInterval(() => { PRICES = { SOL: PRICES.SOL * rand(0.998, 1.002), JUP: PRICES.JUP * rand(0.998, 1.002), BONK: PRICES.BONK * rand(0.997, 1.003) }; }, 5000);
let tickN = 0;
setInterval(() => { tickN++; if (tickN % 3 === 0) newTrade(traders[0]); if (tickN % 5 === 0) newTrade(traders[1]); }, 9000);

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise(r => { let s = ""; req.on("data", d => (s += d)); req.on("end", () => { try { r(JSON.parse(s || "{}")); } catch { r({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const m = (re) => p.match(re);
  try {
    if (req.method === "GET" && p === "/api/health") {
      const now = Date.now();
      return json(res, 200, {
        ok: true, network: "testnet", registry: REGISTRY, rpc: "https://rpc.testnet.fastnear.com",
        services: { trader: { up: true, lastTickAt: now - 2000 }, follower: { up: true, lastTickAt: now - 1000 }, attestor: { up: true, lastTickAt: now - 30_000, note: "publishes every 10 min" } },
        demo: { account: DEMO, available: true, balanceNear: 18.42 }, agentOperator: "polypus-agent-18e5.testnet", mpcContract: "v1.signer-prod.testnet",
      });
    }
    if (req.method === "GET" && p === "/api/traders") return json(res, 200, traders.map(summary));
    let mm;
    if (req.method === "GET" && (mm = m(/^\/api\/traders\/([^/]+)$/))) {
      const t = traders.find(x => x.account === decodeURIComponent(mm[1]));
      if (!t) return json(res, 404, { error: "trader not found" });
      return json(res, 200, { ...summary(t), feed: t.feed.slice(-60).reverse().map(f => f.row) });
    }
    if (req.method === "GET" && p === "/api/prices") return json(res, 200, { ...PRICES, at: Date.now(), source: "mock" });
    if (req.method === "GET" && (mm = m(/^\/api\/portfolio\/([^/]+)$/))) {
      const follower = decodeURIComponent(mm[1]);
      const hs = [...(holdings.get(follower)?.values() ?? [])];
      return json(res, 200, { follower, isDemo: follower === DEMO, tee, keys: hs.map(holdingView) });
    }
    if (req.method === "GET" && p === "/api/timeline") {
      const f = url.searchParams.get("follower"), t = url.searchParams.get("trader");
      return json(res, 200, timelineOf(holdings.get(f)?.get(t)) ?? waitingTimeline(f, t));
    }
    if (req.method === "GET" && p === "/api/intents") return json(res, 200, { options: PAY, partner: false, confidential: false, checkedAt: Date.now(), detail: "mock" });
    if (req.method === "GET" && p === "/api/quote") {
      const t = traders.find(x => x.account === url.searchParams.get("trader"));
      const o = PAY.find(x => x.id === url.searchParams.get("pay"));
      if (!t || !o) return json(res, 400, { error: "trader and pay required" });
      const usd = Number(t.priceNear) * 3.7;
      const amt = o.id === "usdc-base" ? usd : o.id === "eth" ? usd / 3400 : o.id === "sol" ? usd / PRICES.SOL : usd / 98000;
      return json(res, 200, { trader: t.account, payWith: o, amountIn: String(Math.round(amt * 10 ** o.decimals)), amountInFormatted: amt.toPrecision(5), amountInUsd: usd.toFixed(4), amountOutFormatted: t.priceNear, timeEstimateSec: 37, confidential: false, partner: false, dry: true, quotedAt: Date.now() });
    }
    if (req.method === "GET" && p === "/api/activity") return json(res, 200, activity.slice(0, 40));
    if (req.method === "GET" && p === "/api/proof") {
      return json(res, 200, {
        registry: { account: REGISTRY, deployTx, methods: ["register_trader", "post_feed", "subscribe", "seal_key", "publish_pnl", "update_guardrails", "cancel", "get_trader", "get_feed", "get_subscription"] },
        network: { near: "testnet", solana: "devnet", rpc: "https://rpc.testnet.fastnear.com" },
        traders: traders.map(t => ({ account: t.account, handle: t.handle, attestorPubkey: t.attestorPubkey, attestorDigest: t.attestorDigest, pnlStatement: t.pnl.statement, pnlSignature: t.pnl.signature, pnlTx: t.pnl.tx })),
        chainSignatures: { mpcContract: "v1.signer-prod.testnet", operator: "polypus-agent-18e5.testnet", domainId: 1, pathPrefix: "polypus-copy/" },
        solanaProgram: { id: "PoLyKeYs1111111111111111111111111111111111", url: "https://explorer.solana.com/address/PoLyKeYs1111111111111111111111111111111111?cluster=devnet" },
        tee, recent: recent.slice(0, 20),
      });
    }
    if (req.method === "GET" && p === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`retry: 2000\n\n`);
      const c = { res, follower: url.searchParams.get("follower") };
      clients.add(c);
      req.on("close", () => clients.delete(c));
      return;
    }
    if (req.method === "POST" && p === "/api/agent/provision") {
      const b = await readBody(req);
      const t = traders.find(x => x.account === b.trader);
      if (!t || !b.follower) return json(res, 400, { error: "follower and trader required" });
      const g = b.guardrails ?? GR_DEFAULT;
      const agentPubkey = b58(44), digest = hex(32), gh = grHash(g);
      return json(res, 200, { agentPubkey, agentAttestationDigest: digest, guardrailsHash: gh, guardrails: g, call: { receiverId: REGISTRY, methodName: "subscribe", args: { trader: t.account, agent_pubkey: agentPubkey, agent_attestation_digest: digest, guardrails_hash: gh }, gas: "100000000000000", deposit: t.priceYocto } });
    }
    if (req.method === "POST" && p === "/api/subscriptions/notify") {
      const b = await readBody(req);
      const tx = { chain: "near", hash: b.txHash, url: `https://testnet.nearblocks.io/txns/${b.txHash}`, label: "subscribe", at: Date.now() };
      remember(tx);
      subscribe(b.follower, b.trader, undefined, tx);
      return json(res, 200, { ok: true, tx });
    }
    if (req.method === "POST" && p === "/api/demo/subscribe") {
      const b = await readBody(req);
      const wait = 8000 - (Date.now() - lastDemoAt);
      if (wait > 0) return json(res, 429, { error: "demo rate limited", retryAfterSec: Math.ceil(wait / 1000) }, { "retry-after": String(Math.ceil(wait / 1000)) });
      if (!traders.find(x => x.account === b.trader)) return json(res, 400, { error: "unknown trader" });
      lastDemoAt = Date.now();
      await new Promise(r => setTimeout(r, 900));
      const tx = remember(nearTx("subscribe"));
      const h = subscribe(DEMO, b.trader, b.guardrails, tx);
      return json(res, 200, { follower: DEMO, agentPubkey: h.agentPubkey, tx });
    }
    if (req.method === "POST" && p === "/api/guardrails") {
      const b = await readBody(req);
      const h = holdings.get(b.follower)?.get(b.trader);
      if (!h) return json(res, 404, { error: "no key for this trader" });
      const gh = grHash(b.guardrails);
      if (b.follower !== DEMO) return json(res, 200, { guardrailsHash: gh, call: { receiverId: REGISTRY, methodName: "update_guardrails", args: { trader: b.trader, guardrails_hash: gh }, gas: "30000000000000", deposit: "0" } });
      h.guardrails = b.guardrails; h.guardrailsActive = false; h.pendingGr = { hash: gh, at: Date.now() + 6000 };
      const tx = remember(nearTx("update_guardrails"));
      pushActivity({ kind: "guardrails", trader: b.trader, follower: b.follower, text: `${b.follower} updated guardrails for ${h.handle}`, tx });
      broadcast("portfolio", { type: "portfolio", follower: b.follower });
      return json(res, 200, { guardrailsHash: gh, tx });
    }
    if (req.method === "POST" && p === "/api/_mock/reset") { reset(); return json(res, 200, { ok: true }); }
    json(res, 404, { error: `no route ${req.method} ${p}` });
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

reset();
server.listen(PORT, "127.0.0.1", () => console.log(`mock api on http://127.0.0.1:${PORT}`));
