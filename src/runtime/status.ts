// The five answers, STATUS.md, and `atoll why`: read entirely from files on the disk.

import { paths, type AskRecord, type JournalRecord, type Manifest, type OutboxEntry, type TurnRecord, type WaitingFile } from "../format.ts";
import { asText, type Store } from "../store/types.ts";
import type { SystemSpec } from "../system.ts";
import { readJson } from "./install.ts";
import { journalDays, readJournal } from "./journal.ts";
import { currentCodeVersion } from "./code.ts";
import type { FiveAnswers, WhyReport, WhyStep } from "./types.ts";

export async function openAsks(store: Store): Promise<AskRecord[]> {
  const asks: AskRecord[] = [];
  for (const entry of await store.list(paths.asksPrefix)) {
    const id = /^asks\/([^/]+)\.json$/.exec(entry.key)?.[1];
    if (!id || id.endsWith(".answer")) continue;
    const ask = await readJson<AskRecord>(store, entry.key);
    if (ask) asks.push(ask);
  }
  return asks.sort((a, b) => (a.at < b.at ? -1 : 1));
}

export async function waitingFiles(store: Store): Promise<WaitingFile[]> {
  const out: WaitingFile[] = [];
  for (const entry of await store.list("parts/")) {
    if (!entry.key.endsWith("/waiting.json")) continue;
    const file = await readJson<WaitingFile>(store, entry.key);
    if (file) out.push(file);
  }
  return out.sort((a, b) => (a.address < b.address ? -1 : 1));
}

async function recentRecords(store: Store, days = 3): Promise<JournalRecord[]> {
  const all = await journalDays(store);
  const from = all.at(-days);
  return (await readJournal(store, from)).records;
}

function summarize(record: TurnRecord): string {
  if (record.note) return record.note;
  const parts: string[] = [];
  if (record.writes.length || record.deletes.length) parts.push(`changed ${record.writes.length + record.deletes.length} file${record.writes.length + record.deletes.length === 1 ? "" : "s"}`);
  if (record.sends.length) parts.push(`sent ${record.sends.map((s) => `${s.type} to ${s.to}`).join(", ")}`);
  if (record.effects.length) parts.push(`asked for ${record.effects.map((e) => e.name).join(", ")}`);
  if (record.asks.length) parts.push(`asked you ${record.asks.length} question${record.asks.length === 1 ? "" : "s"}`);
  if (record.notices.length) parts.push(`told you ${record.notices.length} thing${record.notices.length === 1 ? "" : "s"}`);
  if (record.done) parts.push(`finished (${record.done})`);
  return parts.length ? `handled ${record.event.type}; ${parts.join("; ")}` : `handled ${record.event.type}; nothing changed`;
}

export async function fiveAnswers(store: Store, system?: SystemSpec): Promise<FiveAnswers> {
  const manifest = await readJson<Manifest>(store, paths.manifest);
  const charter = asText(await store.get(paths.charter)) ?? "";
  const records = await recentRecords(store);
  const turns = records.filter((r): r is TurnRecord => r.kind === "turn");
  const waiting = await waitingFiles(store);
  const partSpecs = system
    ? Object.entries(system.parts).map(([name, p]) => ({ name, purpose: p.purpose, instances: Boolean(p.instances) }))
    : Object.entries(manifest?.parts ?? {}).map(([name, p]) => ({ name, purpose: p.purpose, instances: p.instances }));
  const addresses = new Set<string>(waiting.map((w) => w.address));
  for (const p of partSpecs) if (!p.instances) addresses.add(p.name);
  const purposeOf = (address: string) => partSpecs.find((p) => p.name === address.split("/")[0])?.purpose ?? "";
  const evidenceMeta = (await store.list(paths.evidencePrefix)).filter((e) => e.key.endsWith(".json"));
  const latest: FiveAnswers["evidence"]["latest"] = [];
  for (const entry of evidenceMeta.slice(-200)) {
    const meta = await readJson<{ ref: string; source: string; at: string; size: number }>(store, entry.key);
    if (meta) latest.push({ ref: meta.ref, source: meta.source, at: meta.at, size: meta.size });
  }
  latest.sort((a, b) => (a.at > b.at ? -1 : 1));
  const outbox: OutboxEntry[] = [];
  for (const entry of await store.list(paths.outboxPrefix)) {
    if (!/^outbox\/[^/]+\.json$/.test(entry.key)) continue;
    const o = await readJson<OutboxEntry>(store, entry.key);
    if (o) outbox.push(o);
  }
  const inbox = (await store.list(paths.inboxPrefix)).filter((e) => /^inbox\/[^/]+\.json$/.test(e.key)).length;
  const next = asText(await store.get(paths.nextWake))?.trim();
  const last = records.at(-1);
  return {
    atoll: system?.name ?? manifest?.name ?? "(unnamed)",
    location: store.location,
    code: await currentCodeVersion(store),
    purpose: { charter, parts: [...addresses].sort().map((address) => ({ address, purpose: purposeOf(address) })) },
    changed: turns
      .slice(-10)
      .reverse()
      .map((t) => ({ seq: t.seq, at: t.at, part: t.part, summary: summarize(t), cause: `${t.event.type} from ${t.event.from}`, evidence: t.evidence })),
    waiting: waiting.map((w) => ({ address: w.address, status: w.status, waits: w.waits })),
    nextWake: next ? next : null,
    idle: waiting.filter((w) => w.status === "idle").map((w) => w.address),
    evidence: { count: evidenceMeta.length, latest: latest.slice(0, 5) },
    needs: { asks: await openAsks(store), outbox: outbox.filter((o) => o.state !== "pending" && o.state !== "started") },
    inbox,
    lastTurn: last ? { seq: last.seq, at: last.at } : null,
    counts: { checkpoints: (await store.list(paths.checkpointsPrefix)).length, branches: (await store.list(paths.branchesPrefix)).length },
  };
}

