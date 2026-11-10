// The runner: one tick takes the lease, recovers, applies answers and due timers, handles the inbox
// one event at a time (each a committed turn), runs effects, rewrites STATUS.md, and lets the lease go.

import { hostname } from "node:os";
import { derivedUlid, nonce, parseDuration, ulid, resolveTime, sha256Hex } from "../ids.ts";
import {
  dayOf,
  paths,
  type AskRecord,
  type EffectOp,
  type EffectRecord,
  type JournalRecord,
  type OutboxEntry,
  type TurnRecord,
  type WaitOp,
  type WaitingFile,
  type WriteOp,
} from "../format.ts";
import { asText, type Store } from "../store/types.ts";
import { parseAddress, validateSystem, type EffectSpec, type PartSpec, type ScheduleSpec, type AtollEvent, type SystemSpec } from "../system.ts";
import { defaultIdempotent, MissingStub, overBudget, perform, type EffectEnv, type Outcome } from "./effects.ts";
import { install, readJson, readTimers, timerEventId, type InstallCache, type WaitTyper } from "./install.ts";
import { Journal, readHead, readJournal } from "./journal.ts";
import { Lease } from "./lease.ts";
import { HttpModels } from "./models.ts";
import { nextFire } from "./schedule.ts";
import { inlineContent, TurnContext, type EvidenceItem } from "./turn.ts";
import type { TickOptions, TickReport } from "./types.ts";
import { loadCurrentSystem, currentCodeVersion } from "./code.ts";
import { renderStatus } from "./status.ts";

const INLINE_LIMIT = 32 * 1024;
/** An effect result larger than this, serialized, is delivered as a pointer to its evidence. */
const RESULT_INLINE_LIMIT = 64 * 1024;
const MAX_ATTEMPTS = 3;
/** How long a handled event's ID is remembered, so a redelivery within it is a duplicate. */
export const SEEN_RETENTION_MS = 30 * 86_400_000;
const PRUNED_AT = ".atoll/seen-pruned-at";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const INBOX_KEY = /^inbox\/([0-9A-HJKMNP-TV-Z]{26})\.json$/;

export { timerEventId };

function emptyReport(epoch: number): TickReport {
  return {
    ran: true,
    epoch,
    turns: 0,
    failures: 0,
    duplicates: 0,
    effects: { done: 0, failed: 0, inDoubt: 0, awaitingApproval: 0, overBudget: 0 },
    timersFired: 0,
    answersApplied: 0,
    recovered: { reinstalled: 0, stagingCleared: 0, inDoubt: 0 },
    remaining: 0,
    nextWake: null,
    lastSeq: 0,
  };
}

export class Runner {
  readonly report: TickReport;
  readonly journal: Journal;
  readonly env: EffectEnv;
  readonly typer: WaitTyper;
  private readonly failedThisTick = new Set<string>();
  /** Files only this runner writes while it holds the lease, cached for the tick. */
  readonly cache: InstallCache;
  private startSeq = 0;
  readonly store: Store;
  readonly system: SystemSpec;
  readonly code: string;
  readonly lease: Lease;
  readonly options: TickOptions;
  readonly now: () => Date;

  constructor(store: Store, system: SystemSpec, code: string, lease: Lease, options: TickOptions, now: () => Date) {
    this.store = store;
    this.system = system;
    this.code = code;
    this.lease = lease;
    this.options = options;
    this.now = now;
    this.cache = { code };
    this.report = emptyReport(lease.epoch);
    this.journal = new Journal(store, lease.epoch, () => lease.fence());
    this.env = {
      store,
      ...(options.hands ? { hands: options.hands } : {}),
      ...(options.snapshots ? { snapshots: options.snapshots } : {}),
      ...(options.stubs ? { stubs: options.stubs } : {}),
      ...(options.stubsOnly ? { stubsOnly: true } : {}),
      // Real providers by default. An effect whose key isn't set answers with its stand-in, or fails if it has none.
      models: options.models ?? new HttpModels(),
      fetch: options.fetch ?? fetch,
      now,
      env: process.env,
    };
    this.typer = (address, wait) => {
      if (wait.schedule === undefined) return { type: "timer", body: { reason: wait.reason } };
      const part = this.partOf(address);
      const schedule = part?.schedules?.[wait.schedule];
      return schedule ? { type: schedule.send, ...(schedule.body !== undefined ? { body: schedule.body } : {}) } : { type: "timer", body: { reason: wait.reason } };
    };
  }

