// The door: a small Archil sandbox that mounts the atoll's disk and runs `atoll serve` from the disk as
// a supervised service. Its port stays private; callers reach it with an Archil port token (sent as
// X-Archil-Token), which Archil checks at its edge and which also wakes the sandbox when it is paused.
// With a short idle TTL the sandbox pauses between requests and costs nothing while paused.
//
// Three rules from the probes shape this file:
// - The disk is mounted conditional. A plain sandbox mount takes the disk's whole write delegation and
//   keeps it while paused, and every object-API write from anywhere else then fails with 409.
// - A running mount doesn't see object-API writes made after it started, so the runtime is written to
//   the disk before the sandbox exists. (A tick runs `archil invalidate-cache` first, and then it does
//   see events delivered through the object API, including while the sandbox was paused.)
// - A paused sandbox wakes when a new connection to it opens, not on a request over a connection that
//   was open before the pause, so callDoor opens a new connection for every request.
// - A sandbox's own `env` reaches the commands you exec in it, but not the services it supervises: a door
//   given a model key that way ran its turns without it. So the service's environment goes in through
//   `archil services create --env`, from a script that reads the values from its exec's own env field.
//   They never appear in a command's text or in what comes back.
//
// The door's network. On a plan that can set a sandbox's network policy, the door is created with one
// that denies everything but the hosts its effects declare. Three things shape that policy, each from
// Archil's description of it and then seen on the live service (9 November 2026, Developer plan):
// - It covers the sandbox's own disk mount. Archil's managed allowlist for the Free plan names
//   mount.*.archil.com and data.*.archil.com, so a policy that denies by default names them too. A door
//   that admits nothing else still serves its disk, and a host it doesn't admit resets the connection.
// - A model key goes into the policy, not the sandbox. Archil sets the key's header on the door's
//   requests to that provider, and the service holds a placeholder in the key's variable, so nothing
//   that runs in the sandbox can read the key. Archil's API gives the policy back with the key in it,
//   so whoever holds the account's API key can read it; that key never goes into a sandbox.
// - Archil rewrites those requests by ending their TLS itself, with a certificate from a CA it installs
//   in the sandbox and names in NODE_EXTRA_CA_CERTS for the commands you exec. A service doesn't get
//   that environment, by the last rule above, so the script that creates the service passes it on.
// A plan that can't set a policy refuses one with 403 sandbox_network_plan_required. The door then comes
// up as it did before: on Archil's managed allowlist, with its keys in the service's definition. That
// path is tested only against a stand-in for Archil.
//
// The port token never goes on the disk or into git: it lives only in ~/.config/atoll/doors.json
// (mode 0600), or wherever ATOLL_DOORS_FILE points.

import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ArchilError, type Archil, type Sandbox, type SandboxEgressRule, type SandboxMountSpec, type SandboxNetwork, type SandboxStatus } from "disk";
import { paths } from "../format.ts";
import { ArchilStore } from "../store/archil.ts";
import { asText } from "../store/types.ts";

/** The door's port inside the sandbox. */
export const DOOR_PORT = 8080;
/** Where the atoll's disk is mounted inside the sandbox. */
export const DOOR_MOUNT = "/mnt/atoll";
export const DEFAULT_TOKEN_TTL = "8760h";
/** Archil's own endpoints for a mounted disk, in every fleet. A door's network policy always admits them. */
export const ARCHIL_ENDPOINTS = ["mount.*.archil.com", "data.*.archil.com"];
/** What the service holds in a key's variable when Archil adds the real key to its requests. */
export const BROKERED = "brokered-by-archil";

/** What a door may reach. It names keys, never their values. */
export interface DoorNetwork {
  /** "declared": everything is denied but `allow`. "managed": the plan can't set a policy, so Archil's allowlist applies. */
  egress: "declared" | "managed";
  /** The hosts the door may reach, besides Archil's own endpoints for its disk. Empty when managed. */
  allow: string[];
  /** The keys Archil adds to the door's requests, so the door doesn't hold them. Empty when managed. */
  brokered: string[];
}

/** `.atoll/door.json` on the disk. It holds no credential. */
export interface DoorRecord {
  sandboxId: string;
  name: string;
  hostname: string;
  port: number;
  createdAt: string;
  /** Absent for a door brought up before doors had a network policy. */
  network?: DoorNetwork;
}

