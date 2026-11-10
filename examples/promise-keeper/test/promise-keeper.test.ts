// Promise keeper, from a forwarded message to a reminder sent once. Sam's message arrives on Wednesday
// 4 November 2026 at 08:55 in my time zone (America/Los_Angeles), so "by Friday" means Friday 6
// November at 17:00 there: 2026-11-07T01:00Z. Unless a test stubs the model, the runtime reads each
// message with the stand-in in extract.ts, as it does whenever no model key is configured.

import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { checkAtoll, checkSystem, StandInModels, type EffectStub } from "@standing-systems/atoll";
import { testAtoll } from "@standing-systems/atoll/testing";
import { standIn } from "../extract.ts";
import system, { TIME_ZONE } from "../system.ts";

type Atoll = Awaited<ReturnType<typeof testAtoll>>;
const open: Atoll[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

const SAM = { from: "Sam Rivera <sam@example.com>", text: "Thanks for the call this morning. I'll send you the deck by Friday.", at: "2026-11-04T16:55:00.000Z" };
const DECK = "promise/sam-rivera-send-you-the-deck";
const FRIDAY_5PM = "2026-11-07T01:00:00.000Z";
const DRAFT = "Hi Sam, a quick reminder: on Wednesday, November 4 you said you'd send me the deck by Friday, November 6. Is that still on track?";

/** A model's answer, shaped as the runtime returns one. */
const modelSays =
  (json: unknown): EffectStub =>
  () => ({ json, text: JSON.stringify(json), model: "claude-opus-5-5", standIn: false });
const transportSends: EffectStub = (args) => ({ sent: true, to: args.to, text: args.text });

const START = "2026-11-04T17:00:00.000Z";

async function keeper(stubs: Record<string, EffectStub> = {}) {
  const s = await testAtoll(system, { now: START, stubs: { "reminder.send": transportSends, ...stubs } });
  open.push(s);
  return s;
}

/** No stubs at all: the runtime's stand-in model answers, and custom effects run their real code. */
async function realKeeper() {
  const s = await testAtoll(system, { now: START, realEffects: true, models: new StandInModels() });
  open.push(s);
  return s;
}

/** Forward a message, as I would with `atoll send intake message.received`, and let the atoll read it. */
async function forward(s: Atoll, message: object = SAM): Promise<string> {
  const id = await s.send("intake", "message.received", message);
  await s.tick();
  return id;
}

/** Forward Sam's message and let the clock run to Saturday 02:00 UTC, just after the deck fell due. */
async function overdue(s: Atoll) {
  await forward(s);
  await s.advance("57h");
  const asks = await s.asks();
  expect(asks).toHaveLength(1);
  return asks[0]!;
}

/** Answer the overdue question with send, then approve the reminder exactly as drafted. */
async function approveReminder(s: Atoll) {
  const ask = await overdue(s);
  await s.answer(ask.id, "send");
  const [approval] = await s.asks();
  await s.answer(approval!.id, "approve");
  return approval!;
}

/** Requests the test webhook received, newest last. */
const received: { headers: IncomingHttpHeaders; body: string }[] = [];

/**
 * Run `fn` with PROMISE_KEEPER_WEBHOOK pointing at a local server that calls `handle` with each request
 * and its body (or at `url`, with no server, when `handle` is null), then restore the environment.
 */
async function withWebhook(handle: ((req: IncomingMessage, res: ServerResponse, body: string) => void) | null, fn: () => Promise<void>, url?: string) {
  received.length = 0;
  const server = handle
    ? createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => handle(req, res, body));
      })
    : null;
  if (server) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const saved = process.env.PROMISE_KEEPER_WEBHOOK;
  process.env.PROMISE_KEEPER_WEBHOOK = url ?? `http://127.0.0.1:${(server!.address() as AddressInfo).port}/hooks/s3cret-token`;
  try {
    await fn();
  } finally {
    server?.close();
    if (saved === undefined) delete process.env.PROMISE_KEEPER_WEBHOOK;
    else process.env.PROMISE_KEEPER_WEBHOOK = saved;
  }
}

const told = async (s: Atoll) => (await s.journal()).flatMap((r) => (r.kind === "turn" ? r.notices.map((n) => n.text) : []));
const waitsOf = async (s: Atoll, address: string) => (await s.status()).waiting.find((w) => w.address === address);

