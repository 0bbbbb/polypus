import type { AttestedPnl, Trader } from "./types.js";
import { fetchTradersLive, type TraderOnChain } from "../near/registry.js";
import { pnlPercent } from "./recorded.js";

function parsePnl(t: TraderOnChain): AttestedPnl | undefined {
  if (!t.latest_pnl_statement) return undefined;
  try {
    const st = JSON.parse(t.latest_pnl_statement) as {
      pnl_bps?: number;
      trade_count?: number;
      window_start?: string;
      window_end?: string;
      attestation_kind?: string;
      code_hash?: string;
    };
    const attKind =
      st.attestation_kind === "outlayer-tdx"
        ? "dstack-tdx"
        : st.code_hash?.startsWith("nearai") || t.attestor_attestation_digest.startsWith("nearai")
          ? "near-ai-cloud"
          : "simulated";
    return {
      trader: t.account,
      pnlBps: st.pnl_bps ?? 0,
      windowStart: st.window_start ?? "",
      windowEnd: st.window_end ?? "",
      tradeCount: st.trade_count ?? 0,
      statementHash: "",
      signature: t.latest_pnl_signature,
      attestation: {
        kind: attKind as "near-ai-cloud" | "dstack-tdx" | "simulated",
        signerPublicKey: t.attestor_pubkey,
        nonce: "",
        measurement: st.code_hash ?? t.attestor_attestation_digest,
        quoteDigest: "",
        checks: [{ label: "On-chain ed25519 verify", ok: !!t.latest_pnl_signature, detail: "registry publish_pnl" }],
        fetchedAt: new Date().toISOString(),
        provenance: { kind: "live", network: "near-testnet", ref: "publish_pnl" },
      },
      provenance: { kind: "live", network: "near-testnet", ref: "get_traders" },
    };
  } catch {
    return undefined;
  }
}

export function mapTrader(t: TraderOnChain): Trader {
  const pnl =
    parsePnl(t) ??
    ({
      trader: t.account,
      pnlBps: 0,
      windowStart: "",
      windowEnd: "",
      tradeCount: 0,
      statementHash: "",
      signature: "",
      attestation: {
        kind: "simulated",
        signerPublicKey: t.attestor_pubkey,
        nonce: "",
        measurement: "pending",
        quoteDigest: "",
        checks: [],
        fetchedAt: new Date().toISOString(),
        provenance: { kind: "live", network: "near-testnet" },
      },
      provenance: { kind: "live", network: "near-testnet" },
    } satisfies AttestedPnl);
  return {
    account: t.account,
    handle: t.handle || t.account.split(".")[0],
    shieldedAddress: t.shielded_address,
    solanaAddress: t.solana_address,
    derivationPath: t.derivation_path,
    currentEpoch: t.current_epoch,
    price: { amount: t.price, token: { symbol: "NEAR", decimals: 24 }, periodDays: t.period_days },
    subscribers: t.subscriber_count,
    bio: t.bio,
    pnl,
  };
}

export async function loadLiveTraders(): Promise<Trader[]> {
  const rows = await fetchTradersLive();
  return rows.map(mapTrader).sort((a, b) => b.pnl.pnlBps - a.pnl.pnlBps);
}

export { pnlPercent };
