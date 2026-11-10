// The Turn a handler sees. Reads go to the store (and see this turn's own buffered writes); every
// other call is buffered and becomes part of one journal record when the turn commits.

import { childId, derivedUlid, resolveTime, sha256Hex } from "../ids.ts";
import { paths, type AskRecord, type EffectOp, type NoticeOp, type SendOp, type WaitOp } from "../format.ts";
import { asText, dec, enc, type Store } from "../store/types.ts";
import type { AskSpec, EffectRequestOptions, EvidenceMeta, SendOptions, AtollEvent, Turn, WaitSpec } from "../system.ts";

export interface EvidenceItem {
  hex: string;
  bytes: Uint8Array;
  meta: EvidenceMeta & { at: string; size: number };
}

export interface TurnIntents {
  writes: Map<string, Uint8Array | null>;
  sends: SendOp[];
  effects: { name: string; args: unknown; then: string; key: string; id: string }[];
  waits: WaitOp[];
  done?: string;
  asks: AskRecord[];
  notices: NoticeOp[];
  evidence: Map<string, EvidenceItem>;
  notes: string[];
}

/** Resolve a handler's path to a key under the atoll's root. Relative paths are under `base`. */
export function resolvePath(path: string, base: string): string {
  const absolute = path.startsWith("/");
  const segments = (absolute ? [] : base.split("/")).concat(path.split("/"));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) throw new Error(`Path "${path}" leaves the atoll's root`);
      out.pop();
      continue;
    }
    out.push(segment);
  }
  if (out.length === 0) throw new Error(`Path "${path}" names the atoll's root, not a file`);
  return out.join("/");
}

export class TurnContext implements Turn {
  readonly event: AtollEvent;
  readonly self: string;
  readonly part: string;
  readonly instance: string;
  readonly now: Date;
  readonly intents: TurnIntents = {
    writes: new Map(),
    sends: [],
    effects: [],
    waits: [],
    asks: [],
    notices: [],
    evidence: new Map(),
    notes: [],
  };

  private readonly base: string;
  private sendIndex = 0;
  private effectIndex = 0;
  private askIndex = 0;
  private noticeIndex = 0;
  private waitIndex = 0;
  private readonly store: Store;
  private readonly seq: number;
  private readonly atollName: string;

  constructor(
    store: Store,
    seq: number,
    atollName: string,
    event: AtollEvent,
    address: string,
    part: string,
    instance: string,
    now: Date,
  ) {
    this.store = store;
    this.seq = seq;
    this.atollName = atollName;
    this.event = event;
    this.self = address;
    this.part = part;
    this.instance = instance;
    this.now = now;
    this.base = paths.part(address);
  }

  async bytes(path: string): Promise<Uint8Array | null> {
    const key = resolvePath(path, this.base);
    if (this.intents.writes.has(key)) return this.intents.writes.get(key) ?? null;
    return this.store.get(key);
  }

  async read(path: string): Promise<string | null> {
    return asText(await this.bytes(path));
  }

