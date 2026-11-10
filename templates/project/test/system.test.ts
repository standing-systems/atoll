import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { testAtoll } from "@standing-systems/atoll/testing";
import system from "../system.ts";

type Atoll = Awaited<ReturnType<typeof testAtoll>>;

const open: Atoll[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** A fresh local atoll with the clock at 09:00 UTC on 4 November 2026. */
async function atoll(): Promise<Atoll> {
  const s = await testAtoll(system, { now: "2026-11-04T09:00:00Z" });
  open.push(s);
  return s;
}

/** Everything the atoll has told me so far, in order. */
async function told(s: Atoll): Promise<string[]> {
  return (await s.journal()).flatMap((r) => (r.kind === "turn" ? r.notices.map((n) => n.text) : []));
}

describe("reminder", () => {
  it("waits until the time I asked for, then tells me once and is done", async () => {
    const s = await atoll();
    await s.send("reminder/dentist", "reminder.set", { text: "Call the dentist", at: "2026-11-04T15:00:00Z" });
    await s.tick();
    expect(await s.json("parts/reminder/dentist/reminder.json")).toEqual({ text: "Call the dentist", at: "2026-11-04T15:00:00Z" });
    expect((await s.status()).idle).toEqual([]);

    await s.advance("5h"); // 14:00, an hour early
    expect(await told(s)).toEqual([]);

    await s.advance("2h"); // 16:00
    expect(await told(s)).toEqual(["Call the dentist"]);

    await s.advance("1d");
    expect(await told(s)).toEqual(["Call the dentist"]);
    expect((await s.json("parts/reminder/dentist/waiting.json"))?.status).toBe("done");
  });

  it("reminds me at the new time when I move a reminder later", async () => {
    const s = await atoll();
    await s.send("reminder/call", "reminder.set", { text: "Call Sam", at: "2026-11-04T12:00:00Z" });
    await s.tick();
    await s.send("reminder/call", "reminder.set", { text: "Call Sam", at: "2026-11-05T12:00:00Z" });
    await s.tick();

    await s.advance("4h"); // 13:00 on the first day: past the old time only
    expect(await told(s)).toEqual([]);

    await s.advance("1d"); // 13:00 on the second day
    expect(await told(s)).toEqual(["Call Sam"]);
  });

  it("tells me when a reminder can't be set, instead of waiting for nothing", async () => {
    const s = await atoll();
    await s.send("reminder/later", "reminder.set", { text: "Something" });
    await s.tick();
    expect(await told(s)).toEqual([`I couldn't set the reminder "later": it needs a text and a time.`]);
    expect((await s.status()).idle).toEqual([]);
  });

  it("puts the CHARTER.md beside system.ts on the disk, word for word", async () => {
    const s = await atoll();
    expect(await s.read("CHARTER.md")).toBe(readFileSync(new URL("../CHARTER.md", import.meta.url), "utf8"));
  });
});