// Each test ticks an atoll on disk many times; a busy machine can take longer than vitest's default 5 s.
describe("promise keeper", { timeout: 60_000 }, () => {
  test("a message with a promise creates an instance that waits until it's due", async () => {
    const s = await keeper();
    const id = await forward(s);
    expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({
      who: "Sam Rivera",
      what: "send you the deck",
      due: FRIDAY_5PM,
      to: "Sam Rivera <sam@example.com>",
      status: "open",
      message: { id, from: SAM.from, at: SAM.at },
      proposedBy: "stand-in",
    });
    expect(await s.json(`parts/intake/messages/${id}.json`)).toMatchObject({ readBy: "stand-in", promises: [{ address: DECK, due: FRIDAY_5PM }], rejected: [] });
    expect(await waitsOf(s, DECK)).toMatchObject({ status: "waiting", waits: [expect.objectContaining({ until: FRIDAY_5PM })] });
    expect(await waitsOf(s, "intake")).toMatchObject({ status: "waiting", waits: [expect.objectContaining({ for: "message.received" })] });
    expect((await s.status()).idle).toEqual([]);
  });

  test("two messages at once are both read, and the intake says what it waits for throughout", async () => {
    const s = await keeper();
    await s.send("intake", "message.received", SAM);
    await s.send("intake", "message.received", { from: "Dana Okafor <dana@example.com>", text: "I'll get you the signed lease by tomorrow.", at: SAM.at });
    await s.tick();
    expect(await s.list("parts/promise/")).toEqual([
      "parts/promise/dana-okafor-get-you-the-signed-lease/promise.json",
      "parts/promise/dana-okafor-get-you-the-signed-lease/waiting.json",
      `parts/${DECK}/promise.json`,
      `parts/${DECK}/waiting.json`,
    ]);
    // While a reading is in flight the intake waits for it as well as for the next message, never less.
    const intake = (await s.journal()).flatMap((r) => (r.kind === "turn" && r.part === "intake" ? [[r.event.type, r.waits?.map((w) => w.for)]] : []));
    expect(intake).toEqual([
      ["message.received", ["message.received", "extract.done"]],
      ["message.received", ["message.received", "extract.done"]],
      ["extract.done", ["message.received", "extract.done"]],
      ["extract.done", ["message.received"]],
    ]);
    expect(await s.list("parts/intake/pending/")).toEqual([]);
    expect((await s.status()).idle).toEqual([]);
  });

  test("a long message is read only as far as one reading's budget covers", async () => {
    const s = await keeper({ extract: modelSays({ promises: [] }) });
    const id = await forward(s, { ...SAM, text: `${SAM.text} ${"And more. ".repeat(1_000)}` });
    const sent = JSON.parse(s.calls("extract")[0]!.args.prompt) as { text: string };
    expect(sent.text).toHaveLength(6_000);
    expect(s.calls("extract")[0]!.args.maxTokens).toBe(2_000);
    expect(await s.json(`parts/intake/messages/${id}.json`)).toMatchObject({ readChars: 6_000 });
  });

  test("a message without a promise creates nothing", async () => {
    const s = await keeper();
    const id = await forward(s, { from: "Dana Okafor <dana@example.com>", text: "Great to see you today. Let's talk soon!", at: "2026-11-04T16:00:00.000Z" });
    expect(await s.list("parts/promise/")).toEqual([]);
    expect(await s.json(`parts/intake/messages/${id}.json`)).toMatchObject({ promises: [], rejected: [] });
    expect(await told(s)).toEqual([]);
  });

  test("a past due date is rejected by code even when the model proposes it", async () => {
    const proposals = [
      { who: "Sam Rivera", what: "send you the deck", due: "2026-11-02T17:00:00-08:00" }, // last Monday
      { who: "Sam Rivera", what: "  ", due: "2026-11-13T17:00:00-08:00" },
      { who: "Sam Rivera", what: "book the room", due: "Friday" },
    ];
    const s = await keeper({ extract: modelSays({ promises: proposals }) });
    const id = await forward(s);
    expect(s.calls("extract")).toHaveLength(1);
    expect(await s.list("parts/promise/")).toEqual([]);
    expect(await s.json(`parts/intake/messages/${id}.json`)).toMatchObject({
      readBy: "claude-opus-5-5",
      promises: [],
      rejected: [
        { proposal: proposals[0], reason: "its due date, 2026-11-03T01:00:00.000Z, has already passed" },
        { proposal: proposals[1], reason: "it doesn't say what was promised" },
        { proposal: proposals[2], reason: `its due date, "Friday", isn't an ISO 8601 date` },
      ],
    });
  });

  test("the due timer opens an ask", async () => {
    const s = await keeper();
    await forward(s);
    await s.advance("48h"); // Friday 17:00 UTC is only 09:00 in my time zone
    expect(await s.asks()).toEqual([]);
    await s.advance("9h"); // Saturday 02:00 UTC: Friday 18:00 here
    const asks = await s.asks();
    expect(asks).toEqual([
      expect.objectContaining({
        from: DECK,
        question: "Send Sam a reminder to send you the deck?",
        why: "Sam Rivera said they would send you the deck by Friday, November 6, in a message on Wednesday, November 4, and that time has passed.",
        options: [expect.objectContaining({ id: "send" }), expect.objectContaining({ id: "wait" }), expect.objectContaining({ id: "drop" })],
        recommend: "wait",
        default: "wait",
        expires: "2026-11-09T02:00:00.000Z",
        payload: { to: "Sam Rivera <sam@example.com>", draft: DRAFT },
      }),
    ]);
    expect(await waitsOf(s, DECK)).toMatchObject({ waits: [expect.objectContaining({ ask: asks[0]!.id })] });
  });

  test("answering send opens an approval, and approving runs the effect once with exactly the approved text", async () => {
    const s = await keeper();
    const ask = await overdue(s);
    await s.answer(ask.id, "send", { ...(ask.payload as object), draft: "Hi Sam, any news on the deck?" });

    const [approval] = await s.asks();
    expect(approval).toMatchObject({
      from: DECK,
      question: "Send Sam Rivera <sam@example.com> the reminder below?",
      default: "deny",
      effect: { reason: "approval" },
      payload: { to: "Sam Rivera <sam@example.com>", text: "Hi Sam, any news on the deck?", promise: DECK },
    });
    expect(s.calls("reminder.send")).toEqual([]);

    const approved = { ...(approval!.payload as object), text: "Hi Sam, any news on the deck? Monday is fine too." };
    await s.answer(approval!.id, "approve", approved);
    expect(s.calls("reminder.send").map((c) => c.args)).toEqual([approved]);
    expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "reminded", draft: approved.text, remindedAt: "2026-11-07T02:00:00.000Z" });
    expect(await waitsOf(s, DECK)).toMatchObject({ status: "done", waits: [] });
    const approvedBy = (await s.journal()).find((r) => r.kind === "effect" && r.state === "approved");
    expect(approvedBy).toMatchObject({ approvedBy: approval!.id, args: approved });

    await s.advance("7d");
    expect(s.calls("reminder.send")).toHaveLength(1);
    expect(await s.asks()).toEqual([]);
    expect(await checkAtoll(s.store, system)).toEqual([]);
  });

  test("an unanswered approval expires to deny, and the promise asks again later", async () => {
    const s = await keeper();
    const ask = await overdue(s);
    await s.answer(ask.id, "send");
    const [approval] = await s.asks();
    expect(approval?.expires).toBe("2026-11-10T02:00:00.000Z");

    await s.advance("3d");
    expect(s.calls("reminder.send")).toEqual([]);
    expect((await s.journal()).filter((r) => r.kind === "effect" && r.state === "denied")).toHaveLength(1);
    expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "open", next: "2026-11-12T02:00:00.000Z" });
    expect(await s.asks()).toEqual([]);

    await s.advance("2d");
    expect(await s.asks()).toEqual([expect.objectContaining({ from: DECK, question: "Send Sam a reminder to send you the deck?" })]);
    expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "asked", asked: 2 });
  });

  test("wait re-arms the timer, and so does leaving the question unanswered", async () => {
    const s = await keeper();
    const first = await overdue(s);
    await s.answer(first.id, "wait");
    expect(await s.asks()).toEqual([]);
    expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "open", next: "2026-11-09T02:00:00.000Z" });
    expect(await waitsOf(s, DECK)).toMatchObject({ waits: [expect.objectContaining({ until: "2026-11-09T02:00:00.000Z" })] });

    await s.advance("2d");
    const [second] = await s.asks();
    expect(second).toMatchObject({ from: DECK, expires: "2026-11-11T02:00:00.000Z" });
    expect(second!.id).not.toBe(first.id);

    await s.advance("2d"); // nobody answers, so the default, wait, applies
    expect(await s.asks()).toEqual([]);
    expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "open", next: "2026-11-13T02:00:00.000Z", asked: 2 });
    await s.advance("2d");
    expect(await s.asks()).toEqual([expect.objectContaining({ from: DECK })]);
    expect(s.calls("reminder.send")).toEqual([]);
  });

  test("drop finishes the promise", async () => {
    const s = await keeper();
    const ask = await overdue(s);
    await s.answer(ask.id, "drop");
    expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "dropped" });
    expect(await waitsOf(s, DECK)).toMatchObject({ status: "done", waits: [] });
    await s.advance("7d");
    expect(await s.asks()).toEqual([]);
  });

  test("the same promise in a later message moves its due date instead of making a second one", async () => {
    const s = await keeper();
    await forward(s);
    await forward(s, { from: SAM.from, text: "Running behind, sorry! I'll send you the deck by next Tuesday.", at: "2026-11-05T18:00:00.000Z" });
    expect(await s.list("parts/promise/")).toEqual([`parts/${DECK}/promise.json`, `parts/${DECK}/waiting.json`]);
    expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "open", due: "2026-11-11T01:00:00.000Z", next: "2026-11-11T01:00:00.000Z" });
    await s.advance("57h"); // Friday's timer was replaced when the promise moved
    expect(await s.asks()).toEqual([]);
    await s.advance("4d"); // Wednesday 02:00 UTC: Tuesday evening here
    expect(await s.asks()).toEqual([expect.objectContaining({ from: DECK, why: expect.stringContaining("by Tuesday, November 10") })]);
  });

  test("two people with the same first name and the same promise keep two promises", async () => {
    const s = await keeper();
    await forward(s);
    await forward(s, { from: "Sam Chen <schen@example.com>", text: "I'll send you the deck by Monday.", at: SAM.at });
    expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ who: "Sam Rivera", to: SAM.from, due: FRIDAY_5PM });
    expect(await s.json("parts/promise/sam-chen-send-you-the-deck/promise.json")).toMatchObject({ who: "Sam Chen", to: "Sam Chen <schen@example.com>", due: "2026-11-10T01:00:00.000Z" });
  });

  test("a promise that moves while its reminder waits for approval is asked about when it's due again", async () => {
    const s = await keeper();
    const ask = await overdue(s);
    await s.answer(ask.id, "send");
    const [approval] = await s.asks();
    await forward(s, { from: SAM.from, text: "Running behind, sorry! I'll send you the deck by next Tuesday." }); // sent Friday evening here
    await s.answer(approval!.id, "deny");
    expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "open", due: "2026-11-11T01:00:00.000Z", next: "2026-11-11T01:00:00.000Z" });
    await s.advance("2d");
    expect(await s.asks()).toEqual([]);
    await s.advance("2d");
    expect(await s.asks()).toEqual([expect.objectContaining({ from: DECK, why: expect.stringContaining("by Tuesday, November 10") })]);
  });

  test("a webhook that refuses the reminder leaves it unsent; one that answers 5xx leaves it in doubt", async () => {
    for (const [status, expected] of [
      [422, { status: "unsent", error: "the webhook refused it with HTTP 422" }],
      [504, { status: "in-doubt", error: "the webhook answered HTTP 504, so I don't know whether it went out" }],
    ] as const) {
      await withWebhook(
        (req, res, body) => {
          received.push({ headers: req.headers, body });
          res.writeHead(status).end("no");
        },
        async () => {
          const s = await realKeeper();
          await approveReminder(s);
          expect(received).toHaveLength(1);
          expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject(expected);
        },
      );
    }
  });

  test("with no transport configured, the approved reminder comes back to me to send myself", async () => {
    const saved = process.env.PROMISE_KEEPER_WEBHOOK;
    delete process.env.PROMISE_KEEPER_WEBHOOK;
    try {
      // No stubs: the runtime's own stand-in path reads the message, and reminder.send's real code runs.
      const s = await realKeeper();
      await approveReminder(s);
      expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "unsent", error: "no transport configured", proposedBy: "stand-in" });
      expect((await told(s)).at(-1)).toBe(`I couldn't send your reminder to Sam: no transport configured. Here is the text you approved, if you'd like to send it yourself:\n\n${DRAFT}`);
      expect(await waitsOf(s, DECK)).toMatchObject({ status: "done" });
    } finally {
      if (saved === undefined) delete process.env.PROMISE_KEEPER_WEBHOOK;
      else process.env.PROMISE_KEEPER_WEBHOOK = saved;
    }
  });

  test("with a webhook configured, the approved text is posted once, keyed, and the receipt omits the secret", async () => {
    await withWebhook(
      (req, res, body) => {
        received.push({ headers: req.headers, body });
        res.writeHead(200, { "content-type": "application/json" }).end('{"queued":true}');
      },
      async () => {
        const s = await realKeeper();
        const approval = await approveReminder(s);
        expect(received).toHaveLength(1);
        expect(JSON.parse(received[0]!.body)).toMatchObject({ to: SAM.from, text: DRAFT, promise: DECK });
        expect(received[0]!.headers["idempotency-key"]).toBe(`promise-keeper:${approval.effect!.id}`);
        expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "reminded" });
        for (const key of await s.list("evidence/")) expect(await s.read(key)).not.toContain("s3cret-token");
        await s.advance("7d");
        expect(received).toHaveLength(1);
      },
    );
  });

  test("a webhook that can't be reached leaves the reminder unsent; one that drops the connection leaves it in doubt", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    await withWebhook(null, async () => {
      const s = await realKeeper();
      await approveReminder(s);
      expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "unsent", error: "the webhook couldn't be reached" });
      expect((await told(s)).at(-1)).toMatch(/^I couldn't send your reminder to Sam: the webhook couldn't be reached\./);
    }, `http://127.0.0.1:${port}/hooks/s3cret-token`);

    // This webhook takes the request, then hangs up before answering: it may well have sent it.
    await withWebhook(
      (req, _res, body) => {
        received.push({ headers: req.headers, body });
        req.socket.destroy();
      },
      async () => {
        const s = await realKeeper();
        await approveReminder(s);
        expect(received).toHaveLength(1);
        expect(await s.json(`parts/${DECK}/promise.json`)).toMatchObject({ status: "in-doubt" });
        expect((await told(s)).at(-1)).toMatch(/^I may or may not have sent your reminder to Sam: the webhook didn't confirm it/);
        expect(await waitsOf(s, DECK)).toMatchObject({ status: "done" });
      },
    );
  });

  test("the declaration passes atoll check, declares the budget, and a new atoll's CHARTER.md is the one here", async () => {
    expect(checkSystem(system)).toEqual([]);
    expect(system.effects.extract).toMatchObject({ kind: "model", budget: { usd: 1, per: "month" } });
    expect(system.effects["reminder.send"]).toMatchObject({ kind: "custom", approval: true, idempotent: false });
    const s = await keeper();
    expect(await s.read("CHARTER.md")).toBe(readFileSync(new URL("../CHARTER.md", import.meta.url), "utf8"));
  });
});

