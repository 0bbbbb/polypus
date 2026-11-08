import { useEffect, useRef, useState } from "preact/hooks";
import { closeWalletModal, connectWallet, errText } from "../state/actions";
import { useStore } from "../state/store";
import { listWallets, REGISTRY, type WalletOption } from "../wallet/wallet";
import { IChevron, IClose, Skel } from "./ui";

export function WalletModal() {
  const open = useStore(s => s.walletModal);
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setBusy(null);
    if (!wallets) listWallets().then(setWallets, e => setLoadErr(errText(e)));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeWalletModal();
    addEventListener("keydown", onKey);
    document.documentElement.classList.add("is-locked");
    setTimeout(() => panel.current?.focus(), 0);
    return () => { removeEventListener("keydown", onKey); document.documentElement.classList.remove("is-locked"); };
  }, [open]);

  if (!open) return null;

  const pick = async (w: WalletOption) => {
    setBusy(w.id);
    setErr(null);
    try {
      await connectWallet(w.id);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="modal" role="presentation" onClick={e => e.target === e.currentTarget && closeWalletModal()}>
      <div class="modal__panel" role="dialog" aria-modal="true" aria-labelledby="wm-title" tabIndex={-1} ref={panel}>
        <header class="modal__head">
          <div>
            <h2 id="wm-title" class="modal__title">Connect a NEAR wallet</h2>
            <p class="modal__sub">NEAR testnet. Used to sign <span class="mono">subscribe</span> on the registry.</p>
          </div>
          <button type="button" class="iconbtn" onClick={closeWalletModal} aria-label="Close"><IClose size={16} /></button>
        </header>
        <ul class="wl">
          {!wallets && !loadErr && [0, 1, 2, 3].map(i => (
            <li key={i} class="wl__item wl__item--skel"><Skel w={32} h={32} r={9} /><span class="wl__text"><Skel w={110} h={13} /><Skel w={180} h={11} /></span></li>
          ))}
          {loadErr && <li class="wl__err">Wallets failed to load: {loadErr}</li>}
          {wallets?.map(w => (
            <li key={w.id}>
              <button type="button" class="wl__item" disabled={!!busy || !w.available} onClick={() => pick(w)}>
                <img class="wl__icon" src={w.iconUrl} width={32} height={32} alt="" />
                <span class="wl__text">
                  <b>{w.name}</b>
                  <span>{w.available ? w.description : "Not available in this browser"}</span>
                </span>
                <span class="wl__go">{busy === w.id ? <span class="spin" aria-label="Connecting" /> : <IChevron size={14} />}</span>
              </button>
            </li>
          ))}
        </ul>
        {err && <p class="modal__err" role="alert">{err}</p>}
        <footer class="modal__foot">
          <span>Contract</span>
          <a class="mono" href={`https://testnet.nearblocks.io/address/${REGISTRY}`} target="_blank" rel="noreferrer">{REGISTRY}</a>
        </footer>
      </div>
    </div>
  );
}
