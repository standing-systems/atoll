// __ATOLL_NAME__: an atoll with one part, to start from. Each reminder is its own directory,
// parts/reminder/<name>/, and waits on the disk until its time comes. Change this file into the atoll
// you want.

import { defineSystem } from "@standing-systems/atoll";

/**
 * What I asked for, in my words. `atoll push` writes it into the atoll's CHARTER.md under the atoll's
 * name, followed by each part's purpose, and keeps it in step; a test checks that the result is the
 * CHARTER.md beside this file.
 */
const charter = `## What I want

Remind me of things at the times I ask for. When I set a reminder, keep it until its time comes, then
tell me once. If I move a reminder to a later time, remind me at the new time and not the old one.

## What it may do in my name

Nothing outside its own disk. It keeps its reminders in its own files and tells me things through
notices.

## What it must never do

- Never tell me about the same reminder twice.
- Never contact anyone but me.
- Never spend money. It has no effects that cost anything.
- Never change its own code, or what it does, without me.

## How it asks me

It doesn't ask me anything yet. When it does, every question will come with a recommendation, a default,
and an expiry, so nothing waits on me forever.`;

interface Reminder {
  text: string;
  at: string;
}

export default defineSystem({
  name: "__ATOLL_NAME__",
  charter,
  parts: {
    reminder: {
      purpose: "Remind me of something at the time I ask for",
      instances: true,
      on: {
        // atoll send reminder/dentist reminder.set '{"text":"Call the dentist","at":"2026-11-05T15:00:00Z"}'
        "reminder.set": (t, e) => {
          const { text, at } = (e.body ?? {}) as Partial<Reminder>;
          if (typeof text !== "string" || typeof at !== "string" || Number.isNaN(Date.parse(at))) {
            t.tell(`I couldn't set the reminder "${t.instance}": it needs a text and a time.`);
            t.done("the request had no text or no time");
            return;
          }
          t.write("reminder.json", { text, at });
          t.note(`set for ${at}`);
          // Declaring a wait replaces this reminder's earlier one, so moving it keeps only the new time.
          t.wait({ until: at, reason: `the time you asked to be reminded, ${at}` });
        },
        timer: async (t) => {
          const reminder = await t.json<Reminder>("reminder.json");
          // A timer that was already due when the reminder moved still arrives; it isn't the time yet.
          if (reminder && t.now.getTime() < Date.parse(reminder.at)) return;
          if (reminder) t.tell(reminder.text);
          t.done("I reminded you");
        },
      },
    },
  },
});
