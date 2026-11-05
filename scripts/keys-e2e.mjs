#!/usr/bin/env node
/**
 * NEAR Keys demo checkpoints (testnet). Solana devnet step runs if deployments/devnet.json exists.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, opts = {}) => {
  console.log("\n→", cmd, args.join(" "));
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

console.log("=== Polypus Keys E2E (NEAR testnet) ===\n");
console.log("1. Follower subscribes (pay testnet NEAR → trader)");
run("npm", ["run", "follower", "-w", "agents"]);

console.log("\n2. Trader seals epoch key + posts encrypted feed");
run("npm", ["run", "trader", "-w", "agents"]);

console.log("\n3. Follower decrypts feed (guardrails)");
run("npx", ["tsx", "agents/follower/index.ts", "--decrypt-only"]);

console.log("\n4. Attestor publishes PnL (SIMULATED TEE)");
run("npm", ["run", "attestor", "-w", "agents"]);

const dep = path.join(root, "deployments/devnet.json");
if (fs.existsSync(dep)) {
  const d = JSON.parse(fs.readFileSync(dep, "utf8"));
  console.log("\n5. Solana settlements:", d.network, d.signatures?.length ?? 0, "txs");
  for (const s of d.signatures ?? []) {
    const url = (d.explorer_base ?? "").replace("{sig}", s.sig);
    console.log("   ", s.label, url);
  }
} else {
  console.log("\n5. Solana: SKIP — fund devnet (scripts/FUND_DEVNET.md) then bash scripts/devnet-deploy.sh");
}

console.log("\n=== Done. Open npm run app → VITE_LIVE=1 for registry-backed UI ===");
