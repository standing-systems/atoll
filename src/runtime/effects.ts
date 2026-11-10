// Performing effects. Only the trusted runner calls these, after the requesting turn has committed.

import { execFile } from "node:child_process";
import { commandEnv } from "../command-env.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "../ids.ts";
import { monthOf, dayOf, paths, type OutboxEntry } from "../format.ts";
import { LocalStore } from "../store/local.ts";
import { enc, hasHands, type Hands, type Snapshots, type Store } from "../store/types.ts";
import type { BudgetSpec, EffectSpec, EvidenceMeta } from "../system.ts";
import { readJson } from "./install.ts";
import type { EvidenceItem } from "./turn.ts";
import { modelKey, ModelUnavailable } from "./models.ts";
import type { EffectStub, ModelProvider } from "./types.ts";

export class MissingStub extends Error {
  constructor(name: string) {
    super(`Effect "${name}" ran in a test without a stub. Pass one in testAtoll(system, { stubs: { "${name}": ... } }).`);
    this.name = "MissingStub";
  }
}

export interface EffectEnv {
  store: Store;
  hands?: Hands;
  snapshots?: Snapshots;
  stubs?: Record<string, EffectStub>;
  stubsOnly?: boolean;
  models: ModelProvider;
  fetch: typeof fetch;
  now: () => Date;
  env: Record<string, string | undefined>;
}

export interface Outcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  evidence: EvidenceItem[];
  cost?: { usd?: number; calls?: number };
  changed?: { added: string[]; modified: string[]; deleted: string[] };
  /** For forked exec: what to merge into the main atoll, or, with `keep`, the branch to leave it on. */
  merge?: { branch: string; checkpoint: string; changed: { added: string[]; modified: string[]; deleted: string[] }; base: Record<string, string | null>; scope: string; keep?: boolean };
}

function captured(content: string | Uint8Array, meta: EvidenceMeta, now: Date): EvidenceItem {
  const bytes = typeof content === "string" ? enc.encode(content) : content;
  const hex = sha256Hex(bytes);
  return { hex, bytes, meta: { ...meta, at: now.toISOString(), size: bytes.byteLength } };
}

/** The fields of `value` at the given dotted paths, as a nested object. Missing paths are left out. */
export function pick(value: unknown, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = String(field).split(".");
    let cursor: unknown = value;
    for (const part of parts) cursor = cursor !== null && typeof cursor === "object" ? (cursor as Record<string, unknown>)[part] : undefined;
    if (cursor === undefined) continue;
    let target = out;
    for (const part of parts.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
    target[parts.at(-1)!] = cursor;
  }
  return out;
}

/** HTTP bodies up to this size are inlined in the result event; larger ones only in evidence. */
export const HTTP_INLINE_LIMIT = 16 * 1024;

export function defaultIdempotent(spec: EffectSpec, args: any): boolean {
  if (spec.idempotent !== undefined) return spec.idempotent;
  if (spec.kind === "http") return ["GET", "HEAD"].includes(String(args?.method ?? "GET").toUpperCase());
  return spec.kind === "notify";
}

function hostAllowed(url: URL, allow: string[]): boolean {
  return allow.some((pattern) => (pattern.startsWith("*.") ? url.hostname.endsWith(pattern.slice(1)) : url.hostname === pattern));
}

/** Calls and dollars spent on effects named `name` in the period containing `now`. */
export async function usage(store: Store, name: string, per: BudgetSpec["per"], now: Date): Promise<{ calls: number; usd: number }> {
  const meter = (await readJson<{ effects: Record<string, { name: string; at: string; usd?: number; calls?: number }> }>(store, paths.meter(monthOf(now)))) ?? { effects: {} };
  let calls = 0;
  let usd = 0;
  for (const entry of Object.values(meter.effects)) {
    if (entry.name !== name) continue;
    if (per === "day" && dayOf(entry.at) !== dayOf(now)) continue;
    calls += entry.calls ?? 0;
    usd += entry.usd ?? 0;
  }
  return { calls, usd };
}

/** Would running one more of this effect exceed its budget? Returns a sentence saying how, or null. */
export async function overBudget(store: Store, entry: OutboxEntry, spec: EffectSpec, now: Date): Promise<string | null> {
  const budget = spec.budget;
  if (!budget) return null;
  const used = await usage(store, entry.name, budget.per, now);
  const period = budget.per === "day" ? "today" : "this month";
  if (budget.calls !== undefined && used.calls + 1 > budget.calls) return `${entry.name} has used ${used.calls} of its ${budget.calls} calls ${period}`;
  if (budget.usd !== undefined) {
    const estimate = spec.kind === "model" ? (spec.maxUsd ?? 0.02) : 0;
    if (used.usd + estimate > budget.usd) return `${entry.name} has spent $${used.usd.toFixed(4)} of its $${budget.usd.toFixed(2)} ${period}`;
  }
  return null;
}

