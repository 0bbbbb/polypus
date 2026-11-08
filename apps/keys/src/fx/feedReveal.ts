import { decoder } from "./decode.js";

/** When unlocked, streak-decrypt feed cells (scroll-friendly decode animation). */
export function revealFeed(container: HTMLElement, unlocked: boolean): void {
  const els = [...container.querySelectorAll<HTMLElement>("[data-dec]")];
  const decs = els.map(el => decoder(el));
  decs.forEach(d => d.set(0));
  if (!unlocked) return;

  let tick = 0;
  const loop = () => {
    let active = false;
    for (const d of decs) {
      if (d.tick()) active = true;
    }
    if (active) requestAnimationFrame(loop);
  };

  const run = (stagger: number) => {
    decs.forEach((d, i) => {
      window.setTimeout(() => {
        d.set(1);
        if (i === 0) requestAnimationFrame(loop);
      }, stagger * i);
    });
  };

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  run(reduce.matches ? 0 : 100);
}
