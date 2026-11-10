# Atoll

**Atoll runs agents whose whole state is a directory on an Archil disk.**

An agent here is work you hand off that stays on duty for months. It watches something, follows up,
waits for days without forgetting, and asks you when a decision needs a person. Everything it is lives
in one directory:

```text
release-radar/
├── CHARTER.md    what I asked it to do, and what it must never do
├── STATUS.md     the five answers, rewritten after every tick
├── atoll.json    its parts, effects, schedules, and budgets
├── inbox/        events waiting for a turn, one file each
├── journal/      every turn it has taken and why: its write-ahead log
├── parts/        what each part knows, and what it is waiting for
├── asks/         questions for me, each with a recommendation, a default, and an expiry
├── outbox/       things it wants to do in my name, waiting for my approval
├── notices/      what it told me
├── evidence/     receipts: every page it fetched, every model answer, every command's output
├── workspace/    where untrusted commands run
└── .atoll/       the code that runs it, the lease, the meter, checkpoints
```

That directory is the agent. The harness that runs it is a file in it, its history is a file in it, and
the events that wake it are files in it. Compute is borrowed for one turn and thrown away: my laptop, a
CI job, a sandbox that sleeps until a webhook wakes it, or a microVM for a command I don't trust.
Anything that holds the disk's ID can take the next turn, so moving the agent to another machine means
passing the ID.

