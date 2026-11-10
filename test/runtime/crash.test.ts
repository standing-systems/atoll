import { describe, expect, it } from "vitest";
import { testAtoll } from "../../src/testing.ts";
import { CrashError } from "../../src/store/faulty.ts";
import { checkAtoll } from "../../src/index.ts";
import { counterSystem } from "./fixtures.ts";

async function crashRun(k: number, applyThenCrash: boolean) {
  const s = await testAtoll(counterSystem());
  await s.send("counter", "ping");
  s.store.ops = 0;
  s.store.crashAt = k;
  s.store.applyThenCrash = applyThenCrash;
  let crashed = false;
  try {
    await s.tick();
  } catch (error) {
    if (!(error instanceof CrashError)) throw error;
    crashed = true;
  }
  await s.store.reset();
  // Let any lease the crash left behind expire, then recover with a new tick.
  s.setNow(new Date(s.now().getTime() + 5 * 60_000));
  await s.tick();
  return { s, crashed };
}

describe("a crash at any storage operation of a turn", () => {
  it("recovers to the same state, with each event handled exactly once", async () => {
    const clean = await testAtoll(counterSystem());
    await clean.send("counter", "ping");
    clean.store.ops = 0;
    await clean.tick();
    const total = clean.store.ops;
    // The scenario must cross enough storage operations to be a meaningful test of every crash point.
    expect(total).toBeGreaterThanOrEqual(15);
    await clean.close();

    let crashes = 0;
    for (const applyThenCrash of [false, true]) {
      for (let k = 1; k <= total; k++) {
        const { s, crashed } = await crashRun(k, applyThenCrash);
        if (crashed) crashes += 1;
        const label = `crash at op ${k}${applyThenCrash ? " (after it landed)" : ""}`;
        expect(await s.json("parts/counter/count.json"), label).toEqual({ n: 1 });
        expect((await s.json("parts/ledger/latest.json"))?.n, label).toBe(1);
        expect(await s.list("parts/counter/history/"), label).toEqual(["parts/counter/history/0001.txt"]);
        expect(await s.list("inbox/"), label).toEqual([]);
        expect(await s.list(".atoll/staging/"), label).toEqual([]);
        const turns = (await s.journal()).filter((r) => r.kind === "turn") as any[];
        expect(turns.map((t) => `${t.part}:${t.event.type}`), label).toEqual(["counter:ping", "ledger:tally"]);
        const errors = (await checkAtoll(s.store, s.system)).filter((p) => p.severity === "error");
        expect(errors, label).toEqual([]);
        await s.close();
      }
    }
    expect(crashes).toBeGreaterThan(total);
  }, 120_000);
});

describe("effects across a crash", () => {
  it("retries an idempotent effect whose outcome was never recorded", async () => {
    const s = await testAtoll(counterSystem(), { stubs: { "page.get": () => ({ status: 200, text: "v1" }) } });
    await s.send("watch/home", "watch.start", { url: "https://example.com/" });
    s.store.ops = 0;
    // Crash on the first write after the effect's "started" record.
    const original = s.store.append.bind(s.store);
    let startedSeen = false;
    s.store.append = async (key, body) => {
      const text = typeof body === "string" ? body : new TextDecoder().decode(body);
      if (startedSeen) throw new CrashError(0, "after started");
      await original(key, body);
      if (text.includes('"state":"started"')) startedSeen = true;
    };
    await expect(s.tick()).rejects.toThrow(CrashError);
    s.store.append = original;
    await s.store.reset();
    s.setNow(new Date(s.now().getTime() + 5 * 60_000));
    await s.tick();
    expect(s.calls("page.get").length).toBe(2);
    expect(await s.read("parts/watch/home/last.txt")).toBe("v1");
    await s.close();
  });

  it("marks a non-idempotent effect in doubt and asks, instead of running it again", async () => {
    let sent = 0;
    const s = await testAtoll(counterSystem(), { stubs: { "message.send": () => ({ sent: ++sent }) } });
    await s.send("speaker", "say", { text: "hi" });
    await s.tick();
    const approval = (await s.asks()).find((a) => a.effect?.reason === "approval")!;
    const original = s.store.append.bind(s.store);
    let startedSeen = false;
    s.store.append = async (key, body) => {
      const text = typeof body === "string" ? body : new TextDecoder().decode(body);
      if (startedSeen) throw new CrashError(0, "after started");
      await original(key, body);
      if (text.includes('"state":"started"')) startedSeen = true;
    };
    await expect(s.answer(approval.id, "approve")).rejects.toThrow(CrashError);
    s.store.append = original;
    await s.store.reset();
    s.setNow(new Date(s.now().getTime() + 5 * 60_000));
    await s.tick();
    expect(sent).toBe(1);
    const doubt = (await s.asks()).find((a) => a.effect?.reason === "in-doubt")!;
    expect(doubt.question).toContain("Did message.send");
    expect(doubt.default).toBe("unknown");
    const outbox = await s.json(`outbox/${doubt.effect!.id}.json`);
    expect(outbox.state).toBe("in-doubt");
    await s.answer(doubt.id, "happened");
    expect(sent).toBe(1);
    expect((await s.json("parts/speaker/outcome.json")).result).toEqual({ assumed: true, by: "owner" });
    await s.close();
  });
});

describe("an answer recorded just before a crash", () => {
  it("is applied by the next runner, so an approved effect still runs once", async () => {
    const sent: unknown[] = [];
    const s = await testAtoll(counterSystem(), { stubs: { "message.send": (args) => (sent.push(args), { sent: true }) } });
    await s.send("speaker", "say", { text: "hi" });
    await s.tick();
    const approval = (await s.asks()).find((a) => a.effect?.reason === "approval")!;
    // Crash on the first append after the answer record: the question is closed, the effect hasn't moved.
    const original = s.store.append.bind(s.store);
    let answered = false;
    s.store.append = async (key, body) => {
      const text = typeof body === "string" ? body : new TextDecoder().decode(body);
      if (answered) throw new CrashError(0, "after the answer");
      await original(key, body);
      if (text.includes('"kind":"answer"')) answered = true;
    };
    await expect(s.answer(approval.id, "approve", { to: "sam", text: "edited" })).rejects.toThrow(CrashError);
    s.store.append = original;
    await s.store.reset();
    s.setNow(new Date(s.now().getTime() + 5 * 60_000));
    await s.tick();
    expect(sent).toEqual([{ to: "sam", text: "edited" }]);
    expect((await s.json("parts/speaker/outcome.json")).ok).toBe(true);
    await s.tick();
    expect(sent.length).toBe(1);
    await s.close();
  });
});