function describeWait(w: { until?: string; for?: string; ask?: string; reason: string }): string {
  if (w.until) return `until ${w.until} (${w.reason})`;
  if (w.for) return `for ${w.for} (${w.reason})`;
  return `for your answer to ${w.ask} (${w.reason})`;
}

export function renderAnswers(a: FiveAnswers): string {
  const lines: string[] = [];
  lines.push(`# ${a.atoll}`, "", `${a.location} · code ${a.code ?? "not pushed"} · ${a.lastTurn ? `last turn ${a.lastTurn.seq} at ${a.lastTurn.at}` : "no turns yet"}`, "");
  lines.push("## What it is trying to accomplish", "");
  const charter = a.purpose.charter.replace(/^# .*\n+/, "").split("\n## ")[0]!.trim();
  if (charter) lines.push(charter, "");
  for (const p of a.purpose.parts) lines.push(`- \`${p.address}\`: ${p.purpose}`);
  lines.push("", "## What changed, and why", "");
  if (a.changed.length === 0) lines.push("Nothing yet.");
  for (const c of a.changed) lines.push(`- ${c.at} · turn ${c.seq} · \`${c.part}\` ${c.summary} (because of ${c.cause})${c.evidence.length ? ` · ${c.evidence.length} receipt${c.evidence.length === 1 ? "" : "s"}` : ""}`);
  lines.push("", "## What it is waiting for", "");
  if (a.waiting.length === 0) lines.push("Nothing.");
  for (const w of a.waiting) {
    if (w.status === "done") lines.push(`- \`${w.address}\` is done.`);
    else if (w.status === "idle") lines.push(`- \`${w.address}\` is waiting for nothing. That is a bug: an unfinished part should say what it waits for.`);
    else lines.push(`- \`${w.address}\` waits ${w.waits.map(describeWait).join("; ")}`);
  }
  lines.push("", a.nextWake ? `The next timer is due at ${a.nextWake}. Something outside has to call \`atoll tick\` then; Archil has no timers of its own.` : "No timers are set.");
  if (a.inbox) lines.push("", `${a.inbox} event${a.inbox === 1 ? " is" : "s are"} in the inbox, waiting for the next tick.`);
  lines.push("", "## What evidence supports it", "");
  lines.push(`${a.evidence.count} receipt${a.evidence.count === 1 ? "" : "s"} under evidence/.`);
  for (const e of a.evidence.latest) lines.push(`- ${e.ref.slice(0, 19)}… from ${e.source} at ${e.at} (${e.size} bytes)`);
  lines.push("", "## What it needs from me", "");
  if (a.needs.asks.length === 0 && a.needs.outbox.length === 0) lines.push("Nothing right now.");
  for (const q of a.needs.asks) lines.push(`- **${q.id}**: ${q.question} Options: ${q.options.map((o) => o.id).join(", ")}${q.recommend ? `; I recommend ${q.recommend}` : ""}. If you don't answer by ${q.expires}: ${q.default}.`);
  for (const o of a.needs.outbox) lines.push(`- ${o.id} (${o.name}) is ${o.state}${o.ask ? `; see ${o.ask}` : ""}.`);
  if (a.counts.checkpoints || a.counts.branches) lines.push("", `This atoll has made ${a.counts.checkpoints} checkpoint${a.counts.checkpoints === 1 ? "" : "s"} and ${a.counts.branches} branch${a.counts.branches === 1 ? "" : "es"}; Archil can't delete them yet.`);
  return `${lines.join("\n")}\n`;
}

export async function renderStatus(store: Store, system?: SystemSpec): Promise<string> {
  return renderAnswers(await fiveAnswers(store, system));
}

// ---- why ------------------------------------------------------------------------------------------

function stepOf(record: JournalRecord): WhyStep {
  const step: WhyStep = { seq: record.seq, at: record.at, kind: record.kind, evidence: [] };
  if (record.kind === "turn") {
    step.part = record.part;
    step.event = { id: record.event.id, type: record.event.type, from: record.event.from, to: record.event.to, ...(record.event.cause ? { cause: record.event.cause } : {}) };
    if (record.note) step.note = record.note;
    step.evidence = [...record.evidence, ...(record.event.evidence ?? [])];
    step.code = record.code;
  } else if (record.kind === "effect") {
    step.part = record.deliver?.to;
    step.note = `${record.name} (${record.effect}) ${record.state}${record.error ? `: ${record.error}` : ""}`;
    step.evidence = record.evidence ?? [];
  } else if (record.kind === "answer") {
    step.note = `${record.by === "owner" ? "You answered" : "Nobody answered, so the default applied to"} ${record.ask}: ${record.option}`;
  } else if (record.kind === "merge") {
    step.note = `merged ${record.writes.length + record.deletes.length} file(s) from branch ${record.branch} for ${record.effect}`;
  } else if (record.kind === "push") {
    step.note = `code ${record.code} became current`;
    step.code = record.code;
  }
  return step;
}

/** Explain a file, an event, a turn, an effect, or an ask: the record that produced it and its causes. */
export async function why(store: Store, target: string): Promise<WhyReport> {
  const { records } = await readJournal(store);
  const handled = new Map<string, TurnRecord>();
  for (const r of records) if (r.kind === "turn") handled.set(r.event.id, r);
  let start: JournalRecord | undefined;
  if (/^\d+$/.test(target)) start = records.find((r) => r.seq === Number(target));
  else if (/^fx\d+\.\d+$/.test(target)) start = [...records].reverse().find((r) => r.kind === "effect" && r.effect === target);
  else if (/^q\d+\.\d+$/.test(target)) start = records.find((r) => (r.kind === "turn" && r.asks.some((a) => a.id === target)) || (r.kind === "effect" && r.ask?.id === target));
  else if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(target)) start = handled.get(target) ?? records.find((r) => r.kind === "turn" && r.sends.some((s) => s.id === target));
  else {
    const key = target.replace(/^\/+/, "");
    start = [...records].reverse().find((r) => (r.kind === "turn" || r.kind === "merge") && (r.writes.some((w) => w.path === key) || r.deletes.includes(key)));
    if (!start) start = [...records].reverse().find((r) => r.kind === "effect" && r.changed && [...r.changed.added, ...r.changed.modified, ...r.changed.deleted].some((p) => key.endsWith(p)));
  }
  if (!start) return { target, chain: [], complete: false };
  const chain: WhyStep[] = [stepOf(start)];
  let cursor: JournalRecord | undefined = start;
  const visited = new Set<number>([start.seq]);
  let complete = false;
  for (let i = 0; i < 100 && cursor; i++) {
    let next: JournalRecord | undefined;
    if (cursor.kind === "turn") {
      const event = cursor.event;
      if (/^fx\d+\.\d+$/.test(event.from)) {
        const outcome = [...records].reverse().find((r) => r.kind === "effect" && r.effect === event.from && r.seq < cursor!.seq && r.deliver);
        if (outcome && !visited.has(outcome.seq)) {
          chain.push(stepOf(outcome));
          visited.add(outcome.seq);
        }
      }
      if (event.cause) next = handled.get(event.cause);
      else complete = ["@owner", "@door", "@clock"].includes(event.from);
    } else if (cursor.kind === "effect") {
      const requester = records.find((r) => r.kind === "turn" && r.effects.some((e) => e.id === (cursor as { effect: string }).effect));
      next = requester;
    } else if (cursor.kind === "merge") {
      next = [...records].reverse().find((r) => r.kind === "effect" && r.effect === (cursor as { effect: string }).effect);
    } else {
      complete = true;
    }
    if (!next || visited.has(next.seq)) break;
    chain.push(stepOf(next));
    visited.add(next.seq);
    cursor = next;
    if (cursor.kind === "turn" && !cursor.event.cause && ["@owner", "@door", "@clock"].includes(cursor.event.from)) {
      complete = true;
      break;
    }
  }
  return { target, chain, complete };
}
