import { decoder } from "./decode.js";

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Seal every [data-dec] cell under `container`; returns a function that wipes them open. */
export function sealCells(container: HTMLElement): () => Promise<void> {
  const decs = [...container.querySelectorAll<HTMLElement>("[data-dec]")].map(el => decoder(el));
  decs.forEach(d => d.set(0));
  return () => decryptAll(decs);
}

function decryptAll(decs: ReturnType<typeof decoder>[], duration = 650, stagger = 140): Promise<void> {
  if (reduce.matches || !decs.length) {
    decs.forEach(d => d.set(1));
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const start = performance.now();
    const loop = (now: number) => {
      let done = true;
      decs.forEach((d, i) => {
        const r = (now - start - i * stagger) / duration;
        d.set(r);
        if (r < 1) {
          done = false;
          d.tick();
        }
      });
      if (done) resolve();
      else requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
