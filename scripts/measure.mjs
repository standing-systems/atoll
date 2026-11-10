#!/usr/bin/env node
// Reproduces the Archil numbers atoll's README quotes, against a fresh disk that is deleted afterwards,
// and prints them as markdown. Failures are counted and listed, never dropped, and every sample is in
// the percentiles (the connection's first request is measured on its own).
//
//   node scripts/measure.mjs                     object API, races, 5 exec round trips, a checkpoint, a branch
//   node scripts/measure.mjs --door              also a door's wake latency (needs dist/atoll.mjs; one sandbox)
//   node scripts/measure.mjs --out file.md       also write the markdown to a file
//
// Needs ARCHIL_API_KEY and ARCHIL_REGION in the environment. Costs 6 exec calls (at most 10), plus about
// a minute of sandbox time with --door. Never prints a credential.

import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { Archil, ArchilError, VERSION as SDK_VERSION } from "disk";
import { ArchilStore } from "../src/store/archil.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const EXEC_BUDGET = 10;
const N = 20;

if (!process.env.ARCHIL_API_KEY || !process.env.ARCHIL_REGION) {
  console.error("measure.mjs needs ARCHIL_API_KEY and ARCHIL_REGION in the environment");
  process.exit(2);
}
const region = process.env.ARCHIL_REGION;
const archil = new Archil({ apiKey: process.env.ARCHIL_API_KEY, region });

