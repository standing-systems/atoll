// Replay and try: re-handle recorded events through a chosen version of the code, each against the
// exact state its original turn saw, and compare what the code would do with what was recorded.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../ids.ts";
import type { JournalRecord, TurnRecord, WaitOp } from "../format.ts";
import { LocalStore } from "../store/local.ts";
import type { Store, StoreEntry } from "../store/types.ts";
import { parseAddress, type SystemSpec } from "../system.ts";
import { install, readJson } from "./install.ts";
import { readJournal } from "./journal.ts";
import { TurnContext } from "./turn.ts";
import { nextFire } from "./schedule.ts";
import { paths, type WaitingFile } from "../format.ts";

/** Reads evidence from the live atoll when the replay copy lacks it; writes stay in the copy. */
class ReplayStore extends LocalStore {
  private readonly live: Store;
  constructor(root: string, live: Store) {
    super(root);
    this.live = live;
  }
  override async get(key: string): Promise<Uint8Array | null> {
    const own = await super.get(key);
    if (own !== null || !key.startsWith("evidence/")) return own;
    return this.live.get(key);
  }
  override async head(key: string): Promise<StoreEntry | null> {
    return (await super.head(key)) ?? (key.startsWith("evidence/") ? this.live.head(key) : null);
  }
}

export interface TurnDiff {
  seq: number;
  part: string;
  event: string;
  differences: string[];
}

export interface ReplayReport {
  turns: number;
  same: number;
  different: TurnDiff[];
  /** Turns whose handler threw under the replayed code. */
  errors: { seq: number; part: string; event: string; error: string }[];
  /** Turns whose event the replayed code has no handler for. */
  unhandled: { seq: number; part: string; event: string }[];
}

function canonicalWaits(waits: WaitOp[]): string {
  return JSON.stringify(waits.map((w) => ({ until: w.until, for: w.for, ask: w.ask, schedule: w.schedule })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

/**
 * For every recorded turn, run `system`'s handler against the files as they were just before that turn,
 * at the turn's recorded time, and compare the intents with the recording. The copy's state then follows
 * the recording, so each turn is judged on the state it really saw.
 */
export interface ReplayOptions {
  fromSeq?: number;
  toSeq?: number;
  /**
   * Replay each turn through the code version that recorded it, when that version can be loaded (every
   * pushed version stays on the disk). Without it, every turn is replayed through `system`.
   */
  versions?: (version: string) => Promise<SystemSpec | null>;
}

export async function replay(live: Store, system: SystemSpec, options: ReplayOptions = {}): Promise<ReplayReport> {
  const { records } = await readJournal(live);
  const dir = await mkdtemp(join(tmpdir(), "atoll-replay-"));
  const copy = new ReplayStore(dir, live);
  const report: ReplayReport = { turns: 0, same: 0, different: [], errors: [], unhandled: [] };
  const typer = (address: string, wait: WaitOp) => {
    if (wait.schedule === undefined) return { type: "timer", body: { reason: wait.reason } };
    const part = system.parts[address.split("/")[0]!];
    const s = part?.schedules?.[wait.schedule];
    return s ? { type: s.send, ...(s.body !== undefined ? { body: s.body } : {}) } : { type: "timer" };
  };
  try {
    for (const record of records) {
      if (record.kind === "turn" && (options.fromSeq === undefined || record.seq >= options.fromSeq) && (options.toSeq === undefined || record.seq <= options.toSeq)) {
        const own = options.versions ? await options.versions(record.code).catch(() => null) : null;
        await compareTurn(copy, own ?? system, record, report);
      }
      await install(copy, record as JournalRecord, typer);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return report;
}

async function compareTurn(copy: Store, system: SystemSpec, record: TurnRecord, report: ReplayReport): Promise<void> {
  report.turns += 1;
  const address = parseAddress(record.part);
  const part = address ? system.parts[address.part] : undefined;
  const handler = part?.on[record.event.type];
  if (!address || !part || !handler) {
    report.unhandled.push({ seq: record.seq, part: record.part, event: record.event.type });
    return;
  }
  const turn = new TurnContext(copy, record.seq, system.name, record.event, record.part, address.part, address.instance, new Date(record.at));
  try {
    await handler(turn, record.event);
  } catch (error) {
    report.errors.push({ seq: record.seq, part: record.part, event: record.event.type, error: (error as Error).message });
    return;
  }
  const differences: string[] = [];
  const want = new Map(record.writes.map((w) => [w.path, w.sha256]));
  for (const d of record.deletes) want.set(d, "deleted");
  const got = new Map<string, string>();
  for (const [key, bytes] of turn.intents.writes) got.set(key, bytes === null ? "deleted" : sha256Hex(bytes));
  for (const [key, hash] of want) if (got.get(key) !== hash) differences.push(got.has(key) ? `writes different content to ${key}` : `no longer writes ${key}`);
  for (const key of got.keys()) if (!want.has(key)) differences.push(`now writes ${key}`);
  const sends = (list: { to: string; type: string; body: unknown }[]) => list.map((s) => `${s.type}→${s.to}:${JSON.stringify(s.body)}`).sort();
  const sendsWant = sends(record.sends);
  const sendsGot = sends(turn.intents.sends);
  if (JSON.stringify(sendsWant) !== JSON.stringify(sendsGot)) differences.push(`sends ${JSON.stringify(sendsGot)} instead of ${JSON.stringify(sendsWant)}`);
  const effects = (list: { name: string; args: unknown; then: string }[]) => list.map((e) => `${e.name}(${JSON.stringify(e.args)})→${e.then}`).sort();
  if (JSON.stringify(effects(record.effects)) !== JSON.stringify(effects(turn.intents.effects))) differences.push(`requests effects ${JSON.stringify(effects(turn.intents.effects))} instead of ${JSON.stringify(effects(record.effects))}`);
  const asks = (list: { question: string; options: { id: string }[]; default: string }[]) => list.map((a) => `${a.question}|${a.options.map((o) => o.id).join(",")}|${a.default}`).sort();
  if (JSON.stringify(asks(record.asks)) !== JSON.stringify(asks(turn.intents.asks))) differences.push("asks different questions");
  const notices = (list: { text: string }[]) => list.map((n) => n.text).sort();
  if (JSON.stringify(notices(record.notices)) !== JSON.stringify(notices(turn.intents.notices))) differences.push(`tells you ${JSON.stringify(notices(turn.intents.notices))} instead of ${JSON.stringify(notices(record.notices))}`);
  if (Boolean(record.done) !== Boolean(turn.intents.done)) differences.push(turn.intents.done ? "now finishes the part" : "no longer finishes the part");
  if (record.waits !== null && !record.done) {
    // Compare declared waits, ignoring the schedule waits the runtime re-arms.
    const previous = await readJson<WaitingFile>(copy, paths.waiting(record.part));
    void previous;
    const declaredWant = record.waits.filter((w) => w.schedule === undefined && w.id.startsWith(`w${record.seq}.`));
    if (canonicalWaits(declaredWant) !== canonicalWaits(turn.intents.waits)) differences.push(`waits ${canonicalWaits(turn.intents.waits)} instead of ${canonicalWaits(declaredWant)}`);
  }
  void nextFire;
  if (differences.length) report.different.push({ seq: record.seq, part: record.part, event: record.event.type, differences });
  else report.same += 1;
}