// A wrapper run around exec commands: it lists the files under the scope before and after, runs the
// command, and prints one JSON line with the output and the changes. Node exists in Archil's exec image.
// It doesn't look into directories the effect ignores: hashing an installed node_modules through the
// mount took 18 s each way for 10,000 files (probed 9 November 2026), and nobody reads that list.
const WRAPPER = String.raw`
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const cmd = Buffer.from(process.argv[1], "base64").toString("utf8");
const ignore = new Set(JSON.parse(Buffer.from(process.argv[2] || "W10=", "base64").toString("utf8")));
function manifest(dir) {
  const out = {};
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!ignore.has(e.name)) walk(p); }
      else if (e.isFile()) { try { out[path.relative(dir, p)] = createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch {} }
    }
  };
  walk(dir);
  return out;
}
const dir = process.cwd();
const before = manifest(dir);
const r = spawnSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const after = manifest(dir);
const added = [], modified = [], deleted = [];
for (const k of Object.keys(after)) { if (!(k in before)) added.push(k); else if (before[k] !== after[k]) modified.push(k); }
for (const k of Object.keys(before)) if (!(k in after)) deleted.push(k);
const base = {};
for (const k of [...added, ...modified, ...deleted]) base[k] = k in before ? before[k] : null;
const cap = (s) => (s || "").length > 1048576 ? { text: s.slice(-1048576), truncated: true } : { text: s || "", truncated: false };
const o = cap(r.stdout), e = cap(r.stderr);
process.stdout.write("\n__ATOLL__" + JSON.stringify({ exitCode: r.status === null ? 128 : r.status, stdout: o.text, stderr: e.text, truncated: o.truncated || e.truncated, changed: { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() }, base }));
`;

function wrapCommand(command: string, ignore: string[] = []): string {
  const b64 = Buffer.from(command, "utf8").toString("base64");
  const script = Buffer.from(WRAPPER, "utf8").toString("base64");
  return `node -e "$(printf %s ${script} | base64 -d)" ${b64} ${Buffer.from(JSON.stringify(ignore), "utf8").toString("base64")}`;
}

interface Wrapped {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  changed: { added: string[]; modified: string[]; deleted: string[] };
  /** For each changed path, its SHA-256 before the command ran (null if it didn't exist). */
  base: Record<string, string | null>;
}

function unwrap(stdout: string, stderr: string, exitCode: number): Wrapped {
  const marker = stdout.lastIndexOf("\n__ATOLL__");
  if (marker < 0) {
    return { exitCode, stdout, stderr: stderr || "the command wrapper produced no result", truncated: stdout.includes("[output truncated]"), changed: { added: [], modified: [], deleted: [] }, base: {} };
  }
  return JSON.parse(stdout.slice(marker + "\n__ATOLL__".length)) as Wrapped;
}

