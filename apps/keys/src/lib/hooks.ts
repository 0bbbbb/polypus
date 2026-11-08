import { useEffect, useRef, useState } from "preact/hooks";

const clockSubs = new Set<(t: number) => void>();
let clockTimer = 0;
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    clockSubs.add(setNow);
    if (!clockTimer) clockTimer = window.setInterval(() => { const t = Date.now(); clockSubs.forEach(f => f(t)); }, 1000);
    return () => {
      clockSubs.delete(setNow);
      if (!clockSubs.size) { clearInterval(clockTimer); clockTimer = 0; }
    };
  }, []);
  return now;
}

export type Async<T> = { data: T | null; error: Error | null; loading: boolean; reload: () => void };

export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  const keyRef = useRef<string>("");
  useEffect(() => {
    const ctl = new AbortController();
    const key = JSON.stringify(deps[0] ?? null);
    if (key !== keyRef.current) { setData(null); keyRef.current = key; }
    setLoading(true);
    fn(ctl.signal)
      .then(d => { if (!ctl.signal.aborted) { setData(d); setError(null); } })
      .catch(e => { if (!ctl.signal.aborted) setError(e instanceof Error ? e : new Error(String(e))); })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => ctl.abort();
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN(x => x + 1) };
}

export function useMedia(q: string): boolean {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, [q]);
  return m;
}
