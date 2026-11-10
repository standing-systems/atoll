// Test helpers: an atoll on a temporary directory, effects replaced by stubs, a clock you control, and
// fault injection at any storage operation.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDuration } from "./ids.ts";
import type { AskRecord, JournalRecord } from "./format.ts";
import { FaultyStore } from "./store/faulty.ts";
import { LocalStore } from "./store/local.ts";
import { asText, type Store } from "./store/types.ts";
import type { SystemSpec } from "./system.ts";
import { answer, deliver, tick } from "./runtime/runner.ts";
import { push } from "./runtime/atoll.ts";
import { fiveAnswers, openAsks } from "./runtime/status.ts";
import { readJournal } from "./runtime/journal.ts";
import type { EffectStub, FiveAnswers, ModelProvider, TickReport } from "./runtime/types.ts";
import type { Hands, Snapshots } from "./store/types.ts";

export interface TestAtollOptions {
  /** The starting time; defaults to 2026-01-05T09:00:00Z (a Monday). */
  now?: string | Date;
  /** Effect implementations, keyed by effect name. Every effect a test triggers needs one. */
  stubs?: Record<string, EffectStub>;
  /** Allow effects without stubs to run for real (http, exec on the local directory). Off by default. */
  realEffects?: boolean;
  models?: ModelProvider;
  /** With realEffects, the fetch that http effects use: serve canned responses through the real effect code. */
  fetch?: typeof fetch;
  hands?: Hands;
  snapshots?: Snapshots;
  /** Use this directory instead of a fresh temporary one. */
  dir?: string;
  /** Run against this store instead of a LocalStore (for example an ArchilStore in live tests). */
  store?: Store;
}

export interface EffectCall {
  name: string;
  args: any;
  id: string;
}

export interface TestAtoll {
  readonly dir: string;
  /** The store the runner uses: a FaultyStore around the real one, so tests can inject crashes. */
  readonly store: FaultyStore;
  readonly system: SystemSpec;
  now(): Date;
  setNow(time: string | Date): void;
  send(to: string, type: string, body?: unknown, options?: { id?: string; from?: string }): Promise<string>;
  /** Run ticks until the inbox is empty (or 20 ticks). */
  tick(): Promise<TickReport>;
  /** Move the clock forward by a duration ("1h", "3d") and tick. */
  advance(duration: string): Promise<TickReport>;
  read(path: string): Promise<string | null>;
  json<T = any>(path: string): Promise<T | null>;
  list(prefix: string): Promise<string[]>;
  status(): Promise<FiveAnswers>;
  asks(): Promise<AskRecord[]>;
  answer(id: string, option: string, payload?: unknown): Promise<TickReport>;
  calls(name?: string): EffectCall[];
  journal(): Promise<JournalRecord[]>;
  close(): Promise<void>;
}

export async function testAtoll(system: SystemSpec, options: TestAtollOptions = {}): Promise<TestAtoll> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "atoll-test-")));
  const inner = options.store ?? new LocalStore(dir);
  const store = new FaultyStore(inner);
  let current = new Date(options.now ?? "2026-01-05T09:00:00Z");
  const calls: EffectCall[] = [];
  const stubs: Record<string, EffectStub> = {};
  for (const [name, stub] of Object.entries(options.stubs ?? {})) {
    stubs[name] = async (args, ctx) => {
      calls.push({ name, args, id: ctx.id });
      return stub(args, ctx);
    };
  }
  const base = {
    store,
    system,
    codeVersion: "test",
    now: () => current,
    stubs,
    stubsOnly: !options.realEffects,
    runner: "test-runner",
    ...(options.models ? { models: options.models } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.hands ? { hands: options.hands } : {}),
    ...(options.snapshots ? { snapshots: options.snapshots } : {}),
  };
  await push({ ...base, version: "test" });

  const runTicks = async (): Promise<TickReport> => {
    let total: TickReport | undefined;
    for (let i = 0; i < 20; i++) {
      const report = await tick(base);
      total = total ? merge(total, report) : report;
      if (!report.ran || report.remaining === 0) break;
    }
    return total!;
  };

  return {
    dir,
    store,
    system,
    now: () => current,
    setNow: (time) => {
      current = new Date(time);
    },
    async send(to, type, body = {}, opts = {}) {
      const { id } = await deliver(store, { to, type, body, ...(opts.id ? { id: opts.id } : {}), from: opts.from ?? "@owner" }, current);
      return id;
    },
    tick: runTicks,
    async advance(duration) {
      current = new Date(current.getTime() + parseDuration(duration));
      return runTicks();
    },
    read: async (path) => asText(await store.get(path.replace(/^\/+/, ""))),
    async json(path) {
      const text = asText(await store.get(path.replace(/^\/+/, "")));
      return text === null ? null : JSON.parse(text);
    },
    list: async (prefix) => (await store.list(prefix)).map((e) => e.key),
    status: () => fiveAnswers(store, system),
    asks: () => openAsks(store),
    async answer(id, option, payload) {
      await answer(store, id, option, payload, current);
      return runTicks();
    },
    calls: (name) => (name ? calls.filter((c) => c.name === name) : [...calls]),
    journal: async () => (await readJournal(store)).records,
    async close() {
      if (!options.dir && !options.store) await rm(dir, { recursive: true, force: true });
    },
  };
}

function merge(a: TickReport, b: TickReport): TickReport {
  return {
    ...b,
    turns: a.turns + b.turns,
    failures: a.failures + b.failures,
    duplicates: a.duplicates + b.duplicates,
    timersFired: a.timersFired + b.timersFired,
    answersApplied: a.answersApplied + b.answersApplied,
    effects: {
      done: a.effects.done + b.effects.done,
      failed: a.effects.failed + b.effects.failed,
      inDoubt: a.effects.inDoubt + b.effects.inDoubt,
      awaitingApproval: a.effects.awaitingApproval + b.effects.awaitingApproval,
      overBudget: a.effects.overBudget + b.effects.overBudget,
    },
    recovered: {
      reinstalled: a.recovered.reinstalled + b.recovered.reinstalled,
      stagingCleared: a.recovered.stagingCleared + b.recovered.stagingCleared,
      inDoubt: a.recovered.inDoubt + b.recovered.inDoubt,
    },
  };
}

export { LocalStore, FaultyStore };
