import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "./styles.css";
import { truncate } from "./fx/formats.js";
import { displayAttestorRef, displayEvmAddress, displayNearAccount, isPlaceholderKey } from "./fx/display.js";
import { formatNearYocto, formatUnits } from "./fx/amounts.js";
import { revealFeed } from "./fx/feedReveal.js";
import {
  RECORDED_SETTLEMENTS,
  RECORDED_TRADERS,
  RECORDED_TRADES,
  REGISTRY_ID,
  pnlPercent,
} from "./data/recorded.js";
import { loadLiveTraders } from "./data/live.js";
import type { CheckoutQuote, Trader } from "./data/types.js";
import { dryQuote } from "./near/oneclick.js";
import { PAY_OPTIONS, QUOTE_DESTINATION, type PayOption } from "./data/payOptions.js";
import { loadDevnetSettlements } from "./data/devnet.js";
import { fetchFeedLive } from "./near/registry.js";
import { chainSigForTrader } from "./near/chainsig.js";
import { fetchGatewaySlice } from "./near/nearaiBrowser.js";
import { fetchSubscriptionLive, loadFollowerSnapshot } from "./data/followerLive.js";
import { LIVE_FOLLOWER, LIVE_TRADER } from "./data/constants.js";
import { statusChip } from "./ui/chips.js";
import { DEFAULT_GUARDRAILS } from "./data/guardrails.js";
import { getPayOptionId, isDemoUnlocked, isKeyBought, setDemoUnlocked, setKeyBought, setPayOptionId } from "./app/session.js";

const app = document.getElementById("app")!;
const wantLive = import.meta.env.VITE_LIVE !== "0";
let traders: Trader[] = RECORDED_TRADERS;
let liveMode = false;
let liveFailed = false;

let quotePreview: CheckoutQuote | null = null;
let quoteError = "";
let quoteLoading = false;
let quoteFor: string | null = null;
let payOption: PayOption = PAY_OPTIONS[0]!;

function shell(mainNav: string, body: string, foot: string) {
  return `<div class="app"><nav class="nav nav--story"><div class="nav__row">${navBrand()}${nav(mainNav)}</div></nav>
  <main class="main">${body}</main>
  <footer class="footer footer--story"><span>${foot}</span>
  <a href="#/proof" class="footer__link">Proof &amp; explorer</a></footer></div>`;
}

