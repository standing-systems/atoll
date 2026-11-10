// The declaration an atoll's code exports: its parts, their handlers, and the effects they may request.
// Handlers receive a Turn: reads go to the disk, everything else is buffered and committed as one
// journal record (docs/a-place-to-stand.md, section 7.2).

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** An event in an atoll's inbox. `to` is a part address: "ledger" or "watch/rivetkit". */
export interface AtollEvent<Body = any> {
  id: string;
  type: string;
  to: string;
  /** A part address, "@owner", "@clock", "@door", or the ID of the effect whose result this is. */
  from: string;
  /** The ID of the event whose turn caused this one, if any. */
  cause?: string;
  at: string;
  body: Body;
  /** Evidence references (sha256:<hex>) that support this event. */
  evidence?: string[];
}

export interface WaitSpec {
  /** Wait until a time: a Date, an ISO string, or a duration from now such as "15m", "2h", "3d". */
  until?: Date | string;
  /** Wait for an event of this type addressed to this part. */
  for?: string;
  /** Wait for the answer to an ask (an ID returned by t.ask). */
  ask?: string;
  /** Why, in a plain sentence, e.g. "the registry's answer". */
  reason: string;
}

export interface AskOption {
  id: string;
  label: string;
  /** What happens if the owner picks this option, in a plain sentence. */
  consequence: string;
}

export interface AskSpec {
  question: string;
  why: string;
  options: AskOption[];
  recommend?: string;
  /** The option chosen if nobody answers before `expires`. Required: the owner is never a hard bottleneck. */
  default: string;
  /** When the default applies: a Date, an ISO string, or a duration from now such as "3d". */
  expires: Date | string;
  /** Data the owner may edit before answering, such as a draft. */
  payload?: unknown;
  evidence?: string[];
}

export interface EffectRequestOptions {
  /** The event type the result comes back as. Defaults to "<effect name>.done". */
  then?: string;
  /** An idempotency key. Defaults to one derived from the requesting turn. */
  key?: string;
}

export interface SendOptions {
  evidence?: string[];
}

export interface EvidenceMeta {
  /** Where it came from: a URL, "model:<name>", "exec", "owner", ... */
  source: string;
  /** A media type, e.g. "application/json". */
  type?: string;
}

/** The API a handler sees. One Turn handles exactly one event. */
export interface Turn<Body = any> {
  readonly event: AtollEvent<Body>;
  /** This part instance's address: "watch/rivetkit" or "ledger". */
  readonly self: string;
  readonly part: string;
  /** The instance name, or "" for a singleton part. */
  readonly instance: string;
  /** The turn's time. Replays see the recorded time, so handlers should use this, never Date.now(). */
  readonly now: Date;

  /** Read a file. A relative path is under this part's directory; "/x/y" is from the atoll's root. */
  read(path: string): Promise<string | null>;
  bytes(path: string): Promise<Uint8Array | null>;
  json<T = any>(path: string): Promise<T | null>;
  /** List file paths under a directory, relative to it. */
  list(dir?: string): Promise<string[]>;
  /** Read a receipt by its reference (sha256:<hex>) as text, such as an HTTP body too large to inline. */
  readEvidence(ref: string): Promise<string | null>;

  /** Write a file under this part's directory. Objects are written as JSON. */
  write(path: string, data: string | Uint8Array | object): void;
  delete(path: string): void;

  /** Send an event to a part. Returns the new event's ID. */
  send(to: string, type: string, body?: unknown, options?: SendOptions): string;
  /** Request a declared effect. It runs after this turn commits; its result arrives as an event. Returns its ID. */
  effect(name: string, args: unknown, options?: EffectRequestOptions): string;

  wait(spec: WaitSpec): void;
  /** This instance's work is finished; it waits for nothing. */
  done(reason?: string): void;

  /** Ask the owner a question. Returns the ask's ID. */
  ask(spec: AskSpec): string;
  /** Tell the owner something (a notice). */
  tell(text: string, options?: { evidence?: string[] }): void;
  /** Capture a receipt. Returns its reference, sha256:<hex>. */
  evidence(content: string | Uint8Array, meta: EvidenceMeta): string;
  /** Say why this turn did what it did, for the journal and `atoll why`. */
  note(text: string): void;
}

