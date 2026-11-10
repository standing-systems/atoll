// Promise keeper: reads the messages I forward, keeps track of the promises people make me in them, and
// when one comes due, drafts a reminder and asks me before anything is sent. A model proposes the
// promises (a stand-in, when no model key is configured); the rules in this file decide. See README.md.

import { defineSystem, type Turn } from "@standing-systems/atoll";
import { EXTRACT_SYSTEM, PROMISES_SCHEMA, firstName, senderName, standIn, type MessageForModel, type Proposal } from "./extract.ts";
import { at, dayName } from "./time.ts";

/** My time zone: "by Friday" means Friday at 17:00 here. */
export const TIME_ZONE = "America/Los_Angeles";
/** How long a question about a promise stays open, and how long "wait" waits before asking again. */
const TWO_DAYS = "2d";
const TWO_DAYS_MS = 2 * 86_400_000;
const MAX_PROMISES_PER_MESSAGE = 10;
const MAX_WHAT_LENGTH = 200;
const MAX_AHEAD_MS = 366 * 86_400_000;
/**
 * A reading's cost is bounded by what it reads and writes, so the budget's ceiling per reading holds: the
 * first 6,000 characters of a message (where the newest part of a forwarded thread is) and an answer of
 * at most 2,000 tokens. At Claude Opus 5.5's list prices that is at most about $0.05 for English text.
 */
const READ_CHARS = 6_000;
const ANSWER_TOKENS = 2_000;

/**
 * What I asked for, in my words. Atoll writes it into a new atoll's CHARTER.md under the system's name,
 * followed by each part's purpose; a test checks that the result is the CHARTER.md beside this file.
 */
const charter = `People tell me they'll do things: send a deck by Friday, call me back tomorrow. I forward those
messages here, and I want every promise in them kept track of, so I don't have to remember them.

Read each message I forward and note each promise in it: who made it, what they promised, and when
it's due. A model may read the messages, or a simple stand-in when no model is set up, but either one
only suggests. Your rules decide which promises to keep.

When a promise comes due, ask me whether to send a reminder, with a draft I can edit. Recommend
waiting two more days, and if I don't answer within two days, wait. If I say send, show me the exact
text for approval before anything goes out, and send it once.

## Never

- Never send anything to anyone without my approval of the exact text.
- Never send an approved reminder more than once.
- Never keep a promise whose due date has already passed, or one that doesn't say what was promised.
- Never spend more than $1 a month on the model.
- Never leave a question waiting on me forever: each one has a default and an expiry.
- Never share the messages I forward with anyone but the model that reads them.`;

// ---- What the parts keep on disk ---------------------------------------------------------------------

interface Message {
  /** The message.received event's ID. */
  id: string;
  from: string;
  at: string;
  text: string;
}

/** parts/intake/pending/<effect id>.json: a message whose reading is on its way. */
interface Pending {
  message: Message;
  evidence: string;
  requestedAt: string;
}

/** parts/intake/messages/<event id>.json: a message, and what code decided about each proposal in it. */
interface MessageFile extends Message {
  readAt: string;
  readBy?: string;
  /** Set when the message was longer than one reading covers. */
  readChars?: number;
  promises?: { address: string; who: string; what: string; due: string }[];
  rejected?: { proposal: unknown; reason: string }[];
  error?: string;
}

type Status = "open" | "asked" | "sending" | "reminded" | "unsent" | "in-doubt" | "dropped";

/** parts/promise/<slug>/promise.json */
interface PromiseFile {
  who: string;
  what: string;
  due: string;
  /** Where a reminder goes: whoever sent the message that held the promise. */
  to: string;
  status: Status;
  madeAt: string;
  message: { id: string; from: string; at: string } | null;
  proposedBy: string;
  evidence: string[];
  /** While open: when it next asks me. */
  next?: string;
  /** While asked: the open question. */
  ask?: string;
  /** While sending: the reminder effect. */
  reminder?: string;
  asked: number;
  draft?: string;
  remindedAt?: string;
  error?: string;
}

