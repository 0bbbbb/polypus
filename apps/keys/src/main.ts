import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "./styles.css";
import { truncate } from "./fx/formats.js";
import { displayAttestorRef, displayEvmAddress, displayNearAccount, isPlaceholderKey } from "./fx/display.js";
import { formatNearYocto, formatUnits, formatUsdPrice, formatUtcTime, groupThousands } from "./fx/amounts.js";
import { sealCells } from "./fx/feedReveal.js";
import {
  RECORDED_SETTLEMENTS,
  RECORDED_TRADERS,
  RECORDED_TRADES,
  REGISTRY_ID,
  pnlPercent,
} from "./data/recorded.js";
import { loadLiveTraders } from "./data/live.js";
import type { CheckoutQuote, Trader, TradeRecord } from "./data/types.js";
import { dryQuote } from "./near/oneclick.js";
import { PAY_OPTIONS, QUOTE_DESTINATION, type PayOption } from "./data/payOptions.js";
import { loadDevnetSettlements } from "./data/devnet.js";
import { fetchFeedLive } from "./near/registry.js";
import { chainSigForTrader } from "./near/chainsig.js";
import { fetchGatewaySlice } from "./near/nearaiBrowser.js";
import { fetchSubscriptionLive, loadFollowerSnapshot, type FollowerSnapshot } from "./data/followerLive.js";
import { LIVE_FOLLOWER, LIVE_TRADER } from "./data/constants.js";
import { statusChip } from "./ui/chips.js";
import { DEFAULT_GUARDRAILS } from "./data/guardrails.js";
import {
  advance,
  anyUnlocked,
  demoRequested,
  getPayOptionId,
  isUnlocked,
  setPayOptionId,
  stageOf,
  type Stage,
} from "./app/session.js";

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

/** Bumped on every route render so stale async work never paints over a newer page. */
let renderSeq = 0;

const CHECK = `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 6.3l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEVRON = `<svg class="proof__chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function footText(): string {
  return liveMode ? `${REGISTRY_ID} · NEAR testnet` : "Polypus Keys · NEAR testnet demo";
}

function shell(mainNav: string, body: string) {
  return `<div class="app"><nav class="nav nav--story"><div class="nav__row">${navBrand()}${nav(mainNav)}</div></nav>
  <main class="main">${body}</main>
  <footer class="footer footer--story"><span>${footText()}</span>
  <a href="#/proof" class="footer__link">Proof &amp; explorer</a></footer></div>`;
}