  async json<T = any>(path: string): Promise<T | null> {
    const text = await this.read(path);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
    }
  }

  async readEvidence(ref: string): Promise<string | null> {
    const hex = /^sha256:([0-9a-f]{64})$/.exec(ref)?.[1];
    if (!hex) throw new Error(`Not an evidence reference: "${ref}" (expected sha256:<hex>)`);
    const own = this.intents.evidence.get(hex);
    if (own) return dec.decode(own.bytes);
    return asText(await this.store.get(paths.evidence(hex)));
  }

  async list(dir = ""): Promise<string[]> {
    const key = dir === "" ? this.base : resolvePath(dir, this.base);
    const prefix = `${key}/`;
    const found = new Set((await this.store.list(prefix)).map((e) => e.key));
    for (const [written, bytes] of this.intents.writes) {
      if (!written.startsWith(prefix)) continue;
      if (bytes === null) found.delete(written);
      else found.add(written);
    }
    return [...found].map((k) => k.slice(prefix.length)).sort();
  }

  write(path: string, data: string | Uint8Array | object): void {
    const key = resolvePath(path, this.base);
    let bytes: Uint8Array;
    if (typeof data === "string") bytes = enc.encode(data);
    else if (data instanceof Uint8Array) bytes = data;
    else bytes = enc.encode(`${JSON.stringify(data, null, 2)}\n`);
    this.intents.writes.set(key, bytes);
  }

  delete(path: string): void {
    this.intents.writes.set(resolvePath(path, this.base), null);
  }

  send(to: string, type: string, body: unknown = {}, options: SendOptions = {}): string {
    const index = this.sendIndex++;
    const id = derivedUlid(this.now.getTime(), `${this.atollName}:${this.seq}:send:${index}`);
    this.intents.sends.push({ id, to, type, body: body ?? {}, ...(options.evidence?.length ? { evidence: options.evidence } : {}) });
    return id;
  }

  effect(name: string, args: unknown, options: EffectRequestOptions = {}): string {
    const id = childId("fx", this.seq, this.effectIndex++);
    this.intents.effects.push({
      id,
      name,
      args: args ?? {},
      then: options.then ?? `${name}.done`,
      key: options.key ?? `${this.atollName}:${id}`,
    });
    return id;
  }

  wait(spec: WaitSpec): void {
    if (!spec || (!spec.until && !spec.for && !spec.ask)) throw new Error("t.wait() needs `until`, `for`, or `ask`");
    if (!spec.reason) throw new Error("t.wait() needs a `reason`, a plain sentence saying what it waits for");
    const id = `w${this.seq}.${this.waitIndex++}`;
    const op: WaitOp = { id, reason: spec.reason };
    if (spec.until) op.until = resolveTime(spec.until, this.now).toISOString();
    if (spec.for) op.for = spec.for;
    if (spec.ask) op.ask = spec.ask;
    this.intents.waits.push(op);
  }

  done(reason = "finished"): void {
    this.intents.done = reason;
  }

  ask(spec: AskSpec): string {
    const id = childId("q", this.seq, this.askIndex++);
    const optionIds = new Set((spec.options ?? []).map((o) => o.id));
    if (optionIds.size < 2) throw new Error("t.ask() needs at least two options");
    if (!optionIds.has(spec.default)) throw new Error(`t.ask(): the default "${spec.default}" is not one of the options`);
    if (spec.recommend && !optionIds.has(spec.recommend)) throw new Error(`t.ask(): the recommendation "${spec.recommend}" is not one of the options`);
    for (const option of spec.options) {
      if (!option.consequence) throw new Error(`t.ask(): option "${option.id}" needs a consequence`);
    }
    this.intents.asks.push({
      id,
      from: this.self,
      question: spec.question,
      why: spec.why,
      options: spec.options,
      ...(spec.recommend ? { recommend: spec.recommend } : {}),
      default: spec.default,
      expires: resolveTime(spec.expires, this.now).toISOString(),
      ...(spec.payload !== undefined ? { payload: spec.payload } : {}),
      ...(spec.evidence?.length ? { evidence: spec.evidence } : {}),
      at: this.now.toISOString(),
      cause: this.event.id,
    });
    return id;
  }

  tell(text: string, options: { evidence?: string[] } = {}): void {
    const id = childId("n", this.seq, this.noticeIndex++);
    this.intents.notices.push({ id, text, ...(options.evidence?.length ? { evidence: options.evidence } : {}) });
  }

  evidence(content: string | Uint8Array, meta: EvidenceMeta): string {
    const bytes = typeof content === "string" ? enc.encode(content) : content;
    const hex = sha256Hex(bytes);
    if (!this.intents.evidence.has(hex)) {
      this.intents.evidence.set(hex, { hex, bytes, meta: { ...meta, at: this.now.toISOString(), size: bytes.byteLength } });
    }
    return `sha256:${hex}`;
  }

  note(text: string): void {
    this.intents.notes.push(text);
  }
}

/** Decode a write's bytes for inlining in a journal record. */
export function inlineContent(bytes: Uint8Array): { text: string } | { b64: string } {
  const text = dec.decode(bytes);
  if (enc.encode(text).byteLength === bytes.byteLength && !text.includes("�")) return { text };
  return { b64: Buffer.from(bytes).toString("base64") };
}