const FINISHED: ReadonlySet<Status> = new Set(["reminded", "unsent", "in-doubt", "dropped"]);

interface EffectResult<R> {
  ok: boolean;
  effect: string;
  name: string;
  result?: R;
  error?: string;
  denied?: boolean;
}

interface ModelResult {
  json?: unknown;
  model?: string;
  standIn?: boolean;
}

interface SendResult {
  sent?: boolean;
  reason?: string;
  text?: string;
  /** The owner said an in-doubt send happened. */
  assumed?: boolean;
  /** The owner left an in-doubt send unknown. */
  inDoubt?: boolean;
}

// ---- Models propose; code decides --------------------------------------------------------------------

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;

/** A due date as ISO 8601. One without an offset is my local time; a bare date is 17:00 that day. */
function parseDue(due: unknown): Date | null {
  if (typeof due !== "string") return null;
  const text = due.trim();
  if (ISO_WITH_OFFSET.test(text)) return new Date(text);
  const local = ISO_LOCAL.exec(text);
  if (!local) return null;
  const day = { year: Number(local[1]), month: Number(local[2]), day: Number(local[3]) };
  return at(day, local[4] ? Number(local[4]) : 17, TIME_ZONE, local[5] ? Number(local[5]) : 0);
}

export type Checked = (Proposal & { slug: string }) | { reason: string };

/** One proposed promise, checked: it says what was promised, and it's due in the coming year. */
export function checkPromise(proposal: unknown, fallbackWho: string, now: Date): Checked {
  if (!proposal || typeof proposal !== "object") return { reason: "it isn't a promise" };
  const { who, what, due } = proposal as Record<string, unknown>;
  const promised = typeof what === "string" ? what.replace(/\s+/g, " ").trim() : "";
  if (!promised) return { reason: "it doesn't say what was promised" };
  if (promised.length > MAX_WHAT_LENGTH) return { reason: "what was promised is too long to be one promise" };
  const dueAt = parseDue(due);
  if (!dueAt || Number.isNaN(dueAt.getTime())) return { reason: `its due date, ${JSON.stringify(due ?? null)}, isn't an ISO 8601 date` };
  if (dueAt.getTime() <= now.getTime()) return { reason: `its due date, ${dueAt.toISOString()}, has already passed` };
  if (dueAt.getTime() - now.getTime() > MAX_AHEAD_MS) return { reason: `its due date, ${dueAt.toISOString()}, is more than a year away` };
  const person = (typeof who === "string" && who.trim()) || fallbackWho;
  return { who: person, what: promised, due: dueAt.toISOString(), slug: slugFor(person, promised) };
}

/** Every proposal in one model answer, accepted or rejected with a reason. */
export function decide(proposals: unknown[], message: Message, now: Date): { accepted: (Proposal & { slug: string })[]; rejected: { proposal: unknown; reason: string }[] } {
  const accepted: (Proposal & { slug: string })[] = [];
  const rejected: { proposal: unknown; reason: string }[] = [];
  for (const proposal of proposals) {
    const checked = checkPromise(proposal, senderName(message.from), now);
    if ("reason" in checked) rejected.push({ proposal, reason: checked.reason });
    else if (accepted.some((a) => a.slug === checked.slug)) rejected.push({ proposal, reason: "it repeats a promise already in this message" });
    else if (accepted.length >= MAX_PROMISES_PER_MESSAGE) rejected.push({ proposal, reason: `one message doesn't hold more than ${MAX_PROMISES_PER_MESSAGE} promises` });
    else accepted.push(checked);
  }
  return { accepted, rejected };
}

/**
 * A promise's instance name: who, by their full name, and what, so the same promise in a later message
 * finds the same one, and two people with the same first name never share one.
 */
