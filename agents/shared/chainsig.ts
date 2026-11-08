import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { call, viewOn } from "./near.js";
import { DEVNET_KEYPAIR, MPC_CONTRACT, SOLANA_RPC, nearTxUrl, solTxUrl } from "./config.js";

export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const conn = new Connection(SOLANA_RPC, "confirmed");

const derived = new Map<string, PublicKey>();

export async function derivedSolanaAddress(predecessor: string, path: string): Promise<PublicKey> {
  const k = `${predecessor}|${path}`;
  const hit = derived.get(k);
  if (hit) return hit;
  const s = await viewOn<string>(MPC_CONTRACT, "derived_public_key", { path, predecessor, domain_id: 1 });
  const pk = new PublicKey(s.replace(/^ed25519:/, ""));
  derived.set(k, pk);
  return pk;
}

function deployer(): Keypair {
  const raw = JSON.parse(fs.readFileSync(DEVNET_KEYPAIR, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export async function solBalance(pk: PublicKey): Promise<number> {
  return (await conn.getBalance(pk, "confirmed")) / 1e9;
}

export async function ensureFunded(pk: PublicKey, minSol = 0.002, topUpSol = 0.01): Promise<string | null> {
  const bal = await conn.getBalance(pk, "confirmed");
  if (bal >= minSol * 1e9) return null;
  const payer = deployer();
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pk, lamports: Math.round(topUpSol * 1e9) }),
  );
  const sig = await conn.sendTransaction(tx, [payer]);
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

export type SignedSolanaTx = { solanaSig: string; solanaUrl: string; mpcTx: string; mpcUrl: string };

export async function mpcSendMemo(operator: string, path: string, memo: string): Promise<SignedSolanaTx> {
  const from = await derivedSolanaAddress(operator, path);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const tx = new Transaction().add(
        new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: from, isSigner: true, isWritable: false }], data: Buffer.from(memo) }),
      );
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = from;
      const msg = tx.serializeMessage();
      const signed = await call<{ scheme?: string; signature: number[] }>(
        operator,
        MPC_CONTRACT,
        "sign",
        { request: { path, payload_v2: { Eddsa: Buffer.from(msg).toString("hex") }, domain_id: 1 } },
        { gas: 300, deposit: 1n },
      );
      tx.addSignature(from, Buffer.from(Uint8Array.from(signed.value.signature)));
      if (!tx.verifySignatures()) throw new Error("MPC signature did not verify for derived key");
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      return { solanaSig: sig, solanaUrl: solTxUrl(sig), mpcTx: signed.txHash, mpcUrl: nearTxUrl(signed.txHash) };
    } catch (e) {
      lastErr = e;
      if (!/blockhash|expired|BlockheightExceeded/i.test(String((e as Error)?.message ?? e))) break;
    }
  }
  throw lastErr;
}
