import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAtoll, type TestAtoll } from "../../src/testing.ts";
import { LocalStore, defineSystem, deliver, tick, push, replay, readJournal } from "../../src/index.ts";
import { Lease } from "../../src/runtime/lease.ts";
import { counterSystem } from "./fixtures.ts";

let s: TestAtoll | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("duplicates", () => {
  it("stores an event once however often it is delivered, and handles it once", async () => {
    s = await testAtoll(counterSystem());
    const id = "01JC4Z7V3J8YQ2WQ8N5K6M3T1B";
    expect((await deliver(s.store, { to: "counter", type: "ping", id })).duplicate).toBe(false);
    expect((await deliver(s.store, { to: "counter", type: "ping", id })).duplicate).toBe(true);
    await s.tick();
    expect((await deliver(s.store, { to: "counter", type: "ping", id })).duplicate).toBe(true);
    await s.tick();
    expect(await s.json("parts/counter/count.json")).toEqual({ n: 1 });
  });

  it("records a redelivered event that slipped into the inbox as a duplicate without running code", async () => {
    s = await testAtoll(counterSystem());
    const id = await s.send("counter", "ping");
    await s.tick();
    // Put the same event back by hand, bypassing deliver()'s check.
    await s.store.inner.put(`inbox/${id}.json`, JSON.stringify({ id, type: "ping", to: "counter", from: "@owner", at: s.now().toISOString(), body: {} }));
    const report = await s.tick();
    expect(report.duplicates).toBe(1);
    expect(await s.json("parts/counter/count.json")).toEqual({ n: 1 });
  });
});

describe("the lease", () => {
  it("lets exactly one of many concurrent runners take an epoch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atoll-lease-"));
    const store = new LocalStore(dir);
    const clock = () => new Date("2026-01-05T09:00:00Z");
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => Lease.acquire(store, { runner: `r${i}`, ttlMs: 60_000, clock })));
    expect(results.filter((r) => r.lease).length).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  it("makes concurrent ticks take turns, and handles every event exactly once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atoll-race-"));
    const store = new LocalStore(dir);
    const system = counterSystem();
    await push({ store, system, version: "test", codeVersion: "test" } as any);
    for (let i = 0; i < 10; i++) await deliver(store, { to: "counter", type: "ping" });
    const reports = await Promise.all(Array.from({ length: 5 }, (_, i) => tick({ store, system, codeVersion: "test", runner: `r${i}`, stubsOnly: true })));
    // Ticks that found the lease held did nothing; the rest drained the inbox between them.
    for (let i = 0; i < 5; i++) await tick({ store, system, codeVersion: "test", runner: `late${i}`, stubsOnly: true });
    expect(reports.some((r) => r.ran)).toBe(true);
    const count = JSON.parse(new TextDecoder().decode((await store.get("parts/counter/count.json"))!));
    expect(count).toEqual({ n: 10 });
    const { records, stale } = await readJournal(store);
    expect(stale).toEqual([]);
    const seqs = records.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps its lease alive while a slow effect runs, so no second runner starts the same work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atoll-slow-"));
    const store = new LocalStore(dir);
    const system = defineSystem({
      name: "slow",
      parts: {
        worker: {
          purpose: "Run one slow thing and note that it finished",
          on: {
            go: (t) => {
              t.effect("slow", {}, { then: "went" });
              t.wait({ for: "went", reason: "the slow thing" });
            },
            went: (t) => t.write("done.txt", "done"),
          },
        },
      },
      effects: { slow: { kind: "custom", run: () => null } },
    });
    const expiry = async () => {
      const leases = await store.list(".atoll/lease/");
      return Date.parse(JSON.parse(new TextDecoder().decode((await store.get(leases.at(-1)!.key))!)).expiresAt);
    };
    // The effect takes more than twice the lease's 200 ms, and looks at the lease before and after.
    const seen: number[] = [];
    const slow = async () => {
      seen.push(await expiry());
      await new Promise((resolve) => setTimeout(resolve, 450));
      seen.push(await expiry());
      return {};
    };
    const options = { store, system, codeVersion: "test", runner: "slow-runner", leaseTtlMs: 200, stubs: { slow }, stubsOnly: true };
    await push({ ...options, version: "test" } as any);
    await deliver(store, { to: "worker", type: "go" });
    await tick(options);
    // Renewed while the effect ran: by its end the lease reached past where it stood at the start.
    expect(seen).toHaveLength(2);
    expect(seen[1]! - seen[0]!).toBeGreaterThanOrEqual(200);
    expect(new TextDecoder().decode((await store.get("parts/worker/done.txt"))!)).toBe("done");
    await rm(dir, { recursive: true, force: true });
  });

  it("fences a runner whose lease was taken over before it can commit", async () => {
    s = await testAtoll(counterSystem());
    await s.send("counter", "ping");
    // Another runner takes the next epoch just before this runner's first fence check.
    const original = s.store.head.bind(s.store);
    let first = true;
    s.store.head = async (key) => {
      if (first && key.startsWith(".atoll/lease/")) {
        first = false;
        await s!.store.inner.create(key, JSON.stringify({ epoch: Number(key.split("/").at(-1)), runner: "intruder", acquiredAt: "", expiresAt: "2099-01-01T00:00:00Z" }));
      }
      return original(key);
    };
    await expect(s.tick()).rejects.toThrow(/taken over/);
    s.store.head = original;
    expect(await s.json("parts/counter/count.json")).toBeNull();
    expect((await s.journal()).filter((r) => r.kind === "turn")).toEqual([]);
  });
});

