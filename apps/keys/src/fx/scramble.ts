import { useEffect, useRef, useState } from "preact/hooks";
import { charsetFor, prefixOf } from "./formats";
import { reduceMotion } from "./glitch";

export function useScramble(text: string, play: boolean, duration = 700, delay = 0): string | null {
  const [fx, setFx] = useState<string | null>(play && !reduceMotion.matches ? noiseAll(text) : null);
  const raf = useRef(0);

  useEffect(() => {
    if (!play || reduceMotion.matches) { setFx(null); return; }
    const n = text.length, glyphs = charsetFor(text), keep = prefixOf(text).length;
    const at = [...text].map((_, i) => (i / Math.max(1, n)) * 0.7 + Math.random() * 0.3);
    let start = 0, last = 0;
    const step = (now: number) => {
      if (!start) start = now + delay;
      const t = Math.max(0, Math.min(1, (now - start) / duration));
      if (now - last > 45 || t >= 1) {
        last = now;
        if (t >= 1) { setFx(null); return; }
        let s = "";
        for (let i = 0; i < n; i++) {
          const ch = text[i];
          s += ch === " " || ch === "…" || ch === "." || ch === "," || i < keep || t >= at[i] ? ch : glyphs[(Math.random() * glyphs.length) | 0];
        }
        setFx(s);
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [text, play]);

  return fx;
}

function noiseAll(text: string) {
  const g = charsetFor(text);
  return [...text].map(c => (c === " " ? c : g[(Math.random() * g.length) | 0])).join("");
}
