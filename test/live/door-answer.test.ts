// A model's answer through a door whose key Archil holds, against the real service and through the built
// CLI (dist/atoll.mjs). The other live tests use made-up model keys, which shows a key arrives but not
// that an answer comes back. This one uses the real ANTHROPIC_API_KEY from the environment.
//
// On a plan that can set a sandbox's network policy, `atoll door up` gives that key to Archil in the
// policy and the sandbox a placeholder. A turn taken in the door then asks Claude one short question. The
// test checks that the answer is the model's own, that no process in the sandbox holds the key, and that
// the key is nowhere on the disk, in doors.json, or in anything the CLI printed.
//
// It needs its own opt-in, because the real key leaves this machine: ATOLL_LIVE=1 and ATOLL_LIVE_MODEL=1,
// with ANTHROPIC_API_KEY set, after `node build.mjs`. While the door is up, the key is part of its
// sandbox's network policy at Archil, and Archil's API gives that policy back to whoever holds the
// account's API key. Costs one exec call (push's checkpoint), one sandbox for under a minute, and one
// call to Claude Haiku of at most 16 output tokens. Nothing this test prints or records holds the key.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const REAL = (process.env.ANTHROPIC_API_KEY ?? "").trim();
const READY = LIVE && process.env.ATOLL_LIVE_MODEL === "1" && REAL !== "" && existsSync(BUNDLE);
const RUN = Math.random().toString(36).slice(2, 10);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Whether `text` holds the real key. Every check on the key goes through this, so a failure never prints it. */
const holdsKey = (text: string) => REAL !== "" && text.includes(REAL);
/** `text` without the real key, for anything a failed assertion would show. */
const safe = (text: string) => (REAL ? text.split(REAL).join("[the real key]") : text);

interface CliResult {
  code: number;
  json: any;
  /** What the CLI printed, with the real key taken out. `leaked` says whether it was there. */
  printed: string;
  leaked: boolean;
  ms: number;
}

/** What the turn in the door recorded about the model's answer. */
interface Last {
  ok: boolean;
  error: string | null;
  model: string | null;
  standIn: boolean | null;
  text: string | null;
}

/** What the probe in the sandbox reports about every process's environment there. */
interface Probe {
  processes: number;
  /** Variables whose value is the real key, found by its SHA-256. The probe is never given the key. */
  holders: number;
  /** ANTHROPIC_API_KEY variables holding the placeholder, and ones holding anything else. */
  placeholders: number;
  others: number;
}