/** A key the door's code sends to one host, such as a model key: its variable, value, host, and the headers that carry it. */
export interface DoorKey {
  name: string;
  value: string;
  host: string;
  headers: Record<string, string>;
}

/** One entry of doors.json, on the machine that brought the door up. */
export interface DoorCredential {
  sandboxId: string;
  diskId: string;
  prefix?: string;
  hostname: string;
  port: number;
  token: string;
  tokenId: string;
  tokenExpiresAt?: string;
  createdAt: string;
}

export interface DoorTarget {
  archil: Archil;
  diskId: string;
  atollName: string;
  /** The atoll's key prefix on the disk, when it doesn't live at the root. */
  prefix?: string;
  /** Default: ATOLL_DOORS_FILE, else ~/.config/atoll/doors.json. */
  doorsFile?: string;
  /** Progress lines, for a CLI. Never receives a credential. */
  log?: (line: string) => void;
}

export interface DoorUpOptions extends DoorTarget {
  /** The runtime bundle (dist/atoll.mjs), copied to .atoll/bin/atoll.mjs on the disk. */
  runtimeBundle: Uint8Array;
  /** Pause after this many idle seconds (default 60). */
  idleTtlSeconds?: number;
  /**
   * Environment for the service. It travels in one exec's env field to a script that hands it to the
   * service's definition, so it is never part of a command's text and never reaches the disk.
   */
  env?: Record<string, string>;
  /**
   * The hosts the door's effects may reach. On a plan that can set a network policy, the door reaches
   * these, the hosts of `keys`, and Archil's endpoints for its disk, and nothing else.
   */
  allow?: string[];
  /**
   * Keys the door's code sends to one host each. On a plan that can set a network policy, Archil adds
   * each to the door's requests to its host and the service holds a placeholder. Otherwise they join `env`.
   */
  keys?: DoorKey[];
  /** The port token's lifetime, a Go duration up to "8760h" (the default). */
  tokenTtl?: string;
  /** The sandbox session's maximum lifetime; the plan's default when omitted. */
  maxTtlSeconds?: number;
  /** How long to wait for the service to answer /healthz (default 60 s). */
  healthTimeoutMs?: number;
}

export interface DoorUpResult extends DoorRecord {
  tokenId: string;
  tokenExpiresAt?: string;
}

export interface DoorInfo extends DoorRecord {
  status: SandboxStatus | "missing";
  /** Whether doors.json on this machine holds a token for it. */
  hasToken: boolean;
  tokenExpiresAt?: string;
}

/** The sandbox name for an atoll's door: "atoll-<name>-door". */
export function doorName(atollName: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?$/.test(atollName)) {
    throw new Error(`Can't name a door for "${atollName}": an atoll name for a door is 1 to 52 lowercase letters, digits and "-", not starting or ending with "-"`);
  }
  return `atoll-${atollName}-door`;
}

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/;

/**
 * The network policy for a door: deny everything except the hosts of `keys` (with each key's headers set
 * on requests to its host), the hosts in `allow`, and Archil's endpoints for the disk. A key's rule comes
 * before every plain host, because the first rule that matches a request decides what happens to it.
 * `skipped` are entries of `allow` that Archil's policies have no form for; a policy takes a host name,
 * a "*." wildcard, or an IPv4 address or range.
 */
export function doorNetwork(allow: string[], keys: DoorKey[]): { network: SandboxNetwork; allow: string[]; skipped: string[] } {
  const headers = new Map<string, Record<string, string>>();
  for (const key of keys) headers.set(key.host, { ...headers.get(key.host), ...key.headers });
  const hosts = [...headers.keys()];
  const skipped: string[] = [];
  for (const entry of allow) {
    const host = entry.trim().toLowerCase();
    if (!HOST.test(host) && !IPV4.test(host)) skipped.push(entry);
    else if (!hosts.includes(host)) hosts.push(host);
  }
  const rules: (string | SandboxEgressRule)[] = hosts.map((host) => (headers.has(host) ? { target: host, transform: { headers: headers.get(host)! } } : host));
  return { network: { egress: { default: "deny", allow: [...rules, ...ARCHIL_ENDPOINTS] } }, allow: hosts, skipped };
}

/** Whether Archil refused a sandbox because the account's plan can't set a network policy. */
function planHasNoPolicies(error: unknown): boolean {
  return error instanceof ArchilError && error.status === 403 && `${error.code ?? ""} ${error.message}`.includes("sandbox_network_plan_required");
}

