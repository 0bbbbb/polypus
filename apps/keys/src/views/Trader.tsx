import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import type { DecryptedTrade, FeedRow, Guardrails, KeyHolding, Timeline as TL, TraderDetail, TraderSummary, TxRef } from "../api/types";
import { EquityChart } from "../components/charts";
import { GuardrailsEditor, GuardrailsSummary } from "../components/Guardrails";
import { PayAnyChain } from "../components/PayAnyChain";
import { Timeline } from "../components/Timeline";
import { AddrLink, Ago, Avatar, Card, Copyable, Dec, Empty, IArrow, ICheck, IChevronDown, ILock, IUnlock, LiveDot, Skel, Tag, TxLink } from "../components/ui";
import { clock, compactUsd, date, dateTime, daysLeft, near, num, pct, short, usd } from "../lib/format";
import { useAsync, useMedia } from "../lib/hooks";
import { href } from "../lib/router";
import { buyWithDemo, buyWithWallet, DEFAULT_GUARDRAILS, errText } from "../state/actions";
import { tlKey, useStore } from "../state/store";

export function Trader({ account }: { account: string }) {
  const summary = useStore(s => s.traders?.find(t => t.account === account) ?? null);
  const live = summary?.lastTradeAt ?? 0;
  const tick = useStore(s => s.tick);
  const detail = useAsync(s => api.trader(account, s), [account, live, tick]);
  const identity = useStore(s => s.identity);
  const portfolio = useStore(s => s.portfolio);
  const holding = portfolio && portfolio.follower === identity?.account ? portfolio.keys.find(k => k.trader === account && k.status === "active") ?? null : null;
  const tl = useStore(s => (identity ? s.timelines[tlKey(identity.account, account)] : undefined));
  const [justBought, setJustBought] = useState<{ follower: string; tx: TxRef } | null>(null);

  const d: TraderSummary | TraderDetail | null = detail.data ?? summary;
  if (!d) {
    if (detail.error && !detail.loading) {
      return (
        <main class="page wrap" id="main">
          <Empty title="Trader not found" action={<a class="btn btn--ghost" href={href.discover}>Back to traders <IArrow size={12} /></a>}>
            {account} isn't registered on the registry, or the local API is unavailable.
          </Empty>
        </main>
      );
    }
    return <TraderSkeleton />;
  }

  const merged = { ...d, ...(summary ?? {}) } as TraderSummary;
  const feed = detail.data?.feed ?? null;
  const timeline: TL | null =
    tl ?? holding?.timeline ?? (justBought && justBought.follower === identity?.account ? provisional(justBought.follower, account, justBought.tx) : null);
  const inFlight = !!timeline && !timeline.complete;

  return (
    <main class="page wrap trader" id="main">
      <nav class="crumbs" aria-label="Breadcrumb"><a href={href.discover}>Traders</a><span>/</span><span>{merged.handle}</span></nav>
      <TraderHeader t={merged} />
      <StatsStrip t={merged} />

      <div class="tgrid">
        <div class="tgrid__main">
          <EquityCard t={merged} />
          <FeedCard t={merged} feed={feed} holding={holding} />
        </div>
        <aside class="tgrid__side" id="buy">
          {holding && !inFlight ? (
            <ActivePanel t={merged} h={holding} timeline={timeline ?? holding.timeline} />
          ) : timeline && (holding || justBought) ? (
            <ProgressPanel t={merged} timeline={timeline} />
          ) : (
            <BuyPanel t={merged} onBought={(follower, tx) => setJustBought({ follower, tx })} />
          )}
          {!holding && !justBought && <PayAnyChain trader={merged.account} />}
        </aside>
      </div>
      {!holding && !justBought && <MobileCta t={merged} />}
    </main>
  );
}

function provisional(follower: string, trader: string, tx: TxRef): TL {
  return {
    follower, trader, agentPubkey: "", complete: false,
    steps: [
      { key: "subscribed", label: "Subscribed", status: "active", detail: "Waiting for the registry to confirm", txs: [tx], at: Date.now() },
      { key: "sealed", label: "Key sealed to agent", status: "waiting", detail: "", txs: [] },
      { key: "decrypted", label: "Trades decrypted", status: "waiting", detail: "", txs: [] },
      { key: "copied", label: "Copied on Solana", status: "waiting", detail: "", txs: [] },
    ],
  };
}

