// The door, end to end, against the real service and through the built CLI (dist/atoll.mjs): create an
// atoll on a fresh disk, push a one-part system, bring the door up, POST an event through the port
// token, and check the turn through the object API and `atoll log`. Then pause the sandbox, POST again
// and time the wake. While the door is up, and again while it is paused, the laptop reads the atoll
// (`atoll status`) and delivers to it (`atoll send`) through the object API, and a door /tick must
// handle what was sent. Finally the door comes down and the disk is deleted.
//
// Opt in with ATOLL_LIVE=1 after `node build.mjs`. Costs one exec call (push's checkpoint) and one
// sandbox for about a minute. Port tokens stay in a temporary doors.json, never on the disk or in output.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callDoor, doorName, readDoorCredential, stopAndDelete } from "../../src/door/sandbox.ts";
import { readJournal } from "../../src/index.ts";
import { paths, type TurnRecord } from "../../src/format.ts";
import { ulid } from "../../src/ids.ts";
import { asText } from "../../src/store/types.ts";
import { countExec, createLiveDisk, LIVE, note, sandboxCreated, sandboxDeleted, type LiveDisk } from "./live.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE = join(REPO, "dist", "atoll.mjs");
const READY = LIVE && existsSync(BUNDLE);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CliResult {
  code: number;
  json: any;
  stderr: string;
  ms: number;
}

