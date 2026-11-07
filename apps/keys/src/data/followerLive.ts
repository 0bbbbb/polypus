import { viewCall } from "../near/registry.js";
import { LIVE_FOLLOWER, LIVE_TRADER } from "./constants.js";
import bundledSnapshot from "../../public/live/follower-snapshot.json";

export type SubOnChain = {
  follower: string;
  trader: string;
  agent_pubkey: string;
  agent_attestation_digest: string;
  guardrails_hash: string;
  status: string;
};

export type FollowerSnapshot = {
  generatedAt: string;
  agentPublicKey: string;
  agentAttestationDigest: string;
  guardrailsHash: string;
  decisions: {
    at: string;
    tradeId: string;
    side: string;
    symbol: string;
    quoteHuman: string;
    action: string;
    reason: string;
    explanation: string;
    devnetTx?: string;
  }[];
};

export async function fetchSubscriptionLive(
  follower = LIVE_FOLLOWER,
  trader = LIVE_TRADER,
): Promise<SubOnChain | null> {
  return viewCall<SubOnChain>("get_subscription", { follower, trader });
}

export async function loadFollowerSnapshot(): Promise<FollowerSnapshot | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}live/follower-snapshot.json`);
    if (res.ok) return (await res.json()) as FollowerSnapshot;
  } catch {
    /* use bundled copy */
  }
  return bundledSnapshot as FollowerSnapshot;
}
