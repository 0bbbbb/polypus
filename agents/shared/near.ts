import { connect, KeyPair, keyStores, Account } from "near-api-js";
import { REGISTRY, NEAR_RPC, CRED_DIR } from "./config.js";
import fs from "node:fs";
import path from "node:path";

export function tg(tgas: number): bigint {
  return BigInt(tgas) * 1_000_000_000_000n;
}

export async function accountFor(named: string): Promise<Account> {
  const credPath = path.join(CRED_DIR, `${named}.json`);
  if (!fs.existsSync(credPath)) throw new Error(`Missing credential ${credPath}`);
  const cred = JSON.parse(fs.readFileSync(credPath, "utf8")) as { private_key: string; account_id?: string };
  const keyPair = KeyPair.fromString(cred.private_key);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("testnet", named, keyPair);
  const near = await connect({
    networkId: "testnet",
    nodeUrl: NEAR_RPC,
    keyStore,
    headers: {},
  });
  return near.account(named);
}

export async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const near = await connect({ networkId: "testnet", nodeUrl: NEAR_RPC, headers: {} });
  const acc = await near.account(REGISTRY);
  return acc.viewFunction({ contractId: REGISTRY, methodName: method, args }) as Promise<T>;
}
