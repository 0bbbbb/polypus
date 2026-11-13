#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const depPath = path.join(root, "deployments/devnet.json");
const RPC = process.env.POLYPUS_RPC ?? "https://api.devnet.solana.com";
const NEAR_ACCOUNT = process.env.POLYPUS_FOLLOWER ?? "carol-18e5.testnet";
const MPC_PATH = process.env.POLYPUS_CHAINSIG_PATH ?? "solana-1";
const deployerPath =
  process.env.POLYPUS_DEVNET_KEYPAIR ?? `${process.env.HOME}/.config/solana/polypus-devnet.json`;
const deployerPub = spawnSync("solana", ["address", "-k", deployerPath], { encoding: "utf8" })
  .stdout.trim();

const derivedView = spawnSync(
  "near",
  [
    "contract",
    "call-function",
    "as-read-only",
    "v1.signer-prod.testnet",
    "derived_public_key",
    "json-args",
    JSON.stringify({ path: MPC_PATH, predecessor: NEAR_ACCOUNT, domain_id: 1 }),
    "network-config",
    "testnet",
    "now",
  ],
  { encoding: "utf8", env: { ...process.env, NEAR_ENV: "testnet" } },
);
const m = derivedView.stdout.match(/ed25519:([1-9A-HJ-NP-Za-km-z]{32,44})/);
if (!m) {
  console.error(derivedView.stdout, derivedView.stderr);
  throw new Error("derived_public_key failed");
}
const mpcSolana = new PublicKey(m[1]);
console.log("MPC Solana address", mpcSolana.toBase58(), "for", NEAR_ACCOUNT);

const conn = new Connection(RPC, "confirmed");
const bal = await conn.getBalance(mpcSolana);
console.log("MPC balance", bal / 1e9, "SOL");
if (bal < 5000) {
  console.error("Fund MPC address first (scripts/chainsig-devnet.mjs expects ≥5000 lamports)");
  process.exit(2);
}

const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: mpcSolana,
    toPubkey: new PublicKey(deployerPub),
    lamports: 1_000,
  }),
);
const { blockhash } = await conn.getLatestBlockhash();
tx.recentBlockhash = blockhash;
tx.feePayer = mpcSolana;
const message = tx.serializeMessage();
const payloadHex = Buffer.from(message).toString("hex");
console.log("Signing", message.length, "byte Solana message via MPC…");

const signArgs = {
  request: {
    path: MPC_PATH,
    payload_v2: { Eddsa: payloadHex },
    domain_id: 1,
  },
};
const signProc = spawnSync(
  "near",
  [
    "contract",
    "call-function",
    "as-transaction",
    "v1.signer-prod.testnet",
    "sign",
    "json-args",
    JSON.stringify(signArgs),
    "prepaid-gas",
    "300 Tgas",
    "attached-deposit",
    "1 yoctoNEAR",
    "sign-as",
    NEAR_ACCOUNT,
    "network-config",
    "testnet",
    "sign-with-keychain",
    "send",
  ],
  { encoding: "utf8", env: { ...process.env, NEAR_ENV: "testnet" }, maxBuffer: 10 * 1024 * 1024 },
);
const plainOut = signProc.stdout.replace(/\u001b\[[0-9;]*m/g, "");
const txIdMatch = plainOut.match(/Transaction ID:\s*([A-Za-z0-9]+)/);
const nearTx = txIdMatch?.[1];
const jsonMatch = signProc.stdout.match(
  /\{\s*"scheme"\s*:\s*"Ed25519"[\s\S]*?"signature"\s*:\s*\[[\s\S]*?\]\s*\}/,
);
if (!jsonMatch) {
  console.error(signProc.stdout, signProc.stderr);
  throw new Error("MPC sign failed");
}
const signResult = JSON.parse(jsonMatch[0]);
const sigBytes = Uint8Array.from(signResult.signature);
tx.addSignature(mpcSolana, Buffer.from(sigBytes));
const raw = tx.serialize();
const solSig = await conn.sendRawTransaction(raw, { skipPreflight: false });
await conn.confirmTransaction(solSig, "confirmed");
console.log("Solana tx", solSig);
console.log("Explorer", `https://explorer.solana.com/tx/${solSig}?cluster=devnet`);
if (nearTx) {
  console.log("NEAR sign tx", `https://explorer.testnet.near.org/transactions/${nearTx}`);
}

const doc = JSON.parse(fs.readFileSync(depPath, "utf8"));
doc.chain_signatures = {
  near_account: NEAR_ACCOUNT,
  mpc_contract: "v1.signer-prod.testnet",
  path: MPC_PATH,
  domain_id: 1,
  solana_address: mpcSolana.toBase58(),
  fund_transfer_sig: doc.chain_signatures?.fund_transfer_sig ?? null,
  solana_tx_sig: solSig,
  near_sign_tx: nearTx ?? null,
  explorer_solana: `https://explorer.solana.com/tx/${solSig}?cluster=devnet`,
  explorer_near: nearTx ? `https://explorer.testnet.near.org/transactions/${nearTx}` : null,
};
doc.chain_signatures.fund_transfer_sig =
  process.env.POLYPUS_MPC_FUND_SIG ?? "X2MkWNo6cTntSd8zS4UDHMQYhLXJdXgS3VxdE77ECrPaisLiJS3vBZrNb12jGnPYBmsQ12h7WQdvyG3xB2k6Z7N";
doc.signatures = doc.signatures ?? [];
doc.signatures.push({ label: "chain_signatures_transfer", sig: solSig });
fs.writeFileSync(depPath, JSON.stringify(doc, null, 2) + "\n");
console.log("Updated", depPath);
