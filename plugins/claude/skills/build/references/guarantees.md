# What Atoll guarantees, and what it doesn't

Claim only what is in the first table. When someone asks for something in the second list, say plainly
that atoll doesn't promise it, and describe what it does instead.

## Guarantees

Each of these has a test in Atoll's own suite, in the Atoll repository. The crash test, for example,
injects a crash at every storage operation of a turn and checks that recovery leaves the same files as a
clean run, and the lease test runs 20 concurrent runners against one atoll, locally and on Archil.

| Guarantee | Mechanism |
| --- | --- |
| A turn's file changes, sends, effects, waits, and asks happen together or not at all | One journal append is the commit point; installing a committed turn is idempotent |
| An event ID is handled at most once within 30 days | Create-only inbox delivery, and `.atoll/seen/` markers kept for 30 days |
| Every event delivered is eventually handled, retried, or dead-lettered with a notice | Inbox files persist until a committed turn deletes them; after three failures an event moves to `inbox/dead/` |
| One runner at a time | Create-only epoch objects in `.atoll/lease/`, and a fencing check before every commit |
| An effect is never reported done without a recorded outcome | `started` and outcome records in the journal, and `in-doubt` otherwise |
| An approved effect runs once, with exactly the approved arguments | The ask's answer is recorded as spent |
| A budget is never exceeded by an effect that hasn't run yet | The meter is checked before each effect |
| A timer fires once per due time, even if two ticks race | Timer event IDs derived from the address and the due time, plus create-only delivery |
| Replaying the journal through the same code reproduces the same files | Handlers see only recorded inputs and a recorded clock |
| `atoll check` finds files under `parts/` that the journal didn't write | It compares file hashes with the journal's last write to each path |

## Not guaranteed

- **Exactly-once external effects.** A non-idempotent effect whose runner died mid-call is reported in
  doubt, and the owner is asked whether it happened. Only the remote side's own idempotency can prevent a
  duplicate: pass `ctx.key` to an API that honors one, and declare `idempotent: true` only then.
- **Ordering across senders.** Events are handled in ID order, which is close to arrival order, and
  nothing more.
- **A consistent view of files mid-tick.** A reader that lists `parts/` during a tick can see a turn half
  installed. The journal, `STATUS.md`, and checkpoints taken between ticks are consistent.
- **Exact timing.** A wait fires at the first tick after it is due, so its precision is the clock's: the
  cron line, the GitHub Actions schedule, or the request to the door that calls `atoll tick`.
- **Mutual exclusion under clock skew beyond 10 seconds.** The lease assumes runners' clocks agree within
  that margin. A stale commit beyond it is detected, not prevented.
- **Isolation of untrusted code from the atoll's owner.** A branch is not a security boundary, and a disk's
  credentials reach every branch and checkpoint. Scoped mounts limit what a command can touch; they don't
  hide the disk from someone holding its API key.
- **Deploys.** Atoll never pushes code, creates a disk, starts a door, or installs a clock on its own. A
  request to do so gets the plan and the commands for a person to run.

## When someone asks for more

| They ask for | Say | What the system does instead |
| --- | --- | --- |
| "Make sure it's sent exactly once" | Atoll can't promise that for anything outside the disk | An idempotency key the destination honors, `idempotent: true` only then, and an in-doubt ask when the outcome is unknown |
| "Run it at exactly 9:00" | A wait fires at the first tick after it is due | A clock that ticks often enough, such as every five minutes |
| "Process events in the order they were sent" | Events are handled in ID order, which is close to arrival order, not a promise | Handlers that decide from the part's files, not from which event came first |
| "Let it fix things without asking me" | Only if the person says so for that effect, and it is still budgeted | `approval: true` by default for anything that speaks for the person; an explicit decision recorded in `CHARTER.md` to drop it |
