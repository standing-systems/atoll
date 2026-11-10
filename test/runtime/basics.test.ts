import { afterEach, describe, expect, it } from "vitest";
import { testAtoll, type TestAtoll } from "../../src/testing.ts";
import { counterSystem } from "./fixtures.ts";
import { why, checkAtoll, renderStatus } from "../../src/index.ts";

let s: TestAtoll | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("a turn", () => {
  it("handles an event, writes files, sends, and journals one record per turn", async () => {
    s = await testAtoll(counterSystem());
    await s.send("counter", "ping");
    const report = await s.tick();
    expect(report.turns).toBe(2);
    expect(await s.json("parts/counter/count.json")).toEqual({ n: 1 });
    expect(await s.json("parts/ledger/latest.json")).toMatchObject({ n: 1 });
    const journal = await s.journal();
    const turns = journal.filter((r) => r.kind === "turn");
    expect(turns.map((t) => (t as any).part)).toEqual(["counter", "ledger"]);
    expect(await s.list("inbox/")).toEqual([]);
    const counterTurn = turns[0] as any;
    expect(counterTurn.writes.map((w: any) => w.path)).toEqual(["parts/counter/count.json", "parts/counter/history/0001.txt"]);
    expect(counterTurn.note).toBe("count is now 1");
  });

  it("answers the five questions from files", async () => {
    s = await testAtoll(counterSystem());
    await s.send("counter", "ping");
    await s.tick();
    const a = await s.status();
    expect(a.purpose.parts.map((p) => p.address)).toContain("counter");
    expect(a.changed[0]!.part).toBe("ledger");
    expect(a.waiting.find((w) => w.address === "counter")!.waits[0]!.for).toBe("ping");
    const md = await s.read("STATUS.md");
    expect(md).toContain("## What it is waiting for");
    expect(md).toContain("`counter` waits for ping (the next ping)");
    expect(await renderStatus(s.store, s.system)).toContain("## What it needs from me");
  });

  it("refuses a write outside the part's own directory and records the failure", async () => {
    s = await testAtoll({
      ...counterSystem(),
      parts: {
        ...counterSystem().parts,
        rogue: { purpose: "Try to write into another part's files", on: { go: (t) => t.write("/parts/counter/count.json", { n: 999 }) } },
      },
    });
    await s.send("rogue", "go");
    const report = await s.tick();
    expect(report.failures).toBe(1);
    expect(await s.json("parts/counter/count.json")).toBeNull();
    const failure = (await s.journal()).find((r) => r.kind === "failure") as any;
    expect(failure.error).toContain("outside its own directory");
  });

  it("dead-letters an event after three failed attempts and tells the owner", async () => {
    s = await testAtoll(counterSystem());
    await s.send("counter", "boom");
    await s.tick();
    await s.tick();
    await s.tick();
    const failures = (await s.journal()).filter((r) => r.kind === "failure") as any[];
    expect(failures.map((f) => f.attempt)).toEqual([1, 2, 3]);
    expect(failures[2].dead).toBe(true);
    expect((await s.list("inbox/dead/")).length).toBe(1);
    const notices = await s.list("notices/");
    expect(notices.length).toBe(1);
    expect(await s.read(notices[0]!)).toContain("after 3 attempts");
    await s.tick();
    expect((await s.journal()).filter((r) => r.kind === "failure").length).toBe(3);
  });

  it("dead-letters an event addressed to a part that doesn't exist, at once", async () => {
    s = await testAtoll(counterSystem());
    await s.send("nobody", "ping");
    await s.tick();
    const failure = (await s.journal()).find((r) => r.kind === "failure") as any;
    expect(failure.dead).toBe(true);
    expect(failure.error).toContain('No part "nobody"');
  });

  it("traces a file back to the event that caused it", async () => {
    s = await testAtoll(counterSystem());
    await s.send("counter", "ping");
    await s.tick();
    const report = await why(s.store, "parts/ledger/latest.json");
    expect(report.chain.map((c) => c.part)).toEqual(["ledger", "counter"]);
    expect(report.chain[1]!.event!.from).toBe("@owner");
    expect(report.complete).toBe(true);
  });

  it("finds nothing unattributed in a clean atoll, and flags a file changed outside a turn", async () => {
    s = await testAtoll(counterSystem());
    await s.send("counter", "ping");
    await s.tick();
    expect((await checkAtoll(s.store, s.system)).filter((p) => p.severity === "error")).toEqual([]);
    await s.store.inner.put("parts/counter/count.json", JSON.stringify({ n: 41 }));
    await s.store.inner.put("parts/counter/extra.txt", "sneaky");
    const codes = (await checkAtoll(s.store, s.system)).map((p) => `${p.code} ${p.where}`);
    expect(codes).toContain("UNATTRIBUTED_CHANGE parts/counter/count.json");
    expect(codes).toContain("UNATTRIBUTED_FILE parts/counter/extra.txt");
  });
});