describe("waits, timers, and schedules", () => {
  it("fires a timed wait once, at the first tick after it is due", async () => {
    s = await testAtoll(counterSystem());
    await s.send("nag", "start");
    await s.tick();
    expect(await s.read("parts/nag/timer-fired.txt")).toBeNull();
    await s.advance("23h");
    expect(await s.read("parts/nag/timer-fired.txt")).toBeNull();
    await s.advance("2h");
    expect(await s.read("parts/nag/timer-fired.txt")).not.toBeNull();
    await s.advance("2h");
    const timers = (await s.journal()).filter((r) => r.kind === "turn" && (r as any).event.type === "timer");
    expect(timers.length).toBe(1);
  });

  it("re-arms a schedule after each firing, and fires a missed schedule once", async () => {
    s = await testAtoll(counterSystem(), { stubs: { "page.get": () => ({ status: 200, text: "same" }) } });
    await s.send("watch/home", "watch.start", { url: "https://example.com/" });
    await s.tick();
    expect(s.calls("page.get").length).toBe(1);
    await s.advance("61m");
    expect(s.calls("page.get").length).toBe(2);
    await s.advance("5h"); // five periods missed while nothing ticked
    expect(s.calls("page.get").length).toBe(3);
    const status = await s.status();
    const watch = status.waiting.find((w) => w.address === "watch/home")!;
    expect(watch.waits.some((w) => w.schedule === 0)).toBe(true);
  });

  it("tells the owner only when the page changes, with the receipt", async () => {
    let body = "v1";
    s = await testAtoll(counterSystem(), { stubs: { "page.get": () => ({ status: 200, text: body }) } });
    await s.send("watch/home", "watch.start", { url: "https://example.com/" });
    await s.tick();
    await s.advance("61m");
    expect(await s.list("notices/")).toEqual([]);
    body = "v2";
    await s.advance("61m");
    const notices = await s.list("notices/");
    expect(notices.length).toBe(1);
    const text = await s.read(notices[0]!);
    expect(text).toContain("The page changed: v2");
    expect(text).toContain("Evidence: sha256:");
  });
});

