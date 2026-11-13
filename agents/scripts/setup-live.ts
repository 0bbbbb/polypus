#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { encryptFeedRecord, randomEpochKey, sealEpochKey } from "@polypus/sdk";
import { ATTESTOR_ID, KEYS_DIR, REGISTRY, ROOT, TRADERS } from "../shared/config.js";
import { call, getFeed, view, type TraderOnChain } from "../shared/near.js";
import { readJson, runFile, writeJson, logger } from "../shared/run.js";
import { derivedSolanaAddress } from "../shared/chainsig.js";
import { makeRecord, replay, type TradeRecord } from "../shared/book.js";
import { STYLE_BIO, decide, type Series } from "../shared/strategy.js";
import { priceHistory, SYMS, type Sym } from "../shared/prices.js";
import { agentAttestationBinding } from "../shared/tee.js";

const log = logger("seed");
const PROFILES: Record<string, { bio: string; price: string }> = {
  kestrel: { bio: STYLE_BIO.kestrel!, price: "500000000000000000000000" },
  heron: { bio: STYLE_BIO.heron!, price: "300000000000000000000000" },
};

function attestor(): { x25519: string; ed25519: string } {
  const r = spawnSync("npx", ["tsx", "attestor/index.ts", "--once"], { cwd: path.join(ROOT, "agents"), stdio: "inherit" });
  if (r.status !== 0) throw new Error("attestor --once failed");
  return readJson(runFile("attestor-pub.json"), { x25519: "", ed25519: "" });
}

const att = attestor();
const binding = await agentAttestationBinding(att.ed25519);
const history: Partial<Record<Sym, [number, number][]>> = {};

for (const account of TRADERS) {
  const t = await view<TraderOnChain | null>("get_trader", { account });
  if (!t) {
    log.warn(`${account} not registered`);
    continue;
  }
  const p = PROFILES[t.handle] ?? { bio: t.bio, price: t.price };
  const sol = (await derivedSolanaAddress(account, t.derivation_path || "solana-1")).toBase58();
  if (t.bio !== p.bio || t.solana_address !== sol || t.price !== p.price) {
    const r = await call(account, REGISTRY, "register_trader", {
      handle: t.handle,
      shielded_address: t.shielded_address,
      solana_address: sol,
      derivation_path: t.derivation_path || "solana-1",
      price: p.price,
      period_days: t.period_days,
      attestor_pubkey: t.attestor_pubkey,
      attestor_attestation_digest: t.attestor_attestation_digest,
      bio: p.bio,
    }, { gas: 60 });
    log.info(`${t.handle}: profile refreshed ${r.url}`);
  }
  if (t.attestor_pubkey !== att.ed25519) {
    const r = await call(account, REGISTRY, "set_attestor", { attestor_pubkey: att.ed25519, attestor_attestation_digest: binding.digest }, { gas: 40 });
    log.info(`${t.handle}: set_attestor ${att.ed25519.slice(0, 8)}… ${r.url}`);
  }

  const secretFile = path.join(KEYS_DIR, "trader-epochs", `${account}.json`);
  const secrets = readJson<{ keys: Record<string, number[]> }>(secretFile, { keys: {} });
  let profile = (await view<TraderOnChain>("get_trader", { account }))!;
  let epoch = profile.current_epoch;
  let key: Uint8Array;
  if (epoch > 0 && secrets.keys[String(epoch)]) {
    key = Uint8Array.from(secrets.keys[String(epoch)]!);
  } else {
    epoch += 1;
    key = randomEpochKey();
    secrets.keys[String(epoch)] = [...key];
    writeJson(secretFile, secrets, 0o600);
  }
  const sealed = sealEpochKey(account, ATTESTOR_ID, epoch, att.x25519, key);
  const r = await call(account, REGISTRY, "rotate_epoch", {
    epoch,
    sealed: [{ follower: ATTESTOR_ID, agent_pubkey: att.x25519, sealed_key: sealed }],
  }, { gas: 80 });
  log.info(`${t.handle}: epoch ${epoch} sealed to attestor ${r.url}`);
  const ts = readJson<{ traders: Record<string, { seals?: unknown[]; feedTx?: Record<string, string> }>; activity: unknown[] }>(runFile("trader-state.json"), { traders: {}, activity: [] });
  const entry = (ts.traders[account] ??= {});
  entry.seals = [...(entry.seals ?? []), { follower: ATTESTOR_ID, agentPubkey: att.x25519, epoch, tx: r.txHash, at: Date.now() }];
  writeJson(runFile("trader-state.json"), ts);

  profile = (await view<TraderOnChain>("get_trader", { account }))!;
  const existing = (await getFeed(account)).filter(f => f.epoch === epoch);
  if (existing.length) {
    log.info(`${t.handle}: epoch ${epoch} already has ${existing.length} trades; no backfill`);
    continue;
  }
  for (const s of SYMS) history[s] ??= await priceHistory(s, 5);
  const now = Date.now();
  const sent: TradeRecord[] = [];
  for (let at = now - 4 * 864e5; at < now - 3600_000; at += 3600_000) {
    const series: Partial<Record<Sym, Series>> = {};
    for (const s of SYMS) series[s] = history[s]!.filter(p => p[0] <= at);
    const d = decide(t.handle, replay(sent), series, at);
    if (!d) continue;
    const rec = makeRecord(account, epoch, d, new Date(at), "coingecko-history", true);
    sent.push(rec);
    const ct = encryptFeedRecord(account, epoch, key, rec as unknown as Record<string, unknown>);
    const res = await call(account, REGISTRY, "post_feed", { epoch, ciphertext: ct }, { gas: 50 });
    const seq = (res.events.find(e => e.event === "feed") as { data?: { seq?: number }[] } | undefined)?.data?.[0]?.seq;
    if (seq != null) (entry.feedTx ??= {})[String(seq)] = res.txHash;
    log.info(`${t.handle}: backfilled #${seq} ${d.side} ${d.sym} $${d.usd.toFixed(0)} @ ${d.price.toPrecision(5)} (${new Date(at).toISOString().slice(0, 16)})`);
  }
  writeJson(runFile("trader-state.json"), ts);
}

attestor();
log.info("setup complete");
