// Installing a committed record: applying it to the files. Every step is idempotent, and records are
// installed in sequence order, so re-installing any suffix of the journal after a crash converges to the
// same files (docs/a-place-to-stand.md, sections 7.2 and 7.3).
//
// Within one record, independent writes run concurrently, in phases that keep the order that matters:
// a record's files, messages and questions first, then its dedupe marker, then the inbox delete and
// staging cleanup, and the head last. A crash anywhere leaves a prefix of a record installed, and
// recovery installs the whole record again.

import { derivedUlid } from "../ids.ts";
import {
  dayOf,
  monthOf,
  paths,
  type AskRecord,
  type JournalRecord,
  type OutboxEntry,
  type TimerEntry,
  type WaitOp,
  type WaitingFile,
  type WriteOp,
} from "../format.ts";
import { asText, type Store } from "../store/types.ts";
import type { AtollEvent } from "../system.ts";

export async function readJson<T>(store: Store, key: string): Promise<T | null> {
  const text = asText(await store.get(key));
  if (text === null || text === "") return null;
  return JSON.parse(text) as T;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The ID of the event a timed wait delivers when it comes due: the same for every tick that delivers it. */
export function timerEventId(address: string, waitId: string, until: string): string {
  return derivedUlid(Date.parse(until), `timer:${address}:${waitId}:${until}`);
}

export async function readTimers(store: Store): Promise<TimerEntry[]> {
  return (await readJson<TimerEntry[]>(store, paths.timers)) ?? [];
}

/**
 * State the one runner holding the lease may keep between records of a tick, to skip reads of files only it
 * writes. A fresh cache (the default) reads everything from the store.
 */
export interface InstallCache {
  timers?: TimerEntry[];
  nextWake?: string;
  /** The code version to record in the head. */
  code?: string;
}

async function loadTimers(store: Store, cache: InstallCache): Promise<TimerEntry[]> {
  if (!cache.timers) cache.timers = await readTimers(store);
  return cache.timers;
}

async function saveTimers(store: Store, cache: InstallCache, timers: TimerEntry[]): Promise<void> {
  timers.sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0));
  cache.timers = timers;
  const next = timers[0]?.until ?? "";
  if (cache.nextWake === undefined) cache.nextWake = asText(await store.get(paths.nextWake))?.trim() ?? "";
  await Promise.all([
    store.put(paths.timers, json(timers)),
    cache.nextWake === next ? Promise.resolve() : store.put(paths.nextWake, next),
  ]);
  cache.nextWake = next;
}

async function setTimersFor(store: Store, cache: InstallCache, address: string, waits: WaitOp[], typeOf: (w: WaitOp) => { type: string; body?: unknown }, cause?: string): Promise<void> {
  const timers = (await loadTimers(store, cache)).filter((t) => t.address !== address);
  for (const wait of waits) {
    if (!wait.until) continue;
    const { type, body } = typeOf(wait);
    timers.push({ address, wait: wait.id, until: wait.until, reason: wait.reason, type, ...(body !== undefined ? { body } : {}), ...(wait.schedule !== undefined ? { schedule: wait.schedule } : {}), ...(cause ? { cause } : {}) });
  }
  await saveTimers(store, cache, timers);
}

/** The event type and body a timed wait delivers: its schedule's event, or a plain "timer". */
export type WaitTyper = (address: string, wait: WaitOp) => { type: string; body?: unknown };

async function writeContent(store: Store, op: WriteOp): Promise<void> {
  if (op.text !== undefined) return store.put(op.path, op.text);
  if (op.b64 !== undefined) return store.put(op.path, Buffer.from(op.b64, "base64"));
  if (op.staged) {
    const bytes = await store.get(op.staged);
    if (bytes === null) {
      // Already installed and the staging copy cleaned up: the target must hold this content.
      const existing = await store.head(op.path);
      if (existing && existing.size === op.size) return;
      throw new Error(`Staged content for ${op.path} is missing (${op.staged})`);
    }
    return store.put(op.path, bytes);
  }
  throw new Error(`Write for ${op.path} has no content`);
}

