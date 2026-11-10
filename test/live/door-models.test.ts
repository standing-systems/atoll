// The door's model keys and network, against the real service and through the built CLI (dist/atoll.mjs).
// `atoll door up` refuses when the pushed code calls a model it would have no key for. Otherwise the door
// gets exactly the keys that code uses, and what happens next depends on the account's plan.
//
// On a plan that can set a sandbox's network policy, the key goes to Archil in the policy and the sandbox
// holds a placeholder. The test looks inside the sandbox: no process there has the key, a request to
// Anthropic that carries no key at all is refused the way a wrong key is (so Archil added one), and hosts
// the code doesn't declare can't be reached. On the Free plan the key is in the service's environment and
// the door reaches Archil's managed allowlist.
//
// Either way, with a made-up Anthropic key a turn taken in the door calls Anthropic and is refused with
// HTTP 401, and neither made-up key ever lands on the disk.
//
// Opt in with ATOLL_LIVE=1 after `node build.mjs`. Costs one exec call (push's checkpoint), one sandbox for
// about a minute, and four refused requests to api.anthropic.com: one from the door's turn, one from
// inside the sandbox, and two from this machine to learn how Anthropic words each refusal. No real model
// key is used.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROKERED, doorName, stopAndDelete, type DoorNetwork } from "../../src/door/sandbox.ts";
import { ulid } from "../../src/ids.ts";
import { asText } from "../../src/store/types.ts";
import { countExec, createLiveDisk, LIVE, note, sandboxCreated, sandboxDeleted, type LiveDisk } from "./live.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE = join(REPO, "dist", "atoll.mjs");
const READY = LIVE && existsSync(BUNDLE);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Made up for this run, so a scan can tell whether either ever reached the disk.
const RUN = Math.random().toString(36).slice(2, 10);
const FAKE_ANTHROPIC = `sk-ant-atoll-live-fake-${RUN}`;
const FAKE_OPENAI = `sk-atoll-live-fake-openai-${RUN}`;

/** What a request from inside the sandbox met. */
type Answer = { reached: true; status: number; message: string | null } | { reached: false; why: string };

/** What the probe in the sandbox reports. */
interface Probe {
  /** Whether a command there is told where Archil's egress CA is. */
  ca: boolean;
  /** Processes whose environment holds the made-up key, and ones that hold its placeholder. */
  holders: number;
  placeholders: number;
  anthropic: Answer & { message?: string | null };
  undeclared: Answer;
  npm: Answer;
}

interface CliResult {
  code: number;
  json: any;
  stdout: string;
  stderr: string;
  ms: number;
}

