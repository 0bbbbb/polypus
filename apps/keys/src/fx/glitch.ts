import { reduceMotion } from "./scramble";

// RGB channel split + slice displacement (CSS keyframes in styles.css); this only toggles it.
export function glitch(el: HTMLElement) {
  if (reduceMotion.matches || el.classList.contains("is-glitching")) return;
  el.classList.add("is-glitching");
  setTimeout(() => el.classList.remove("is-glitching"), 480);
}

export function prepLogo(el: HTMLElement) {
  const svg = el.querySelector("svg");
  if (!svg || el.children.length > 1) return;
  for (const cls of ["lg-c", "lg-y"]) {
    const c = svg.cloneNode(true) as SVGElement;
    c.classList.add(cls);
    el.append(c);
  }
}

// glitch on hover (throttled) and once when first revealed
export function bindGlitch(el: HTMLElement, { onReveal = true, hoverTarget = el } = {}) {
  let lastHover = 0;
  hoverTarget.addEventListener("pointerenter", () => {
    const now = performance.now();
    if (now - lastHover > 1200) { lastHover = now; glitch(el); }
  });
  if (onReveal) {
    const io = new IntersectionObserver(es => {
      if (es[0].isIntersecting) { io.disconnect(); setTimeout(() => glitch(el), 700); }
    }, { threshold: 0.6 });
    io.observe(el);
  }
}
