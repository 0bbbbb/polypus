import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "./styles.css";
import { truncate } from "./fx/formats.js";
import {
  displayAttestorRef,
  displayEvmAddress,
  displayNearAccount,
  formatAgentNote,
  isPlaceholderKey,
} from "./fx/display.js";
import { formatNearYocto, formatUnits } from "./fx/amounts.js";
import { decoder } from "./fx/decode.js";
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
import { loadDevnetSettlements } from "./data/devnet.js";
import { fetchFeedLive } from "./near/registry.js";
import { chainSigForTrader } from "./near/chainsig.js";
import { fetchGatewaySlice } from "./near/nearaiBrowser.js";
import { fetchSubscriptionLive, loadFollowerSnapshot } from "./data/followerLive.js";
import { LIVE_FOLLOWER, LIVE_TRADER } from "./data/constants.js";
import { statusChip, statusChipFromLive } from "./ui/chips.js";
import { DEFAULT_GUARDRAILS } from "./data/guardrails.js";

const app = document.getElementById("app")!;
const wantLive = import.meta.env.VITE_LIVE !== "0";
let traders: Trader[] = RECORDED_TRADERS;
let liveMode = false;
let liveFailed = false;
let liveReady = false;
let quotePreview: CheckoutQuote | null = null;
let quoteError = "";
let quoteLoading = false;
let checkoutQuoteFor: string | null = null;

