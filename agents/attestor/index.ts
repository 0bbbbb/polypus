#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { decryptFeedRecord, generateAgentKeypair, unsealEpochKey } from "@polypus/sdk";
import { ATTESTOR_ID, KEYS_DIR, PNL_RELAY, PORTS, REGISTRY, SOLANA_PROGRAM, TRADERS, nearTxUrl } from "../shared/config.js";
import { call, getFeed, sleep, view, type TraderOnChain } from "../shared/near.js";
import { logger, readJson, runFile, serve, writeJson } from "../shared/run.js";
import { attestorPublicKey, canonicalStatement, loadOrCreateAttestorSecret, signStatement, type PnlStatement } from "../shared/pnl.js";
import { computePnl, type TradeRecord } from "../shared/book.js";
import { getPrices } from "../shared/prices.js";
import { attestationNonceOk, attestationQuoteDigest, fetchAttestationReport, randomNonceHex } from "../shared/nearai.js";

const log = logger("attestor");
const ONCE = process.argv.includes("--once");
const REMARK_MS = Number(process.env.POLYPUS_REMARK_S ?? 600) * 1000;

const sk = loadOrCreateAttestorSecret(process.env.POLYPUS_ATTESTOR_KEY ?? path.join(KEYS_DIR, "attestor-ed25519.json"));
const pk = attestorPublicKey(sk);

const xFile = path.join(KEYS_DIR, "attestor-x25519.json");
let xkp: { publicKey: string; secretKey: Uint8Array };
if (fs.existsSync(xFile)) {
  const j = JSON.parse(fs.readFileSync(xFile, "utf8")) as { publicKey: string; secretKey: number[] };
  xkp = { publicKey: j.publicKey, secretKey: Uint8Array.from(j.secretKey) };
} else {
  xkp = generateAgentKeypair();
  writeJson(xFile, { publicKey: xkp.publicKey, secretKey: [...xkp.secretKey] }, 0o600);
}
writeJson(runFile("attestor-pub.json"), { x25519: xkp.publicKey, ed25519: pk });

type Published = { feedSeq: number; at: number; tx: string; pnlBps: number; tradeCount: number };
type State = { published: Record<string, Published>; lastTickAt: number; gateway: { quoteDigest: string; signingAddress?: string; ok: boolean; at: number } | null; errors: Record<string, string> };
const stateFile = runFile("attestor-state.json");
const st = readJson<State>(stateFile, { published: {}, lastTickAt: 0, gateway: null, errors: {} });
st.errors = {};
const activity: { id: string; at: number; kind: string; trader: string; text: string; tx: { chain: "near"; hash: string; url: string; label: string } }[] =
  readJson<{ activity?: [] }>(stateFile, {}).activity ?? [];

async function gateway() {
  if (st.gateway && Date.now() - st.gateway.at < 30 * 60_000) return st.gateway;
  try {
    const nonce = randomNonceHex();
    const report = await fetchAttestationReport(nonce);
    st.gateway = {
      quoteDigest: attestationQuoteDigest(report),
      signingAddress: report.gateway_attestation?.signing_address,
      ok: attestationNonceOk(report, nonce),
      at: Date.now(),
    };
  } catch {
    st.gateway = { quoteDigest: "", ok: false, at: Date.now() };
  }
  return st.gateway;
}

