# The atoll format, version 1

An atoll is a directory tree rooted at the top of a disk, or at a prefix so several atolls can share one
disk. `.atoll/format` contains `atoll/1`. The runtime reads and writes only what is listed here and leaves
anything else on the disk alone.

```text
CHARTER.md    what the owner asked it to do, and what it must never do
STATUS.md     the five answers in prose, rewritten after every tick
atoll.json    the manifest: parts, effects, schedules, budgets, the code version that runs
inbox/        events waiting to be handled, one file each; inbox/dead/ after three failures
journal/      every committed turn and every effect outcome, one line each, by UTC day
parts/        each part's own files: what it knows, and waiting.json
asks/         questions for the owner, as .json and .md; answered ones under asks/closed/
outbox/       effects waiting for the owner's approval, or whose outcome is in doubt
notices/      what it told the owner, by day
evidence/     receipts: fetched pages, model answers, command output, by hash
workspace/    where untrusted commands run
.atoll/       the lease, the code, staging, the meter, timers, checkpoints
```

## Where each answer lives

| Question | File | Read it without Atoll |
| --- | --- | --- |
| What is it trying to accomplish? | `CHARTER.md` (written by `atoll push` from the declared charter, with each part's purpose), and `atoll.json` | `cat CHARTER.md` |
| What changed, and why? | `journal/<YYYY-MM-DD>.jsonl`: each turn names its cause, its writes, and its evidence | `tail -n 5 journal/2026-11-04.jsonl` |
| What is it waiting for? | `parts/<address>/waiting.json`, `.atoll/timers.json`, `.atoll/next-wake` | `cat parts/watch/rivetkit/waiting.json` |
| What evidence supports its state? | `evidence/<hh>/<sha256>` and `<sha256>.json`, cited by hash from the journal | `grep -rl rivetkit evidence/` |
| What does it need from me? | `asks/<id>.json` and `.md`, `outbox/<fx>.json` | `ls asks/ outbox/` |

## Identifiers

- **Event IDs** are 26-character ULIDs, so lexical order is time order. An event from outside gets a fresh
  one. An event a turn creates gets one derived from the turn's time, its sequence number, and the send's
  position, so re-installing a turn after a crash recreates the same IDs.
- **Sequence numbers** (`seq`) start at 1 and go up by one for every journal record.
- **Effect, ask, and notice IDs** come from the sequence number that created them: `fx42.0`, `q42.1`,
  `n42.0`.
- **Part addresses** are `<part>` for a singleton or `<part>/<instance>`, and a part's files are under
  `parts/<address>/`.
- **Evidence references** are `sha256:<hex>`. **Code versions** are the first 16 hex digits of the
  bundle's SHA-256.

## Events

`inbox/<id>.json` holds `id`, `type`, `to`, `from`, `cause`, `at`, and `body`, plus `evidence` when the
sender cited any. `from` is a part address, `@owner` (the CLI, and answers to asks), `@clock` (timers,
schedules, and asks that expired), `@door`, or the ID of the effect whose result it is. `cause` is the
event whose turn sent it. After a turn handles an event, the runtime creates `.atoll/seen/<id>` and
deletes the inbox file. A redelivery of the same ID within 30 days finds the marker and is recorded as a
`duplicate` without running any code.

A due wait arrives as a `timer` event with the wait's `reason` in its body; a schedule arrives as its own
event type. An effect's result arrives as its `then` type, with the body
`{ ok, effect, name, result, error, denied }`. An http result names its whole answer as evidence in
`result.body`; a result too large to carry inline arrives as `{ tooLarge: true, bytes, body }`, with the
rest in that evidence file.

## The journal

One JSON record per line in `journal/<YYYY-MM-DD>.jsonl`, by the UTC day of commit. Every record has `v`,
`kind`, `seq`, `epoch` (the lease epoch of the runner that wrote it), `at`, and a `crc`, so a torn final
line is detected and ignored. The kinds:

- `turn`: the event, the part, the code version, every write (inline up to 32 KiB, staged beyond),
  delete, send, effect requested, the part's waits afterwards (or `done`), asks, notices, evidence, and
  the handler's `note`. The append of this record is the commit point of the turn.
- `effect`: one outcome for one effect: `started`, `done`, `failed`, `in-doubt`, `awaiting-approval`,
  `approved` (with the answer that authorized it and the arguments it runs with), `denied`,
  `over-budget`, or `dropped`, with any result event, error, evidence, and cost. An `exec` outcome lists
  the files the command changed.
- `failure`: a handler threw or its turn broke a rule at commit; the record says which attempt, and
  whether the event went to `inbox/dead/` (after three attempts, or at once when no part or handler
  matches the event).
- `duplicate`: an event ID that arrived again.
- `answer`: an ask resolved by the owner or by its expiry, and the event it delivered.
- `push`: new code became current, with the previous version.
- `checkpoint` and `merge`: a snapshot of the disk, and a forked command's changes copied back.

`.atoll/head.json` says how far the journal has been installed into the files.

## Parts and waits

A part may hold any files it likes under its directory. Atoll reserves only `waiting.json`:
`{ address, status, waits, done?, since, seq }`, where `status` is `waiting`, `done`, or `idle`, each wait
has `until`, `for`, or `ask` and a `reason`, and `seq` is the turn that last changed it. Timed waits are
indexed in `.atoll/timers.json`, and `.atoll/next-wake` holds the earliest due time. A tick first delivers
a `timer` event for each due wait, then handles the inbox. Schedules are timers the runtime re-arms after
each firing.

## Asks and the outbox

An ask is `asks/<id>.json` (with `question`, `why`, `options`, `recommend`, `default`, `expires`,
`payload`, `evidence`, and `effect: { id, reason }` when the runner opened it about an effect) and a
rendered `asks/<id>.md`. An answer is `asks/<id>.answer.json` with `option` and optionally an edited
`payload`, written by `atoll answer` or by hand. The next tick turns it into an `ask.answered` event for
the asking part, with the body `{ ask, option, payload, by }`, and moves the ask under `asks/closed/`. An
expired ask resolves with its default as `ask.expired`.

The runner opens three kinds of ask about effects, each with fixed options:

| `reason` | Options | Default |
| --- | --- | --- |
| `approval` | `approve` (optionally with an edited payload, which becomes the arguments) or `deny` | `deny`, after three days |
| `over-budget` | `allow` this one run, or `drop` it | `drop` |
| `in-doubt` | `happened`, `retry` (which may repeat it), or `unknown` | `unknown` |

The effect waits in `outbox/<fx>.json`, with its exact arguments and state, until its ask is answered.

## The meter, evidence, notices, and code

- `.atoll/meter/<YYYY-MM>.json` counts calls and dollars per effect, advanced by effect outcome records,
  so it can always be recomputed from the journal.
- `evidence/<hh>/<sha256>` holds the bytes and `<sha256>.json` the source, type, time, and size.
- `notices/<YYYY-MM-DD>/<n-id>.md` is each thing it told the owner.
- `.atoll/code/<version>/system.mjs` is each pushed bundle, `.atoll/code/current` names the one that
  runs, and `.atoll/bin/atoll.mjs` is a copy of the runtime, so a sandbox with the disk mounted can run a
  tick with nothing installed.
- `.atoll/lease/<epoch>` holds the lease, one object per epoch; `.atoll/checkpoints.jsonl` and
  `.atoll/branches.jsonl` count the checkpoints and branches Atoll created.
