#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { decryptFeedRecord, generateAgentKeypair, unsealEpochKey } from "@polypus/sdk";
import { AGENT_OPERATOR, COPY_PATH_PREFIX, KEYS_DIR, PORTS, solTxUrl } from "../shared/config.js";
import { getFeed, nsToMs, sleep, view, type SubscriptionOnChain, type TraderOnChain } from "../shared/near.js";
import { HttpError, logger, readBody, readJson, runFile, serve, writeJson } from "../shared/run.js";
import {
  DEFAULT_GUARDRAILS,
  guardrailsHash,
  normalizeGuardrails,
  sizeCopy,
  validGuardrails,
  type Guardrails,
} from "../shared/guardrails.js";
import { agentAttestationBinding } from "../shared/tee.js";
import { explainCopyDecision, type InferenceProof } from "../shared/nearai.js";
import { derivedSolanaAddress, ensureFunded, mpcSendMemo, solBalance } from "../shared/chainsig.js";
import { fromUnits, type TradeRecord } from "../shared/book.js";

const log = logger("follower");
const CATCHUP_MS = Number(process.env.POLYPUS_CATCHUP_MIN ?? 15) * 60_000;
const AGENT_DIR = path.join(KEYS_DIR, "agents");
fs.mkdirSync(AGENT_DIR, { recursive: true, mode: 0o700 });

type Decrypted = {
  seq: number;
  epoch: number;
  postedAt: number;
  record: TradeRecord;
};
type Copy = {
  seq: number;
  tradeId: string;
  side: "buy" | "sell";
  symbol: string;
  traderQuote: string;
  copiedQuote: string;
  action: "copy" | "resize" | "skip";
  reason: string;
  explanation: string;
  explanationKind: "near-ai-cloud" | "template";
  status: "pending" | "signing" | "submitted" | "confirmed" | "skipped" | "failed";
  at: number;
  guardrailsHash: string;
  inference?: InferenceProof;
  solanaSig?: string;
  mpcTx?: string;
  error?: string;
};
type AgentRec = {
  agentPubkey: string;
  follower: string;
  trader: string;
  createdAt: number;
  attestationDigest: string;
  teeKind: string;
  guardrails: Record<string, Guardrails>;
  subscribeTx?: string;
  activatedAt?: number;
  superseded?: boolean;
  onChainGuardrailsHash?: string;
  sealedEpoch?: number;
  sealedAt?: number;
  firstDecryptAt?: number;
  decrypted: Decrypted[];
  copies: Copy[];
  fundTx?: string;
  copyWallet?: string;
  lastError?: string;
};
type Secret = { publicKey: string; secretKey: number[] };

const stateFile = runFile("follower-state.json");
const state = readJson<{ agents: Record<string, AgentRec>; activity: unknown[] }>(stateFile, { agents: {}, activity: [] });
const activity = state.activity as { id: string; at: number; kind: string; trader?: string; follower?: string; text: string; tx?: unknown }[];
let tee: Awaited<ReturnType<typeof agentAttestationBinding>> & { checkedAt: number; signingAddress?: string } = {
  digest: "simulated-tee-v0",
  kind: "simulated",
  quoteDigest: "",
  checks: [],
  checkedAt: 0,
};
let lastTickAt = 0;

const save = () => writeJson(stateFile, state);
const secretPath = (pk: string) => path.join(AGENT_DIR, `${pk}.json`);
function secretFor(pk: string): Uint8Array | null {
  const s = readJson<Secret | null>(secretPath(pk), null);
  return s ? Uint8Array.from(s.secretKey) : null;
}
const mpcPath = (follower: string) => `${COPY_PATH_PREFIX}/${follower}`;

function push(a: Omit<(typeof activity)[number], "id">) {
  activity.unshift({ id: `${a.kind}-${a.at}-${Math.random().toString(36).slice(2, 7)}`, ...a });
  activity.length = Math.min(activity.length, 120);
}

async function refreshTee(pk: string) {
  const b = await agentAttestationBinding(pk);
  tee = { ...b, checkedAt: Date.now(), signingAddress: b.checks[0]?.detail };
  return b;
}

