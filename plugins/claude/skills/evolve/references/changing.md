# Changing a standing system

A first push is the easy part. An atoll is worth having for as long as it can be changed safely while it
runs, so every change is tried against what actually happened before it is pushed.

## Replay

`atoll replay` re-handles every recorded turn through the code version that recorded it (every pushed
version stays on the disk), each against the files as they were just before that turn and at the turn's
recorded time, and compares what the code asks for with what was recorded. `atoll replay --code <file>`
replays every turn through one version instead. Handlers see only recorded inputs and the recorded clock, so the code
that ran reproduces its own turns exactly. When it doesn't, a handler reached outside the Turn API: a
`Date.now()`, a `Math.random()`, a module variable, or I/O that should have been an effect.

## Try

`atoll try` does the same with the working copy's `system.ts`. For every recorded turn it runs the new
handler against the state that turn really saw, compares the writes, sends, effects, waits, asks, and
notices with the recording, and then moves on from the recorded state, so one difference never cascades
into the next turn. It reports how many turns behave the same, and lists the ones that differ (and how),
the ones whose handler throws, and the ones whose event the new code has no handler for. It never runs
an effect: a request the new code adds shows up as a difference, and what the new code does with that
effect's result is untested until a test covers it.

It is a diff of behavior against real traffic, not a classification of schemas, and it covers only what
actually happened. Read each line of the report as one of these:

| In the report | Means | Do |
| --- | --- | --- |
| A difference the change was meant to make | The change works on real history | Name it, with the line of the change that causes it |
| A difference nobody asked for | A regression | Fix it, and add a test that would have caught it |
| A turn that throws | The new code fails on an event that really arrived | Fix it before anything else |
| A turn with no handler | The new code dropped a type that history has | Keep the handler, or say why that event can never arrive again |
| A new effect request | Behavior that history has no result for | Cover the result with an `@standing-systems/atoll/testing` test that stubs the effect |

## Push

`atoll push` bundles `system.ts` with esbuild into one file, stores it at
`.atoll/code/<version>/system.mjs`, points `.atoll/code/current` at it, appends a `push` record, and takes a
checkpoint. When the system declares a `charter`, the push also rewrites the disk's `CHARTER.md` to match
it and the parts' purposes, so a change to what the atoll is for reaches the disk with the code. Runners
load the current bundle from the disk, so every turn record names the code version that produced it.
Events already in the inbox are handled by the new code, which is why `atoll try` comes first.

## What must keep working

- **Event types in flight.** Anything that may be in the inbox, or that a wait expects (`for`), needs a
  handler in the new code. An event whose part or handler the new code lacks goes straight to
  `inbox/dead/`, with a notice to the owner.
- **Waits and asks already recorded.** A `timer` for a due wait, and `ask.answered` or `ask.expired` for an
  open ask, arrive at the new code, addressed to the same part.
- **Schedules.** A singleton part's schedules are armed when code is pushed. A missed schedule fires
  once on the next tick, not once per missed period.
- **Files.** Each part's existing files stay on the disk. Renaming a file, or changing its shape, means
  reading both forms or migrating in a turn the journal records. A file changed by hand instead is one the
  journal didn't write, and `atoll check` reports it.
- **Outbox entries.** An effect waiting for approval was requested by the old code. Keep its declaration,
  and a handler for its result event, until `atoll status` shows the outbox empty.
- **Budgets.** The meter is a file on the disk, so a push doesn't reset the month's count.

## Checkpoints and forks

A checkpoint is a consistent snapshot of the whole system between ticks: every part, every inbox, every
open question. `atoll checkpoint <name>` takes one (one exec), and every push takes one too.
`atoll fork --checkpoint <name>` branches the disk at a checkpoint and prints the new branch's ID, which
every `atoll` command accepts like a disk, so a full copy of the system can be inspected, ticked, and
changed without touching the original. Archil can't delete checkpoints or branches yet; `atoll status`
counts the ones Atoll created.

Rolling back means pushing the previous code version, or adopting a branch. Neither undoes an effect that
already happened.