  private partOf(address: string): PartSpec | undefined {
    const parsed = parseAddress(address);
    return parsed ? this.system.parts[parsed.part] : undefined;
  }

  get atollName(): string {
    return this.system.name;
  }

  /** Append a record and install it. */
  async record(record: JournalRecord): Promise<JournalRecord> {
    const committed = await this.journal.append(record);
    await install(this.store, committed, this.typer, this.cache);
    this.report.lastSeq = committed.seq;
    this.options.onRecord?.(committed);
    return committed;
  }

  private base(kind: JournalRecord["kind"]) {
    return { v: 1 as const, kind, seq: this.journal.nextSeq(), epoch: this.lease.epoch, at: this.now().toISOString() };
  }

  // ---- recovery -----------------------------------------------------------------------------------

  async recover(): Promise<void> {
    const head = await readHead(this.store);
    const read = await readJournal(this.store, head?.day ? previousDay(head.day) : undefined);
    const last = read.records.at(-1);
    this.journal.lastSeq = Math.max(last?.seq ?? 0, head?.seq ?? 0);
    const installed = head?.installed ?? 0;
    for (const record of read.records) {
      if (record.seq <= installed) continue;
      await install(this.store, record, this.typer, this.cache);
      this.report.recovered.reinstalled += 1;
    }
    // Everything committed is installed now, so any staging left belongs to turns that never committed.
    for (const entry of await this.store.list(paths.stagingPrefix)) {
      await this.store.delete(entry.key);
      this.report.recovered.stagingCleared += 1;
    }
    this.report.lastSeq = this.journal.lastSeq;
    this.startSeq = this.journal.lastSeq;
  }

  // ---- asks ---------------------------------------------------------------------------------------

  async applyAsks(): Promise<void> {
    const entries = await this.store.list(paths.asksPrefix);
    const open = entries.map((e) => /^asks\/([^/]+)\.json$/.exec(e.key)?.[1]).filter((id): id is string => Boolean(id) && !id!.endsWith(".answer"));
    for (const id of open) {
      const ask = await readJson<AskRecord>(this.store, paths.ask(id));
      if (!ask) continue;
      const answer = await readJson<{ option?: string; payload?: unknown }>(this.store, paths.askAnswer(id)).catch(() => null);
      const now = this.now();
      if (answer?.option && ask.options.some((o) => o.id === answer.option)) {
        await this.resolveAsk(ask, answer.option, answer.payload ?? ask.payload, "owner");
      } else if (new Date(ask.expires).getTime() <= now.getTime()) {
        await this.resolveAsk(ask, ask.default, ask.payload, "expiry");
      }
    }
  }

  private async resolveAsk(ask: AskRecord, option: string, payload: unknown, by: "owner" | "expiry"): Promise<void> {
    this.report.answersApplied += 1;
    if (ask.effect) {
      await this.record({ ...this.base("answer"), kind: "answer", ask: ask.id, option, ...(payload !== undefined ? { payload } : {}), by } as JournalRecord);
      await this.resolveEffectAsk(ask, option, payload);
      return;
    }
    const type = by === "owner" ? "ask.answered" : "ask.expired";
    const at = this.now().toISOString();
    const deliver: AtollEvent = {
      id: derivedUlid(Date.parse(at), `${this.atollName}:answer:${ask.id}`),
      type,
      to: ask.from,
      from: by === "owner" ? "@owner" : "@clock",
      ...(ask.cause ? { cause: ask.cause } : {}),
      at,
      body: { ask: ask.id, option, ...(payload !== undefined ? { payload } : {}), by },
    };
    await this.record({ ...this.base("answer"), kind: "answer", ask: ask.id, option, ...(payload !== undefined ? { payload } : {}), by, deliver } as JournalRecord);
  }