/** Run a command on the local machine against a LocalStore's directory (development without Archil). */
async function localExec(store: LocalStore, command: string, scope: string, ignore: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const dir = join(store.root, ...scope.split("/"));
  await mkdir(dir, { recursive: true });
  return new Promise((resolve) => {
    execFile("sh", ["-c", wrapCommand(command, ignore)], { cwd: dir, env: commandEnv(), maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as any).code === "number" ? (error as any).code : 0;
      resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function perform(entry: OutboxEntry, spec: EffectSpec, env: EffectEnv): Promise<Outcome> {
  const now = env.now();
  const args = entry.args as any;
  const stub = env.stubs?.[entry.name];
  if (stub) {
    try {
      const result = await stub(args, { id: entry.id, key: entry.key, now });
      return { ok: true, result, evidence: [captured(JSON.stringify(result ?? null), { source: `stub:${entry.name}`, type: "application/json" }, now)], cost: { calls: 1 } };
    } catch (error) {
      return { ok: false, error: (error as Error).message, evidence: [], cost: { calls: 1 } };
    }
  }
  // In tests every effect needs a stub, except a model effect with a stand-in: that is deterministic and
  // local, and exists for exactly this.
  if (env.stubsOnly && !(spec.kind === "model" && spec.standIn)) throw new MissingStub(entry.name);

  switch (spec.kind) {
    case "http": {
      let url: URL;
      try {
        url = new URL(String(args?.url));
      } catch {
        return { ok: false, error: `Not a URL: ${String(args?.url)}`, evidence: [] };
      }
      if (!hostAllowed(url, spec.allow ?? [])) return { ok: false, error: `${url.hostname} is not in this effect's allow list`, evidence: [] };
      try {
        const response = await env.fetch(url, {
          method: args?.method ?? "GET",
          headers: args?.headers,
          body: args?.body === undefined ? undefined : typeof args.body === "string" ? args.body : JSON.stringify(args.body),
          signal: AbortSignal.timeout(30_000),
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const type = response.headers.get("content-type") ?? "application/octet-stream";
        const text = new TextDecoder().decode(bytes.subarray(0, 262_144));
        let json: unknown;
        if (type.includes("json") || Array.isArray(args?.pick)) {
          try {
            json = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            json = undefined;
          }
        }
        const evidence = captured(bytes, { source: url.toString(), type }, now);
        // `pick` keeps only the named fields (dotted paths) of a JSON answer in the result; the evidence
        // always keeps the whole body.
        const picked = Array.isArray(args?.pick) && json !== undefined ? pick(json, args.pick as string[]) : undefined;
        if (picked !== undefined) json = picked;
        // Bodies are journaled with the result event, so only small ones are inlined. A larger body is
        // in the evidence: read it with t.readEvidence(result.body).
        const inline = picked !== undefined || bytes.byteLength <= HTTP_INLINE_LIMIT;
        return {
          ok: true,
          result: {
            status: response.status,
            headers: { "content-type": type, etag: response.headers.get("etag"), "last-modified": response.headers.get("last-modified") },
            ...(inline ? (json !== undefined ? { json } : { text }) : { tooLarge: true }),
            body: `sha256:${evidence.hex}`,
            bytes: bytes.byteLength,
          },
          evidence: [evidence],
          cost: { calls: 1 },
        };
      } catch (error) {
        return { ok: false, error: `Request to ${url.hostname} failed: ${(error as Error).message}`, evidence: [], cost: { calls: 1 } };
      }
    }
    case "exec": {
      const command = String(args?.command ?? "");
      if (!command) return { ok: false, error: "An exec effect needs a `command`", evidence: [] };
      const scope = spec.scope ?? "workspace";
      const ignore = spec.ignore ?? [];
      if (spec.fork) return forkedExec(entry, command, scope, env, now, { ignore, keep: spec.merge === false });
      let raw: { exitCode: number; stdout: string; stderr: string };
      if (env.hands) raw = await env.hands.exec({ command: wrapCommand(command, ignore), scope });
      else if (env.store instanceof LocalStore) raw = await localExec(env.store, command, scope, ignore);
      else if (hasHands(env.store)) raw = await env.store.exec({ command: wrapCommand(command, ignore), scope });
      else return { ok: false, error: "This runner has no hands for exec effects", evidence: [] };
      const w = unwrap(raw.stdout, raw.stderr, raw.exitCode);
      const evidence = captured(JSON.stringify({ command, exitCode: w.exitCode, stdout: w.stdout, stderr: w.stderr }), { source: "exec", type: "application/json" }, now);
      return {
        ok: w.exitCode === 0,
        result: { exitCode: w.exitCode, stdout: w.stdout.slice(-65_536), stderr: w.stderr.slice(-65_536), truncated: w.truncated, changed: w.changed },
        ...(w.exitCode === 0 ? {} : { error: `exit ${w.exitCode}: ${w.stderr.trim().split("\n").slice(-3).join(" ")}` }),
        evidence: [evidence],
        cost: { calls: 1 },
        changed: w.changed,
      };
    }
    case "model": {
      // A stand-in answers when stand-ins are forced, or when this runner has no key for the model.
      const key = modelKey(spec.model);
      const useStandIn = Boolean(spec.standIn) && (env.stubsOnly === true || env.models.name === "stand-in" || !key || !env.env[key]);
      if (useStandIn) {
        const json = spec.standIn!(args);
        const text = JSON.stringify(json);
        return {
          ok: true,
          result: { json, text, model: "stand-in", standIn: true },
          evidence: [captured(text, { source: "model:stand-in", type: "application/json" }, now)],
          cost: { calls: 1, usd: 0 },
        };
      }
      if (!spec.model) return { ok: false, error: "This model effect names no `model` and has no stand-in", evidence: [] };
      try {
        const response = await env.models.complete({
          model: spec.model,
          prompt: String(args?.prompt ?? ""),
          ...(args?.system ? { system: String(args.system) } : {}),
          ...(args?.schema ? { schema: args.schema } : {}),
          maxTokens: Number(args?.maxTokens ?? 4096),
        });
        const usd = response.costUsd ?? spec.maxUsd ?? 0.02;
        return {
          ok: response.json !== undefined || !args?.schema,
          result: { json: response.json, text: response.text, model: response.model, usage: response.usage, standIn: response.standIn ?? false },
          ...(args?.schema && response.json === undefined ? { error: "The model's answer was not valid JSON" } : {}),
          evidence: [captured(response.text, { source: `model:${response.model}`, type: "text/plain" }, now)],
          cost: { calls: 1, usd },
        };
      } catch (error) {
        // ModelUnavailable is thrown before any request goes out, so it costs nothing against a budget.
        return { ok: false, error: (error as Error).message, evidence: [], ...(error instanceof ModelUnavailable ? {} : { cost: { calls: 1 } }) };
      }
    }
    case "notify": {
      const url = env.env.ATOLL_NOTIFY_URL;
      const text = String(args?.text ?? "");
      if (!url) return { ok: true, result: { delivered: false, reason: "ATOLL_NOTIFY_URL is not set; the notice is on the disk only" }, evidence: [] };
      try {
        const response = await env.fetch(url, { method: "POST", body: text, headers: { "content-type": "text/plain", ...(args?.title ? { title: String(args.title) } : {}) }, signal: AbortSignal.timeout(15_000) });
        return { ok: response.ok, result: { delivered: response.ok, status: response.status }, evidence: [], cost: { calls: 1 } };
      } catch (error) {
        return { ok: false, error: (error as Error).message, evidence: [], cost: { calls: 1 } };
      }
    }
    case "custom": {
      if (!spec.run) return { ok: false, error: "A custom effect needs `run`", evidence: [] };
      const evidence: EvidenceItem[] = [];
      try {
        const result = await spec.run(args, {
          id: entry.id,
          key: entry.key,
          now,
          evidence: (content, meta) => {
            const item = captured(content, meta, now);
            evidence.push(item);
            return `sha256:${item.hex}`;
          },
        });
        return { ok: true, result, evidence, cost: { calls: 1 } };
      } catch (error) {
        return { ok: false, error: (error as Error).message, evidence, cost: { calls: 1 } };
      }
    }
  }
}

/**
 * exec with fork: checkpoint, branch, run on the branch, and report what to merge back. With `keep`,
 * nothing is merged: the command's changes stay on the branch, and the main atoll's files are as they
 * were, so the outcome claims no changes to them.
 */
async function forkedExec(entry: OutboxEntry, command: string, scope: string, env: EffectEnv, now: Date, options: { ignore: string[]; keep: boolean }): Promise<Outcome> {
  if (!env.snapshots) return { ok: false, error: "This runner can't fork the disk (no checkpoints or branches here)", evidence: [] };
  const safe = entry.id.replace(/[^A-Za-z0-9_-]/g, "-");
  const checkpoint = `atoll-${safe}-${now.getTime()}`;
  await env.snapshots.checkpoint(checkpoint);
  const branch = await env.snapshots.branch(`atoll-${safe}`, checkpoint);
  const branchStore = await env.snapshots.open(branch.id);
  if (!hasHands(branchStore)) return { ok: false, error: "The branch has no hands for exec", evidence: [] };
  const raw = await branchStore.exec({ command: wrapCommand(command, options.ignore), scope });
  const w = unwrap(raw.stdout, raw.stderr, raw.exitCode);
  const evidence = captured(JSON.stringify({ command, branch: branch.id, exitCode: w.exitCode, stdout: w.stdout, stderr: w.stderr }), { source: `exec:${branch.id}`, type: "application/json" }, now);
  return {
    ok: w.exitCode === 0,
    result: { exitCode: w.exitCode, stdout: w.stdout.slice(-65_536), stderr: w.stderr.slice(-65_536), truncated: w.truncated, changed: w.changed, branch: branch.id, checkpoint },
    ...(w.exitCode === 0 ? {} : { error: `exit ${w.exitCode} on branch ${branch.id}` }),
    evidence: [evidence],
    cost: { calls: 2 },
    ...(options.keep ? {} : { changed: w.changed }),
    merge: { branch: branch.id, checkpoint, changed: w.changed, base: w.base ?? {}, scope, ...(options.keep ? { keep: true } : {}) },
  };
}
