# What earns a part, and what to make instead

A part is a directory with a purpose in the owner's voice and handlers keyed by event type. A part with
`instances: true` has one directory per instance under `parts/<part>/<instance>/`, created by the first
event addressed to it. A singleton part lives at `parts/<part>/`. A part may read anything in the atoll
and writes only under its own directory, which the runtime checks at commit.

## The three tests

| Test | Holds when | Fails when |
| --- | --- | --- |
| Owns state | It is the only writer of files that must stay consistent, such as a ledger keyed by package and version | Another part could write the same facts, or its files are a copy of another part's |
| Its own waits or schedule | It waits for a time, an event, or an answer that no existing part already waits for, or it needs its own `every` or `cron` | An existing part already waits for the same thing, or a schedule on that part would do |
| Its own instances | It tracks many independent things, each needing its own directory and its own waits | There is only one of it, or the instances would share every file |

## What a part that fails all three becomes

| If the thing... | Make it | Why |
| --- | --- | --- |
| Needs a periodic wake | A schedule on the part that owns the work: `{ every: "1h", send: "watch.poll" }`, or `{ cron: "0 9 * * 1", tz: "Europe/London", send: "digest.write" }` | The runtime re-arms a schedule after each firing. A missed schedule fires once on the next tick, not once per missed period |
| Needs one wake later: a reminder, a timeout, a follow-up | A wait on the part that owns it, `t.wait({ until: "2d", reason: "..." })`, handled as a `timer` event | A due wait delivers one `timer` event whose ID is derived from the address and the due time, so it fires once even if two ticks race |
| Reads another part's data | A read: `t.json("/parts/ledger/releases.json")` | Parts share an environment, not just events. A digest that reads the ledger's files needs nothing from the ledger |
| Calls an outside API, a model, or a command | An effect of the part that owns the result | Effects run after the turn commits; they are keyed, budgeted, and approvable, and the result comes back to the requesting part as an event |
| Tells the owner something | `t.tell(...)` from the part that knows it, or a `notify` effect to push it to a webhook | A notice is a file under `notices/`. A notifier part adds a hop and owns nothing |
| Needs the owner's yes before it runs | `approval: true` on the effect | The runner writes the exact arguments to `outbox/` and opens an ask; approval spends once, on exactly those arguments |
| Needs a decision from the owner | `t.ask(...)` from the part that owns the item, answered as `ask.answered` or `ask.expired` | Every ask has a default and an expiry, so nothing waits on the owner forever |
| Is a judgment with fixed answers, or facts pulled from text | A `model` effect of the part that owns the item, with a `standIn` and a checked answer | The model proposes; the owning part's code decides |
| Runs an untrusted command | An `exec` effect with a `scope` (default `workspace`), or `fork: true` to run it on a branch | The command gets a mount of one subdirectory. A forked command merges back only if nothing else wrote the same files, or never, with `merge: false`, when what you want from it is a verdict |
| Is a pure function of its inputs: parse, format, classify by rule | A function in `system.ts` or a module beside it | No state and no waits: a part would add a hop for nothing |

## Over-splits the critic will flag

- **A forwarding part** that receives an event and sends it on without owning a file: merge it into the
  part that receives it.
- **A scheduler part** that only wakes other parts: give the owner of the work a schedule.
- **A notifier part:** `t.tell` or a `notify` effect from the part that owns the finding.
- **A classifier or judge part** that labels another part's items: a `model` effect of the owner.
- **An approver part:** approval is a field of the effect.
- **A cache part** that copies another part's files: read them where they are.
- **One part per pipeline stage** when the stages share their files: merge them. A part can send an event
  to itself (`t.send(t.self, ...)`) when one stage must wait for an effect before the next.

## What splitting doesn't buy

One runner at a time holds an atoll's lease and handles its events in ID order, so splitting work across
parts doesn't make it run in parallel. A split buys one writer per directory, separate waits, and
separate instances, and nothing else. Each extra part is another directory to read in `atoll status` and
another address that a later change has to keep accepting events for.
