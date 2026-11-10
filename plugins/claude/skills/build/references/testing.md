# Testing an atoll with @standing-systems/atoll/testing

`testAtoll(system, options)` pushes a system onto a fresh local atoll in a temporary directory, with a
clock the test controls and effects replaced by stubs. It runs the same handlers, the same commit
protocol, and the same files as an atoll on a disk, so a test reads what a turn wrote the way `cat` would.

```ts
import { testAtoll } from "@standing-systems/atoll/testing";
import system from "../system.ts";

const s = await testAtoll(system, {
  now: "2026-11-04T09:00:00Z",
  stubs: { "npm.get": (args) => ({ status: 200, json: { version: "3.0.1" } }) },
});
```

`now` defaults to 2026-01-05T09:00:00Z, a Monday. A stub receives the effect's arguments and returns what
the effect would have; that becomes `e.body.result` in the result event exactly, since `pick` and the
16 KiB limit apply only to real requests, and a stub that throws is a failed effect. Every effect a test
reaches needs a stub, except a `model` effect with a `standIn`, which answers with its stand-in. One
without either stops the tick with an error that names it, and nothing runs for real unless the options
say `realEffects: true`.

| Call | What it does |
| --- | --- |
| `await s.send(to, type, body, { id?, from? })` | Deliver an event, from `@owner` unless `from` says otherwise. Returns its ID. Passing the same `id` twice delivers it once |
| `await s.tick()` | Run ticks until the inbox is empty: due waits first, then events, effects, and their results |
| `await s.advance("1h")` | Move the clock forward, then tick |
| `s.now()`, `s.setNow(time)` | Read or set the clock without ticking |
| `await s.read(path)`, `await s.json(path)` | Read a file by its path from the atoll's root, such as `parts/watch/rivetkit/latest.json` |
| `await s.list(prefix)` | The files under a prefix, such as `notices/` |
| `await s.status()` | The five answers, including `idle` (parts that are neither waiting nor done) and `needs` (open asks and the outbox) |
| `await s.asks()` | The open asks. An ask the runner opened about an effect has `effect: { id, reason }`, with `reason` one of `approval`, `over-budget`, and `in-doubt` |
| `await s.answer(id, option, payload?)` | Answer an ask, as `atoll answer` does, then tick |
| `s.calls(name?)` | The calls the stubs received, each `{ name, args, id }` |
| `await s.journal()` | Every journal record, in order: turns, effect outcomes, answers, failures |
| `s.store` | The store the runner uses, which can inject a crash at any storage operation (`s.store.crashAt = n`) |
| `await s.close()` | Remove the temporary atoll |

