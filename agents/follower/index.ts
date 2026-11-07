#!/usr/bin/env node
/** Follower agent: TEE-labelled; unseal epoch key, decrypt feed, guardrails, devnet copy. */
import { accountFor, view, tg } from "../shared/near.js";
import { REGISTRY, TRADER, FOLLOWER } from "../shared/config.js";
import { generateAgentKeypair, unsealEpochKey, decryptFeedRecord } from "@polypus/sdk";
import { runDevnetSettle, syncPublicDeployment } from "../shared/devnet.js";
import { DEFAULT_GUARDRAILS, evaluateCopy, guardrailsHash } from "../shared/guardrails.js";
import { agentAttestationBinding } from "../shared/tee.js";
import { explainCopyDecision } from "../shared/nearai.js";

async function main() {
  const decryptOnly = process.argv.includes("--decrypt-only");
  const agentFile = process.env.POLYPUS_AGENT_KEY_FILE ?? `${process.env.HOME}/.polypus-keys/agent-x25519.json`;
  let agent = generateAgentKeypair();
  try {
    const fs = await import("node:fs");
    if (fs.existsSync(agentFile)) {
      const j = JSON.parse(fs.readFileSync(agentFile, "utf8")) as { publicKey: string; secretKey: number[] };
      agent = { publicKey: j.publicKey, secretKey: Uint8Array.from(j.secretKey) };
    } else {
      fs.mkdirSync(agentFile.replace(/\/[^/]+$/, ""), { recursive: true });
      fs.writeFileSync(agentFile, JSON.stringify({ publicKey: agent.publicKey, secretKey: [...agent.secretKey] }));
    }
  } catch {
    /* keep ephemeral */
  }
  const follower = await accountFor(FOLLOWER);
  const price = await view<{ price: string }>("get_trader", { account: TRADER });
  const deposit = BigInt(price?.price ?? "500000000000000000000000");

  const tee = await agentAttestationBinding(agent.publicKey);
  const gHash = guardrailsHash(DEFAULT_GUARDRAILS);
  console.log(`TEE label: ${tee.kind} · digest ${tee.digest}`);

  if (!decryptOnly) {
    console.log("Subscribing with agent pubkey", agent.publicKey);
    await follower.functionCall({
      contractId: REGISTRY,
      methodName: "subscribe",
      args: {
        trader: TRADER,
        agent_pubkey: agent.publicKey,
        agent_attestation_digest: tee.digest,
        guardrails_hash: gHash,
      },
      gas: tg(120),
      attachedDeposit: deposit,
    });
    console.log("subscribe ok");
  }

  const profile = await view<{ current_epoch: number }>("get_trader", { account: TRADER });
  const epoch = profile?.current_epoch ?? 1;
  const sealed = await view<string | null>("get_sealed_key", {
    trader: TRADER,
    follower: FOLLOWER,
    epoch,
  });
  if (!sealed) {
    console.log("No sealed key yet — run trader-node after subscribe");
    return;
  }
  const epochKey = unsealEpochKey(TRADER, FOLLOWER, epoch, agent.secretKey, sealed);
  const feed = await view<{ seq: number; epoch: number; ciphertext: string }[]>("get_feed", {
    trader: TRADER,
    from_seq: 0,
    limit: 10,
  });
  for (const row of feed ?? []) {
    if (row.epoch !== epoch) continue;
    const trade = decryptFeedRecord(TRADER, epoch, epochKey, row.ciphertext);
    const { action, reason } = evaluateCopy(trade, DEFAULT_GUARDRAILS);
    const base = trade.base as { symbol?: string } | undefined;
  const expl = await explainCopyDecision({
      side: String(trade.side ?? "buy"),
      symbol: String(base?.symbol ?? "SOL"),
      quoteAmount: String(trade.quoteAmount ?? "0"),
      action,
      reason,
    });
    console.log(`trade ${trade.id}: ${action} (${trade.side} ${base?.symbol}) — ${expl.kind}`);
    console.log(`  agent: ${expl.text}`);
    if ((action === "copy" || action === "resize") && !decryptOnly) {
      const sig = runDevnetSettle("follower");
      if (sig) syncPublicDeployment();
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