function TraderHeader({ t }: { t: TraderSummary }) {
  return (
    <header class="th">
      <Avatar account={t.account} size={56} />
      <div class="th__id">
        <h1 class="th__name">{t.handle}</h1>
        <p class="th__meta">
          <AddrLink addr={t.account} chain="near" />
          {t.style && <Tag>{t.style}</Tag>}
        </p>
      </div>
      <div class="th__live">
        <LiveDot on={t.live} />
        <span>{t.live ? "Posting" : "Idle"}</span>
        <span class="muted">· last trade {t.lastTradeAt ? <Ago t={t.lastTradeAt} /> : "—"}</span>
      </div>
      {t.bio && <p class="th__bio">{t.bio}</p>}
    </header>
  );
}

function StatsStrip({ t }: { t: TraderSummary }) {
  const p = t.pnl;
  const cells: [string, string, string?][] = [
    ["Return", p ? pct(p.pnlBps) : "—", p ? `${date(p.windowStart)} – ${date(p.windowEnd)}` : "No statement yet"],
    ["Trades", p ? num(p.tradeCount, 0) : num(t.feedLen, 0), `${num(t.feedLen, 0)} on-chain`],
    ["Volume", p ? compactUsd(p.volumeUsd) : "—", "attested"],
    ["Win rate", p ? pct(p.winRateBps, false, 0) : "—", "closed trades"],
    ["Holders", String(t.subscriberCount), `epoch ${t.currentEpoch}`],
    ["Key", `${near(t.priceNear)} NEAR`, `per ${t.periodDays} days`],
  ];
  return (
    <dl class="stats">
      {cells.map(([k, v, sub], i) => (
        <div key={k} class={`stats__c${i === 0 && p && p.pnlBps < 0 ? " is-neg" : ""}`}>
          <dt>{k}</dt>
          <dd><Dec text={v} delay={i * 60} /></dd>
          {sub && <span class="stats__sub">{sub}</span>}
        </div>
      ))}
    </dl>
  );
}