async function provision(body: { follower?: string; trader?: string; guardrails?: Guardrails }) {
  const follower = String(body.follower ?? "");
  const trader = String(body.trader ?? "");
  if (!/^[a-z0-9_.-]{2,64}$/.test(follower) || !/^[a-z0-9_.-]{2,64}$/.test(trader)) throw new HttpError(400, "bad account id");
  const profile = await view<TraderOnChain | null>("get_trader", { account: trader });
  if (!profile) throw new HttpError(404, "unknown trader");
  const g = body.guardrails ? body.guardrails : DEFAULT_GUARDRAILS;
  if (!validGuardrails(g)) throw new HttpError(400, "invalid guardrails");
  const guardrails = normalizeGuardrails(g);
  const kp = generateAgentKeypair();
  writeJson(secretPath(kp.publicKey), { publicKey: kp.publicKey, secretKey: [...kp.secretKey] }, 0o600);
  const b = await refreshTee(kp.publicKey);
  const hash = guardrailsHash(guardrails);
  state.agents[kp.publicKey] = {
    agentPubkey: kp.publicKey,
    follower,
    trader,
    createdAt: Date.now(),
    attestationDigest: b.digest,
    teeKind: b.kind,
    guardrails: { [hash]: guardrails },
    decrypted: [],
    copies: [],
  };
  save();
  log.info(`provisioned agent ${kp.publicKey.slice(0, 8)}… for ${follower} → ${profile.handle} (${b.kind})`);
  void prepareWallet(state.agents[kp.publicKey]!);
  return { agentPubkey: kp.publicKey, agentAttestationDigest: b.digest, guardrailsHash: hash, guardrails, teeKind: b.kind };
}

async function prepareWallet(a: AgentRec) {
  try {
    const pk = await derivedSolanaAddress(AGENT_OPERATOR, mpcPath(a.follower));
    a.copyWallet = pk.toBase58();
    const sig = await ensureFunded(pk);
    if (sig) {
      a.fundTx = sig;
      log.info(`funded copy wallet ${a.copyWallet.slice(0, 6)}… for ${a.follower}: ${solTxUrl(sig)}`);
      push({ at: Date.now(), kind: "fund", follower: a.follower, text: `Copy wallet for ${a.follower} funded on Solana devnet`, tx: { chain: "solana", hash: sig, url: solTxUrl(sig), label: "fund copy wallet" } });
    }
    save();
  } catch (e) {
    log.warn(`copy wallet for ${a.follower}: ${String(e)}`);
  }
}

type Live = { epoch: number; key: Uint8Array; handle: string; checkedAt: number; feedLen: number };
const live = new Map<string, Live>();
const feedLens = new Map<string, Promise<number>>();

async function tick(a: AgentRec) {
  if (a.superseded) return;
  let l = live.get(a.agentPubkey);
  if (!l || Date.now() - l.checkedAt > 10_000) {
    l = (await activate(a)) ?? undefined;
    if (!l) {
      live.delete(a.agentPubkey);
      return;
    }
    live.set(a.agentPubkey, l);
  }
  let len = feedLens.get(a.trader);
  if (!len) {
    len = view<number>("get_feed_len", { trader: a.trader });
    feedLens.set(a.trader, len);
  }
  const n = await len;
  if (n !== l.feedLen) {
    const fromSeq = a.decrypted.filter(d => d.epoch === l.epoch).reduce((m, d) => Math.max(m, d.seq), 0) + 1;
    const rows = (await getFeed(a.trader, fromSeq)).filter(r => r.epoch === l.epoch);
    for (const r of rows) {
      try {
        const record = decryptFeedRecord(a.trader, l.epoch, l.key, r.ciphertext) as unknown as TradeRecord;
        a.decrypted.push({ seq: r.seq, epoch: l.epoch, postedAt: nsToMs(r.posted_at), record });
      } catch (e) {
        log.warn(`decrypt seq ${r.seq}: ${String(e)}`);
      }
    }
    if (rows.length) {
      a.firstDecryptAt ??= Date.now();
      log.info(`${a.follower} → ${l.handle}: decrypted ${rows.length} trade(s), total ${a.decrypted.length}`);
    }
    l.feedLen = n;
  }
  await copyNew(a, l.handle);
}