/**
 * Bring a door up: copy the runtime to the disk, create the sandbox with the disk mounted conditional
 * and a network policy that admits only what its effects declare, start `atoll serve` as a supervised
 * service, wait for /healthz, mint a port token, and record the door on the disk (without the token) and
 * in doors.json (with it). On any failure after the sandbox exists, the sandbox is stopped and deleted
 * before the error is rethrown. No error or log line carries a value from `env` or `keys`.
 */
export async function doorUp(options: DoorUpOptions): Promise<DoorUpResult> {
  const name = doorName(options.atollName);
  const log = options.log ?? (() => {});
  const { archil } = options;
  const existing = await findSandbox(archil, name);
  if (existing) {
    throw new Error(`A door for "${options.atollName}" already exists (sandbox ${existing.id}, ${existing.status}). Take it down first.`);
  }
  const keys = options.keys ?? [];
  const plain = checkEnv({ ...options.env, ...Object.fromEntries(keys.map((key) => [key.name, key.value])) });
  const secrets = Object.values(plain);
  const store = await openStore(options);

  log(`copying the runtime to ${store.location}/${paths.runtimeBin}`);
  await store.put(paths.runtimeBin, options.runtimeBundle);

  const mount: SandboxMountSpec = { disk: options.diskId, path: DOOR_MOUNT, conditional: true };
  if (store.prefix) mount.subdirectory = store.prefix.slice(0, -1);
  const request = {
    name,
    vcpuCount: 1,
    memSizeMiB: 1024,
    idleTtlSeconds: options.idleTtlSeconds ?? 60,
    ...(options.maxTtlSeconds === undefined ? {} : { maxTtlSeconds: options.maxTtlSeconds }),
    mounts: [mount],
  };
  const policy = doorNetwork(options.allow ?? [], keys);
  let network: DoorNetwork = { egress: "declared", allow: policy.allow, brokered: keys.map((key) => key.name) };
  log(`creating sandbox ${name}`);
  let sandbox: Sandbox | undefined;
  try {
    try {
      sandbox = await archil.sandboxes.create({ ...request, network: policy.network }, { wait: false });
    } catch (error) {
      if (!planHasNoPolicies(error)) throw error;
      log("this Archil plan can't set a sandbox's network policy, so the door gets Archil's managed allowlist and holds its own keys");
      network = { egress: "managed", allow: [], brokered: [] };
      sandbox = await archil.sandboxes.create(request, { wait: false });
    }
    if (network.egress === "declared" && policy.skipped.length) {
      log(`left ${policy.skipped.join(", ")} out of the network policy: it takes host names, "*." wildcards, and IPv4 addresses`);
    }
    await waitWhile(sandbox, ["pending"], 120_000);
    if (sandbox.status !== "running") throw new Error(`Sandbox ${name} is ${sandbox.status}${sandbox.exitReason ? ` (${sandbox.exitReason})` : ""}, not running`);

    // With a policy, Archil holds the keys and the service gets a placeholder in each one's variable, so
    // the runner still calls its models and Archil overwrites the header the placeholder travels in.
    const env = network.egress === "declared" ? { ...plain, ...Object.fromEntries(keys.map((key) => [key.name, BROKERED])) } : plain;
    log("starting the atoll service");
    const names = Object.keys(env);
    const service = await sandbox.exec(nodeScript(serviceScript(names)), { timeoutSeconds: 60, ...(names.length ? { env } : {}) });
    const started = lastJsonLine(service.stdout) as { ok?: boolean; env?: string[] | null; ca?: boolean; error?: string } | null;
    if (service.exitCode !== 0 || !started?.ok) {
      throw new Error(`The atoll service didn't start: ${started?.error ?? (service.stderr || service.stdout).trim().slice(0, 600)}`);
    }
    if (Array.isArray(started.env)) {
      const missing = names.filter((key) => !started.env!.includes(key));
      if (missing.length) throw new Error(`The atoll service was created without ${missing.join(", ")}`);
    } else if (names.length) log(`couldn't read the service's environment back to confirm it has ${names.join(", ")}`);
    if (network.brokered.length && started.ca === false) {
      log("the sandbox's environment names no egress CA (NODE_EXTRA_CA_CERTS); if the door's model calls fail on a certificate, that is why");
    }

    log("waiting for /healthz");
    const healthy = await sandbox.exec(nodeScript(healthScript(options.healthTimeoutMs ?? 60_000)), { timeoutSeconds: 120 });
    if (healthy.exitCode !== 0) {
      const logs = await sandbox.exec("archil services logs atoll 2>&1 | tail -n 40", { timeoutSeconds: 30 }).catch(() => null);
      throw new Error(`The atoll service didn't answer /healthz: ${healthy.stdout.trim()}${logs ? `\nService log:\n${logs.stdout.trim()}` : ""}`);
    }

    log("minting a port token");
    const port = await sandbox.createPortToken(DOOR_PORT, { ttl: options.tokenTtl ?? DEFAULT_TOKEN_TTL });
    const record: DoorRecord = { sandboxId: sandbox.id, name, hostname: port.hostname, port: DOOR_PORT, createdAt: new Date().toISOString(), network };
    await store.put(paths.door, `${JSON.stringify(record, null, 2)}\n`);
    const credential: DoorCredential = { sandboxId: sandbox.id, diskId: options.diskId, hostname: port.hostname, port: DOOR_PORT, token: port.token, tokenId: port.id, createdAt: record.createdAt };
    if (store.prefix) credential.prefix = store.prefix.slice(0, -1);
    if (port.expiresAt) credential.tokenExpiresAt = port.expiresAt.toISOString();
    await updateDoors(doorsFile(options), (doors) => {
      doors[name] = credential;
    });
    const result: DoorUpResult = { ...record, tokenId: port.id };
    if (credential.tokenExpiresAt) result.tokenExpiresAt = credential.tokenExpiresAt;
    return result;
  } catch (error) {
    // Archil's answer to a refused request, or a service's log, could echo a key back.
    const safe = redacted(error, secrets);
    if (sandbox) {
      log(`cleaning up sandbox ${name} after: ${safe.message.split("\n")[0]}`);
      await stopAndDelete(sandbox).catch(() => {});
    }
    throw safe;
  }
}

