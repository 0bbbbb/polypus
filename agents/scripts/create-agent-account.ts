#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { AGENT_OPERATOR, CRED_DIR } from "../shared/config.js";
import { balanceNear, call, hasCredential } from "../shared/near.js";

const funder = process.env.POLYPUS_FUNDER ?? "alice-18e5.testnet";
const amountNear = Number(process.env.POLYPUS_AGENT_FUND ?? "3");

if (hasCredential(AGENT_OPERATOR)) {
  console.log(`${AGENT_OPERATOR} credential already present; balance ${await balanceNear(AGENT_OPERATOR).catch(() => "?")} NEAR`);
  process.exit(0);
}
const kp = KeyPair.fromRandom("ed25519");
const file = path.join(CRED_DIR, `${AGENT_OPERATOR}.json`);
fs.writeFileSync(
  file,
  JSON.stringify({ account_id: AGENT_OPERATOR, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }),
  { mode: 0o600 },
);
const r = await call(funder, "testnet", "create_account", {
  new_account_id: AGENT_OPERATOR,
  new_public_key: kp.getPublicKey().toString(),
}, { gas: 100, deposit: BigInt(Math.round(amountNear * 1000)) * 10n ** 21n });
console.log(`created ${AGENT_OPERATOR} (funded ${amountNear} NEAR by ${funder}) tx ${r.url}`);