describe("asks", () => {
  it("delivers the owner's answer to the asking part and closes the ask", async () => {
    s = await testAtoll(counterSystem());
    await s.send("nag", "start");
    await s.tick();
    const [ask] = await s.asks();
    expect(ask!.question).toBe("Keep going?");
    expect(await s.read(`asks/${ask!.id}.md`)).toContain("If nobody answers by");
    await s.answer(ask!.id, "yes", { draft: "edited" });
    expect(await s.json("parts/nag/answer.json")).toMatchObject({ ask: ask!.id, option: "yes", payload: { draft: "edited" }, by: "owner" });
    expect(await s.asks()).toEqual([]);
    expect((await s.json(`asks/closed/${ask!.id}.json`)).answer.option).toBe("yes");
  });

  it("applies the default when an ask expires", async () => {
    s = await testAtoll(counterSystem());
    await s.send("nag", "start");
    await s.tick();
    await s.advance("3d");
    expect(await s.json("parts/nag/expired.json")).toMatchObject({ option: "no", by: "expiry" });
    const status = await s.status();
    expect(status.waiting.find((w) => w.address === "nag")!.status).toBe("done");
  });

  it("accepts an answer written as a file by hand", async () => {
    s = await testAtoll(counterSystem());
    await s.send("nag", "start");
    await s.tick();
    const [ask] = await s.asks();
    await s.store.put(`asks/${ask!.id}.answer.json`, JSON.stringify({ option: "no" }));
    await s.tick();
    expect(await s.json("parts/nag/answer.json")).toMatchObject({ option: "no" });
  });
});

describe("approvals", () => {
  it("runs an approved effect once, with exactly the edited arguments", async () => {
    const sent: any[] = [];
    s = await testAtoll(counterSystem(), { stubs: { "message.send": (args) => (sent.push(args), { sent: true }) } });
    await s.send("speaker", "say", { text: "hello sam" });
    await s.tick();
    expect(sent).toEqual([]);
    const [ask] = await s.asks();
    expect(ask!.question).toBe('Send sam "hello sam"?');
    expect(ask!.default).toBe("deny");
    await s.answer(ask!.id, "approve", { to: "sam", text: "hello Sam, edited" });
    expect(sent).toEqual([{ to: "sam", text: "hello Sam, edited" }]);
    await s.tick();
    expect(sent.length).toBe(1);
    const approved = (await s.journal()).find((r) => r.kind === "effect" && (r as any).state === "approved") as any;
    expect(approved.approvedBy).toBe(ask!.id);
  });

  it("never runs an effect whose approval expires", async () => {
    const sent: any[] = [];
    s = await testAtoll(counterSystem(), { stubs: { "message.send": (args) => (sent.push(args), { sent: true }) } });
    await s.send("speaker", "say", { text: "hello" });
    await s.tick();
    await s.advance("4d");
    expect(sent).toEqual([]);
    expect(await s.json("parts/speaker/outcome.json")).toMatchObject({ ok: false, denied: true });
  });
});

describe("budgets", () => {
  it("parks an effect that would exceed its budget and asks to allow it", async () => {
    s = await testAtoll(counterSystem(), { realEffects: true });
    for (let i = 0; i < 3; i++) await s.send("thinker", "think", { prompt: `q${i}` });
    await s.tick();
    expect((await s.list("parts/thinker/answers/")).length).toBe(2);
    const [ask] = await s.asks();
    expect(ask!.effect!.reason).toBe("over-budget");
    expect(ask!.why).toContain("used 2 of its 2 calls today");
    await s.answer(ask!.id, "allow");
    expect((await s.list("parts/thinker/answers/")).length).toBe(3);
    const answer = await s.json((await s.list("parts/thinker/answers/"))[0]!);
    expect(answer.result).toMatchObject({ standIn: true, json: { answer: "stand-in answer to q0" } });
  });
});