[What a turn is](#what-a-turn-is) · [Why a disk](#why-a-disk) · [Try it](#try-it) ·
[Guarantees](#what-atoll-guarantees) · [Measured](#measured-on-archil) · [Plugins](#plugins-for-claude-code-and-codex) ·
[Design](docs/a-place-to-stand.md)

## What a turn is

Most of what wakes a standing agent isn't me. It's a schedule, a webhook, an answer I gave yesterday,
another agent handing off, the result of a request the agent made an hour ago. Each of those arrives as
an event file in `inbox/`, and each event gets exactly one turn:

1. A runner takes the disk's lease. The lease is one object per epoch, created with S3's create-only
   write (`If-None-Match: *`), so exactly one runner wins each epoch, and the epoch number fences every
   record it writes.
2. The handler for the event reads whatever files it needs. Everything else it does (writes, messages to
   other parts, requests for effects, waits, questions for me) is buffered.
3. **The turn commits with one append to the journal.** A turn that changes nine files is still one
   append, and Archil commits an append before it returns. A crash before the append means the turn
   never happened; a crash after it means the next runner finishes installing it. The files are a
   materialized view of the journal.
4. Effects run only after the commit: HTTP requests, model calls, commands in a microVM, messages to
   people. Each has an idempotency key and a budget, and the ones that speak for me wait for my
   approval. An effect whose outcome can't be known is reported as in doubt, never as done.

The test suite crashes a runner at every storage operation of a turn, before and after each write
lands, recovers with a fresh runner, and checks that every event was handled exactly once.

## Why a disk

I built two earlier versions of this on actors (Cloudflare Durable Objects, then Rivet). Actors were
good at control: an address, a mailbox, one message at a time. They were bad at context: large,
shared, forkable workspaces that a model can read with ordinary tools. An Archil disk is the other way
around, and most of what an agent needs is context.

- **Every question has an `ls` answer.** The five things I want to know about anything I've left
  running are files, so the agent can be read with `cat`, `ls`, and `grep`, by me or by a model:

  | What I want to know | Where it is |
  | --- | --- |
  | What is it trying to accomplish? | `CHARTER.md` and each part's purpose |
  | What changed, and why? | `journal/`, where each turn names its cause, its writes, and its receipts |
  | What is it waiting for? | `parts/**/waiting.json` and `.atoll/next-wake` |
  | What evidence supports it? | `evidence/`, content-addressed and cited by hash |
  | What does it need from me? | `asks/` and `outbox/`; answering is writing `asks/<id>.answer.json` |

- **A checkpoint is a snapshot of the whole system.** One runner writes an atoll at a time, so a
  checkpoint taken between ticks is a consistent cut of every part, every pending event, and every open
  question. Archil reports 15 to 36 ms for one, at any size.
- **A branch is a full copy to try things on.** `atoll fork` branches the disk; the branch has its own
  disk ID and every command accepts it. `atoll try` replays recorded history through the code in my
  working copy, each turn against the exact files it originally saw, and shows which turns would behave
  differently.
- **A command can be a transaction.** An `exec` effect with `fork: true` checkpoints the disk, runs on a
  branch, and merges back only if every file it touched still holds, on the main atoll, what the branch
  started from. Otherwise nothing from the branch lands and the part is told which files conflicted.
- **Untrusted code gets one directory.** Commands run in Archil's serverless exec with the disk mounted
  and scoped to `workspace/`, so they can't read or rewrite the journal, the questions, the lease, or
  the code, and every file they change is recorded against the effect that changed it. Exec carries no
  credentials, though today it does reach the open internet.
- **Turns cost no compute.** The control plane is Archil's object API, which isn't billed per call. An
  atoll spends tool calls only when it asks for hands.

Archil has no timers and no triggers, so Atoll says so instead of pretending: waits are files,
`.atoll/next-wake` holds the next due time, and something outside calls `atoll tick`. `atoll clock`
writes that something for you: a crontab line, a launchd job, a GitHub Actions schedule, or a request to
the door.

## Try it

Atoll needs Node.js 22.19 or later. It isn't on npm yet. It will be published as `@standing-systems/atoll`; the
bare name `atoll` there belongs to an unrelated package, so don't `npm install atoll`. From a checkout of
this repository:

```sh
npm install && npm run build && npm link     # puts `atoll` on your PATH
```

**A local atoll, with no account.** `atoll init` scaffolds a project with tests and guidance for Claude
Code and Codex. The project's atoll lives in `.atoll-local/` until you give it a disk.

```sh
atoll init radar --template release-radar && cd radar && npm install
npm test                                    # the example's tests; no network
atoll push                                  # bundle system.ts onto the (local) atoll
atoll send watch/rivetkit watch.start '{"package": "rivetkit"}' --tick
atoll status                                # the five answers
atoll why parts/watch/rivetkit/latest.json  # the turn that wrote it, and every cause before it
```

**The same atoll on Archil.** With `ARCHIL_API_KEY` and `ARCHIL_REGION` in the environment, or in the
project's `.env` the way Archil's own setup prompts keep them (a free account works):

```sh
atoll create radar --disk radar             # one of the Free plan's five disks
atoll push --disk radar                     # the code goes onto the disk; one exec for the checkpoint
atoll send watch/rivetkit watch.start '{"package": "rivetkit"}' --disk radar --tick
atoll ls --disk radar                       # the disk's files, without mounting it
atoll clock --crontab --disk radar          # a line that ticks it every 15 minutes
```

`atoll create` looks before it writes. On a disk that already has files, it shows the top level and
stops: `--prefix atolls/radar` gives the atoll a folder of its own, and `--alongside` puts it beside
them. It never overwrites a file either way.

**A door that sleeps.** A webhook needs an address. `atoll door up` creates a small sandbox that mounts
the disk in conditional mode and runs `atoll serve` from the copy of the runtime stored on the disk. It
pauses when idle, costs nothing while paused, and a request with its port token wakes it. It works with
the model keys its code calls its models with and no others, and it won't come up if a model effect with
no stand-in would have no key. On an Archil plan that can set a sandbox's network policy, the door reaches
only the hosts its effects declare, and Archil adds those keys to its requests, so the door never holds
them. On the Free plan it holds them, and reaches Archil's managed allowlist.

```sh
atoll door up --disk radar
atoll door call /events '{"to": "watch/rivetkit", "type": "watch.poll"}' --disk radar
atoll door down --disk radar
```

## What an atoll looks like in code

An atoll is declared in one `system.ts`. Parts are directories; handlers get a turn. This is part of the
release radar in `examples/release-radar`:

```ts
export default defineSystem({
  name: "release-radar",
  charter,
  parts: {
    watch: {
      purpose: "Tell me about each new version of this package on npm",
      instances: true, // one directory per package: parts/watch/<name>/
      schedules: [{ every: "1h", send: "watch.poll" }],
      on: {
        "watch.poll": async (t) => {
          const w = await t.json<WatchFile>("watch.json");
          t.effect("npm.get", { url: w.url, pick: ["name", "version"] }, { then: "watch.fetched" });
          t.wait({ for: "watch.fetched", reason: `npm's answer about ${w.package}` });
        },
        "watch.fetched": async (t) => {
          const w = await t.json<WatchFile>("watch.json");
          const reading = readLatest(t.event.body);
          const latest = await t.json<LatestFile>("latest.json");
          if (reading.ok && latest?.version !== reading.version) {
            t.write("latest.json", { version: reading.version, previous: latest?.version ?? null, seenAt: t.now.toISOString(), evidence: t.event.evidence });
            t.send("ledger", "release.seen", { name: w.package, version: reading.version }, { evidence: t.event.evidence });
          }
        },
      },
    },
    ledger: { purpose: "Keep one record of every release a watch sees, and tell me once about each major or minor one", on: { /* ... */ } },
    digest: { purpose: "Write me a digest of the week's releases every Monday", schedules: [{ cron: "0 16 * * 1", send: "digest.due" }], on: { /* ... */ } },
  },
  effects: {
    "npm.get": { kind: "http", allow: ["registry.npmjs.org"], budget: { calls: 5000, per: "month" } },
  },
});
```

The digest doesn't message the ledger for its data; it reads the ledger's files. Parts share the
environment and own their writes: a part may read anything in the atoll and write only under its own
directory, which the runtime checks at commit.

The second example, `examples/promise-keeper`, takes messages in, has a model propose the commitments in
them (a deterministic stand-in answers when no model key is set), validates the proposal in code, keeps
one directory per promise, and when one is overdue drafts a reminder and asks before sending it. The
approval is spent once, on exactly the text I approved or my edit of it.

## What Atoll guarantees

Each guarantee has a test that would fail without it.

| Guarantee | Test |
| --- | --- |
| A turn's writes, messages, effects, waits, and questions happen together or not at all, whatever storage operation a crash lands on | `test/runtime/crash.test.ts` |
| An event ID is handled at most once within 30 days, however often it's delivered | `test/runtime/semantics.test.ts` (duplicates) |
| One runner at a time: of 20 runners racing for an epoch, one wins; a runner whose lease was taken can't commit | `test/runtime/semantics.test.ts` (the lease) |
| An effect is never reported done without a recorded outcome; a non-idempotent one interrupted mid-call is marked in doubt and asked about, not run again | `test/runtime/crash.test.ts` (effects) |
| An approved effect runs once, with exactly the approved arguments; an unanswered approval never runs it | `test/runtime/semantics.test.ts` (approvals) |
| An effect that would exceed its budget doesn't run until I allow it | `test/runtime/semantics.test.ts` (budgets) |
| A timer fires once per due time; a schedule keeps its cadence, and a missed one fires once, not once per missed period | `test/runtime/semantics.test.ts` (timers, schedule cadence) |
| Replaying the journal through the code that ran reproduces every turn | `test/runtime/semantics.test.ts` (replay) |
| A forked command merges back only if nothing changed the same files meanwhile | `test/runtime/hands.test.ts`; live on Archil in `test/live/fork.test.ts` |
| A command run as an effect sees none of the runner's keys, locally as on Archil, so none can end up in the atoll | `test/runtime/hands.test.ts` (environment) |
| A model effect without its key answers with its stand-in, or fails and costs nothing if it has none; it never answers with nothing | `test/runtime/models.test.ts` |
| A door gets only the model keys its code uses, and they never appear in a command, in what comes back, or on the disk | `test/door/sandbox.test.ts`; live on Archil in `test/live/door-models.test.ts` |
| On a plan that can set a network policy, a door asks to reach only the hosts its effects declare, and its model keys go to Archil while the sandbox gets placeholders | `test/door/sandbox.test.ts`; live on Archil's Developer plan in `test/live/door-models.test.ts`, and with a real key and a model's answer in `test/live/door-answer.test.ts` |
| `atoll create` and `atoll push` show what is already on a disk and stop before laying an atoll out beside it; nothing is overwritten | `test/cli.test.ts`; live on Archil in [verification](docs/verification.md) |
| `atoll check` finds files under `parts/` that no turn wrote | `test/runtime/basics.test.ts`, `test/cli.test.ts` |

What it doesn't guarantee:

- **Exactly-once external effects.** A non-idempotent effect interrupted mid-call is in doubt; only the
  far side's own idempotency can rule out a duplicate.
- **Mutual exclusion beyond 10 seconds of clock skew.** The lease assumes runners' clocks roughly agree.
  A stale runner's commit beyond that is detected (`atoll check` reports it), not prevented.
- **A consistent view of `parts/` mid-tick.** A reader can see a turn half installed; the journal,
  `STATUS.md`, and checkpoints taken between ticks are consistent.
- **Timing more precise than the clock.** A timer fires at the first tick after it's due.
- **Isolation from someone holding the disk's credentials.** A branch isn't a security boundary, and an
  API key reaches every branch and checkpoint of every disk in its account.
- **Deploys.** Atoll never creates a disk, pushes code, starts a door, or installs a clock on its own,
  and the plugins answer a request to do any of those with the plan.

## Measured on Archil

On a free account in `aws-us-west-2`, from a laptop, on 5 November 2026. `node scripts/measure.mjs`
reruns every row on your own account and deletes what it creates; the full output, failures included, is
in [docs/research/measurements-2026-11-05.md](docs/research/measurements-2026-11-05.md).

| Operation | Measured |
| --- | --- |
| Object API read / write / append / list (p50 of 20) | 52 / 58 / 54 / 54 ms |
| Create-only PUT, 10 concurrent writers on one key | 1 winner and 9 × `412` in each of 3 rounds |
| Append, 20 concurrent writers on an existing object | 20 of 20 records whole, none duplicated or interleaved |
| Append, 20 concurrent first writers on a missing object | 9 of 20 succeed (the rest get `409` and write nothing); 20 of 20 with Atoll's retry |
| Serverless exec round trip (p50 of 5) | 99 ms, of which Archil reports 46 ms |
| Checkpoint, taken in one exec | 168 ms; readable through the S3 API 9.6 s later |
| Branch from that checkpoint | 68 ms |
| Door up: copy the runtime, create the sandbox, start `atoll serve`, mint a port token | 3.8 s |
| Door, awake: deliver an event and run its turn | 275 ms (p50 of 3) |
| Door, paused: one request wakes it, delivers an event, and runs its turn | 865 to 947 ms |
| Door, paused, woken by `GET /healthz` | 680 ms |
| A turn run from a laptop through the object API | about 0.6 s per journal record ([verification](docs/verification.md)) |

The numbers that look bad stay in. A turn from a laptop is slow because each one makes a few dozen object
API calls of about 55 ms, some in sequence; on the door, where the disk is a local mount, the same turn
takes a fraction of that. A checkpoint isn't readable over the S3 API for several seconds after it returns
(`503 SlowDown`, "The checkpoint is not readable yet"). A paused sandbox wakes only on a new connection:
a request on a keep-alive connection opened before the pause hangs, which cost one measurement run a
30-second timeout, so the door client opens a fresh connection for every request. A plain sandbox mount
holds the disk's whole write delegation even while paused, which makes every object-API write fail with
`409`, so the door mounts in conditional mode. And concurrent appends through FUSE mounts lost data in my
probes (three execs appending to one file through conditional mounts kept 20 of 60 lines), which is why
Atoll never shares a file through a mount.

## What it costs

An atoll at rest is its files. After a simulated week of watching two packages hourly, served npm's real
answers, the release radar's atoll is 994 KiB: 902 KiB of journal across 1,356 records, and the 338
answers it fetched deduplicated to two receipts, because they didn't change. Archil charges $0.20 per
GiB-month for that. A turn uses no tool calls.
Hands cost $0.05 per 1,000 exec calls, and a forked command uses two. The door costs $0.055 per vCPU-hour and $0.020 per GiB-hour while awake and
nothing while paused, so a door woken a hundred times a day for about twenty seconds each comes to about
$1.25 a month. The Free plan's 1,000 tool calls and one sandbox-hour a month run both examples from a
laptop or CI indefinitely, and a door for a demo but not as a permanent host.

## Plugins for Claude Code and Codex

The plugins teach a coding agent to design, build, test, run, inspect, and change atolls. The Claude Code
plugin has six skills (`start`, `design`, `build`, `run`, `inspect`, `evolve`), two critics
(`part-critic` argues for fewer parts; `effect-auditor` checks idempotency, approvals, budgets, and
in-doubt handling), a hook that runs `atoll check` after edits to `system.ts`, and the CLI on the agent's
PATH. The Codex plugin has the same skills and launcher.

```sh
claude plugin marketplace add /path/to/atoll && claude plugin install atoll@atoll
codex plugin marketplace add /path/to/atoll && codex plugin add atoll@atoll
```

The rules that must hold even when no skill fires (never push, create a disk, start a door, or install a
clock without the person; answer a deploy request with the plan) also go into the `CLAUDE.md` and
`AGENTS.md` that `atoll init` writes.

## What would make Atoll smaller

Building this on Archil for a few days left me with a short list, each item a piece of Atoll that would
disappear:

- **Harness invocation from the disk.** Running code stored on the disk when a request arrives would
  replace the door.
- **Scheduled exec.** A timer that runs a command against a disk would replace the clock.
- **Create-only and compare-and-swap writes in the SDK.** The S3 API honors `If-None-Match: *`, but
  `putObject` doesn't expose it, so Atoll reaches it through the SDK's internal request method.
- **Checkpoints through the API.** Today a laptop runner spends an exec to take one.

The rest of what I learned, with the measurements behind each item, is in section 14 of the
[design document](docs/a-place-to-stand.md).

## Status

Early: a one-person project, started 4 November 2026.

- Built and tested: the atoll format, the runtime (turns, the journal, the lease, recovery, effects,
  approvals, budgets, waits, schedules, questions, replay), the CLI, the Archil store, the door, both
  examples, and both plugins. `npm run verify` runs everything that needs no account;
  `npm run test:live` runs the Archil tests and deletes what they create.
- Not built yet: agent parts whose handler is a model loop, shell-script parts, and read-only context
  disks mounted beside an atoll's own. The design document's roadmap has the order.
- One owner per atoll. There are no accounts, teams, or shared atolls.
- Nothing is published to npm, and anything may change.

The design, with the reasoning behind every choice above, is in
[A Place to Stand](docs/a-place-to-stand.md).

## The name

Archil's name alludes to an archipelago. As its founder tells it, data in the cloud sits on islands it
can't easily leave, and Archil bridges them so the data can be reached from anywhere. An atoll is an island
of a particular kind: a ring of reef around a still lagoon, built up layer by layer by the small things
that live on it. That is how an agent lives here. Its journal only grows, its parts each keep to their own
ground, and because the island is an Archil disk, a laptop, a CI job, and a sandbox can all reach it.

## License

Apache-2.0. See [LICENSE](LICENSE).