function route(): { page: string; id?: string } {
  const raw = location.hash.replace(/^#\/?/, "") || "traders";
  const [page, id] = raw.split("/");
  const alias: Record<string, string> = {
    "": "traders",
    leaderboard: "traders",
    checkout: "trader",
    follower: "agent",
    explorer: "proof",
  };
  return { page: alias[page] ?? page, id };
}

function navBrand() {
  return `<a class="nav__brand" href="#/traders"><img class="nav__mark" src="./brand/polypus-mark.svg" width="22" height="22" alt=""> Polypus Keys</a>`;
}

function nav(active: string) {
  const items: [string, string][] = [
    ["traders", "Traders"],
    ["agent", "My agent"],
  ];
  const links = items
    .map(([href, label]) => `<a href="#/${href}" class="${active === href ? "is-on" : ""}">${label}</a>`)
    .join("");
  return `<div class="nav__links nav__links--main">${links}</div>${statusChip("live", "Testnet")}`;
}

function hasPnlStatement(t: Trader): boolean {
  return t.pnl.tradeCount > 0 || t.pnl.pnlBps !== 0;
}

function listedTraders(): Trader[] {
  return traders.filter(hasPnlStatement);
}

function redactPills(n = 6): string {
  const widths = ["w-72", "w-56", "w-64", "w-48", "w-60", "w-52"];
  return `<div class="redact-pills">${widths
    .slice(0, n)
    .map(w => `<span class="redact-pill ${w}"></span>`)
    .join("")}</div>`;
}

function homeTraderCard(t: Trader, rank: number): string {
  const pnl = pnlPercent(t.pnl.pnlBps);
  const verified = t.pnl.provenance.kind === "live" || t.pnl.tradeCount > 0;
  return `<article class="kc home-card">
    <header class="kc__head"><div class="kc__title"><span class="kc__rank">${rank}</span> ${t.handle}
    <span class="kc__acct">${displayNearAccount(t.account)}</span></div>
    ${verified ? `<span class="verify-chip">✓ Verified</span>` : ""}</header>
    <div class="home-card__body">
      <div class="home-card__pnl">${pnl}</div>
      <p class="home-card__meta">${t.pnl.tradeCount} shielded trades · verified on-chain</p>
      ${redactPills()}
    </div>
    <footer class="kc__foot home-card__foot">
      <div class="kc__price"><span>Viewing key</span><b>${formatNearYocto(t.price.amount)} / ${t.price.periodDays}d</b></div>
      <a class="kc__btn kc__btn--wide" href="#/trader/${encodeURIComponent(t.account)}">Buy key</a>
    </footer>
  </article>`;
}

function renderTraders() {
  const list = listedTraders();
  const note = liveFailed
    ? `<p class="banner banner--muted">${statusChip("simulated", "Offline")} Could not reach registry — showing saved trader list.</p>`
    : "";
  const body = `<div class="page-head page-head--story">
    <h1 class="h2">Copy traders whose trades stay private.</h1>
    <p class="page-lead">Performance is verified. Trades are hidden until you buy their key.</p></div>
    ${note}<div class="stack stack--home">${list.map((t, i) => homeTraderCard(t, i + 1)).join("")}</div>`;
  const foot = liveMode ? `${REGISTRY_ID} · NEAR testnet` : "Polypus Keys · NEAR hackathon demo";
  app.innerHTML = shell("traders", body, foot);
}

function stepper(activeStep: number): string {
  const steps = ["Verified", "Key bought", "Trades decrypted", "Copied on Solana"];
  return `<ol class="stepper" aria-label="Progress">${steps
    .map((label, i) => {
      const n = i + 1;
      const cls = n < activeStep ? "is-done" : n === activeStep ? "is-active" : "";
      return `<li class="${cls}"><span class="stepper__n">${n}</span><span class="stepper__t">${label}</span></li>`;
    })
    .join("")}</ol>`;
}

function proofDrawer(title: string, rows: string, open = false): string {
  return `<details class="proof"${open ? " open" : ""}><summary>${title}</summary><div class="proof__body"><dl class="proof__dl">${rows}</dl></div></details>`;
}

function proofRow(label: string, value: string, title?: string): string {
  const t = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
  return `<div><dt>${label}</dt><dd class="mono"${t}>${value}</dd></div>`;
}

function lockedFeedRow(time: string): string {
  return `<li class="feed-row feed-row--locked">
    <div class="feed-row__bars">${redactPills(4)}</div>
    <time class="feed-row__time">${time}</time>
  </li>`;
}

function tradeFeedHtml(t: Trader, unlocked: boolean): string {
  const trades = RECORDED_TRADES.filter(tr => tr.trader === t.account);
  if (!unlocked) {
    const times = trades.length
      ? trades.map(tr => tr.executedAt.slice(11, 16))
      : ["09:14", "11:02", "14:38", "16:51", "18:22", "19:01"];
    return `<ul class="feed-list feed-list--locked">${times.map(lockedFeedRow).join("")}</ul>`;
  }
  const rows = trades
    .map(
      tr => `<li class="feed-row feed-row--open is-hit">
      <div class="feed-row__main">
        <b data-dec>${tr.side.toUpperCase()} ${tr.base.symbol}</b>
        <span data-dec>${formatUnits(tr.quoteAmount, tr.quote.decimals, tr.quote.symbol)}</span>
      </div>
      <div class="feed-row__meta">
        <span class="mono" data-dec>${tr.price}</span>
        <time data-dec>${tr.executedAt.slice(11, 19)}Z</time>
      </div>
    </li>`,
    )
    .join("");
  return `<ul class="feed-list feed-list--open" data-feed>${rows || `<li class="feed-row"><span>No trades in fixture.</span></li>`}</ul>`;
}

function plainQuoteLine(q: CheckoutQuote | null, t: Trader, opt: PayOption, loading: boolean, err: string): string {
  if (loading) return `<p class="buy-quote buy-quote--loading" aria-busy="true"><span class="quote-skel-line"></span></p>`;
  if (err) return `<p class="buy-quote buy-quote--err">${err}</p>`;
  if (!q) return `<p class="buy-quote">Choose how you want to pay — we’ll fetch a live exchange quote.</p>`;
  return `<p class="buy-quote">You pay ~<b>${q.amountInFormatted} ${opt.label}</b> → <b>${t.handle}</b> receives <b>${formatNearYocto(t.price.amount)}</b> for ${t.price.periodDays} days.</p>`;
}

async function fetchQuoteForTrader(t: Trader, opt: PayOption): Promise<void> {
  quoteLoading = true;
  quoteError = "";
  quotePreview = null;
  quoteFor = `${t.account}:${opt.id}`;
  const q = await dryQuote({
    originAsset: opt.originAsset,
    destinationAsset: QUOTE_DESTINATION,
    amount: opt.amount,
    recipient: "alice.near",
  });
  quoteLoading = false;
  if (!q) quoteError = "Could not fetch a quote for this asset right now.";
  else quotePreview = q;
}

function paySelect(t: Trader, selected: PayOption): string {
  return `<label class="pay-select"><span class="pay-select__label">Pay with</span>
  <select id="pay-with" class="pay-select__input">${PAY_OPTIONS.map(
    o => `<option value="${o.id}"${o.id === selected.id ? " selected" : ""}>${o.label}</option>`,
  ).join("")}</select></label>`;
}

function buyPanel(t: Trader, unlocked: boolean, quoteLine: string): string {
  const bought = unlocked;
  return `<aside class="buy-panel panel">
    <h2 class="buy-panel__title">Buy ${t.handle}'s key</h2>
    <p class="buy-panel__price">${formatNearYocto(t.price.amount)} <span>/ ${t.price.periodDays} days</span></p>
    ${paySelect(t, payOption)}
    ${quoteLine}
  <button type="button" class="kc__btn kc__btn--wide buy-panel__cta" id="btn-buy-key"${bought ? " disabled" : ""}>${bought ? "Key active" : "Buy key"}</button>
    <p class="buy-panel__hint">Settles on NEAR testnet registry. Mainnet Intents when funded.</p>
  </aside>`;
}

function storyBanner(unlocked: boolean): string {
  if (!unlocked) return "";
  return `<p class="story-banner">${statusChip("live", "Unlocked")} Key delivered to your copy agent — it never leaves the secure enclave.</p>`;
}

function copyAgentSection(
  showingLive: boolean,
  snap: Awaited<ReturnType<typeof loadFollowerSnapshot>>,
  decisions: NonNullable<Awaited<ReturnType<typeof loadFollowerSnapshot>>>["decisions"],
  inferenceFootnote: string,
): string {
  const maxQuote = formatUnits(DEFAULT_GUARDRAILS.maxTradeQuote, 6, "pUSD");
  const ratio = `${DEFAULT_GUARDRAILS.copyRatioBps / 100}% of trader size`;
  const tokens = DEFAULT_GUARDRAILS.allowedTokens.join(", ");
  const rows =
    decisions && decisions.length
      ? decisions
          .map(d => {
            const link = d.devnetTx
              ? `<a class="copy-trade__link" href="https://explorer.solana.com/tx/${d.devnetTx}?cluster=devnet" target="_blank" rel="noopener">View on Solana ↗</a>`
              : "";
            return `<li class="copy-trade"><div><b>${d.action} ${d.side} ${d.symbol}</b><small>${d.quoteHuman} · within your limits</small></div>
            <div class="copy-trade__end">${link}<span class="copy-trade__status">Settled</span></div></li>`;
          })
          .join("")
      : `<li class="copy-trade copy-trade--empty"><span>Copied trades appear here after the agent runs.</span></li>`;

  return `<section class="agent-section panel" id="copy-agent">
    <h2>Your agent copies within your limits</h2>
    <ul class="guardrail-plain">
      <li><span>Max per trade</span><b>${maxQuote}</b></li>
      <li><span>Size</span><b>${ratio}</b></li>
      <li><span>Tokens</span><b>${tokens}</b></li>
    </ul>
    <ul class="copy-trades">${rows}</ul>
    ${inferenceFootnote}
    <p class="agent-foot">${showingLive ? `Following ${displayNearAccount(LIVE_TRADER)} as ${displayNearAccount(LIVE_FOLLOWER)}` : "Demo follower pair on testnet."}</p>
  </section>`;
}

async function renderTrader(id: string) {
  const acct = decodeURIComponent(id);
  const t = listedTraders().find(x => x.account === acct) ?? listedTraders()[0];
  if (!t) {
    app.innerHTML = shell("traders", `<p class="page-lead">No verified traders yet.</p>`, "");
    return;
  }

  const storedPay = getPayOptionId(t.account);
  payOption = PAY_OPTIONS.find(o => o.id === storedPay) ?? PAY_OPTIONS[0]!;

  const subLive = wantLive ? await fetchSubscriptionLive().catch(() => null) : null;
  const snap = wantLive ? await loadFollowerSnapshot().catch(() => null) : null;
  const gateway = await fetchGatewaySlice().catch(() => ({
    ok: false,
    signingAddress: "",
    quoteDigest: "",
    nonce: "",
    fetchedAt: new Date().toISOString(),
  }));
  const feedMeta =
    liveMode && wantLive
      ? await fetchFeedLive(t.account, 0, 8).catch(() => [])
      : [];
  const cs =
    liveMode && wantLive
      ? await chainSigForTrader(t.account, t.derivationPath || "solana-1").catch(() => ({ solanaAddress: "" }))
      : { solanaAddress: "" };

  const demo = isDemoUnlocked();
  const hasSub = !!(subLive && subLive.trader === t.account) || demo;
  const keyActive = hasSub || isKeyBought(t.account);
  const unlocked = demo || isKeyBought(t.account) || !!(subLive && subLive.trader === t.account);
  const decisions = snap?.decisions ?? [];
  const copied = decisions.some(d => !!d.devnetTx);
  const step = copied ? 4 : unlocked ? 3 : keyActive ? 2 : hasPnlStatement(t) ? 1 : 1;

  const quoteKey = `${t.account}:${payOption.id}`;
  if (quoteFor !== quoteKey) {
    quoteLoading = true;
    void fetchQuoteForTrader(t, payOption).then(() => renderTrader(id));
  }

  const proofVerified = proofDrawer(
    "How do we know performance is verified?",
  `${proofRow("Registry", REGISTRY_ID)}
  ${proofRow("Trader", displayNearAccount(t.account))}
  ${proofRow("Return", pnlPercent(t.pnl.pnlBps))}
  ${!isPlaceholderKey(t.pnl.attestation.signerPublicKey) ? proofRow("Attestor", truncate(t.pnl.attestation.signerPublicKey), t.pnl.attestation.signerPublicKey) : ""}
  ${proofRow("Statement", t.pnl.signature ? truncate(t.pnl.signature) : "—")}`,
  );

  const proofKey = proofDrawer(
    "How do we know the key is yours?",
    `${proofRow("Follower", LIVE_FOLLOWER)}
    ${subLive ? proofRow("Subscription", subLive.status) : proofRow("Subscription", demo ? "Demo unlock (judge)" : "—")}
    ${proofRow("Encrypted feed rows", String(feedMeta.length || "—"))}`,
  );

  const proofCopy = proofDrawer(
    "How do we know copies settled?",
    `${gateway.signingAddress ? proofRow("Gateway signer", displayEvmAddress(gateway.signingAddress), gateway.signingAddress) : ""}
    ${proofRow("Guardrails", snap?.guardrailsHash ? truncate(snap.guardrailsHash) : "—")}
    ${cs.solanaAddress ? proofRow("Chain Signatures Solana", truncate(cs.solanaAddress), cs.solanaAddress) : ""}
    ${decisions[0]?.devnetTx ? proofRow("Latest Solana tx", truncate(decisions[0].devnetTx), decisions[0].devnetTx) : ""}`,
  );

  const inferenceSim = decisions.some(d => /SIMULATED|simulated inference/i.test(d.explanation ?? ""));
  const inferenceFootnote = inferenceSim
    ? `<p class="footnote-chip">${statusChip("simulated", "Enclave inference simulated")} · needs NEAR AI key</p>`
  : "";

  const demoToggle = `<button type="button" class="demo-toggle" id="btn-demo-unlock">${demo ? "Hide demo unlock" : "See it unlocked (demo)"}</button>`;

  const body = `<div class="trader-story">
    ${stepper(step)}
    ${storyBanner(unlocked)}
    <div class="trader-story__head">
      <h1 class="h2">${t.handle}</h1>
      <p class="page-lead">${displayNearAccount(t.account)}</p>
      ${demoToggle}
    </div>
    <div class="trader-layout">
      <div class="trader-feed panel">
        <h2>${unlocked ? "Their trades (for you only)" : "Their trades (hidden)"}</h2>
        <p class="panel__sub">${unlocked ? "Decrypted inside your agent — not in this browser." : "Buy the key to decrypt inside your copy agent."}</p>
        ${tradeFeedHtml(t, unlocked)}
        ${proofVerified}
      </div>
      ${buyPanel(t, keyActive, plainQuoteLine(quotePreview, t, payOption, quoteLoading, quoteError))}
    </div>
    ${unlocked ? proofKey : ""}
    ${unlocked && t.account === LIVE_TRADER ? copyAgentSection(!!(subLive || snap), snap, decisions, inferenceFootnote) : ""}
    ${unlocked && copied ? proofCopy : ""}
  </div>`;

  app.innerHTML = shell("traders", body, liveMode ? `${REGISTRY_ID} · NEAR testnet` : "Polypus Keys");
  app.querySelector<HTMLElement>("[data-feed]") && revealFeed(app.querySelector("[data-feed]")!, unlocked);

  app.querySelector("#btn-demo-unlock")?.addEventListener("click", () => {
    setDemoUnlocked(!demo);
    if (!demo) setKeyBought(t.account);
    void renderTrader(id);
  });
  app.querySelector("#btn-buy-key")?.addEventListener("click", () => {
    setKeyBought(t.account);
    void renderTrader(id);
  });
  app.querySelector<HTMLSelectElement>("#pay-with")?.addEventListener("change", e => {
    const opt = PAY_OPTIONS.find(o => o.id === (e.target as HTMLSelectElement).value) ?? PAY_OPTIONS[0]!;
    payOption = opt;
    setPayOptionId(t.account, opt.id);
    quoteFor = null;
    quotePreview = null;
    void fetchQuoteForTrader(t, opt).then(() => renderTrader(id));
  });
}

async function renderAgent() {
  const t = traders.find(x => x.account === LIVE_TRADER) ?? listedTraders()[0];
  if (!t) {
    app.innerHTML = shell("agent", `<p class="page-lead">Subscribe to a trader to run your copy agent.</p>`, "");
    return;
  }
  const snap = wantLive ? await loadFollowerSnapshot().catch(() => null) : null;
  const subLive = wantLive ? await fetchSubscriptionLive().catch(() => null) : null;
  const decisions = snap?.decisions ?? [];
  const copied = decisions.some(d => !!d.devnetTx);
  const inferenceSim = decisions.some(d => /SIMULATED|simulated inference/i.test(d.explanation ?? ""));
  const inferenceFootnote = inferenceSim
    ? `<p class="footnote-chip">${statusChip("simulated", "Enclave inference simulated")} · needs NEAR AI key</p>`
    : "";
  const body = `<div class="page-head page-head--story">
    <h1 class="h2">My copy agent</h1>
    <p class="page-lead">Runs in a secure enclave — you set limits; it copies ${t.handle} on Solana.</p></div>
    ${stepper(copied ? 4 : 3)}
    <p class="story-banner">${statusChip("live", "Agent")} Subscribed to ${displayNearAccount(LIVE_TRADER)}.</p>
    ${copyAgentSection(!!(subLive || snap), snap, decisions, inferenceFootnote)}
    <p style="margin-top:var(--s5)"><a class="kc__btn" href="#/trader/${encodeURIComponent(t.account)}">View ${t.handle}'s story</a></p>`;
  app.innerHTML = shell("agent", body, liveMode ? `${REGISTRY_ID} · NEAR testnet` : "Polypus Keys");
}

async function renderProof() {
  const dev = await loadDevnetSettlements();
  const s = dev.at(-1) ?? RECORDED_SETTLEMENTS[0];
  const t = traders.find(x => x.account === LIVE_TRADER) ?? listedTraders()[0];
  const gateway = await fetchGatewaySlice().catch(() => ({
    ok: false,
    signingAddress: "",
    quoteDigest: "",
    nonce: "",
    fetchedAt: new Date().toISOString(),
  }));

  const body = `<div class="page-head page-head--story"><h1 class="h2">Proof &amp; explorer</h1>
  <p class="page-lead">Technical artifacts for reviewers — not required to use the product.</p></div>
  <div class="stack">
    ${proofDrawer(
      "Registry &amp; attestor",
      `${proofRow("Contract", REGISTRY_ID)}
      ${t ? proofRow("Trader", displayNearAccount(t.account)) : ""}
      ${t && !isPlaceholderKey(t.pnl.attestation.signerPublicKey) ? proofRow("Attestor pubkey", truncate(t.pnl.attestation.signerPublicKey), t.pnl.attestation.signerPublicKey) : ""}
      ${t ? proofRow("Attestor ref", displayAttestorRef(t.pnl.attestation.signerPublicKey, t.pnl.attestation.measurement, t.pnl.attestation.kind)) : ""}`,
      true,
    )}
    ${proofDrawer(
      "NEAR AI gateway",
      `${gateway.signingAddress ? proofRow("Signer", displayEvmAddress(gateway.signingAddress), gateway.signingAddress) : proofRow("Signer", "—")}
      ${proofRow("Quote digest", gateway.quoteDigest ? truncate(gateway.quoteDigest) : "—")}
      ${proofRow("Fetched", gateway.fetchedAt)}`,
    )}
    ${proofDrawer(
      "Solana devnet settlement",
      `${proofRow("Signature", truncate(s.signature))}
      ${proofRow("Pool", truncate(s.pool))}
      ${proofRow("Nullifier", truncate(s.nullifiers[0]))}`,
    )}
  </div>`;
  app.innerHTML = shell("proof", body, "Polypus Keys · proof view");
}

async function refreshLive() {
  if (!wantLive) return;
  try {
    const live = await loadLiveTraders();
    if (live.length) {
      traders = live;
      liveMode = true;
      liveFailed = false;
    } else liveFailed = true;
  } catch {
    liveFailed = true;
    liveMode = false;
  }
}

async function render() {
  const { page, id } = route();
  if (page === "trader") await renderTrader(id ?? listedTraders()[0]?.account ?? LIVE_TRADER);
  else if (page === "agent") await renderAgent();
  else if (page === "proof") await renderProof();
  else renderTraders();
}

window.addEventListener("hashchange", () => void render());
void (async () => {
  await refreshLive();
  await render();
})();
