import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "./styles.css";
import { truncate } from "./fx/formats.js";
import { decoder } from "./fx/decode.js";
import {
  RECORDED_AGENT,
  RECORDED_SETTLEMENTS,
  RECORDED_SUB,
  RECORDED_TRADERS,
  RECORDED_TRADES,
  pnlPercent,
} from "./data/recorded.js";
import { loadLiveTraders } from "./data/live.js";
import type { Provenance, Trader } from "./data/types.js";
import { dryQuote } from "./near/oneclick.js";
import { loadDevnetSettlements } from "./data/devnet.js";
import { fetchFeedLive } from "./near/registry.js";
import { chainSigForTrader } from "./near/chainsig.js";
import { REGISTRY_ID } from "./data/recorded.js";

const LIVE_FOLLOWER = "carol-18e5.testnet";

const app = document.getElementById("app")!;
let traders: Trader[] = RECORDED_TRADERS;
let liveMode = false;
let quotePreview: string = "Click refresh for a live dry quote (mainnet 1Click, no spend).";

function provBadge(p: Provenance): string {
  if (p.kind === "live") return `<span class="prov prov--live">LIVE · ${p.network}</span>`;
  if (p.kind === "recorded") return `<span class="prov">RECORDED · ${p.recordedAt.slice(0, 10)}</span>`;
  return `<span class="prov prov--sim">SIMULATED</span>`;
}