describe("large effect results", () => {
  it("delivers a result too big for a journal record as a pointer to its evidence", async () => {
    const big = "x".repeat(200_000);
    const system = counterSystem();
    system.parts.reader = {
      purpose: "Fetch a large page and keep its size",
      on: {
        go: (t) => {
          t.effect("page.get", { url: "https://example.com/big" }, { then: "got" });
        },
        got: async (t, e) => {
          const text = e.body.result.tooLarge ? await t.readEvidence(e.body.result.body) : e.body.result.text;
          t.write("size.json", { size: JSON.parse(text!).text.length, viaEvidence: Boolean(e.body.result.tooLarge) });
        },
      },
    };
    s = await testAtoll(system, { stubs: { "page.get": () => ({ status: 200, text: big }) } });
    await s.send("reader", "go");
    await s.tick();
    expect(await s.json("parts/reader/size.json")).toEqual({ size: 200_000, viaEvidence: true });
    const longest = Math.max(...(await s.journal()).map((r) => JSON.stringify(r).length));
    expect(longest).toBeLessThan(70_000);
  });
});

describe("replay", () => {
  it("reproduces every recorded turn exactly when replayed through the same code", async () => {
    s = await testAtoll(counterSystem(), { stubs: { "page.get": () => ({ status: 200, text: "v" + Math.floor(Math.random() * 3) }) } });
    await s.send("counter", "ping");
    await s.send("counter", "ping");
    await s.send("watch/home", "watch.start", { url: "https://example.com/" });
    await s.send("nag", "start");
    await s.tick();
    await s.advance("2h");
    await s.advance("2d");
    const report = await replay(s.store, s.system);
    expect(report.turns).toBeGreaterThan(8);
    expect(report.different).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.same).toBe(report.turns);
  });

  it("shows which recorded turns a code change would handle differently", async () => {
    s = await testAtoll(counterSystem());
    await s.send("counter", "ping");
    await s.send("counter", "ping");
    await s.tick();
    const changed = counterSystem();
    changed.parts.counter!.on.ping = async (t) => {
      const state = (await t.json<{ n: number }>("count.json")) ?? { n: 0 };
      t.write("count.json", { n: state.n + 10 });
      t.send("ledger", "tally", { n: state.n + 10 });
      t.wait({ for: "ping", reason: "the next ping" });
    };
    const report = await replay(s.store, changed);
    const counterDiffs = report.different.filter((d) => d.part === "counter");
    expect(counterDiffs.length).toBe(2);
    expect(counterDiffs[0]!.differences.join(" ")).toContain("writes different content to parts/counter/count.json");
    expect(counterDiffs[0]!.differences.join(" ")).toContain("no longer writes parts/counter/history/0001.txt");
  });
});

describe("the dedupe window", () => {
  it("forgets handled event IDs after 30 days, and remembers them until then", async () => {
    s = await testAtoll(counterSystem());
    const id = "01JC4Z7V3J8YQ2WQ8N5K6M3T1C";
    await s.send("counter", "ping", {}, { id });
    await s.tick();
    await s.advance("29d");
    expect((await deliver(s.store, { to: "counter", type: "ping", id })).duplicate).toBe(true);
    await s.advance("2d");
    expect(await s.list(".atoll/seen/")).toEqual([]);
    expect((await deliver(s.store, { to: "counter", type: "ping", id }, s.now())).duplicate).toBe(false);
  });
});

describe("waits are what the last turn declared", () => {
  it("drops an old timer when a turn declares a new one, and keeps unsatisfied waits when it declares none", async () => {
    const system = counterSystem();
    system.parts.alarm = {
      purpose: "Ring once at the time I set, and move when I move it",
      on: {
        set: (t, e) => {
          t.wait({ until: e.body.at, reason: `ring at ${e.body.at}` });
        },
        poke: (t) => {
          t.note("poked; nothing about the alarm changed");
        },
        timer: (t) => {
          t.write(`rang-${t.now.toISOString().slice(11, 16)}.txt`, "ring");
          t.done("rang");
        },
      },
    };
    s = await testAtoll(system, { now: "2026-01-05T09:00:00Z" });
    await s.send("alarm", "set", { at: "2026-01-05T10:00:00Z" });
    await s.tick();
    await s.send("alarm", "set", { at: "2026-01-05T12:00:00Z" });
    await s.tick();
    await s.send("alarm", "poke");
    await s.tick();
    const waits = (await s.status()).waiting.find((w) => w.address === "alarm")!.waits;
    expect(waits.map((w) => w.until)).toEqual(["2026-01-05T12:00:00.000Z"]);
    await s.advance("4h");
    expect(await s.list("parts/alarm/")).toEqual(["parts/alarm/rang-13:00.txt", "parts/alarm/waiting.json"]);
  });
});

