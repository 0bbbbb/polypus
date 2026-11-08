import {
  API_BASE,
  type ActivityItem,
  type DemoSubscribeRequest,
  type DemoSubscribeResponse,
  type GuardrailsUpdateRequest,
  type GuardrailsUpdateResponse,
  type HealthView,
  type IntentsQuote,
  type IntentsStatus,
  type NotifyRequest,
  type Portfolio,
  type Prices,
  type ProofView,
  type ProvisionRequest,
  type ProvisionResponse,
  type StreamEvent,
  type Timeline,
  type TraderDetail,
  type TraderSummary,
  type TxRef,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
  get offline() {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Local API unreachable", 0);
  }
  const text = await res.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch {}
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; retryAfterSec?: number };
    const retry = d.retryAfterSec ?? (Number(res.headers.get("retry-after")) || undefined);
    throw new ApiError(d.error ?? `HTTP ${res.status}`, data === undefined && res.status >= 500 ? 502 : res.status, retry);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  health: (s?: AbortSignal) => request<HealthView>("GET", "/health", undefined, s),
  traders: (s?: AbortSignal) => request<TraderSummary[]>("GET", "/traders", undefined, s),
  trader: (account: string, s?: AbortSignal) => request<TraderDetail>("GET", `/traders/${enc(account)}`, undefined, s),
  prices: (s?: AbortSignal) => request<Prices>("GET", "/prices", undefined, s),
  portfolio: (follower: string, s?: AbortSignal) => request<Portfolio>("GET", `/portfolio/${enc(follower)}`, undefined, s),
  timeline: (follower: string, trader: string, s?: AbortSignal) =>
    request<Timeline>("GET", `/timeline?follower=${enc(follower)}&trader=${enc(trader)}`, undefined, s),
  intents: (s?: AbortSignal) => request<IntentsStatus>("GET", "/intents", undefined, s),
  quote: (trader: string, pay: string, s?: AbortSignal) => request<IntentsQuote>("GET", `/quote?trader=${enc(trader)}&pay=${enc(pay)}`, undefined, s),
  activity: (s?: AbortSignal) => request<ActivityItem[]>("GET", "/activity", undefined, s),
  proof: (s?: AbortSignal) => request<ProofView>("GET", "/proof", undefined, s),
  provision: (req: ProvisionRequest) => request<ProvisionResponse>("POST", "/agent/provision", req),
  notify: (req: NotifyRequest) => request<{ ok: true; tx: TxRef }>("POST", "/subscriptions/notify", req),
  demoSubscribe: (req: DemoSubscribeRequest) => request<DemoSubscribeResponse>("POST", "/demo/subscribe", req),
  guardrails: (req: GuardrailsUpdateRequest) => request<GuardrailsUpdateResponse>("POST", "/guardrails", req),
};

export type StreamStatus = "connecting" | "open" | "closed";

const EVENT_TYPES: StreamEvent["type"][] = ["activity", "traders", "timeline", "portfolio"];

export function openStream(
  follower: string | null,
  onEvent: (e: StreamEvent) => void,
  onStatus?: (s: StreamStatus) => void,
): () => void {
  let es: EventSource | null = null;
  let closed = false, retry = 0, timer = 0;
  const url = `${API_BASE}/stream${follower ? `?follower=${enc(follower)}` : ""}`;

  const connect = () => {
    if (closed) return;
    onStatus?.("connecting");
    es = new EventSource(url);
    es.onopen = () => { retry = 0; onStatus?.("open"); };
    es.onerror = () => {
      es?.close();
      es = null;
      if (closed) return;
      onStatus?.("closed");
      const wait = Math.min(15000, 1000 * 2 ** retry++);
      timer = window.setTimeout(connect, wait);
    };
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, ev => {
        try {
          const data = JSON.parse((ev as MessageEvent<string>).data);
          if (Array.isArray(data)) onEvent({ type: "traders", traders: data });
          else onEvent(data && data.type === type ? data : ({ type, ...data } as StreamEvent));
        } catch {}
      });
    }
  };
  connect();
  return () => { closed = true; clearTimeout(timer); es?.close(); };
}