/** With ATOLL_LIVE_LEDGER set, spending goes into the live tests' ledger too (JSON lines). */
const ledger = (event) => {
  if (process.env.ATOLL_LIVE_LEDGER) appendFileSync(process.env.ATOLL_LIVE_LEDGER, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
};
let execCalls = 0;
const spend = (label) => {
  if (++execCalls > EXEC_BUDGET) throw new Error(`exec budget of ${EXEC_BUDGET} reached`);
  ledger({ kind: "exec", label: `measure: ${label}` });
};
const failures = [];
const rows = [];
const races = [];
const compute = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const describe = (error) => (error instanceof ArchilError ? `${error.status} ${error.code ?? ""} ${String(error.message).split("\n")[0]}`.trim() : String(error?.message ?? error));

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const ms = (value) => (Number.isFinite(value) ? value.toFixed(1) : "n/a");
const each = (samples) => (samples.length ? `${samples.map(ms).join(", ")} ms` : "no answer");

async function timed(fn) {
  const start = performance.now();
  try {
    const value = await fn();
    return { ok: true, ms: performance.now() - start, value };
  } catch (error) {
    return { ok: false, ms: performance.now() - start, error };
  }
}

/** Run `fn(i)` n times in sequence and add a latency row. */
async function series(label, n, fn, note = "") {
  const samples = [];
  let failed = 0;
  for (let i = 0; i < n; i++) {
    const t = await timed(() => fn(i));
    if (t.ok) samples.push(t.ms);
    else {
      failed += 1;
      failures.push(`${label} #${i + 1}: ${describe(t.error)}`);
    }
  }
  rows.push({ label, n, ok: samples.length, failed, p50: percentile(samples, 50), p90: percentile(samples, 90), min: Math.min(...samples), max: Math.max(...samples), note });
  return samples;
}

const started = new Date();
const name = `atoll-measure-${Math.random().toString(36).slice(2, 8)}`;
let disk;
let sandboxSeconds = 0;
let cleanup = async () => {};
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

try {
  const created = await timed(() => archil.disks.create({ name }));
  if (!created.ok) throw created.error;
  disk = created.value.disk; // the one-time mount token in the result is dropped, never stored
  ledger({ kind: "disk-created", id: disk.id, name });
  cleanup = async () => {
    if (!disk) return;
    const doomed = disk;
    disk = undefined;
    await doomed.delete().then(
      () => ledger({ kind: "disk-deleted", id: doomed.id, name }),
      (error) => failures.push(`deleting ${doomed.id}: ${describe(error)}`),
    );
  };
  const store = await ArchilStore.open({ disk: disk.id, archil });
  const first = await timed(() => store.head("m/first-request"));
  rows.push({ label: "first request on a new connection (HEAD, missing key)", n: 1, ok: first.ok ? 1 : 0, failed: first.ok ? 0 : 1, p50: first.ms, p90: first.ms, min: first.ms, max: first.ms, note: "TLS and HTTP/2 setup" });

  // ---- object API ----------------------------------------------------------------------------------
  const body = "x".repeat(1024);
  await series("put (1 KiB)", N, (i) => store.put(`m/obj/${String(i).padStart(2, "0")}.txt`, body));
  await series("get (1 KiB)", N, (i) => store.get(`m/obj/${String(i).padStart(2, "0")}.txt`));
  await series("head", N, (i) => store.head(`m/obj/${String(i).padStart(2, "0")}.txt`));
  await series("head, missing key", N, (i) => store.head(`m/missing/${i}`));
  await series("list (20 keys, recursive)", N, () => store.list("m/obj/"));
  await store.create("m/append.log", "");
  await series("append (120 B, existing key)", N, (i) => store.append("m/append.log", `${JSON.stringify({ i, pad: "y".repeat(100) })}\n`));
  await series("create-only put, uncontended", N, (i) => store.create(`m/create/${i}`, "c"));
  await series("delete", N, (i) => store.delete(`m/obj/${String(i).padStart(2, "0")}.txt`));

  // ---- races ---------------------------------------------------------------------------------------
  const createRounds = [];
  for (let round = 0; round < 3; round++) {
    const key = `m/race/create-${round}`;
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.create(key, `writer-${i}`).then((won) => (won ? "won" : "lost"), (error) => `error ${describe(error)}`)));
    const wall = performance.now() - t0;
    const won = results.filter((r) => r === "won").length;
    const lost = results.filter((r) => r === "lost").length;
    const errors = results.filter((r) => r.startsWith("error"));
    errors.forEach((e) => failures.push(`create race ${round + 1}: ${e}`));
    const winner = results.indexOf("won");
    const final = new TextDecoder().decode((await store.get(key)) ?? new Uint8Array());
    createRounds.push({ won, lost, errors: errors.length, wall, bodyIsWinners: final === `writer-${winner}` });
  }
  races.push({
    label: "create-only PUT (`If-None-Match: *`), 10 writers on one new key",
    rounds: createRounds.length,
    result:
      `winners per round: ${createRounds.map((r) => r.won).join(", ")}; 412s: ${createRounds.map((r) => r.lost).join(", ")}; ` +
      `errors: ${createRounds.reduce((n, r) => n + r.errors, 0)}; final body is the winner's: ${createRounds.every((r) => r.bodyIsWinners) ? "yes" : "NO"}; ` +
      `wall ${createRounds.map((r) => ms(r.wall)).join(", ")} ms`,
  });

  const appendRace = async (key, append) => {
    const lines = Array.from({ length: 20 }, (_, i) => `${JSON.stringify({ i, pad: "z".repeat(150 + i) })}\n`);
    const t0 = performance.now();
    const outcomes = await Promise.all(lines.map((line) => append(key, line).then(() => "ok", (error) => error)));
    const wall = performance.now() - t0;
    const text = new TextDecoder().decode((await store.get(key)) ?? new Uint8Array());
    const got = text.split("\n").filter(Boolean);
    const expected = new Set(lines.map((l) => l.trimEnd()));
    const whole = got.filter((l) => expected.has(l));
    const duplicates = whole.length - new Set(whole).size;
    const torn = got.length - whole.length;
    const okCount = outcomes.filter((o) => o === "ok").length;
    const errors = outcomes.filter((o) => o !== "ok");
    return { okCount, errors, landed: new Set(whole).size, duplicates, torn, wall };
  };
  await store.create("m/race/existing.jsonl", "");
  const existing = await appendRace("m/race/existing.jsonl", (key, line) => store.append(key, line));
  existing.errors.forEach((e) => failures.push(`append race, existing key: ${describe(e)}`));
  races.push({
    label: "append, 20 writers on an existing key",
    rounds: 1,
    result: `${existing.landed}/20 landed whole; ${existing.duplicates} duplicated; ${existing.torn} torn or interleaved; ${existing.errors.length} errors; wall ${ms(existing.wall)} ms`,
  });
  const raw = await appendRace("m/race/missing-raw.jsonl", (key, line) => disk.appendObject(key, line));
  const raced = raw.errors.filter((e) => e instanceof ArchilError && e.status === 409 && /created by another writer/i.test(e.message)).length;
  raw.errors.filter((e) => !(e instanceof ArchilError && e.status === 409)).forEach((e) => failures.push(`append race, missing key, raw: ${describe(e)}`));
  races.push({
    label: "append, 20 first writers on a missing key, raw SDK (no retry)",
    rounds: 1,
    result: `${raw.okCount}/20 succeeded and ${raw.landed} landed; ${raced} got 409 OperationAborted ("created by another writer"), and those wrote nothing; ${raw.duplicates} duplicated; ${raw.torn} torn; wall ${ms(raw.wall)} ms`,
  });
  const retried = await appendRace("m/race/missing-store.jsonl", (key, line) => store.append(key, line));
  retried.errors.forEach((e) => failures.push(`append race, missing key, ArchilStore: ${describe(e)}`));
  races.push({
    label: "append, 20 first writers on a missing key, ArchilStore (retries that 409)",
    rounds: 1,
    result: `${retried.landed}/20 landed whole; ${retried.duplicates} duplicated; ${retried.torn} torn; ${retried.errors.length} errors; wall ${ms(retried.wall)} ms`,
  });

  // ---- compute -------------------------------------------------------------------------------------
  const execSamples = [];
  const server = { total: [], queue: [], execute: [] };
  let execFailed = 0;
  for (let i = 0; i < 5; i++) {
    spend(`exec round trip ${i + 1}`);
    const t = await timed(() => store.exec({ command: "true" }));
    if (t.ok && t.value.exitCode === 0) {
      execSamples.push(t.ms);
      server.total.push(t.value.timing?.totalMs ?? NaN);
      server.queue.push(t.value.timing?.queueMs ?? NaN);
      server.execute.push(t.value.timing?.executeMs ?? NaN);
    } else {
      execFailed += 1;
      failures.push(`exec round trip #${i + 1}: ${t.ok ? `exit ${t.value.exitCode}: ${t.value.stderr.slice(0, 200)}` : describe(t.error)}`);
    }
  }
  compute.push({
    label: "exec round trip (`true`, whole disk, conditional mount)",
    n: 5,
    ok: execSamples.length,
    failed: execFailed,
    result: `p50 ${ms(percentile(execSamples, 50))}, p90 ${ms(percentile(execSamples, 90))}, min ${ms(Math.min(...execSamples))}, max ${ms(Math.max(...execSamples))}`,
    note: `server-side p50: total ${ms(percentile(server.total, 50))}, queue ${ms(percentile(server.queue, 50))}, execute ${ms(percentile(server.execute, 50))}`,
  });

  await store.put("m/cp/state.txt", "before the checkpoint");
  const cpName = `measure-${Date.now().toString(36)}`;
  spend("checkpoint");
  const cp = await timed(() => store.checkpoint(cpName));
  let readable = "not measured";
  if (cp.ok) {
    await store.put("m/cp/state.txt", "after the checkpoint");
    const read = await timed(() => store.readAt(cpName, "m/cp/state.txt", 90_000));
    const text = read.ok ? new TextDecoder().decode(read.value ?? new Uint8Array()) : null;
    readable = read.ok ? `readable with \`versionId\` ${(read.ms / 1000).toFixed(1)} s after the call returned (${text === "before the checkpoint" ? "old value, as expected" : `UNEXPECTED: ${text}`})` : `not readable: ${describe(read.error)}`;
    if (!read.ok) failures.push(`checkpoint read: ${describe(read.error)}`);
  } else failures.push(`checkpoint: ${describe(cp.error)}`);
  compute.push({ label: "checkpoint (one exec of `archil checkpoints create`)", n: 1, ok: cp.ok ? 1 : 0, failed: cp.ok ? 0 : 1, result: `${ms(cp.ms)} ms`, note: readable });

  if (cp.ok) {
    const br = await timed(() => store.branch(`measure-br-${Date.now().toString(36)}`, cpName));
    let note = "";
    if (br.ok) {
      const branchStore = await store.open(br.value.id);
      const read = await timed(() => branchStore.get("m/cp/state.txt"));
      const text = read.ok ? new TextDecoder().decode(read.value ?? new Uint8Array()) : null;
      note = `first read on the branch ${ms(read.ms)} ms (${text === "before the checkpoint" ? "checkpoint state" : `UNEXPECTED: ${text}`})`;
    } else failures.push(`branch: ${describe(br.error)}`);
    compute.push({ label: "branch from that checkpoint (`createBranch`)", n: 1, ok: br.ok ? 1 : 0, failed: br.ok ? 0 : 1, result: `${ms(br.ms)} ms`, note });
  }

  // ---- the door (opt in) ---------------------------------------------------------------------------
  if (flag("--door")) {
    const bundlePath = option("--bundle", "dist/atoll.mjs");
    const { doorUp, doorDown, readDoorCredential, callDoor } = await import("../src/door/sandbox.ts");
    const { loadProjectSystem, push } = await import("../src/index.ts");
    const { ulid } = await import("../src/ids.ts");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const work = await mkdtemp(join(tmpdir(), "atoll-measure-door-"));
    const atollName = `measure-${Math.random().toString(36).slice(2, 6)}`;
    const target = { archil, diskId: disk.id, atollName, doorsFile: join(work, "doors.json") };
    const t0 = performance.now();
    const previousCleanup = cleanup;
    const takeDown = async () => {
      const down = await doorDown(target).catch((error) => {
        failures.push(`door down: ${describe(error)}`);
        return null;
      });
      if (down?.sandboxId) ledger({ kind: "sandbox-deleted", id: down.sandboxId, name: `atoll-${atollName}-door`, runningMs: Math.round(performance.now() - t0) });
      await rm(work, { recursive: true, force: true });
    };
    cleanup = async () => {
      await takeDown();
      await previousCleanup();
    };
    try {
      // `atoll serve` needs an atoll on the disk: push a one-part system that counts pings.
      await writeFile(
        join(work, "system.ts"),
        `import { defineSystem } from "@standing-systems/atoll";
export default defineSystem({ name: ${JSON.stringify(atollName)}, parts: { counter: { purpose: "Count pings", on: {
  ping: async (t) => { const s = (await t.json("count.json")) ?? { n: 0 }; t.write("count.json", { n: s.n + 1 }); t.wait({ for: "ping", reason: "the next ping" }); },
} } } });
`,
      );
      const { system, bytes, version } = await loadProjectSystem(join(work, "system.ts"));
      await push({ store, system, version, bundle: bytes });
      const runtimeBundle = new Uint8Array(await readFile(bundlePath));
      const up = await timed(() => doorUp({ ...target, runtimeBundle, idleTtlSeconds: 60 }));
      if (!up.ok) throw up.error;
      ledger({ kind: "sandbox-created", id: up.value.sandboxId, name: up.value.name });
      const credential = await readDoorCredential(atollName, target.doorsFile);
      // One attempt per sample, capped at 30 s, so a hung request shows up as a failure, not a slow retry.
      const call = (path, body) =>
        callDoor({ hostname: credential.hostname, token: credential.token, path, attempts: 1, attemptTimeoutMs: 30_000, timeoutMs: 30_000, ...(body === undefined ? {} : { body }) });
      const sample = async (label, list, path, body) => {
        try {
          const r = await call(path, body);
          if (r.status === 200) {
            list.push(r.ms);
            return true;
          }
          failures.push(`${label}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        } catch (error) {
          failures.push(`${label}: ${describe(error)}`);
        }
        return false;
      };
      const warmHealth = [];
      for (let i = 0; i < 5; i++) await sample("door warm /healthz", warmHealth, "/healthz");
      const warmEvents = [];
      for (let i = 0; i < 3; i++) await sample("door warm POST /events", warmEvents, "/events", { to: "counter", type: "ping", id: ulid() });
      const sandbox = await archil.sandboxes.get(up.value.sandboxId);
      const pauses = [];
      const wakeHealth = [];
      const wakeEvents = [];
      const retries = [];
      for (const [label, list, path, body] of [
        ["door wake /healthz", wakeHealth, "/healthz", undefined],
        ["door wake /healthz", wakeHealth, "/healthz", undefined],
        ["door wake POST /events", wakeEvents, "/events", { to: "counter", type: "ping", id: ulid() }],
      ]) {
        const p = await timed(() => sandbox.pause());
        if (p.ok) pauses.push(p.ms);
        else failures.push(`door pause: ${describe(p.error)}`);
        await sleep(2000);
        if (!(await sample(label, list, path, body))) await sample(`${label}, retried at once`, retries, path, body);
      }
      const summary = (list) => `p50 ${ms(percentile(list, 50))}, max ${ms(Math.max(...list))}`;
      compute.push({ label: "door up (`doorUp`: copy the runtime, create the sandbox, start the service, wait for /healthz, mint a port token)", n: 1, ok: 1, failed: 0, result: `${ms(up.ms)} ms`, note: "1 vCPU, 1 GiB, node:24-bookworm" });
      compute.push({ label: "door, warm `GET /healthz` through the port token", n: 5, ok: warmHealth.length, failed: 5 - warmHealth.length, result: summary(warmHealth), note: "" });
      compute.push({ label: "door, warm `POST /events` (deliver, then a tick that runs one turn)", n: 3, ok: warmEvents.length, failed: 3 - warmEvents.length, result: summary(warmEvents), note: "the atoll's files are on the disk's FUSE mount" });
      compute.push({ label: "door, pause (`sandbox.pause()`)", n: 3, ok: pauses.length, failed: 3 - pauses.length, result: summary(pauses), note: "" });
      compute.push({ label: "door, paused sandbox woken by `GET /healthz`", n: 2, ok: wakeHealth.length, failed: 2 - wakeHealth.length, result: each(wakeHealth), note: "request sent 2 s after the pause returned" });
      compute.push({ label: "door, paused sandbox woken by `POST /events` (wake, deliver, tick)", n: 1, ok: wakeEvents.length, failed: 1 - wakeEvents.length, result: each(wakeEvents), note: "request sent 2 s after the pause returned" });
      if (retries.length || failures.some((f) => f.includes("retried at once"))) {
        const tried = retries.length + failures.filter((f) => f.includes("retried at once")).length;
        compute.push({ label: "door, a second request right after a wake request failed", n: tried, ok: retries.length, failed: tried - retries.length, result: each(retries), note: "each sample is one attempt, capped at 30 s" });
      }
    } catch (error) {
      failures.push(`door: ${describe(error)}`);
    } finally {
      await takeDown();
      cleanup = previousCleanup;
      sandboxSeconds = (performance.now() - t0) / 1000;
    }
  }
} catch (error) {
  failures.push(`fatal: ${describe(error)}`);
} finally {
  await cleanup();
}

const leftovers = (await archil.disks.list()).filter((d) => d.name === name);
const markdown = [
  `# Archil measurements, ${started.toISOString().slice(0, 10)}`,
  "",
  `Measured by \`scripts/measure.mjs\` on ${started.toISOString().replace(/\.\d+Z$/, "Z")} from ${platform()} ${release()},`,
  `against a fresh disk in \`${region}\` that the script deleted afterwards. Node ${process.version}, \`disk\` SDK ${SDK_VERSION}.`,
  "Times are milliseconds on the client, network included, unless marked server-side. Every sample is in the",
  "percentiles; failures are counted, and listed at the end.",
  "",
  "## Object API (sequential)",
  "",
  "| Operation | n | ok | failed | p50 | p90 | min | max | Notes |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ...rows.map((r) => `| ${r.label} | ${r.n} | ${r.ok} | ${r.failed} | ${ms(r.p50)} | ${ms(r.p90)} | ${ms(r.min)} | ${ms(r.max)} | ${r.note} |`),
  "",
  "## Races (concurrent)",
  "",
  "| Race | Rounds | Result |",
  "| --- | ---: | --- |",
  ...races.map((r) => `| ${r.label} | ${r.rounds} | ${r.result} |`),
  "",
  "## Compute and snapshots",
  "",
  "| Operation | n | ok | failed | Result | Notes |",
  "| --- | ---: | ---: | ---: | --- | --- |",
  ...compute.map((r) => `| ${r.label} | ${r.n} | ${r.ok} | ${r.failed} | ${r.result} | ${r.note} |`),
  "",
  "## Failures",
  "",
  ...(failures.length ? failures.map((f) => `- ${f}`) : ["None."]),
  "",
  "## Resources used",
  "",
  `- Disks: 1 created (\`${name}\`), ${leftovers.length ? "**NOT deleted**" : "deleted"}. Its checkpoint and branch went with it.`,
  `- Exec calls: ${execCalls} (budget ${EXEC_BUDGET}).`,
  `- Sandbox: ${flag("--door") ? `1, up for about ${sandboxSeconds.toFixed(0)} s wall time, deleted` : "none (run with --door to measure the door)"}.`,
  "",
].join("\n");

console.log(markdown);
const out = option("--out", "");
if (out) await writeFile(out, markdown);
process.exit(leftovers.length ? 1 : 0);
