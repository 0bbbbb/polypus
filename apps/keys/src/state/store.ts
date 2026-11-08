import { useEffect, useReducer, useRef } from "preact/hooks";
import { api, ApiError, openStream, type StreamStatus } from "../api/client";
import type { ActivityItem, HealthView, Portfolio, StreamEvent, Timeline, TraderSummary, TxRef } from "../api/types";

export type Identity = { kind: "wallet"; account: string } | { kind: "demo"; account: string };

export type State = {
  health: HealthView | null;
  traders: TraderSummary[] | null;
  activity: ActivityItem[] | null;
  offline: boolean;
  stream: StreamStatus;
  identity: Identity | null;
  wallet: string | null;
  portfolio: Portfolio | null;
  portfolioError: string | null;
  timelines: Record<string, Timeline>;
  walletModal: boolean;
  tick: number;
  notice: Notice | null;
};

export type Notice = { id: number; text: string; kind: "ok" | "error"; tx?: TxRef };

const ID_KEY = "polypus.identity";
export const DEMO_ACCOUNT = "carol-18e5.testnet";

function loadIdentity(): Identity | null {
  try {
    const v = JSON.parse(localStorage.getItem(ID_KEY) ?? "null");
    if (v && (v.kind === "wallet" || v.kind === "demo") && typeof v.account === "string") return v;
  } catch {}
  return null;
}

let state: State = {
  health: null,
  traders: null,
  activity: null,
  offline: false,
  stream: "connecting",
  identity: loadIdentity(),
  wallet: null,
  portfolio: null,
  portfolioError: null,
  timelines: {},
  walletModal: false,
  tick: 0,
  notice: null,
};

let noticeTimer = 0;
export function notify(text: string, kind: Notice["kind"] = "ok", tx?: TxRef) {
  clearTimeout(noticeTimer);
  setState({ notice: { id: Date.now(), text, kind, tx } });
  noticeTimer = window.setTimeout(() => setState({ notice: null }), kind === "error" ? 9000 : 6000);
}

const subs = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  subs.forEach(f => f());
}

export function useStore<T>(sel: (s: State) => T): T {
  const ref = useRef(sel);
  ref.current = sel;
  const [, force] = useReducer((x: number) => x + 1, 0);
  const last = useRef<T>(sel(state));
  useEffect(() => {
    const f = () => {
      const v = ref.current(state);
      if (v !== last.current) { last.current = v; force(0); }
    };
    subs.add(f);
    f();
    return () => { subs.delete(f); };
  }, []);
  const v = sel(state);
  last.current = v;
  return v;
}

export const tlKey = (follower: string, trader: string) => `${follower}|${trader}`;

export function setIdentity(id: Identity | null) {
  try {
    if (id) localStorage.setItem(ID_KEY, JSON.stringify(id));
    else localStorage.removeItem(ID_KEY);
  } catch {}
  const changed = id?.account !== state.identity?.account;
  setState({ identity: id, ...(changed ? { portfolio: null, portfolioError: null } : {}) });
  if (changed) { refreshPortfolio(); restartStream(); }
}

const markOnline = () => state.offline && setState({ offline: false });
const handle = (e: unknown) => {
  if (e instanceof ApiError && e.offline) setState({ offline: true });
};

export async function refreshHealth() {
  try { setState({ health: await api.health() }); markOnline(); } catch (e) { handle(e); }
}
export async function refreshTraders() {
  try { setState({ traders: await api.traders() }); markOnline(); } catch (e) { handle(e); }
}
export async function refreshActivity() {
  try { setState({ activity: await api.activity() }); } catch (e) { handle(e); }
}

let pfSeq = 0;
export async function refreshPortfolio() {
  const who = state.identity?.account;
  if (!who) { setState({ portfolio: null }); return; }
  const seq = ++pfSeq;
  try {
    const p = await api.portfolio(who);
    if (seq !== pfSeq || state.identity?.account !== who) return;
    const timelines = { ...state.timelines };
    for (const k of p.keys) {
      const key = tlKey(p.follower, k.trader);
      if (!timelines[key] || progress(k.timeline) >= progress(timelines[key]!)) timelines[key] = k.timeline;
    }
    setState({ portfolio: p, portfolioError: null, timelines });
  } catch (e) {
    handle(e);
    if (seq === pfSeq) setState({ portfolioError: e instanceof Error ? e.message : String(e) });
  }
}

export async function refreshTimeline(follower: string, trader: string) {
  try {
    const t = await api.timeline(follower, trader);
    if (t.steps.every(s => s.status === "waiting")) return;
    setState(s => ({ timelines: { ...s.timelines, [tlKey(follower, trader)]: t } }));
  } catch (e) { handle(e); }
}

const rank = { waiting: 0, active: 1, error: 1, done: 2 } as const;
export const progress = (t: Timeline) => t.steps.reduce((n, s) => n + rank[s.status], 0) + (t.complete ? 1 : 0);

let closeStream: (() => void) | null = null;
let pfTimer = 0;

function onEvent(e: StreamEvent) {
  switch (e.type) {
    case "activity":
      setState(s => {
        const list = s.activity ?? [];
        if (list.some(a => a.id === e.item.id)) return {};
        return { activity: [e.item, ...list].slice(0, 40) };
      });
      break;
    case "traders":
      setState({ traders: e.traders });
      break;
    case "timeline":
      setState(s => ({ timelines: { ...s.timelines, [tlKey(e.timeline.follower, e.timeline.trader)]: e.timeline } }));
      if (e.timeline.follower === state.identity?.account) schedulePortfolio();
      break;
    case "portfolio":
      if (e.follower === state.identity?.account) schedulePortfolio();
      setState(s => ({ tick: s.tick + 1 }));
      break;
  }
}

function schedulePortfolio() {
  clearTimeout(pfTimer);
  pfTimer = window.setTimeout(refreshPortfolio, 250);
}

export function restartStream() {
  closeStream?.();
  closeStream = openStream(state.identity?.account ?? null, onEvent, s => {
    setState({ stream: s });
    if (s === "open") { refreshTraders(); refreshActivity(); refreshPortfolio(); }
  });
}

let booted = false;
export function boot() {
  if (booted) return;
  booted = true;
  refreshHealth();
  refreshTraders();
  refreshActivity();
  refreshPortfolio();
  restartStream();
  setInterval(refreshTraders, 10_000);
  setInterval(refreshHealth, 10_000);
  setInterval(() => {
    const p = state.portfolio;
    if (state.stream !== "open" && p && p.keys.some(k => !k.timeline.complete)) refreshPortfolio();
  }, 4000);
}
