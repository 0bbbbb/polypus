import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { EquityPoint } from "../api/types";
import { date, dateTime, pct } from "../lib/format";

function extent(points: EquityPoint[]) {
  let lo = 0, hi = 0;
  for (const p of points) { lo = Math.min(lo, p.bps); hi = Math.max(hi, p.bps); }
  if (hi - lo < 50) { hi += 25; lo -= 25; }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad] as const;
}

export function Sparkline({ points, w = 128, h = 36 }: { points: EquityPoint[]; w?: number; h?: number }) {
  if (points.length < 2) return <svg class="spark spark--empty" width={w} height={h} aria-hidden="true"><line x1="0" x2={w} y1={h / 2} y2={h / 2} /></svg>;
  const [lo, hi] = extent(points);
  const t0 = points[0]!.t, t1 = points[points.length - 1]!.t || t0 + 1;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (w - 4) + 2;
  const y = (b: number) => h - 2 - ((b - lo) / (hi - lo)) * (h - 4);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.bps).toFixed(1)}`).join("");
  const last = points[points.length - 1]!;
  return (
    <svg class={`spark${last.bps < 0 ? " is-neg" : ""}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <line class="spark__zero" x1="0" x2={w} y1={y(0)} y2={y(0)} />
      <path d={`${d}L${x(last.t)} ${h}L${x(t0)} ${h}Z`} class="spark__area" />
      <path d={d} class="spark__line" />
      <circle cx={x(last.t)} cy={y(last.bps)} r="2.25" class="spark__end" />
    </svg>
  );
}

export function EquityChart({ points, height = 280 }: { points: EquityPoint[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (points.length < 2 || !w) return null;
    const padR = 56, padT = 16, padB = 28;
    const [lo, hi] = extent(points);
    const t0 = points[0]!.t, t1 = points[points.length - 1]!.t;
    const iw = w - padR, ih = height - padT - padB;
    const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * iw;
    const y = (b: number) => padT + (1 - (b - lo) / (hi - lo)) * ih;
    const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(2)} ${y(p.bps).toFixed(2)}`).join("");
    const step = niceStep((hi - lo) / 4);
    const yt: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) yt.push(v);
    const xt = [0, 1, 2, 3].map(i => t0 + ((t1 - t0) * i) / 3);
    return { d, x, y, iw, padT, padB, yt, xt, lo, hi };
  }, [points, w, height]);

  const onMove = (ev: PointerEvent) => {
    if (!geo || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const px = Math.max(0, Math.min(geo.iw, ev.clientX - r.left));
    let best = 0, bd = Infinity;
    points.forEach((p, i) => { const dd = Math.abs(geo.x(p.t) - px); if (dd < bd) { bd = dd; best = i; } });
    setHover(best);
  };

  const hp = hover != null ? points[hover] : null;
  const last = points[points.length - 1];

  return (
    <div class="chart" ref={box} style={{ height: `${height}px` }} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
      {!geo ? (
        <div class={points.length < 2 && w ? "chart__empty" : "chart__empty skel"}>{points.length < 2 && w ? "Not enough statement points yet" : ""}</div>
      ) : (
        <>
          <svg width={w} height={height} class="chart__svg" aria-label={`Equity curve, ${last ? pct(last.bps) : ""}`}>
            <defs>
              <linearGradient id="eqfill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stop-color="#0b0b0c" stop-opacity="0.07" />
                <stop offset="1" stop-color="#0b0b0c" stop-opacity="0" />
              </linearGradient>
            </defs>
            {geo.yt.map(v => (
              <g key={v}>
                <line class={v === 0 ? "chart__zero" : "chart__grid"} x1="0" x2={geo.iw} y1={geo.y(v)} y2={geo.y(v)} />
                <text class="chart__yl" x={w - 4} y={geo.y(v) + 4} text-anchor="end">{pct(v, true, Math.abs(v) < 100 && v !== 0 ? 1 : 0)}</text>
              </g>
            ))}
            {geo.xt.map((t, i) => (
              <text key={t} class="chart__xl" x={geo.x(t)} y={height - 8} text-anchor={i === 0 ? "start" : i === 3 ? "end" : "middle"}>{date(t)}</text>
            ))}
            <path class="chart__area" d={`${geo.d}L${geo.x(points[points.length - 1]!.t)} ${height - geo.padB}L0 ${height - geo.padB}Z`} fill="url(#eqfill)" />
            <path class="chart__line" d={geo.d} />
            {last && !hp && <circle class="chart__end" cx={geo.x(last.t)} cy={geo.y(last.bps)} r="3.5" />}
            {hp && (
              <g>
                <line class="chart__cross" x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={geo.padT - 8} y2={height - geo.padB} />
                <circle class="chart__dot" cx={geo.x(hp.t)} cy={geo.y(hp.bps)} r="4" />
              </g>
            )}
          </svg>
          {hp && (
            <div class="chart__tip" style={{ left: `${Math.min(Math.max(geo.x(hp.t), 64), geo.iw - 64)}px`, top: "0px" }}>
              <b class="tnum">{pct(hp.bps)}</b>
              <span>{dateTime(hp.t)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
