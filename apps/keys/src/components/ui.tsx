import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { TxRef } from "../api/types";
import { hashString } from "../fx/formats";
import { glitch } from "../fx/glitch";
import { useScramble } from "../fx/scramble";
import { ago, nearAccountUrl, short, solAddressUrl } from "../lib/format";
import { useNow } from "../lib/hooks";

type IconProps = { size?: number; class?: string };
const svg = (d: JSX.Element, { size = 14, class: c }: IconProps) => (
  <svg class={c} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{d}</svg>
);
export const IArrow = (p: IconProps) => svg(<path d="M3 8h9.5M8.5 4l4 4-4 4" />, p);
export const IArrowNE = (p: IconProps) => svg(<path d="M5 11l6-6M6 5h5v5" />, p);
export const ICheck = (p: IconProps) => svg(<path d="M3.5 8.5l3 3 6-7" />, p);
export const IClose = (p: IconProps) => svg(<path d="M4 4l8 8M12 4l-8 8" />, p);
export const IChevron = (p: IconProps) => svg(<path d="M6 4l4 4-4 4" />, p);
export const IChevronDown = (p: IconProps) => svg(<path d="M4 6l4 4 4-4" />, p);
export const ILock = (p: IconProps) => svg(<><rect x="3.5" y="7" width="9" height="6.5" rx="1.75" stroke-width="1.25" /><path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" stroke-width="1.25" /></>, p);
export const IKey = (p: IconProps) => svg(<><circle cx="5.5" cy="10.5" r="2.75" stroke-width="1.25" /><path d="M7.5 8.5l5-5M10.75 5.25l1.75 1.75M9.25 6.75l1.25 1.25" stroke-width="1.25" /></>, p);
export const ICopy = (p: IconProps) => svg(<><rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1.75" stroke-width="1.25" /><path d="M10.25 3.25h-5a2 2 0 0 0-2 2v5" stroke-width="1.25" /></>, p);
export const IUnlock = (p: IconProps) => svg(<><rect x="3.5" y="7" width="9" height="6.5" rx="1.75" stroke-width="1.25" /><path d="M5.5 7V5.25a2.5 2.5 0 0 1 4.9-.7" stroke-width="1.25" /></>, p);

export function Coin({ size = 28, class: c }: { size?: number; class?: string }) {
  return <img class={c} src={size > 64 ? "./brand/coin-360.webp" : "./brand/coin-96.webp"} width={size} height={size} alt="" draggable={false} />;
}

export function Avatar({ account, size = 36 }: { account: string; size?: number }) {
  let h = hashString(account);
  const cells: JSX.Element[] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    if (h % 7 < 3) continue;
    cells.push(<rect x={x} y={y} width="1" height="1" />);
    if (x < 2) cells.push(<rect x={4 - x} y={y} width="1" height="1" />);
  }
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <svg viewBox="-1 -1 7 7" width={size} height={size} shape-rendering="crispEdges">{cells}</svg>
    </span>
  );
}

export function TxLink({ tx, hideLabel }: { tx: TxRef; hideLabel?: boolean }) {
  return (
    <a class="txl" href={tx.url} target="_blank" rel="noreferrer" title={`${tx.label} · ${tx.hash}`}>
      {!hideLabel && <span class="txl__label">{tx.label}</span>}
      <span class="mono">{short(tx.hash)}</span>
      <IArrowNE size={12} />
    </a>
  );
}

export function AddrLink({ addr, chain, full }: { addr: string; chain: "near" | "sol"; full?: boolean }) {
  const url = chain === "near" ? nearAccountUrl(addr) : solAddressUrl(addr);
  const text = chain === "near" && /\.(testnet|near)$/.test(addr) ? addr : full ? addr : short(addr);
  return (
    <a class="addr" href={url} target="_blank" rel="noreferrer" title={addr}>
      <span class={chain === "near" && text === addr ? "" : "mono"}>{text}</span>
      <IArrowNE size={12} />
    </a>
  );
}

export function Copyable({ value, display }: { value: string; display?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      class="copyable"
      title={value}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }, () => {});
      }}
    >
      <span class="mono">{display ?? short(value)}</span>
      {ok ? <ICheck size={12} /> : <ICopy size={12} />}
    </button>
  );
}

export function Dec({ text, play = true, delay = 0, class: c }: { text: string; play?: boolean; delay?: number; class?: string }) {
  const fx = useScramble(text, play, 650, delay);
  return (
    <span class={`scr ${c ?? ""}`}>
      <span class={fx ? "scr__real is-hidden" : "scr__real"}>{text}</span>
      {fx && <span class="scr__fx" aria-hidden="true">{fx}</span>}
    </span>
  );
}

export function Glitch({ children, text, onMount = true }: { children?: ComponentChildren; text: string; onMount?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(0);
  useEffect(() => {
    if (!onMount) return;
    const t = setTimeout(() => glitch(ref.current), 350);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <span
      ref={ref}
      class="g"
      data-text={text}
      onPointerEnter={() => {
        const n = performance.now();
        if (n - last.current > 1200) { last.current = n; glitch(ref.current); }
      }}
    >
      {children ?? text}
    </span>
  );
}

export function LiveDot({ on = true }: { on?: boolean }) {
  return <span class={on ? "dot" : "dot dot--off"} aria-hidden="true" />;
}

export function Ago({ t, prefix }: { t: number | null | undefined; prefix?: string }) {
  const now = useNow();
  return <span class="tnum">{prefix}{ago(t, now)}</span>;
}

export function Tag({ children, tone, title }: { children: ComponentChildren; tone?: "ink" | "soft" | "ok"; title?: string }) {
  return <span class={`tag${tone ? ` tag--${tone}` : ""}`} title={title}>{children}</span>;
}

export function Skel({ w = "100%", h = 14, r = 6, class: c }: { w?: number | string; h?: number; r?: number; class?: string }) {
  return <span class={`skel ${c ?? ""}`} style={{ width: typeof w === "number" ? `${w}px` : w, height: `${h}px`, borderRadius: `${r}px` }} aria-hidden="true" />;
}

export function Card({ title, meta, children, class: c, id, flush }: { title?: ComponentChildren; meta?: ComponentChildren; children: ComponentChildren; class?: string; id?: string; flush?: boolean }) {
  return (
    <section class={`card ${flush ? "card--flush " : ""}${c ?? ""}`} id={id}>
      {(title || meta) && (
        <header class="card__head">
          <h2 class="card__title">{title}</h2>
          {meta && <div class="card__meta">{meta}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="empty">
      <p class="empty__title">{title}</p>
      {children && <p class="empty__body">{children}</p>}
      {action && <div class="empty__action">{action}</div>}
    </div>
  );
}
