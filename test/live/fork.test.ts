// Commands as transactions, live: an exec effect with fork: true checkpoints the real disk, branches it,
// runs the command on the branch in an Archil microVM, and merges back only if every file it touched
// still holds, on the main atoll, what the branch started from. The second case writes the same file on
// the main atoll through the object API while the command sleeps on its branch, and the merge must refuse.
//
// Opt in with ATOLL_LIVE=1. Costs four exec calls (a checkpoint and a command, twice) and one disk, which is
// deleted afterwards along with its branches.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineSystem } from "../../src/index.ts";
import { testAtoll, type TestAtoll } from "../../src/testing.ts";
import { asText } from "../../src/store/types.ts";
import { countExec, createLiveDisk, LIVE, note, type LiveDisk } from "./live.ts";

const system = defineSystem({
  name: "fork-live",
  parts: {
    builder: {
      purpose: "Run the commands I give it on a branch, and keep what merges",
      on: {
        run: (t, e) => {
          t.effect("shell.fork", { command: e.body.command }, { then: "ran" });
          t.wait({ for: "ran", reason: "the command on its branch" });
        },
        ran: (t, e) => {
          t.write(`runs/${e.id}.json`, e.body);
        },
      },
    },
  },
  effects: { "shell.fork": { kind: "exec", scope: "workspace", fork: true } },
});

describe.skipIf(!LIVE)("a forked command on Archil", () => {
  let live: LiveDisk;
  let s: TestAtoll;

  beforeAll(async () => {
    live = await createLiveDisk("fork");
    s = await testAtoll(system, { store: live.store, hands: live.store, snapshots: live.store, realEffects: true, now: new Date() });
  }, 120_000);

  afterAll(async () => {
    await s?.close();
    await live?.cleanup();
  }, 120_000);

  async function lastRun(): Promise<any> {
    const runs = await s.list("parts/builder/runs/");
    return s.json(runs.at(-1)!);
  }

  it("merges a command's changes back into the main atoll when nothing else touched them", async () => {
    countExec("fork: checkpoint (clean)");
    countExec("fork: command on the branch (clean)");
    s.setNow(new Date());
    await s.send("builder", "run", { command: "echo forked > report.txt" });
    const started = Date.now();
    await s.tick();
    const run = await lastRun();
    note("fork clean merge", { ms: Date.now() - started, branch: run.result?.branch });
    expect(run.ok).toBe(true);
    expect(run.result.merged).toBe(true);
    expect(run.result.branch).toMatch(/^dsk-/);
    expect(asText(await live.store.get("workspace/report.txt"))).toBe("forked\n");
    const merge = (await s.journal()).find((r) => r.kind === "merge") as any;
    expect(merge.writes.map((w: any) => w.path)).toEqual(["workspace/report.txt"]);
  }, 180_000);

  it("refuses to merge a file the main atoll changed while the command ran on its branch", async () => {
    countExec("fork: checkpoint (conflict)");
    countExec("fork: command on the branch (conflict)");
    s.setNow(new Date());
    // The command changes report.txt (it holds "forked" from the first case) and adds other.txt.
    await s.send("builder", "run", { command: "sleep 8 && echo second > report.txt && echo extra > other.txt" });
    // Write the same file on the main atoll while the command sleeps on its branch.
    const concurrent = new Promise<void>((resolve) => setTimeout(() => void live.store.put("workspace/report.txt", "concurrent\n").then(resolve), 5_000));
    const started = Date.now();
    await s.tick();
    await concurrent;
    const run = await lastRun();
    note("fork conflict", { ms: Date.now() - started, merged: run.result?.merged, conflicts: run.result?.conflicts });
    expect(run.result.merged).toBe(false);
    expect(run.result.conflicts).toContain("workspace/report.txt");
    expect(asText(await live.store.get("workspace/report.txt"))).toBe("concurrent\n");
    expect(await live.store.get("workspace/other.txt")).toBeNull();
  }, 180_000);
});