async function activate(a: AgentRec): Promise<Live | null> {
  const sub = await view<SubscriptionOnChain | null>("get_subscription", { follower: a.follower, trader: a.trader });
  if (!sub || sub.agent_pubkey !== a.agentPubkey) {
    if (a.activatedAt || Date.now() - a.createdAt > 30 * 60_000) a.superseded = true;
    return null;
  }
  if (sub.status !== "active" || nsToMs(sub.expires_at) < Date.now()) return null;
  if (!a.activatedAt) {
    a.activatedAt = Date.now();
    log.info(`${a.follower} → ${a.trader}: subscription live on-chain for agent ${a.agentPubkey.slice(0, 8)}…`);
  }
  a.onChainGuardrailsHash = sub.guardrails_hash;
  const secret = secretFor(a.agentPubkey);
  if (!secret) {
    a.lastError = "agent secret missing";
    return null;
  }
  const trader = await view<TraderOnChain>("get_trader", { account: a.trader });
  const epoch = trader.current_epoch;
  const sealed = await view<string | null>("get_sealed_key", { trader: a.trader, follower: a.follower, epoch });
  if (!sealed) return null;
  let key: Uint8Array;
  try {
    key = unsealEpochKey(a.trader, a.follower, epoch, secret, sealed);
  } catch {
    return null;
  }
  if (a.sealedEpoch !== epoch) {
    a.sealedEpoch = epoch;
    a.sealedAt = Date.now();
    log.info(`${a.follower} → ${trader.handle}: unsealed epoch ${epoch} key`);
  }
  const prev = live.get(a.agentPubkey);
  return { epoch, key, handle: trader.handle, checkedAt: Date.now(), feedLen: prev?.epoch === epoch ? prev.feedLen : -1 };
}

async function copyNew(a: AgentRec, handle: string) {
  const active = a.onChainGuardrailsHash ? a.guardrails[a.onChainGuardrailsHash] : undefined;
  const done = new Set(a.copies.map(c => c.seq));
  const start = a.activatedAt ?? Date.now();
  const sorted = [...a.decrypted].sort((x, y) => x.seq - y.seq);
  const after = sorted.filter(d => d.postedAt >= start);
  const before = sorted.filter(d => d.postedAt < start && d.postedAt >= start - CATCHUP_MS && !d.record.backfilled);
  const candidates = [...(a.copies.length || after.length ? [] : before.slice(-1)), ...after].filter(d => !done.has(d.seq));
  if (!candidates.length) return;
  if (!active) {
    a.lastError = "on-chain guardrails hash does not match any guardrails this agent holds; copying paused";
    return;
  }
  a.lastError = undefined;
  for (const d of candidates) {
    const t = d.record;
    const sized = sizeCopy(t, active);
    const traderQuote = fromUnits(t.quoteAmount, 6).toFixed(2);
    const copiedQuote = (Number(sized.copiedQuote) / 1e6).toFixed(2);
    const c: Copy = {
      seq: d.seq,
      tradeId: t.id,
      side: t.side,
      symbol: t.base.symbol,
      traderQuote,
      copiedQuote: sized.action === "skip" ? "0" : copiedQuote,
      action: sized.action,
      reason: sized.reason,
      explanation: "",
      explanationKind: "template",
      status: sized.action === "skip" ? "skipped" : "pending",
      at: Date.now(),
      guardrailsHash: a.onChainGuardrailsHash!,
    };
    a.copies.push(c);
    save();
    const explained = explainCopyDecision({
      side: t.side,
      symbol: t.base.symbol,
      quoteAmount: `${sized.action === "skip" ? traderQuote : copiedQuote} pUSD`,
      action: sized.action,
      reason: sized.reason,
    }).then(e => {
      c.explanation = e.text;
      c.explanationKind = e.kind;
      c.inference = e.proof;
      if (e.error) log.warn(`NEAR AI: ${e.error}`);
      save();
    });
    if (c.status === "skipped") log.info(`${a.follower} ← ${handle} #${d.seq}: skip (${sized.reason})`);
    else await execute(a, c, handle);
    await explained;
  }
}

