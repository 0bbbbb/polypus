export const REGISTRY = process.env.POLYPUS_REGISTRY ?? "polypus-keys-18e5.testnet";
export const NEAR_RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.near.org";
export const SOLANA_RPC = process.env.POLYPUS_RPC ?? "https://api.devnet.solana.com";
export const MPC_CONTRACT = "v1.signer-prod.testnet";
export const CHAIN_SIG_PATH = process.env.POLYPUS_CHAINSIG_PATH ?? "solana-1";
export const CRED_DIR = process.env.NEAR_CREDENTIALS ?? `${process.env.HOME}/.near-credentials/testnet`;

export const TRADER = process.env.POLYPUS_TRADER ?? "alice-18e5.testnet";
export const FOLLOWER = process.env.POLYPUS_FOLLOWER ?? "carol-18e5.testnet";