  private async resolveEffectAsk(ask: AskRecord, option: string, payload: unknown): Promise<void> {
    const effect = ask.effect!;
    const entry = await readJson<OutboxEntry>(this.store, paths.outbox(effect.id));
    if (!entry) return;
    const spec = this.system.effects?.[entry.name];
    if (effect.reason === "approval") {
      if (option === "approve") {
        const args = payload !== undefined ? payload : entry.args;
        await this.recordEffect(entry, { state: "approved", approvedBy: ask.id, args });
        await this.runEffect({ ...entry, state: "approved", args });
      } else {
        await this.finishEffect(entry, { ok: false, result: { denied: true }, error: "The owner did not approve it", evidence: [] }, "denied");
      }
      return;
    }
    if (effect.reason === "over-budget") {
      if (option === "allow") await this.runEffect({ ...entry, state: "approved" }, { skipBudget: true });
      else await this.finishEffect(entry, { ok: false, result: { dropped: true, overBudget: true }, error: "Over budget; the owner dropped it", evidence: [] }, "dropped");
      return;
    }
    if (effect.reason === "in-doubt") {
      if (option === "retry" && spec) await this.runEffect({ ...entry, state: "approved" }, { skipBudget: true });
      else if (option === "happened") await this.finishEffect(entry, { ok: true, result: { assumed: true, by: "owner" }, evidence: [] }, "done");
      else await this.finishEffect(entry, { ok: false, result: { inDoubt: true }, error: "Unknown whether it happened", evidence: [] }, "dropped");
    }
  }

  // ---- timers -------------------------------------------------------------------------------------

  async deliverTimers(): Promise<void> {
    const now = this.now();
    for (const timer of this.cache.timers ?? (this.cache.timers = await readTimers(this.store))) {
      if (Date.parse(timer.until) > now.getTime()) break;
      const id = timerEventId(timer.address, timer.wait, timer.until);
      if (await this.store.head(paths.seen(id))) continue;
      const event: AtollEvent = { id, type: timer.type, to: timer.address, from: "@clock", ...(timer.cause ? { cause: timer.cause } : {}), at: timer.until, body: timer.body ?? { reason: timer.reason } };
      if (await this.store.create(paths.inbox(id), json(event))) this.report.timersFired += 1;
    }
  }

  // ---- the inbox ----------------------------------------------------------------------------------

  async pendingEvents(): Promise<string[]> {
    const ids: string[] = [];
    for (const entry of await this.store.list(paths.inboxPrefix)) {
      const id = INBOX_KEY.exec(entry.key)?.[1];
      if (id && !this.failedThisTick.has(id)) ids.push(id);
    }
    return ids.sort();
  }

  async processInbox(maxTurns: number): Promise<void> {
    while (this.report.turns + this.report.failures < maxTurns) {
      const ids = await this.pendingEvents();
      if (ids.length === 0) break;
      for (const id of ids) {
        if (this.report.turns + this.report.failures >= maxTurns) break;
        const event = await readJson<AtollEvent>(this.store, paths.inbox(id)).catch(() => null);
        if (!event) continue;
        await this.handle(event);
        await this.lease.maybeRenew();
      }
      await this.deliverTimers();
    }
    this.report.remaining = (await this.pendingEvents()).length;
  }

  async handle(event: AtollEvent): Promise<void> {
    if (await this.store.head(paths.seen(event.id))) {
      await this.record({ ...this.base("duplicate"), kind: "duplicate", event: event.id } as JournalRecord);
      this.report.duplicates += 1;
      return;
    }
    const address = parseAddress(event.to);
    const part = address ? this.system.parts[address.part] : undefined;
    if (!address || !part) return this.fail(event, `No part "${event.to}" in this atoll`, true);
    if (part.instances && !address.instance) return this.fail(event, `Part "${address.part}" has instances; address one as ${address.part}/<name>`, true);
    if (!part.instances && address.instance) return this.fail(event, `Part "${address.part}" has no instances; address it as "${address.part}"`, true);
    const handler = part.on[event.type];
    if (!handler) return this.fail(event, `Part "${address.part}" has no handler for "${event.type}"`, true);

    const seq = this.journal.nextSeq();
    const now = this.now();
    const turn = new TurnContext(this.store, seq, this.atollName, event, event.to, address.part, address.instance, now);
    try {
      await handler(turn, event);
    } catch (error) {
      if (error instanceof MissingStub) throw error;
      return this.fail(event, `${(error as Error).name}: ${(error as Error).message}`, false);
    }
    const problem = this.validateIntents(turn, event.to);
    if (problem) return this.fail(event, problem, false);
    await this.commitTurn(turn, event, part, seq, now);
  }