async function execute(a: AgentRec, c: Copy, handle: string) {
  try {
    c.status = "signing";
    save();
    const p = mpcPath(a.follower);
    const pk = await derivedSolanaAddress(AGENT_OPERATOR, p);
    a.copyWallet = pk.toBase58();
    const fund = await ensureFunded(pk);
    if (fund) a.fundTx = fund;
    const commit = bytesToHex(
      sha256(new TextEncoder().encode([a.follower, a.trader, c.seq, c.side, c.symbol, c.copiedQuote, a.agentPubkey].join("|"))),
    ).slice(0, 32);
    const r = await mpcSendMemo(AGENT_OPERATOR, p, `polypus-copy:v1:${commit}`);
    c.solanaSig = r.solanaSig;
    c.mpcTx = r.mpcTx;
    c.status = "confirmed";
    log.info(`${a.follower} ← ${handle} #${c.seq}: ${c.action} ${c.side} ${c.symbol} ${c.copiedQuote} pUSD · MPC ${r.mpcUrl} · Solana ${r.solanaUrl}`);
    push({
      at: Date.now(),
      kind: "copy",
      trader: a.trader,
      follower: a.follower,
      text: `${a.follower}'s agent copied ${handle}'s trade #${c.seq} on Solana`,
      tx: { chain: "solana", hash: r.solanaSig, url: r.solanaUrl, label: "copy (Chain Signatures)" },
    });
  } catch (e) {
    c.status = "failed";
    c.error = String((e as Error)?.message ?? e).slice(0, 240);
    log.error(`copy #${c.seq} failed: ${c.error}`);
  }
  save();
}

async function setGuardrails(body: { follower?: string; trader?: string; guardrails?: unknown }) {
  if (!validGuardrails(body.guardrails)) throw new HttpError(400, "invalid guardrails");
  const g = normalizeGuardrails(body.guardrails);
  const a = Object.values(state.agents).find(
    x => x.follower === body.follower && x.trader === body.trader && x.activatedAt && !x.superseded,
  );
  if (!a) throw new HttpError(404, "no active agent for this key");
  const hash = guardrailsHash(g);
  a.guardrails[hash] = g;
  save();
  return { guardrailsHash: hash, guardrails: g, agentPubkey: a.agentPubkey };
}

async function copyWalletInfo(follower: string) {
  const pk = await derivedSolanaAddress(AGENT_OPERATOR, mpcPath(follower));
  let bal: number | null = null;
  try {
    bal = await solBalance(pk);
  } catch {}
  return { address: pk.toBase58(), sol: bal, path: mpcPath(follower) };
}

const balances = new Map<string, { at: number; v: Awaited<ReturnType<typeof copyWalletInfo>> }>();

serve(PORTS.follower, {
  "POST /provision": async req => provision(await readBody(req)),
  "POST /subscribed": async req => {
    const b = await readBody<{ agentPubkey?: string; txHash?: string }>(req);
    const a = state.agents[String(b.agentPubkey)];
    if (!a) throw new HttpError(404, "unknown agent");
    a.subscribeTx = String(b.txHash);
    save();
    return { ok: true };
  },
  "POST /guardrails": async req => setGuardrails(await readBody(req)),
  "GET /status": () => ({
    lastTickAt,
    tee,
    operator: AGENT_OPERATOR,
    agents: Object.values(state.agents).filter(a => a.activatedAt && !a.superseded).length,
    activity: activity.slice(0, 60),
    at: Date.now(),
  }),
  "GET /portfolio": async (_req, url) => {
    const follower = url.searchParams.get("follower") ?? "";
    const agents = Object.values(state.agents).filter(a => a.follower === follower);
    let wallet = balances.get(follower);
    if (!wallet || Date.now() - wallet.at > 20_000) {
      wallet = { at: Date.now(), v: await copyWalletInfo(follower) };
      balances.set(follower, wallet);
    }
    return { follower, tee, wallet: wallet.v, agents };
  },
});

log.info(`follower agent on 127.0.0.1:${PORTS.follower} · operator ${AGENT_OPERATOR} · MPC path ${COPY_PATH_PREFIX}/<follower>`);
void refreshTee(generateAgentKeypair().publicKey).then(b => log.info(`TEE binding: ${b.kind} (${b.digest})`));
for (;;) {
  feedLens.clear();
  for (const a of Object.values(state.agents).filter(x => !x.superseded)) {
    try {
      await tick(a);
    } catch (e) {
      a.lastError = String((e as Error)?.message ?? e).slice(0, 200);
      log.error(`${a.follower}/${a.trader}: ${a.lastError}`);
    }
  }
  lastTickAt = Date.now();
  save();
  await sleep(2500);
}