/** Take a door down: stop and delete its sandbox, and forget it on the disk and in doors.json. */
export async function doorDown(target: DoorTarget): Promise<{ removed: boolean; sandboxId?: string }> {
  const name = doorName(target.atollName);
  const store = await openStore(target);
  const record = await readRecord(store);
  let sandbox: Sandbox | null = null;
  if (record) sandbox = await getSandbox(target.archil, record.sandboxId);
  sandbox ??= await findSandbox(target.archil, name);
  if (sandbox) {
    target.log?.(`stopping and deleting sandbox ${sandbox.name}`);
    await stopAndDelete(sandbox);
  }
  if (record) await store.delete(paths.door);
  await updateDoors(doorsFile(target), (doors) => {
    delete doors[name];
  });
  const result: { removed: boolean; sandboxId?: string } = { removed: sandbox !== null || record !== null };
  const id = sandbox?.id ?? record?.sandboxId;
  if (id) result.sandboxId = id;
  return result;
}

/** What the disk and this machine know about a door, and the sandbox's state; null when there is none. */
export async function doorInfo(target: DoorTarget): Promise<DoorInfo | null> {
  const name = doorName(target.atollName);
  const store = await openStore(target);
  let record = await readRecord(store);
  let sandbox = record ? await getSandbox(target.archil, record.sandboxId) : await findSandbox(target.archil, name);
  if (!record && sandbox) record = { sandboxId: sandbox.id, name, hostname: "", port: DOOR_PORT, createdAt: sandbox.createdAt.toISOString() };
  if (!record) return null;
  const credential = (await readDoors(doorsFile(target)))[name];
  const info: DoorInfo = { ...record, status: sandbox?.status ?? "missing", hasToken: credential?.sandboxId === record.sandboxId };
  if (!info.hostname && credential?.hostname) info.hostname = credential.hostname;
  if (credential?.tokenExpiresAt) info.tokenExpiresAt = credential.tokenExpiresAt;
  return info;
}

/**
 * Mint a new port token for a door and make it the one doors.json holds. The previous token keeps
 * working until it expires, unless `revokePrevious` is set. The token is returned to the caller: give it
 * to whatever rings the door (a webhook, a clock), and don't print or store it anywhere else.
 */
