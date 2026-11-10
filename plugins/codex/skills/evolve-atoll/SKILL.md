---
name: evolve-atoll
description: Change an atoll that already runs on a disk. Try the change against its recorded history with `atoll try`, explain every difference, and give the person a push plan to run. Use to change, fix, extend, upgrade, roll back, or push new code to a running atoll.
---

1. State the change, and from `atoll status --disk <name>` what must keep working: waits and their due times, schedules, open asks, outbox entries, events still in the inbox, and the files the new code will read. Everything in flight is handled by the new code after the push, so keep a handler for every event type that may be waiting, including `timer`, `ask.answered`, and `ask.expired`. A part's existing files stay on the disk: read their old shape, or migrate it in a turn.
2. Make the change the way `build-atoll` does: the declaration first, then the handlers, then one focused test, keeping the existing tests as they are. Run `npm run verify` until it passes.
3. Run `atoll try --disk <name>`. It re-handles every recorded turn through the working copy's code, against the state that turn saw, and reports the turns that behave the same, the ones that differ (and how), the ones that throw, and the ones the new code has no handler for. It runs no effects and covers only what actually happened. Mark each difference as intended, with the line that causes it, or fix it as a regression; cover any new effect's result with a test.
4. Write the push plan for the person: `atoll checkpoint pre-<change> --disk <name>`; `atoll push --disk <name>`; then `atoll tick --disk <name>`, `atoll status --disk <name>`, and `atoll log --since 1h --disk <name>` to watch the first turns. Rolling back means pushing the previous `system.ts` again, or `atoll fork --checkpoint pre-<change> --disk <name>` for a full copy of the system as it was; neither undoes an effect that already ran.
5. Return the change, the verify and `atoll try` results as they ran, each difference with its explanation, and the plan, with the sentence that nothing was pushed.

Use the [shared Atoll conventions](references/workflow.md) when needed. Completion requires the commands to have run and their real output to be reported; report a blocked command precisely. Never push code, create a disk, start a door, or install a clock: give the person the plan and the exact commands. The person's instructions take precedence.