  private validateIntents(turn: TurnContext, address: string): string | null {
    const own = `${paths.part(address)}/`;
    for (const key of turn.intents.writes.keys()) {
      if (!key.startsWith(own)) return `This turn tried to write ${key}, outside its own directory ${own}`;
      if (key === paths.waiting(address)) return `waiting.json is written by the runtime; use t.wait() instead`;
    }
    for (const send of turn.intents.sends) {
      const target = parseAddress(send.to);
      const spec = target ? this.system.parts[target.part] : undefined;
      if (!target || !spec) return `t.send() to "${send.to}": no such part`;
      if (spec.instances && !target.instance) return `t.send() to "${send.to}": that part has instances; name one`;
      if (!spec.instances && target.instance) return `t.send() to "${send.to}": that part has no instances`;
      if (!spec.on[send.type]) return `t.send() of "${send.type}" to "${send.to}": that part has no handler for it`;
    }
    for (const effect of turn.intents.effects) {
      if (!this.system.effects?.[effect.name]) return `t.effect("${effect.name}"): no effect by that name is declared`;
    }
    return null;
  }

  private satisfies(address: string, wait: WaitOp, event: AtollEvent): boolean {
    if (wait.until && event.from === "@clock" && event.id === timerEventId(address, wait.id, wait.until)) return true;
    if (wait.for && wait.for === event.type) return true;
    if (wait.ask && (event.type === "ask.answered" || event.type === "ask.expired") && (event.body as { ask?: string })?.ask === wait.ask) return true;
    return false;
  }

  private async commitTurn(turn: TurnContext, event: AtollEvent, part: PartSpec, seq: number, now: Date): Promise<void> {
    const intents = turn.intents;
    const address = event.to;
    const previous = await readJson<WaitingFile>(this.store, paths.waiting(address));
    const before = previous?.waits ?? [];
    let waits: WaitOp[] = [];
    if (!intents.done) {
      // A turn that declares waits says what the part waits for now: they replace the old ones. A turn
      // that declares none keeps the part's waits this event didn't satisfy. Schedules are always kept.
      const kept = before.filter((w) => w.schedule !== undefined || (intents.waits.length === 0 && !this.satisfies(address, w, event)));
      waits = kept.filter((w) => !(w.schedule !== undefined && this.satisfies(address, w, event))).concat(intents.waits);
      for (const [index, schedule] of (part.schedules ?? []).entries()) {
        if (waits.some((w) => w.schedule === index)) continue;
        const previous = before.find((w) => w.schedule === index);
        waits.push({ id: `s${seq}.${index}`, until: nextScheduled(schedule, previous?.until, now, this.system.owner?.timezone).toISOString(), reason: `the next scheduled ${schedule.send}`, schedule: index });
      }
    }
    const changed = previous === null || Boolean(intents.done) !== (previous.status === "done") || JSON.stringify(before) !== JSON.stringify(waits);

    // Evidence first: content-addressed, so harmless if this turn never commits.
    for (const item of intents.evidence.values()) await this.stageEvidence(item);

    const writes: WriteOp[] = [];
    const deletes: string[] = [];
    let n = 0;
    let inlineBytes = 0;
    for (const [key, bytes] of intents.writes) {
      if (bytes === null) {
        deletes.push(key);
        continue;
      }
      const hex = sha256Hex(bytes);
      if (bytes.byteLength <= INLINE_LIMIT && inlineBytes + bytes.byteLength < 600_000) {
        writes.push({ path: key, sha256: hex, size: bytes.byteLength, ...inlineContent(bytes) });
        inlineBytes += bytes.byteLength;
      } else {
        const staged = paths.staging(seq, n++);
        await this.store.put(staged, bytes);
        writes.push({ path: key, sha256: hex, size: bytes.byteLength, staged });
      }
    }

    const effects: EffectOp[] = intents.effects.map((e) => {
      const spec = this.system.effects![e.name]!;
      return { ...e, kind: spec.kind, approval: Boolean(spec.approval), idempotent: defaultIdempotent(spec, e.args), for: address };
    });

    const record: TurnRecord = {
      v: 1,
      kind: "turn",
      seq,
      epoch: this.lease.epoch,
      at: now.toISOString(),
      code: this.code,
      event,
      part: address,
      writes,
      deletes,
      sends: intents.sends,
      effects,
      waits: changed ? waits : null,
      ...(intents.done ? { done: intents.done } : {}),
      asks: intents.asks,
      notices: intents.notices,
      evidence: [...intents.evidence.keys()].map((hex) => `sha256:${hex}`),
      ...(intents.notes.length ? { note: intents.notes.join(" ") } : {}),
    };
    await this.record(record);
    this.report.turns += 1;
    for (const effect of effects) {
      const entry = await readJson<OutboxEntry>(this.store, paths.outbox(effect.id));
      if (entry && entry.state === "pending") await this.runEffect(entry);
    }
  }

