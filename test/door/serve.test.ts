import { afterEach, describe, expect, it } from "vitest";
import { serve, TickQueue, MAX_BODY_BYTES, type DoorEvent, type DoorServer, type ServeOptions } from "../../src/door/serve.ts";
import type { FiveAnswers, TickReport } from "../../src/runtime/types.ts";
import type { Store } from "../../src/store/types.ts";

const store = { location: "dir:/tmp/fake-atoll" } as Store;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function report(n: number): TickReport {
  return {
    ran: true,
    epoch: 1,
    turns: n,
    failures: 0,
    duplicates: 0,
    effects: { done: 0, failed: 0, inDoubt: 0, awaitingApproval: 0, overBudget: 0 },
    timersFired: 0,
    answersApplied: 0,
    recovered: { reinstalled: 0, stagingCleared: 0, inDoubt: 0 },
    remaining: 0,
    nextWake: null,
    lastSeq: n,
  };
}

const answers = { atoll: "radar", location: store.location, code: null } as FiveAnswers;

/** A door with fake runtime functions that record what they were asked to do. */
async function door(overrides: Partial<ServeOptions> = {}) {
  const delivered: DoorEvent[] = [];
  const deliveredAt = new Map<string, number>();
  const tickStarts: number[] = [];
  let running = 0;
  let maxRunning = 0;
  let next = 0;
  const server = await serve({
    store,
    port: 0,
    log: () => {},
    async deliver(event) {
      const id = event.id ?? `e${++next}`;
      delivered.push(event);
      deliveredAt.set(id, performance.now());
      return { id, duplicate: false };
    },
    async tick() {
      tickStarts.push(performance.now());
      const n = tickStarts.length;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(30);
      running -= 1;
      return report(n);
    },
    async status() {
      return answers;
    },
    ...overrides,
  });
  servers.push(server);
  return { server, delivered, deliveredAt, tickStarts, maxRunning: () => maxRunning };
}

const servers: DoorServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function call(server: DoorServer, path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const response = await fetch(`${server.url}${path}`, { ...init, headers });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("serve", () => {
  it("answers /healthz without auth, and everything else only with the bearer token", async () => {
    const { server } = await door({ token: "s3cret" });
    expect(await call(server, "/healthz")).toMatchObject({ status: 200, text: "ok" });
    const denied = await call(server, "/status");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect((await call(server, "/status", { token: "wrong" })).status).toBe(401);
    expect((await call(server, "/tick", { method: "POST", token: "s3cre" })).status).toBe(401);
    expect((await call(server, "/nowhere")).status).toBe(401);
    const ok = await call(server, "/status", { token: "s3cret" });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual(answers);
  });

  it("delivers an event from @door, ticks, and reports both", async () => {
    const { server, delivered, tickStarts } = await door();
    const res = await call(server, "/events", post({ to: "watch/rivetkit", type: "watch.poll", body: { n: 1 }, id: "01JC4Z7V3J8YQ2WQ8N5K6M3T1B", cause: "c1", from: "@owner" }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: "01JC4Z7V3J8YQ2WQ8N5K6M3T1B", duplicate: false, report: report(1) });
    expect(delivered).toEqual([{ to: "watch/rivetkit", type: "watch.poll", from: "@door", body: { n: 1 }, id: "01JC4Z7V3J8YQ2WQ8N5K6M3T1B", cause: "c1" }]);
    expect(tickStarts).toHaveLength(1);
  });

  it("rejects malformed events without delivering them", async () => {
    const { server, delivered } = await door();
    for (const bad of ["not json", "[]", "null", { type: "x" }, { to: "", type: "x" }, { to: "a", type: 3 }, { to: "a", type: "x", id: 7 }]) {
      const res = await call(server, "/events", post(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(typeof res.json.error).toBe("string");
    }
    expect(delivered).toHaveLength(0);
  });

  it("refuses bodies over 1 MiB with 413", async () => {
    const { server, delivered } = await door();
    const big = JSON.stringify({ to: "a", type: "b", body: "x".repeat(MAX_BODY_BYTES) });
    const res = await call(server, "/events", post(big));
    expect(res.status).toBe(413);
    expect(delivered).toHaveLength(0);
    const fits = JSON.stringify({ to: "a", type: "b", body: "x".repeat(MAX_BODY_BYTES - 100) });
    expect((await call(server, "/events", post(fits))).status).toBe(200);
  });

  it("ticks on POST /tick", async () => {
    const { server } = await door();
    const res = await call(server, "/tick", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual(report(1));
  });

  it("answers 404 for unknown routes and 405 for wrong methods", async () => {
    const { server } = await door();
    expect((await call(server, "/nope")).status).toBe(404);
    expect((await call(server, "/events/extra", post({}))).status).toBe(404);
    const wrong = await call(server, "/events");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    expect((await call(server, "/status", post({}))).status).toBe(405);
  });

  it("serializes ticks, and every event's tick starts after the event was delivered", async () => {
    const { server, deliveredAt, tickStarts, maxRunning } = await door();
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? call(server, "/tick", { method: "POST" }) : call(server, "/events", post({ to: "a", type: "b", id: `ev${i}` })))),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(maxRunning()).toBe(1);
    expect(tickStarts.length).toBeGreaterThanOrEqual(1);
    expect(tickStarts.length).toBeLessThanOrEqual(12);
    for (const res of responses.filter((r) => r.json.id)) {
      const tickNumber = res.json.report.lastSeq as number;
      expect(deliveredAt.get(res.json.id)!).toBeLessThanOrEqual(tickStarts[tickNumber - 1]!);
    }
  });

  it("reports runtime failures with their status, and keeps serving", async () => {
    let fail = true;
    const { server } = await door({
      async tick() {
        if (fail) throw new Error("lease held by another runner");
        return report(9);
      },
      async deliver(event) {
        if (event.to === "nobody") throw Object.assign(new Error('no part "nobody"'), { status: 400 });
        return { id: "e1", duplicate: true };
      },
    });
    expect(await call(server, "/tick", { method: "POST" })).toMatchObject({ status: 500, json: { error: "lease held by another runner" } });
    expect(await call(server, "/events", post({ to: "nobody", type: "x" }))).toMatchObject({ status: 400, json: { error: 'no part "nobody"' } });
    fail = false;
    expect(await call(server, "/events", post({ to: "a", type: "x" }))).toMatchObject({ status: 200, json: { id: "e1", duplicate: true, report: report(9) } });
  });

  it("finishes the tick in flight before close resolves", async () => {
    let finished = false;
    const { server } = await door({
      async tick() {
        await sleep(80);
        finished = true;
        return report(1);
      },
    });
    const inFlight = call(server, "/tick", { method: "POST" });
    await sleep(20);
    servers.splice(servers.indexOf(server), 1);
    await server.close();
    expect(finished).toBe(true);
    expect((await inFlight).status).toBe(200);
  });
});

describe("TickQueue", () => {
  it("shares a queued tick between callers that arrive before it starts", async () => {
    let calls = 0;
    const queue = new TickQueue(async () => {
      calls += 1;
      await sleep(20);
      return report(calls);
    });
    const first = queue.request();
    await sleep(5); // the first tick is running
    const [a, b, c] = [queue.request(), queue.request(), queue.request()];
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect((await first).lastSeq).toBe(1);
    expect((await a).lastSeq).toBe(2);
    expect(calls).toBe(2);
    await queue.idle();
  });
});
