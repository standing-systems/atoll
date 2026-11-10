// The atoll format, version 1: where things live on the disk, and the journal's record types.
// docs/a-place-to-stand.md, section 6, is the specification this file implements.

import { crc32 } from "./ids.ts";
import type { AskOption, AtollEvent } from "./system.ts";

export const FORMAT = "atoll/1";

export const paths = {
  format: ".atoll/format",
  charter: "CHARTER.md",
  status: "STATUS.md",
  manifest: "atoll.json",
  inbox: (id: string) => `inbox/${id}.json`,
  inboxPrefix: "inbox/",
  dead: (id: string) => `inbox/dead/${id}.json`,
  journalDay: (day: string) => `journal/${day}.jsonl`,
  journalPrefix: "journal/",
  part: (address: string) => `parts/${address}`,
  waiting: (address: string) => `parts/${address}/waiting.json`,
  ask: (id: string) => `asks/${id}.json`,
  askMd: (id: string) => `asks/${id}.md`,
  askAnswer: (id: string) => `asks/${id}.answer.json`,
  askClosed: (id: string) => `asks/closed/${id}.json`,
  asksPrefix: "asks/",
  outbox: (id: string) => `outbox/${id}.json`,
  outboxPrefix: "outbox/",
  notice: (day: string, id: string) => `notices/${day}/${id}.md`,
  noticesPrefix: "notices/",
  evidence: (hex: string) => `evidence/${hex.slice(0, 2)}/${hex}`,
  evidenceMeta: (hex: string) => `evidence/${hex.slice(0, 2)}/${hex}.json`,
  evidencePrefix: "evidence/",
  workspace: "workspace",
  codeBundle: (version: string) => `.atoll/code/${version}/system.mjs`,
  codeManifest: (version: string) => `.atoll/code/${version}/manifest.json`,
  codeCurrent: ".atoll/code/current",
  runtimeBin: ".atoll/bin/atoll.mjs",
  lease: (epoch: number) => `.atoll/lease/${String(epoch).padStart(20, "0")}`,
  leasePrefix: ".atoll/lease/",
  seen: (id: string) => `.atoll/seen/${id}`,
  seenPrefix: ".atoll/seen/",
  staging: (seq: number, n: number) => `.atoll/staging/${seq}/${n}`,
  stagingPrefix: ".atoll/staging/",
  head: ".atoll/head.json",
  timers: ".atoll/timers.json",
  nextWake: ".atoll/next-wake",
  meter: (month: string) => `.atoll/meter/${month}.json`,
  checkpoint: (name: string) => `.atoll/checkpoints/${name}.json`,
  checkpointsPrefix: ".atoll/checkpoints/",
  branch: (name: string) => `.atoll/branches/${name}.json`,
  branchesPrefix: ".atoll/branches/",
  door: ".atoll/door.json",
} as const;

/** "2026-11-04" for a time, in UTC. */
export function dayOf(at: Date | string): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** "2026-11" for a time, in UTC. */
export function monthOf(at: Date | string): string {
  return new Date(at).toISOString().slice(0, 7);
}

// ---- journal records ------------------------------------------------------------------------------

export interface WriteOp {
  path: string;
  sha256: string;
  size: number;
  /** Inline content: UTF-8 text... */
  text?: string;
  /** ...or base64 for binary content. */
  b64?: string;
  /** Or the staging key holding content too large to inline. */
  staged?: string;
}

export interface SendOp {
  id: string;
  to: string;
  type: string;
  body: unknown;
  evidence?: string[];
}

export interface EffectOp {
  id: string;
  name: string;
  kind: string;
  args: unknown;
  then: string;
  key: string;
  approval: boolean;
  idempotent: boolean;
  /** The part instance that requested it, which receives the result. */
  for: string;
}

export interface WaitOp {
  id: string;
  until?: string;
  for?: string;
  ask?: string;
  reason: string;
  /** Set for waits the runtime arms from a declared schedule. */
  schedule?: number;
}

export interface AskRecord {
  id: string;
  from: string;
  question: string;
  why: string;
  options: AskOption[];
  recommend?: string;
  default: string;
  expires: string;
  payload?: unknown;
  evidence?: string[];
  at: string;
  /** The event handled by the turn that asked. */
  cause?: string;
  /** Present when the runner opened this ask about an effect rather than a part asking it. */
  effect?: { id: string; reason: "approval" | "in-doubt" | "over-budget" };
}

export interface NoticeOp {
  id: string;
  text: string;
  evidence?: string[];
}

interface RecordBase {
  v: 1;
  seq: number;
  epoch: number;
  at: string;
  crc?: string;
}