describe("the stand-in", () => {
  const read = (text: string, sent = "2026-11-04T16:55:00.000Z") => standIn({ prompt: JSON.stringify({ from: SAM.from, sent, timeZone: TIME_ZONE, text }) }).promises;

  test.each([
    ["I'll send you the deck by Friday.", "send you the deck", "2026-11-07T01:00:00.000Z"],
    ["I will call you tomorrow", "call you", "2026-11-06T01:00:00.000Z"],
    ["We’ll have the contract to you by Nov 12th.", "have the contract to you", "2026-11-13T01:00:00.000Z"],
    ["I'm going to fix the invoice by next Tuesday", "fix the invoice", "2026-11-11T01:00:00.000Z"],
    ["Sounds good! I'll get back to you tonight.", "get back to you", "2026-11-05T05:00:00.000Z"],
    ["I will send the final numbers by 2026-11-20", "send the final numbers", "2026-11-21T01:00:00.000Z"],
  ])("reads %j", (text, what, due) => {
    expect(read(text)).toEqual([{ who: "Sam Rivera", what, due }]);
  });

  test.each([["Let's catch up soon."], ["Could you send me the deck by Friday?"], ["I'll think about it."]])("finds no promise in %j", (text) => {
    expect(read(text)).toEqual([]);
  });

  test("keeps 17:00 in my time zone across the end of daylight saving time", () => {
    // Friday 30 October, 09:00 PDT. Saturday is still daylight time; Monday is standard time.
    expect(read("I'll send it by Saturday", "2026-10-30T16:00:00.000Z")[0]?.due).toBe("2026-11-01T00:00:00.000Z");
    expect(read("I'll send it by Monday", "2026-10-30T16:00:00.000Z")[0]?.due).toBe("2026-11-03T01:00:00.000Z");
  });
});
