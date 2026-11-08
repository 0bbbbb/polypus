import { useEffect, useState } from "preact/hooks";
import type { CopyRecord, Guardrails, KeyHolding, Portfolio as P, TeeView, TxRef } from "../api/types";
import { GuardrailsEditor, sameGuardrails } from "../components/Guardrails";
import { Timeline } from "../components/Timeline";
import { AddrLink, Ago, Avatar, Card, Copyable, Empty, IArrow, ICheck, IChevronDown, Skel, Tag, TxLink } from "../components/ui";
import { clock, date, daysLeft, num, short } from "../lib/format";
import { href } from "../lib/router";
import { DEFAULT_GUARDRAILS, errText, openWalletModal, saveGuardrails } from "../state/actions";
import { tlKey, useStore } from "../state/store";

export function Portfolio() {
  const identity = useStore(s => s.identity);
  const p = useStore(s => s.portfolio);
  const err = useStore(s => s.portfolioError);

  if (!identity) {
    return (
      <main class="page wrap" id="main">
        <div class="pf-empty">
          <Empty
            title="No account selected"
            action={<><a class="btn btn--dark" href={href.discover}>Discover traders</a><button type="button" class="btn btn--line" onClick={openWalletModal}>Connect wallet</button></>}
          >
            Connect a NEAR testnet wallet, or pick a trader and try the demo account.
          </Empty>
        </div>
      </main>
    );
  }

  const ready = p && p.follower === identity.account;
  const keys = ready ? [...p.keys].sort((a, b) => rankStatus(a) - rankStatus(b) || b.expiresAt - a.expiresAt) : [];
  const copies = keys.reduce((n, k) => n + k.copies.filter(c => c.status === "confirmed").length, 0);

  return (
    <main class="page wrap" id="main">
      <header class="pfh">
        <Avatar account={identity.account} size={56} />
        <div class="pfh__id">
          <p class="pfh__k">{identity.kind === "demo" || p?.isDemo ? "Demo account" : "Connected wallet"}</p>
          <h1 class="pfh__name">{identity.account}</h1>
          <p class="pfh__meta">
            <AddrLink addr={identity.account} chain="near" />
            {(identity.kind === "demo" || p?.isDemo) && <Tag>Signed server-side</Tag>}
          </p>
        </div>
        <dl class="pfh__stats">
          <div><dt>Keys</dt><dd class="tnum">{ready ? keys.filter(k => k.status === "active").length : <Skel w={20} h={22} />}</dd></div>
          <div><dt>Decrypted</dt><dd class="tnum">{ready ? keys.reduce((n, k) => n + k.decrypted.length, 0) : <Skel w={28} h={22} />}</dd></div>
          <div><dt>Copied</dt><dd class="tnum">{ready ? copies : <Skel w={28} h={22} />}</dd></div>
        </dl>
      </header>

      {err && !ready && <p class="inline-err">Couldn't load this portfolio: {err}</p>}

      <div class="pgrid">
        <div class="pgrid__main">
          {!ready && !err && <KeySkeleton />}
          {ready && keys.length === 0 && (
            <div class="card">
              <Empty title="No keys yet" action={<a class="btn btn--dark" href={href.discover}>Discover traders <IArrow size={12} /></a>}>
                Buy a trader's key and your agent starts decrypting and copying their trades here.
              </Empty>
            </div>
          )}
          {keys.map(k => <KeyCard key={k.trader} p={p!} k={k} />)}
        </div>
        <aside class="pgrid__side">
          {ready ? <AgentCard tee={p.tee} /> : <div class="card"><Skel h={220} r={12} /></div>}
          {ready && <CopyWallets keys={keys} />}
        </aside>
      </div>
    </main>
  );
}

const hashLabel = (h: string) => (h.startsWith("sha256-") ? `sha256-${short(h.slice(7))}` : short(h));

const rankStatus = (k: KeyHolding) => (k.status === "active" ? 0 : k.status === "expired" ? 1 : 2);

function AgentCard({ tee }: { tee: TeeView }) {
  const attested = tee.kind === "nearai-gateway";
  return (
    <Card title="Copy agent" meta={<Tag tone={attested ? "ink" : undefined}>{attested ? <><ICheck size={12} />Attested</> : "Simulated"}</Tag>} class="agent">
      <dl class="dl">
        <div><dt>TEE</dt><dd>{attested ? "NEAR AI gateway attested" : "Simulated (local process)"}</dd></div>
        <div><dt>Digest</dt><dd><Copyable value={tee.digest} /></dd></div>
        <div><dt>Quote digest</dt><dd><Copyable value={tee.quoteDigest} /></dd></div>
        {tee.signingAddress && <div><dt>Signing address</dt><dd><Copyable value={tee.signingAddress} display={short(tee.signingAddress.replace(/^0x/i, ""))} /></dd></div>}
        <div><dt>Inference</dt><dd>{tee.inference === "near-ai-cloud" ? "NEAR AI Cloud" : "Template"}</dd></div>
        <div><dt>Checked</dt><dd><Ago t={tee.checkedAt} /></dd></div>
      </dl>
      <p class="card__note">The agent holds the X25519 secret for every key below. Sealed epoch keys open only inside it.</p>
    </Card>
  );
}

function CopyWallets({ keys }: { keys: KeyHolding[] }) {
  const seen = new Map<string, KeyHolding>();
  for (const k of keys) if (k.copyWallet && !seen.has(k.copyWallet)) seen.set(k.copyWallet, k);
  if (!seen.size) return null;
  return (
    <Card title="Copy wallet" meta={<span class="muted">Solana devnet</span>} class="cw">
      {[...seen.values()].map(k => (
        <div key={k.copyWallet} class="cw__item">
          <p class="cw__bal tnum">{k.copyWalletSol == null ? "—" : num(k.copyWalletSol, 4)} <span>SOL</span></p>
          <dl class="dl">
            <div><dt>Address</dt><dd><AddrLink addr={k.copyWallet} chain="sol" /></dd></div>
            <div><dt>Derived via</dt><dd>Chain Signatures</dd></div>
            <div><dt>Path</dt><dd class="mono">{k.mpcPath}</dd></div>
          </dl>
        </div>
      ))}
    </Card>
  );
}

function KeyCard({ p, k }: { p: P; k: KeyHolding }) {
  const live = useStore(s => s.timelines[tlKey(p.follower, k.trader)]);
  const tl = live ?? k.timeline;
  const [showTl, setShowTl] = useState(!tl.complete);
  useEffect(() => { if (!tl.complete) setShowTl(true); }, [tl.complete]);
  const done = tl.steps.filter(s => s.status === "done").length;

  return (
    <section class="card key">
      <header class="key__head">
        <a class="key__who" href={href.trader(k.trader)}>
          <Avatar account={k.trader} size={36} />
          <span><b>{k.handle}</b><span>{k.trader}</span></span>
        </a>
        <div class="key__status">
          <Tag tone={k.status === "active" ? "ink" : undefined}>{k.status === "active" ? "Active" : k.status === "expired" ? "Expired" : "Cancelled"}</Tag>
          <span class="muted tnum">{k.status === "active" ? `${daysLeft(k.expiresAt)} · ${date(k.expiresAt)}` : `ended ${date(k.expiresAt)}`}</span>
        </div>
      </header>

      <div class="key__sec">
        <button type="button" class="key__toggle" onClick={() => setShowTl(!showTl)} aria-expanded={showTl}>
          <span>Delivery</span>
          <span class="muted tnum">{tl.complete ? "Complete" : `${done} of ${tl.steps.length}`}</span>
          <IChevronDown size={12} class={showTl ? "rot" : ""} />
        </button>
        {showTl && <Timeline timeline={tl} compact={tl.complete} />}
      </div>

      <GuardrailsSection p={p} k={k} />

      <div class="key__sec key__sec--flush">
        <div class="key__label"><span>Copied trades</span><span class="muted tnum">{k.copies.length} · {k.decrypted.length} decrypted</span></div>
        <CopyTable copies={k.copies} />
      </div>
    </section>
  );
}

function GuardrailsSection({ p, k }: { p: P; k: KeyHolding }) {
  const base = k.guardrails ?? DEFAULT_GUARDRAILS;
  const [g, setG] = useState<Guardrails>(base);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<TxRef | null>(null);
  const walletAcc = useStore(s => s.wallet);
  useEffect(() => { if (!busy) setG(k.guardrails ?? DEFAULT_GUARDRAILS); }, [JSON.stringify(k.guardrails)]);
  const dirty = !sameGuardrails(g, base);
  const needsWallet = !p.isDemo && walletAcc !== p.follower;

  const save = async () => {
    setBusy(true); setErr(null); setSent(null);
    try {
      const r = await saveGuardrails(k.trader, g);
      if (r.tx) setSent(r.tx);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="key__sec">
      <div class="key__label">
        <span>Guardrails</span>
        <span class={k.guardrailsActive ? "gr-state is-on" : "gr-state"}>
          {k.guardrailsActive ? <><ICheck size={12} />Agent enforcing <span class="mono">{hashLabel(k.guardrailsHashOnChain)}</span></> : <>Waiting for on-chain update</>}
        </span>
      </div>
      <GuardrailsEditor value={g} onChange={setG} disabled={busy || k.status !== "active"} />
      <div class="gr__foot">
        <span class="muted gr__hash">{dirty ? "Unsaved changes" : k.guardrailsActive ? "Saved on-chain" : <>On-chain <span class="mono">{k.guardrailsHashOnChain ? hashLabel(k.guardrailsHashOnChain) : "—"}</span></>}</span>
        {sent && <TxLink tx={sent} />}
        {err && <span class="inline-err">{err}</span>}
        <span class="gr__btns">
          {dirty && <button type="button" class="btn btn--ghost btn--sm" disabled={busy} onClick={() => setG(base)}>Reset</button>}
          <button type="button" class="btn btn--dark btn--sm" disabled={!dirty || busy || !g.allowedTokens.length || k.status !== "active"} onClick={needsWallet ? openWalletModal : save}>
            {busy ? <><span class="spin spin--inv" />Saving</> : needsWallet ? "Connect wallet to save" : p.isDemo ? "Save" : "Sign & save"}
          </button>
        </span>
      </div>
    </div>
  );
}

const STATUS: Record<CopyRecord["status"], string> = {
  pending: "Pending",
  signing: "Signing (MPC)",
  submitted: "Submitted",
  confirmed: "Confirmed",
  skipped: "Skipped",
  failed: "Failed",
};

function CopyTable({ copies }: { copies: CopyRecord[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!copies.length) return <p class="key__none">No copies yet. The agent copies the trader's next trade that passes your guardrails.</p>;
  return (
    <div class="ct" role="table" aria-label="Copied trades">
      <div class="ct__head" role="row">
        <span>Time</span><span>Trade</span><span class="r">Trader</span><span class="r">You</span><span>Action</span><span>Status</span><span class="r">Solana · MPC</span><span />
      </div>
      {copies.slice(0, 25).map(c => {
        const isOpen = open === c.tradeId;
        return (
          <div key={c.tradeId} class={`ct__item${isOpen ? " is-open" : ""}`}>
            <div class={`ct__row is-${c.status}${c.action === "skip" ? " is-skip" : ""}`} role="row" onClick={e => !(e.target as HTMLElement).closest("a") && setOpen(isOpen ? null : c.tradeId)}>
              <span class="tnum ct__t">{clock(c.at, true)}</span>
              <span class="ct__trade"><b class={`side is-${c.side}`}>{c.side === "buy" ? "Buy" : "Sell"}</b> {c.symbol}</span>
              <span class="r tnum ct__n" data-k="Trader">{num(c.traderQuote, 2)}</span>
              <span class="r tnum ct__n" data-k="You">{c.action === "skip" ? "—" : num(c.copiedQuote, 2)}</span>
              <span class="ct__act">
                <span class={`act-${c.action}`}>{c.action}</span>
                <span class="ct__why">{c.reason}</span>
              </span>
              <span class="ct__st"><span class={`pip pip--${c.status}`} />{STATUS[c.status]}</span>
              <span class="r ct__tx">
                {c.solanaTx ? <TxLink tx={c.solanaTx} hideLabel /> : null}
                {c.mpcTx ? <TxLink tx={c.mpcTx} hideLabel /> : null}
                {!c.solanaTx && !c.mpcTx && <span class="muted">{c.error ? c.error : "—"}</span>}
              </span>
              <button type="button" class="ct__x" aria-expanded={isOpen} aria-label="Details"><IChevronDown size={12} class={isOpen ? "rot" : ""} /></button>
            </div>
            {isOpen && <CopyDetail c={c} />}
          </div>
        );
      })}
    </div>
  );
}

function CopyDetail({ c }: { c: CopyRecord }) {
  const inf = c.inference;
  const verified = !!inf && inf.signatureValid && inf.requestHashOk && inf.responseHashOk && inf.gatewayNonceOk;
  const checks: [string, boolean][] = inf ? [["Signature", inf.signatureValid], ["Request hash", inf.requestHashOk], ["Response hash", inf.responseHashOk], ["Gateway nonce", inf.gatewayNonceOk]] : [];
  return (
    <div class="cd">
      <p class="cd__why">{c.explanation || c.reason}</p>
      {inf ? (
        <>
          <p class={verified ? "cd__src is-ok" : "cd__src"}>{verified ? <ICheck size={12} /> : null}NEAR AI Cloud · {verified ? "signature verified" : "signature not verified"}<span class="muted"> · {inf.model}</span></p>
          <dl class="dl dl--tight">
            <div><dt>Chat</dt><dd><Copyable value={inf.chatId} /></dd></div>
            <div><dt>Signing address</dt><dd><Copyable value={inf.signingAddress} display={short(inf.signingAddress.replace(/^0x/i, ""))} /></dd></div>
            <div><dt>Checks</dt><dd class="cd__checks">{checks.map(([k, ok]) => <span key={k} class={ok ? "is-ok" : ""}>{ok ? <ICheck size={11} /> : "×"}{k}</span>)}</dd></div>
          </dl>
        </>
      ) : (
        <p class="cd__src">{c.explanationKind === "near-ai-cloud" ? "NEAR AI Cloud" : "Template explanation"}</p>
      )}
    </div>
  );
}

function KeySkeleton() {
  return (
    <section class="card key" aria-hidden="true">
      <div class="key__head"><span class="key__who"><Skel w={36} h={36} r={10} /><span><Skel w={90} h={14} /><Skel w={130} h={11} /></span></span><Skel w={90} h={22} r={999} /></div>
      <div class="key__sec"><Skel h={120} r={10} /></div>
      <div class="key__sec"><Skel h={160} r={10} /></div>
    </section>
  );
}
