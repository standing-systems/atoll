---
name: inspect
description: Answer "what is it doing", "why did it do that", "what is it waiting for", and "what does it need from me" about an atoll, from `atoll status`, `atoll why`, `atoll log`, `atoll asks`, and the files on its disk. Use for a notice it sent, a stuck or idle part, an in-doubt effect, or an open question. Says unknown where the journal ends.
allowed-tools: Bash(atoll status *) Bash(atoll why *) Bash(atoll log *) Bash(atoll asks *) Bash(atoll check *) Bash(atoll ls *) Bash(atoll cat *) Bash(ls *) Bash(cat *) Bash(tail *) Bash(grep *) Bash("${CLAUDE_PLUGIN_ROOT}/bin/atoll" status *)
---

# Inspect an atoll

Rules that hold for this whole skill:
- **Answer only from the atoll:** `atoll status`, `atoll why`, `atoll log`, `atoll asks`, and its files.
  When the record stops, say "unknown" and say where it ends. Never fill a gap with what probably
  happened.
- **Read, never change.** Don't run `atoll send`, `atoll tick`, or `atoll answer`, and don't edit files on
  the disk while inspecting. Answering an ask is the person's decision: give them the exact
  `atoll answer` command, and say that it ticks right after, so an approved effect runs then. A file
  changed by hand under `parts/` is one the journal didn't write, and `atoll check` reports it.
- **Say which atoll you read:** a local one (`--dir <path>`), a disk (`--disk <name-or-id>`), or a fork's
  branch ID, which `--disk` accepts too. In a project, commands without either flag read the local atoll
  in `.atoll-local/`, or the disk that `package.json` names in `"atoll": { "disk": "<name>" }`.
- **The journal is authoritative.** A listing taken during a tick can show a turn half installed; the
  journal, `STATUS.md`, and checkpoints taken between ticks are consistent.
- **In doubt means in doubt.** An effect whose outcome is `in-doubt` may or may not have happened. Never
  report it as done or as not done.
- Quote event IDs, sequence numbers, effect IDs (`fx42.0`), ask IDs (`q42.1`), and evidence references
  (`sha256:...`) exactly as recorded.

## What it says about itself

!`"${CLAUDE_PLUGIN_ROOT}/bin/atoll" status || true`

## Steps

1. **Name the atoll** the question is about, and re-run the commands with `--dir` or `--disk` if the
   output above is for a different one.
2. **Answer from the command that fits the question:**
   - what is it doing, or what is it waiting for: `atoll status`, the five answers, with each part's
     waits and the next wake, or `atoll status <address>` for one part (it exits 1 when a part is idle);
   - why did something happen: `atoll why <path|event-id|seq>`, the turn that produced it and its cause
     chain with evidence, back to an event from outside;
   - what happened lately: `atoll log --since 1d`, or `--part <address>` for one part;
   - what does it need from me: `atoll asks`, each with its options, consequences, recommendation,
     default, and expiry.
3. **Follow the evidence.** Each `sha256:<hex>` is a file at `evidence/<first two hex digits>/<hex>`, with
   its metadata (source, type, time, size) beside it in `<hex>.json`. Read the receipt before describing
   what it says.
4. **Cross-check with the files.** `references/format.md` says where each answer lives. For a local
   atoll or a mounted disk, read them directly: `cat parts/<address>/waiting.json`,
   `tail -n 5 journal/<day>.jsonl`, `ls asks/ outbox/`, `grep -rl <term> evidence/`. For a disk you
   can't mount, which on the Free plan is any disk from your own machine, read the same files through
   the object API: `atoll ls asks/ --disk <name>` lists them, and
   `atoll cat parts/<address>/waiting.json --disk <name>` prints one.
5. **Explain in the order things happened:** what started it (the person, the clock, the door, another
   part, or an effect's result), which part decided what and why (its recorded note, and the handler
   code), what came of each effect, and where the path ended. Tie each step to a sequence number or an
   event ID.

## Reading what the journal records

- **Effect outcomes.** `started`, then `done` or `failed`; `awaiting-approval` while an ask is open, then
  `approved` (naming the answer that authorized it) or `denied`; `over-budget` when the meter refused it;
  `in-doubt` when a runner died between `started` and the outcome of an effect that isn't safe to retry;
  `dropped` when the owner didn't let it run past its budget, or left an in-doubt outcome unknown. Each
  ask the runner opens about an effect names it in `effect: { id, reason }`.
- **A `failure` record** means a handler threw, or its turn broke a rule at commit (a write outside its
  directory, a send or effect that isn't declared). The event stays in the inbox for the next tick, and
  after three attempts it moves to `inbox/dead/` and the owner gets a notice. An event for a part or a
  type the code doesn't have goes to `inbox/dead/` at once.
- **A `duplicate` record** means an event ID arrived again within 30 days and no code ran for it.
- **A `push` record** names the code version that became current; every turn record names the version
  that produced it.
- **An `answer` record** says who resolved an ask: the owner, or its expiry with the default.
- **An idle part** is neither waiting for anything nor done. `atoll check` flags it; the cause is
  usually a handler that ended without `t.wait(...)` or `t.done(...)`.
- **An incomplete chain.** When `atoll why` can't reach an event from outside, the record ran out:
  report the last step it found and say the rest is unknown.
- **A stale-runner record** carries a lower lease epoch than one already seen. `atoll check` reports it;
  the next runner's recovery re-installs the authoritative history.

Done when: each question is answered with the command output or file that shows it, every unknown is
named with where the record ends, and any action the person might take (answering an ask, deciding an
in-doubt effect) is given as a command for them to run.