function shell(page: string, body: string, foot: string) {
  return `<div class="app"><nav class="nav"><div class="nav__row">${navBrand()}</div><div class="nav__links">${nav(page)}</div></nav>
  <main class="main">${body}</main>
  <footer class="footer">${foot}</footer></div>`;
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

function attestationBar(t: Trader): string {
  const label = displayAttestorRef(
    t.pnl.attestation.signerPublicKey,
    t.pnl.attestation.measurement,
    t.pnl.attestation.kind,
  );
  const live = t.pnl.provenance.kind === "live" && !isPlaceholderKey(t.pnl.attestation.signerPublicKey);
  return `<div class="kc__att">
    ${statusChip(live ? "live" : "simulated", "Attested")}
    <span class="kc__hash">${label}</span>
  </div>`;
}

function traderCards(list: Trader[]) {
  return list
    .map((t, i) => {
      const pnl = pnlPercent(t.pnl.pnlBps);
      return `<article class="kc">
        <header class="kc__head"><div class="kc__title"><span class="kc__rank">${i + 1}</span> ${t.handle}
        <span class="kc__acct">${displayNearAccount(t.account)}</span></div>
        <span class="kc__tag">${statusChipFromLive(t.pnl.provenance.kind === "live", "PnL")}</span></header>
        <div class="kc__lead kc__group"><div class="kc__big">${pnl}</div>
        <div class="kc__sub">${t.pnl.tradeCount} trades · through ${t.pnl.windowEnd.slice(0, 10)}</div>
        ${attestationBar(t)}</div>
        <footer class="kc__foot"><div class="kc__price"><span>Viewing key</span>
        <b>${formatNearYocto(t.price.amount)} / ${t.price.periodDays}d</b></div>
        <a class="kc__btn" href="#/trader/${encodeURIComponent(t.account)}">Open</a></footer>
      </article>`;
    })
    .join("");
}

function renderLeaderboard() {
  const note = liveFailed
    ? `<p class="banner banner--muted">${statusChip("simulated", "Offline")} Registry unreachable — showing recorded fixtures.</p>`
    : liveMode
      ? ""
      : "";
  const body = `<div class="page-head"><h1 class="h2">Attested performance. Trades stay sealed.</h1>
  <p class="page-lead">Ranked by on-chain PnL statements. Activity and settlements stay encrypted until your agent decrypts inside a TEE.</p></div>
  ${note}<div class="stack">${traderCards(traders)}</div>`;
  const foot = liveMode
    ? `${REGISTRY_ID} · testnet · ${statusChip("live", "Registry")}`
    : "Built for NEAR HACKATHON · Chain Signatures · Intents";
  app.innerHTML = shell("leaderboard", body, foot);
}

async function renderTrader(id: string) {
  const t = traders.find(x => x.account === decodeURIComponent(id)) ?? traders[0];
  let meta = "";
  if (liveMode) {
    const feed = await fetchFeedLive(t.account, 0, 8);
    const cs = await chainSigForTrader(t.account, t.derivationPath || "solana-1");
    meta = `<div class="kc__note"><span>Encrypted feed</span><span>${feed.length} records · epoch ${feed.at(-1)?.epoch ?? t.currentEpoch}</span></div>`;
    if (cs.solanaAddress) {
      meta += `<div class="kc__note"><span>MPC Solana</span><span class="mono">${truncate(cs.solanaAddress)}</span></div>`;
    }
  }
  const rows = RECORDED_TRADES.filter(tr => tr.trader === t.account)
    .map(
      tr => `<li class="is-hit"><div class="kc__fa"><b class="dec" data-dec>${tr.side.toUpperCase()} ${tr.base.symbol}</b>
      <span class="dec" data-dec>${formatUnits(tr.quoteAmount, tr.quote.decimals, tr.quote.symbol)}</span></div>
      <div class="kc__fv"><span class="mono dec" data-dec>${tr.price}</span><span class="mono dec" data-dec>${tr.executedAt.slice(11, 19)}Z</span></div></li>`,
    )
    .join("");
  const body = `<div class="grid2"><div>${traderCards([t])}</div>
  <article class="panel"><h2>Activity feed</h2>
  <p>Public view: fields redacted. Subscribers decrypt inside the copy agent.</p>
  <div class="kc"><header class="kc__head"><div class="kc__title">${t.handle} · shielded</div>
  <span class="kc__tag">${statusChip("simulated", "Encrypted")}</span></header>
  <ul class="kc__feed kc__group">${rows || "<li><span class=\"kc__fa\"><span>No public trades</span></span></li>"}</ul>
  <div class="kc__note"><span>Receipt address</span><span class="mono">${truncate(t.shieldedAddress)}</span></div>
  ${meta}</div></article></div>`;
  app.innerHTML = shell("trader", body, "Solana devnet settlements · Polypus pool");
  document.querySelectorAll<HTMLElement>("[data-dec]").forEach(el => decoder(el).set(0));
}

function quoteBlock(q: CheckoutQuote | null, err: string, loading: boolean, keyTrader?: string): string {
  if (loading) {
    return `<div class="kc__dl kc__group quote-skel" style="padding-bottom:8px" aria-busy="true">
    <div></div><div></div><div></div><div></div></div>`;
  }
  if (err) return `<p class="kc__note" style="box-shadow:none;color:var(--ink)">${err}</p>`;
  if (!q) return `<p class="page-lead" style="margin:0;padding:16px 20px">Dry quote from mainnet 1Click — no wallet spend.</p>`;
  const dep = q.depositAddress ? truncate(q.depositAddress) : "— (dry)";
  const exp = q.deadline ? q.deadline.slice(0, 19).replace("T", " ") + " UTC" : "—";
  return `<div class="kc__dl kc__group" style="padding-bottom:8px">
    <div><dt>Pay in</dt><dd>${q.amountInFormatted} <span class="mono">${truncate(q.originAsset)}</span></dd></div>
    <div><dt>Receive</dt><dd>${q.amountOutFormatted} USDC</dd></div>
    <div><dt>Deposit</dt><dd class="mono">${dep}</dd></div>
    <div><dt>Valid until</dt><dd>${exp}</dd></div>
    <div><dt>ETA</dt><dd>${q.timeEstimateSec ?? "—"}s · dry</dd></div>
    <div><dt>Route</dt><dd>${statusChip("live", "1Click")} USDC Base → NEAR</dd></div>
    ${keyTrader ? `<div><dt>Key trader</dt><dd>${displayNearAccount(keyTrader)}</dd></div>` : ""}
  </div>`;
}

async function fetchCheckoutQuote(t: Trader): Promise<void> {
  quoteLoading = true;
  quoteError = "";
  quotePreview = null;
  const q = await dryQuote({
    originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    amount: "2000000",
    recipient: "alice.near",
  });
  quoteLoading = false;
  if (!q) quoteError = "Quote failed — try again in a moment.";
  else quotePreview = q;
}

async function renderCheckout(id: string) {
  const t = traders.find(x => x.account === decodeURIComponent(id)) ?? traders[0];
  if (checkoutQuoteFor !== t.account) {
    checkoutQuoteFor = t.account;
    quotePreview = null;
    quoteError = "";
    quoteLoading = true;
    void fetchCheckoutQuote(t).then(() => renderCheckout(id));
  }
  const side = `<article class="checkout-side panel"><h2>${t.handle}</h2>
  <p class="mono" style="font-size:13px;margin-bottom:8px">${displayNearAccount(t.account)}</p>
  <p>Viewing key unlocks encrypted trade records for your copy agent inside a TEE — not your browser.</p>
  <ol><li>Quote any origin asset via 1Click (dry, no spend).</li><li>Pay on NEAR testnet to the registry, or use mainnet Intents when funded.</li><li>Trader seals the epoch key to your agent X25519 pubkey.</li></ol></article>`;
  const body = `<div class="checkout-layout"><article class="kc checkout-card">
  <header class="kc__head"><div class="kc__title">Buy key · ${t.handle}</div><span class="kc__tag">${statusChip("live", "1Click")}</span></header>
  <div class="kc__pay kc__group"><div class="kc__amt">${formatNearYocto(t.price.amount)}<small>/ ${t.price.periodDays}d</small></div>
  <span class="kc__chip">Registry</span></div>
  <div class="kc__route kc__group"><span class="kc__node is-on">Any chain</span><span class="kc__line"><i style="transform:scaleX(1)"></i></span>
  <span class="kc__node is-on">Intents</span><span class="kc__line"><i style="transform:scaleX(0.85)"></i></span><span class="kc__node is-on">NEAR</span></div>
  ${quoteBlock(quotePreview, quoteError, quoteLoading, t.account)}
  <div style="padding:0 20px 16px;display:flex;gap:8px;flex-wrap:wrap">
  <button type="button" class="kc__btn" id="btn-quote">Refresh dry quote</button>
  <button type="button" class="kc__btn kc__btn--wide is-done" disabled>Pay testnet NEAR</button></div>
  <div class="kc__note"><span>Confidential Intents</span><span>${statusChip("simulated", "Partner JWT")}</span></div>
  </article>${side}</div>`;
  app.innerHTML = shell("checkout", body, "Quotes use dry:true on the public 1Click API");
  document.getElementById("btn-quote")?.addEventListener("click", async () => {
    await fetchCheckoutQuote(t);
    renderCheckout(id);
  });
}

function dlRow(label: string, value: string, chip?: string, title?: string): string {
  const t = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
  return `<div><dt>${label}</dt><dd>${chip ?? ""}<span class="mono"${t}>${value}</span></dd></div>`;
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);
}

