// `atoll check`: what the compiler can't catch. The declaration, the six promises, and a live atoll's
// files measured against its journal.

import { sha256Hex } from "../ids.ts";
import { paths, type WriteOp } from "../format.ts";
import type { Store } from "../store/types.ts";
import { validateSystem, type SystemSpec } from "../system.ts";
import { readJournal } from "./journal.ts";
import { modelKey } from "./models.ts";
import { scheduleProblem } from "./schedule.ts";
import { waitingFiles } from "./status.ts";
import type { Problem } from "./types.ts";

/** Patterns in a bundle that break replay or bypass effects. Warnings: they may be in libraries. */
const SOURCE_RULES: { re: RegExp; code: string; message: string }[] = [
  { re: /\bfetch\s*\(/, code: "NETWORK_IN_CODE", message: "The code calls fetch(); network calls belong in an http effect so they are declared, budgeted, and recorded" },
  { re: /from\s*["']node:(http|https|net|tls|dgram)["']|require\(["']node:(http|https|net)["']\)/, code: "NETWORK_IN_CODE", message: "The code imports a network module; use an effect instead" },
  { re: /["']node:child_process["']|["']child_process["']/, code: "PROCESS_IN_CODE", message: "The code starts processes; use an exec effect so commands run in a microVM with a scoped mount" },
  { re: /\bDate\.now\s*\(|new Date\(\s*\)/, code: "CLOCK_IN_CODE", message: "The code reads the wall clock; handlers should use t.now so replays see the recorded time" },
  { re: /\bMath\.random\s*\(/, code: "RANDOM_IN_CODE", message: "The code uses Math.random(); replays can't reproduce it" },
];

export function checkSystem(system: SystemSpec, source?: string): Problem[] {
  const problems: Problem[] = validateSystem(system).map((p) => ({ severity: "error", ...p }));
  for (const [name, part] of Object.entries(system.parts ?? {})) {
    for (const [i, s] of (part.schedules ?? []).entries()) {
      const message = scheduleProblem(s, system.owner?.timezone);
      if (message) problems.push({ severity: "error", code: "BAD_SCHEDULE", where: `parts.${name}.schedules[${i}]`, message });
    }
  }
  for (const [name, effect] of Object.entries(system.effects ?? {})) {
    if (effect.kind === "model" && !effect.standIn && (!effect.model || effect.model === "stand-in")) problems.push({ severity: "error", code: "MODEL_WITHOUT_MODEL", where: `effects.${name}`, message: "A model effect needs a `model`, a `standIn`, or both" });
    if (effect.kind === "model" && effect.model && effect.model !== "stand-in" && !modelKey(effect.model)) {
      problems.push({ severity: "error", code: "BAD_MODEL", where: `effects.${name}`, message: `atoll can't call "${effect.model}": name the model as anthropic/<model> or openai/<model>, or as "stand-in" to always use the stand-in` });
    }
    if (effect.kind === "model" && !effect.budget) problems.push({ severity: "warning", code: "MODEL_WITHOUT_BUDGET", where: `effects.${name}`, message: "A model effect should declare a budget" });
    if (effect.kind === "custom" && effect.approval !== true && /send|email|post|reply|message|tweet|slack/i.test(name)) {
      problems.push({ severity: "warning", code: "SPEAKS_WITHOUT_APPROVAL", where: `effects.${name}`, message: "This effect's name suggests it speaks for the owner; such effects should set approval: true" });
    }
  }
  // Scan the handlers' own code, not the bundle: a fetch inside a custom effect's run is where it belongs.
  void source;
  for (const [name, part] of Object.entries(system.parts ?? {})) {
    for (const [type, handler] of Object.entries(part.on ?? {})) {
      const text = typeof handler === "function" ? Function.prototype.toString.call(handler) : "";
      for (const rule of SOURCE_RULES) {
        if (rule.re.test(text)) problems.push({ severity: "warning", code: rule.code, where: `parts.${name}.on.${type}`, message: rule.message });
      }
    }
  }
  return problems;
}

/** Check a live atoll's files against its journal. */
export async function checkAtoll(store: Store, system?: SystemSpec): Promise<Problem[]> {
  const problems: Problem[] = [];
  const read = await readJournal(store);
  if (read.torn) problems.push({ severity: "warning", code: "TORN_RECORDS", where: "journal/", message: `${read.torn} journal line(s) were torn or failed their checksum and are ignored` });
  if (read.stale.length) problems.push({ severity: "error", code: "STALE_RUNNER", where: "journal/", message: `${read.stale.length} record(s) were written by a runner whose lease had been taken over (sequence ${read.stale.map((r) => r.seq).join(", ")}); the authoritative history ignores them` });
  // The last write the journal made to each path under parts/.
  const expected = new Map<string, WriteOp | null>();
  for (const record of read.records) {
    if (record.kind !== "turn" && record.kind !== "merge") continue;
    for (const w of record.writes) if (w.path.startsWith("parts/")) expected.set(w.path, w);
    for (const d of record.deletes) if (d.startsWith("parts/")) expected.set(d, null);
  }
  for (const entry of await store.list("parts/")) {
    if (entry.key.endsWith("/waiting.json")) continue;
    const want = expected.get(entry.key);
    if (want === undefined) {
      problems.push({ severity: "error", code: "UNATTRIBUTED_FILE", where: entry.key, message: "No turn wrote this file; it was changed outside the atoll" });
      continue;
    }
    if (want === null) {
      problems.push({ severity: "error", code: "UNATTRIBUTED_FILE", where: entry.key, message: "The journal deleted this file, but it exists" });
      continue;
    }
    const bytes = await store.get(entry.key);
    if (bytes && sha256Hex(bytes) !== want.sha256) problems.push({ severity: "error", code: "UNATTRIBUTED_CHANGE", where: entry.key, message: "This file differs from what its last turn wrote; it was changed outside the atoll" });
  }
  for (const w of await waitingFiles(store)) {
    if (w.status === "idle") problems.push({ severity: "warning", code: "IDLE_WITHOUT_WAIT", where: w.address, message: "This part is neither done nor waiting for anything" });
    if (system) {
      const part = system.parts[w.address.split("/")[0]!];
      for (const wait of w.waits) {
        if (wait.until && wait.schedule === undefined && part && !part.on.timer) problems.push({ severity: "error", code: "TIMER_UNHANDLED", where: w.address, message: `It waits until ${wait.until}, but its part has no "timer" handler` });
        if (wait.for && part && !part.on[wait.for]) problems.push({ severity: "error", code: "WAIT_UNHANDLED", where: w.address, message: `It waits for "${wait.for}", which its part has no handler for` });
      }
    }
  }
  const dead = (await store.list("inbox/dead/")).length;
  if (dead) problems.push({ severity: "warning", code: "DEAD_LETTERS", where: "inbox/dead/", message: `${dead} event(s) could not be handled after repeated attempts` });
  if (!(await store.head(paths.format))) problems.push({ severity: "error", code: "NOT_AN_ATOLL", where: paths.format, message: "This location has no .atoll/format; it isn't an atoll" });
  return problems;
}