function route(): { page: string; id?: string } {
  const raw = location.hash.replace(/^#\/?/, "").split("?")[0] || "traders";
  const [page, id] = raw.split("/");
  const alias: Record<string, string> = {
    "": "traders",
    leaderboard: "traders",
    checkout: "trader",
    follower: "agent",
    explorer: "proof",
  };
  return { page: alias[page!] ?? page!, id };
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
  return `<div class="redact-pills" aria-label="Hidden trades">${widths
    .slice(0, n)
    .map(w => `<span class="redact-pill ${w}"></span>`)
    .join("")}</div>`;
}

/* ---------- home ---------- */

function homeTraderCard(t: Trader, rank: number): string {
  const pnl = pnlPercent(t.pnl.pnlBps);
  const verified = t.pnl.provenance.kind === "live" || t.pnl.tradeCount > 0;
  const n = t.pnl.tradeCount;
  return `<article class="kc home-card">
    <header class="kc__head"><div class="kc__title"><span class="kc__rank">${rank}</span> ${t.handle}
    <span class="kc__acct">${displayNearAccount(t.account)}</span></div>
    ${verified ? `<span class="verify-chip">${CHECK} Verified</span>` : ""}</header>
    <div class="home-card__body">
      <div class="home-card__stat"><div class="home-card__pnl">${pnl}</div>
      <p class="home-card__meta">Verified return · ${groupThousands(n)} private trade${n === 1 ? "" : "s"}</p></div>
      <div class="home-card__hidden"><span class="home-card__hlabel">Trades hidden until you buy the key</span>${redactPills()}</div>
    </div>
    <footer class="kc__foot home-card__foot">
      <div class="kc__price"><span>Key</span><b>${formatNearYocto(t.price.amount)} / ${t.price.periodDays} days</b></div>
      <a class="kc__btn home-card__cta" href="#/trader/${encodeURIComponent(t.account)}">View trader</a>
    </footer>
  </article>`;
}

function howItWorks(): string {
  const steps: [string, string][] = [
    ["Verified performance", "Returns are checked and signed before a trader is listed."],
    ["Buy the key", "One payment unlocks the trader’s hidden trades for 30 days."],
    ["Agent copies on Solana", "Your copy agent mirrors each trade within the limits you set."],
  ];
  return `<section class="how" aria-label="How it works"><h2 class="how__title">How it works</h2><ol class="how__list">${steps
    .map(([t, d], i) => `<li><span class="how__n">${i + 1}</span><b>${t}</b><p>${d}</p></li>`)
    .join("")}</ol></section>`;
}

function renderTraders() {
  const list = listedTraders();
  const note = liveFailed
    ? `<p class="banner banner--muted">${statusChip("simulated", "Offline")} Could not reach the registry — showing the saved trader list.</p>`
    : "";
  const body = `<div class="home">
    <div class="page-head page-head--story">
      <h1 class="h2">Copy traders whose trades stay private.</h1>
      <p class="page-lead">Performance is verified. Trades stay hidden until you buy the trader’s key — then your agent copies them.</p>
    </div>
    ${note}<div class="stack stack--home">${list.map((t, i) => homeTraderCard(t, i + 1)).join("")}</div>
    ${howItWorks()}
  </div>`;
  app.innerHTML = shell("traders", body);
}

/* ---------- shared pieces ---------- */

const STEPS = ["Verified", "Key bought", "Trades decrypted", "Copied on Solana"];

function stepsDone(stage: Stage): number {
  return { locked: 1, key_bought: 2, decrypted: 3, copied: 4 }[stage];
}

function stepper(stage: Stage): string {
  const done = stepsDone(stage);
  const current = done + 1;
  const items = STEPS.map((label, i) => {
    const n = i + 1;
    const cls = n <= done ? "is-done" : n === current ? "is-current" : "is-future";
    const state = n <= done ? "done" : n === current ? "current" : "not started";
    return `<li class="${cls}" aria-label="Step ${n}: ${label} (${state})"><span class="stepper__n">${n <= done ? CHECK : n}</span><span class="stepper__t">${label}</span></li>`;
  }).join("");
  const now = done >= STEPS.length ? `All done · ${STEPS[STEPS.length - 1]}` : `Step ${current} of ${STEPS.length} · ${STEPS[current - 1]}`;
  return `<div class="stepper-wrap" data-stepper><ol class="stepper" aria-label="Progress">${items}</ol><p class="stepper__now">${now}</p></div>`;
}

function proofDrawer(id: string, rows: string, opts: { title?: string; card?: boolean; open?: boolean } = {}): string {
  const { title = "How do we know?", card = false, open = false } = opts;
  return `<details class="proof${card ? " proof--card" : ""}" id="${id}"${open ? " open" : ""}><summary><span>${title}</span>${CHEVRON}</summary><div class="proof__body"><dl class="proof__dl">${rows}</dl></div></details>`;
}

function proofRow(label: string, value: string, title?: string): string {
  const t = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
  return `<div><dt>${label}</dt><dd class="mono"${t}>${value}</dd></div>`;
}

/** What the copy agent would place for a trader trade under the default guardrails. */
function copySize(tr: TradeRecord): { text: string; capped: boolean } {
  const amt = BigInt(tr.quoteAmount.replace(/\D/g, "") || "0");
  const scaled = (amt * BigInt(DEFAULT_GUARDRAILS.copyRatioBps)) / 10000n;
  const max = BigInt(DEFAULT_GUARDRAILS.maxTradeQuote);
  const capped = scaled > max;
  return { text: formatUnits((capped ? max : scaled).toString(), tr.quote.decimals, tr.quote.symbol), capped };
}

function maskText(s: string): string {
  return s.replace(/[A-Za-z0-9$@]/g, "0");
}

/* ---------- trader page ---------- */

type TraderCtx = {
  t: Trader;
  trades: TradeRecord[];
  subLive: Awaited<ReturnType<typeof fetchSubscriptionLive>>;
  snap: FollowerSnapshot | null;
  gateway: Awaited<ReturnType<typeof fetchGatewaySlice>>;
  feedRows: number;
  solanaAddress: string;
};

const emptyGateway = () => ({ ok: false, signingAddress: "", quoteDigest: "", nonce: "", fetchedAt: new Date().toISOString() });

async function loadTraderCtx(t: Trader): Promise<TraderCtx> {
  const [subLive, snap, gateway, feed, cs] = await Promise.all([
    wantLive ? fetchSubscriptionLive().catch(() => null) : Promise.resolve(null),
    wantLive ? loadFollowerSnapshot().catch(() => null) : Promise.resolve(null),
    fetchGatewaySlice().catch(emptyGateway),
    liveMode && wantLive ? fetchFeedLive(t.account, 0, 8).catch(() => []) : Promise.resolve([]),
    liveMode && wantLive
      ? chainSigForTrader(t.account, t.derivationPath || "solana-1").catch(() => ({ solanaAddress: "" }))
      : Promise.resolve({ solanaAddress: "" }),
  ]);
  return {
    t,
    trades: RECORDED_TRADES.filter(tr => tr.trader === t.account),
    subLive,
    snap,
    gateway: gateway as TraderCtx["gateway"],
    feedRows: feed.length,
    solanaAddress: cs.solanaAddress ?? "",
  };
}

function copyDecisions(ctx: TraderCtx) {
  return ctx.t.account === LIVE_TRADER ? (ctx.snap?.decisions ?? []) : [];
}

function tradeRow(tr: TradeRecord, sealed: boolean): string {
  const side = `${tr.side.toUpperCase()} ${tr.base.symbol}`;
  const amount = formatUnits(tr.quoteAmount, tr.quote.decimals, tr.quote.symbol);
  const price = `@ ${formatUsdPrice(tr.price)}`;
  const time = formatUtcTime(tr.executedAt);
  const copy = copySize(tr);
  const copyText = `You copy ${copy.text}${copy.capped ? " (capped at your max)" : ""}`;
  const v = (s: string) => (sealed ? maskText(s) : s);
  return `<li class="feed-row${sealed ? " is-sealed" : ""}">
    <div class="feed-row__main">
      <b data-dec>${v(side)}</b>
      <span data-dec>${v(amount)}</span>
      <small class="feed-row__copy" data-dec>${v(copyText)}</small>
    </div>
    <div class="feed-row__meta">
      <span data-dec>${v(price)}</span>
      <time data-dec>${v(time)}</time>
    </div>
  </li>`;
}

function tradeFeedHtml(ctx: TraderCtx, stage: Stage): string {
  if (!ctx.trades.length) {
    return `<ul class="feed-list"><li class="feed-row feed-row--empty"><span>No recent trades to show.</span></li></ul>`;
  }
  const sealed = !isUnlocked(stage);
  return `<ul class="feed-list" data-feed>${ctx.trades.map(tr => tradeRow(tr, sealed)).join("")}</ul>`;
}

function quoteLine(t: Trader): string {
  if (quoteLoading) return `<p class="buy-quote buy-quote--loading" id="buy-quote" aria-busy="true"><span class="quote-skel-line"></span></p>`;
  if (quoteError || !quotePreview)
    return `<p class="buy-quote" id="buy-quote">Pay <b>${formatNearYocto(t.price.amount)}</b> for ${t.price.periodDays} days of access${quoteError ? " (live conversion quote unavailable right now)" : ""}.</p>`;
  return `<p class="buy-quote" id="buy-quote">Pay about <b>${quotePreview.amountInFormatted} ${payOption.label}</b>, converted to <b>${formatNearYocto(t.price.amount)}</b> for ${t.price.periodDays} days of access.</p>`;
}

async function fetchQuote(t: Trader, opt: PayOption): Promise<void> {
  const key = `${t.account}:${opt.id}`;
  quoteFor = key;
  quoteLoading = true;
  quoteError = "";
  quotePreview = null;
  const q = await dryQuote({
    originAsset: opt.originAsset,
    destinationAsset: QUOTE_DESTINATION,
    amount: opt.amount,
    recipient: "alice.near",
  }).catch(() => null);
  if (quoteFor !== key) return;
  quoteLoading = false;
  if (!q) quoteError = "unavailable";
  else quotePreview = q;
  const el = app.querySelector("#buy-quote");
  if (el) el.outerHTML = quoteLine(t);
}

function paySelect(selected: PayOption): string {
  return `<label class="pay-select"><span class="pay-select__label">Pay with</span>
  <select id="pay-with" class="pay-select__input">${PAY_OPTIONS.map(
    o => `<option value="${o.id}"${o.id === selected.id ? " selected" : ""}>${o.label}</option>`,
  ).join("")}</select></label>`;
}

function buyPanel(ctx: TraderCtx, stage: Stage): string {
  const { t } = ctx;
  const bought = isUnlocked(stage);
  const head = `<h2 class="buy-panel__title">${bought ? `${t.handle}'s key` : `Buy ${t.handle}'s key`}</h2>
    <p class="buy-panel__price">${formatNearYocto(t.price.amount)} <span>/ ${t.price.periodDays} days</span></p>`;
  if (!bought) {
    return `<aside class="buy-panel panel" id="buy-panel">${head}
      ${paySelect(payOption)}
      ${quoteLine(t)}
      <button type="button" class="kc__btn kc__btn--wide buy-panel__cta" id="btn-buy-key">Buy key</button>
      <button type="button" class="text-btn buy-panel__demo" id="btn-demo-unlock">Skip payment — demo unlock</button>
      <p class="buy-panel__hint">Testnet demo — no real funds.</p>
    </aside>`;
  }
  const keyProof = proofDrawer(
    "proof-key",
    `${proofRow("Copy agent account", LIVE_FOLLOWER)}
    ${proofRow("Subscription on registry", ctx.subLive ? `${ctx.subLive.status} (${displayNearAccount(ctx.subLive.follower)} → ${displayNearAccount(ctx.subLive.trader)})` : "Demo unlock — no payment")}
    ${ctx.subLive?.agent_pubkey ? proofRow("Agent key", truncate(ctx.subLive.agent_pubkey), ctx.subLive.agent_pubkey) : ""}
    ${proofRow("Encrypted feed rows", ctx.feedRows ? String(ctx.feedRows) : "—")}
    ${proofRow("Registry", REGISTRY_ID)}`,
  );
  return `<aside class="buy-panel panel" id="buy-panel">${head}
    <p class="buy-quote">Your copy agent holds this key for ${t.price.periodDays} days. It reads the trades; nobody else can.</p>
    <button type="button" class="kc__btn kc__btn--wide buy-panel__cta is-done" id="btn-buy-key" disabled>Key active ${CHECK}</button>
    ${keyProof}
    <p class="buy-panel__hint">Testnet demo — no real funds.</p>
  </aside>`;
}

function storyBanner(ctx: TraderCtx, stage: Stage): string {
  if (!isUnlocked(stage)) return "";
  const h = ctx.t.handle;
  const willCopy = copyDecisions(ctx).length > 0;
  const text =
    stage === "key_bought"
      ? `Key delivered to your copy agent. Decrypting ${h}’s trades…`
      : stage === "decrypted"
        ? willCopy
          ? `Trades decrypted. Your agent is copying the latest one on Solana…`
          : `Trades decrypted. Your agent will copy ${h}’s next trade on Solana.`
        : `Your agent copied ${h}’s latest trade on Solana, within your limits.`;
  const jump = stage === "copied" ? `<button type="button" class="text-btn story-banner__jump" data-scroll="copy-agent">See the copy ↓</button>` : "";
  return `<div class="story-banner" role="status">${statusChip("live", "Unlocked")}<span>${text}</span>${jump}</div>`;
}

function copiedRow(d: FollowerSnapshot["decisions"][number], sealed: boolean): string {
  const verb = d.action === "copy" ? "Copied" : d.action.charAt(0).toUpperCase() + d.action.slice(1);
  const amount = d.quoteHuman.replace(/^(\d+)/, m => groupThousands(m));
  const when = `${new Date(d.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${formatUtcTime(d.at)}`;
  const link = d.devnetTx
    ? `<a class="copy-trade__link" href="https://explorer.solana.com/tx/${d.devnetTx}?cluster=devnet" target="_blank" rel="noopener">View on Solana ↗</a>`
    : "";
  return `<li class="copy-trade${sealed ? " is-new" : ""}">
    <div class="copy-trade__main"><b data-dec>${verb} ${d.side.toUpperCase()} ${d.symbol} · ${amount}</b><small>${when} · within your limits</small></div>
    <div class="copy-trade__end"><span class="copy-trade__status">${CHECK} Settled</span>${link}</div>
  </li>`;
}

function copyAgentSection(ctx: TraderCtx, stage: Stage, animateCopy: boolean): string {
  const decisions = copyDecisions(ctx);
  const maxQuote = formatUnits(DEFAULT_GUARDRAILS.maxTradeQuote, 6, "pUSD");
  const ratio = `${DEFAULT_GUARDRAILS.copyRatioBps / 100}% of the trader’s size`;
  const tokens = DEFAULT_GUARDRAILS.allowedTokens.join(", ");

  let rows: string;
  if (stage === "copied" && decisions.length) rows = decisions.map(d => copiedRow(d, animateCopy)).join("");
  else {
    const msg =
      stage === "locked"
        ? `Nothing copied yet — buy the key and your agent starts copying ${ctx.t.handle}.`
        : stage === "key_bought"
          ? "Waiting for decrypted trades…"
          : decisions.length
            ? "Placing the copy on Solana…"
            : `Your agent will copy ${ctx.t.handle}’s next trade.`;
    rows = `<li class="copy-trade copy-trade--empty"><span>${msg}</span></li>`;
  }

  const inferenceSim = decisions.some(d => /SIMULATED|simulated inference/i.test(d.explanation ?? ""));
  const latestTx = decisions.find(d => d.devnetTx)?.devnetTx;
  const copyProof = proofDrawer(
    "proof-copy",
    `${proofRow("Live pair", `${displayNearAccount(LIVE_FOLLOWER)} follows ${displayNearAccount(LIVE_TRADER)}`)}
    ${latestTx ? proofRow("Latest Solana tx", truncate(latestTx), latestTx) : ""}
    ${ctx.solanaAddress ? proofRow("Trader’s Solana address", truncate(ctx.solanaAddress), ctx.solanaAddress) : ""}
    ${ctx.snap?.guardrailsHash ? proofRow("Limits fingerprint", truncate(ctx.snap.guardrailsHash), ctx.snap.guardrailsHash) : ""}
    ${ctx.gateway.signingAddress ? proofRow("Gateway signer", displayEvmAddress(ctx.gateway.signingAddress), ctx.gateway.signingAddress) : ""}
    ${proofRow("Agent reasoning", inferenceSim ? "Simulated — needs a NEAR AI key for enclave inference" : "NEAR AI enclave")}`,
  );

  return `<section class="agent-section panel${isUnlocked(stage) ? "" : " is-idle"}" id="copy-agent">
    <div class="agent-section__head">
      <div><h2>Your copy agent</h2><p class="panel__sub">Copies ${ctx.t.handle} on Solana — only within the limits you set.</p></div>
    </div>
    <ul class="guardrail-plain">
      <li><span>Max per trade</span><b>${maxQuote}</b></li>
      <li><span>Copy size</span><b>${ratio}</b></li>
      <li><span>Tokens</span><b>${tokens}</b></li>
    </ul>
    <h3 class="agent-section__label">Copied trades</h3>
    <ul class="copy-trades" data-copies>${rows}</ul>
    ${copyProof}
  </section>`;
}

type PaintOpts = { animateFeed?: boolean; animateCopy?: boolean };

function paintTrader(ctx: TraderCtx, opts: PaintOpts = {}): { decryptFeed: () => Promise<void>; decryptCopy: () => Promise<void> } {
  const { t } = ctx;
  const stage = stageOf(t.account);
  const openDrawers = new Set([...app.querySelectorAll<HTMLDetailsElement>("details[open]")].map(d => d.id));
  const n = t.pnl.tradeCount;

  const perfProof = proofDrawer(
    "proof-perf",
    `${proofRow("Registry", REGISTRY_ID)}
    ${proofRow("Trader", displayNearAccount(t.account))}
    ${proofRow("Return", pnlPercent(t.pnl.pnlBps))}
    ${!isPlaceholderKey(t.pnl.attestation.signerPublicKey) ? proofRow("Attestor", truncate(t.pnl.attestation.signerPublicKey), t.pnl.attestation.signerPublicKey) : proofRow("Attestor", displayAttestorRef(t.pnl.attestation.signerPublicKey, t.pnl.attestation.measurement, t.pnl.attestation.kind))}
    ${proofRow("Signed statement", t.pnl.signature ? truncate(t.pnl.signature) : "—")}`,
  );

  const unlocked = isUnlocked(stage);
  const body = `<div class="trader-story" data-stage="${stage}">
    <header class="trader-head">
      <div class="trader-head__who"><h1 class="h2">${t.handle}</h1><p class="trader-head__acct">${displayNearAccount(t.account)}</p></div>
      <dl class="trader-head__stats">
        <div><dt>Verified return</dt><dd>${pnlPercent(t.pnl.pnlBps)}</dd></div>
        <div><dt>Trades</dt><dd>${groupThousands(n)}</dd></div>
        <div><dt>Key</dt><dd>${formatNearYocto(t.price.amount)}</dd></div>
      </dl>
    </header>
    ${stepper(stage)}
    ${storyBanner(ctx, stage)}
    <div class="trader-layout">
      <section class="trader-feed panel">
        <h2>${unlocked ? "Their trades — unlocked for you" : "Their trades are hidden"}</h2>
        <p class="panel__sub">${unlocked ? "Only you and your copy agent can read these." : `Buy the key to read them. Your agent then copies them for you.`}</p>
        ${tradeFeedHtml(ctx, stage)}
        ${perfProof}
      </section>
      ${buyPanel(ctx, stage)}
    </div>
    ${copyAgentSection(ctx, stage, !!opts.animateCopy)}
  </div>`;

  app.innerHTML = shell("traders", body);
  for (const id of openDrawers) app.querySelector<HTMLDetailsElement>(`#${id}`)?.setAttribute("open", "");
  document.body.dataset.stage = stage;

  const feed = app.querySelector<HTMLElement>("[data-feed]");
  const noop = () => Promise.resolve();
  const decryptFeed = feed && (!unlocked || opts.animateFeed) ? sealCells(feed) : noop;
  const copies = app.querySelector<HTMLElement>("[data-copies]");
  const decryptCopy = copies && opts.animateCopy ? sealCells(copies) : noop;
  return { decryptFeed: unlocked ? decryptFeed : noop, decryptCopy };
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** KEY_BOUGHT -> DECRYPTED -> COPIED, with the decode animations in between. */
async function runUnlock(ctx: TraderCtx, seq: number): Promise<void> {
  const acct = ctx.t.account;
  if (!advance(acct, "key_bought")) return;
  document.body.dataset.anim = "1";
  try {
    const { decryptFeed } = paintTrader(ctx, { animateFeed: true });
    bindTrader(ctx, seq);
    await wait(250);
    await decryptFeed();
    if (seq !== renderSeq) return;
    advance(acct, "decrypted");
    paintTrader(ctx);
    bindTrader(ctx, seq);
    if (!copyDecisions(ctx).length) return;
    await wait(700);
    if (seq !== renderSeq) return;
    advance(acct, "copied");
    const { decryptCopy } = paintTrader(ctx, { animateCopy: true });
    bindTrader(ctx, seq);
    await decryptCopy();
  } finally {
    if (seq === renderSeq) document.body.dataset.anim = "0";
  }
}

function bindTrader(ctx: TraderCtx, seq: number) {
  const { t } = ctx;
  const buy = app.querySelector<HTMLButtonElement>("#btn-buy-key:not([disabled])");
  buy?.addEventListener("click", async () => {
    buy.disabled = true;
    buy.classList.add("is-busy");
    buy.textContent = "Confirming…";
    app.querySelector<HTMLButtonElement>("#btn-demo-unlock")?.setAttribute("disabled", "");
    await wait(700);
    if (seq === renderSeq) void runUnlock(ctx, seq);
  });
  app.querySelector("#btn-demo-unlock")?.addEventListener("click", () => void runUnlock(ctx, seq));
  app.querySelector<HTMLSelectElement>("#pay-with")?.addEventListener("change", e => {
    const opt = PAY_OPTIONS.find(o => o.id === (e.target as HTMLSelectElement).value) ?? PAY_OPTIONS[0]!;
    payOption = opt;
    setPayOptionId(t.account, opt.id);
    const q = app.querySelector("#buy-quote");
    quoteLoading = true;
    if (q) q.outerHTML = quoteLine(t);
    void fetchQuote(t, opt);
  });
  app.querySelectorAll<HTMLElement>("[data-scroll]").forEach(el =>
    el.addEventListener("click", () => app.querySelector(`#${el.dataset.scroll}`)?.scrollIntoView({ behavior: "smooth", block: "start" })),
  );
}

async function renderTrader(id: string, seq: number) {
  const acct = decodeURIComponent(id);
  const t = listedTraders().find(x => x.account === acct) ?? listedTraders()[0];
  if (!t) {
    app.innerHTML = shell("traders", `<p class="page-lead">No verified traders yet.</p>`);
    return;
  }

  const storedPay = getPayOptionId(t.account);
  payOption = PAY_OPTIONS.find(o => o.id === storedPay) ?? PAY_OPTIONS[0]!;
  if (quoteFor !== `${t.account}:${payOption.id}`) void fetchQuote(t, payOption);

  const ctx = await loadTraderCtx(t);
  if (seq !== renderSeq) return;
  paintTrader(ctx);
  bindTrader(ctx, seq);
  document.body.dataset.anim = "0";
  if (demoRequested() && stageOf(t.account) === "locked") void runUnlock(ctx, seq);
}

/* ---------- my agent ---------- */

async function renderAgent(seq: number) {
  const acct = anyUnlocked();
  const t = acct ? traders.find(x => x.account === acct) : undefined;
  if (!t) {
    const first = listedTraders()[0];
    app.innerHTML = shell(
      "agent",
      `<div class="home"><div class="page-head page-head--story">
        <h1 class="h2">My copy agent</h1>
        <p class="page-lead">You don’t have an agent yet. Buy a trader’s key and your agent starts copying their trades on Solana, within your limits.</p>
      </div>
      ${first ? `<a class="kc__btn" href="#/trader/${encodeURIComponent(first.account)}">Browse traders</a>` : ""}</div>`,
    );
    document.body.dataset.stage = "locked";
    return;
  }
  const ctx = await loadTraderCtx(t);
  if (seq !== renderSeq) return;
  const stage = stageOf(t.account);
  const body = `<div class="home">
    <div class="page-head page-head--story">
      <h1 class="h2">My copy agent</h1>
      <p class="page-lead">Copying ${t.handle} on Solana, within the limits you set.</p>
    </div>
    ${stepper(stage)}
    ${copyAgentSection(ctx, stage, false)}
    <p class="agent-back"><a class="text-btn" href="#/trader/${encodeURIComponent(t.account)}">← Back to ${t.handle}</a></p>
  </div>`;
  app.innerHTML = shell("agent", body);
  document.body.dataset.stage = stage;
}

/* ---------- proof ---------- */

async function renderProof(seq: number) {
  const dev = await loadDevnetSettlements();
  const s = dev.at(-1) ?? RECORDED_SETTLEMENTS[0]!;
  const t = traders.find(x => x.account === LIVE_TRADER) ?? listedTraders()[0];
  const gateway = await fetchGatewaySlice().catch(emptyGateway);
  if (seq !== renderSeq) return;

  const body = `<div class="home"><div class="page-head page-head--story"><h1 class="h2">Proof &amp; explorer</h1>
  <p class="page-lead">Technical artifacts for reviewers — not needed to use the product.</p></div>
  <div class="stack">
    ${proofDrawer(
      "pp-registry",
      `${proofRow("Contract", REGISTRY_ID)}
      ${t ? proofRow("Trader", displayNearAccount(t.account)) : ""}
      ${t && !isPlaceholderKey(t.pnl.attestation.signerPublicKey) ? proofRow("Attestor pubkey", truncate(t.pnl.attestation.signerPublicKey), t.pnl.attestation.signerPublicKey) : ""}
      ${t ? proofRow("Attestor ref", displayAttestorRef(t.pnl.attestation.signerPublicKey, t.pnl.attestation.measurement, t.pnl.attestation.kind)) : ""}`,
      { title: "Registry &amp; attestor", card: true, open: true },
    )}
    ${proofDrawer(
      "pp-gateway",
      `${gateway.signingAddress ? proofRow("Signer", displayEvmAddress(gateway.signingAddress), gateway.signingAddress) : proofRow("Signer", "—")}
      ${proofRow("Quote digest", gateway.quoteDigest ? truncate(gateway.quoteDigest) : "—")}
      ${proofRow("Fetched", gateway.fetchedAt)}`,
      { title: "NEAR AI gateway", card: true },
    )}
    ${proofDrawer(
      "pp-solana",
      `${proofRow("Signature", truncate(s.signature))}
      ${proofRow("Pool", truncate(s.pool))}
      ${proofRow("Nullifier", truncate(s.nullifiers[0]!))}`,
      { title: "Solana devnet settlement", card: true },
    )}
  </div></div>`;
  app.innerHTML = shell("proof", body);
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
  const seq = ++renderSeq;
  const { page, id } = route();
  delete document.body.dataset.stage;
  document.body.dataset.anim = "0";
  if (page === "trader") await renderTrader(id ?? listedTraders()[0]?.account ?? LIVE_TRADER, seq);
  else if (page === "agent") await renderAgent(seq);
  else if (page === "proof") await renderProof(seq);
  else renderTraders();
  if (seq === renderSeq) window.scrollTo(0, 0);
}

window.addEventListener("hashchange", () => void render());
void (async () => {
  await refreshLive();
  await render();
})();
