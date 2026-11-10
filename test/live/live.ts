// Helpers for the opt-in live tests (ATOLL_LIVE=1): an Archil client from the environment, a disk per
// test file that is deleted afterwards, and a ledger of what the tests spent. The ledger is JSON lines,
// appended one event at a time so test files running in parallel don't lose each other's entries. It
// lives at ATOLL_LIVE_LEDGER (default: the OS temp dir) and refuses exec calls past ATOLL_LIVE_EXEC_LIMIT
// (default 40), so a broken loop can't drain a Free plan's 1,000 calls.

import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archil, type Disk } from "disk";
import { ArchilStore } from "../../src/store/archil.ts";

export const LIVE = process.env.ATOLL_LIVE === "1";
export const LEDGER_FILE = process.env.ATOLL_LIVE_LEDGER ?? join(tmpdir(), "atoll-live-ledger.jsonl");
const EXEC_LIMIT = Number(process.env.ATOLL_LIVE_EXEC_LIMIT ?? 40);
/** At most this many disks of ours may exist at once. */
const DISK_LIMIT = 2;

export type LedgerEvent =
  | { kind: "disk-created"; id: string; name: string; at: string }
  | { kind: "disk-deleted"; id: string; name: string; at: string }
  | { kind: "exec"; label: string; at: string }
  | { kind: "sandbox-created"; id: string; name: string; at: string }
  | { kind: "sandbox-deleted"; id: string; name: string; at: string; runningMs?: number }
  | { kind: "note"; label: string; at: string; data: unknown };

export function ledger(): LedgerEvent[] {
  try {
    return readFileSync(LEDGER_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEvent);
  } catch {
    return [];
  }
}

function record(event: LedgerEvent): void {
  appendFileSync(LEDGER_FILE, `${JSON.stringify(event)}\n`);
}

const now = () => new Date().toISOString();

/** Count one exec call (a checkpoint is one too) before making it; throws past the limit. */
export function countExec(label: string): void {
  const used = ledger().filter((event) => event.kind === "exec").length;
  if (used >= EXEC_LIMIT) throw new Error(`Live exec budget used up (${used}/${EXEC_LIMIT} in ${LEDGER_FILE}); not running "${label}"`);
  record({ kind: "exec", label, at: now() });
}

export function sandboxCreated(id: string, name: string): void {
  record({ kind: "sandbox-created", id, name, at: now() });
}

export function sandboxDeleted(id: string, name: string, runningMs?: number): void {
  record(runningMs === undefined ? { kind: "sandbox-deleted", id, name, at: now() } : { kind: "sandbox-deleted", id, name, at: now(), runningMs });
}

/** Keep a test's measurements in the ledger, where they survive a reporter that hides console output. */
export function note(label: string, data: unknown): void {
  record({ kind: "note", label, at: now(), data });
}

export function liveArchil(): Archil {
  if (!process.env.ARCHIL_API_KEY || !process.env.ARCHIL_REGION) throw new Error("ATOLL_LIVE=1 needs ARCHIL_API_KEY and ARCHIL_REGION in the environment");
  return new Archil({ apiKey: process.env.ARCHIL_API_KEY, region: process.env.ARCHIL_REGION });
}

export interface LiveDisk {
  archil: Archil;
  disk: Disk;
  store: ArchilStore;
  name: string;
  /** Delete the disk (and with it every branch made from it). */
  cleanup(): Promise<void>;
}

/** Create a fresh disk named atoll-live-<label>-<random> and a store on it. */
export async function createLiveDisk(label: string): Promise<LiveDisk> {
  const archil = liveArchil();
  const ours = (await archil.disks.list()).filter((disk) => /^atoll-(live|measure)-/.test(disk.name));
  if (ours.length >= DISK_LIMIT) {
    throw new Error(`${ours.length} atoll test disks already exist (${ours.map((d) => `${d.name} ${d.id}`).join(", ")}); delete them before running more live tests`);
  }
  const name = `atoll-live-${label}-${Math.random().toString(36).slice(2, 8)}`;
  // The create result includes a one-time mount token; it is dropped here and never stored.
  const { disk } = await archil.disks.create({ name });
  record({ kind: "disk-created", id: disk.id, name, at: now() });
  const store = await ArchilStore.open({ disk: disk.id, archil });
  let deleted = false;
  return {
    archil,
    disk,
    store,
    name,
    async cleanup() {
      if (deleted) return;
      await disk.delete();
      deleted = true;
      record({ kind: "disk-deleted", id: disk.id, name, at: now() });
    },
  };
}

export function suffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
