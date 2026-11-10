# Atoll

**Atoll runs agents whose whole state is a directory on an Archil disk.**

An agent here is work you hand off that stays on duty for months. It watches something, follows up,
waits for days without forgetting, and asks you when a decision needs a person. Everything it is lives
in one directory:

```text
upgrade-steward/
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
├── workspace/    where commands run: here, a checkout of the repository it keeps
└── .atoll/       the code that runs it, the lease, the meter, checkpoints
```

That directory is the agent. The harness that runs it is a file in it, its history is a file in it, and
the events that wake it are files in it. Compute is borrowed for one turn and thrown away: my laptop, a
CI job, a sandbox that sleeps until a webhook wakes it, or a microVM for a command I don't trust.
Anything that holds the disk's ID can take the next turn, so moving the agent to another machine means
passing the ID.

The one above is the [upgrade steward](examples/upgrade-steward), the example this page follows. It keeps a
checkout of a repository on its disk with the dependencies installed. When a dependency publishes a new
version, it tries it on a branch of the whole disk: one command in a microVM installs it and runs the
tests. It tells me which upgrades are safe and which break, and asks before requesting a pull request.
One keeps this repository, with GitHub Actions as its clock, and the repository's first three pull
requests are its first three trials.

[What a turn is](#what-a-turn-is) · [Why a disk](#why-a-disk) · [Try it](#try-it) ·
[In code](#what-an-atoll-looks-like-in-code) · [Guarantees](#what-atoll-guarantees) ·
[Measured](#measured-on-archil) · [Plugins](#plugins-for-claude-code-and-codex) · [Design](docs/a-place-to-stand.md)

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
- **Or a trial.** With `merge: false` as well, nothing is copied back at all: the command's verdict
  returns, and the branch keeps the tree that produced it. A branch of a checkout with 9,710 installed
  files took 114 ms to make.
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

**The upgrade steward, on Archil.** `atoll init` scaffolds a project with tests and guidance for Claude
Code and Codex. Its tests need no account. The rest needs `ARCHIL_API_KEY` and `ARCHIL_REGION` in the
environment, or in the project's `.env` the way Archil's own setup prompts keep them.

```sh
atoll init steward --template upgrade-steward && cd steward && npm install
npm test                                    # replays what its commands really answered on Archil
atoll create upgrade-steward --disk upgrade-steward
atoll push --disk upgrade-steward           # the code goes onto the disk; one exec for the checkpoint
atoll send repo repo.track '{"url": "https://github.com/<you>/<repo>"}' --disk upgrade-steward --tick
atoll status --disk upgrade-steward         # the five answers
atoll asks --disk upgrade-steward           # the pull requests it wants my approval for
```

The repository has to be a public one on GitHub, since the microVM that clones it holds no credential.
That one tick clones it, installs it, and runs its tests. It starts a watch for each dependency and tries
every one that is behind, each on a branch of the disk. For this repository that was six watches and
three trials, and it took two and a half minutes. I ran it on Archil's Developer plan; its budgets add up
to the Free plan's 1,000 tool calls a month.

```sh
atoll answer <ask-id> approve --disk upgrade-steward
atoll why parts/trial/<name>/trial.json --disk upgrade-steward
atoll cat workspace/repo/package.json --disk <branch-id>   # the checkout a trial left, on its branch
atoll clock --github --disk upgrade-steward # a workflow that ticks it
```

An approval becomes a pull request through a workflow in the repository, and the machine that ticks
needs a `GITHUB_TOKEN` to ask for it; [the example's README](examples/upgrade-steward/README.md) has both.

`atoll why` walks back from a file to the event that started it all. This is the steward that keeps this
repository, asked about `parts/trial/disk-1.12.0/trial.json`, its trial of Archil's own SDK (times and
receipts left out):

```text
turn 50: trial/disk-1.12.0 handled pr.done from fx40.0
  ← effect 49: pr.open (fx40.0) done
    ← turn 40: trial/disk-1.12.0 handled trial.ran from fx31.0
      ← effect 33: trial.run (fx31.0) done
        ← turn 31: trial/disk-1.12.0 handled trial.start from watch/disk. Trying disk 1.12.0 (a minor release after 1.11.0) against standing-systems/atoll at 2ca9447
          ← turn 25: watch/disk handled watch.fetched from fx7.0. npm's latest disk is 1.12.0, a minor release after 1.11.0; sent it to trial/disk-1.12.0
            ← effect 9: npm.get (fx7.0) done
            ← turn 7: watch/disk handled watch.set from repo. Started watching disk, which the repository has at 1.11.0
            ← turn 6: repo handled repo.synced from fx3.0. Synced standing-systems/atoll to 2ca9447; installed its dependencies; its own tests pass at 2ca9447 (20 s); 6 watches updated, 0 dropped
            ← effect 5: repo.sync (fx3.0) done
            ← turn 3: repo handled repo.track from @owner. Started keeping standing-systems/atoll; tests run with `npm run typecheck && npm run build && npm test`
That's the whole chain: it starts with an event from outside the atoll.
```

**A local atoll, with no account.** The steward needs a disk, because a trial is a branch of one. The two
smaller examples run whole on a local atoll, which a project keeps in `.atoll-local/` until you give it a
disk:

```sh
atoll init radar --template release-radar && cd radar && npm install
atoll push                                  # bundle system.ts onto the (local) atoll
atoll send watch/rivetkit watch.start '{"package": "rivetkit"}' --tick
atoll status
```

`atoll create` looks before it writes. On a disk that already has files, it shows the top level and
stops: `--prefix atolls/steward` gives the atoll a folder of its own, and `--alongside` puts it beside
them. It never overwrites a file either way.

**A door that sleeps.** The steward doesn't need one, but a system that takes webhooks needs an
address. `atoll door up` creates a small sandbox that mounts
the disk in conditional mode and runs `atoll serve` from the copy of the runtime stored on the disk. It
pauses when idle, costs nothing while paused, and a request with its port token wakes it. It works with
the model keys its code calls its models with and no others, and it won't come up if a model effect with
no stand-in would have no key. On an Archil plan that can set a sandbox's network policy, the door reaches
only the hosts its effects declare, and Archil adds those keys to its requests, so the door never holds
them. On the Free plan it holds them, and reaches Archil's managed allowlist. With the release radar on a
disk named `radar`:

```sh
atoll door up --disk radar
atoll door call /events '{"to": "watch/rivetkit", "type": "watch.poll"}' --disk radar
atoll door down --disk radar
```

## What an atoll looks like in code

An atoll is declared in one `system.ts`. Parts are directories; handlers get a turn. This is part of the
upgrade steward in `examples/upgrade-steward`, with the checks and the wording of its notices cut:

```ts
export default defineSystem({
  name: "upgrade-steward",
  charter,
  parts: {
    repo: { purpose: "Keep a checkout of my repository up to date, with its dependencies installed and its own tests run", schedules: [{ every: "6h", send: "repo.sync" }], on: { /* ... */ } },
    watch: { purpose: "Send each new version of this dependency to a trial", instances: true, schedules: [{ every: "6h", send: "watch.poll" }], on: { /* ... */ } },
    trial: {
      purpose: "Try one new version of one dependency on a copy of the checkout, and tell me whether the tests still pass",
      instances: true, // one directory per package and version: parts/trial/typescript-7.0.2/
      on: {
        "trial.start": async (t) => {
          const { package: name, version } = t.event.body;
          if (await t.json<TrialFile>("trial.json")) return t.note(`Already tried ${name} ${version}`);
          // Another part's files are there to read: what the repository has, and how its own tests did.
          const repo = await t.json<RepoFile>("/parts/repo/repo.json");
          const trial = { package: name, version /* , what it replaces, and where package.json lists it */ };
          t.write("trial.json", { ...trial, state: "running", head: repo.head });
          t.effect("trial.run", { command: trialCommand(trial, repo.test) }, { then: "trial.ran" });
          t.wait({ for: "trial.ran", reason: `${name} ${version} to be installed and tested on a branch` });
        },
        "trial.ran": async (t) => {
          const trial = await t.json<TrialFile>("trial.json");
          const result = await execResult(t); // the command's output, and the branch it ran on
          const summary = summaryOf<TrialSummary>(result, "trial"); // what the command reported about itself
          const evidence = t.event.evidence;
          if (summary.test !== 0) {
            t.write("trial.json", { ...trial, state: "failed", branch: result.branch });
            t.tell(`${trial.package} ${trial.version} breaks the tests. The checkout it left is on branch ${result.branch}.`, { evidence });
            return t.done("it fails the tests");
          }
          t.write("trial.json", { ...trial, state: "passed", branch: result.branch });
          t.tell(`${trial.package} ${trial.version} is safe: the tests pass with it.`, { evidence });
          t.effect("pr.open", { package: trial.package, version: trial.version, branch: result.branch, evidence /* ... */ }, { then: "pr.done" });
          t.wait({ for: "pr.done", reason: "your answer about a pull request, and then GitHub's" });
        },
      },
    },
  },
  effects: {
    "npm.get": { kind: "http", allow: ["registry.npmjs.org"], budget: { calls: 10_000, per: "month" } },
    // One command in a microVM, on a branch of the whole disk that is never merged back.
    "trial.run": { kind: "exec", fork: true, merge: false, ignore: ["node_modules", ".git", ".steward"], idempotent: true, budget: { calls: 300, per: "month" } },
    // It speaks for me, so it waits for my approval of exactly these arguments, and runs once.
    "pr.open": { kind: "custom", approval: true, idempotent: false, run: async (args) => { /* ask GitHub for the pull request */ } },
  },
});
```

A trial is an instance named for its package and version, so a second report of the same release finds
the directory already there. The trial doesn't message the `repo` part for what it knows; it reads the
part's files. Parts share the environment and own their writes: a part may read anything in the atoll and
write only under its own directory, which the runtime checks at commit. The checkout is in `workspace/`,
where only commands write.

There are two smaller examples. `examples/release-radar` watches npm packages, keeps a ledger with one
file per release, tells me once about each major or minor one, and writes a weekly digest. It has no
commands and no model, so it runs whole on a local atoll, and its tests replay two weeks of npm's real
history. `examples/promise-keeper` takes messages in, has a model propose the commitments in them (a
deterministic stand-in answers when no model key is set), validates the proposal in code, keeps one
directory per promise, and when one is overdue drafts a reminder and asks before sending it. The approval
is spent once, on exactly the text I approved or my edit of it.

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
| A command declared with `merge: false` changes nothing on the main atoll, whether it passes or fails, and its branch is recorded either way | `test/runtime/hands.test.ts`; live on Archil in `test/live/steward.test.ts` |
| A runner keeps its lease while an effect runs, however long the effect takes | `test/runtime/semantics.test.ts` (the lease) |
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
in [docs/measurements-2026-11-05.md](docs/measurements-2026-11-05.md).

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

An atoll at rest is its files, at $0.20 per GiB-month. The steward's disk holds a checkout with its
dependencies installed, about 130 MiB for commander.js: under three cents a month. Each trial's branch
stores only what the trial changed.

A turn uses no tool calls. Hands cost $0.05 per 1,000 exec calls: a sync is one and a trial is two, a
checkpoint and then the command. The steward's first tick on this repository, a sync and three trials, was
seven. Its budgets allow 400 syncs and 300 trials a month, which is at most 1,000 calls, or five cents.
Watching the dependencies costs nothing on Archil, since the requests to npm come from whatever machine
runs the tick.

A system with no hands is smaller still. After a simulated week of watching two packages hourly, served
npm's real answers, the release radar's atoll is 994 KiB: 902 KiB of journal across 1,356 records, and the
338 answers it fetched deduplicated to two receipts, because they didn't change.

The door costs $0.055 per vCPU-hour and $0.020 per GiB-hour while awake and nothing while paused, so a
door woken a hundred times a day for about twenty seconds each comes to about $1.25 a month. The Free
plan's 1,000 tool calls and one sandbox-hour a month run the two smaller examples from a laptop or CI
indefinitely, and a door for a demo but not as a permanent host.

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
  approvals, budgets, waits, schedules, questions, replay), the CLI, the Archil store, the door, three
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
