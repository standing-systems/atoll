// The built CLI, driven as a person or a plugin would: a temporary project, a local atoll, real processes.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const cli = join(repo, "dist", "atoll.mjs");
let project: string;

const SYSTEM = `import { defineSystem } from "@standing-systems/atoll";
export default defineSystem({
  name: "clitest",
  charter: "Count what I send, and ask me before resetting.",
  parts: {
    counter: {
      purpose: "Count the pings I send",
      on: {
        ping: async (t) => {
          const s = (await t.json("count.json")) ?? { n: 0 };
          t.write("count.json", { n: s.n + 1 });
          t.note("count is " + (s.n + 1));
          t.wait({ for: "ping", reason: "the next ping" });
        },
        reset: (t) => {
          t.ask({
            question: "Reset the count?",
            why: "You sent reset.",
            options: [
              { id: "yes", label: "Reset", consequence: "The count goes back to zero." },
              { id: "no", label: "Keep it", consequence: "Nothing changes." },
            ],
            default: "no",
            expires: "1d",
          });
        },
        "ask.answered": (t, e) => {
          if (e.body.option === "yes") t.write("count.json", { n: 0 });
        },
      },
    },
  },
});
`;

function atoll(args: string[], options: { input?: string; cwd?: string; env?: Record<string, string> } = {}) {
  // No credentials reach the CLI unless a test gives them (an empty variable counts as unset).
  const env = { ...process.env, ARCHIL_API_KEY: "", ARCHIL_REGION: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", ATOLL_DEBUG: "", ...options.env };
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: options.cwd ?? project, input: options.input, encoding: "utf8", env });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(async () => {
  execFileSync(process.execPath, [join(repo, "build.mjs")], { cwd: repo, stdio: "ignore" });
  project = await mkdtemp(join(tmpdir(), "atoll-cli-"));
  await writeFile(join(project, "system.ts"), SYSTEM);
}, 120_000);

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("the atoll CLI", () => {
  it("lists every command the plugins rely on", () => {
    const { code, stdout } = atoll(["help", "--json"]);
    expect(code).toBe(0);
    const names = JSON.parse(stdout).commands.map((c: { name: string }) => c.name);
    const contract = join(repo, "scripts", "atoll-commands.json");
    if (existsSync(contract)) {
      const raw = JSON.parse(readFileSync(contract, "utf8"));
      const wanted: string[] = Array.isArray(raw) ? raw.map((c: any) => (typeof c === "string" ? c : c.name)) : (raw.commands ?? []).map((c: any) => (typeof c === "string" ? c : c.name));
      for (const name of wanted) expect(names).toContain(name.split(" ")[0]);
    }
    for (const name of ["push", "send", "tick", "status", "why", "check", "try", "door", "clock", "hook"]) expect(names).toContain(name);
  });

  it("pushes, delivers, ticks, and answers the five questions", () => {
    expect(atoll(["push"]).code).toBe(0);
    for (let i = 0; i < 3; i++) expect(atoll(["send", "counter", "ping"]).code).toBe(0);
    const tick = atoll(["tick"]);
    expect(tick.stdout).toContain("3 turns");
    const status = JSON.parse(atoll(["status", "--json"]).stdout);
    expect(status.answers.waiting[0]).toMatchObject({ address: "counter", status: "waiting" });
    expect(status.answers.changed[0].summary).toBe("count is 3");
    expect(readFileSync(join(project, ".atoll-local", "parts", "counter", "count.json"), "utf8")).toContain('"n": 3');
    expect(atoll(["cat", "STATUS.md"]).stdout).toContain("## What it needs from me");
  });

  it("explains a file with its cause chain", () => {
    const { code, stdout } = atoll(["why", "parts/counter/count.json"]);
    expect(code).toBe(0);
    expect(stdout).toContain("counter handled ping from @owner");
    expect(stdout).toContain("starts with an event from outside");
  });

  it("asks, takes an answer, and closes the question", () => {
    atoll(["send", "counter", "reset", "--tick"]);
    const asks = JSON.parse(atoll(["asks", "--json"]).stdout).asks;
    expect(asks).toHaveLength(1);
    const answered = atoll(["answer", asks[0].id, "yes"]);
    expect(answered.code).toBe(0);
    expect(JSON.parse(atoll(["asks", "--json"]).stdout).asks).toHaveLength(0);
    expect(readFileSync(join(project, ".atoll-local", "parts", "counter", "count.json"), "utf8")).toContain('"n": 0');
  });

  it("passes check, then fails it when a file changes outside a turn", async () => {
    expect(atoll(["check"]).code).toBe(0);
    await writeFile(join(project, ".atoll-local", "parts", "counter", "count.json"), '{"n": 99}');
    const failed = atoll(["check"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("UNATTRIBUTED_CHANGE");
  });

  it("replays recorded turns through the pushed code without differences, and shows what an edit would change", async () => {
    expect(atoll(["replay"]).code).toBe(0);
    await writeFile(join(project, "system.ts"), SYSTEM.replace("s.n + 1 });", "s.n + 2 });"));
    const tried = atoll(["try"]);
    expect(tried.code).toBe(0);
    expect(tried.stdout).toMatch(/3 differ|differ/);
    expect(tried.stdout).toContain("writes different content to parts/counter/count.json");
    await writeFile(join(project, "system.ts"), SYSTEM);
  });

  it("reports hard errors after an edit, and stays silent when clean", async () => {
    const input = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(project, "system.ts") } });
    expect(atoll(["hook", "check-on-edit"], { input }).stdout).toBe("");
    await writeFile(join(project, "system.ts"), SYSTEM.replace('purpose: "Count the pings I send",', 'purpose: "",'));
    const out = atoll(["hook", "check-on-edit"], { input });
    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("NO_PURPOSE");
    await writeFile(join(project, "system.ts"), SYSTEM);
  });

  it("writes clock configuration and never overwrites a file", async () => {
    const crontab = atoll(["clock", "--cron", "*/10 * * * *", "--disk", "radar"]);
    expect(crontab.stdout).toContain("*/10 * * * *");
    expect(crontab.stdout).toContain("atoll tick --disk radar");
    const github = atoll(["clock", "--github", "--disk", "radar", "--write", ".github/workflows/atoll-tick.yml"]);
    expect(github.code).toBe(0);
    expect(readFileSync(join(project, ".github", "workflows", "atoll-tick.yml"), "utf8")).toContain("secrets.ARCHIL_API_KEY");
    expect(atoll(["clock", "--github", "--write", ".github/workflows/atoll-tick.yml"]).code).toBe(2);
  });

  it("gives a clock that runs the atoll elsewhere the model keys its code uses, and only those", async () => {
    const plain = atoll(["clock", "--github", "--disk", "radar"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY/);
    const withModel = SYSTEM.replace(
      "  parts: {",
      '  effects: {\n    summarize: { kind: "model", model: "anthropic/claude-haiku-5-5", maxUsd: 0.01, budget: { usd: 1, per: "month" } },\n  },\n  parts: {',
    );
    await writeFile(join(project, "system.ts"), withModel);
    try {
      const github = atoll(["clock", "--github", "--disk", "radar"]);
      expect(github.code).toBe(0);
      expect(github.stdout).toContain("# Add ANTHROPIC_API_KEY as a repository secret too: this atoll's code calls its models with it.\n");
      expect(github.stdout).toContain("          ARCHIL_REGION: ${{ vars.ARCHIL_REGION }}\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n");
      expect(github.stdout).not.toContain("OPENAI_API_KEY");
      expect(atoll(["clock", "--disk", "radar"]).stdout).toContain("Put ARCHIL_API_KEY and ARCHIL_REGION, and ANTHROPIC_API_KEY for this atoll's models, in ~/.atoll/env");
      expect(atoll(["clock", "--launchd", "--disk", "radar"]).stdout).toContain("Put ARCHIL_API_KEY and ARCHIL_REGION, and ANTHROPIC_API_KEY for this atoll's models, in ~/.atoll/env");
      // A door's ticks run in its sandbox, which has its own keys (atoll door up), so its clock names none.
      expect(atoll(["clock", "--door"]).stdout).not.toContain("ANTHROPIC_API_KEY");
      // The local atoll's own state may hold other findings by now; this is only about the model's name.
      const named = atoll(["check", "--json"]);
      expect(JSON.parse(named.stdout).problems.map((p: { code: string }) => p.code)).not.toContain("BAD_MODEL");
      await writeFile(join(project, "system.ts"), withModel.replace("anthropic/claude-haiku-5-5", "antropic/claude-haiku-5-5"));
      const typo = atoll(["check", "--json"]);
      expect(typo.code).toBe(1);
      expect(JSON.parse(typo.stdout).problems).toContainEqual(expect.objectContaining({ severity: "error", code: "BAD_MODEL", where: "effects.summarize" }));
    } finally {
      await writeFile(join(project, "system.ts"), SYSTEM);
    }
  });

  it("uses exit 3 outside a project and exit 2 for usage errors", async () => {
    const empty = await mkdtemp(join(tmpdir(), "atoll-empty-"));
    await mkdir(join(empty, "x"));
    expect(atoll(["status"], { cwd: join(empty, "x") }).code).toBe(3);
    expect(atoll(["send", "counter"]).code).toBe(2);
    expect(atoll(["no-such-command"]).code).toBe(2);
    await rm(empty, { recursive: true, force: true });
  });

  it("scaffolds a project from a template and never overwrites", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atoll-init-"));
    const first = atoll(["init", join(dir, "radar"), "--template", "release-radar"], { cwd: dir });
    expect(first.code).toBe(0);
    expect(existsSync(join(dir, "radar", "system.ts"))).toBe(true);
    const second = JSON.parse(atoll(["init", join(dir, "radar"), "--template", "release-radar", "--json"], { cwd: dir }).stdout);
    expect(second.written).toEqual([]);
    expect(readFileSync(join(dir, "radar", ".gitignore"), "utf8")).toMatch(/^\.env$/m);
    await rm(dir, { recursive: true, force: true });
  });

  it("reads credentials from the project's .env as Archil's prompts keep them, lets the environment win, and never prints one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atoll-env-"));
    const secret = "key-0123456789abcdef0123";
    await writeFile(join(dir, "system.ts"), SYSTEM);
    await writeFile(join(dir, ".env"), `ARCHIL_API_KEY=${secret}\nARCHIL_REGION=aws-us-west-2\nUNRELATED=1\n`);
    const doctor = (env: Record<string, string> = {}) => {
      const r = atoll(["doctor", "--json"], { cwd: dir, env });
      expect(r.stdout + r.stderr).not.toContain(secret);
      return Object.fromEntries(JSON.parse(r.stdout).checks.map((c: { name: string }) => [c.name, c]));
    };
    let checks = doctor();
    expect(checks["archil-key"].ok).toBe(true);
    expect(checks["archil-key"].detail).toContain("is set from .env");
    expect(checks["archil-region"].detail).toContain("aws-us-west-2 from .env");
    expect(checks["env-file"].detail).toContain(".env supplied ARCHIL_API_KEY, ARCHIL_REGION (values not shown)");
    // A variable already set in the environment wins over the file.
    checks = doctor({ ARCHIL_REGION: "aws-eu-west-1" });
    expect(checks["archil-region"].detail).toMatch(/^ARCHIL_REGION is aws-eu-west-1 \(/);
    expect(checks["env-file"].detail).toContain(".env supplied ARCHIL_API_KEY (values not shown)");
    // In a git repository, a .env that git would commit fails the check until it's ignored.
    execFileSync("git", ["init", "-q"], { cwd: dir });
    checks = doctor();
    expect(checks["env-file"].ok).toBe(false);
    expect(checks["env-file"].detail).toContain("add .env to .gitignore");
    await writeFile(join(dir, ".gitignore"), ".env\n");
    expect(doctor()["env-file"].ok).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("shows the top level and stops before laying an atoll out beside files it didn't write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atoll-existing-"));
    await writeFile(join(dir, "notes.txt"), "mine\n");
    await mkdir(join(dir, "workspace"));
    await writeFile(join(dir, "workspace", "draft.md"), "draft\n");
    const refused = atoll(["create", "guarded", "--dir", dir]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("isn't an atoll. Its top level:\n  notes.txt\n  workspace/\n");
    expect(refused.stdout).toContain("Already here: workspace/.");
    const json = JSON.parse(atoll(["create", "guarded", "--dir", dir, "--json"]).stdout);
    expect(json).toMatchObject({ refused: "existing-files", top: ["notes.txt", "workspace/"], alreadyThere: ["workspace/"] });
    // push lays an atoll out on first use, so it looks first too.
    expect(atoll(["push", "--dir", dir]).code).toBe(1);
    expect(existsSync(join(dir, ".atoll"))).toBe(false);
    expect(atoll(["create", "guarded", "--dir", dir, "--alongside"]).code).toBe(0);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(dir, "workspace", "draft.md"), "utf8")).toBe("draft\n");
    // Once it is an atoll there's nothing to ask.
    expect(atoll(["push", "--dir", dir]).code).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
});
