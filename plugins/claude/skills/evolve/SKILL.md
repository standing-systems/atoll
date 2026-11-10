---
name: evolve
description: Change an atoll that already runs on a disk. Replay its recorded history through the working copy's code with `atoll try`, explain every difference, and give the person a push plan to run. Use when someone asks to change, fix, extend, upgrade, roll back, or push new code to a running atoll. Never pushes.
allowed-tools: Bash(atoll try *) Bash(atoll replay *) Bash(atoll check *) Bash(atoll status *) Bash(atoll log *) Bash("${CLAUDE_PLUGIN_ROOT}/bin/atoll" status *)
---

# Change a running atoll

Rules that hold for this whole skill:
- **Produce a push plan, never a push.** Don't run `atoll push`, `atoll create`, `atoll door`,
  `atoll clock`, `atoll fork`, or `atoll checkpoint`. Asked to push or deploy, show the plan and say that
  the person runs it.
- **What is in flight meets the new code.** Events already in the inbox, waits already set, open asks,
  and effects waiting in the outbox are all handled by the new code after the push. Keep a handler for
  every event type that may be in flight, including `timer`, `ask.answered`, and `ask.expired` wherever a
  wait or an ask is outstanding.
- **Files on the disk stay.** A part's existing files keep their names and shapes on the disk after the
  push. New code reads the old shape, or migrates it in a turn; it never assumes a fresh directory.
- **`atoll try` covers only what happened.** Its diff is against real recorded traffic, not every
  possible event. An effect the new code requests that history has no result for isn't covered: test it.
- **Keep the existing tests**, and add one focused test that proves the change.
- **Never imply a push can be undone.** Rolling back means pushing the previous code version, or adopting
  a branch from a checkpoint. Effects the new code already performed stay performed.

## What it is doing now

!`"${CLAUDE_PLUGIN_ROOT}/bin/atoll" status || true`

## Steps

1. **State the change**, and from the status above, what must keep working: waits and their due times,
   schedules, open asks, outbox entries, events still in the inbox, and the files the new code will read.
   The status above is the project's default atoll, which is `.atoll-local/` unless `package.json` names
   a disk; for the running one, run `atoll status --disk <name>`.
2. **Make the change** the way `/atoll:build` does: declaration first, then handlers, then a focused test.
   Run `npm run verify` until it passes.
3. **Try it against the recorded history:** `atoll try --disk <name>`. It re-handles every recorded turn
   through the working copy's code, against the state that turn saw, and reports the turns that differ
   (and how), the ones that throw, and the ones the new code has no handler for. It runs no effects.
   `references/changing.md` says how to read each line.
4. **Account for every difference:** intended, with the line of the change that causes it, or a
   regression to fix. Re-run `atoll try` after each fix.
5. **Ask the critics** when the change touches them: `part-critic` for a part added, removed, or split,
   and `effect-auditor` for a new or changed effect or approval.
6. **Write the push plan** for the person:
   1. `atoll checkpoint pre-<change> --disk <name>`, so there is a named state to fork from (the push
      also takes one).
   2. `atoll push --disk <name>`: the new bundle becomes current, and the next tick runs it.
   3. `atoll tick --disk <name>`, or the next tick from the clock, then `atoll status --disk <name>` and
      `atoll log --since 1h --disk <name>` to watch the first turns.
   4. Rolling back: check out the previous `system.ts` and run `atoll push --disk <name>` again, or
      `atoll fork --checkpoint pre-<change> --disk <name>` to get a full copy of the system as it was.

## Output (done when shown)

- The change, and what had to keep working through it.
- The tests and the check, with their real results.
- The `atoll try` report, each difference marked intended (and why) or fixed, and the effects it could
  not cover.
- The push plan, and one plain sentence: nothing was pushed; the person runs the plan.
