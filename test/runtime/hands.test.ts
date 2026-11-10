// Hands: exec effects scoped to the workspace, and commands as transactions (on a branch, merged back
// only when nothing else wrote the same files).

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSystem, why } from "../../src/index.ts";
import { testAtoll, type TestAtoll } from "../../src/testing.ts";
import { LocalHandsStore, LocalSnapshots } from "../../src/store/local-snapshots.ts";

const system = defineSystem({
  name: "hands",
  parts: {
    builder: {
      purpose: "Run the commands I give it against the workspace",
      on: {
        run: (t, e) => {
          t.effect(e.body.fork ? "shell.fork" : "shell", { command: e.body.command }, { then: "ran" });
          t.wait({ for: "ran", reason: "the command" });
        },
        ran: (t, e) => {
          t.write(`runs/${e.id}.json`, e.body);
        },
      },
    },
    editor: {
      purpose: "Write notes into the workspace directly, as a part, while commands run",
      on: {
        note: (t) => {
          // Parts write only their own directories; this one is used to show a conflict below.
          t.write("note.txt", "x");
        },
      },
    },
  },
  effects: {
    shell: { kind: "exec", scope: "workspace" },
    "shell.fork": { kind: "exec", scope: "workspace", fork: true },
  },
});

let s: TestAtoll | undefined;
let dir: string | undefined;
afterEach(async () => {
  await s?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  s = undefined;
  dir = undefined;
});

async function setup() {
  dir = await mkdtemp(join(tmpdir(), "atoll-hands-"));
  const root = join(dir, "atoll");
  const store = new LocalHandsStore(root);
  s = await testAtoll(system, { store, dir: root, realEffects: true, hands: store, snapshots: new LocalSnapshots(root) });
  return s;
}

describe("exec effects", () => {
  it("runs a command scoped to the workspace and records exactly what it changed", async () => {
    const s = await setup();
    await s.send("builder", "run", { command: "mkdir -p out && echo hello > out/a.txt && echo world > b.txt" });
    await s.tick();
    expect(await s.read("workspace/out/a.txt")).toBe("hello\n");
    const [run] = await s.list("parts/builder/runs/");
    const result = (await s.json(run!)).result;
    expect(result.exitCode).toBe(0);
    expect(result.changed).toEqual({ added: ["b.txt", "out/a.txt"], modified: [], deleted: [] });
    const effect = (await s.journal()).find((r) => r.kind === "effect" && (r as any).state === "done") as any;
    expect(effect.changed.added).toContain("out/a.txt");
    const chain = await why(s.store, "workspace/out/a.txt");
    expect(chain.chain[0]!.kind).toBe("effect");
  });

  it("can't reach outside its scope: the atoll's journal and lease aren't in the command's directory", async () => {
    const s = await setup();
    await s.send("builder", "run", { command: "ls -a; test ! -e journal && test ! -e .atoll && echo isolated" });
    await s.tick();
    const [run] = await s.list("parts/builder/runs/");
    expect((await s.json(run!)).result.stdout).toContain("isolated");
  });

  it("reports a failing command as a failed effect with its exit code", async () => {
    const s = await setup();
    await s.send("builder", "run", { command: "echo nope >&2; exit 3" });
    await s.tick();
    const [run] = await s.list("parts/builder/runs/");
    const body = await s.json(run!);
    expect(body.ok).toBe(false);
    expect(body.result.exitCode).toBe(3);
    expect(body.error).toContain("exit 3");
  });
});

describe("the environment commands see", () => {
  it("carries none of the runner's keys, as on Archil, so no command can write one into the atoll", async () => {
    const secrets = { ARCHIL_API_KEY: "key-0000hands0000test0000", ANTHROPIC_API_KEY: "sk-ant-hands-test-0000", OPENAI_API_KEY: "sk-hands-test-0000" };
    const saved = Object.fromEntries(Object.keys(secrets).map((name) => [name, process.env[name]]));
    Object.assign(process.env, secrets);
    try {
      const s = await setup();
      await s.send("builder", "run", { command: "env; command -v node > /dev/null && echo node-found" });
      await s.tick();
      const [run] = await s.list("parts/builder/runs/");
      const result = (await s.json(run!)).result;
      expect(result.stdout).toContain("PATH=");
      expect(result.stdout).toContain("node-found");
      await s.send("builder", "run", { command: "env > env.txt", fork: true });
      await s.tick();
      expect(await s.read("workspace/env.txt")).toContain("PATH=");
      // Every file in the atoll and its snapshots: results, evidence, the journal, the workspace.
      const names = (await readdir(dir!, { recursive: true })) as string[];
      const everything = (await Promise.all(names.map((name) => readFile(join(dir!, name), "utf8").catch(() => "")))).join("\n");
      for (const value of Object.values(secrets)) expect(everything).not.toContain(value);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("commands as transactions", () => {
  it("runs on a branch and merges the changes back when nothing else touched them", async () => {
    const s = await setup();
    await s.send("builder", "run", { command: "echo one > report.txt", fork: true });
    await s.tick();
    expect(await s.read("workspace/report.txt")).toBe("one\n");
    const merge = (await s.journal()).find((r) => r.kind === "merge") as any;
    expect(merge.writes.map((w: any) => w.path)).toEqual(["workspace/report.txt"]);
    const [run] = await s.list("parts/builder/runs/");
    expect((await s.json(run!)).result).toMatchObject({ merged: true, conflicts: [] });
    expect((await s.status()).counts.branches).toBe(1);
  });

  it("refuses to merge a file that changed on the main atoll while the command ran on its branch", async () => {
    dir = await mkdtemp(join(tmpdir(), "atoll-hands-"));
    const root = join(dir, "atoll");
    const main = new LocalHandsStore(root);
    // Another client rewrites workspace/report.txt on the main atoll while the forked command runs.
    class Racing extends LocalSnapshots {
      override async open(id: string) {
        const branch = await super.open(id);
        const exec = branch.exec.bind(branch);
        branch.exec = async (request) => {
          await main.put("workspace/report.txt", "concurrent\n");
          return exec(request);
        };
        return branch;
      }
    }
    s = await testAtoll(system, { store: main, dir: root, realEffects: true, hands: main, snapshots: new Racing(root) });
    await s.send("builder", "run", { command: "echo base > report.txt" });
    await s.tick();
    await s.send("builder", "run", { command: "echo forked > report.txt && echo extra > other.txt", fork: true });
    await s.tick();
    const runs = await Promise.all((await s.list("parts/builder/runs/")).map((p) => s!.json(p)));
    const forked = runs.find((r: any) => r.result?.branch);
    expect(forked.result.merged).toBe(false);
    expect(forked.result.conflicts).toEqual(["workspace/report.txt"]);
    // Nothing from the branch reached the main atoll: neither the conflicting file nor the clean one.
    expect(await s.read("workspace/report.txt")).toBe("concurrent\n");
    expect(await s.read("workspace/other.txt")).toBeNull();
    expect((await s.journal()).filter((r) => r.kind === "merge")).toEqual([]);
  });
});
