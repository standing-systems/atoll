// The parts of the door's management that need no Archil account: naming, calling a door, the network
// policy a door asks for, and what doorUp hands Archil on a plan that takes that policy and on one that
// refuses it. The sandbox lifecycle itself is covered by test/live/door.test.ts.

import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archil, ArchilError } from "disk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callDoor, doorName, doorNetwork, doorUp, serviceScript, type DoorKey, type DoorUpOptions } from "../../src/door/sandbox.ts";
import { DISK_ID, startFakeArchil } from "../store/fake-archil.ts";
import { serve, type DoorEvent, type DoorServer } from "../../src/door/serve.ts";
import type { FiveAnswers, TickReport } from "../../src/runtime/types.ts";
import type { Store } from "../../src/store/types.ts";

describe("doorName", () => {
  it("names a door after its atoll, within Archil's sandbox name rules", () => {
    expect(doorName("release-radar")).toBe("atoll-release-radar-door");
    expect(doorName("a".repeat(52))).toHaveLength(63);
    for (const bad of ["", "Radar", "-radar", "radar-", "ra_dar", "a".repeat(53), "radar.v2"]) expect(() => doorName(bad), bad).toThrow();
  });
});

describe("callDoor", () => {
  let server: DoorServer;
  const delivered: DoorEvent[] = [];
  beforeAll(async () => {
    server = await serve({
      store: { location: "dir:/tmp/fake" } as Store,
      port: 0,
      token: "local-bearer",
      log: () => {},
      async deliver(event) {
        delivered.push(event);
        return { id: event.id ?? "generated", duplicate: false };
      },
      async tick() {
        return { ran: true, turns: delivered.length } as TickReport;
      },
      async status() {
        return { atoll: "local" } as FiveAnswers;
      },
    });
  });
  afterAll(() => server.close());

  it("GETs without a body and POSTs JSON with one, parsing JSON answers", async () => {
    const status = await callDoor({ hostname: server.url, bearer: "local-bearer", path: "/status" });
    expect(status).toMatchObject({ status: 200, body: { atoll: "local" } });
    expect(status.ms).toBeGreaterThan(0);
    // A deadline no longer than one attempt leaves a fractional remainder for the attempt's timer.
    const single = await callDoor({ hostname: server.url, bearer: "local-bearer", path: "/status", attempts: 1, attemptTimeoutMs: 30_000, timeoutMs: 30_000 });
    expect(single).toMatchObject({ status: 200, attempts: 1 });
    const posted = await callDoor({ hostname: `${server.url}/`, bearer: "local-bearer", path: "events", body: { to: "a", type: "b", id: "e1" } });
    expect(posted).toMatchObject({ status: 200, body: { id: "e1", duplicate: false, report: { ran: true, turns: 1 } } });
    expect(delivered).toEqual([{ to: "a", type: "b", id: "e1", from: "@door" }]);
  });

  it("retries a hung attempt when repeating is harmless, and never re-sends an event without an ID", async () => {
    let seen = 0;
    const hanging = createServer((req, res) => {
      seen += 1;
      if (seen === 1) return; // the first request never gets an answer, like a wake that hangs
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, seen }));
    });
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`;
    try {
      const healed = await callDoor({ hostname: url, path: "/healthz", attemptTimeoutMs: 300 });
      expect(healed).toMatchObject({ status: 200, attempts: 2, body: { ok: true, seen: 2 } });
      seen = 0;
      await expect(callDoor({ hostname: url, path: "/events", body: { to: "a", type: "b" }, attemptTimeoutMs: 300 })).rejects.toThrow(/didn't answer POST \/events/);
      expect(seen).toBe(1);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("returns refusals rather than throwing, and says which door didn't answer", async () => {
    expect(await callDoor({ hostname: server.url, path: "/status" })).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    await expect(callDoor({ hostname: "http://127.0.0.1:9", path: "/healthz", timeoutMs: 2000 })).rejects.toThrow(/The door at http:\/\/127\.0\.0\.1:9 didn't answer GET \/healthz/);
  });
});

describe("doorNetwork", () => {
  const key: DoorKey = { name: "ANTHROPIC_API_KEY", value: "sk-ant-policy-test", host: "api.anthropic.com", headers: { "x-api-key": "sk-ant-policy-test" } };

  it("denies everything but the declared hosts and Archil's endpoints for the disk", () => {
    expect(doorNetwork([], [])).toEqual({ network: { egress: { default: "deny", allow: ["mount.*.archil.com", "data.*.archil.com"] } }, allow: [], skipped: [] });
    const { network, allow, skipped } = doorNetwork(["registry.npmjs.org", " Hooks.Example.com ", "*.example.org", "registry.npmjs.org", "203.0.113.7", "198.51.100.0/24"], []);
    expect(network).toEqual({ egress: { default: "deny", allow: ["registry.npmjs.org", "hooks.example.com", "*.example.org", "203.0.113.7", "198.51.100.0/24", "mount.*.archil.com", "data.*.archil.com"] } });
    expect(allow).toEqual(["registry.npmjs.org", "hooks.example.com", "*.example.org", "203.0.113.7", "198.51.100.0/24"]);
    expect(skipped).toEqual([]);
  });

  it("puts a key's rule first, so its headers are set even when an effect lists the same host or a wildcard over it", () => {
    const { network, allow } = doorNetwork(["*.anthropic.com", "api.anthropic.com", "registry.npmjs.org"], [key]);
    expect(network.egress!.allow).toEqual([
      { target: "api.anthropic.com", transform: { headers: { "x-api-key": "sk-ant-policy-test" } } },
      "*.anthropic.com",
      "registry.npmjs.org",
      "mount.*.archil.com",
      "data.*.archil.com",
    ]);
    expect(allow).toEqual(["api.anthropic.com", "*.anthropic.com", "registry.npmjs.org"]);
  });

  it("leaves out what a policy has no form for, and says which", () => {
    const { network, skipped } = doorNetwork(["localhost", "example.com:8443", "https://example.com", "[::1]", "*", "ok.example.com"], []);
    expect(skipped).toEqual(["localhost", "example.com:8443", "https://example.com", "[::1]", "*"]);
    expect(network.egress!.allow).toEqual(["ok.example.com", "mount.*.archil.com", "data.*.archil.com"]);
  });
});

describe("doorUp", () => {
  const KEY = "sk-ant-door-test-0123456789";
  const ANTHROPIC: DoorKey = { name: "ANTHROPIC_API_KEY", value: KEY, host: "api.anthropic.com", headers: { "x-api-key": KEY } };

  interface BringUp extends Pick<DoorUpOptions, "env" | "keys" | "allow"> {
    /** What the service script prints; by default, that the service has every variable it was given. */
    serviceAnswer?: object;
    /** How Archil answers a sandbox that asks for a network policy: "refuse" as the Free plan does, or with this error. */
    policy?: "refuse" | Error;
  }

  /** doorUp against Archil's real SDK on a local fake for the disk, and a recording stand-in for sandboxes. */
  async function bringUp(given: BringUp = {}) {
    const fake = await startFakeArchil();
    fake.on((r) => (r.method === "PUT" ? { status: 200 } : undefined));
    const real = new Archil({ apiKey: "key-offline-test", region: "aws-us-west-2", baseUrl: fake.url, s3BaseUrl: fake.url });
    const created: { request: any; options: any }[] = [];
    const execs: { command: string; script: string; env?: Record<string, string> }[] = [];
    const lifecycle: string[] = [];
    const logs: string[] = [];
    const sandbox = {
      id: "sbx-door-test",
      name: "",
      status: "running",
      async refresh() {},
      async exec(command: string, options: { env?: Record<string, string> } = {}) {
        // Every command doorUp runs is a node script, sent base64-encoded.
        const script = Buffer.from(/printf %s '([^']+)'/.exec(command)?.[1] ?? "", "base64").toString("utf8");
        execs.push({ command, script, ...(options.env ? { env: options.env } : {}) });
        const isService = script.includes('"services", "create", "atoll"');
        const stdout = isService ? JSON.stringify(given.serviceAnswer ?? { ok: true, env: Object.keys(options.env ?? {}) }) : "healthy";
        return { status: "exited", exitCode: 0, stdout, stderr: "" };
      },
      async createPortToken() {
        return { id: "ptk-door-test", token: "port-token-door-test", hostname: "8080-sbx-door-test.example.archil.app", expiresAt: new Date("2027-11-05T00:00:00Z") };
      },
      async stop() {
        lifecycle.push("stop");
        this.status = "stopped";
      },
      async delete() {
        lifecycle.push("delete");
        this.status = "deleted";
      },
    };
    const sandboxes = {
      async list() {
        return [];
      },
      async create(request: any, options: any) {
        created.push({ request, options });
        if (request.network && given.policy === "refuse") throw new ArchilError("Network policies are not available on the Free plan", 403, "sandbox_network_plan_required");
        if (request.network && given.policy) throw given.policy;
        sandbox.name = request.name;
        return sandbox;
      },
    };
    const archil = Object.create(real, { sandboxes: { value: sandboxes } }) as Archil;
    const dir = await mkdtemp(join(tmpdir(), "atoll-door-up-"));
    const doorsFile = join(dir, "doors.json");
    try {
      const { env, keys, allow } = given;
      const result = await doorUp({ archil, diskId: DISK_ID, atollName: "radar", runtimeBundle: new TextEncoder().encode("// the runtime"), doorsFile, log: (line) => logs.push(line), ...(env ? { env } : {}), ...(keys ? { keys } : {}), ...(allow ? { allow } : {}) }).catch((error: Error) => error);
      const written = fake.requests.filter((r) => r.method === "PUT").map((r) => ({ path: r.path, body: r.body.toString("utf8") }));
      const doors = await readFile(doorsFile, "utf8").catch(() => "");
      return { result, created, execs, lifecycle, logs, written, doors };
    } finally {
      await fake.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Everything doorUp put inside the sandbox or on this machine's side of it: commands, scripts, their env, the disk, doors.json, the log. */
  function everywhereButThePolicy(run: Awaited<ReturnType<typeof bringUp>>): string {
    return JSON.stringify([run.execs, run.written, run.doors, run.logs, run.result instanceof Error ? run.result.message : run.result]);
  }

  it("gives Archil a model key in the network policy, and the sandbox only a placeholder", async () => {
    const run = await bringUp({ keys: [ANTHROPIC], allow: ["registry.npmjs.org"] });
    const { result, created, execs, written } = run;
    const network = { egress: "declared", allow: ["api.anthropic.com", "registry.npmjs.org"], brokered: ["ANTHROPIC_API_KEY"] };
    expect(result).toMatchObject({ sandboxId: "sbx-door-test", name: "atoll-radar-door", port: 8080, network });
    expect(created).toHaveLength(1);
    expect(created[0]!.request).toMatchObject({ name: "atoll-radar-door", mounts: [{ disk: DISK_ID, path: "/mnt/atoll", conditional: true }] });
    expect(created[0]!.request.network).toEqual({
      egress: { default: "deny", allow: [{ target: "api.anthropic.com", transform: { headers: { "x-api-key": KEY } } }, "registry.npmjs.org", "mount.*.archil.com", "data.*.archil.com"] },
    });
    // The sandbox itself has no environment: Archil gives that to execs, and services never see it.
    expect(created[0]!.request).not.toHaveProperty("env");
    expect(execs).toHaveLength(2);
    expect(execs[0]!.script).toBe(serviceScript(["ANTHROPIC_API_KEY"]));
    expect(execs[0]!.env).toEqual({ ANTHROPIC_API_KEY: "brokered-by-archil" });
    expect(execs[1]!.env).toBeUndefined();
    // The policy is the only place the key went.
    expect(everywhereButThePolicy(run)).not.toContain(KEY);
    expect(written.map((w) => w.path)).toEqual([`/${DISK_ID}/.atoll/bin/atoll.mjs`, `/${DISK_ID}/.atoll/door.json`]);
    expect(JSON.parse(written[1]!.body).network).toEqual(network);
    expect(run.doors).toContain("port-token-door-test");
  });

  it("on a plan that can't set a policy, hands the key to the service through one exec's env field, never a command's text or the disk", async () => {
    const run = await bringUp({ keys: [ANTHROPIC], allow: ["registry.npmjs.org"], policy: "refuse" });
    const { result, created, execs, lifecycle, logs, written, doors } = run;
    expect(result).toMatchObject({ sandboxId: "sbx-door-test", network: { egress: "managed", allow: [], brokered: [] } });
    // Asked for with a policy, refused, and asked for again without one. Nothing was created to clean up.
    expect(created).toHaveLength(2);
    expect(created[0]!.request).toHaveProperty("network");
    expect(created[1]!.request).not.toHaveProperty("network");
    expect(created[1]!.request).not.toHaveProperty("env");
    expect({ ...created[0]!.request, network: undefined }).toEqual({ ...created[1]!.request, network: undefined });
    expect(lifecycle).toEqual([]);
    expect(logs.join("\n")).toContain("can't set a sandbox's network policy");
    expect(execs).toHaveLength(2);
    expect(execs[0]!.script).toBe(serviceScript(["ANTHROPIC_API_KEY"]));
    expect(execs[0]!.env).toEqual({ ANTHROPIC_API_KEY: KEY });
    expect(execs[1]!.env).toBeUndefined();
    for (const { command, script } of execs) {
      expect(command).not.toContain(KEY);
      expect(script).not.toContain(KEY);
    }
    expect(written.map((w) => w.path)).toEqual([`/${DISK_ID}/.atoll/bin/atoll.mjs`, `/${DISK_ID}/.atoll/door.json`]);
    for (const { body } of written) expect(body).not.toContain(KEY);
    expect(doors).toContain("port-token-door-test");
    expect(doors).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("doesn't come up, and doesn't repeat a key, when Archil refuses the policy for any other reason", async () => {
    const run = await bringUp({ keys: [ANTHROPIC], policy: new ArchilError(`invalid header value "${KEY}" for api.anthropic.com`, 400, "bad_request") });
    expect(run.result).toBeInstanceOf(Error);
    expect((run.result as Error).message).toBe('invalid header value "[redacted]" for api.anthropic.com');
    expect(run.created).toHaveLength(1);
    expect(run.execs).toEqual([]);
    expect(run.doors).toBe("");
    expect(everywhereButThePolicy(run)).not.toContain(KEY);
  });

  it("takes the sandbox down when the service comes up without a key it was given", async () => {
    for (const policy of [undefined, "refuse"] as const) {
      const { result, lifecycle, written, doors } = await bringUp({ keys: [ANTHROPIC], serviceAnswer: { ok: true, env: [] }, ...(policy ? { policy } : {}) });
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe("The atoll service was created without ANTHROPIC_API_KEY");
      expect(lifecycle).toEqual(["stop", "delete"]);
      expect(written.map((w) => w.path)).toEqual([`/${DISK_ID}/.atoll/bin/atoll.mjs`]);
      expect(doors).toBe("");
    }
    const failed = await bringUp({ keys: [ANTHROPIC], policy: "refuse", serviceAnswer: { ok: false, error: `archil services create exited 2: bad --env ANTHROPIC_API_KEY=${KEY}` } });
    expect((failed.result as Error).message).toBe("The atoll service didn't start: archil services create exited 2: bad --env ANTHROPIC_API_KEY=[redacted]");
    expect(failed.logs.join("\n")).not.toContain(KEY);
  });

  it("hands nothing over when there's nothing to hand over, and lets the door reach only its disk", async () => {
    const { result, created, execs } = await bringUp();
    expect(created[0]!.request).not.toHaveProperty("env");
    expect(created[0]!.request.network).toEqual({ egress: { default: "deny", allow: ["mount.*.archil.com", "data.*.archil.com"] } });
    expect(execs.map((e) => e.env)).toEqual([undefined, undefined]);
    expect(result).toMatchObject({ network: { egress: "declared", allow: [], brokered: [] } });
  });

  it("gives the service plain environment as it is, on either plan", async () => {
    for (const policy of [undefined, "refuse"] as const) {
      const { execs } = await bringUp({ env: { ATOLL_LOG: "debug" }, keys: [ANTHROPIC], ...(policy ? { policy } : {}) });
      expect(execs[0]!.env).toEqual({ ATOLL_LOG: "debug", ANTHROPIC_API_KEY: policy ? KEY : "brokered-by-archil" });
    }
  });

  it("says which declared hosts the policy left out, and when the sandbox names no CA for the rewritten requests", async () => {
    const quiet = await bringUp({ keys: [ANTHROPIC], allow: ["registry.npmjs.org"], serviceAnswer: { ok: true, env: ["ANTHROPIC_API_KEY", "NODE_EXTRA_CA_CERTS"], ca: true } });
    expect(quiet.logs.join("\n")).not.toMatch(/left|egress CA/);
    const loud = await bringUp({ keys: [ANTHROPIC], allow: ["localhost", "registry.npmjs.org"], serviceAnswer: { ok: true, env: ["ANTHROPIC_API_KEY"], ca: false } });
    expect(loud.logs).toContain('left localhost out of the network policy: it takes host names, "*." wildcards, and IPv4 addresses');
    expect(loud.logs.join("\n")).toContain("names no egress CA (NODE_EXTRA_CA_CERTS)");
    // Neither matters to a door Archil isn't rewriting requests for.
    const noKeys = await bringUp({ serviceAnswer: { ok: true, env: [], ca: false } });
    expect(noKeys.logs.join("\n")).not.toContain("egress CA");
    const managed = await bringUp({ keys: [ANTHROPIC], allow: ["localhost"], policy: "refuse", serviceAnswer: { ok: true, env: ["ANTHROPIC_API_KEY"], ca: false } });
    expect(managed.logs.join("\n")).not.toMatch(/left localhost|egress CA/);
  });
});

describe("the service script, run against a stand-in for Archil's services command", () => {
  const KEY = "sk-ant-service-test-0123456789";

  /** Run the script with a fake `archil` first on PATH, which records its arguments and answers as told. */
  async function runScript(names: string[], env: Record<string, string>, answer: { status: number; stdout?: string; echoArgs?: boolean }) {
    const dir = await mkdtemp(join(tmpdir(), "atoll-service-script-"));
    try {
      const argsFile = join(dir, "args.json");
      await writeFile(
        join(dir, "archil"),
        `#!${process.execPath}
const args = process.argv.slice(2);
require("node:fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const env = {};
for (let i = 0; i < args.length; i++) if (args[i] === "--env") { const [k, ...v] = args[i + 1].split("="); env[k] = v.join("="); }
if (${answer.status} !== 0) { process.stderr.write(${answer.echoArgs ? '"bad request: " + args.join(" ")' : '"bad request"'}); process.exit(${answer.status}); }
process.stdout.write(${answer.stdout === undefined ? 'JSON.stringify({ name: "atoll", enabled: true, env, tcp_port: 8080 })' : JSON.stringify(answer.stdout)});
`,
      );
      await chmod(join(dir, "archil"), 0o755);
      const run = spawnSync(process.execPath, ["-e", serviceScript(names)], { encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, ...env } });
      let args: string[] | null = null;
      try {
        args = JSON.parse(await readFile(argsFile, "utf8"));
      } catch {}
      return { code: run.status, out: run.stdout.trim(), args };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("creates the service with the key from its own environment, and prints only the names", async () => {
    const { code, out, args } = await runScript(["ANTHROPIC_API_KEY"], { ANTHROPIC_API_KEY: KEY }, { status: 0 });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ ok: true, env: ["ANTHROPIC_API_KEY"], ca: false });
    expect(out).not.toContain(KEY);
    expect(args).toEqual(["services", "create", "atoll", "--tcp-port", "8080", "--env", `ANTHROPIC_API_KEY=${KEY}`, "--", "node", "/mnt/atoll/.atoll/bin/atoll.mjs", "serve", "--dir", "/mnt/atoll", "--mounted", "/mnt/atoll", "--port", "8080", "--host", "0.0.0.0"]);
  });

  it("passes on the CA its own environment names, since a service gets none of that environment", async () => {
    const serve = ["--", "node", "/mnt/atoll/.atoll/bin/atoll.mjs", "serve", "--dir", "/mnt/atoll", "--mounted", "/mnt/atoll", "--port", "8080", "--host", "0.0.0.0"];
    const passed = await runScript(["ANTHROPIC_API_KEY"], { ANTHROPIC_API_KEY: "brokered-by-archil", NODE_EXTRA_CA_CERTS: "/etc/archil/egress-ca.pem" }, { status: 0 });
    expect(passed.code).toBe(0);
    expect(JSON.parse(passed.out)).toEqual({ ok: true, env: ["ANTHROPIC_API_KEY", "NODE_EXTRA_CA_CERTS"], ca: true });
    expect(passed.args).toEqual(["services", "create", "atoll", "--tcp-port", "8080", "--env", "ANTHROPIC_API_KEY=brokered-by-archil", "--env", "NODE_EXTRA_CA_CERTS=/etc/archil/egress-ca.pem", ...serve]);
    // A CA the caller names itself goes in once, as the caller gave it.
    const named = await runScript(["NODE_EXTRA_CA_CERTS"], { NODE_EXTRA_CA_CERTS: "/etc/archil/egress-ca.pem" }, { status: 0 });
    expect(named.args).toEqual(["services", "create", "atoll", "--tcp-port", "8080", "--env", "NODE_EXTRA_CA_CERTS=/etc/archil/egress-ca.pem", ...serve]);
    expect(JSON.parse(named.out)).toEqual({ ok: true, env: ["NODE_EXTRA_CA_CERTS"], ca: true });
  });

  it("says so when a key didn't arrive, hides a value an error echoes, and copes with an answer it can't read", async () => {
    const absent = await runScript(["ANTHROPIC_API_KEY"], {}, { status: 0 });
    expect(absent.code).toBe(1);
    expect(JSON.parse(absent.out)).toEqual({ ok: false, error: "ANTHROPIC_API_KEY didn't reach the sandbox" });
    expect(absent.args).toBeNull();

    const refused = await runScript(["ANTHROPIC_API_KEY"], { ANTHROPIC_API_KEY: KEY }, { status: 2, echoArgs: true });
    expect(refused.code).toBe(1);
    expect(refused.out).not.toContain(KEY);
    expect(JSON.parse(refused.out)).toMatchObject({ ok: false, error: expect.stringContaining("archil services create exited 2: bad request: services create atoll") });
    expect(JSON.parse(refused.out).error).toContain("ANTHROPIC_API_KEY=[redacted]");

    const unreadable = await runScript([], {}, { status: 0, stdout: "service created" });
    expect(JSON.parse(unreadable.out)).toEqual({ ok: true, env: null, ca: false });
  });
});
