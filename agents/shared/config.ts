import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

if (fs.existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));

export const REGISTRY = process.env.POLYPUS_REGISTRY ?? "polypus-keys-18e5.testnet";
export const REGISTRY_DEPLOY_TX = process.env.POLYPUS_REGISTRY_DEPLOY_TX ?? "12URKRtc3qZ7KQB1vMiYTrvJVbvrrvpjLUuLZ79yXeof";
export const NEAR_RPCS = (process.env.NEAR_RPC ?? "https://rpc.testnet.fastnear.com,https://near-testnet.drpc.org,https://rpc.testnet.near.org").split(",");
export const NEAR_RPC = NEAR_RPCS[0]!;
export const NEAR_TX_RPC = process.env.NEAR_TX_RPC ?? "https://near-testnet.drpc.org";
export const SOLANA_RPC = process.env.POLYPUS_RPC ?? "https://api.devnet.solana.com";
export const SOLANA_PROGRAM = "PoLYdUXuf78YC6aqE4qkmyFkfJi3mm773ZqJNECDYtj";
export const MPC_CONTRACT = "v1.signer-prod.testnet";
export const CHAIN_SIG_PATH = process.env.POLYPUS_CHAINSIG_PATH ?? "solana-1";
export const COPY_PATH_PREFIX = "polypus-copy";
export const CRED_DIR = process.env.NEAR_CREDENTIALS ?? `${process.env.HOME}/.near-credentials/testnet`;
export const KEYS_DIR = process.env.POLYPUS_KEYS_DIR ?? `${process.env.HOME}/.polypus-keys`;
export const RUN_DIR = process.env.POLYPUS_RUN_DIR ?? path.join(ROOT, ".polypus-run");
export const DEVNET_KEYPAIR = process.env.POLYPUS_DEVNET_KEYPAIR ?? `${process.env.HOME}/.config/solana/polypus-devnet.json`;

export const TRADER = process.env.POLYPUS_TRADER ?? "alice-18e5.testnet";
export const FOLLOWER = process.env.POLYPUS_FOLLOWER ?? "carol-18e5.testnet";
export const DEMO_ACCOUNT = process.env.POLYPUS_DEMO_ACCOUNT ?? FOLLOWER;
export const AGENT_OPERATOR = process.env.POLYPUS_AGENT_OPERATOR ?? "polypus-agent-18e5.testnet";
export const PNL_RELAY = process.env.POLYPUS_RELAY ?? REGISTRY;
// sealed-key slot for the attestor; the account never needs to exist
export const ATTESTOR_ID = "attestor.polypus-keys-18e5.testnet";

export const TRADERS = (process.env.POLYPUS_TRADERS ?? "alice-18e5.testnet,bob-18e5.testnet").split(",");

export const PORTS = {
  api: Number(process.env.POLYPUS_API_PORT ?? 8787),
  trader: Number(process.env.POLYPUS_TRADER_PORT ?? 8791),
  follower: Number(process.env.POLYPUS_FOLLOWER_PORT ?? 8792),
  attestor: Number(process.env.POLYPUS_ATTESTOR_PORT ?? 8793),
};

export const nearTxUrl = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
export const solTxUrl = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
