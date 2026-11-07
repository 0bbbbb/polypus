/** Chain Signatures metadata for the UI (read-only; MPC sign happens in agents/scripts). */
const MPC = "v1.signer-prod.testnet";
const RPC = import.meta.env.VITE_NEAR_RPC ?? "https://rpc.testnet.near.org";

export type ChainSigView = {
  nearAccount: string;
  mpcContract: string;
  path: string;
  domainId: number;
  solanaAddress: string | null;
};

export async function fetchDerivedSolanaAddress(nearAccount: string, path = "solana-1"): Promise<string | null> {
  const args = JSON.stringify({ path, predecessor: nearAccount, domain_id: 1 });
  const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(args)));
  const body = {
    jsonrpc: "2.0",
    id: "cs",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: MPC,
      method_name: "derived_public_key",
      args_base64: argsBase64,
    },
  };
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as { result?: { result?: number[] } };
  if (!json.result?.result) return null;
  const text = new TextDecoder().decode(Uint8Array.from(json.result.result));
  const m = text.match(/ed25519:([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return m?.[1] ?? null;
}

export async function chainSigForTrader(nearAccount: string, path: string): Promise<ChainSigView> {
  const solanaAddress = await fetchDerivedSolanaAddress(nearAccount, path);
  return {
    nearAccount,
    mpcContract: MPC,
    path,
    domainId: 1,
    solanaAddress,
  };
}
