#!/usr/bin/env node
// Buys a key with the demo account through the local API, waits for the copy timeline to finish,
// then checks every transaction on NEAR testnet RPC and Solana devnet (finalized).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = process.env.POLYPUS_API ?? "http://127.0.0.1:8787/api";
const NEAR_RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.fastnear.com";
const SOLANA_RPC = process.env.POLYPUS_RPC ?? "https://api.devnet.solana.com";
const trader = process.argv[2] ?? "alice-18e5.testnet";
const timeoutMs = Number(process.env.POLYPUS_E2E_TIMEOUT_S ?? 240) * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p, body) {
  const r = await fetch(`${API}${p}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error ?? r.status}`);
  return j;
}

let services = null;
async function ensureServices() {
  try {
    await api("/health");
    return;
  } catch {}
  console.log("starting services (npm run services)…");
  services = spawn("node", ["scripts/dev-all.mjs", "--no-app"], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const h = await api("/health");
      if (h.services.follower.up && h.services.trader.up) return;
    } catch {}
  }
  throw new Error("services did not come up");
}

async function nearOk(hash, sender) {
  const r = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" } }),
  });
  const j = await r.json();
  return j.result?.status?.SuccessValue !== undefined ? "final, success" : `FAILED ${JSON.stringify(j.error ?? j.result?.status).slice(0, 120)}`;
}

async function solOk(sig) {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(SOLANA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[sig], { searchTransactionHistory: true }] }),
    });
    const s = (await r.json()).result?.value?.[0];
    if (s?.err) return `FAILED ${JSON.stringify(s.err)}`;
    if (s?.confirmationStatus === "finalized") return "finalized";
    await sleep(3000);
  }
  return "not finalized yet";
}

const senderFor = (label, follower, h) => {
  if (label === "subscribe") return follower;
  if (label === "MPC sign") return h.agentOperator;
  if (label.startsWith("rotate_epoch") || label.startsWith("post_feed")) return trader;
  return follower;
};

try {
  await ensureServices();
  const h = await api("/health");
  console.log(`registry ${h.registry} · demo ${h.demo.account} (${h.demo.balanceNear.toFixed(2)} NEAR)`);
  const buy = await api("/demo/subscribe", { trader });
  console.log(`subscribe → ${buy.tx.url}`);
  const start = Date.now();
  let tl;
  let last = "";
  while (Date.now() - start < timeoutMs) {
    tl = await api(`/timeline?follower=${buy.follower}&trader=${trader}`);
    const line = tl.steps.map(s => `${s.label}: ${s.status}`).join("  ·  ");
    if (line !== last) console.log(`${((Date.now() - start) / 1000).toFixed(0).padStart(4)}s  ${line}`);
    last = line;
    if (tl.complete || tl.steps.some(s => s.status === "error")) break;
    await sleep(2000);
  }
  if (!tl?.complete) throw new Error(`timeline incomplete: ${tl?.steps.map(s => `${s.key}=${s.status} ${s.detail}`).join("; ")}`);
  console.log("\nverifying transactions");
  let bad = 0;
  for (const step of tl.steps) {
    for (const tx of step.txs) {
      const res = tx.chain === "near" ? await nearOk(tx.hash, senderFor(tx.label, buy.follower, h)) : await solOk(tx.hash);
      if (!/^final/.test(res)) bad++;
      console.log(`  ${step.label.padEnd(20)} ${tx.label.padEnd(18)} ${res.padEnd(16)} ${tx.url}`);
    }
  }
  if (bad) throw new Error(`${bad} transaction(s) failed verification`);
  console.log("\nall transactions verified");
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exitCode = 1;
} finally {
  services?.kill("SIGTERM");
}