export function slugFor(who: string, what: string): string {
  const slug = `${senderName(who)} ${what}`
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const short = slug.length <= 64 ? slug : slug.slice(0, 64).replace(/-[^-]*$/, "");
  return short || `promise-${fnv1a(`${who}\n${what}`)}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

// ---- Small helpers -----------------------------------------------------------------------------------

function readMessage(t: Turn): Message | { reason: string } {
  const { from, text, at: sentAt } = t.event.body ?? {};
  if (typeof text !== "string" || !text.trim()) return { reason: "it has no text" };
  if (typeof from !== "string" || !from.trim()) return { reason: "it doesn't say who sent it" };
  const sent = typeof sentAt === "string" ? new Date(sentAt) : new Date(t.event.at);
  return { id: t.event.id, from: from.trim(), at: Number.isNaN(sent.getTime()) ? t.event.at : sent.toISOString(), text };
}

function extractArgs(m: Message): { system: string; prompt: string; schema: object; maxTokens: number } {
  const forModel: MessageForModel = { from: m.from, sent: m.at, timeZone: TIME_ZONE, text: m.text.slice(0, READ_CHARS) };
  return { system: EXTRACT_SYSTEM, prompt: JSON.stringify(forModel), schema: PROMISES_SCHEMA, maxTokens: ANSWER_TOKENS };
}

/**
 * What the intake waits for, said whole, since a turn's declared waits replace the old ones: the next
 * message always, and the reading of any message still in flight.
 */
function intakeWaits(t: Turn, reading: number): void {
  t.wait({ for: "message.received", reason: "the next message you forward" });
  if (reading > 0) t.wait({ for: "extract.done", reason: `the reading of ${plural(reading, "message")} you forwarded` });
}

function modelAnswer(body: EffectResult<ModelResult> | undefined): { promises: unknown[]; by: string } | { error: string } {
  if (!body?.ok) return { error: body?.error ? String(body.error) : "the model call failed" };
  const promises = (body.result?.json as { promises?: unknown } | null | undefined)?.promises;
  if (!Array.isArray(promises)) return { error: "the answer has no list of promises in it" };
  return { promises, by: body.result?.standIn ? "stand-in" : (body.result?.model ?? "model") };
}

const day = (instant: Date | string) => dayName(instant, TIME_ZONE);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const inTwoDays = (now: Date) => new Date(now.getTime() + TWO_DAYS_MS).toISOString();

/** "send you the deck", as they put it, turned around for writing back to them: "send me the deck". */
function backToThem(what: string): string {
  return what.replace(/\byours\b/gi, "mine").replace(/\byour\b/gi, "my").replace(/\byou\b/gi, "me");
}

/** The reminder I'd send, in my voice. I can edit it before it goes. */
function draftReminder(p: PromiseFile): string {
  const said = p.message ? `on ${day(p.message.at)} you said` : "you said";
  return `Hi ${firstName(p.who)}, a quick reminder: ${said} you'd ${backToThem(p.what)} by ${day(p.due)}. Is that still on track?`;
}

function askAboutIt(t: Turn, p: PromiseFile): void {
  const first = firstName(p.who);
  const draft = draftReminder(p);
  const where = p.message ? `, in a message on ${day(p.message.at)}` : "";
  const ask = t.ask({
    question: `Send ${first} a reminder to ${p.what}?`,
    why: `${p.who} said they would ${p.what} by ${day(p.due)}${where}, and that time has passed.`,
    options: [
      { id: "send", label: "Send the reminder", consequence: `${first} gets the reminder below from you, once you approve its exact text.` },
      { id: "wait", label: "Wait two more days", consequence: "I ask you again in two days." },
      { id: "drop", label: "Drop it", consequence: "I stop keeping track of this promise." },
    ],
    recommend: "wait",
    default: "wait",
    expires: TWO_DAYS,
    payload: { to: p.to, draft },
    evidence: p.evidence,
  });
  t.write("promise.json", { ...p, status: "asked", next: undefined, ask, asked: p.asked + 1, draft } satisfies PromiseFile);
  t.wait({ ask, reason: `your answer about reminding ${first}` });
}

