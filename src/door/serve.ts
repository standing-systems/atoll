// The door's HTTP API: what `atoll serve` runs, in a sandbox or on any machine. The runtime functions
// are passed in, so this module knows nothing about the runner. Routes:
//
//   GET  /healthz   200 "ok", no auth (the sandbox supervisor and doorUp poll it)
//   GET  /status    the five answers
//   POST /events    deliver one event from "@door", tick, and answer {id, duplicate, report}
//   POST /tick      tick, and answer the report
//
// With `token` set, every route but /healthz needs `Authorization: Bearer <token>`. Behind an Archil
// port token the sandbox edge already authenticates callers (X-Archil-Token); the bearer token is for
// doors served anywhere else. Ticks are serialized in this process, and a request that arrives while a
// tick is waiting to start shares that tick, since it will see the request's event.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FiveAnswers, TickReport } from "../runtime/types.ts";
import type { Store } from "../store/types.ts";

/** An event as the door receives it. `from` is always "@door", whatever the caller sends. */
export interface DoorEvent {
  to: string;
  type: string;
  body?: unknown;
  id?: string;
  cause?: string;
  from?: string;
}

export interface ServeOptions {
  store: Store;
  port: number;
  /** Default 127.0.0.1. A sandbox needs 0.0.0.0, because Archil's edge connects from outside the guest. */
  host?: string;
  /** Require `Authorization: Bearer <token>` on everything but /healthz. */
  token?: string;
  tick(): Promise<TickReport>;
  deliver(event: DoorEvent): Promise<{ id: string; duplicate: boolean }>;
  status(): Promise<FiveAnswers>;
  /** One line per request; default console.log. Never receives bodies or credentials. */
  log?: (line: string) => void;
}

export interface DoorServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** Stop accepting requests, finish the ones in flight, and wait for the current tick. */
  close(): Promise<void>;
}

/** The largest request body the door reads. Events larger than this belong in evidence or a file. */
export const MAX_BODY_BYTES = 1024 * 1024;

const ROUTES: Record<string, string[]> = {
  "/healthz": ["GET", "HEAD"],
  "/status": ["GET"],
  "/events": ["POST"],
  "/tick": ["POST"],
};

export async function serve(options: ServeOptions): Promise<DoorServer> {
  const host = options.host ?? "127.0.0.1";
  const log = options.log ?? ((line: string) => console.log(line));
  const ticks = new TickQueue(options.tick);
  const expected = options.token ? digest(options.token) : null;

  const server = createServer((req, res) => {
    const started = performance.now();
    res.on("finish", () => log(`${req.method} ${pathOf(req)} ${res.statusCode} ${Math.round(performance.now() - started)}ms`));
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) send(res, statusOf(error), { error: messageOf(error) });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = pathOf(req);
    const method = req.method ?? "GET";
    if (path === "/healthz" && (method === "GET" || method === "HEAD")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(method === "HEAD" ? undefined : "ok");
      return;
    }
    if (expected && !authorized(req, expected)) {
      drain(req);
      res.setHeader("www-authenticate", 'Bearer realm="atoll door"');
      send(res, 401, { error: "unauthorized" });
      return;
    }
    const allowed = ROUTES[path];
    if (!allowed) {
      drain(req);
      send(res, 404, { error: `no route ${path}` });
      return;
    }
    if (!allowed.includes(method)) {
      drain(req);
      res.setHeader("allow", allowed.join(", "));
      send(res, 405, { error: `${path} accepts ${allowed.join(", ")}` });
      return;
    }

    if (path === "/status") {
      send(res, 200, await options.status());
      return;
    }
    if (path === "/tick") {
      drain(req);
      send(res, 200, await ticks.request());
      return;
    }
    // POST /events
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw === null) {
      send(res, 413, { error: `request bodies are limited to ${MAX_BODY_BYTES} bytes` }, { close: true });
      return;
    }
    const parsed = parseEvent(raw);
    if (typeof parsed === "string") {
      send(res, 400, { error: parsed });
      return;
    }
    const delivered = await options.deliver(parsed);
    const report = await ticks.request();
    send(res, 200, { id: delivered.id, duplicate: delivered.duplicate, report });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const shownHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  log(`atoll door serving ${options.store.location} on http://${shownHost}:${address.port}`);

  return {
    server,
    host: address.address,
    port: address.port,
    url: `http://${shownHost}:${address.port}`,
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await ticks.idle();
      // Requests in flight finish with their ticks; drop whatever connections are left after that.
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), 2000);
      await closed;
      clearTimeout(timer);
    },
  };
}

/**
 * Runs ticks one at a time. A caller that arrives while a tick is queued but not yet started joins it:
 * that tick starts after the caller's event was delivered, so it will handle it. A caller that arrives
 * while a tick is running queues the next one.
 */
export class TickQueue {
  private readonly tick: () => Promise<TickReport>;
  private tail: Promise<unknown> = Promise.resolve();
  private pending: Promise<TickReport> | null = null;

  constructor(tick: () => Promise<TickReport>) {
    this.tick = tick;
  }

  request(): Promise<TickReport> {
    if (this.pending) return this.pending;
    const run = this.tail.then(() => {
      this.pending = null;
      return this.tick();
    });
    this.pending = run;
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Resolves when no tick is running or queued. */
  async idle(): Promise<void> {
    let tail;
    do {
      tail = this.tail;
      await tail;
    } while (tail !== this.tail);
  }
}

function parseEvent(raw: Buffer): DoorEvent | string {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return "the body must be a JSON object: {to, type, body?, id?, cause?}";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "the body must be a JSON object: {to, type, body?, id?, cause?}";
  const input = value as Record<string, unknown>;
  for (const field of ["to", "type"] as const) {
    if (typeof input[field] !== "string" || input[field] === "") return `"${field}" must be a non-empty string`;
  }
  for (const field of ["id", "cause"] as const) {
    if (input[field] !== undefined && (typeof input[field] !== "string" || input[field] === "")) return `"${field}" must be a non-empty string when given`;
  }
  const event: DoorEvent = { to: input.to as string, type: input.type as string, from: "@door" };
  if (input.body !== undefined) event.body = input.body;
  if (input.id !== undefined) event.id = input.id as string;
  if (input.cause !== undefined) event.cause = input.cause as string;
  return event;
}

/**
 * The body, or null when it is larger than `limit`. An oversized body is read and discarded, so the
 * client gets its 413 instead of a reset connection; past 8 times the limit the connection is dropped.
 */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit * 8) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > limit * 8) {
      req.destroy();
      return null;
    }
    if (size <= limit) chunks.push(buffer);
  }
  return size > limit ? null : Buffer.concat(chunks);
}

/** Discard a body we won't read, so the connection can be reused. */
function drain(req: IncomingMessage): void {
  req.resume();
}

function authorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization;
  const match = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match !== null && timingSafeEqual(digest(match[1]!), expected);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function send(res: ServerResponse, status: number, value: unknown, options: { close?: boolean } = {}): void {
  const body = JSON.stringify(value);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
  };
  if (options.close) headers.connection = "close";
  res.writeHead(status, headers);
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const query = url.indexOf("?");
  const path = query >= 0 ? url.slice(0, query) : url;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** A thrown error's HTTP status: its own `status` if it is 4xx or 5xx, else 500. */
function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