export async function doorToken(
  options: DoorTarget & { ttl?: string; revokePrevious?: boolean },
): Promise<{ hostname: string; token: string; tokenId: string; expiresAt?: string }> {
  const name = doorName(options.atollName);
  const store = await openStore(options);
  const record = await readRecord(store);
  const sandbox = record ? await getSandbox(options.archil, record.sandboxId) : await findSandbox(options.archil, name);
  if (!sandbox) throw new Error(`There is no door for "${options.atollName}" to mint a token for.`);
  const file = doorsFile(options);
  const previous = (await readDoors(file))[name];
  const port = await sandbox.createPortToken(DOOR_PORT, { ttl: options.ttl ?? DEFAULT_TOKEN_TTL });
  const credential: DoorCredential = {
    sandboxId: sandbox.id,
    diskId: options.diskId,
    hostname: port.hostname,
    port: DOOR_PORT,
    token: port.token,
    tokenId: port.id,
    createdAt: record?.createdAt ?? new Date().toISOString(),
  };
  if (store.prefix) credential.prefix = store.prefix.slice(0, -1);
  if (port.expiresAt) credential.tokenExpiresAt = port.expiresAt.toISOString();
  await updateDoors(file, (doors) => {
    doors[name] = credential;
  });
  if (options.revokePrevious && previous && previous.sandboxId === sandbox.id && previous.tokenId !== port.id) {
    await sandbox.deletePortToken(previous.tokenId).catch((error: unknown) => {
      if (!(error instanceof ArchilError && error.status === 404)) throw error;
    });
  }
  const result: { hostname: string; token: string; tokenId: string; expiresAt?: string } = { hostname: port.hostname, token: port.token, tokenId: port.id };
  if (credential.tokenExpiresAt) result.expiresAt = credential.tokenExpiresAt;
  return result;
}

/** The hostname and token doors.json holds for an atoll's door, or null. */
export async function readDoorCredential(atollName: string, file?: string): Promise<DoorCredential | null> {
  return (await readDoors(file ?? defaultDoorsFile()))[doorName(atollName)] ?? null;
}

export interface CallDoorOptions {
  /** The door's hostname, or a full base URL ("http://127.0.0.1:8080") for a door served elsewhere. */
  hostname: string;
  /** The Archil port token, sent as X-Archil-Token. */
  token?: string;
  /** A bearer token, for a door started with `serve({token})`. */
  bearer?: string;
  path: string;
  /** JSON to POST; without a body the request is a GET. */
  body?: unknown;
  /** The whole call's deadline, retries included (default 120 s). */
  timeoutMs?: number;
  /** Each attempt's deadline (default 30 s). A paused door answers within about a second of waking. */
  attemptTimeoutMs?: number;
  /** Attempts for a request that is safe to repeat (default 3). Other requests get one. */
  attempts?: number;
}

export interface DoorResponse {
  status: number;
  body: unknown;
  ms: number;
  /** How many attempts it took. */
  attempts: number;
}

/**
 * Call a door, on a new connection every time. Archil wakes a paused sandbox when a connection to it
 * opens: a request on a keep-alive connection opened before the pause got no answer and left the
 * sandbox paused, while the same request on a new connection woke it in under a second (probed
 * 5 November 2026). So this uses node:http(s) without an agent instead of fetch, which reuses
 * connections.
 *
 * A request that fails or hangs before any answer is retried when repeating it is harmless: a GET, a
 * POST /tick, or a POST /events whose event carries its own ID (delivery dedupes by ID). An event
 * without an ID gets one attempt, so it is never delivered twice.
 */