export type Handler = (t: Turn, event: AtollEvent) => void | Promise<void>;

export interface ScheduleSpec {
  /** A fixed interval: "30s", "15m", "1h", "1d". */
  every?: string;
  /** A five-field cron expression: minute hour day-of-month month day-of-week. */
  cron?: string;
  /** IANA time zone for `cron`; defaults to the system's owner time zone, else UTC. */
  tz?: string;
  /** The event type delivered when it fires. */
  send: string;
  body?: unknown;
}

export interface PartSpec {
  /** What this part does, in the owner's voice: "Tell me about each new version of this package on npm". */
  purpose: string;
  /** One directory per instance under parts/<part>/<instance>/, created by the first event addressed to it. */
  instances?: boolean;
  schedules?: ScheduleSpec[];
  on: Record<string, Handler>;
}

export type EffectKind = "http" | "exec" | "model" | "notify" | "custom";

export interface BudgetSpec {
  /** Dollars per period (models). */
  usd?: number;
  /** Calls per period (any effect). */
  calls?: number;
  per: "day" | "month";
}

export interface EffectContext {
  /** The effect's ID, e.g. "fx42.0". */
  id: string;
  /** Its idempotency key. Pass it to remote APIs that accept one. */
  key: string;
  now: Date;
  /** Capture a receipt for the result. */
  evidence(content: string | Uint8Array, meta: EvidenceMeta): string;
}

export interface EffectSpec {
  kind: EffectKind;
  /** Wait for the owner's approval before running, and run once with exactly the approved arguments. */
  approval?: boolean;
  /** Safe to retry after an interruption. Defaults to true for http GET/HEAD and notify, false otherwise. */
  idempotent?: boolean;
  budget?: BudgetSpec;
  /**
   * The hosts it may reach: exact names, or "*.example.com" for a name's subdomains. An http effect must
   * list them, and the runner checks every request against them. A door's network policy admits the hosts
   * that any effect lists and no others, so a custom or exec effect that reaches the network from a door
   * lists them too.
   */
  allow?: string[];
  /** exec: the directory the command's mount is limited to. Defaults to "workspace". */
  scope?: string;
  /** exec: run on a branch and merge back only if nothing else wrote the same files. */
  fork?: boolean;
  /** model: "stand-in", "anthropic/<model>", or "openai/<model>". */
  model?: string;
  /** model: the most one call may cost, used for budgets when a price is unknown. */
  maxUsd?: number;
  /**
   * model: a deterministic answer used when no model is configured (and in tests). Receives the request's
   * arguments and returns what the model's JSON answer would be. The result says it came from a stand-in.
   */
  standIn?: (args: any) => unknown;
  /** For approvals: a plain sentence saying what running it will do. */
  describe?: (args: any) => string;
  /** custom: the code that performs it, run by the trusted runner. */
  run?: (args: any, ctx: EffectContext) => Promise<unknown> | unknown;
}

export interface SystemSpec {
  name: string;
  /** What the atoll is for, in the owner's words. Written to CHARTER.md when the atoll has none. */
  charter?: string;
  owner?: { name?: string; timezone?: string };
  parts: Record<string, PartSpec>;
  effects?: Record<string, EffectSpec>;
}

/** Declare an atoll. Returns the spec unchanged; it exists for types and as the module's default export. */
export function defineSystem<const S extends SystemSpec>(spec: S): S {
  return spec;
}

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const PART = /^[a-z][a-z0-9-]{0,62}$/;
const EVENT_TYPE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const EFFECT = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
export const INSTANCE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED_TYPES = new Set(["timer", "ask.answered", "ask.expired"]);

export interface SpecProblem {
  code: string;
  message: string;
  where: string;
}