function route(): { page: string; id?: string } {
  const h = location.hash.replace(/^#\/?/, "") || "leaderboard";
  const [page, id] = h.split("/");
  return { page, id };
}

function navBrand() {
  return `<a class="nav__brand" href="#/leaderboard"><img class="nav__mark" src="./brand/polypus-mark.svg" width="22" height="22" alt=""> Polypus Keys</a>`;
}

function nav(active: string) {
  const lead = traders[0]?.account ?? RECORDED_TRADERS[0].account;
  const items = [
    ["leaderboard", "Leaderboard"],
    [`trader/${lead}`, "Trader"],
    [`checkout/${lead}`, "Checkout"],
    ["follower", "Follower"],
    [`explorer/${lead}`, "Explorer"],
  ];
  return items
    .map(([href, label]) => {
      const key = href.split("/")[0];
      return `<a href="#/${href}" class="${active === key ? "is-on" : ""}">${label}</a>`;
    })
    .join("");
}

function traderCards(traders: Trader[]) {
  return traders
    .map((t, i) => {
      const pnl = pnlPercent(t.pnl.pnlBps);
      return `<article class="kc" style="position:relative;margin-bottom:16px">
        <header class="kc__head"><div class="kc__title"><span class="kc__rank">${i + 1}</span> ${t.handle} <span style="color:var(--ink-2);font-weight:400">· ${t.account}</span></div>
        <span class="kc__tag kc__tag--live"><i class="dot"></i> Attested</span></header>
        <div class="kc__lead kc__group"><div class="kc__big">${pnl}</div><div class="kc__sub">${t.pnl.tradeCount} trades · window through ${t.pnl.windowEnd.slice(0, 10)}</div>
        ${provBadge(t.pnl.provenance)}</div>
        <footer class="kc__foot"><div class="kc__price"><span>Key</span><b>${(Number(t.price.amount) / 1e24).toFixed(2)} NEAR / ${t.price.periodDays}d</b></div>
        <a class="kc__btn" href="#/trader/${encodeURIComponent(t.account)}">View</a></footer>
      </article>`;
    })
    .join("");
}

function renderLeaderboard() {
  const liveBanner = liveMode
    ? `<div class="banner"><b>Live registry</b> on <span class="mono">polypus-keys-18e5.testnet</span> — PnL from on-chain statements when published.</div>`
    : `<div class="banner banner--sim"><b>Fallback fixtures.</b> Run with <span class="mono">VITE_LIVE=1</span> for testnet traders + PnL.</div>`;
  app.innerHTML = `<div class="app"><nav class="nav">${navBrand()}<div class="nav__links">${nav("leaderboard")}</div></nav>
  <main class="main"><h1 class="h2" style="margin-bottom:16px">Attested PnL, hidden trades</h1>
  ${liveBanner}${traderCards(traders)}</main>
  <footer class="footer">Built for NEAR HACKATHON · Chain Signatures · Intents · NEAR AI Cloud</footer></div>`;
}

async function renderTrader(id: string) {
  const t = traders.find(x => x.account === decodeURIComponent(id)) ?? traders[0];
  let feedNote = "";
  if (liveMode) {
    const feed = await fetchFeedLive(t.account, 0, 8);
    feedNote = feed.length
      ? `<p class="kc__note"><span>On-chain feed</span><span>${feed.length} encrypted records · epoch ${feed[feed.length - 1]?.epoch ?? t.currentEpoch}</span></p>`
      : `<p class="kc__note"><span>On-chain feed</span><span>empty — run <span class="mono">npm run demo:live</span></span></p>`;
    const cs = await chainSigForTrader(t.account, t.derivationPath || "solana-1");
    if (cs.solanaAddress) {
      feedNote += `<p class="kc__note"><span>Chain Signatures</span><span class="mono">${truncate(cs.solanaAddress)} · ${cs.mpcContract}</span></p>`;
    }
  }
  const rows = RECORDED_TRADES.filter(tr => tr.trader === t.account)
    .map(
      tr => `<li class="is-hit"><div class="kc__fa"><b class="dec" data-dec>${tr.side.toUpperCase()} ${tr.base.symbol}</b><span class="dec" data-dec>${tr.quoteAmount} ${tr.quote.symbol}</span></div>
      <div class="kc__fv"><span class="mono dec" data-dec>${tr.price}</span><span class="mono dec" data-dec>${tr.executedAt.slice(11, 19)}Z</span></div></li>`,
    )
    .join("");
  app.innerHTML = `<div class="app"><nav class="nav">${navBrand()}<div class="nav__links">${nav("trader")}</div></nav>
  <main class="main grid2"><div>${traderCards([t])}</div>
  <div class="panel"><h2>Activity feed</h2><p>Public view: values redacted. Key holders decrypt inside the agent TEE.</p>
  <article class="kc"><header class="kc__head"><div class="kc__title">${t.handle} · shielded</div><span class="kc__tag">Encrypted</span></header>
  <ul class="kc__feed kc__group">${rows || "<li>No recorded trades</li>"}</ul>
  <div class="kc__note"><span>poly1 address</span><span class="mono">${truncate(t.shieldedAddress)}</span></div></article>
  ${feedNote}
  <p style="margin-top:12px">${provBadge(liveMode ? { kind: "live", network: "near-testnet", ref: REGISTRY_ID } : (RECORDED_TRADES[0]?.provenance ?? { kind: "simulated", reason: "" }))}</p></div></main>
  <footer class="footer">Solana settlements on devnet · RFQ desk stand-in for Confidential Intents</footer></div>`;
  document.querySelectorAll<HTMLElement>("[data-dec]").forEach(el => {
    const d = decoder(el);
    d.set(0);
  });
}

function renderCheckout(id: string) {
  const t = traders.find(x => x.account === decodeURIComponent(id)) ?? traders[0];
  app.innerHTML = `<div class="app"><nav class="nav">${navBrand()}<div class="nav__links">${nav("checkout")}</div></nav>
  <main class="main"><article class="kc" style="max-width:440px;margin:0 auto">
  <header class="kc__head"><div class="kc__title">Buy key · ${t.handle}</div><span class="kc__tag">1Click</span></header>
  <div class="kc__group"><div class="kc__pay"><div class="kc__amt">${(Number(t.price.amount) / 1e24).toFixed(2)}<small>NEAR</small></div><span class="kc__chip">30 days</span></div>
  <div class="kc__route"><span class="kc__node is-on">Any chain</span><span class="kc__line"><i style="transform:scaleX(1)"></i></span><span class="kc__node is-on">Intents</span><span class="kc__line"><i style="transform:scaleX(0.6)"></i></span><span class="kc__node">Registry</span></div>
  <p style="padding:16px 20px;font-size:13px;color:var(--ink-2)">${quotePreview}</p>
  <div style="padding:0 20px 16px;display:flex;gap:8px;flex-wrap:wrap">
  <button type="button" class="kc__btn" id="btn-quote">Refresh dry quote</button>
  <button type="button" class="kc__btn kc__btn--wide is-done" disabled>Pay on testnet NEAR (wallet)</button></div>
  <div class="kc__note"><span>Confidential Intents</span><span>Partner JWT required · shown as disabled in UI</span></div>
  </div></article></main>
  <footer class="footer">Live quotes hit mainnet 1Click with <span class="mono">dry:true</span> — no deposit</footer></div>`;
  document.getElementById("btn-quote")?.addEventListener("click", async () => {
    quotePreview = "Fetching…";
    renderCheckout(id);
    const q = await dryQuote({
      originAsset: "nep141:wrap.near",
      destinationAsset: "nep141:wrap.near",
      amount: t.price.amount,
      recipient: t.account,
    });
    quotePreview = q
      ? `Dry quote: ${q.amountInFormatted} → ${q.amountOutFormatted} (live mainnet API)`
      : "Quote failed — network or CORS; see README for curl fallback.";
    renderCheckout(id);
  });
}

async function renderFollower() {
  const a = RECORDED_AGENT;
  const sub = RECORDED_SUB;
  const dev = await loadDevnetSettlements();
  const latestCopy =
    [...dev].reverse().find(s => (s as { label?: string }).label?.includes("follower")) ?? dev[dev.length - 1];
  const copyLink =
    latestCopy?.signature
      ? `<a class="mono" href="https://explorer.solana.com/tx/${latestCopy.signature}?cluster=devnet" target="_blank" rel="noopener">${truncate(latestCopy.signature)}</a>`
      : "run npm run demo:live";
  app.innerHTML = `<div class="app"><nav class="nav">${navBrand()}<div class="nav__links">${nav("follower")}</div></nav>
  <main class="main grid2"><article class="kc"><header class="kc__head"><div class="kc__title">Copy agent</div><span class="kc__tag kc__tag--live"><i class="dot"></i> Online</span></header>
  <div class="kc__group kc__dl"><div><dt>Follower</dt><dd class="mono">${sub.follower}</dd></div>
  <div><dt>Trader</dt><dd class="mono">${sub.trader}</dd></div>
  <div><dt>Agent key</dt><dd class="mono">${truncate(sub.agentPublicKey)}</dd></div>
  <div><dt>Guardrails</dt><dd class="kc__chips"><i>max ${sub.guardrails.maxTradeQuote} quote</i><i>${sub.guardrails.copyRatioBps / 100}% size</i></dd></div></div>
  <ul class="kc__feed kc__group">${a.decisions.map(d => `<li><div class="kc__fa"><b>${d.action}</b><span>${d.reason}</span></div><div class="kc__fv"><span class="mono">${d.at.slice(11, 19)}Z</span></div></li>`).join("")}</ul>
  <div class="kc__note"><span>Latest devnet copy</span><span>${copyLink}</span></div>
  <div class="kc__note">${provBadge(a.provenance)} · key never shown to human · ${liveMode ? LIVE_FOLLOWER : sub.follower}</div></article>
  <div class="panel"><h2>Attestation</h2><p>${a.attestation.checks.map(c => `${c.ok ? "✓" : "○"} ${c.label}`).join("<br>")}</p>
  ${provBadge(a.attestation.provenance)}</div></main>
  <footer class="footer">Subscribe on NEAR testnet · epoch keys sealed to agent X25519 pubkey</footer></div>`;
}

async function renderExplorer(id: string) {
  const dev = await loadDevnetSettlements();
  const s = dev[0] ?? RECORDED_SETTLEMENTS[0];
  app.innerHTML = `<div class="app"><nav class="nav">${navBrand()}<div class="nav__links">${nav("explorer")}</div></nav>
  <main class="main grid2"><div class="panel"><h2>Public settlement</h2><p>Redacted explorer view — no amounts or tokens.</p>
  <div class="kc__dl"><div><dt>Signature</dt><dd class="mono">${truncate(s.signature)}</dd></div>
  <div><dt>Slot</dt><dd class="mono">${s.slot}</dd></div>
  <div><dt>Nullifiers</dt><dd class="mono">${truncate(s.nullifiers[0])}</dd></div>
  <div><dt>Commitments</dt><dd class="mono">${truncate(s.commitments[0])}</dd></div></div>
  ${provBadge(s.provenance)}</div>
  <div class="panel"><h2>Key holder view</h2><p>Decrypted trade records appear in the agent after settlement (demo: see Follower).</p>
  ${RECORDED_TRADES.map(tr => `<div style="margin-top:8px;font-size:13px"><b>${tr.side} ${tr.base.symbol}</b> · ${tr.baseAmount} @ ${tr.price}</div>`).join("")}
  </div></main>
  <footer class="footer">Polypus pool on Solana devnet (UNAUDITED)</footer></div>`;
}

async function refreshLive() {
  if (import.meta.env.VITE_LIVE !== "1") return;
  const live = await loadLiveTraders();
  if (live.length) {
    traders = live;
    liveMode = true;
  }
}

async function render() {
  const { page, id } = route();
  if (page === "trader") await renderTrader(id ?? traders[0].account);
  else if (page === "checkout") renderCheckout(id ?? traders[0].account);
  else if (page === "follower") await renderFollower();
  else if (page === "explorer") await renderExplorer(id ?? "");
  else renderLeaderboard();
}

window.addEventListener("hashchange", () => void render());
refreshLive().finally(() => void render());