  private async stageEvidence(item: EvidenceItem): Promise<void> {
    await this.store.create(paths.evidence(item.hex), item.bytes);
    await this.store.create(paths.evidenceMeta(item.hex), json({ ref: `sha256:${item.hex}`, ...item.meta }));
  }

  private async fail(event: AtollEvent, error: string, routing: boolean): Promise<void> {
    const attemptsKey = `.atoll/attempts/${event.id}`;
    const attempt = Number(asText(await this.store.get(attemptsKey)) ?? "0") + 1;
    const dead = routing || attempt >= MAX_ATTEMPTS;
    const seq = this.journal.nextSeq();
    await this.record({
      v: 1,
      kind: "failure",
      seq,
      epoch: this.lease.epoch,
      at: this.now().toISOString(),
      event,
      attempt,
      error,
      dead,
      ...(dead
        ? { notice: { id: `f${seq}.0`, text: `I couldn't handle a "${event.type}" event for ${event.to} after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${error}. It is in inbox/dead/${event.id}.json.` } }
        : {}),
    } as JournalRecord);
    this.report.failures += 1;
    if (dead) await this.store.delete(attemptsKey);
    else {
      await this.store.put(attemptsKey, String(attempt));
      this.failedThisTick.add(event.id);
    }
  }

  // ---- effects ------------------------------------------------------------------------------------

  private async recordEffect(entry: OutboxEntry, fields: Partial<EffectRecord>): Promise<EffectRecord> {
    return (await this.record({ ...this.base("effect"), kind: "effect", effect: entry.id, name: entry.name, state: "started", ...fields } as JournalRecord)) as EffectRecord;
  }

  async resumeOutbox(): Promise<void> {
    for (const item of await this.store.list(paths.outboxPrefix)) {
      if (!/^outbox\/[^/]+\.json$/.test(item.key)) continue;
      const entry = await readJson<OutboxEntry>(this.store, item.key);
      if (!entry) continue;
      if (entry.state === "pending" || entry.state === "approved") await this.runEffect(entry);
      else if ((entry.state === "awaiting-approval" || entry.state === "over-budget" || entry.state === "in-doubt") && entry.ask) {
        // The owner's answer may have been recorded just before the runner stopped: the question is closed
        // but the effect never moved on. Apply that answer now instead of waiting forever.
        const closed = await readJson<AskRecord & { answer?: { option: string; payload?: unknown } }>(this.store, paths.askClosed(entry.ask));
        if (closed?.answer && closed.effect) await this.resolveEffectAsk(closed, closed.answer.option, closed.answer.payload);
      } else if (entry.state === "started") {
        if (entry.idempotent) await this.runEffect({ ...entry, state: "approved" }, { skipBudget: true });
        else {
          this.report.recovered.inDoubt += 1;
          await this.markInDoubt(entry, "The runner stopped after starting this effect and before recording its outcome");
        }
      }
    }
  }

  private async markInDoubt(entry: OutboxEntry, why: string): Promise<void> {
    const seq = this.journal.nextSeq();
    const now = this.now();
    const ask: AskRecord = {
      id: `q${seq}.0`,
      from: entry.for,
      question: `Did ${entry.name} (${entry.id}) happen?`,
      why: `${why}. I won't run it again unless you say so.`,
      options: [
        { id: "happened", label: "It happened", consequence: `${entry.for} is told it succeeded.` },
        { id: "retry", label: "Run it again", consequence: "It runs once more, which may repeat it." },
        { id: "unknown", label: "Leave it unknown", consequence: `${entry.for} is told the outcome is unknown.` },
      ],
      recommend: "unknown",
      default: "unknown",
      expires: resolveTime("3d", now).toISOString(),
      payload: entry.args,
      at: now.toISOString(),
      effect: { id: entry.id, reason: "in-doubt" },
    };
    await this.recordEffect(entry, { state: "in-doubt", ask, error: why });
    this.report.effects.inDoubt += 1;
  }