The asks the runner opens have fixed options: an approval offers `approve` and `deny` (default `deny`,
after three days, with the effect's arguments as the payload to edit); an effect past its budget offers
`allow` and `drop` (default `drop`); an effect whose outcome is in doubt offers `happened`, `retry`, and
`unknown` (default `unknown`).

## What a good test suite covers

- **Each behavior the person asked for**, through the events that cause it and the files and notices it
  leaves. Assert on files and on the journal, not on private variables.
- **Time.** Use `s.advance(...)` to move past a wait or a schedule, then assert that it fired once. Advance
  a little past the due time rather than exactly to it.
- **The same business event twice.** Two polls that see the same version, or the person sending the same
  request again, arrive under new event IDs. Assert that the part acted once.
- **Every effect a test reaches has a stub.** Assert the calls with `s.calls(name)`, including that an
  effect needing approval made no call before the approval.
- **Approvals and asks.** Approve one, deny one, and let one expire by advancing past its `expires`.
  Denial and expiry deliver the result event with `ok: false` and `denied: true`.
- **Never idle.** After each scenario, `(await s.status()).idle` is empty.
- **The charter.** When `system.ts` declares `charter`, one test checks that a new atoll's `CHARTER.md` is
  the project's file: `expect(await s.read("CHARTER.md")).toBe(readFileSync(...))`, with `readFileSync`
  from `node:fs` reading `new URL("../CHARTER.md", import.meta.url)`.

Close each atoll in `finally`, or collect them and close them in `afterEach`, so a failing assertion
doesn't leave temporary directories behind. Give each test its own instance names.

## The watcher and the ledger

The system is the first example in `turn-api.md`, saved as `system.ts`.

```ts
// atoll:check test/release-watch.test.ts
import { describe, expect, it } from "vitest";
import { testAtoll } from "@standing-systems/atoll/testing";
import system from "../system.ts";

const registry = (version: string) => () => ({ status: 200, json: { name: "rivetkit", version } });

async function notices(s: Awaited<ReturnType<typeof testAtoll>>): Promise<string[]> {
  const records = await s.journal();
  return records.flatMap((r) => (r.kind === "turn" ? r.notices.map((n) => n.text) : []));
}

describe("release-watch", () => {
  it("tells me about a new version once, however many polls see it", async () => {
    const s = await testAtoll(system, { now: "2026-11-04T09:00:00Z", stubs: { "npm.get": registry("3.0.1") } });
    try {
      await s.send("watch/rivetkit", "watch.poll", {});
      await s.tick();
      // The hourly schedule polls again, and the registry still says 3.0.1.
      await s.advance("90m");

      expect(s.calls("npm.get")).toHaveLength(2);
      const releases = await s.json("parts/ledger/releases.json");
      expect(releases.map((r: { version: string }) => r.version)).toEqual(["3.0.1"]);
      expect(await notices(s)).toEqual(["rivetkit 3.0.1 is out."]);
      expect((await s.status()).idle).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("records a release once when the same news arrives twice under new event IDs", async () => {
    const s = await testAtoll(system, { now: "2026-11-04T09:00:00Z" });
    try {
      await s.send("ledger", "release.seen", { name: "rivetkit", version: "3.0.1" });
      await s.send("ledger", "release.seen", { name: "rivetkit", version: "3.0.1" });
      await s.tick();

      expect(await s.json("parts/ledger/releases.json")).toHaveLength(1);
      expect(await notices(s)).toEqual(["rivetkit 3.0.1 is out."]);
    } finally {
      await s.close();
    }
  });
});
```

## The approval

The system is the second example in `turn-api.md`, saved as `follow-up.ts`.

```ts
// atoll:check test/follow-up.test.ts
import { describe, expect, it } from "vitest";
import { testAtoll } from "@standing-systems/atoll/testing";
import system from "../follow-up.ts";

const promise = { what: "the deck", to: "Sam", due: "2026-11-06T17:00:00Z" };

async function overdue() {
  const s = await testAtoll(system, { now: "2026-11-04T09:00:00Z", stubs: { "mail.send": () => ({ status: 202 }) } });
  await s.send("promise/deck-for-sam", "promise.made", promise);
  await s.tick();
  await s.advance("3d");
  const approval = (await s.asks()).find((a) => a.effect?.reason === "approval");
  return { s, approval };
}

describe("follow-up", () => {
  it("sends the note only after I approve it, with the text I approved", async () => {
    const { s, approval } = await overdue();
    try {
      expect(s.calls("mail.send")).toHaveLength(0);
      expect(approval?.default).toBe("deny");

      const edited = { to: "Sam", text: "Hi Sam, the deck is coming Monday." };
      await s.answer(approval!.id, "approve", edited);

      expect(s.calls("mail.send").map((c) => c.args)).toEqual([edited]);
      expect((await s.status()).idle).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("sends nothing when I deny the note, and asks whether to keep tracking it", async () => {
    const { s, approval } = await overdue();
    try {
      await s.answer(approval!.id, "deny");

      expect(s.calls("mail.send")).toHaveLength(0);
      const open = await s.asks();
      expect(open.map((a) => a.question)).toEqual(["Keep tracking your promise to Sam about the deck?"]);
      expect(open[0]?.default).toBe("keep");
    } finally {
      await s.close();
    }
  });
});
```

## Reading a failure

- A test that sees no files from a handler: read `await s.journal()`. A `failure` record names the error.
  A handler that wrote outside its directory, sent to an undeclared part, or requested an undeclared
  effect failed at commit and wrote nothing.
- A part reported as idle: one of its handlers ended without `t.wait(...)` or `t.done(...)`, and the part
  had no waits left.
- An effect that never ran: it waits for approval (look in `await s.asks()`), it is past its budget (an
  `effect` record with `state: "over-budget"`), or the event that requests it was never handled.
- A tick that throws "ran in a test without a stub": add the stub it names.