function EquityCard({ t }: { t: TraderSummary }) {
  const p = t.pnl;
  const [open, setOpen] = useState(false);
  const mobile = useMedia("(max-width: 760px)");
  return (
    <Card
      class="eq"
      title={<>Equity <span class="muted">· {p ? `${date(p.windowStart)} – ${date(p.windowEnd)}` : "30 days"}</span></>}
      meta={
        p ? (
          <button type="button" class={`attest${open ? " is-open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
            <span class="attest__badge"><ICheck size={12} />Attested</span>
            <span class="attest__more">Statement<IChevronDown size={12} /></span>
          </button>
        ) : <Tag>Awaiting statement</Tag>
      }
    >
      {p && open && <Statement t={t} />}
      <div class="eq__chart">
        {p ? <EquityChart points={p.equity} height={mobile ? 200 : 280} /> : <div class="chart__empty" style={{ height: mobile ? "200px" : "280px" }}>The attestor hasn't published a statement for this trader yet.</div>}
      </div>
    </Card>
  );
}

function Statement({ t }: { t: TraderSummary }) {
  const p = t.pnl!;
  const pretty = useMemo(() => { try { return JSON.stringify(JSON.parse(p.statement), null, 2); } catch { return p.statement; } }, [p.statement]);
  return (
    <div class="stmt">
      <dl class="dl">
        <div><dt>Verified on-chain</dt><dd>{p.tx ? <TxLink tx={p.tx} /> : "pending"}</dd></div>
        <div><dt>Attestation</dt><dd>{p.attestationKind}</dd></div>
        <div><dt>Attestor key</dt><dd><Copyable value={t.attestorPubkey} /></dd></div>
        <div><dt>Code hash</dt><dd><Copyable value={p.codeHash} /></dd></div>
        <div><dt>Signature</dt><dd><Copyable value={p.signature} /></dd></div>
        <div><dt>Covers feed</dt><dd class="tnum">through seq {p.feedSeq}</dd></div>
        <div><dt>Published</dt><dd class="tnum">{dateTime(p.publishedAt)}</dd></div>
      </dl>
      <details class="json">
        <summary>Signed statement</summary>
        <pre class="mono">{pretty}</pre>
      </details>
    </div>
  );
}

const revealed = new Set<string>();

function FeedCard({ t, feed, holding }: { t: TraderSummary; feed: FeedRow[] | null; holding: KeyHolding | null }) {
  const dec = useMemo(() => new Map((holding?.decrypted ?? []).map(x => [x.seq, x])), [holding?.decrypted]);
  const unlocked = dec.size > 0;
  const hitRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(12);

  useEffect(() => {
    if (unlocked || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => {
      const rows = hitRef.current?.querySelectorAll<HTMLElement>(".ft__row.is-sealed");
      if (!rows?.length) return;
      const r = rows[(Math.random() * Math.min(rows.length, 8)) | 0]!;
      r.classList.remove("is-hit"); void r.offsetWidth; r.classList.add("is-hit");
    }, 2200);
    return () => clearInterval(id);
  }, [unlocked, feed]);

  const rows = feed ?? [];
  const sealedN = rows.filter(r => !dec.has(r.seq)).length;
  return (
    <Card
      class="feed"
      flush
      title={<>Trades <span class="muted">· {num(t.feedLen, 0)} posted</span></>}
      meta={unlocked ? <Tag tone="ink"><IUnlock size={12} />Decrypted by your agent</Tag> : <Tag><ILock size={12} />Encrypted · XChaCha20</Tag>}
    >
      <div class="ft" role="table" aria-label="Trade feed" ref={hitRef}>
        <div class="ft__head" role="row">
          <span>#</span><span>Posted</span><span>Side</span><span>Token</span><span class="r">Size</span><span class="r">Price</span><span class="r">Notional, pUSD</span><span class="r">Feed tx</span>
        </div>
        {!feed && [0, 1, 2, 3, 4].map(i => (
          <div key={i} class="ft__row is-skel"><Skel w={24} h={12} /><Skel w={64} h={12} /><Skel w={40} h={12} /><Skel w={44} h={12} /><Skel w={60} h={12} /><Skel w={56} h={12} /><Skel w={64} h={12} /><Skel w={90} h={12} /></div>
        ))}
        {feed && rows.length === 0 && <Empty title="No trades posted yet">New trades appear here the moment they land on NEAR.</Empty>}
        {rows.slice(0, shown).map((r, i) => {
          const x = dec.get(r.seq);
          return x ? <OpenRow key={r.seq} r={r} x={x} trader={t.account} i={i} /> : <SealedRow key={r.seq} r={r} />;
        })}
      </div>
      {rows.length > shown && (
        <button type="button" class="ft__more" onClick={() => setShown(s => s + 24)}>Show {Math.min(24, rows.length - shown)} more</button>
      )}
      <footer class="feed__foot">
        {unlocked
          ? <span>{dec.size} decrypted by your agent{sealedN ? ` · ${sealedN} older stay sealed` : ""}</span>
          : <span>Ciphertext only. Buy a key and your agent decrypts these.</span>}
        <span class="mono muted">epoch {t.currentEpoch}</span>
      </footer>
    </Card>
  );
}

function SealedRow({ r }: { r: FeedRow }) {
  const c = r.ciphertextPreview.replace(/^ct_/, "");
  const part = (a: number, n: number) => c.slice(a, a + n).padEnd(n, "·");
  return (
    <div class="ft__row is-sealed" role="row">
      <span class="tnum ft__seq">{r.seq}</span>
      <span class="tnum ft__t">{dateTime(r.postedAt)}</span>
      <span class="rd" style={{ width: "40px" }}>{part(0, 4)}</span>
      <span class="rd" style={{ width: "48px" }}>{part(4, 5)}</span>
      <span class="r"><span class="rd" style={{ width: "72px" }}>{part(9, 8)}</span></span>
      <span class="r"><span class="rd" style={{ width: "60px" }}>{part(17, 7)}</span></span>
      <span class="r"><span class="rd" style={{ width: "76px" }}>{part(24, 9)}</span></span>
      <span class="r ft__tx">{r.tx ? <TxLink tx={r.tx} hideLabel /> : <span class="mono muted">{short(r.ciphertextPreview)}</span>}</span>
      <span class="ft__mob">
        <span class="rd" style={{ width: "120px" }}>{part(0, 14)}</span>
        <span class="rd" style={{ width: "64px" }}>{part(14, 7)}</span>
      </span>
    </div>
  );
}

function OpenRow({ r, x, trader, i }: { r: FeedRow; x: DecryptedTrade; trader: string; i: number }) {
  const id = `${trader}:${r.seq}`;
  const [play] = useState(() => !revealed.has(id));
  useEffect(() => { revealed.add(id); }, []);
  const delay = play ? Math.min(i, 10) * 70 : 0;
  const side = x.side === "buy" ? "Buy" : "Sell";
  return (
    <div class={`ft__row is-open${play ? " is-reveal" : ""}${x.backfilled ? " is-backfill" : ""}`} role="row" style={{ "--d": `${delay}ms` }}>
      <span class="tnum ft__seq">{r.seq}</span>
      <span class="tnum ft__t">{dateTime(x.executedAt || r.postedAt)}{x.backfilled && <span class="bf" title="Posted before you bought; decrypted from history">backfill</span>}</span>
      <span class={`side is-${x.side}`}><Dec text={side} play={play} delay={delay} /></span>
      <span class="ft__sym"><Dec text={x.symbol} play={play} delay={delay + 40} /></span>
      <span class="r tnum"><Dec text={num(x.baseAmount)} play={play} delay={delay + 80} /></span>
      <span class="r tnum"><Dec text={usd(Number(x.price), 2)} play={play} delay={delay + 120} /></span>
      <span class="r tnum"><Dec text={num(x.quoteAmount, 2)} play={play} delay={delay + 160} /></span>
      <span class="r ft__tx">{(x.feedTx ?? r.tx) ? <TxLink tx={(x.feedTx ?? r.tx)!} hideLabel /> : null}</span>
      <span class="ft__mob">
        <span><b class={`side is-${x.side}`}>{side}</b> <Dec text={`${num(x.baseAmount)} ${x.symbol}`} play={play} delay={delay} /> <span class="muted">@ {usd(Number(x.price), 2)}</span></span>
        <span class="tnum">{num(x.quoteAmount, 2)} <small class="muted">pUSD</small></span>
      </span>
    </div>
  );
}

function BuyPanel({ t, onBought }: { t: TraderSummary; onBought: (follower: string, tx: TxRef) => void }) {
  const walletAcc = useStore(s => s.wallet);
  const health = useStore(s => s.health);
  const [g, setG] = useState<Guardrails>(DEFAULT_GUARDRAILS);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"wallet" | "demo" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const valid = g.allowedTokens.length > 0 && Number(g.maxTradeQuote) > 0 && g.copyRatioBps > 0;

  const run = async (kind: "wallet" | "demo") => {
    setBusy(kind);
    setErr(null);
    try {
      if (kind === "wallet") await buyWithWallet(t.account, g);
      else {
        const tx = await buyWithDemo(t.account, g);
        onBought(health?.demo.account ?? "carol-18e5.testnet", tx);
      }
    } catch (e) {
      const ae = e as { status?: number; retryAfterSec?: number };
      if (ae.status === 429) setRetryAt(Date.now() + (ae.retryAfterSec ?? 30) * 1000);
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const demoDown = health && !health.demo.available;
  return (
    <section class="card buy" aria-labelledby="buy-title">
      <header class="buy__top">
        <img class="buy__coin" src="./brand/key-coin-160.webp" width={44} height={44} alt="" />
        <div>
          <h2 id="buy-title" class="buy__title">{t.handle}'s key</h2>
          <p class="buy__price"><b class="tnum">{near(t.priceNear)} NEAR</b><span> / {t.periodDays} days</span></p>
        </div>
      </header>

      <ul class="buy__gets">
        <li><ICheck size={12} />Epoch key sealed to your agent's X25519 key</li>
        <li><ICheck size={12} />Agent decrypts every trade inside a TEE</li>
        <li><ICheck size={12} />Copies on Solana devnet within your limits</li>
      </ul>

      <div class="buy__gr">
        <div class="buy__grh">
          <span>Guardrails</span>
          <button type="button" class="linkbtn" onClick={() => setEditing(!editing)} aria-expanded={editing}>{editing ? "Done" : "Edit"}</button>
        </div>
        {editing ? <GuardrailsEditor value={g} onChange={setG} /> : <GuardrailsSummary g={g} />}
      </div>

      <div class="buy__ctas">
        <button type="button" class="btn btn--dark btn--block" disabled={!!busy || !valid} onClick={() => run("wallet")}>
          {busy === "wallet" ? <><span class="spin spin--inv" />Waiting for wallet</> : walletAcc ? `Buy key · ${near(t.priceNear)} NEAR` : "Buy key"}
        </button>
        <button type="button" class="btn btn--line btn--block" disabled={!!busy || !valid || !!demoDown || retryAt > Date.now()} onClick={() => run("demo")}>
          {busy === "demo" ? <><span class="spin" />Subscribing as demo</> : "Try with a demo account"}
        </button>
      </div>
      {err && <p class="buy__err" role="alert">{err}</p>}
      <p class="buy__fine">
        {walletAcc ? <>Signs <span class="mono">subscribe</span> from {walletAcc}.</> : "Buy key connects a NEAR testnet wallet."}{" "}
        {demoDown ? `Demo unavailable: ${health?.demo.reason ?? "account empty"}.` : <>Demo signs server-side as {health?.demo.account ?? "carol-18e5.testnet"}; keys never reach the browser.</>}
      </p>
    </section>
  );
}

function ProgressPanel({ t, timeline }: { t: TraderSummary; timeline: TL }) {
  const done = timeline.steps.filter(s => s.status === "done").length;
  return (
    <section class="card prog" aria-live="polite">
      <header class="card__head">
        <h2 class="card__title">Delivering your key</h2>
        <span class="card__meta tnum muted">{done} / {timeline.steps.length}</span>
      </header>
      <div class="prog__bar"><i style={{ transform: `scaleX(${done / timeline.steps.length})` }} /></div>
      <Timeline timeline={timeline} />
      <p class="prog__note">
        {timeline.agentPubkey ? <>Agent key <span class="mono">{short(timeline.agentPubkey)}</span>. </> : null}
        Trades from {t.handle} unlock in the feed as your agent decrypts them.
      </p>
    </section>
  );
}

function ActivePanel({ t, h, timeline }: { t: TraderSummary; h: KeyHolding; timeline: TL }) {
  const lastCopy = h.copies[0];
  return (
    <section class="card active">
      <header class="buy__top">
        <img class="buy__coin" src="./brand/key-coin-160.webp" width={44} height={44} alt="" />
        <div>
          <h2 class="buy__title">You hold {t.handle}'s key</h2>
          <p class="buy__price"><span class="tnum">{daysLeft(h.expiresAt)} · expires {date(h.expiresAt)}</span></p>
        </div>
      </header>
      <dl class="dl">
        <div><dt>Agent</dt><dd><Copyable value={h.agentPubkey} /></dd></div>
        <div><dt>Guardrails</dt><dd>{h.guardrailsActive ? <span class="ok"><ICheck size={12} />Enforcing</span> : <span class="muted">Waiting for on-chain update</span>}</dd></div>
        <div><dt>Decrypted</dt><dd class="tnum">{h.decrypted.length} trades</dd></div>
        <div><dt>Copied</dt><dd class="tnum">{h.copies.filter(c => c.status === "confirmed").length} on Solana</dd></div>
        {lastCopy && <div><dt>Last copy</dt><dd class="tnum">{lastCopy.action} {lastCopy.symbol} · {clock(lastCopy.at)}</dd></div>}
      </dl>
      <div class="active__tl">
        <Timeline timeline={timeline} compact />
      </div>
      <a class="btn btn--line btn--block" href={href.portfolio}>Open portfolio <IArrow size={12} /></a>
    </section>
  );
}

function MobileCta({ t }: { t: TraderSummary }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const el = document.getElementById("buy");
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setHidden(!!e?.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div class={`mcta${hidden ? " is-hidden" : ""}`}>
      <div class="mcta__p"><b class="tnum">{near(t.priceNear)} NEAR</b><span>{t.periodDays}-day key</span></div>
      <button type="button" class="btn btn--dark" onClick={() => document.getElementById("buy")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Buy key</button>
    </div>
  );
}

function TraderSkeleton() {
  return (
    <main class="page wrap trader" aria-busy="true">
      <div class="crumbs"><Skel w={120} h={12} /></div>
      <div class="th"><Skel w={56} h={56} r={14} /><div class="th__id"><Skel w={180} h={36} /><Skel w={220} h={14} /></div></div>
      <div class="stats">{[0, 1, 2, 3, 4, 5].map(i => <div key={i} class="stats__c"><Skel w={60} h={12} /><Skel w={90} h={26} /></div>)}</div>
      <div class="tgrid">
        <div class="tgrid__main"><div class="card"><Skel h={280} r={12} /></div></div>
        <aside class="tgrid__side"><div class="card"><Skel h={320} r={12} /></div></aside>
      </div>
    </main>
  );
}