describe("http effects", () => {
  it("keeps only the picked fields of a JSON answer in the result, and the whole body in evidence", async () => {
    const system = counterSystem();
    system.parts.picker = {
      purpose: "Fetch a document and keep one field from it",
      on: {
        go: (t) => {
          t.effect("page.get", { url: "https://example.com/doc", pick: ["version", "dist.tarball"] }, { then: "got" });
        },
        got: async (t, e) => {
          t.write("result.json", e.body.result);
          t.write("whole.json", JSON.parse((await t.readEvidence(e.body.result.body))!));
        },
      },
    };
    const doc = { name: "x", version: "1.2.3", dist: { tarball: "https://example.com/x.tgz", shasum: "abc" }, readme: "y".repeat(50_000) };
    s = await testAtoll(system, { realEffects: true, stubs: {} });
    // Serve the document with a fetch stand-in so the real http effect code runs.
    const { tick } = await import("../../src/runtime/runner.ts");
    await s.send("picker", "go");
    await tick({ store: s.store, system, codeVersion: "test", now: () => s!.now(), fetch: (async () => new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } })) as typeof fetch });
    const result = await s.json("parts/picker/result.json");
    expect(result.json).toEqual({ version: "1.2.3", dist: { tarball: "https://example.com/x.tgz" } });
    expect(result.bytes).toBeGreaterThan(50_000);
    expect((await s.json("parts/picker/whole.json")).readme.length).toBe(50_000);
    const longest = Math.max(...(await s.journal()).map((r) => JSON.stringify(r).length));
    expect(longest).toBeLessThan(5_000);
  });
});

describe("the charter", () => {
  it("follows the declaration on push, and is attributed to the push", async () => {
    const system = { ...counterSystem(), charter: "Count what I send." };
    s = await testAtoll(system);
    expect(await s.read("CHARTER.md")).toContain("Count what I send.");
    const { push } = await import("../../src/runtime/atoll.ts");
    await push({ store: s.store, system: { ...system, charter: "Count what I send, and never more than ten." }, version: "v2", now: () => s!.now() });
    expect(await s.read("CHARTER.md")).toContain("never more than ten");
    const pushes = (await s.journal()).filter((r) => r.kind === "push") as any[];
    expect(pushes.at(-1).writes.map((w: any) => w.path)).toContain("CHARTER.md");
  });
});

describe("schedule cadence", () => {
  it("keeps an hourly schedule on the hour when the clock ticks hourly, a little late each time", async () => {
    s = await testAtoll(counterSystem(), { now: "2026-01-05T09:00:00Z", stubs: { "page.get": () => ({ status: 200, text: "same" }) } });
    await s.send("watch/home", "watch.start", { url: "https://example.com/" });
    await s.tick(); // armed for 10:00
    // Each tick lands a second earlier relative to the hour than the last, as a real clock's jitter does.
    // Re-arming from the tick's time would put each due time just after the next tick and skip every other hour.
    for (let i = 0; i < 6; i++) {
      s.setNow(new Date(Date.parse("2026-01-05T10:00:05Z") + i * 3_600_000 - i * 1000));
      await s.tick();
    }
    // One poll per hourly tick from 10:00:05 to 15:00:05, plus the first fetch: no skipped hours.
    expect(s.calls("page.get").length).toBe(7);
    const watch = (await s.status()).waiting.find((w) => w.address === "watch/home")!;
    expect(watch.waits.find((w) => w.schedule === 0)!.until).toBe("2026-01-05T16:00:00.000Z");
  });
});