export interface TurnRecord extends RecordBase {
  kind: "turn";
  code: string;
  event: AtollEvent;
  part: string;
  writes: WriteOp[];
  deletes: string[];
  sends: SendOp[];
  effects: EffectOp[];
  /** Waits after this turn (the instance's complete set), or null when unchanged. */
  waits: WaitOp[] | null;
  done?: string;
  asks: AskRecord[];
  notices: NoticeOp[];
  evidence: string[];
  note?: string;
}

export type EffectState = "started" | "done" | "failed" | "in-doubt" | "awaiting-approval" | "approved" | "denied" | "over-budget" | "dropped";

export interface EffectRecord extends RecordBase {
  kind: "effect";
  effect: string;
  name: string;
  state: EffectState;
  /** The result event this outcome delivers to the requesting part, if any. */
  deliver?: AtollEvent;
  /** A question this outcome opens for the owner (approval, in doubt, over budget). */
  ask?: AskRecord;
  error?: string;
  evidence?: string[];
  cost?: { usd?: number; calls?: number };
  /** For "approved": the ask answer that authorized it, and the arguments it will run with. */
  approvedBy?: string;
  args?: unknown;
  /** For exec effects: the files the command changed, under its scope. */
  changed?: { added: string[]; modified: string[]; deleted: string[] };
}

export interface FailureRecord extends RecordBase {
  kind: "failure";
  event: AtollEvent;
  attempt: number;
  error: string;
  dead: boolean;
  /** When dead, the notice that tells the owner. */
  notice?: NoticeOp;
}

export interface DuplicateRecord extends RecordBase {
  kind: "duplicate";
  event: string;
}

export interface PushRecord extends RecordBase {
  kind: "push";
  code: string;
  previous?: string;
  parts: string[];
  /** The manifest, the current-code pointer, and a charter if the atoll had none. */
  writes: WriteOp[];
  /** Schedule timers to arm for singleton parts that aren't waiting yet. */
  arm: { address: string; waits: WaitOp[] }[];
}

export interface CheckpointRecord extends RecordBase {
  kind: "checkpoint";
  name: string;
  reason: string;
}

export interface MergeRecord extends RecordBase {
  kind: "merge";
  effect: string;
  branch: string;
  checkpoint: string;
  writes: WriteOp[];
  deletes: string[];
}

export interface AnswerRecord extends RecordBase {
  kind: "answer";
  ask: string;
  option: string;
  payload?: unknown;
  by: "owner" | "expiry";
  /** The event delivered to the asking part, if any. */
  deliver?: AtollEvent;
}

export type JournalRecord =
  | TurnRecord
  | EffectRecord
  | FailureRecord
  | DuplicateRecord
  | PushRecord
  | CheckpointRecord
  | MergeRecord
  | AnswerRecord;

/** Serialize a record as one journal line, with its CRC. */
export function encodeRecord(record: JournalRecord): string {
  const { crc: _drop, ...rest } = record;
  const body = JSON.stringify(rest);
  return `${JSON.stringify({ ...rest, crc: crc32(body) })}\n`;
}

/** Parse journal text into records, skipping lines that are torn or fail their CRC. */
export function decodeJournal(text: string): { records: JournalRecord[]; torn: number } {
  const records: JournalRecord[] = [];
  let torn = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JournalRecord;
      const { crc, ...rest } = parsed;
      if (!crc || crc32(JSON.stringify(rest)) !== crc) {
        torn += 1;
        continue;
      }
      records.push(parsed);
    } catch {
      torn += 1;
    }
  }
  return { records, torn };
}

export interface Head {
  seq: number;
  installed: number;
  epoch: number;
  day: string;
  code?: string;
}

export interface TimerEntry {
  /** The part instance that waits. */
  address: string;
  wait: string;
  until: string;
  reason: string;
  /** The event type to deliver (schedules), or "timer". */
  type: string;
  body?: unknown;
  schedule?: number;
  /** The event handled by the turn that declared this wait. */
  cause?: string;
}

export interface WaitingFile {
  address: string;
  status: "waiting" | "done" | "idle";
  waits: WaitOp[];
  done?: string;
  since: string;
  /** The turn that last changed this file. */
  seq: number;
}

export interface OutboxEntry {
  id: string;
  name: string;
  kind: string;
  for: string;
  args: unknown;
  then: string;
  key: string;
  state: EffectState | "pending";
  approval: boolean;
  idempotent: boolean;
  ask?: string;
  requestedAt: string;
  seq: number;
  updatedAt: string;
  error?: string;
  /** The event whose turn requested this effect. */
  cause?: string;
}

export interface Manifest {
  format: string;
  name: string;
  code: string;
  pushedAt: string;
  owner?: { name?: string; timezone?: string };
  parts: Record<string, { purpose: string; instances: boolean; handles: string[]; schedules: { every?: string; cron?: string; tz?: string; send: string }[] }>;
  effects: Record<string, { kind: string; approval: boolean; idempotent?: boolean; budget?: unknown; allow?: string[]; scope?: string; fork?: boolean; model?: string }>;
}