  async runEffect(entry: OutboxEntry, options: { skipBudget?: boolean } = {}): Promise<void> {
    const spec: EffectSpec | undefined = this.system.effects?.[entry.name];
    if (!spec) {
      await this.finishEffect(entry, { ok: false, error: `No effect named ${entry.name} is declared in the current code`, evidence: [] }, "failed");
      return;
    }
    const now = this.now();
    if (entry.state === "pending" && spec.approval) {
      const seq = this.journal.nextSeq();
      const describe = spec.describe ? spec.describe(entry.args) : `Run ${entry.name} with the arguments below`;
      const ask: AskRecord = {
        id: `q${seq}.0`,
        from: entry.for,
        question: `${describe}?`,
        why: `${entry.for} asked for ${entry.name}, which needs your approval each time.`,
        options: [
          { id: "approve", label: "Approve", consequence: "It runs once, with exactly these arguments (or your edit of them)." },
          { id: "deny", label: "Deny", consequence: `It doesn't run; ${entry.for} is told you said no.` },
        ],
        default: "deny",
        expires: resolveTime("3d", now).toISOString(),
        payload: entry.args,
        at: now.toISOString(),
        effect: { id: entry.id, reason: "approval" },
      };
      await this.recordEffect(entry, { state: "awaiting-approval", ask });
      this.report.effects.awaitingApproval += 1;
      return;
    }
    if (!options.skipBudget) {
      const over = await overBudget(this.store, entry, spec, now);
      if (over) {
        const seq = this.journal.nextSeq();
        const ask: AskRecord = {
          id: `q${seq}.0`,
          from: entry.for,
          question: `Let ${entry.name} run past its budget?`,
          why: `${over}.`,
          options: [
            { id: "allow", label: "Allow this one", consequence: "It runs once now; the budget stays as declared." },
            { id: "drop", label: "Don't run it", consequence: `${entry.for} is told it was dropped for budget.` },
          ],
          default: "drop",
          expires: resolveTime("3d", now).toISOString(),
          at: now.toISOString(),
          effect: { id: entry.id, reason: "over-budget" },
        };
        await this.recordEffect(entry, { state: "over-budget", ask, error: over });
        this.report.effects.overBudget += 1;
        return;
      }
    }
    await this.recordEffect(entry, { state: "started" });
    let outcome: Outcome;
    try {
      outcome = await perform(entry, spec, this.env);
    } catch (error) {
      if (error instanceof MissingStub) throw error;
      outcome = { ok: false, error: (error as Error).message, evidence: [] };
    }
    if (outcome.merge) await this.mergeBranch(entry, outcome);
    await this.finishEffect(entry, outcome, outcome.ok ? "done" : "failed");
  }

  private async finishEffect(entry: OutboxEntry, outcome: Outcome, state: "done" | "failed" | "denied" | "dropped"): Promise<void> {
    for (const item of outcome.evidence) await this.stageEvidence(item);
    const at = this.now().toISOString();
    const evidence = outcome.evidence.map((e) => `sha256:${e.hex}`);
    // A result is journaled twice (with its outcome, and with the turn that handles it), so a large one
    // is kept as evidence and the event carries a pointer.
    if (outcome.result !== undefined) {
      const text = JSON.stringify(outcome.result) ?? "";
      if (text.length > RESULT_INLINE_LIMIT) {
        const item = { hex: sha256Hex(text), bytes: new TextEncoder().encode(text), meta: { source: `result:${entry.id}`, type: "application/json", at, size: text.length } };
        await this.stageEvidence(item);
        evidence.push(`sha256:${item.hex}`);
        outcome.result = { tooLarge: true, bytes: text.length, body: `sha256:${item.hex}` };
      }
    }
    const deliver: AtollEvent = {
      id: derivedUlid(Date.parse(at), `${this.atollName}:${entry.id}:result:${state}`),
      type: entry.then,
      to: entry.for,
      from: entry.id,
      ...(entry.cause ? { cause: entry.cause } : {}),
      at,
      body: {
        ok: outcome.ok,
        effect: entry.id,
        name: entry.name,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(state === "denied" ? { denied: true } : {}),
        ...((outcome.result as { inDoubt?: boolean } | undefined)?.inDoubt ? { inDoubt: true } : {}),
      },
      ...(evidence.length ? { evidence } : {}),
    };
    await this.recordEffect(entry, {
      state,
      deliver,
      ...(evidence.length ? { evidence } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.cost ? { cost: outcome.cost } : {}),
      ...(outcome.changed ? { changed: outcome.changed } : {}),
    });
    if (state === "done") this.report.effects.done += 1;
    else if (state === "failed") this.report.effects.failed += 1;
  }

