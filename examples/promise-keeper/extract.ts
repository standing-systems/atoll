// The `extract` effect: what the model is asked, the shape its answer must take, and the stand-in that
// answers when no model key is configured. The stand-in is a plain reader for the commonest kind of
// promise ("I'll send the deck by Friday"). Whoever answers only proposes; system.ts decides.

import { addDays, at, isRealDay, type Day, wallClock, weekday } from "./time.ts";

/** One promise as a model proposes it. */
export interface Proposal {
  who: string;
  what: string;
  /** ISO 8601. */
  due: string;
}

/** What the prompt carries, as JSON: the message, and what's needed to resolve "Friday". */
export interface MessageForModel {
  from: string;
  /** When it was sent, ISO 8601. */
  sent: string;
  timeZone: string;
  text: string;
}

export const EXTRACT_SYSTEM = `You read one message that someone sent me and list the promises in it: things the sender, or someone they name, says they will do by a certain time.

The message arrives as JSON: who sent it ("from"), when it was sent ("sent", ISO 8601), my time zone ("timeZone"), and its text.

For each promise, give:
- who: the person who made it, by name if the message gives one;
- what: what they said they would do, as a short phrase in their words, such as "send you the deck";
- due: when it is due, as an ISO 8601 date and time with an offset. Resolve words like "Friday" or "tomorrow" from when the message was sent, in my time zone. When no time of day is given, use 17:00.

Leave out wishes, questions, plans without a date, and promises I made. If there are no promises, answer with an empty list.`;

export const PROMISES_SCHEMA = {
  type: "object",
  properties: {
    promises: {
      type: "array",
      items: {
        type: "object",
        properties: {
          who: { type: "string", description: "Who made the promise" },
          what: { type: "string", description: "What they said they would do, in their words" },
          due: { type: "string", description: "When it is due, ISO 8601 with an offset" },
        },
        required: ["who", "what", "due"],
        additionalProperties: false,
      },
    },
  },
  required: ["promises"],
  additionalProperties: false,
};

// ---- People ------------------------------------------------------------------------------------------

/** "Sam Rivera <sam@example.com>" is "Sam Rivera"; a bare address stays as it is. */
export function senderName(from: string): string {
  const display = /^\s*"?([^"<]+?)"?\s*<[^>]*>\s*$/.exec(from)?.[1]?.trim();
  return display || from.trim();
}

/** How to greet someone: the first word of their name, or the first word of their address. */
export function firstName(who: string): string {
  const name = senderName(who);
  const word = (name.includes("@") ? name.split("@")[0]!.split(/[._+-]/)[0] : name.split(/\s+/)[0]) ?? "";
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : name;
}

// ---- The stand-in ------------------------------------------------------------------------------------

const PROMISE_OPENERS = String.raw`(?:i'll|i will|i'm going to|i am going to|we'll|we will)`;
const WHEN = String.raw`today|tonight|tomorrow|eod|end of (?:the )?(?:day|week)|(?:next )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2}`;
/** "I'll <what> by <when>", or "I'll <what> tomorrow". */
const PROMISE = new RegExp(String.raw`\b${PROMISE_OPENERS}\s+(.+?)\s+(?:(?:by|before|on|until)\s+(${WHEN})|(today|tonight|tomorrow))\b`, "i");

const DAY_STEMS = ["sun", "mon", "tues", "wednes", "thurs", "fri", "satur"];
const MONTH_STEMS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When a phrase like "Friday" or "Nov 12" falls due, counted from when the message was sent: 17:00 in
 * the time zone ("tonight" is 21:00). "Friday" is the coming Friday, today if it is Friday; "next
 * Friday" is the Friday of next week.
 */
export function resolveDue(phrase: string, sent: Date, timeZone: string): Date | null {
  const p = phrase.toLowerCase().replace(/\s+/g, " ").trim();
  const now = wallClock(sent, timeZone);
  const today: Day = { year: now.year, month: now.month, day: now.day };
  if (p === "today" || p === "eod" || p === "end of day" || p === "end of the day") return at(today, 17, timeZone);
  if (p === "tonight") return at(today, 21, timeZone);
  if (p === "tomorrow") return at(addDays(today, 1), 17, timeZone);
  if (p === "end of week" || p === "end of the week") return at(addDays(today, (5 - weekday(today) + 7) % 7), 17, timeZone);

  const named = /^(next )?(mon|tues|wednes|thurs|fri|satur|sun)day$/.exec(p);
  if (named) {
    const target = DAY_STEMS.indexOf(named[2]!);
    if (!named[1]) return at(addDays(today, (target - weekday(today) + 7) % 7), 17, timeZone);
    const toNextMonday = (8 - weekday(today)) % 7 || 7;
    return at(addDays(today, toNextMonday + ((target + 6) % 7)), 17, timeZone);
  }

  const dated = /^([a-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?$/.exec(p);
  if (dated) {
    const month = MONTH_STEMS.indexOf(dated[1]!) + 1;
    if (month === 0) return null;
    let day: Day = { year: today.year, month, day: Number(dated[2]) };
    if (month < today.month || (month === today.month && day.day < today.day)) day = { ...day, year: today.year + 1 };
    return isRealDay(day) ? at(day, 17, timeZone) : null;
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p);
  if (iso) {
    const day: Day = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
    return isRealDay(day) ? at(day, 17, timeZone) : null;
  }
  return null;
}

/** The deterministic stand-in for the model: the first-person promises with a time, one per sentence. */
export function standIn(args: { prompt?: unknown }): { promises: Proposal[] } {
  let message: MessageForModel;
  try {
    message = JSON.parse(String(args?.prompt)) as MessageForModel;
  } catch {
    return { promises: [] };
  }
  const sent = new Date(message.sent);
  if (typeof message.text !== "string" || Number.isNaN(sent.getTime())) return { promises: [] };
  const who = senderName(String(message.from ?? ""));
  const promises: Proposal[] = [];
  for (const sentence of message.text.replace(/[‘’]/g, "'").split(/(?<=[.!?])\s+|\n+/)) {
    const m = PROMISE.exec(sentence);
    if (!m) continue;
    const what = (m[1] ?? "").replace(/\s+/g, " ").replace(/[,;:]+$/, "").trim();
    const due = resolveDue(m[2] ?? m[3] ?? "", sent, message.timeZone);
    if (what && due) promises.push({ who, what, due: due.toISOString() });
  }
  return { promises };
}
