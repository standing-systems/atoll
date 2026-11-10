---
name: design
description: Turn something I want kept standing (an agent that watches a thing, follows up, reminds me, or asks me before acting) into an atoll design, a table of parts with what each owns on disk, waits for, asks me, may do in my name, and spends, plus a CHARTER.md in my voice with a "never do" list. Has the part-critic argue for fewer parts.
---

# Design an atoll

Rules that hold for this whole skill:
- **Fewer parts.** A part earns its own directory only if at least one of these holds: it **owns state**
  that no other part writes, it has **its own waits or schedule**, or it needs **its own instances** (one
  directory per thing it tracks, such as one per package or per promise). Anything else is a handler on a
  part that already exists, an effect, a schedule, or a file in a part's directory. Parts read each
  other's files freely, so sharing data never needs a part or an event of its own.
- **Programs before models.** Use a `model` effect only where reading or judgment is needed, and let code
  decide what happens with the answer. Models propose; code decides.
- **Nothing speaks for the person without their OK.** Every effect that reaches another person (a message,
  an email, a comment) declares `approval: true`. Every effect that costs money or counts against a plan
  has a budget.
- **The person is never a hard bottleneck.** Every ask has options with stated consequences, a
  recommendation, a default, and an expiry. Say what happens if nobody answers.
- **The disk is the only memory.** Whatever a part must remember between turns is a file in its
  directory. A variable in the code doesn't survive the runner, and replay can't see it.
- **Never promise** exactly-once external effects, ordering across senders, or exact timing. A timer fires
  at the first tick after it is due, and Archil has no clock of its own: something outside calls
  `atoll tick`.
- Write only `CHARTER.md`, plus what `atoll init` scaffolds for a new project. Handlers and tests are
  `/atoll:build`.

## Steps

1. **Restate the intent** in two sentences, in the person's words. List what it watches, what it tracks,
   what it waits on, who it might contact, and what it might spend.
2. **Find the project.** An atoll project has `system.ts` and `CHARTER.md` at its root. If there is none,
   ask which new or empty directory to use and run `atoll init <dir>` there. Never scaffold into a
   directory that has files in it without asking first.
3. **Draft the parts table**, one row per part. `references/parts.md` has the decisions and the common
   over-splits.

   | Part | Purpose, in my voice | Owns on disk | Waits for | Asks me | May do in my name | Budget |
   | --- | --- | --- | --- | --- | --- | --- |
   | `watch/<package>` | Tell me about each new version of this package on npm | `parts/watch/<package>/latest.json` | its hourly schedule, then the registry's answer | nothing | read the npm registry (`npm.get`, http GET) | 5,000 calls a month |

   - **Part:** its address. `<instance>` marks a part with one directory per instance.
   - **Purpose:** a plain sentence the person would say, with no closing period: "Tell me when...",
     "Keep track of...".
   - **Owns on disk:** the files under `parts/<part>/` it writes. No other part writes them.
   - **Waits for:** a time, an event type, an ask's answer, or a schedule (`every`, or `cron` with a time
     zone). A part that waits for nothing is done.
   - **Asks me:** each question, its options, the recommendation, the default, and the expiry.
   - **May do in my name:** each effect, with its kind (`http`, `exec`, `model`, `notify`, `custom`),
     whether it needs approval, and whether a retry is safe.
   - **Budget:** calls or dollars, per day or per month, for each effect.
4. **List the effects** as they will be declared: a dotted lowercase name such as `npm.get`, the kind,
   `approval`, `idempotent`, `budget`, the `allow` hosts for http, the `scope` for exec, and the `model`
   and `maxUsd` for a model.
5. **Ask the part critic.** Launch the `part-critic` subagent with the table, the effects, and the
   restated intent. It argues for fewer parts and names the test that would settle each disagreement.
6. **Resolve every objection.** Merge the part, or make it a handler, a file, or an effect, or keep it and
   name the `@standing-systems/atoll/testing` test that would prove the critic wrong. Record both sides.
7. **Write `CHARTER.md`** in the person's voice, first person, plain sentences. `atoll push` will write
   the same file to the disk from the system's `charter` and its parts' purposes, so give it that shape:
   the title `# <atoll name>`, then these sections, then `## Parts` with one line per part,
   `- **<part>**: <purpose>.`
   - **What I want:** the intent, in two or three sentences.
   - **What it may do in my name:** each effect in everyday words, with its allowance ("Read the npm
     registry, up to 5,000 times a month").
   - **What it must never do:** a short list ("Never message anyone but me", "Never spend more than $5 a
     month on model calls", "Never send a reminder I haven't approved").
   - **How it asks me:** what it asks about, and what happens if I don't answer.

## Output (the design is done when all of this is shown)

- The parts table and the effects list.
- `CHARTER.md`, written.
- **Rejected parts**, each with the test it failed and what it became instead.
- **Critic objections**, each with its resolution and the test that settles it.
- **Assumptions** that could be wrong: volumes, how often things change, what an outside API guarantees
  (an idempotency key, a rate limit), and how the person wants to be asked.

Stop and ask the person when the intent leaves a consequential choice open: who it may contact, what it
may spend, what must never be lost, or what an outside system guarantees. The next step is `/atoll:build`.
