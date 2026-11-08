import { useEffect, useRef, useState } from "preact/hooks";
import type { Route } from "../lib/router";
import { href } from "../lib/router";
import { account, ago } from "../lib/format";
import { useNow } from "../lib/hooks";
import { exitDemo, openWalletModal, signOutWallet } from "../state/actions";
import { setState, useStore } from "../state/store";
import { REGISTRY } from "../wallet/wallet";
import { Coin, IChevronDown, IClose, LiveDot, TxLink } from "./ui";

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const f = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("pointerdown", f);
    addEventListener("keydown", k);
    return () => { removeEventListener("pointerdown", f); removeEventListener("keydown", k); };
  }, [open]);
  return { open, setOpen, ref };
}

export function Header({ route }: { route: Route }) {
  const links: [string, string, Route["name"][]][] = [
    ["Discover", href.discover, ["discover", "trader"]],
    ["Portfolio", href.portfolio, ["portfolio"]],
    ["Proof", href.proof, ["proof"]],
  ];
  const tabs = links.map(([label, to, names]) => (
    <a key={to} href={to} class={names.includes(route.name) ? "is-on" : ""} aria-current={names.includes(route.name) ? "page" : undefined}>{label}</a>
  ));
  return (
    <>
    <header class="hdr">
      <div class="hdr__bar wrap">
        <a class="brand" href={href.discover} aria-label="Polypus Keys home">
          <Coin size={28} class="brand__coin" />
          <span class="brand__word">Polypus <span>Keys</span></span>
        </a>
        <nav class="nav" aria-label="Primary">{tabs}</nav>
        <div class="hdr__end">
          <Status />
          <AccountButton />
        </div>
      </div>
    </header>
    <nav class="tabbar" aria-label="Primary">{tabs}</nav>
    </>
  );
}

function Status() {
  const health = useStore(s => s.health);
  const offline = useStore(s => s.offline);
  const now = useNow();
  const pop = usePopover();
  const svcs = health ? Object.entries(health.services) : [];
  const allUp = svcs.length > 0 && svcs.every(([, v]) => v.up);
  const state = offline ? "Offline" : !health ? "Connecting" : allUp ? "Live" : "Degraded";
  return (
    <div class="status" ref={pop.ref}>
      <button type="button" class={`status__btn is-${state.toLowerCase()}`} onClick={() => pop.setOpen(!pop.open)} aria-expanded={pop.open}>
        <LiveDot on={state === "Live"} />
        <span class="status__t">{state}</span>
      </button>
      {pop.open && (
        <div class="pop pop--status" role="dialog" aria-label="Service status">
          <p class="pop__title">Local services</p>
          {offline || !health ? (
            <p class="pop__note">The local API at 127.0.0.1:8787 isn't answering.</p>
          ) : (
            <dl class="dl dl--tight">
              {svcs.map(([k, v]) => (
                <div key={k}>
                  <dt class="cap"><span class={v.up ? "pip is-up" : "pip"} />{k}</dt>
                  <dd>{v.up ? (v.lastTickAt ? ago(v.lastTickAt, now) : "up") : v.note ?? "down"}</dd>
                </div>
              ))}
              <div><dt>Network</dt><dd>NEAR {health.network}</dd></div>
              <div><dt>Demo account</dt><dd>{health.demo.available ? `${health.demo.balanceNear.toFixed(2)} NEAR` : health.demo.reason ?? "unavailable"}</dd></div>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

function AccountButton() {
  const identity = useStore(s => s.identity);
  const walletAcc = useStore(s => s.wallet);
  const pop = usePopover();

  if (!identity && !walletAcc) {
    return <button type="button" class="btn btn--dark btn--sm" onClick={openWalletModal}>Connect wallet</button>;
  }
  const who = identity?.account ?? walletAcc!;
  const isDemo = identity?.kind === "demo";
  return (
    <div class="acct" ref={pop.ref}>
      <button type="button" class="acct__btn" onClick={() => pop.setOpen(!pop.open)} aria-expanded={pop.open}>
        {isDemo && <span class="acct__demo">Demo</span>}
        <span class="acct__name">{account(who)}</span>
        <IChevronDown size={12} />
      </button>
      {pop.open && (
        <div class="pop pop--menu" role="menu">
          <p class="pop__title">{isDemo ? "Acting as demo account" : "Connected wallet"}</p>
          <p class="pop__acct mono">{who}</p>
          <a role="menuitem" class="pop__item" href={href.portfolio} onClick={() => pop.setOpen(false)}>Portfolio</a>
          <a role="menuitem" class="pop__item" href={`https://testnet.nearblocks.io/address/${who}`} target="_blank" rel="noreferrer">View on NearBlocks</a>
          {isDemo && !walletAcc && <button role="menuitem" type="button" class="pop__item" onClick={() => { pop.setOpen(false); openWalletModal(); }}>Connect wallet</button>}
          {isDemo && <button role="menuitem" type="button" class="pop__item" onClick={() => { pop.setOpen(false); exitDemo(); }}>Exit demo</button>}
          {walletAcc && <button role="menuitem" type="button" class="pop__item" onClick={() => { pop.setOpen(false); signOutWallet(); }}>Sign out {isDemo ? account(walletAcc) : ""}</button>}
        </div>
      )}
    </div>
  );
}

export function Footer() {
  return (
    <footer class="ftr">
      <div class="wrap ftr__in">
        <span class="ftr__brand"><Coin size={18} />Polypus Keys</span>
        <span class="ftr__net">NEAR testnet · Solana devnet</span>
        <a class="ftr__reg" href={`https://testnet.nearblocks.io/address/${REGISTRY}`} target="_blank" rel="noreferrer">
          <span class="mono">{REGISTRY}</span>
        </a>
      </div>
    </footer>
  );
}

export function OfflineBanner() {
  const offline = useStore(s => s.offline);
  if (!offline) return null;
  return (
    <div class="banner" role="status">
      <div class="wrap banner__in">
        <span class="pip" />
        <span>Local API offline. Run <code class="mono">npm run dev:all</code> and this page reconnects on its own.</span>
      </div>
    </div>
  );
}

export function NoticeToast() {
  const n = useStore(s => s.notice);
  if (!n) return null;
  return (
    <div class={`toast is-${n.kind}`} role={n.kind === "error" ? "alert" : "status"} key={n.id}>
      <span class="toast__t">{n.text}</span>
      {n.tx && <TxLink tx={n.tx} />}
      <button type="button" class="iconbtn iconbtn--sm" aria-label="Dismiss" onClick={() => setState({ notice: null })}><IClose size={12} /></button>
    </div>
  );
}
