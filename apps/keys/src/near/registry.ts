import { REGISTRY_ID } from "../data/recorded.js";

export const NEAR_RPC =
  import.meta.env.VITE_NEAR_RPC ?? "https://rpc.testnet.fastnear.com";

const RPC = NEAR_RPC;

export async function viewCall<T>(method: string, args: Record<string, unknown>): Promise<T | null> {
  try {
  const argsJson = JSON.stringify(args);
  const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(argsJson)));
  const body = {
    jsonrpc: "2.0",
    id: "pk",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: REGISTRY_ID,
      method_name: method,
      args_base64: argsBase64,
    },
  };
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json() as { error?: unknown; result?: { result?: number[] } };
  if (json.error || !json.result?.result) return null;
  const text = new TextDecoder().decode(Uint8Array.from(json.result.result));
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
  } catch {
    return null;
  }
}

export type TraderOnChain = {
  account: string;
  handle: string;
  shielded_address: string;
  solana_address: string;
  derivation_path: string;
  price: string;
  period_days: number;
  current_epoch: number;
  subscriber_count: number;
  latest_pnl_statement: string;
  latest_pnl_signature: string;
  attestor_pubkey: string;
  attestor_attestation_digest: string;
  bio?: string;
};

export async function fetchTradersLive(): Promise<TraderOnChain[]> {
  return (await viewCall<TraderOnChain[]>("get_traders", { from_index: 0, limit: 20 })) ?? [];
}

export type FeedRow = { seq: number; epoch: number; ciphertext: string; posted_at: string };

export async function fetchFeedLive(trader: string, fromSeq = 0, limit = 20): Promise<FeedRow[]> {
  return (await viewCall<FeedRow[]>("get_feed", { trader, from_seq: fromSeq, limit })) ?? [];
}
