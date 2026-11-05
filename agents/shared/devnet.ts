import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOLANA_RPC } from "./config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function devnetReady(): boolean {
  const ledger = `${process.env.HOME}/.polypus-keys/devnet-ledger.json`;
  return fs.existsSync(path.join(root, "deployments/devnet.json")) && fs.existsSync(ledger);
}

/** Real Groth16 Polypus deposit on devnet (trader trade or follower copy). */
export function runDevnetSettle(role: "trader" | "follower"): string | null {
  if (process.env.POLYPUS_SKIP_DEVNET === "1" || !devnetReady()) return null;
  const bin = path.join(root, "programs/target/release/keys-agent-settle");
  if (!fs.existsSync(bin)) {
    console.warn("keys-agent-settle missing — run: (cd programs && cargo build -r -p polypus-tests --bin keys-agent-settle)");
    return null;
  }
  const out = execFileSync(bin, [role], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      POLYPUS_ALLOW_DEVNET: "1",
      POLYPUS_RPC: SOLANA_RPC,
      POLYPUS_DEPLOYMENT_OUT: path.join(root, "deployments/devnet.json"),
    },
  });
  const m = out.match(/sig=([1-9A-HJ-NP-Za-km-z]{87,88})/);
  if (m) {
    const url = `https://explorer.solana.com/tx/${m[1]}?cluster=devnet`;
    console.log(`devnet ${role} settlement → ${url}`);
    return m[1];
  }
  return null;
}

export function syncPublicDeployment(): void {
  const src = path.join(root, "deployments/devnet.json");
  const dstDir = path.join(root, "apps/keys/public/deployments");
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(src, path.join(dstDir, "devnet.json"));
}