async function renderFollower() {
  try {
  const subLive = wantLive ? await withTimeout(fetchSubscriptionLive(), 12_000, null) : null;
  const snap = wantLive ? await loadFollowerSnapshot() : null;
  const gateway = await withTimeout(fetchGatewaySlice(), 8_000, {
    ok: false,
    signingAddress: "",
    quoteDigest: "",
    nonce: "",
    fetchedAt: new Date().toISOString(),
  });
  const showingLive = wantLive && !!(subLive || snap || liveMode);
  const trader = traders.find(x => x.account === LIVE_TRADER) ?? traders[0];
  const agentPk = subLive?.agent_pubkey ?? snap?.agentPublicKey ?? "—";
  const attDigest = subLive?.agent_attestation_digest ?? snap?.agentAttestationDigest ?? "—";
  const gHash = subLive?.guardrails_hash ?? snap?.guardrailsHash ?? "—";
  const maxQuote = formatUnits(DEFAULT_GUARDRAILS.maxTradeQuote, 6, "pUSD");
  const ratio = `${DEFAULT_GUARDRAILS.copyRatioBps / 100}% notional`;

  const decisions = snap?.decisions?.length
    ? snap.decisions
    : [];
  const copiedRows =
    decisions.length > 0
      ? decisions
          .map(d => {
            const tx = d.devnetTx
              ? `<a class="mono" href="https://explorer.solana.com/tx/${d.devnetTx}?cluster=devnet" target="_blank" rel="noopener">${truncate(d.devnetTx)}</a>`
              : "—";
            return `<li><div class="kc__ct"><b>${d.action} ${d.side} ${d.symbol}</b><small>${d.quoteHuman} · ${d.reason}</small></div>
            <div class="kc__cs">${tx}</div></li>`;
          })
          .join("")
      : `<li class="kc__fa"><span>Run <span class="mono">npm run demo:live</span> to populate feed.</span></li>`;

  const attRows = `
    <article class="kc"><header class="kc__head"><div class="kc__title">Attestation</div>
    ${statusChip(gateway.ok ? "live" : "simulated", "Gateway")}</header>
    <div class="kc__dl kc__group">
    ${dlRow("Vendor", "NEAR AI Cloud", statusChip(gateway.ok ? "live" : "simulated"))}
    ${gateway.signingAddress ? dlRow("Gateway signer", displayEvmAddress(gateway.signingAddress), undefined, gateway.signingAddress) : dlRow("Gateway signer", "—")}
    ${dlRow("Quote digest", gateway.quoteDigest ? truncate(gateway.quoteDigest) : "—")}
    ${dlRow("Agent digest", truncate(attDigest))}
    ${dlRow("Guardrails hash", truncate(gHash))}
    ${
      !isPlaceholderKey(trader.pnl.attestation.signerPublicKey)
        ? dlRow("PnL attestor", truncate(trader.pnl.attestation.signerPublicKey))
        : ""
    }
    ${dlRow("Fetched", gateway.fetchedAt.slice(11, 19) + "Z")}
    </div>
    <p style="padding:12px 20px 16px;font-size:12px;color:var(--ink-2)">Key material never leaves the agent runtime. Human sees copied settlements only.</p>
    </article>`;

  const agentCard = `<article class="kc"><header class="kc__head"><div class="kc__title">Copy agent</div>
    ${statusChip(showingLive ? "live" : "simulated", showingLive ? "Online" : "Fixture")}</header>
    <div class="kc__dl kc__group">
    <div><dt>Follower</dt><dd class="mono">${LIVE_FOLLOWER}</dd></div>
    <div><dt>Trader</dt><dd class="mono">${LIVE_TRADER}</dd></div>
    <div><dt>Agent X25519</dt><dd class="mono">${truncate(agentPk)}</dd></div>
    <div><dt>Guardrails</dt><dd class="kc__chips"><i>max ${maxQuote}</i><i>${ratio}</i><i>${DEFAULT_GUARDRAILS.allowedTokens.join(" · ")}</i></dd></div>
    </div>
    <header class="kc__glabel kc__group" style="padding-top:12px"><span>Decrypted feed</span>
    ${statusChip(snap ? "live" : "simulated", snap ? "Agent TEE" : "Awaiting sync")}</header>
    <ul class="kc__copied kc__group">${copiedRows}</ul>
    </article>`;

  const last = decisions[decisions.length - 1];
  const explainPanel = last
    ? (() => {
        const { line, inferenceChip } = formatAgentNote({
          action: last.action,
          side: last.side,
          symbol: last.symbol,
          quoteHuman: last.quoteHuman,
          inferenceSimulated: /SIMULATED|simulated inference/i.test(last.explanation ?? ""),
        });
        return `<article class="panel"><h2>Agent note</h2><p style="color:var(--ink);font-size:14px;margin:0">${line}</p>
    <p style="margin-top:12px;margin-bottom:0">${statusChip(inferenceChip, inferenceChip === "live" ? "NEAR AI" : "Template inference")}</p></article>`;
      })()
    : "";

  const body = `<div class="follower-stack"><div class="grid2 grid2--balanced">${agentCard}${attRows}</div>${explainPanel}</div>`;
  app.innerHTML = shell("follower", body, "Epoch keys sealed to agent pubkey on subscribe");
  } catch (e) {
    app.innerHTML = shell("follower", `<p class="page-lead">Follower view error: ${String(e)}</p>`, "");
  }
}

