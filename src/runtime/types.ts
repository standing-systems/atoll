// Types shared by the runner, the CLI, the door, and tests.

import type { Hands, Snapshots, Store } from "../store/types.ts";
import type { EffectSpec, AtollEvent, SystemSpec } from "../system.ts";
import type { AskRecord, JournalRecord, OutboxEntry, WaitOp } from "../format.ts";

/** Performs model calls for `model` effects. The stand-in answers deterministically without a network. */
export interface ModelProvider {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface ModelRequest {
  model: string;
  system?: string;
  prompt: string;
  /** A JSON schema the answer must match; the provider asks for JSON and the runner validates it. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface ModelResponse {
  text: string;
  json?: unknown;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Dollars, when the provider knows the price. */
  costUsd?: number;
  /** True when no real model answered (the stand-in). */
  standIn?: boolean;
}

/** In tests, replaces an effect's implementation. Receives the request's arguments. */
export type EffectStub = (args: any, ctx: { id: string; key: string; now: Date }) => unknown | Promise<unknown>;

export interface TickOptions {
  store: Store;
  /** The system to run. When omitted, the runner loads the current code from the disk. */
  system?: SystemSpec;
  /** The code version recorded in turn records when `system` is given directly. */
  codeVersion?: string;
  /** Untrusted compute for `exec` effects. */
  hands?: Hands;
  /** Checkpoints and branches, for `fork: true` effects and checkpoints after ticks. */
  snapshots?: Snapshots;
  /** Clock; defaults to the real one. */
  now?: () => Date;
  /** Identifies this runner in lease records. */
  runner?: string;
  /** Stop after this many turns in one tick (default 200). */
  maxTurns?: number;
  /** Lease time-to-live in milliseconds (default 60 s). */
  leaseTtlMs?: number;
  /** Effect implementations to use instead of the real ones, keyed by effect name. */
  stubs?: Record<string, EffectStub>;
  /** When true, an effect without a stub throws instead of running for real (tests). */
  stubsOnly?: boolean;
  models?: ModelProvider;
  fetch?: typeof fetch;
  /** Take a checkpoint after the tick if any turn committed (needs `snapshots`). */
  checkpoint?: boolean;
  /** Called after each committed record, for live output. */
  onRecord?: (record: JournalRecord) => void;
}

export interface TickReport {
  /** False when another runner holds the lease. */
  ran: boolean;
  heldBy?: string;
  epoch: number;
  turns: number;
  failures: number;
  duplicates: number;
  effects: { done: number; failed: number; inDoubt: number; awaitingApproval: number; overBudget: number };
  timersFired: number;
  answersApplied: number;
  recovered: { reinstalled: number; stagingCleared: number; inDoubt: number };
  /** Events still in the inbox when the tick stopped (the turn limit was reached). */
  remaining: number;
  nextWake: string | null;
  checkpoint?: string;
  lastSeq: number;
}

export interface FiveAnswers {
  atoll: string;
  location: string;
  code: string | null;
  /** 1. What is it trying to accomplish? */
  purpose: { charter: string; parts: { address: string; purpose: string }[] };
  /** 2. What changed, and why? Most recent first. */
  changed: { seq: number; at: string; part: string; summary: string; cause: string; evidence: string[] }[];
  /** 3. What is it waiting for? */
  waiting: { address: string; status: "waiting" | "done" | "idle"; waits: WaitOp[] }[];
  nextWake: string | null;
  /** Parts that are neither done nor waiting for anything. */
  idle: string[];
  /** 4. What evidence supports its state? */
  evidence: { count: number; latest: { ref: string; source: string; at: string; size: number }[] };
  /** 5. What does it need from me? */
  needs: { asks: AskRecord[]; outbox: OutboxEntry[] };
  inbox: number;
  lastTurn: { seq: number; at: string } | null;
  counts: { checkpoints: number; branches: number };
}

export interface WhyStep {
  seq: number;
  at: string;
  kind: string;
  part?: string;
  event?: Pick<AtollEvent, "id" | "type" | "from" | "to" | "cause">;
  note?: string;
  evidence: string[];
  code?: string;
}

export interface WhyReport {
  target: string;
  /** From the record that produced the target back to the first cause the journal holds. */
  chain: WhyStep[];
  /** True when the chain reached an event from outside (owner, clock, door), false when the record ran out. */
  complete: boolean;
}

export interface Problem {
  severity: "error" | "warning";
  code: string;
  where: string;
  message: string;
}

export type EffectSpecs = Record<string, EffectSpec>;
