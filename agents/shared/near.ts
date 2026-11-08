import { connect, KeyPair, keyStores, Account, providers } from "near-api-js";
import { REGISTRY, NEAR_RPCS, NEAR_TX_RPC, CRED_DIR, nearTxUrl } from "./config.js";
import fs from "node:fs";
import path from "node:path";


export function tg(tgas: number): bigint {
  return BigInt(tgas) * 1_000_000_000_000n;
}

const accounts = new Map<string, Promise<Account>>();
const locks = new Map<string, Promise<unknown>>();

export function hasCredential(named: string): boolean {
  return fs.existsSync(path.join(CRED_DIR, `${named}.json`));
}

export async function accountFor(named: string, nodeUrl = NEAR_TX_RPC): Promise<Account> {
  const cacheKey = `${named}|${nodeUrl}`;
  let p = accounts.get(cacheKey);
  if (!p) {
    p = (async () => {
      const credPath = path.join(CRED_DIR, `${named}.json`);
      if (!fs.existsSync(credPath)) throw new Error(`Missing NEAR credential for ${named}`);
      const cred = JSON.parse(fs.readFileSync(credPath, "utf8")) as { private_key: string };
      const keyStore = new keyStores.InMemoryKeyStore();
      await keyStore.setKey("testnet", named, KeyPair.fromString(cred.private_key as `ed25519:${string}`));
      const config = {
        networkId: "testnet",
        nodeUrl,
        keyStore,
        headers: {},
        logger: false,
      };
      const near = await connect(config as Parameters<typeof connect>[0]);
      return near.account(named);
    })();
    accounts.set(cacheKey, p);
  }
  return p;
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(r => (release = r));
  locks.set(key, prev.then(() => next));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

export type CallResult<T = unknown> = { txHash: string; url: string; value: T; events: Record<string, unknown>[] };

function parseEvents(res: { receipts_outcome: { outcome: { logs: string[] } }[] }): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of res.receipts_outcome) {
    for (const l of r.outcome.logs) {
      if (!l.startsWith("EVENT_JSON:")) continue;
      try {
        out.push(JSON.parse(l.slice("EVENT_JSON:".length)));
      } catch {}
    }
  }
  return out;
}

export async function call<T = unknown>(
  signer: string,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  opts: { gas?: number; deposit?: bigint; rpc?: string } = {},
): Promise<CallResult<T>> {
  return withLock(signer, async () => {
    const acc = await accountFor(signer, opts.rpc);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await acc.functionCall({
          contractId,
          methodName,
          args,
          gas: tg(opts.gas ?? 100),
          attachedDeposit: opts.deposit ?? 0n,
        });
        const txHash = res.transaction_outcome.id;
        const value = providers.getTransactionLastResult(res) as T;
        return { txHash, url: nearTxUrl(txHash), value, events: parseEvents(res) };
      } catch (e) {
        lastErr = e;
        const msg = String((e as Error)?.message ?? e);
        if (/InvalidNonce|nonce too|fetch failed|ECONNRESET/i.test(msg)) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  });
}

const cooldown = new Map<string, number>();

async function rpc<T>(method: string, params: unknown): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < NEAR_RPCS.length + 2; attempt++) {
    const url = NEAR_RPCS.find(u => (cooldown.get(u) ?? 0) < Date.now()) ?? NEAR_RPCS[attempt % NEAR_RPCS.length]!;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "p", method, params }),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`${url} HTTP ${res.status}`);
      const j = (await res.json()) as { result?: T & { error?: string }; error?: { code?: number; message?: string; data?: unknown } };
      if (j.error) {
        if (j.error.code === -429 || /rate limit/i.test(j.error.message ?? "")) throw new Error(`${url} rate limited`);
        throw new RpcError(`${method}: ${j.error.message} ${JSON.stringify(j.error.data ?? "")}`);
      }
      if (j.result && typeof (j.result as { error?: string }).error === "string") {
        throw new RpcError(`${method}: ${(j.result as { error: string }).error}`);
      }
      return j.result as T;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      lastErr = e;
      cooldown.set(url, Date.now() + 30_000);
      await sleep(200 * attempt);
    }
  }
  throw lastErr;
}

class RpcError extends Error {}

export async function viewOn<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString()) as T;
}

export function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return viewOn<T>(REGISTRY, method, args);
}

export async function balanceNear(account: string): Promise<number> {
  const r = await rpc<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: account });
  return Number(BigInt(r.amount) / 10n ** 18n) / 1e6;
}

export type TxStatus = {
  ok: boolean;
  signer: string;
  receiver: string;
  methods: string[];
  args: Record<string, unknown>[];
  deposit: bigint;
};

export async function txStatus(hash: string, sender: string): Promise<TxStatus> {
  const r = await rpc<{
    status: { SuccessValue?: string; Failure?: unknown };
    transaction: {
      signer_id: string;
      receiver_id: string;
      actions: { FunctionCall?: { method_name: string; args: string; deposit: string } }[];
    };
  }>("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "EXECUTED_OPTIMISTIC" });
  const fcs = r.transaction.actions.map(a => a.FunctionCall).filter(Boolean) as {
    method_name: string;
    args: string;
    deposit: string;
  }[];
  return {
    ok: r.status.SuccessValue !== undefined,
    signer: r.transaction.signer_id,
    receiver: r.transaction.receiver_id,
    methods: fcs.map(f => f.method_name),
    args: fcs.map(f => {
      try {
        return JSON.parse(Buffer.from(f.args, "base64").toString());
      } catch {
        return {};
      }
    }),
    deposit: fcs.reduce((s, f) => s + BigInt(f.deposit), 0n),
  };
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));


export type TraderOnChain = {
  account: string;
  handle: string;
  shielded_address: string;
  solana_address: string;
  derivation_path: string;
  price: string;
  period_days: number;
  attestor_pubkey: string;
  attestor_attestation_digest: string;
  bio: string;
  current_epoch: number;
  subscriber_count: number;
  latest_pnl_statement: string;
  latest_pnl_signature: string;
  latest_pnl_at: number;
};

export type SubscriptionOnChain = {
  follower: string;
  trader: string;
  agent_pubkey: string;
  agent_attestation_digest: string;
  guardrails_hash: string;
  starts_at: number;
  expires_at: number;
  status: "active" | "cancelled" | "expired";
  last_sealed_epoch: number;
  payment_receipt: string;
};

export type FeedOnChain = { seq: number; epoch: number; ciphertext: string; posted_at: number };

export const nsToMs = (ns: number | string) => Math.floor(Number(BigInt(String(ns)) / 1_000_000n));

export async function getFeed(trader: string, fromSeq = 0, max = 2000): Promise<FeedOnChain[]> {
  const out: FeedOnChain[] = [];
  let from = fromSeq;
  for (;;) {
    const page = await view<FeedOnChain[]>("get_feed", { trader, from_seq: from, limit: 100 });
    out.push(...page);
    if (page.length < 100 || out.length >= max) break;
    from = page[page.length - 1]!.seq + 1;
  }
  return out;
}
