export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

export function glitch(el: HTMLElement | null | undefined) {
  if (!el || reduceMotion.matches || el.classList.contains("is-glitching")) return;
  el.classList.add("is-glitching");
  setTimeout(() => el.classList.remove("is-glitching"), 480);
}