describe.skipIf(!READY)("a model's answer through a door whose key Archil holds, live", () => {
  const atollName = `door-answer-${RUN.slice(0, 4)}`;
  let live: LiveDisk;
  let project: string;
  let doorsFile: string;
  let sandboxStarted = 0;

  /** Run the built CLI in the project with --json. It has the real Anthropic key, and no OpenAI key. */
  function cli(args: string[]): Promise<CliResult> {
    const started = performance.now();
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [BUNDLE, ...args, "--json"],
        { cwd: project, env: { ...process.env, ATOLL_DOORS_FILE: doorsFile, ANTHROPIC_API_KEY: REAL, OPENAI_API_KEY: "" }, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
        (error, stdout, stderr) => {
          let json: any;
          try {
            json = JSON.parse(stdout);
          } catch {
            json = undefined;
          }
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0;
          resolve({ code, json, printed: safe(`${stdout}\n${stderr}`).slice(0, 4000), leaked: holdsKey(stdout) || holdsKey(stderr), ms: performance.now() - started });
        },
      );
    });
  }

  async function lastAnswer(timeoutMs: number): Promise<Last | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = asText(await live.store.get("parts/reader/last.json"));
      if (text || Date.now() > deadline) return text ? (JSON.parse(text) as Last) : null;
      await sleep(500);
    }
  }

  beforeAll(async () => {
    live = await createLiveDisk("door-answer");
    project = await mkdtemp(join(tmpdir(), "atoll-door-answer-"));
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
          const result = e.body.result ?? {};
          t.write("last.json", { ok: e.body.ok, error: e.body.error ?? null, model: result.model ?? null, standIn: result.standIn ?? null, text: result.text ?? null });
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
    // Whatever happened above, leave no sandbox behind: its policy is where the real key is.
    if (live) {
      const leftovers = (await live.archil.sandboxes.list()).filter((s) => s.name === doorName(atollName) && s.status !== "deleted");
      for (const sandbox of leftovers) {
        await stopAndDelete(sandbox).catch((error: unknown) => console.error(`[door answer] cleanup of ${sandbox.id} failed: ${safe(String(error))}`));
        sandboxDeleted(sandbox.id, sandbox.name, sandboxStarted ? Date.now() - sandboxStarted : undefined);
      }
      await live.cleanup();
    }
    if (project) await rm(project, { recursive: true, force: true });
  }, 180_000);

  it("answers from the model itself, with the key held by Archil and nowhere else", async () => {
    const created = await cli(["create", atollName, "--disk", live.name]);
    expect(created.code, created.printed).toBe(0);
    countExec("live door answer: push's checkpoint");
    const pushed = await cli(["push", "--disk", live.name]);
    expect(pushed.code, pushed.printed).toBe(0);

    // ---- the door comes up with the key in its policy, not in the sandbox ---------------------------
    sandboxStarted = Date.now();
    const up = await cli(["door", "up", "--disk", live.name]);
    expect(up.code, up.printed).toBe(0);
    const sandboxId = up.json.up.sandboxId as string;
    sandboxCreated(sandboxId, up.json.up.name);
    const network = up.json.up.network as DoorNetwork;
    // This test is about a key Archil holds. On a plan that can't set a policy the service would hold it.
    expect(network).toEqual({ egress: "declared", allow: ["api.anthropic.com"], brokered: ["ANTHROPIC_API_KEY"] });
    expect(up.json).toMatchObject({ modelKeys: ["ANTHROPIC_API_KEY"], standIns: [] });

    const sandbox = await live.archil.sandboxes.get(sandboxId);
    const source = `
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const wanted = ${JSON.stringify(createHash("sha256").update(REAL).digest("hex"))};
let processes = 0, holders = 0, placeholders = 0, others = 0;
for (const pid of fs.readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name) && Number(name) !== process.pid)) {
  let env;
  try { env = fs.readFileSync("/proc/" + pid + "/environ", "utf8"); } catch { continue; }
  processes += 1;
  for (const entry of env.split("\\0")) {
    const at = entry.indexOf("=");
    if (at < 0) continue;
    const name = entry.slice(0, at), value = entry.slice(at + 1);
    if (createHash("sha256").update(value).digest("hex") === wanted) holders += 1;
    if (name === "ANTHROPIC_API_KEY") { if (value === ${JSON.stringify(BROKERED)}) placeholders += 1; else others += 1; }
  }
}
console.log(JSON.stringify({ processes, holders, placeholders, others }));`;
    const ran = await sandbox.exec(`node -e "$(printf %s '${Buffer.from(source).toString("base64")}' | base64 -d)"`, { timeoutSeconds: 60 });
    const probe = JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "null") as Probe | null;
    expect(probe, safe(ran.stdout + ran.stderr).slice(0, 600)).not.toBeNull();
    expect(probe!.processes).toBeGreaterThan(0);
    expect(probe).toMatchObject({ holders: 0, others: 0 });
    expect(probe!.placeholders).toBeGreaterThan(0);

    // ---- a turn in the door asks the model, and the model answers -----------------------------------
    const id = ulid();
    const called = await cli(["door", "call", "/events", JSON.stringify({ to: "reader", type: "read", id, body: { text: "Reply with the single word: ready" } }), "--disk", live.name]);
    expect(called.code, called.printed).toBe(0);
    expect(called.json.response).toMatchObject({ status: 200, body: { id, duplicate: false } });
    let last = await lastAnswer(30_000);
    let extraTick = false;
    if (!last) {
      extraTick = true;
      expect((await cli(["door", "call", "/tick", "{}", "--disk", live.name])).code).toBe(0);
      last = await lastAnswer(30_000);
    }
    expect(last, "the door never recorded the model's answer").not.toBeNull();
    expect(last, safe(JSON.stringify(last))).toMatchObject({ ok: true, error: null, standIn: false });
    expect(String(last!.model)).toContain("haiku");
    expect(String(last!.text ?? "").trim().length).toBeGreaterThan(0);

    // ---- the key is nowhere but Archil's policy -----------------------------------------------------
    const entries = await live.store.list("");
    const onDisk = [];
    for (const entry of entries) {
      if (holdsKey(new TextDecoder().decode((await live.store.get(entry.key)) ?? new Uint8Array()))) onDisk.push(entry.key);
    }
    expect(onDisk).toEqual([]);
    expect(holdsKey(await readFile(doorsFile, "utf8"))).toBe(false);
    expect([created, pushed, up, called].map((result) => result.leaked)).toEqual([false, false, false, false]);

    // ---- the door comes down, and the policy with it ------------------------------------------------
    const down = await cli(["door", "down", "--disk", live.name]);
    const wallMs = Date.now() - sandboxStarted;
    expect(down.code, down.printed).toBe(0);
    expect(down.json.down).toEqual({ removed: true, sandboxId });
    sandboxDeleted(sandboxId, doorName(atollName), wallMs);
    expect((await live.archil.sandboxes.list()).filter((s) => s.name === doorName(atollName) && s.status !== "deleted")).toEqual([]);

    const summary = { model: last!.model, answer: String(last!.text ?? "").trim().slice(0, 40), extraTick, network, probe, scanned: entries.length, cliMs: { up: Math.round(up.ms), call: Math.round(called.ms), down: Math.round(down.ms) }, sandboxWallMs: wallMs };
    note("door answer", summary);
    console.log(`[door answer] ${JSON.stringify(summary)}`);
  }, 300_000);
});