export async function callDoor(options: CallDoorOptions): Promise<DoorResponse> {
  const base = /^https?:\/\//.test(options.hostname) ? options.hostname.replace(/\/+$/, "") : `https://${options.hostname}`;
  const url = new URL(`${base}${options.path.startsWith("/") ? options.path : `/${options.path}`}`);
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token) headers["x-archil-token"] = options.token;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  const post = options.body !== undefined;
  const body = post ? JSON.stringify(options.body) : undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  const hasId = typeof (options.body as { id?: unknown } | undefined)?.id === "string";
  const repeatable = !post || options.path.startsWith("/tick") || hasId;
  const attempts = repeatable ? Math.max(1, options.attempts ?? 3) : 1;
  const started = performance.now();
  const deadline = started + (options.timeoutMs ?? 120_000);
  for (let attempt = 1; ; attempt++) {
    const limit = Math.max(1, Math.floor(Math.min(options.attemptTimeoutMs ?? 30_000, deadline - performance.now())));
    try {
      const answer = await exchange(url, post ? "POST" : "GET", headers, body, limit);
      let parsed: unknown = answer.text;
      if (answer.contentType.includes("json")) {
        try {
          parsed = JSON.parse(answer.text);
        } catch {
          parsed = answer.text;
        }
      }
      return { status: answer.status, body: parsed, ms: performance.now() - started, attempts: attempt };
    } catch (error) {
      const backoff = 300 * attempt;
      if (attempt >= attempts || performance.now() + backoff >= deadline) {
        const code = (error as { code?: string }).code;
        const tries = attempt > 1 ? ` after ${attempt} attempts` : "";
        throw new Error(
          `The door at ${base} didn't answer ${post ? "POST" : "GET"} ${options.path}${tries}: ${error instanceof Error ? error.message : String(error)}${code && !String((error as Error).message).includes(code) ? ` (${code})` : ""}`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

/** One HTTP request on its own connection, with a deadline for the whole exchange. */
function exchange(url: URL, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number): Promise<{ status: number; contentType: string; text: string }> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = send(url, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        finish(() => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), text: Buffer.concat(chunks).toString("utf8") })),
      );
      res.on("error", (error) => finish(() => reject(error)));
    });
    const timer = setTimeout(() => {
      const error = new Error(`no answer within ${timeoutMs} ms`);
      error.name = "TimeoutError";
      finish(() => reject(error));
      req.destroy();
    }, timeoutMs);
    req.on("error", (error) => finish(() => reject(error)));
    req.end(body);
  });
}

// ---- sandboxes ----------------------------------------------------------------------------------------

async function findSandbox(archil: Archil, name: string): Promise<Sandbox | null> {
  const all = await archil.sandboxes.list();
  return all.find((sandbox) => sandbox.name === name && sandbox.status !== "deleted") ?? null;
}

async function getSandbox(archil: Archil, id: string): Promise<Sandbox | null> {
  try {
    const sandbox = await archil.sandboxes.get(id);
    return sandbox.status === "deleted" ? null : sandbox;
  } catch (error) {
    if (error instanceof ArchilError && error.status === 404) return null;
    throw error;
  }
}

async function waitWhile(sandbox: Sandbox, statuses: SandboxStatus[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (statuses.includes(sandbox.status)) {
    if (Date.now() > deadline) throw new Error(`Sandbox ${sandbox.name} stayed ${sandbox.status} for ${Math.round(timeoutMs / 1000)} s`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await sandbox.refresh();
  }
}

/** Stop a sandbox if it is up, then delete it. Deleting a sandbox leaves the disks it mounted alone. */
export async function stopAndDelete(sandbox: Sandbox): Promise<void> {
  await sandbox.refresh();
  if (sandbox.status === "deleted" || sandbox.status === "deleting") return;
  await waitWhile(sandbox, ["pending", "pausing", "stopping"], 120_000);
  if (sandbox.status === "running" || sandbox.status === "paused") {
    await sandbox.stop({ wait: false });
    await waitWhile(sandbox, ["running", "paused", "stopping"], 120_000);
  }
  await sandbox.delete();
}

// ---- doors.json ---------------------------------------------------------------------------------------

type Doors = Record<string, DoorCredential>;

function defaultDoorsFile(): string {
  return process.env.ATOLL_DOORS_FILE ?? join(homedir(), ".config", "atoll", "doors.json");
}

function doorsFile(target: { doorsFile?: string }): string {
  return target.doorsFile ?? defaultDoorsFile();
}

async function readDoors(file: string): Promise<Doors> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = JSON.parse(text) as { doors?: Doors };
  return parsed.doors ?? {};
}

/** Read, change, and rewrite doors.json atomically, with mode 0600 in a 0700 directory. */
async function updateDoors(file: string, change: (doors: Doors) => void): Promise<void> {
  const doors = await readDoors(file);
  change(doors);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, doors }, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}

// ---- helpers ------------------------------------------------------------------------------------------

function openStore(target: DoorTarget): Promise<ArchilStore> {
  return ArchilStore.open(target.prefix === undefined ? { disk: target.diskId, archil: target.archil } : { disk: target.diskId, archil: target.archil, prefix: target.prefix });
}

