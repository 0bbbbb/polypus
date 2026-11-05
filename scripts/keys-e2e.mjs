#!/usr/bin/env node
/**
 * NEAR Keys demo checkpoints (testnet) + optional Solana devnet settlements.
 */
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const explorer = (base, sig) => (base ?? "").replace("{sig}", sig);

const run = (cmd, args, opts = {}) => {
  console.log("\n→", cmd, args.join(" "));
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const ledger = path.join(process.env.HOME ?? "", ".polypus-keys/devnet-ledger.json");
const depPath = path.join(root, "deployments/devnet.json");
const devnetOn = fs.existsSync(depPath) && fs.existsSync(ledger);

console.log("=== Polypus Keys E2E (NEAR testnet) ===\n");
console.log("1. Follower subscribes (pay testnet NEAR → trader)");
run("npm", ["run", "follower", "-w", "agents"]);

console.log("\n2. Trader: devnet Polypus deposit (if ledger ready) + encrypted feed");
run("npm", ["run", "trader", "-w", "agents"]);

console.log("\n3. Follower decrypts feed (guardrails)");
run("npx", ["tsx", "agents/follower/index.ts", "--decrypt-only"]);

if (devnetOn && process.env.POLYPUS_SKIP_DEVNET !== "1") {
  console.log("\n3b. Follower copy settles on devnet (shielded deposit)");
  const bin = path.join(root, "programs/target/release/keys-agent-settle");
  if (fs.existsSync(bin)) {
    const out = execFileSync(bin, ["follower"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        POLYPUS_ALLOW_DEVNET: "1",
        POLYPUS_RPC: process.env.POLYPUS_RPC ?? "https://api.devnet.solana.com",
        POLYPUS_DEPLOYMENT_OUT: depPath,
      },
    });
    const m = out.match(/sig=([1-9A-HJ-NP-Za-km-z]{87,88})/);
    if (m) {
      console.log("   see", `https://explorer.solana.com/tx/${m[1]}?cluster=devnet`);
    }
    fs.mkdirSync(path.join(root, "apps/keys/public/deployments"), { recursive: true });
    fs.copyFileSync(depPath, path.join(root, "apps/keys/public/deployments/devnet.json"));
  }
}

console.log("\n4. Attestor publishes PnL (SIMULATED TEE)");
run("npm", ["run", "attestor", "-w", "agents"]);

if (devnetOn) {
  const d = JSON.parse(fs.readFileSync(depPath, "utf8"));
  console.log("\n5. Solana devnet proof txs (Polypus + Chain Signatures):");
  for (const s of d.signatures ?? []) {
    console.log("   ", s.label, explorer(d.explorer_base, s.sig));
  }
  if (d.chain_signatures?.explorer_near) {
    console.log("   NEAR MPC sign", d.chain_signatures.explorer_near);
  } else if (!d.chain_signatures?.solana_tx_sig && process.env.POLYPUS_SKIP_CHAINSIG !== "1") {
    console.log("\n6. Chain Signatures → Solana devnet transfer");
    run("node", ["scripts/chainsig-devnet.mjs"]);
    const d2 = JSON.parse(fs.readFileSync(depPath, "utf8"));
    if (d2.chain_signatures?.explorer_solana) {
      console.log("   see", d2.chain_signatures.explorer_solana);
    }
    if (d2.chain_signatures?.explorer_near) {
      console.log("   NEAR sign", d2.chain_signatures.explorer_near);
    }
    fs.copyFileSync(depPath, path.join(root, "apps/keys/public/deployments/devnet.json"));
  } else if (d.chain_signatures?.explorer_solana) {
    console.log("\n6. Chain Signatures (already recorded)");
    console.log("   see", d.chain_signatures.explorer_solana);
    if (d.chain_signatures.explorer_near) console.log("   NEAR sign", d.chain_signatures.explorer_near);
  }
} else {
  console.log("\n5. Solana: SKIP — run bash scripts/devnet-deploy.sh after funding deployer");
}

console.log("\n=== Done. Open npm run app → VITE_LIVE=1 for registry-backed UI ===");
