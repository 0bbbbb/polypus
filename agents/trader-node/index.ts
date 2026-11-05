#!/usr/bin/env node
/** Trader node: seal epoch keys + post encrypted trade feed after (simulated) settlement. */
import { accountFor, view, tg } from "../shared/near.js";
import { REGISTRY, TRADER } from "../shared/config.js";
import {
  encryptFeedRecord,
  randomEpochKey,
  sealEpochKey,
} from "@polypus/sdk";
import { runDevnetSettle, syncPublicDeployment } from "../shared/devnet.js";

async function main() {
  const trader = await accountFor(TRADER);
  const profile = await view<{
    current_epoch: number;
    handle: string;
  }>("get_trader", { account: TRADER });
  const follower = process.env.POLYPUS_FOLLOWER ?? "carol-18e5.testnet";
  const sub = await view<{ agent_pubkey: string } | null>("get_subscription", {
    follower,
    trader: TRADER,
  });
  if (!sub?.agent_pubkey) {
    throw new Error("No active subscription — run npm run follower -w agents first");
  }
  const epoch = Math.max(1, (profile?.current_epoch ?? 0) + 1);
  const epochKey = randomEpochKey();
  const sealed = sealEpochKey(TRADER, follower, epoch, sub.agent_pubkey, epochKey);
  await trader.functionCall({
    contractId: REGISTRY,
    methodName: "rotate_epoch",
    args: {
      epoch,
      sealed: [{ follower, agent_pubkey: sub.agent_pubkey, sealed_key: sealed }],
    },
    gas: tg(120),
    attachedDeposit: 0n,
  });
  console.log(`rotate_epoch → ${epoch}`);

  const settlementSig = runDevnetSettle("trader");
  syncPublicDeployment();

  const trade = {
    id: `t-${Date.now()}`,
    trader: TRADER,
    epoch,
    side: "buy",
    base: { symbol: "SOL", decimals: 9 },
    quote: { symbol: "pUSD", decimals: 6 },
    baseAmount: "1000000000",
    quoteAmount: "180000000",
    price: "180.0",
    executedAt: new Date().toISOString(),
    settlements: settlementSig ? [settlementSig] : [],
    provenance: { kind: "live", network: "solana-devnet" },
  };
  const ct = encryptFeedRecord(TRADER, epoch, epochKey, trade);
  await trader.functionCall({
    contractId: REGISTRY,
    methodName: "post_feed",
    args: { epoch, ciphertext: ct },
    gas: tg(80),
    attachedDeposit: 0n,
  });
  console.log("post_feed ok (trade hidden on-chain)");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
