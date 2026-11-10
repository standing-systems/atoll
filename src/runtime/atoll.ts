// Creating an atoll and pushing code to it.

import { FORMAT, paths, type JournalRecord } from "../format.ts";
import { asText, type Store } from "../store/types.ts";
import type { SystemSpec } from "../system.ts";
import { charterText, pushPlan } from "./code.ts";
import { withRunner } from "./runner.ts";
import type { TickOptions } from "./types.ts";

export interface AtollInfo {
  format: string | null;
  exists: boolean;
}

export async function atollInfo(store: Store): Promise<AtollInfo> {
  const format = asText(await store.get(paths.format))?.trim() ?? null;
  return { format, exists: format !== null };
}

/** Lay out an empty atoll: the format marker, a charter, and an empty workspace. Never overwrites. */
export async function createAtoll(store: Store, options: { name: string; charter?: string; system?: SystemSpec }): Promise<{ created: boolean }> {
  const created = await store.create(paths.format, `${FORMAT}\n`);
  const charter = options.system ? charterText({ ...options.system, ...(options.charter ? { charter: options.charter } : {}) }) : `# ${options.name}\n\n${options.charter ?? "(Say here, in your own words, what this atoll is for and what it must never do.)"}\n`;
  await store.create(paths.charter, charter);
  await store.create(`${paths.workspace}/.keep`, "Untrusted commands run here; their mounts are scoped to this directory.\n");
  return { created };
}

/**
 * Store a bundle on the disk (when given), make it current, and arm singleton schedules, as one push
 * record. Takes the lease like a tick, so it never races a runner.
 */
export async function push(
  options: Omit<TickOptions, "system" | "codeVersion"> & { system: SystemSpec; version: string; bundle?: Uint8Array; runtime?: Uint8Array },
): Promise<{ ran: true; seq: number; version: string; previous: string | null } | { ran: false; heldBy: string }> {
  const { store, system, version, bundle, runtime } = options;
  if (!(await atollInfo(store)).exists) await createAtoll(store, { name: system.name, system });
  if (bundle) {
    await store.create(paths.codeBundle(version), bundle);
    await store.put(paths.codeManifest(version), `${JSON.stringify({ version, name: system.name, bytes: bundle.byteLength }, null, 2)}\n`);
  }
  if (runtime) await store.put(paths.runtimeBin, runtime);
  const outcome = await withRunner({ ...options, system, codeVersion: version }, async (runner) => {
    const seq = runner.journal.nextSeq();
    const now = runner.now();
    const plan = await pushPlan(store, system, version, seq, now);
    await runner.record({
      v: 1,
      kind: "push",
      seq,
      epoch: runner.lease.epoch,
      at: now.toISOString(),
      code: version,
      ...(plan.previous ? { previous: plan.previous } : {}),
      parts: Object.keys(system.parts),
      writes: plan.writes,
      arm: plan.arm,
    } as JournalRecord);
    await runner.finish();
    return { seq, previous: plan.previous };
  });
  if (!outcome.ran) return { ran: false, heldBy: outcome.heldBy };
  return { ran: true, seq: outcome.value.seq, version, previous: outcome.value.previous };
}