/** Structural checks on a declaration. `atoll check` reports these; the runner refuses a spec with any. */
export function validateSystem(spec: SystemSpec): SpecProblem[] {
  const problems: SpecProblem[] = [];
  const add = (code: string, where: string, message: string) => problems.push({ code, where, message });
  if (!spec || typeof spec !== "object") return [{ code: "NOT_A_SYSTEM", where: "default export", message: "The module's default export is not an atoll declaration" }];
  if (!NAME.test(spec.name ?? "")) add("BAD_NAME", "name", `"${spec.name}" must be lowercase letters, digits, and hyphens, starting with a letter`);
  const parts = Object.entries(spec.parts ?? {});
  if (parts.length === 0) add("NO_PARTS", "parts", "An atoll needs at least one part");
  for (const [name, part] of parts) {
    const where = `parts.${name}`;
    if (!PART.test(name)) add("BAD_PART_NAME", where, `Part name "${name}" must be lowercase letters, digits, and hyphens`);
    if (!part.purpose || part.purpose.trim().length < 8) add("NO_PURPOSE", where, "Every part needs a purpose, written as a plain sentence in the owner's voice");
    const handlers = Object.entries(part.on ?? {});
    if (handlers.length === 0) add("NO_HANDLERS", where, "A part needs at least one handler in `on`");
    for (const [type, handler] of handlers) {
      if (!EVENT_TYPE.test(type)) add("BAD_EVENT_TYPE", `${where}.on.${type}`, `Event type "${type}" must be dotted lowercase words`);
      if (typeof handler !== "function") add("NOT_A_HANDLER", `${where}.on.${type}`, "Handlers must be functions");
    }
    for (const [i, s] of (part.schedules ?? []).entries()) {
      const sw = `${where}.schedules[${i}]`;
      if (!s.every === !s.cron) add("BAD_SCHEDULE", sw, "A schedule needs exactly one of `every` or `cron`");
      if (!s.send || !(part.on ?? {})[s.send]) add("SCHEDULE_UNHANDLED", sw, `The schedule sends "${s.send}", which this part has no handler for`);
    }
    for (const type of Object.keys(part.on ?? {})) {
      if (RESERVED_TYPES.has(type)) continue;
    }
  }
  for (const [name, effect] of Object.entries(spec.effects ?? {})) {
    const where = `effects.${name}`;
    if (!EFFECT.test(name)) add("BAD_EFFECT_NAME", where, `Effect name "${name}" must be dotted lowercase words`);
    if (!["http", "exec", "model", "notify", "custom"].includes(effect.kind)) add("BAD_EFFECT_KIND", where, `Unknown effect kind "${String(effect.kind)}"`);
    if (effect.kind === "custom" && typeof effect.run !== "function") add("CUSTOM_WITHOUT_RUN", where, "A custom effect needs a `run` function");
    if (effect.kind === "http" && (!effect.allow || effect.allow.length === 0)) add("HTTP_WITHOUT_ALLOW", where, "An http effect must list the hosts it may reach in `allow`");
    if (effect.budget && !effect.budget.usd && !effect.budget.calls) add("EMPTY_BUDGET", where, "A budget needs `usd` or `calls`");
    if (effect.budget && effect.budget.per !== "day" && effect.budget.per !== "month") add("BAD_BUDGET_PERIOD", where, "A budget's `per` is \"day\" or \"month\"");
  }
  return problems;
}

/** The hosts a system's effects list in `allow`, in the order declared, each once. */
export function declaredHosts(spec: SystemSpec): string[] {
  const hosts = new Set<string>();
  for (const effect of Object.values(spec.effects ?? {})) for (const host of effect.allow ?? []) hosts.add(host);
  return [...hosts];
}

/** Split "watch/rivetkit" into its part and instance. */
export function parseAddress(address: string): { part: string; instance: string } | null {
  const [part, instance = "", ...rest] = address.split("/");
  if (!part || rest.length > 0 || !PART.test(part)) return null;
  if (instance && !INSTANCE.test(instance)) return null;
  return { part, instance };
}

/** The directory under the atoll's root that a part instance owns. */
export function partDir(address: string): string {
  return `parts/${address}`;
}