function askAgainLater(t: Turn, p: PromiseFile, fields: Partial<PromiseFile>): void {
  // Two days from now, or the promise's own due date if it has since moved later than that.
  const next = new Date(Math.max(Date.parse(inTwoDays(t.now)), Date.parse(p.due))).toISOString();
  t.write("promise.json", { ...p, ...fields, status: "open", next, ask: undefined, reminder: undefined } satisfies PromiseFile);
  t.wait({ until: next, reason: `asking you again about ${firstName(p.who)}'s promise` });
}

async function answered(t: Turn): Promise<void> {
  const body = t.event.body ?? {};
  const p = await t.json<PromiseFile>("promise.json");
  if (!p || p.status !== "asked" || p.ask !== body.ask) return t.note(`Ignored the answer to ${String(body.ask)}: it isn't the open question`);
  const first = firstName(p.who);
  const how = t.event.type === "ask.expired" ? `Nobody answered ${p.ask}, so its default applies` : `You answered ${p.ask}`;

  if (body.option === "send") {
    const edited = typeof body.payload?.draft === "string" && body.payload.draft.trim() ? body.payload.draft.trim() : null;
    const text = edited ?? p.draft ?? draftReminder(p);
    const reminder = t.effect("reminder.send", { to: p.to, text, promise: t.self }, { then: "reminder.result" });
    t.write("promise.json", { ...p, status: "sending", ask: undefined, reminder, draft: text } satisfies PromiseFile);
    t.wait({ for: "reminder.result", reason: `your approval of the reminder to ${first}` });
    return t.note(`${how}: send. The reminder to ${first} waits for your approval of its exact text`);
  }
  if (body.option === "drop") {
    t.write("promise.json", { ...p, status: "dropped", ask: undefined } satisfies PromiseFile);
    t.done(`you dropped it`);
    return t.note(`${how}: drop. I stopped keeping track of it`);
  }
  askAgainLater(t, p, {});
  t.note(`${how}: wait. I'll ask again in two days`);
}

// ---- The system ----------------------------------------------------------------------------------------

