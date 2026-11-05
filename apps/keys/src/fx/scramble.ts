// Text scramble/decode. The real text keeps the layout (hidden while decoding) and the
// scrambled copy is overlaid, so labels never reflow or shift.
import { charsetFor, prefixOf } from "./formats";

export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

type State = { real: HTMLSpanElement; fx: HTMLSpanElement; raf: number };
const states = new WeakMap<HTMLElement, State>();

function prep(el: HTMLElement): State {
  let s = states.get(el);
  if (s) return s;
  const text = el.textContent ?? "";
  el.textContent = "";
  el.classList.add("scr");
  const real = document.createElement("span"); real.className = "scr__real"; real.textContent = text;
  const fx = document.createElement("span"); fx.className = "scr__fx"; fx.setAttribute("aria-hidden", "true");
  el.append(real, fx);
  s = { real, fx, raf: 0 };
  states.set(el, s);
  return s;
}

export function scramble(el: HTMLElement, duration = 700, from?: string) {
  const s = prep(el);
  const target = s.real.textContent ?? "";
  cancelAnimationFrame(s.raf);
  if (reduceMotion.matches) { s.fx.textContent = ""; s.real.classList.remove("is-hidden"); return; }
  const start = performance.now();
  const n = target.length;
  // glyph noise stays inside the value's own alphabet (base58 or bech32), and typed prefixes never scramble
  const glyphs = charsetFor(target), keep = prefixOf(target).length;
  // each character resolves at its own time, left to right with jitter
  const at = [...target].map((_, i) => (i / Math.max(1, n)) * 0.7 + Math.random() * 0.3);
  let lastSwap = 0, cache = "";
  s.real.classList.add("is-hidden");
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    if (now - lastSwap > 45 || t >= 1) {
      lastSwap = now;
      let html = "";
      for (let i = 0; i < n; i++) {
        const ch = target[i];
        if (ch === " " || ch === "…" || i < keep || t >= at[i]) html += ch === "<" ? "&lt;" : ch === "&" ? "&amp;" : ch;
        else if (from && t < at[i] * 0.4 && from[i]) html += from[i];
        else html += `<i>${glyphs[(Math.random() * glyphs.length) | 0]}</i>`;
      }
      cache = html;
      s.fx.innerHTML = cache;
    }
    if (t < 1) s.raf = requestAnimationFrame(step);
    else { s.fx.textContent = ""; s.real.classList.remove("is-hidden"); }
  };
  s.raf = requestAnimationFrame(step);
}

// swap to new text with a decode. The element reflows once (to the final text) — used for
// labels inside fixed-size slots.
export function scrambleTo(el: HTMLElement, text: string, duration = 320) {
  const s = prep(el);
  const prev = s.real.textContent ?? "";
  if (prev === text) return;
  s.real.textContent = text;
  scramble(el, duration, prev);
}
