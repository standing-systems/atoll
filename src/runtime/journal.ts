// The journal: the atoll's write-ahead log. One append per record; the append is the commit point.

import { dayOf, decodeJournal, encodeRecord, paths, type Head, type JournalRecord } from "../format.ts";
import { asText, type Store } from "../store/types.ts";

export interface JournalRead {
  records: JournalRecord[];
  /** Lines that were torn or failed their CRC. */
  torn: number;
  /** Records written under an epoch older than one already seen: a stale runner's, and ignored. */
  stale: JournalRecord[];
}

/** The journal's day files, oldest first. */
export async function journalDays(store: Store): Promise<string[]> {
  const entries = await store.list(paths.journalPrefix);
  return entries
    .map((e) => /^journal\/(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(e.key)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort();
}

/** Read records from day files at or after `fromDay` (all of them when omitted), in sequence order. */
export async function readJournal(store: Store, fromDay?: string): Promise<JournalRead> {
  const days = (await journalDays(store)).filter((d) => !fromDay || d >= fromDay);
  const all: JournalRecord[] = [];
  let torn = 0;
  for (const day of days) {
    const text = asText(await store.get(paths.journalDay(day))) ?? "";
    const decoded = decodeJournal(text);
    all.push(...decoded.records);
    torn += decoded.torn;
  }
  all.sort((a, b) => a.seq - b.seq || a.epoch - b.epoch);
  const records: JournalRecord[] = [];
  const stale: JournalRecord[] = [];
  let maxEpoch = 0;
  const seen = new Set<number>();
  for (const record of all) {
    if (record.epoch < maxEpoch || seen.has(record.seq)) {
      stale.push(record);
      continue;
    }
    maxEpoch = Math.max(maxEpoch, record.epoch);
    seen.add(record.seq);
    records.push(record);
  }
  return { records, torn, stale };
}

export async function readHead(store: Store): Promise<Head | null> {
  const text = asText(await store.get(paths.head));
  if (!text) return null;
  try {
    return JSON.parse(text) as Head;
  } catch {
    return null;
  }
}

export class Journal {
  lastSeq = 0;
  private readonly days = new Set<string>();

  private readonly store: Store;
  readonly epoch: number;
  private readonly fence: () => Promise<void>;

  constructor(store: Store, epoch: number, fence: () => Promise<void>) {
    this.store = store;
    this.epoch = epoch;
    this.fence = fence;
  }

  nextSeq(): number {
    return this.lastSeq + 1;
  }

  /** Append one record. Its `seq` must be the next sequence number. Durable when this returns. */
  async append(record: JournalRecord): Promise<JournalRecord> {
    if (record.seq !== this.lastSeq + 1) throw new Error(`Journal sequence gap: expected ${this.lastSeq + 1}, got ${record.seq}`);
    const stamped = { ...record, epoch: this.epoch } as JournalRecord;
    const line = encodeRecord(stamped);
    if (line.length > 1_000_000) throw new Error(`Journal record ${record.seq} is ${line.length} bytes; one append holds at most 1 MiB`);
    const day = dayOf(record.at);
    if (!this.days.has(day)) {
      // Concurrent first appends to a missing object conflict, so each day's file is created first.
      await this.store.create(paths.journalDay(day), "");
      this.days.add(day);
    }
    await this.fence();
    await this.store.append(paths.journalDay(day), line);
    this.lastSeq = record.seq;
    return stamped;
  }
}
