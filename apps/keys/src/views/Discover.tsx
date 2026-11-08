import type { ActivityItem, TraderSummary } from "../api/types";
import { Sparkline } from "../components/charts";
import { Ago, Avatar, Card, Dec, Empty, IArrow, LiveDot, Skel, Tag, TxLink } from "../components/ui";
import { near, num, pct } from "../lib/format";
import { useMedia } from "../lib/hooks";
import { href, navigate } from "../lib/router";
import { useStore } from "../state/store";

export function Discover() {
  const traders = useStore(s => s.traders);
  const offline = useStore(s => s.offline);
  const sorted = traders ? [...traders].sort((a, b) => (b.pnl?.pnlBps ?? -1e9) - (a.pnl?.pnlBps ?? -1e9)) : null;
  const sum = (f: (t: TraderSummary) => number) => (traders ?? []).reduce((n, t) => n + f(t), 0);

  return (
    <main class="page wrap" id="main">
      <section class="hero">
        <div class="hero__copy">
          <p class="eyebrow"><LiveDot />Live on NEAR testnet</p>
          <h1 class="display">Copy traders whose trades stay encrypted.</h1>
          <p class="lead">Buy a key. Your agent decrypts the feed in a TEE and copies it on Solana, within your limits.</p>
        </div>
        <dl class="hero__stats">
          <Stat k="Traders" v={traders ? String(traders.length) : null} />
          <Stat k="Keys held" v={traders ? num(sum(t => t.subscriberCount), 0) : null} />
          <Stat k="Encrypted trades" v={traders ? num(sum(t => t.feedLen), 0) : null} />
          <Stat k="Attested statements" v={traders ? String(traders.filter(t => t.pnl).length) : null} />
        </dl>
      </section>

      <Card title="Traders" meta={<span class="muted">Attested 30-day return · updates live</span>} class="board" flush>
        <div class="tt" aria-label="Traders">
          <div class="tt__head">
            <span>Trader</span>
            <span>Equity</span>
            <span class="r">Return</span>
            <span class="r">Trades</span>
            <span class="r">Win rate</span>
            <span class="r">Holders</span>
            <span class="r">Key</span>
            <span>Last trade</span>
            <span />
          </div>
          {!sorted && [0, 1].map(i => <SkelRow key={i} />)}
          {sorted && sorted.length === 0 && <Empty title="No traders registered yet">Traders appear here once they register on the registry contract.</Empty>}
          {sorted?.map((t, i) => <TraderRow key={t.account} t={t} rank={i + 1} />)}
        </div>
        {!sorted && offline && <p class="board__off">Waiting for the local API…</p>}
      </Card>

      <div class="split">
        <Activity />
        <HowItWorks />
      </div>
    </main>
  );
}

function Stat({ k, v }: { k: string; v: string | null }) {
  return (
    <div class="stat">
      <dt>{k}</dt>
      <dd>{v == null ? <Skel w={44} h={24} /> : <Dec text={v} />}</dd>
    </div>
  );
}

function TraderRow({ t, rank }: { t: TraderSummary; rank: number }) {
  const ret = t.pnl?.pnlBps;
  const mobile = useMedia("(max-width: 760px)");
  return (
    <a class="tt__row" href={href.trader(t.account)} onClick={e => { e.preventDefault(); navigate(href.trader(t.account)); }}>
      <span class="tt__who">
        <span class="tt__rank tnum">{rank}</span>
        <Avatar account={t.account} />
        <span class="tt__name">
          <b>{t.handle}</b>
          <span>{t.account}</span>
        </span>
      </span>
      <span class="tt__spark">{t.pnl ? <Sparkline points={t.pnl.equity} w={mobile ? 320 : 132} h={mobile ? 44 : 36} /> : <span class="muted">No statement</span>}</span>
      <span class={`tt__ret r tnum${ret != null && ret < 0 ? " is-neg" : ""}`}>{ret != null ? pct(ret) : "—"}</span>
      <span class="r tnum tt__m" data-k="Trades">{t.pnl ? num(t.pnl.tradeCount, 0) : num(t.feedLen, 0)}</span>
      <span class="r tnum tt__m" data-k="Win rate">{t.pnl ? pct(t.pnl.winRateBps, false, 0) : "—"}</span>
      <span class="r tnum tt__m" data-k="Holders">{t.subscriberCount}</span>
      <span class="r tnum tt__m tt__price" data-k="Key">{near(t.priceNear)} <small>NEAR / {t.periodDays}d</small></span>
      <span class="tt__live">
        <LiveDot on={t.live} />
        {t.lastTradeAt ? <Ago t={t.lastTradeAt} /> : <span class="muted">No trades yet</span>}
      </span>
      <span class="tt__go" aria-hidden="true"><IArrow size={14} /></span>
    </a>
  );
}

