// Scrubbed decrypt: a redaction bar wipes off left to right while a narrow band of
// glyph noise resolves into the real value. State is a pure function of r (0 = redacted,
// 1 = plain), so scrolling back re-encrypts exactly.
const DIGITS = "0123456789";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";

// noise keeps each character's class, so separators and widths stay put
const noise = (ch: string) => {
  const abc = /\d/.test(ch) ? DIGITS : /[A-Z]/.test(ch) ? UPPER : /[a-z]/.test(ch) ? LOWER : "";
  return abc ? abc[(Math.random() * abc.length) | 0] : ch;
};

export type Decoder = { set(r: number): void; tick(): boolean; readonly el: HTMLElement };

const BAND = 0.32;

export function decoder(el: HTMLElement): Decoder {
  const text = el.textContent ?? "";
  el.textContent = "";
  el.classList.add("dec");
  const real = document.createElement("span"); real.className = "dec__real"; real.textContent = text;
  const fx = document.createElement("span"); fx.className = "dec__fx"; fx.setAttribute("aria-hidden", "true");
  const bar = document.createElement("span"); bar.className = "dec__bar"; bar.setAttribute("aria-hidden", "true");
  el.append(real, fx, bar);
  const n = text.length;
  let r = -1;

  const paint = () => {
    const head = r * (1 + BAND);
    let s = "";
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n, ch = text[i];
      s += x < head - BAND ? ch : x < head ? noise(ch) : ch === " " ? " " : noise(ch);
    }
    fx.textContent = s;
  };

  return {
    el,
    set(v: number) {
      v = Math.min(1, Math.max(0, v));
      if (v === r) return;
      const was = r;
      r = v;
      el.classList.toggle("is-plain", r >= 1);
      el.classList.toggle("is-sealed", r <= 0);
      bar.style.clipPath = r <= 0 ? "" : `inset(0 0 0 ${Math.min(100, r * (1 + BAND) * 100).toFixed(2)}%)`;
      if (r <= 0 || r >= 1) fx.textContent = "";
      else paint();
      if (was <= 0 && r > 0) el.dispatchEvent(new Event("unseal", { bubbles: true }));
    },
    // keep the noise alive while a value sits mid-decode; false once it is settled
    tick() {
      if (r <= 0 || r >= 1) return false;
      paint();
      return true;
    },
  };
}