  /**
   * Merge a forked command's changes into the main atoll, but only if every file it touched still holds,
   * on the main atoll, the content the branch started from: optimistic concurrency for a bash command.
   */
  private async mergeBranch(entry: OutboxEntry, outcome: Outcome): Promise<void> {
    const merge = outcome.merge!;
    if (!outcome.ok || !this.env.snapshots) return;
    const scopePrefix = `${merge.scope}/`;
    const touched = [...merge.changed.added, ...merge.changed.modified, ...merge.changed.deleted];
    const conflicts: string[] = [];
    for (const p of touched) {
      const current = await this.store.get(`${scopePrefix}${p}`);
      const hash = current === null ? null : sha256Hex(current);
      if (hash !== (merge.base[p] ?? null)) conflicts.push(`${scopePrefix}${p}`);
    }
    const result = (outcome.result ?? {}) as Record<string, unknown>;
    await this.store.put(paths.branch(`atoll-${entry.id}`), json({ name: `atoll-${entry.id}`, id: merge.branch, checkpoint: merge.checkpoint, effect: entry.id, at: this.now().toISOString(), merged: conflicts.length === 0 }));
    if (conflicts.length) {
      outcome.result = { ...result, merged: false, conflicts };
      return;
    }
    const branchStore = await this.env.snapshots.open(merge.branch);
    const writes: WriteOp[] = [];
    const seq = this.journal.nextSeq();
    let n = 0;
    for (const p of [...merge.changed.added, ...merge.changed.modified]) {
      const key = `${scopePrefix}${p}`;
      const bytes = await branchStore.get(key);
      if (bytes === null) continue;
      const hex = sha256Hex(bytes);
      if (bytes.byteLength <= INLINE_LIMIT) writes.push({ path: key, sha256: hex, size: bytes.byteLength, ...inlineContent(bytes) });
      else {
        const staged = paths.staging(seq, n++);
        await this.store.put(staged, bytes);
        writes.push({ path: key, sha256: hex, size: bytes.byteLength, staged });
      }
    }
    await this.record({ ...this.base("merge"), kind: "merge", effect: entry.id, branch: merge.branch, checkpoint: merge.checkpoint, writes, deletes: merge.changed.deleted.map((p) => `${scopePrefix}${p}`) } as JournalRecord);
    outcome.result = { ...result, merged: true, conflicts: [] };
  }

  // ---- after the tick -----------------------------------------------------------------------------

  /** Delete dedupe markers older than the dedupe window, at most once a day. */
  async pruneSeen(): Promise<number> {
    const now = this.now();
    const last = Date.parse(asText(await this.store.get(PRUNED_AT))?.trim() ?? "") || 0;
    if (now.getTime() - last < 86_400_000) return 0;
    const cutoff = now.getTime() - SEEN_RETENTION_MS;
    let pruned = 0;
    for (const entry of await this.store.list(paths.seenPrefix)) {
      const marker = await readJson<{ at?: string }>(this.store, entry.key).catch(() => null);
      const at = Date.parse(marker?.at ?? "") || entry.lastModified?.getTime() || now.getTime();
      if (at < cutoff) {
        await this.store.delete(entry.key);
        pruned += 1;
      }
    }
    await this.store.put(PRUNED_AT, now.toISOString());
    return pruned;
  }

  async finish(): Promise<void> {
    await this.pruneSeen();
    const next = this.cache.nextWake ?? asText(await this.store.get(paths.nextWake))?.trim();
    this.report.nextWake = next ? next : null;
    // STATUS.md changes only when the journal does; an idle tick leaves it alone.
    if (this.journal.lastSeq > this.startSeq || !(await this.store.head(paths.status))) {
      await this.store.put(paths.status, await renderStatus(this.store, this.system));
    }
    if (this.options.checkpoint && this.options.snapshots && this.report.turns > 0) {
      const name = `atoll-${this.journal.lastSeq}-${Date.now()}`;
      await this.options.snapshots.checkpoint(name);
      await this.record({ ...this.base("checkpoint"), kind: "checkpoint", name, reason: "after a tick" } as JournalRecord);
      this.report.checkpoint = name;
    }
    this.report.lastSeq = this.journal.lastSeq;
  }
}

