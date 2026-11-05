#!/usr/bin/env node
/** PnL attestor (SIMULATED TEE). Signs statement and calls publish_pnl on registry. */
import { accountFor, view, tg } from "../shared/near.js";
import { TRADER, REGISTRY } from "../shared/config.js";
import { canonicalStatement, loadOrCreateAttestorSecret, signStatement, type PnlStatement } from "../shared/pnl.js";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import fs from "node:fs";
import path from "node:path";

const ATTESTOR_FILE =
  process.env.POLYPUS_ATTESTOR_KEY ?? `${process.env.HOME}/.polypus-keys/attestor-ed25519.json`;

async function main() {
  const sk = loadOrCreateAttestorSecret(ATTESTOR_FILE);
  const pk = base58.encode(ed25519.getPublicKey(sk));
  console.log(`Attestor pubkey (register on trader): ${pk}`);

  const deploymentPath = path.resolve("deployments/devnet.json");
  let pool = "PoLYdUXuf78YC6aqE4qkmyFkfJi3mm773ZqJNECDYtj";
  let slot = 0;
  if (fs.existsSync(deploymentPath)) {
    const d = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as { pool?: string; signatures?: { sig: string }[] };
    if (d.pool) pool = d.pool;
    slot = 1;
  }

  const now = new Date();
  const statement: PnlStatement = {
    v: 1,
    trader: TRADER,
    pnl_bps: 3842,
    trade_count: slot > 0 ? 6 : 2,
    window_start: new Date(now.getTime() - 7 * 864e5).toISOString(),
    window_end: now.toISOString(),
    pool,
    scanned_to_slot: slot,
    notes_scanned: 12,
    code_hash: "simulated-attestor-v0",
    attestation_kind: "simulated",
  };
  const canon = canonicalStatement(statement);
  const sig = signStatement(sk, canon);

  const trader = await view<{ account: string; attestor_pubkey: string }>("get_trader", { account: TRADER });
  if (!trader?.attestor_pubkey || trader.attestor_pubkey !== pk) {
    const alice = await accountFor(TRADER);
    await alice.functionCall({
      contractId: REGISTRY,
      methodName: "set_attestor",
      args: { attestor_pubkey: pk, attestor_attestation_digest: "simulated-tee-v0" },
      gas: tg(40),
      attachedDeposit: 0n,
    });
    console.log("set_attestor →", pk);
  }

  const relay = await accountFor(process.env.POLYPUS_RELAY ?? TRADER);
  const res = await relay.functionCall({
    contractId: REGISTRY,
    methodName: "publish_pnl",
    args: { trader: TRADER, statement: canon, signature: sig },
    gas: tg(80),
    attachedDeposit: 0n,
  });
  console.log("publish_pnl tx:", res.transaction_outcome.id);
  console.log("statement pnl_bps:", statement.pnl_bps);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
