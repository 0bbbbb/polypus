#!/usr/bin/env node
// usage: node scripts/verify-txs.mjs [follower] [trader]
const [follower = "carol-18e5.testnet", trader = "alice-18e5.testnet"] = process.argv.slice(2);
const api = process.env.API ?? "http://127.0.0.1:8787";
const nearRpcs = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"];
const solRpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";

const rpc = (url, method, params) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());

async function nearStatus(hash, signers) {
  for (const signer of signers) {
    for (const url of nearRpcs) {
      const r = await rpc(url, "tx", [hash, signer]).catch(() => null);
      if (r?.result) {
        const s = r.result.status;
        const ok = typeof s === "object" && ("SuccessValue" in s || "SuccessReceiptId" in s);
        return { ok, final: r.result.final_execution_status ?? "", signer: r.result.transaction.signer_id, receiver: r.result.transaction.receiver_id };
      }
    }
  }
  return null;
}

async function solStatus(sig) {
  const r = await rpc(solRpc, "getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
  const v = r.result?.value?.[0];
  return v ? { ok: !v.err, final: v.confirmationStatus } : null;
}

const tl = await fetch(`${api}/api/timeline?follower=${follower}&trader=${trader}`).then(r => r.json());
let bad = 0;
for (const step of tl.steps) {
  console.log(`${step.status.padEnd(8)} ${step.label}`);
  for (const tx of step.txs) {
    const st = tx.chain === "near"
      ? await nearStatus(tx.hash, [follower, trader, "polypus-agent-18e5.testnet"])
      : await solStatus(tx.hash);
    const pass = !!st?.ok && (tx.chain === "near" || st.final === "finalized");
    if (!pass) bad++;
    console.log(`  ${pass ? "ok  " : "FAIL"} ${tx.chain.padEnd(6)} ${tx.label.padEnd(14)} ${st?.final ?? "not found"} ${tx.url}`);
  }
}
console.log(tl.complete ? "timeline complete" : "timeline incomplete");
process.exit(bad || !tl.complete ? 1 : 0);
