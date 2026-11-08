import { useMemo, useState } from "preact/hooks";
import { api } from "../api/client";
import type { ProofView } from "../api/types";
import { AddrLink, Avatar, Card, Copyable, Empty, IArrowNE, ICheck, Skel, Tag, TxLink } from "../components/ui";
import { ago, dateTime, short } from "../lib/format";
import { useAsync, useNow } from "../lib/hooks";
import { useStore } from "../state/store";

export function Proof() {
  const tick = useStore(s => s.tick);
  const health = useStore(s => s.health);
  const proof = useAsync(s => api.proof(s), [null, tick]);
  const d = proof.data;

  return (
    <main class="page wrap proof" id="main">
      <header class="ph">
        <p class="eyebrow">Proof</p>
        <h1 class="h1">Every claim, on-chain.</h1>
        <p class="lead">Registry, attested PnL, Chain Signatures and TEE details, each with a link you can check yourself.</p>
      </header>

      {proof.error && !d && <div class="card"><Empty title="Proof data unavailable">{proof.error.message}</Empty></div>}
      {!d && !proof.error && <ProofSkeleton />}
      {d && (
        <div class="pgrid pgrid--proof">
          <div class="pgrid__main">
            <TraderProofs d={d} />
            <Recent d={d} />
          </div>
          <aside class="pgrid__side">
            <Card title="Registry" meta={<Tag>NEAR {d.network.near}</Tag>}>
              <dl class="dl">
                <div><dt>Contract</dt><dd><AddrLink addr={d.registry.account} chain="near" /></dd></div>
                <div><dt>Deploy</dt><dd><TxLink tx={d.registry.deployTx} hideLabel /></dd></div>
                <div><dt>RPC</dt><dd class="mono trunc" title={d.network.rpc}>{d.network.rpc.replace(/^https?:\/\//, "")}</dd></div>
                <div><dt>Solana</dt><dd>{d.network.solana}</dd></div>
              </dl>
              <p class="dl__label">Methods</p>
              <div class="methods">{d.registry.methods.map(m => <span key={m} class="mchip mono">{m}</span>)}</div>
            </Card>
            <Card title="Chain Signatures">
              <dl class="dl">
                <div><dt>MPC contract</dt><dd><AddrLink addr={d.chainSignatures.mpcContract} chain="near" /></dd></div>
                <div><dt>Operator</dt><dd><AddrLink addr={d.chainSignatures.operator} chain="near" /></dd></div>
                <div><dt>Domain</dt><dd class="tnum">{d.chainSignatures.domainId} · {d.chainSignatures.domainId === 1 ? "ed25519" : "secp256k1"}</dd></div>
                <div><dt>Path prefix</dt><dd class="mono">{d.chainSignatures.pathPrefix}</dd></div>
                <div><dt>Solana program</dt><dd><a class="addr" href={d.solanaProgram.url} target="_blank" rel="noreferrer" title={d.solanaProgram.id}><span class="mono">{short(d.solanaProgram.id)}</span><IArrowNE size={12} /></a></dd></div>
              </dl>
            </Card>
            <Card title="Copy agent TEE" meta={<Tag tone={d.tee.kind === "nearai-gateway" ? "ink" : undefined}>{d.tee.kind === "nearai-gateway" ? <><ICheck size={12} />Attested</> : "Simulated"}</Tag>}>
              <dl class="dl">
                <div><dt>Kind</dt><dd>{d.tee.kind === "nearai-gateway" ? "NEAR AI gateway attested" : "Simulated"}</dd></div>
                <div><dt>Digest</dt><dd><Copyable value={d.tee.digest} /></dd></div>
                <div><dt>Quote digest</dt><dd><Copyable value={d.tee.quoteDigest} /></dd></div>
                {d.tee.signingAddress && <div><dt>Signing address</dt><dd><Copyable value={d.tee.signingAddress} /></dd></div>}
                <div><dt>Inference</dt><dd>{d.tee.inference === "near-ai-cloud" ? "NEAR AI Cloud" : "Template"}</dd></div>
                <div><dt>Checked</dt><dd class="tnum">{dateTime(d.tee.checkedAt)}</dd></div>
              </dl>
            </Card>
            {health && (
              <Card title="Services">
                <dl class="dl">
                  {Object.entries(health.services).map(([k, v]) => (
                    <div key={k}><dt class="cap"><span class={v.up ? "pip is-up" : "pip"} />{k}</dt><dd>{v.up ? (v.lastTickAt ? ago(v.lastTickAt) : "up") : v.note ?? "down"}</dd></div>
                  ))}
                  <div><dt>Agent operator</dt><dd><AddrLink addr={health.agentOperator} chain="near" /></dd></div>
                </dl>
              </Card>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}

function TraderProofs({ d }: { d: ProofView }) {
  const [i, setI] = useState(0);
  const t = d.traders[i];
  const pretty = useMemo(() => {
    if (!t) return "";
    try { return JSON.stringify(JSON.parse(t.pnlStatement), null, 2); } catch { return t.pnlStatement; }
  }, [t?.pnlStatement]);
  if (!t) return <Card title="Attested PnL"><Empty title="No traders yet" /></Card>;
  return (
    <Card
      title="Attested PnL"
      class="pproof"
      meta={
        <div class="seg" role="tablist">
          {d.traders.map((x, j) => (
            <button key={x.account} type="button" role="tab" aria-selected={j === i} class={j === i ? "is-on" : ""} onClick={() => setI(j)}>{x.handle}</button>
          ))}
        </div>
      }
    >
      <div class="pproof__who">
        <Avatar account={t.account} size={32} />
        <div><b>{t.handle}</b><AddrLink addr={t.account} chain="near" /></div>
        {t.pnlTx && <span class="pproof__tx"><span class="muted">publish_pnl</span><TxLink tx={t.pnlTx} hideLabel /></span>}
      </div>
      <dl class="dl">
        <div><dt>Attestor pubkey</dt><dd><Copyable value={t.attestorPubkey} /></dd></div>
        <div><dt>Attestor digest</dt><dd><Copyable value={t.attestorDigest} /></dd></div>
        <div><dt>ed25519 signature</dt><dd><Copyable value={t.pnlSignature} /></dd></div>
        {t.pnlSignatureValid !== undefined && <div><dt>Signature check</dt><dd>{t.pnlSignatureValid ? <span class="ok"><ICheck size={12} />Valid for attestor key</span> : <span class="inline-err">Invalid</span>}</dd></div>}
        <div><dt>Verified by</dt><dd>registry <span class="mono">publish_pnl</span> (ed25519_verify)</dd></div>
      </dl>
      <div class="code">
        <div class="code__bar"><span>statement.json</span><Copyable value={t.pnlStatement} display="Copy" /></div>
        <pre class="mono">{pretty}</pre>
      </div>
    </Card>
  );
}

function Recent({ d }: { d: ProofView }) {
  useNow();
  const [shown, setShown] = useState(12);
  return (
    <Card title="Recent transactions" meta={<span class="muted">{d.recent.length} on NEAR testnet and Solana devnet</span>} flush>
      {d.recent.length === 0 ? <Empty title="No transactions yet" /> : (
        <div class="rt">
          <div class="rt__head"><span>Method</span><span>Chain</span><span>Hash</span><span class="r">Time</span></div>
          {d.recent.slice(0, shown).map(tx => (
            <a key={tx.hash} class="rt__row" href={tx.url} target="_blank" rel="noreferrer">
              <span class="rt__m">{tx.label}</span>
              <span><Tag>{tx.chain === "near" ? "NEAR" : "Solana"}</Tag></span>
              <span class="mono rt__h">{tx.hash.slice(0, 10)}…{tx.hash.slice(-10)}</span>
              <span class="r muted tnum">{tx.at ? ago(tx.at) : ""}</span>
            </a>
          ))}
          {d.recent.length > shown && <button type="button" class="ft__more" onClick={() => setShown(n => n + 24)}>Show {Math.min(24, d.recent.length - shown)} more</button>}
        </div>
      )}
    </Card>
  );
}

function ProofSkeleton() {
  return (
    <div class="pgrid pgrid--proof" aria-hidden="true">
      <div class="pgrid__main"><div class="card"><Skel h={420} r={12} /></div></div>
      <aside class="pgrid__side"><div class="card"><Skel h={200} r={12} /></div><div class="card"><Skel h={180} r={12} /></div></aside>
    </div>
  );
}