export function renderAskMd(ask: AskRecord): string {
  const lines = [
    `# ${ask.question}`,
    "",
    `Asked by \`${ask.from}\` on ${ask.at}. ${ask.why}`,
    "",
    ...ask.options.map((o) => `- **${o.id}**${o.id === ask.recommend ? " (recommended)" : ""}: ${o.label}. ${o.consequence}`),
    "",
    `If nobody answers by ${ask.expires}, the answer is **${ask.default}**.`,
    "",
    `Answer with \`atoll answer ${ask.id} <option>\`, or write \`asks/${ask.id}.answer.json\` containing \`{"option": "<option>"}\`.`,
  ];
  if (ask.payload !== undefined) lines.push("", "Draft (editable with `--payload`):", "", "```json", JSON.stringify(ask.payload, null, 2), "```");
  if (ask.evidence?.length) lines.push("", `Evidence: ${ask.evidence.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

async function openAsk(store: Store, ask: AskRecord): Promise<void> {
  if (await store.head(paths.askClosed(ask.id))) return;
  await Promise.all([store.create(paths.ask(ask.id), json(ask)), store.create(paths.askMd(ask.id), renderAskMd(ask))]);
}

async function deliver(store: Store, event: AtollEvent): Promise<void> {
  await store.create(paths.inbox(event.id), json(event));
}

async function updateOutbox(store: Store, id: string, change: Partial<OutboxEntry>): Promise<void> {
  const current = await readJson<OutboxEntry>(store, paths.outbox(id));
  if (!current) return;
  await store.put(paths.outbox(id), json({ ...current, ...change }));
}

async function setHead(store: Store, cache: InstallCache, record: JournalRecord, code?: string): Promise<void> {
  if (code) cache.code = code;
  if (cache.code === undefined) cache.code = (await readJson<{ code?: string }>(store, paths.head))?.code ?? "";
  await store.put(paths.head, json({ seq: record.seq, installed: record.seq, epoch: record.epoch, day: dayOf(record.at), code: cache.code || undefined }));
}

export async function install(store: Store, record: JournalRecord, typer: WaitTyper, cache: InstallCache = {}): Promise<void> {
  switch (record.kind) {
    case "turn": {
      const work: Promise<unknown>[] = [];
      for (const op of record.writes) work.push(writeContent(store, op));
      for (const key of record.deletes) work.push(store.delete(key));
      for (const send of record.sends) {
        work.push(
          deliver(store, {
            id: send.id,
            type: send.type,
            to: send.to,
            from: record.part,
            cause: record.event.id,
            at: record.at,
            body: send.body,
            ...(send.evidence?.length ? { evidence: send.evidence } : {}),
          }),
        );
      }
      for (const ask of record.asks) work.push(openAsk(store, ask));
      for (const effect of record.effects) {
        const entry: OutboxEntry = {
          id: effect.id,
          name: effect.name,
          kind: effect.kind,
          for: effect.for,
          args: effect.args,
          then: effect.then,
          key: effect.key,
          state: "pending",
          approval: effect.approval,
          idempotent: effect.idempotent,
          requestedAt: record.at,
          seq: record.seq,
          updatedAt: record.at,
          cause: record.event.id,
        };
        work.push(store.create(paths.outbox(effect.id), json(entry)));
      }
      for (const notice of record.notices) work.push(store.put(paths.notice(dayOf(record.at), notice.id), noticeMd(record.part, record.at, notice.text, notice.evidence)));
      if (record.waits !== null || record.done) {
        const waits = record.done ? [] : (record.waits ?? []);
        const file: WaitingFile = {
          address: record.part,
          status: record.done ? "done" : waits.length ? "waiting" : "idle",
          waits,
          ...(record.done ? { done: record.done } : {}),
          since: record.at,
          seq: record.seq,
        };
        work.push(store.put(paths.waiting(record.part), json(file)));
        work.push(setTimersFor(store, cache, record.part, waits, (w) => typer(record.part, w), record.event.id));
      }
      await Promise.all(work);
      await store.create(paths.seen(record.event.id), json({ seq: record.seq, at: record.at }));
      await Promise.all([store.delete(paths.inbox(record.event.id)), ...record.writes.filter((op) => op.staged).map((op) => store.delete(op.staged!))]);
      await setHead(store, cache, record, record.code);
      return;
    }
    case "effect": {
      const terminal = record.state === "done" || record.state === "failed" || record.state === "denied" || record.state === "dropped";
      const work: Promise<unknown>[] = [];
      if (record.ask) work.push(openAsk(store, record.ask));
      if (record.deliver) work.push(deliver(store, record.deliver));
      if ((record.state === "done" || record.state === "failed") && record.cost) {
        work.push(
          (async () => {
            const key = paths.meter(monthOf(record.at));
            const meter = (await readJson<{ month: string; effects: Record<string, unknown> }>(store, key)) ?? { month: monthOf(record.at), effects: {} };
            meter.effects[record.effect] = { name: record.name, at: record.at, ...record.cost };
            await store.put(key, json(meter));
          })(),
        );
      }
      if (terminal) work.push(store.delete(paths.outbox(record.effect)));
      else {
        work.push(
          updateOutbox(store, record.effect, {
            state: record.state,
            updatedAt: record.at,
            ...(record.ask ? { ask: record.ask.id } : {}),
            ...(record.args !== undefined ? { args: record.args } : {}),
            ...(record.error ? { error: record.error } : {}),
          }),
        );
      }
      await Promise.all(work);
      await setHead(store, cache, record);
      return;
    }
    case "answer": {
      const ask = await readJson<AskRecord>(store, paths.ask(record.ask));
      if (ask) await store.put(paths.askClosed(record.ask), json({ ...ask, answer: { option: record.option, payload: record.payload, by: record.by, at: record.at } }));
      await Promise.all([
        store.delete(paths.ask(record.ask)),
        store.delete(paths.askMd(record.ask)),
        store.delete(paths.askAnswer(record.ask)),
        record.deliver ? deliver(store, record.deliver) : Promise.resolve(),
      ]);
      await setHead(store, cache, record);
      return;
    }
    case "failure": {
      if (record.dead) {
        await Promise.all([
          store.put(paths.dead(record.event.id), json({ event: record.event, error: record.error, attempts: record.attempt, at: record.at })),
          record.notice ? store.put(paths.notice(dayOf(record.at), record.notice.id), noticeMd(record.event.to, record.at, record.notice.text)) : Promise.resolve(),
        ]);
        await store.create(paths.seen(record.event.id), json({ seq: record.seq, at: record.at, dead: true }));
        await store.delete(paths.inbox(record.event.id));
        if (record.event.from === "@clock") {
          // A timed wait whose event can't be handled is dropped, so it doesn't stay due forever.
          const timers = await loadTimers(store, cache);
          const kept = timers.filter((t) => timerEventId(t.address, t.wait, t.until) !== record.event.id);
          if (kept.length !== timers.length) await saveTimers(store, cache, kept);
        }
      }
      await setHead(store, cache, record);
      return;
    }
    case "duplicate": {
      await store.delete(paths.inbox(record.event));
      await setHead(store, cache, record);
      return;
    }
    case "push": {
      await Promise.all(record.writes.map((op) => writeContent(store, op)));
      for (const { address, waits } of record.arm) {
        if (await store.head(paths.waiting(address))) continue;
        const file: WaitingFile = { address, status: waits.length ? "waiting" : "idle", waits, since: record.at, seq: record.seq };
        await store.put(paths.waiting(address), json(file));
        await setTimersFor(store, cache, address, waits, (w) => typer(address, w));
      }
      await setHead(store, cache, record, record.code);
      return;
    }
    case "checkpoint": {
      await store.put(paths.checkpoint(record.name), json({ name: record.name, seq: record.seq, at: record.at, reason: record.reason }));
      await setHead(store, cache, record);
      return;
    }
    case "merge": {
      await Promise.all([...record.writes.map((op) => writeContent(store, op)), ...record.deletes.map((key) => store.delete(key))]);
      await Promise.all(record.writes.filter((op) => op.staged).map((op) => store.delete(op.staged!)));
      await setHead(store, cache, record);
      return;
    }
  }
}

export function noticeMd(from: string, at: string, text: string, evidence?: string[]): string {
  return `${text}\n\n_From \`${from}\` at ${at}._${evidence?.length ? `\n\nEvidence: ${evidence.join(", ")}` : ""}\n`;
}