function SkelRow() {
  return (
    <div class="tt__row is-skel" aria-hidden="true">
      <span class="tt__who"><Skel w={12} h={12} /><Skel w={36} h={36} r={10} /><span class="tt__name"><Skel w={80} h={14} /><Skel w={120} h={11} /></span></span>
      <span class="tt__spark"><Skel w={132} h={30} /></span>
      <span class="r"><Skel w={64} h={16} /></span>
      <span class="r tt__m"><Skel w={28} h={14} /></span>
      <span class="r tt__m"><Skel w={36} h={14} /></span>
      <span class="r tt__m"><Skel w={20} h={14} /></span>
      <span class="r tt__m"><Skel w={72} h={14} /></span>
      <span class="tt__live"><Skel w={72} h={14} /></span>
      <span />
    </div>
  );
}

const KIND: Record<ActivityItem["kind"], string> = {
  trade: "Trade",
  seal: "Seal",
  subscribe: "Key",
  copy: "Copy",
  pnl: "PnL",
  guardrails: "Limits",
  fund: "Fund",
};

export function ActivityList({ items, limit = 10 }: { items: ActivityItem[] | null; limit?: number }) {
  if (!items) return <ul class="act">{[0, 1, 2, 3, 4].map(i => <li key={i} class="act__row"><Skel w={44} h={20} r={999} /><Skel w="60%" h={13} /><Skel w={56} h={12} /></li>)}</ul>;
  if (!items.length) return <Empty title="No activity yet">On-chain events show up here as they land.</Empty>;
  return (
    <ul class="act">
      {items.slice(0, limit).map((a, i) => (
        <li key={a.id} class={`act__row${i === 0 ? " is-new" : ""}`}>
          <Tag>{KIND[a.kind] ?? a.kind}</Tag>
          <span class="act__text">{a.text}</span>
          <span class="act__end">
            {a.tx && <TxLink tx={a.tx} hideLabel />}
            <span class="act__t"><Ago t={a.at} /></span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Activity() {
  const items = useStore(s => s.activity);
  return (
    <Card title="Activity" meta={<span class="muted"><LiveDot />On-chain, newest first</span>} class="activity">
      <ActivityList items={items} limit={9} />
    </Card>
  );
}

function HowItWorks() {
  const steps: [string, string][] = [
    ["Trader posts encrypted", "Every trade lands on NEAR as an XChaCha20 ciphertext. Nobody can read it."],
    ["You buy a key", "Pay in NEAR on the registry. The epoch key is sealed to your agent's X25519 key."],
    ["Agent decrypts in a TEE", "Your copy agent opens the feed and applies your guardrails."],
    ["Copied on Solana", "Trades are signed on Solana devnet through NEAR Chain Signatures."],
  ];
  return (
    <Card title="How it works" class="how">
      <ol class="how__list">
        {steps.map(([h, p], i) => (
          <li key={h}>
            <span class="how__n tnum">0{i + 1}</span>
            <div><b>{h}</b><p>{p}</p></div>
          </li>
        ))}
      </ol>
      <a class="link" href={href.proof}>Verify every piece on-chain <IArrow size={12} /></a>
    </Card>
  );
}