describe.skipIf(!READY)("the door's model keys, live", () => {
  const atollName = `door-models-${RUN.slice(0, 4)}`;
  let live: LiveDisk;
  let project: string;
  let doorsFile: string;
  let sandboxId: string | undefined;
  let sandboxStarted = 0;

  /** Run the built CLI in the project with --json. No model key reaches it unless `env` gives one. */
  function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
    const started = performance.now();
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [BUNDLE, ...args, "--json"],
        { cwd: project, env: { ...process.env, ATOLL_DOORS_FILE: doorsFile, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
        (error, stdout, stderr) => {
          let json: any;
          try {
            json = JSON.parse(stdout);
          } catch {
            json = undefined;
          }
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0;
          resolve({ code, json, stdout, stderr: stderr.slice(0, 2000), ms: performance.now() - started });
        },
      );
    });
  }

  /** Run a node program in the door's sandbox and read the JSON it prints on its last line. */
  async function inSandbox<T>(id: string, source: string): Promise<T> {
    const sandbox = await live.archil.sandboxes.get(id);
    const run = await sandbox.exec(`node -e "$(printf %s '${Buffer.from(source).toString("base64")}' | base64 -d)"`, { timeoutSeconds: 90 });
    try {
      return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as T;
    } catch {
      throw new Error(`The probe in the sandbox exited ${run.exitCode} without JSON: ${(run.stdout + run.stderr).slice(0, 600)}`);
    }
  }

  /** How Anthropic refuses a request from this machine, with the given headers. */
  async function refusal(headers: Record<string, string>): Promise<{ status: number; message: string | null }> {
    const response = await fetch("https://api.anthropic.com/v1/models", { headers: { "anthropic-version": "2023-06-01", ...headers }, signal: AbortSignal.timeout(30_000) });
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { status: response.status, message: body?.error?.message ?? null };
  }

  async function lastAnswer(timeoutMs: number): Promise<{ ok: boolean; error: string | null } | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = asText(await live.store.get("parts/reader/last.json"));
      if (text || Date.now() > deadline) return text ? JSON.parse(text) : null;
      await sleep(500);
    }
  }

  beforeAll(async () => {
    live = await createLiveDisk("door-models");
    project = await mkdtemp(join(tmpdir(), "atoll-door-models-"));
    doorsFile = join(project, "doors.json");
    await symlink(join(REPO, "node_modules"), join(project, "node_modules"), "dir");
    await writeFile(
      join(project, "system.ts"),
      `import { defineSystem } from "@standing-systems/atoll";
export default defineSystem({
  name: ${JSON.stringify(atollName)},
  parts: {
    reader: {
      purpose: "Ask a model about what the door is sent",
      on: {
        read: (t, e) => {
          t.effect("summarize", { prompt: String(e.body.text ?? ""), maxTokens: 16 }, { then: "summarized" });
          t.wait({ for: "summarized", reason: "the model's answer" });
        },
        summarized: (t, e) => {
          t.write("last.json", { ok: e.body.ok, error: e.body.error ?? null });
          t.wait({ for: "read", reason: "the next request" });
        },
      },
    },
  },
  effects: {
    summarize: { kind: "model", model: "anthropic/claude-haiku-5-5", maxUsd: 0.01, budget: { usd: 0.05, per: "day" } },
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
        await stopAndDelete(sandbox).catch((error: unknown) => console.error(`[door models] cleanup of ${sandbox.id} failed: ${String(error)}`));
        sandboxDeleted(sandbox.id, sandbox.name, sandboxStarted ? Date.now() - sandboxStarted : undefined);
      }
      await live.cleanup();
    }
    if (project) await rm(project, { recursive: true, force: true });
  }, 180_000);

  it("refuses without the key, hands over only the key the code uses, and the door's call goes out with it", async () => {
    const created = await cli(["create", atollName, "--disk", live.name]);
    expect(created.code, created.stderr).toBe(0);
    countExec("live door models: push's checkpoint");
    const pushed = await cli(["push", "--disk", live.name]);
    expect(pushed.code, pushed.stderr).toBe(0);

    // ---- no key here: every call would fail, so the door doesn't come up --------------------------
    const refused = await cli(["door", "up", "--disk", live.name]);
    expect(refused.code, refused.stdout + refused.stderr).toBe(1);
    expect(refused.json).toMatchObject({ up: null, refused: "model-keys", missing: [{ key: "ANTHROPIC_API_KEY", effects: ["summarize"] }] });
    expect((await live.archil.sandboxes.list()).filter((s) => s.name === doorName(atollName) && s.status !== "deleted")).toEqual([]);

    // ---- keys for both providers here: the door gets only the one its code uses --------------------
    sandboxStarted = Date.now();
    const up = await cli(["door", "up", "--disk", live.name], { ANTHROPIC_API_KEY: FAKE_ANTHROPIC, OPENAI_API_KEY: FAKE_OPENAI });
    expect(up.code, up.stderr).toBe(0);
    sandboxId = up.json.up.sandboxId as string;
    sandboxCreated(sandboxId, up.json.up.name);
    expect(up.json).toMatchObject({ modelKeys: ["ANTHROPIC_API_KEY"], standIns: [] });
    for (const printed of [up.stdout, up.stderr, refused.stdout, refused.stderr]) {
      expect(printed).not.toContain(FAKE_ANTHROPIC);
      expect(printed).not.toContain(FAKE_OPENAI);
    }

    // ---- what the door may reach, and who holds the key ------------------------------------------
    const network = up.json.up.network as DoorNetwork;
    const declared = network.egress === "declared";
    expect(network).toEqual(declared ? { egress: "declared", allow: ["api.anthropic.com"], brokered: ["ANTHROPIC_API_KEY"] } : { egress: "managed", allow: [], brokered: [] });
    const policy = await (await live.archil.sandboxes.get(sandboxId)).getNetwork();
    expect(policy.managed === true).toBe(!declared);
    if (declared) {
      expect(policy.egress?.default).toBe("deny");
      const targets = (policy.egress?.allow ?? []).map((rule) => (typeof rule === "string" ? rule : rule.target));
      expect(targets, JSON.stringify(targets)).toEqual(expect.arrayContaining(["api.anthropic.com", "mount.*.archil.com", "data.*.archil.com"]));
      expect(targets).not.toContain("registry.npmjs.org");
    }
    // Looked at from inside: which processes hold the key or its placeholder, and what answers. The probe
    // names the made-up key only by the part every run shares, and sends Anthropic no key of its own.
    const probe = await inSandbox<Probe>(
      sandboxId,
      `
const fs = require("node:fs");
const ask = async (url, headers) => {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    let message = null;
    try { message = (await response.json()).error.message; } catch {}
    return { reached: true, status: response.status, message };
  } catch (error) {
    return { reached: false, why: String((error.cause && (error.cause.code || error.cause.message)) || error.name) };
  }
};
(async () => {
  let holders = 0, placeholders = 0;
  for (const pid of fs.readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name) && Number(name) !== process.pid)) {
    try {
      const env = fs.readFileSync("/proc/" + pid + "/environ", "utf8");
      if (env.includes("sk-ant-atoll-live-fake-")) holders += 1;
      if (env.includes("ANTHROPIC_API_KEY=${BROKERED}")) placeholders += 1;
    } catch {}
  }
  console.log(JSON.stringify({
    ca: Boolean(process.env.NODE_EXTRA_CA_CERTS),
    holders,
    placeholders,
    anthropic: await ask("https://api.anthropic.com/v1/models", { "anthropic-version": "2023-06-01" }),
    undeclared: await ask("https://example.com/", {}),
    npm: await ask("https://registry.npmjs.org/", {}),
  }));
})();`,
    );
    const [noKey, wrongKey] = [await refusal({}), await refusal({ "x-api-key": FAKE_ANTHROPIC })];
    const reached = (answer: Probe["npm"]) => answer.reached && answer.status === 200;
    expect(probe.anthropic, JSON.stringify(probe)).toMatchObject({ reached: true, status: 401 });
    expect(reached(probe.undeclared), JSON.stringify(probe)).toBe(false);
    if (declared) {
      // Nothing in the sandbox holds the key, and the service holds its placeholder.
      expect(probe.holders, JSON.stringify(probe)).toBe(0);
      expect(probe.placeholders).toBeGreaterThan(0);
      // The probe sent no key. If Anthropic words that differently from a wrong key, its answer here
      // has to be the wrong-key one: Archil put the made-up key on the request.
      if (noKey.message !== wrongKey.message) expect(probe.anthropic.message).toBe(wrongKey.message);
      // npm is on Archil's managed allowlist, but this code doesn't declare it.
      expect(reached(probe.npm), JSON.stringify(probe)).toBe(false);
    } else {
      expect(probe.holders).toBeGreaterThan(0);
      expect(probe.placeholders).toBe(0);
      if (noKey.message !== wrongKey.message) expect(probe.anthropic.message).toBe(noKey.message);
      expect(reached(probe.npm), JSON.stringify(probe)).toBe(true);
    }

    // ---- a turn in the door asks the model, and Anthropic itself refuses the made-up key ----------
    const id = ulid();
    const called = await cli(["door", "call", "/events", JSON.stringify({ to: "reader", type: "read", id, body: { text: "Say hi." } }), "--disk", live.name]);
    expect(called.code, called.stderr).toBe(0);
    expect(called.json.response).toMatchObject({ status: 200, body: { id, duplicate: false } });
    let last = await lastAnswer(20_000);
    let extraTick = false;
    if (!last) {
      extraTick = true;
      expect((await cli(["door", "call", "/tick", "{}", "--disk", live.name])).code).toBe(0);
      last = await lastAnswer(20_000);
    }
    expect(last, "the door never recorded the model's answer").not.toBeNull();
    expect(last!.ok).toBe(false);
    expect(last!.error).toMatch(/^Anthropic returned 401/);

    // ---- neither key is on the disk or in doors.json ----------------------------------------------
    const entries = await live.store.list("");
    for (const entry of entries) {
      const text = new TextDecoder().decode((await live.store.get(entry.key)) ?? new Uint8Array());
      expect(text, entry.key).not.toContain(FAKE_ANTHROPIC);
      expect(text, entry.key).not.toContain(FAKE_OPENAI);
    }
    const doors = await readFile(doorsFile, "utf8");
    expect(doors).not.toContain(FAKE_ANTHROPIC);
    expect(doors).not.toContain(FAKE_OPENAI);

    // ---- the door comes down ------------------------------------------------------------------------
    const down = await cli(["door", "down", "--disk", live.name]);
    const wallMs = Date.now() - sandboxStarted;
    expect(down.code, down.stderr).toBe(0);
    expect(down.json.down).toEqual({ removed: true, sandboxId });
    sandboxDeleted(sandboxId, doorName(atollName), wallMs);
    sandboxId = undefined;

    // Whether Archil's own API gives a policy's key back to whoever holds the account's API key.
    const policyShowsKey = JSON.stringify(policy).includes(FAKE_ANTHROPIC);
    const summary = { error: last!.error, extraTick, network, probe, refusals: { noKey, wrongKey }, policyShowsKey, scanned: entries.length, cliMs: { refused: Math.round(refused.ms), up: Math.round(up.ms), call: Math.round(called.ms), down: Math.round(down.ms) }, sandboxWallMs: wallMs };
    note("door models", summary);
    console.log(`[door models] ${JSON.stringify(summary)}`);
  }, 300_000);
});