describe.skipIf(!READY)("door live, through the CLI", () => {
  const atollName = `door-e2e-${Math.random().toString(36).slice(2, 6)}`;
  let live: LiveDisk;
  let project: string;
  let doorsFile: string;
  let sandboxId: string | undefined;
  let sandboxStarted = 0;

  /** Run the built CLI in the project directory with --json, and parse what it prints. */
  function cli(...args: string[]): Promise<CliResult> {
    const started = performance.now();
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [BUNDLE, ...args, "--json"],
        { cwd: project, env: { ...process.env, ATOLL_DOORS_FILE: doorsFile }, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
        (error, stdout, stderr) => {
          let json: any;
          try {
            json = JSON.parse(stdout);
          } catch {
            json = undefined;
          }
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0;
          resolve({ code, json, stderr: stderr.slice(0, 2000), ms: performance.now() - started });
        },
      );
    });
  }

  async function turnsFor(eventId: string, timeoutMs = 20_000): Promise<TurnRecord[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { records } = await readJournal(live.store);
      const turns = records.filter((r): r is TurnRecord => r.kind === "turn" && r.event.id === eventId);
      if (turns.length || Date.now() > deadline) return turns;
      await sleep(500);
    }
  }

  beforeAll(async () => {
    live = await createLiveDisk("door");
    project = await mkdtemp(join(tmpdir(), "atoll-door-e2e-"));
    doorsFile = join(project, "doors.json");
    await symlink(join(REPO, "node_modules"), join(project, "node_modules"), "dir");
    await writeFile(
      join(project, "system.ts"),
      `import { defineSystem } from "@standing-systems/atoll";
export default defineSystem({
  name: ${JSON.stringify(atollName)},
  parts: {
    counter: {
      purpose: "Count the pings I send",
      on: {
        ping: async (t) => {
          const state = (await t.json<{ n: number }>("count.json")) ?? { n: 0 };
          t.write("count.json", { n: state.n + 1 });
          t.wait({ for: "ping", reason: "the next ping" });
        },
      },
    },
  },
});
`,
    );
  }, 120_000);

  afterAll(async () => {
    // Whatever happened above, leave no sandbox and no disk behind.
    if (live) {
      const leftovers = (await live.archil.sandboxes.list()).filter((s) => s.name === doorName(atollName) && s.status !== "deleted");
      for (const sandbox of leftovers) {
        await stopAndDelete(sandbox).catch((error: unknown) => console.error(`[door e2e] cleanup of ${sandbox.id} failed: ${String(error)}`));
        sandboxDeleted(sandbox.id, sandbox.name, sandboxStarted ? Date.now() - sandboxStarted : undefined);
      }
      await live.cleanup();
    }
    if (project) await rm(project, { recursive: true, force: true });
  }, 180_000);

  it("serves, sleeps, wakes, and shares the disk with the laptop", async () => {
    // ---- an atoll with code, made by the CLI --------------------------------------------------------
    const created = await cli("create", atollName, "--disk", live.name);
    expect(created.code, created.stderr).toBe(0);
    expect(created.json).toMatchObject({ disk: live.disk.id, created: true });
    countExec("live door: push's checkpoint");
    const pushed = await cli("push", "--disk", live.name);
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.json).toMatchObject({ pushed: true });
    expect(await live.store.head(paths.runtimeBin)).not.toBeNull();

    // ---- the door comes up ---------------------------------------------------------------------------
    sandboxStarted = Date.now();
    const up = await cli("door", "up", "--disk", live.name);
    expect(up.code, up.stderr).toBe(0);
    sandboxId = up.json.up.sandboxId as string;
    sandboxCreated(sandboxId, up.json.up.name);
    expect(up.json.up.name).toBe(doorName(atollName));

    // The token is only in doors.json, mode 0600; the record on the disk has none.
    const credential = (await readDoorCredential(atollName, doorsFile))!;
    expect(credential.sandboxId).toBe(sandboxId);
    expect((await stat(doorsFile)).mode & 0o777).toBe(0o600);
    const record = asText(await live.store.get(paths.door))!;
    expect(JSON.parse(record)).toMatchObject({ sandboxId, name: doorName(atollName), port: 8080 });
    // This atoll declares no hosts and calls no models. On a plan that can set a network policy its door
    // reaches nothing but Archil's endpoints for the disk, so everything below also shows the mount works
    // under that policy. On the Free plan it is on Archil's managed allowlist.
    const network = up.json.up.network as { egress: string };
    expect(network).toEqual(network.egress === "declared" ? { egress: "declared", allow: [], brokered: [] } : { egress: "managed", allow: [], brokered: [] });
    expect(JSON.parse(record).network).toEqual(network);
    expect(record).not.toContain(credential.token);
    const call = (path: string, body?: unknown) => callDoor({ hostname: credential.hostname, token: credential.token, path, ...(body === undefined ? {} : { body }) });
    const noToken = await callDoor({ hostname: credential.hostname, path: "/status" });
    expect([401, 403]).toContain(noToken.status);

    // ---- an event through the door, checked through the object API and the CLI -----------------------
    const first = ulid();
    const called = await cli("door", "call", "/events", JSON.stringify({ to: "counter", type: "ping", id: first }), "--disk", live.name);
    expect(called.code, called.stderr).toBe(0);
    expect(called.json.response).toMatchObject({ status: 200, body: { id: first, duplicate: false, report: { ran: true, turns: 1, failures: 0 } } });
    const firstTurns = await turnsFor(first);
    expect(firstTurns).toHaveLength(1);
    expect(firstTurns[0]!.event.from).toBe("@door");
    const log = await cli("log", "--disk", live.name);
    expect(log.code, log.stderr).toBe(0);
    expect((log.json.records as TurnRecord[]).some((r) => r.kind === "turn" && r.event?.id === first)).toBe(true);
    const warm = await call("/events", { to: "counter", type: "ping", id: ulid() });
    expect(warm.status).toBe(200);

    // The laptop reads the atoll while the door's sandbox has it mounted.
    const statusRunning = await cli("status", "--disk", live.name);
    expect([0, 1], statusRunning.stderr).toContain(statusRunning.code);
    expect(statusRunning.json.answers).toMatchObject({ atoll: atollName });

    // ---- pause, then wake with an event ------------------------------------------------------------
    const sandbox = await live.archil.sandboxes.get(sandboxId);
    let started = Date.now();
    await sandbox.pause();
    const pauseMs = Date.now() - started;
    expect(sandbox.status).toBe("paused");
    await sleep(2000);
    const second = ulid();
    const woken = await call("/events", { to: "counter", type: "ping", id: second });
    expect(woken.status, JSON.stringify(woken.body)).toBe(200);
    expect(woken.body).toMatchObject({ id: second, duplicate: false, report: { ran: true, turns: 1 } });
    expect(await turnsFor(second)).toHaveLength(1);
    await sandbox.refresh();
    expect(sandbox.status).toBe("running");
    const redelivered = await call("/events", { to: "counter", type: "ping", id: second });
    expect(redelivered.body).toMatchObject({ id: second, duplicate: true });

    // ---- the laptop delivers while the door is paused, and a door tick handles it -------------------
    started = Date.now();
    await sandbox.pause();
    const secondPauseMs = Date.now() - started;
    const statusPaused = await cli("status", "--disk", live.name);
    expect([0, 1], statusPaused.stderr).toContain(statusPaused.code);
    const sent = await cli("send", "counter", "ping", "--disk", live.name);
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.json).toMatchObject({ duplicate: false });
    await sandbox.refresh();
    const stillPaused = sandbox.status;
    const ticked = await call("/tick", {});
    expect(ticked.status, JSON.stringify(ticked.body)).toBe(200);
    const tickTurns = (ticked.body as { turns?: number }).turns ?? 0;
    const sentTurns = await turnsFor(sent.json.id as string, tickTurns ? 20_000 : 1_000);
    let retick: { status: number; turns?: number } | undefined;
    if (!sentTurns.length) {
      // Record whether a later tick catches up, for the report.
      await sleep(5000);
      const again = await call("/tick", {});
      retick = { status: again.status, turns: (again.body as { turns?: number }).turns };
    }
    const sentHandled = (await turnsFor(sent.json.id as string, 1_000)).length === 1;
    expect(JSON.parse(asText(await live.store.get("parts/counter/count.json"))!)).toEqual({ n: sentHandled ? 4 : 3 });

    // ---- the door comes down ------------------------------------------------------------------------
    const down = await cli("door", "down", "--disk", live.name);
    const wallMs = Date.now() - sandboxStarted;
    expect(down.code, down.stderr).toBe(0);
    sandboxDeleted(sandboxId, doorName(atollName), wallMs);
    expect(down.json.down).toEqual({ removed: true, sandboxId });
    sandboxId = undefined;
    expect(await live.store.get(paths.door)).toBeNull();
    expect(await readDoorCredential(atollName, doorsFile)).toBeNull();
    expect((await live.archil.sandboxes.list()).filter((s) => s.name === doorName(atollName) && s.status !== "deleted")).toEqual([]);

    const summary = {
      cliMs: { create: Math.round(created.ms), push: Math.round(pushed.ms), doorUp: Math.round(up.ms), doorCall: Math.round(called.ms), statusRunning: Math.round(statusRunning.ms), statusPaused: Math.round(statusPaused.ms), send: Math.round(sent.ms), doorDown: Math.round(down.ms) },
      warmPostMs: Math.round(warm.ms),
      pauseMs,
      secondPauseMs,
      wokenPostMs: Math.round(woken.ms),
      wokenTickMs: Math.round(ticked.ms),
      statusWhilePaused: stillPaused,
      sendWhilePausedThenTick: { tickTurns, handled: sentHandled, retick },
      sandboxWallMs: wallMs,
    };
    note("door e2e", summary);
    console.log(`[door e2e] ${JSON.stringify(summary)}`);
    // Asserted last, so the timings above are reported either way.
    expect(sentHandled, "a door tick didn't handle an event the laptop sent through the object API").toBe(true);
  }, 300_000);
});