async function readRecord(store: ArchilStore): Promise<DoorRecord | null> {
  const text = asText(await store.get(paths.door));
  return text ? (JSON.parse(text) as DoorRecord) : null;
}

function checkEnv(env: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name "${key}" for the door`);
  }
  return env;
}

/**
 * Runs in the sandbox: starts `atoll serve` as the supervised service "atoll", with the named variables
 * taken from this process's own environment. It also passes on NODE_EXTRA_CA_CERTS when its environment
 * has one, which is where Archil names the CA it rewrites requests under; a service wouldn't get it
 * otherwise. It prints one JSON line, `{ok, env, ca}` with the names the service was created with (null
 * when Archil's answer doesn't say) and whether there was a CA to pass on, or `{ok: false, error}`. No
 * value is ever printed: errors have them replaced.
 */
export function serviceScript(names: string[]): string {
  const serve = ["node", `${DOOR_MOUNT}/${paths.runtimeBin}`, "serve", "--dir", DOOR_MOUNT, "--mounted", DOOR_MOUNT, "--port", String(DOOR_PORT), "--host", "0.0.0.0"];
  return `
const { spawnSync } = require("node:child_process");
const names = ${JSON.stringify(names)};
const values = names.map((name) => process.env[name] || "");
const scrub = (text) => values.reduce((out, value) => (value ? out.split(value).join("[redacted]") : out), String(text));
const say = (result) => { console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1); };
const absent = names.filter((name) => !process.env[name]);
if (absent.length) say({ ok: false, error: absent.join(", ") + " didn't reach the sandbox" });
const args = ["services", "create", "atoll", "--tcp-port", "${DOOR_PORT}"];
for (const name of names) args.push("--env", name + "=" + process.env[name]);
const ca = names.includes("NODE_EXTRA_CA_CERTS") ? "" : process.env.NODE_EXTRA_CA_CERTS || "";
if (ca) args.push("--env", "NODE_EXTRA_CA_CERTS=" + ca);
args.push("--", ...${JSON.stringify(serve)});
const run = spawnSync("archil", args, { encoding: "utf8" });
if (run.error) say({ ok: false, error: scrub(run.error.message) });
if (run.status !== 0) say({ ok: false, error: "archil services create exited " + run.status + ": " + scrub((run.stderr || run.stdout || "").trim()).slice(-600) });
let env = null;
try {
  const answer = JSON.parse(run.stdout);
  if (answer && typeof answer.env === "object" && answer.env) env = Object.keys(answer.env);
} catch {}
say({ ok: true, env, ca: Boolean(ca) || names.includes("NODE_EXTRA_CA_CERTS") });`;
}

/** The last line of `text` that parses as JSON, or null. */
function lastJsonLine(text: string): unknown {
  for (const line of text.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

/** `text` with every secret replaced, for messages that might echo one. Longer secrets go first, in case one contains another. */
function scrub(text: string, secrets: string[]): string {
  return [...secrets].sort((a, b) => b.length - a.length).reduce((out, value) => (value ? out.split(value).join("[redacted]") : out), text);
}

/** The error itself when its message holds no secret; otherwise a new one that says the same without them. */
function redacted(error: unknown, secrets: string[]): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const message = scrub(original.message, secrets);
  if (message === original.message) return original;
  const clean = new Error(message);
  clean.name = original.name;
  return clean;
}

/** A shell command that runs a JavaScript program with the sandbox's node, without quoting trouble. */
function nodeScript(source: string): string {
  return `node -e "$(printf %s '${Buffer.from(source).toString("base64")}' | base64 -d)"`;
}

function healthScript(timeoutMs: number): string {
  return `
const deadline = Date.now() + ${timeoutMs};
let last = "no answer yet";
(async () => {
  for (;;) {
    try {
      const response = await fetch("http://127.0.0.1:${DOOR_PORT}/healthz", { signal: AbortSignal.timeout(2000) });
      if (response.ok) { console.log("healthy"); process.exit(0); }
      last = "HTTP " + response.status;
    } catch (error) { last = String(error && error.cause ? error.cause.code || error.cause : error); }
    if (Date.now() > deadline) { console.log("no /healthz after ${Math.round(timeoutMs / 1000)} s: " + last); process.exit(1); }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
})();`;
}