async function attest(trader: string): Promise<void> {
  const prev = st.published[trader];
  const len = await view<number>("get_feed_len", { trader });
  if (prev && prev.feedSeq >= len && Date.now() - prev.at < REMARK_MS) return;
  const profile = await view<TraderOnChain | null>("get_trader", { account: trader });
  if (!profile) return;
  if (profile.attestor_pubkey !== pk) {
    st.errors[trader] = `trader's registered attestor ${profile.attestor_pubkey.slice(0, 8)}… != ours ${pk.slice(0, 8)}… (run npm run setup:live)`;
    return;
  }
  const feed = await getFeed(trader);
  const epochs = [...new Set(feed.map(f => f.epoch))];
  const keys = new Map<number, Uint8Array>();
  for (const e of epochs) {
    const sealed = await view<string | null>("get_sealed_key", { trader, follower: ATTESTOR_ID, epoch: e });
    if (!sealed) continue;
    try {
      keys.set(e, unsealEpochKey(trader, ATTESTOR_ID, e, xkp.secretKey, sealed));
    } catch {}
  }
  const trades: TradeRecord[] = [];
  let maxSeq = 0;
  for (const row of feed) {
    const k = keys.get(row.epoch);
    if (!k) continue;
    trades.push(decryptFeedRecord(trader, row.epoch, k, row.ciphertext) as unknown as TradeRecord);
    maxSeq = Math.max(maxSeq, row.seq);
  }
  if (!trades.length) {
    st.errors[trader] = "no decryptable trades yet (waiting for the trader to seal the epoch key to the attestor)";
    return;
  }
  const stale = !prev || prev.feedSeq < maxSeq || Date.now() - prev.at > REMARK_MS;
  if (!stale) return;
  const prices = await getPrices();
  const gw = await gateway();
  const pnl = computePnl(trades, prices);
  const statement: PnlStatement = {
    v: 2,
    trader,
    pnl_bps: pnl.pnlBps,
    trade_count: pnl.tradeCount,
    volume_usd: pnl.volumeUsd,
    win_rate_bps: pnl.winRateBps,
    equity: pnl.equity.map(p => [Math.floor(p.t / 1000), p.bps]),
    epochs: [...keys.keys()].sort((a, b) => a - b),
    feed_seq: maxSeq,
    marks: { SOL: prices.SOL, JUP: prices.JUP, BONK: prices.BONK },
    book_usd: 2000,
    window_start: new Date(pnl.windowStart).toISOString(),
    window_end: new Date(pnl.windowEnd).toISOString(),
    pool: SOLANA_PROGRAM,
    code_hash: "polypus-attestor-v2",
    gateway_quote_digest: gw?.quoteDigest ?? "",
    attestation_kind: "simulated",
  };
  const canon = canonicalStatement(statement);
  const sig = signStatement(sk, canon);
  const res = await call(PNL_RELAY, REGISTRY, "publish_pnl", { trader, statement: canon, signature: sig }, { gas: 80 });
  st.published[trader] = { feedSeq: maxSeq, at: Date.now(), tx: res.txHash, pnlBps: pnl.pnlBps, tradeCount: pnl.tradeCount };
  activity.unshift({
    id: `pnl-${Date.now()}-${trader}`,
    at: Date.now(),
    kind: "pnl",
    trader,
    text: `${profile.handle} PnL attested: ${(pnl.pnlBps / 100).toFixed(2)}% over ${pnl.tradeCount} trades`,
    tx: { chain: "near", hash: res.txHash, url: nearTxUrl(res.txHash), label: "publish_pnl" },
  });
  activity.length = Math.min(activity.length, 60);
  delete st.errors[trader];
  log.info(`${profile.handle}: ${(pnl.pnlBps / 100).toFixed(2)}% · ${pnl.tradeCount} trades · seq ${maxSeq} → publish_pnl ${res.url}`);
}

function save() {
  writeJson(stateFile, { ...st, activity });
}

if (!ONCE) {
  serve(PORTS.attestor, {
    "GET /status": () => ({ ...st, pubkey: pk, x25519: xkp.publicKey, activity: activity.slice(0, 40), at: Date.now() }),
  });
  log.info(`attestor on 127.0.0.1:${PORTS.attestor} · ed25519 ${pk.slice(0, 8)}… · relay ${PNL_RELAY}`);
}
for (;;) {
  for (const t of TRADERS) {
    try {
      await attest(t);
    } catch (e) {
      st.errors[t] = String((e as Error)?.message ?? e).slice(0, 200);
      log.error(t, st.errors[t]);
    }
  }
  st.lastTickAt = Date.now();
  save();
  if (ONCE) break;
  await sleep(8000);
}
