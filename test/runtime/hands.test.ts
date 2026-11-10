// Hands: exec effects scoped to the workspace, and commands as transactions (on a branch, merged back
// only when nothing else wrote the same files). Also the two things a command over a big tree needs:
// directories the runner doesn't look into, and a trial whose changes stay on its branch.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSystem, validateSystem, why } from "../../src/index.ts";
import { LocalStore } from "../../src/store/local.ts";
import { testAtoll, type TestAtoll } from "../../src/testing.ts";
import { LocalHandsStore, LocalSnapshots } from "../../src/store/local-snapshots.ts";

const system = defineSystem({
  name: "hands",
  parts: {
    builder: {
      purpose: "Run the commands I give it against the workspace",
      on: {
        run: (t, e) => {
          t.effect(e.body.effect ?? (e.body.fork ? "shell.fork" : "shell"), { command: e.body.command }, { then: "ran" });
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
    // "deps" stands for a directory like node_modules: big, rebuilt by commands, and nobody's to read.
    "shell.quiet": { kind: "exec", scope: "workspace", ignore: ["deps"] },
    "shell.fork.quiet": { kind: "exec", scope: "workspace", fork: true, ignore: ["deps"] },
    "shell.trial": { kind: "exec", scope: "workspace", fork: true, merge: false, ignore: ["deps"] },
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

describe("commands over a big tree", () => {
  const runs = async (s: TestAtoll) => Promise.all((await s.list("parts/builder/runs/")).map((path) => s.json(path)));

  it("doesn't look into the directories an effect ignores, at any depth", async () => {
    const s = await setup();
    await s.send("builder", "run", { effect: "shell.quiet", command: "mkdir -p deps/a src/deps && echo 1 > deps/a/b.txt && echo 2 > src/deps/c.txt && echo 3 > src/main.txt && echo 4 > out.txt" });
    await s.tick();
    const [run] = await runs(s);
    expect(run.result.exitCode).toBe(0);
    expect(run.result.changed).toEqual({ added: ["out.txt", "src/main.txt"], modified: [], deleted: [] });
    // The command still wrote them; the runner only didn't walk them.
    expect(await s.read("workspace/deps/a/b.txt")).toBe("1\n");
    expect(await s.read("workspace/src/deps/c.txt")).toBe("2\n");
    // Without `ignore`, the same command reports every file.
    await s.send("builder", "run", { command: "echo 5 > deps/a/d.txt" });
    await s.tick();
    expect((await runs(s)).map((r) => r.result.changed.added)).toContainEqual(["deps/a/d.txt"]);
  });

  it("merges what a forked command changed, and leaves what it ignores on the branch", async () => {
    const s = await setup();
    await s.send("builder", "run", { effect: "shell.fork.quiet", command: "echo one > report.txt && mkdir -p deps && echo big > deps/blob.bin" });
    await s.tick();
    const [run] = await runs(s);
    expect(run.result).toMatchObject({ merged: true, conflicts: [], changed: { added: ["report.txt"] } });
    expect(await s.read("workspace/report.txt")).toBe("one\n");
    expect(await s.read("workspace/deps/blob.bin")).toBeNull();
    expect(new TextDecoder().decode((await new LocalStore(run.result.branch).get("workspace/deps/blob.bin"))!)).toBe("big\n");
  });

  it("leaves a trial's changes on its branch, and records the branch whether the command passed or failed", async () => {
    const s = await setup();
    await s.send("builder", "run", { command: "echo base > report.txt" });
    await s.tick();
    await s.send("builder", "run", { effect: "shell.trial", command: "echo tried > report.txt && echo new > extra.txt && mkdir -p deps && echo x > deps/y.txt" });
    await s.tick();
    const passed = (await runs(s)).find((r) => r.result.branch);
    expect(passed.ok).toBe(true);
    expect(passed.result).toMatchObject({ exitCode: 0, merged: false, kept: true, changed: { added: ["extra.txt"], modified: ["report.txt"], deleted: [] } });
    expect(passed.result).not.toHaveProperty("conflicts");
    // The main atoll is as it was, and no merge was journaled. The effect claims no change to its files.
    expect(await s.read("workspace/report.txt")).toBe("base\n");
    expect(await s.read("workspace/extra.txt")).toBeNull();
    expect((await s.journal()).filter((r) => r.kind === "merge")).toEqual([]);
    const done = (await s.journal()).filter((r) => r.kind === "effect" && (r as any).state === "done") as any[];
    expect(done.at(-1).changed).toBeUndefined();
    // What it did is on the branch, ignored directories included.
    const branch = new LocalStore(passed.result.branch);
    expect(new TextDecoder().decode((await branch.get("workspace/report.txt"))!)).toBe("tried\n");
    expect(await branch.get("workspace/deps/y.txt")).not.toBeNull();
    expect((await s.status()).counts.branches).toBe(1);
    expect(JSON.parse((await s.read(`.atoll/branches/atoll-${passed.effect}.json`))!)).toMatchObject({ id: passed.result.branch, merged: false, kept: true });

    // A trial that fails is still a result: its branch holds the tree that failed.
    await s.send("builder", "run", { effect: "shell.trial", command: "echo broke > report.txt; echo 'tests failed' >&2; exit 7" });
    await s.tick();
    const failed = (await runs(s)).find((r) => r.result.branch && r.result.exitCode === 7);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("exit 7");
    expect(failed.result).toMatchObject({ merged: false, kept: true, changed: { modified: ["report.txt"] } });
    expect(new TextDecoder().decode((await new LocalStore(failed.result.branch).get("workspace/report.txt"))!)).toBe("broke\n");
    expect(await s.read("workspace/report.txt")).toBe("base\n");
    expect((await s.status()).counts.branches).toBe(2);
  });

  it("refuses a declaration that asks for either where it means nothing", () => {
    const withEffect = (effect: object) => validateSystem({ ...system, effects: { odd: effect } } as never).map((p) => p.code);
    expect(withEffect({ kind: "exec", merge: false })).toEqual(["MERGE_WITHOUT_FORK"]);
    expect(withEffect({ kind: "http", allow: ["example.com"], ignore: ["node_modules"] })).toEqual(["IGNORE_WITHOUT_EXEC"]);
    expect(withEffect({ kind: "exec", ignore: ["node_modules", "packages/app/dist", "..", ""] })).toEqual(["BAD_IGNORE"]);
    expect(withEffect({ kind: "exec", fork: true, merge: false, ignore: ["node_modules", ".git"] })).toEqual([]);
  });
});