async function renderExplorer(id: string) {
  const dev = await loadDevnetSettlements();
  const s = dev.at(-1) ?? RECORDED_SETTLEMENTS[0];
  const body = `<div class="grid2 grid2--balanced">
  <article class="panel"><h2>Public settlement</h2><p>Redacted explorer — signatures and Merkle artifacts only.</p>
  <div class="kc__dl">
  ${dlRow("Signature", truncate(s.signature))}
  ${dlRow("Pool", truncate(s.pool))}
  ${dlRow("Nullifier", truncate(s.nullifiers[0]))}
  ${dlRow("Commitment", truncate(s.commitments[0]))}
  </div>
  <p style="margin-top:16px">${statusChip("live", "devnet")}</p></article>
  <article class="panel"><h2>Key holder view</h2><p>Decrypted trade rows appear on the Follower screen after the agent copies.</p>
  <ul class="kc__feed">${RECORDED_TRADES.slice(0, 3).map(tr => `<li><div class="kc__fa"><b>${tr.side} ${tr.base.symbol}</b>
  <span>${formatUnits(tr.baseAmount, tr.base.decimals, tr.base.symbol)}</span></div></li>`).join("")}</ul>
  </article></div>`;
  app.innerHTML = shell("explorer", body, "Polypus pool · UNAUDITED devnet");
}

async function refreshLive() {
  if (!wantLive) {
    liveReady = true;
    return;
  }
  try {
    const live = await loadLiveTraders();
    if (live.length) {
      traders = live;
      liveMode = true;
      liveFailed = false;
    } else {
      liveFailed = true;
    }
  } catch {
    liveFailed = true;
    liveMode = false;
  } finally {
    liveReady = true;
  }
}

async function render() {
  const { page, id } = route();
  if (page === "trader") await renderTrader(id ?? traders[0].account);
  else if (page === "checkout") await renderCheckout(id ?? traders[0].account);
  else if (page === "follower") await renderFollower();
  else if (page === "explorer") await renderExplorer(id ?? "");
  else renderLeaderboard();
}

window.addEventListener("hashchange", () => void render());
void (async () => {
  await refreshLive();
  await render();
})();
