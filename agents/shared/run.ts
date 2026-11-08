import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { RUN_DIR } from "./config.js";

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export const runFile = (name: string) => path.join(RUN_DIR, name);

export function logger(tag: string) {
  const color = { trader: 33, follower: 36, attestor: 35, api: 32, seed: 34 }[tag] ?? 37;
  const prefix = `\x1b[${color}m${tag.padEnd(8)}\x1b[0m`;
  return {
    info: (...a: unknown[]) => console.log(prefix, ...a),
    warn: (...a: unknown[]) => console.warn(prefix, "\x1b[33mwarn\x1b[0m", ...a),
    error: (...a: unknown[]) => console.error(prefix, "\x1b[31merror\x1b[0m", ...a),
  };
}

export async function readBody<T>(req: http.IncomingMessage, max = 16_384): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(data);
}

export type Route = (req: http.IncomingMessage, url: URL) => Promise<unknown> | unknown;

export function serve(
  port: number,
  routes: Record<string, Route>,
  fallback?: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>,
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (fallback && (await fallback(req, res, url))) return;
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, "not found");
      sendJson(res, 200, await handler(req, url));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const extra = e instanceof HttpError ? e.extra : {};
      if (!res.headersSent) sendJson(res, status, { error: String((e as Error)?.message ?? e).slice(0, 400), ...extra });
      else res.end();
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

export async function getJson<T>(url: string, timeoutMs = 4000): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export async function postJson<T>(url: string, data: unknown, timeoutMs = 60_000): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new HttpError(r.status, body.error ?? `HTTP ${r.status}`, body as Record<string, unknown>);
  return body;
}
