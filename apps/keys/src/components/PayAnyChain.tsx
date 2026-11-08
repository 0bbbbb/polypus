import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import type { IntentsQuote, IntentsStatus } from "../api/types";
import { num } from "../lib/format";
import { ILock, Skel } from "./ui";

let statusP: Promise<IntentsStatus> | null = null;
const cache = new Map<string, { q: IntentsQuote | null; at: number }>();

export function PayAnyChain({ trader }: { trader: string }) {
  const [status, setStatus] = useState<IntentsStatus | null | undefined>(undefined);
  const [opt, setOpt] = useState<string | null>(null);
  const [q, setQ] = useState<IntentsQuote | null | undefined>(undefined);

  useEffect(() => {
    statusP ??= api.intents();
    statusP.then(
      s => { setStatus(s); setOpt(o => o ?? s.options[0]?.id ?? null); },
      () => { statusP = null; setStatus(null); },
    );
  }, []);

  useEffect(() => {
    if (!opt) return;
    const key = `${trader}:${opt}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 60_000) { setQ(hit.q); return; }
    const ctl = new AbortController();
    setQ(undefined);
    api.quote(trader, opt, ctl.signal)
      .catch(() => null)
      .then(r => { if (ctl.signal.aborted) return; cache.set(key, { q: r, at: Date.now() }); setQ(r); });
    return () => ctl.abort();
  }, [trader, opt]);

  if (status === null) return null;
  const conf = q?.confidential ?? status?.confidential;

  return (
    <section class="card pay">
      <header class="card__head">
        <h2 class="card__title">Pay from any chain</h2>
        <span class="card__meta">
          {conf ? <span class="tag" title={status?.detail}><ILock size={11} />Confidential</span> : <span class="muted">NEAR Intents</span>}
        </span>
      </header>
      <div class="pay__opts" role="radiogroup" aria-label="Pay with">
        {status ? status.options.map(o => (
          <button key={o.id} type="button" role="radio" aria-checked={o.id === opt} class={o.id === opt ? "chip is-on" : "chip"} onClick={() => setOpt(o.id)}>
            {o.label}
          </button>
        )) : [0, 1, 2, 3].map(i => <Skel key={i} w={72} h={30} r={999} />)}
      </div>
      <dl class="pay__quote dl" aria-live="polite">
        {q === undefined ? (
          <><div><dt>You send</dt><dd><Skel w={110} h={14} /></dd></div><div><dt>You receive</dt><dd><Skel w={80} h={14} /></dd></div></>
        ) : q ? (
          <>
            <div><dt>You send</dt><dd class="tnum"><b>{num(q.amountInFormatted)} {q.payWith.label}</b><span class="muted">on {q.payWith.chain}</span></dd></div>
            <div><dt>You receive</dt><dd class="tnum">{q.amountOutFormatted} wNEAR</dd></div>
            <div><dt>Settles in</dt><dd class="tnum">about {q.timeEstimateSec}s · ≈ ${Number(q.amountInUsd).toFixed(2)}</dd></div>
          </>
        ) : (
          <div><dt>Quote</dt><dd class="muted">Unavailable right now</dd></div>
        )}
      </dl>
      <p class="pay__note">{conf ? "NEAR Intents quote · confidential · " : "NEAR Intents quote · "}quote only, mainnet, no funds move</p>
    </section>
  );
}