/**
 * When a schedule fires next. An `every` schedule keeps its cadence from the time it was due, not the time a
 * tick happened to handle it, so a clock that ticks as often as the interval doesn't skip every other one.
 * Periods missed while nothing ticked are skipped: the schedule fires once, then on its next due time.
 */
export function nextScheduled(schedule: ScheduleSpec, previousUntil: string | undefined, now: Date, tz?: string): Date {
  if (!schedule.every || !previousUntil) return nextFire(schedule, now, tz);
  const step = parseDuration(schedule.every);
  let next = Date.parse(previousUntil) + step;
  if (next <= now.getTime()) next += Math.ceil((now.getTime() - next + 1) / step) * step;
  return new Date(next);
}

function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

export function runnerId(): string {
  return `${hostname()}:${process.pid}:${nonce(3)}`;
}

/** Take the lease, run `work` with a recovered runner, and release the lease. */
export async function withRunner<T>(
  options: TickOptions,
  work: (runner: Runner) => Promise<T>,
): Promise<{ ran: true; value: T; runner: Runner } | { ran: false; heldBy: string; until: string }> {
  const now = options.now ?? (() => new Date());
  await options.store.refresh?.();
  const acquired = await Lease.acquire(options.store, { runner: options.runner ?? runnerId(), ttlMs: options.leaseTtlMs ?? 60_000, clock: now });
  if (!acquired.lease) return { ran: false, heldBy: acquired.heldBy, until: acquired.until };
  const lease = acquired.lease;
  try {
    const system = options.system ?? (await loadCurrentSystem(options.store));
    const problems = validateSystem(system);
    if (problems.length) throw new Error(`The atoll's code has problems: ${problems.map((p) => `${p.where}: ${p.message}`).join("; ")}`);
    const code = options.codeVersion ?? (await currentCodeVersion(options.store)) ?? "unpushed";
    const runner = new Runner(options.store, system, code, lease, options, now);
    await runner.recover();
    const value = await work(runner);
    return { ran: true, value, runner };
  } finally {
    await lease.release().catch(() => {});
  }
}

/** Run one tick: handle everything in the inbox, up to `maxTurns`. */
export async function tick(options: TickOptions): Promise<TickReport> {
  const outcome = await withRunner(options, async (runner) => {
    await runner.applyAsks();
    await runner.deliverTimers();
    await runner.resumeOutbox();
    await runner.processInbox(options.maxTurns ?? 200);
    await runner.finish();
    return runner.report;
  });
  if (!outcome.ran) {
    const report = emptyReport(0);
    return { ...report, ran: false, heldBy: outcome.heldBy };
  }
  return outcome.value;
}

/** Deliver an event to an atoll's inbox. Safe to repeat with the same `id`. */
export async function deliver(
  store: Store,
  input: { to: string; type: string; body?: unknown; from?: string; cause?: string; id?: string; at?: string; evidence?: string[] },
  now: Date = new Date(),
): Promise<{ id: string; duplicate: boolean }> {
  if (!parseAddress(input.to)) throw new Error(`"${input.to}" is not a part address (use part or part/instance)`);
  if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/.test(input.type)) throw new Error(`"${input.type}" is not an event type (use dotted lowercase words)`);
  const id = input.id ?? ulid(now.getTime());
  if (await store.head(paths.seen(id))) return { id, duplicate: true };
  const event: AtollEvent = {
    id,
    type: input.type,
    to: input.to,
    from: input.from ?? "@owner",
    ...(input.cause ? { cause: input.cause } : {}),
    at: input.at ?? now.toISOString(),
    body: input.body ?? {},
    ...(input.evidence?.length ? { evidence: input.evidence } : {}),
  };
  const created = await store.create(paths.inbox(id), json(event));
  return { id, duplicate: !created };
}

/** Record the owner's answer to an ask. The next tick applies it. */
export async function answer(store: Store, id: string, option: string, payload?: unknown, now: Date = new Date()): Promise<AskRecord> {
  const ask = await readJson<AskRecord>(store, paths.ask(id));
  if (!ask) throw new Error(`No open ask "${id}" (closed asks are under asks/closed/)`);
  if (!ask.options.some((o) => o.id === option)) throw new Error(`"${option}" is not an option of ${id}: ${ask.options.map((o) => o.id).join(", ")}`);
  await store.put(paths.askAnswer(id), json({ option, ...(payload !== undefined ? { payload } : {}), at: now.toISOString() }));
  return ask;
}