export default defineSystem({
  name: "promise-keeper",
  charter,
  owner: { timezone: TIME_ZONE },
  parts: {
    intake: {
      purpose: "Read each message I forward and keep track of the promises people make me in it",
      on: {
        "message.received": async (t) => {
          const inFlight = (await t.list("pending")).length;
          const message = readMessage(t);
          if ("reason" in message) {
            intakeWaits(t, inFlight);
            return t.note(`Ignored a message: ${message.reason}`);
          }
          const evidence = t.evidence(JSON.stringify(message), { source: `message from ${message.from}`, type: "application/json" });
          const fx = t.effect("extract", extractArgs(message), { then: "extract.done" });
          t.write(`pending/${fx}.json`, { message, evidence, requestedAt: t.now.toISOString() } satisfies Pending);
          intakeWaits(t, inFlight + 1);
          t.note(`Asked for a reading of ${senderName(message.from)}'s message`);
        },

        "extract.done": async (t) => {
          const fx = String(t.event.body?.effect ?? t.event.from);
          intakeWaits(t, (await t.list("pending")).filter((name) => name !== `${fx}.json`).length);
          const pending = await t.json<Pending>(`pending/${fx}.json`);
          if (!pending) return t.note(`No message was waiting for ${fx}`);
          t.delete(`pending/${fx}.json`);
          const { message } = pending;
          const now = t.now.toISOString();
          const answer = modelAnswer(t.event.body);
          if ("error" in answer) {
            t.write(`messages/${message.id}.json`, { ...message, readAt: now, error: answer.error } satisfies MessageFile);
            t.tell(`I couldn't read the promises in ${senderName(message.from)}'s message of ${day(message.at)}: ${answer.error}. It's kept in parts/intake/messages/${message.id}.json.`);
            return t.note(`Couldn't read ${message.id}: ${answer.error}`);
          }

          const { accepted, rejected } = decide(answer.promises, message, t.now);
          const evidence = [pending.evidence, ...(t.event.evidence ?? [])];
          for (const p of accepted) {
            const body = { who: p.who, what: p.what, due: p.due, to: message.from, message: { id: message.id, from: message.from, at: message.at }, proposedBy: answer.by };
            t.send(`promise/${p.slug}`, "promise.made", body, { evidence });
          }
          t.write(`messages/${message.id}.json`, {
            ...message,
            readAt: now,
            readBy: answer.by,
            ...(message.text.length > READ_CHARS ? { readChars: READ_CHARS } : {}),
            promises: accepted.map((p) => ({ address: `promise/${p.slug}`, who: p.who, what: p.what, due: p.due })),
            rejected,
          } satisfies MessageFile);
          const found = plural(answer.promises.length, "proposed promise");
          t.note(`${senderName(message.from)}'s message: ${found}; kept ${accepted.length}${rejected.length ? `, rejected ${rejected.length} (${rejected.map((r) => r.reason).join("; ")})` : ""}`);
        },
      },
    },

    promise: {
      purpose: "Keep track of something someone promised me, and when it's due, help me remind them",
      instances: true,
      on: {
        "promise.made": async (t) => {
          const body = t.event.body ?? {};
          const to = typeof body.to === "string" && body.to.trim() ? body.to.trim() : null;
          const checked = checkPromise(body, to ? senderName(to) : t.instance, t.now);
          const current = await t.json<PromiseFile>("promise.json");
          if ("reason" in checked) {
            if (!current) t.done(`nothing to keep: ${checked.reason}`);
            return t.note(`Ignored a promise.made: ${checked.reason}`);
          }
          if (current && !FINISHED.has(current.status)) {
            if (current.due === checked.due) return t.note(`Already keeping this: ${current.who} will ${current.what} by ${day(current.due)}`);
            if (current.status === "sending") {
              t.write("promise.json", { ...current, due: checked.due } satisfies PromiseFile);
              return t.note(`${current.who} moved it to ${day(checked.due)}; a reminder is already waiting for your approval`);
            }
          }
          const message = body.message && typeof body.message.id === "string" ? { id: body.message.id, from: String(body.message.from), at: String(body.message.at) } : null;
          const fresh: PromiseFile = {
            who: checked.who,
            what: checked.what,
            due: checked.due,
            to: to ?? checked.who,
            status: "open",
            madeAt: t.now.toISOString(),
            message,
            proposedBy: typeof body.proposedBy === "string" ? body.proposedBy : t.event.from,
            evidence: t.event.evidence ?? [],
            next: checked.due,
            asked: current && !FINISHED.has(current.status) ? current.asked : 0,
          };
          t.write("promise.json", fresh);
          t.wait({ until: checked.due, reason: `${firstName(checked.who)} said they'd ${checked.what} by ${day(checked.due)}` });
          t.note(current && !FINISHED.has(current.status) ? `${checked.who} moved it to ${day(checked.due)}` : `Keeping track: ${checked.who} will ${checked.what} by ${day(checked.due)}`);
        },

        timer: async (t) => {
          const p = await t.json<PromiseFile>("promise.json");
          // Act only on an open promise that is due; any other timer no longer applies.
          if (!p || p.status !== "open" || !p.next || Date.parse(p.next) > t.now.getTime()) return t.note("A timer that no longer applies; nothing is due now");
          askAboutIt(t, p);
        },

        "ask.answered": answered,
        "ask.expired": answered,

        "reminder.result": async (t) => {
          const body: EffectResult<SendResult> = t.event.body ?? {};
          const p = await t.json<PromiseFile>("promise.json");
          if (!p || p.status !== "sending" || p.reminder !== body.effect) return t.note(`Ignored ${String(body.effect)}'s result: no reminder of this promise is waiting for it`);
          const first = firstName(p.who);
          if (body.denied) {
            askAgainLater(t, p, {});
            return t.note(`You didn't approve the reminder to ${first}, so nothing was sent. I'll ask again in two days`);
          }
          const result = body.result ?? {};
          const text = typeof result.text === "string" ? result.text : (p.draft ?? draftReminder(p));
          if (body.ok && (result.sent === true || result.assumed === true)) {
            t.write("promise.json", { ...p, status: "reminded", reminder: undefined, remindedAt: t.now.toISOString(), draft: text } satisfies PromiseFile);
            t.done(`reminded ${first}`);
            return t.note(`Sent ${first} the reminder you approved`);
          }
          // In doubt is said as in doubt: a reminder that may have gone out is never reported as unsent.
          if (result.inDoubt) {
            const why = result.reason ?? "the runner stopped while sending it, so I don't know whether it went out";
            t.write("promise.json", { ...p, status: "in-doubt", reminder: undefined, error: why, draft: text } satisfies PromiseFile);
            t.tell(`I may or may not have sent your reminder to ${first}: ${why}. Check with them before sending it again. The text you approved:\n\n${text}`, { evidence: t.event.evidence ?? [] });
            return t.done(`the reminder is in doubt: ${why}`);
          }
          const why = body.ok ? (result.reason ?? "it wasn't sent") : (body.error ?? "sending it failed");
          t.write("promise.json", { ...p, status: "unsent", reminder: undefined, error: why, draft: text } satisfies PromiseFile);
          t.tell(`I couldn't send your reminder to ${first}: ${why}. Here is the text you approved, if you'd like to send it yourself:\n\n${text}`, { evidence: t.event.evidence ?? [] });
          t.done(`couldn't send the reminder: ${why}`);
        },
      },
    },
  },

  effects: {
    extract: {
      kind: "model",
      model: "anthropic/claude-opus-5-5",
      standIn,
      // What one reading can cost at most (see READ_CHARS). The budget counts each reading at this when
      // the provider doesn't report a price.
      maxUsd: 0.05,
      budget: { usd: 1, per: "month" },
      // Reading a message again is harmless, so a runner that stopped mid-call just asks again.
      idempotent: true,
    },
    "reminder.send": {
      kind: "custom",
      approval: true,
      idempotent: false,
      describe: (args: { to?: string }) => `Send ${args?.to ?? "them"} the reminder below`,
      run: async (args: { to: string; text: string; promise?: string }, ctx) => {
        const url = process.env.PROMISE_KEEPER_WEBHOOK;
        if (!url) return { sent: false, reason: "no transport configured", to: args.to, text: args.text };
        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": ctx.key },
            body: JSON.stringify({ to: args.to, text: args.text, promise: args.promise, key: ctx.key }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (error) {
          // A webhook that was never reached certainly didn't send it; one that went quiet may have.
          const code = (error as { cause?: { code?: string } }).cause?.code;
          if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") return { sent: false, reason: "the webhook couldn't be reached", to: args.to, text: args.text };
          return { sent: false, inDoubt: true, reason: "the webhook didn't confirm it, so I don't know whether it went out", to: args.to, text: args.text };
        }
        // The status says what happened even if the body is cut off afterwards.
        let reply = "";
        try {
          reply = await response.text();
        } catch {
          reply = `(the answer's body was cut off after HTTP ${response.status})`;
        }
        // A webhook URL often carries its secret, so the receipt names only its origin.
        ctx.evidence(reply, { source: new URL(url).origin, type: response.headers.get("content-type") ?? "text/plain" });
        if (response.ok) return { sent: true, to: args.to, text: args.text };
        // A 4xx is the webhook refusing it. Anything else, such as a proxy's 504, may have gone through.
        if (response.status >= 400 && response.status < 500) return { sent: false, reason: `the webhook refused it with HTTP ${response.status}`, to: args.to, text: args.text };
        return { sent: false, inDoubt: true, reason: `the webhook answered HTTP ${response.status}, so I don't know whether it went out`, to: args.to, text: args.text };
      },
    },
  },
});
